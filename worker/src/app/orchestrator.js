// Central conversational orchestrator for personal DMs: builds the 4-specialist
// agent graph, manages ephemeral session / follow-up state, enforces analytics
// quota, and routes replies.
import { defineAgent, runAgentLoop } from "../llm/agents.js";
import { findTransactionByCardMessage } from "../db/transactions.js";
import { consumeAsk, refundAsk } from "../db/quota.js";
import { putEphemeral, takeEphemeral, deleteEphemeral } from "../db/ephemeral.js";
import { setPending, takePending, clearPending } from "./pending.js";
import { FREE_ASK_LIMIT } from "./constants.js";
import { istDate } from "../util/dates.js";
import { fromMinor } from "../util/money.js";
import {
  askSystemPrompt,
  ledgerSystemPrompt,
  groupSystemPrompt,
  accountSystemPrompt,
  triageSystemPrompt,
  classifyFastAgent,
  capHitMessage
} from "./orchestratorPrompts.js";
import {
  ANALYTICS_TOOLS,
  LEDGER_TOOLS,
  GROUP_TOOLS,
  ACCOUNT_TOOLS,
  ASK_TOOLS,
  askToolExecutor
} from "./orchestratorTools.js";

export {
  ANALYTICS_TOOLS,
  LEDGER_TOOLS,
  GROUP_TOOLS,
  ACCOUNT_TOOLS,
  ASK_TOOLS,
  askSystemPrompt,
  askToolExecutor,
  classifyFastAgent,
  capHitMessage
};

export const ASK_MAX_ITERATIONS = 6;
export const ASK_MAX_TURNS = 5;
const CONVO_TTL_SEC = 600;
const ERROR_TEXT = "❌ Something went wrong. Tap your pinned summary for recent spends, or try again in a moment.";

const convoKey = (chatId, messageId) => "ask:" + chatId + ":" + messageId;
const openAskKey = (chatId) => "ask_open:" + chatId;

export function buildOrchestratorGraph(executeTool) {
  const analytics = defineAgent({
    name: "analytics",
    description: "Read-only spending summaries, category breakdowns, top merchants, trends, and transaction search.",
    instructions: (rc) => askSystemPrompt(rc.today),
    tools: ANALYTICS_TOOLS,
    executeTool,
    quotaExempt: false
  });

  const ledger = defineAgent({
    name: "ledger",
    description: "Tagging untagged expenses, editing category/merchant/type, and saving pasted bank alerts.",
    instructions: (rc) => ledgerSystemPrompt(rc.today),
    tools: LEDGER_TOOLS,
    executeTool,
    quotaExempt: true
  });

  const groups = defineAgent({
    name: "groups",
    description: "Splitting transactions, checking group balances / who owes whom, settling up, and undoing splits.",
    instructions: (rc) => groupSystemPrompt(rc.today),
    tools: GROUP_TOOLS,
    executeTool,
    quotaExempt: true
  });

  const account = defineAgent({
    name: "account",
    description:
      "Registering Gmail, resending setup steps, backfilling emails, CSV/Sheet exports, dashboard, or data deletion.",
    instructions: (rc) => accountSystemPrompt(rc.today, rc.tenantStatus),
    tools: ACCOUNT_TOOLS,
    executeTool,
    quotaExempt: true
  });

  analytics.handoffs = [ledger, groups, account];
  ledger.handoffs = [analytics, groups, account];
  groups.handoffs = [analytics, ledger, account];
  account.handoffs = [analytics, ledger, groups];

  const triage = defineAgent({
    name: "triage",
    description: "Central router",
    instructions: (rc) => triageSystemPrompt(rc.today),
    handoffs: [analytics, ledger, groups, account],
    quotaExempt: false
  });

  return { rootAgent: triage, agents: { triage, analytics, ledger, groups, account } };
}

async function runTurn(ctx, { chatId, username = "", tenantStatus = "active", activeAgent = null, messages, turn }) {
  if (turn > ASK_MAX_TURNS) {
    await ctx.tg.sendMessage(
      chatId,
      "This conversation has too many follow-ups. Send your next request as a fresh message.",
      { parse_mode: null }
    );
    return;
  }

  const runMeta = { username, suppressFinalText: false };
  const executor = askToolExecutor(ctx, chatId, runMeta);
  const { rootAgent, agents } = buildOrchestratorGraph(executor);
  const startAgent = (activeAgent && agents[activeAgent]) || rootAgent;

  const day = istDate(ctx.now());
  let consumedQuota = false;
  if (!startAgent.quotaExempt) {
    const quota = await consumeAsk(ctx.db, chatId, day, FREE_ASK_LIMIT);
    if (!quota.allowed) {
      await ctx.tg.sendMessage(chatId, capHitMessage(ctx.now()), {
        reply_markup: { inline_keyboard: [[{ text: "💎 Upgrade to Premium", callback_data: "premium_info" }]] }
      });
      return;
    }
    consumedQuota = true;
  }

  let result;
  try {
    result = await runAgentLoop(ctx.llm, {
      rootAgent,
      activeAgent: startAgent.name,
      messages,
      runCtx: { today: day, tenantStatus },
      maxIterations: ASK_MAX_ITERATIONS,
      maxTokens: 800,
      suspendOn: ["ask_user"],
      onIteration: () => ctx.tg.sendChatAction(chatId).catch(() => {})
    });
  } catch (e) {
    console.error("[orchestrator] failed:", e && e.message);
    if (consumedQuota) await refundAsk(ctx.db, chatId, day, FREE_ASK_LIMIT);
    await ctx.tg.sendMessage(chatId, ERROR_TEXT, { parse_mode: null });
    return;
  }

  if (consumedQuota && result.quotaExempt) {
    await refundAsk(ctx.db, chatId, day, FREE_ASK_LIMIT);
  }
  if (!consumedQuota && !result.quotaExempt) {
    const quota = await consumeAsk(ctx.db, chatId, day, FREE_ASK_LIMIT);
    if (!quota.allowed) {
      await ctx.tg.sendMessage(chatId, capHitMessage(ctx.now()), {
        reply_markup: { inline_keyboard: [[{ text: "💎 Upgrade to Premium", callback_data: "premium_info" }]] }
      });
      return;
    }
  }

  if (result.kind === "suspend") {
    const q = String(result.args.question || "").trim() || "Could you share a bit more detail?";
    const sent = await ctx.tg.sendMessage(chatId, q, {
      parse_mode: null,
      reply_markup: { force_reply: true, selective: true }
    });
    if (sent && sent.message_id) {
      await putEphemeral(
        ctx.db,
        convoKey(chatId, sent.message_id),
        { activeAgent: result.activeAgent, messages: result.messages, askCallId: result.toolCall.id, turn },
        CONVO_TTL_SEC,
        ctx.now()
      );
      await putEphemeral(ctx.db, openAskKey(chatId), { messageId: sent.message_id }, CONVO_TTL_SEC, ctx.now());
    }
    return;
  }

  if (result.kind === "exhausted") {
    await ctx.tg.sendMessage(chatId, "I took too many steps trying to handle that. Try phrasing it more simply.", {
      parse_mode: null
    });
    return;
  }

  if (runMeta.suppressFinalText) return;

  const text = result.content.trim() || "I couldn't find an answer to that. Try being more specific.";
  const canFollowUp = turn < ASK_MAX_TURNS;
  const sent = await ctx.tg.sendMessage(chatId, text, {
    parse_mode: null,
    reply_markup: canFollowUp
      ? { inline_keyboard: [[{ text: "💬 Follow up", callback_data: "askfu_" + turn }]] }
      : undefined
  });
  if (canFollowUp && sent && sent.message_id) {
    await putEphemeral(
      ctx.db,
      convoKey(chatId, sent.message_id),
      { activeAgent: result.activeAgent, messages: result.messages, askCallId: null, turn },
      CONVO_TTL_SEC,
      ctx.now()
    );
  }
}

export async function handleOrchestrator(ctx, m, tenant) {
  const stripped = String(m.text || "")
    .replace(/^\/ask(@\w+)?\s*/i, "")
    .trim();
  if (!stripped) {
    await setPending(ctx, "ask", m.chatId);
    await ctx.tg.sendMessage(
      m.chatId,
      "💬 Type anything in plain English — no commands needed:\n\n" +
        "• How much on food last month?\n" +
        "• Tag Rahul as Food\n" +
        "• Split dinner 50/50\n" +
        "• Export September CSV",
      { parse_mode: null, reply_markup: { force_reply: true, input_field_placeholder: "Ask or tell me what to do…" } }
    );
    return;
  }
  await clearPending(ctx, "ask", m.chatId);
  const tenantStatus = (tenant && tenant.status) || "active";
  const fastAgent = classifyFastAgent(stripped, tenantStatus);
  let userContent = stripped;
  if (m.replyTo && m.replyTo.message_id) {
    const repliedTxn = await findTransactionByCardMessage(ctx.db, m.chatId, m.replyTo.message_id);
    if (repliedTxn) {
      userContent =
        "[Replied to transaction_id=" +
        repliedTxn.id +
        " (" +
        repliedTxn.occurred_on +
        ", " +
        (repliedTxn.merchant || "Unknown") +
        ", " +
        repliedTxn.currency +
        " " +
        fromMinor(repliedTxn.amount_minor) +
        ", " +
        repliedTxn.direction +
        ")]\n" +
        stripped;
    }
  }
  await runTurn(ctx, {
    chatId: m.chatId,
    username: m.username || "",
    tenantStatus,
    activeAgent: fastAgent,
    messages: [{ role: "user", content: userContent }],
    turn: 1
  });
}

export async function handleAskResume(ctx, m, tenant) {
  let convo = null;
  if (m.replyTo && m.replyTo.message_id) {
    convo = await takeEphemeral(ctx.db, convoKey(m.chatId, m.replyTo.message_id), ctx.now());
    if (convo) await deleteEphemeral(ctx.db, openAskKey(m.chatId));
  } else {
    const open = await takeEphemeral(ctx.db, openAskKey(m.chatId), ctx.now());
    if (open && open.messageId) {
      convo = await takeEphemeral(ctx.db, convoKey(m.chatId, open.messageId), ctx.now());
    }
  }
  if (!convo) return false;
  if (convo.followUpPromptId) {
    await ctx.tg.deleteMessage(m.chatId, convo.followUpPromptId).catch(() => {});
  }
  const reply = convo.askCallId
    ? { role: "tool", tool_call_id: convo.askCallId, content: m.text }
    : { role: "user", content: m.text };
  await runTurn(ctx, {
    chatId: m.chatId,
    username: m.username || "",
    tenantStatus: (tenant && tenant.status) || "active",
    activeAgent: convo.activeAgent || null,
    messages: convo.messages.concat([reply]),
    turn: convo.turn + 1
  });
  return true;
}

export async function handlePendingAsk(ctx, m, tenant) {
  if (!(await takePending(ctx, "ask", m.chatId))) return false;
  const question = String(m.text || "").trim();
  if (!question) {
    await ctx.tg.sendMessage(m.chatId, "❌ Empty message, cancelled.", { parse_mode: null });
    return true;
  }
  await handleOrchestrator(ctx, { ...m, text: question }, tenant);
  return true;
}

export async function cancelOpenConversation(ctx, chatId) {
  const openAsk = await takeEphemeral(ctx.db, openAskKey(chatId), ctx.now());
  if (openAsk && openAsk.messageId) {
    const convo = await takeEphemeral(ctx.db, convoKey(chatId, openAsk.messageId), ctx.now());
    if (convo && convo.followUpPromptId) {
      await ctx.tg.deleteMessage(chatId, convo.followUpPromptId).catch(() => {});
    }
  }
  const pendingAsk = await takePending(ctx, "ask", chatId);
  return !!(openAsk || pendingAsk);
}

export async function handleAskFollowUp(ctx, chatId, messageId, ack) {
  await ctx.tg.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] }).catch(() => {});
  const convo = await takeEphemeral(ctx.db, convoKey(chatId, messageId), ctx.now());
  if (!convo) {
    if (ack) await ack.toast("⌛ That follow-up window expired — just type your question below.", true);
    else await ctx.tg.sendMessage(chatId, "_That follow-up window has expired. Just send your question directly._");
    return;
  }
  const sent = await ctx.tg.sendMessage(chatId, "_What's your follow-up?_", {
    reply_markup: { force_reply: true, selective: true }
  });
  if (sent && sent.message_id) {
    await putEphemeral(
      ctx.db,
      convoKey(chatId, sent.message_id),
      { ...convo, followUpPromptId: sent.message_id },
      CONVO_TTL_SEC,
      ctx.now()
    );
    await putEphemeral(ctx.db, openAskKey(chatId), { messageId: sent.message_id }, CONVO_TTL_SEC, ctx.now());
  }
}
