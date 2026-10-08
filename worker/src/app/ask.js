// /ask: LLM tool-calling over the tenant's transactions, with ask_user
// suspension (resume by replying), a 💬 Follow up button and a daily quota.
import { runToolLoop } from "../llm/azure.js";
import { listEffectiveTransactions } from "../db/analytics.js";
import { getTransaction, updateTransaction } from "../db/transactions.js";
import { upsertMerchantRule } from "../db/merchantRules.js";
import { groupsForMember, getGroupMembers } from "../db/tenants.js";
import { consumeAsk, refundAsk } from "../db/quota.js";
import { putEphemeral, takeEphemeral } from "../db/ephemeral.js";
import { setPending, takePending, clearPending } from "./pending.js";
import { refreshCardMessage } from "./cardState.js";
import { splitTransaction, memberName } from "./groups.js";
import { CATEGORIES, CREDIT_CATEGORIES, FREE_ASK_LIMIT, TAG_MAX_LEN, categoriesFor } from "./constants.js";
import { istDate, shiftIsoDate } from "../util/dates.js";
import { defaultKind } from "../util/kind.js";
import { fromMinor, toMinor } from "../util/money.js";

export const ASK_MAX_ITERATIONS = 6;
export const ASK_MAX_TURNS = 5;
const CONVO_TTL_SEC = 600;
const NON_SPEND = ["CC Bill Payment", "Transfer Out", "Investment"];
const convoKey = (chatId, messageId) => "ask:" + chatId + ":" + messageId;
const DATE_PARAMS = {
  start_date: { type: "string", description: "Start date in YYYY-MM-DD format" },
  end_date: { type: "string", description: "End date in YYYY-MM-DD format" }
};
const fn = (name, description, properties = {}, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } }
});

export const ASK_TOOLS = [
  fn(
    "get_spending_summary",
    "Get total spending and income summary for a date range. spend_by_currency excludes card bill payments, transfers out and investments (reported separately as non_spend_debits_by_currency).",
    DATE_PARAMS,
    ["start_date", "end_date"]
  ),
  fn(
    "get_category_breakdown",
    "Get spending breakdown by category for a date range. Returns each category with amount, currency, and transaction count.",
    DATE_PARAMS,
    ["start_date", "end_date"]
  ),
  fn(
    "get_top_merchants",
    "Get top merchants by spending amount for a date range.",
    { ...DATE_PARAMS, limit: { type: "number", description: "Number of merchants to return. Default 5." } },
    ["start_date", "end_date"]
  ),
  fn(
    "get_user_spend",
    "Get per-user spending totals for a date range. Shows how much each forwarder spent.",
    DATE_PARAMS,
    ["start_date", "end_date"]
  ),
  fn(
    "search_transactions",
    "Search for specific transactions. Use when the user asks about a specific merchant, category, or amount range. All parameters are optional filters.",
    {
      ...DATE_PARAMS,
      merchant: { type: "string", description: "Merchant name to search for (case-insensitive partial match)" },
      category: { type: "string", description: "Category to filter by (exact match)" },
      user: { type: "string", description: "Forwarder to filter by (partial match)" },
      min_amount: { type: "number", description: "Minimum transaction amount" },
      max_amount: { type: "number", description: "Maximum transaction amount" },
      transaction_type: { type: "string", description: "Filter by transaction type: Debit or Credit" },
      limit: { type: "number", description: "Max results to return. Default 10." }
    }
  ),
  fn(
    "ask_user",
    "Ask the user a short clarifying question and wait for a free-text reply. Use when a required parameter is genuinely missing and cannot be inferred from prior context, OR when you need the user to pick one row before calling a mutation tool (update_transaction, split_transaction). For pure read-only answers, do NOT use ask_user for disambiguation — just present the options inline in your normal reply instead. Never use for confirmations or stylistic choices.",
    { question: { type: "string", description: "The question to ask. Max 200 chars. Plain text, no markdown." } },
    ["question"]
  ),
  fn(
    "update_transaction",
    "Update a single transaction's category, merchant tag, or transaction type. Identify the row via transaction_id from search_transactions. Use only when the user explicitly asks to change a transaction — never speculatively. Confirm any ambiguity with ask_user first.",
    {
      transaction_id: { type: "string", description: "The transaction_id from search_transactions output." },
      category: {
        type: "string",
        description: "New category. Must be one of the listed debit or credit categories appropriate to the row's type."
      },
      merchant: { type: "string", description: "New merchant / tag name. Short, 1-18 chars." },
      transaction_type: { type: "string", description: "New transaction type: Debit or Credit." }
    },
    ["transaction_id"]
  ),
  fn(
    "split_transaction",
    "Split a personal transaction into a group. Posts the split notification in the group chat. If the user has multiple groups, call get_groups first or ask_user to disambiguate. Never split a transaction that already shows split=true in search results.",
    {
      transaction_id: { type: "string", description: "The transaction_id from search_transactions output." },
      group_chat_id: {
        type: "string",
        description: "The group's chat_id from get_groups output. Optional if the user has only one group."
      },
      mode: {
        type: "string",
        description:
          "Split mode: '50' (50/50 between 2 members), 'p100' (the other 2-member owes 100%), 'all' (even across all members), 'wN' (everyone except member index N), 'iN' (just payer + member index N). Member index N is the 0-based index in the group's members list from get_groups."
      }
    },
    ["transaction_id", "mode"]
  ),
  fn(
    "get_groups",
    "List the active groups the current user is a member of. Use before split_transaction when the user hasn't specified the group, or when you need member indices for 'wN' / 'iN' split modes."
  )
];

export function askSystemPrompt(today) {
  return (
    "You are a concise spending analyst for a personal expense tracker.\n" +
    "Today's date is " +
    today +
    ".\n\n" +
    "You have tools to query expense data. Use them to answer questions about spending, transactions, and settlements.\n\n" +
    "Rules:\n" +
    "- When no date range is specified, default to last 10 days: " +
    shiftIsoDate(today, -10) +
    " to " +
    today +
    "\n" +
    "- When no user is specified, include all users combined\n" +
    "- Format currency amounts with the symbol and a rounded whole number, no thousands separator or decimals (e.g. ₹1234, $550, €99). Currency symbols: INR=₹, USD=$, EUR=€, GBP=£, JPY/CNY=¥, AUD=A$, CAD=C$, SGD=S$, HKD=HK$, NZD=NZ$. For currencies not listed here, use the 3-letter code prefix instead (e.g. AED 500). Show INR prominently; other currencies only if present\n" +
    "- Keep answers short — 2-5 sentences max. Use bullet points for lists\n" +
    "- Do NOT use Markdown bold/italic formatting\n" +
    "- If the question is unrelated to expenses or transactions, politely decline\n" +
    "- If a tool returns empty results, say so clearly — do not guess or hallucinate\n" +
    "- You may call multiple tools to answer complex questions\n" +
    "- Available debit categories: " +
    CATEGORIES.join(", ") +
    "\n" +
    "- Available credit categories: " +
    CREDIT_CATEGORIES.join(", ") +
    "\n" +
    "- 'Spending' means spend_by_currency: it excludes " +
    NON_SPEND.join(", ") +
    " (money moved, not spent). Mention those separately only when asked or when they explain a total\n" +
    "- Amounts of transactions split into a group count only the user's own share (your_share in search results)\n" +
    "- Correct likely typos in merchant names before searching (e.g., flipart → flipkart, swiggi → swiggy, amzn → amazon)\n" +
    "- Use short/common merchant name for search — the data may have suffixes like _mws_merch\n" +
    "- Prefer answering with the data you already have. For read-only answers, call ask_user only when a required parameter is genuinely missing and cannot be inferred — never for confirmation or stylistic choices. For mutation tools, see below.\n" +
    "- CRITICAL: A final text answer MUST be a complete statement, never a question to the user. If your final answer would ask the user anything (e.g. 'Which one?', 'Want a breakdown?', 'Should I update X?'), STOP — call the ask_user tool with that question instead. Rhetorical questions are also forbidden — rephrase as a statement.\n" +
    "\nMutation tools (update_transaction, split_transaction):\n" +
    "- Run them ONLY when the user explicitly asks to change or split a transaction. Never speculate.\n" +
    "- Always identify the row via transaction_id from a prior search_transactions call. If you don't have one, run search_transactions first.\n" +
    "- If the search returns more than one plausible match, you MUST call the ask_user tool to disambiguate before mutating.\n" +
    "- After a successful mutation, briefly confirm what changed in plain text (e.g. 'Updated: category Food → Transfer'). Do not re-run search.\n" +
    "- For split_transaction: if the user has multiple groups and the user didn't specify one, call get_groups first; if still ambiguous, call ask_user.\n"
  );
}

// ─── Tools ───────────────────────────────────────────────────────────

const label = (r) => r.merchant || r.merchant_raw || "Unknown";

function sumByCurrency(rows) {
  const out = {};
  for (const r of rows) out[r.currency] = (out[r.currency] || 0) + r.effective_minor;
  for (const c of Object.keys(out)) out[c] = fromMinor(out[c]);
  return out;
}

function aggregate(rows, keyOf) {
  const groups = {};
  for (const r of rows) {
    const name = keyOf(r);
    const k = name + "|" + r.currency;
    groups[k] = groups[k] || { name, currency: r.currency, amount: 0, count: 0, rows: [] };
    groups[k].amount += r.effective_minor;
    groups[k].count++;
    groups[k].rows.push(r);
  }
  return Object.values(groups)
    .sort((a, b) => b.amount - a.amount)
    .map((g) => ({ ...g, amount: fromMinor(g.amount) }));
}

// Tool executor bound to one tenant. Rows are loaded per date range.
export function askToolExecutor(ctx, tenantId) {
  const cache = {};
  const rowsFor = (args) => {
    const key = (args.start_date || "") + "|" + (args.end_date || "");
    cache[key] =
      cache[key] || listEffectiveTransactions(ctx.db, tenantId, { from: args.start_date, to: args.end_date });
    return cache[key];
  };

  const tools = {
    async get_spending_summary(args) {
      const rows = await rowsFor(args);
      const spend = rows.filter((r) => r.kind === "spend");
      const credits = rows.filter((r) => r.direction === "credit");
      return {
        total_transactions: rows.length,
        spend_count: spend.length,
        credit_count: credits.length,
        spend_by_currency: sumByCurrency(spend),
        non_spend_debits_by_currency: sumByCurrency(rows.filter((r) => r.direction === "debit" && r.kind !== "spend")),
        credits_by_currency: sumByCurrency(credits)
      };
    },
    async get_category_breakdown(args) {
      const debits = (await rowsFor(args)).filter((r) => r.direction === "debit");
      return {
        categories: aggregate(debits, (r) => r.category || "Uncategorized").map(({ rows, ...c }) => ({
          ...c,
          counts_as_spend: rows.every((r) => r.kind === "spend")
        }))
      };
    },
    async get_top_merchants(args) {
      const spend = (await rowsFor(args)).filter((r) => r.kind === "spend");
      return {
        merchants: aggregate(spend, label)
          .slice(0, args.limit || 5)
          .map(({ rows, ...m }) => m)
      };
    },
    async get_user_spend(args) {
      const users = {};
      for (const r of (await rowsFor(args)).filter((x) => x.kind === "spend")) {
        const u = r.forwarder || "you";
        users[u] = users[u] || {};
        users[u][r.currency] = (users[u][r.currency] || 0) + r.effective_minor;
      }
      for (const u of Object.keys(users)) for (const c of Object.keys(users[u])) users[u][c] = fromMinor(users[u][c]);
      return { users };
    },
    async search_transactions(args) {
      let rows = await rowsFor(args);
      if (args.merchant) {
        const m = String(args.merchant).toLowerCase();
        rows = rows.filter(
          (r) => (r.merchant || "").toLowerCase().includes(m) || (r.merchant_raw || "").toLowerCase().includes(m)
        );
      }
      if (args.category) rows = rows.filter((r) => r.category === args.category);
      if (args.user)
        rows = rows.filter((r) => (r.forwarder || "").toLowerCase().includes(String(args.user).toLowerCase()));
      if (args.transaction_type) {
        const dir = String(args.transaction_type).trim().toLowerCase();
        rows = rows.filter((r) => r.direction === dir);
      }
      if (args.min_amount !== undefined) rows = rows.filter((r) => r.amount_minor >= toMinor(args.min_amount));
      if (args.max_amount !== undefined) rows = rows.filter((r) => r.amount_minor <= toMinor(args.max_amount));
      rows = rows.slice(-(args.limit || 10));
      return {
        count: rows.length,
        transactions: rows.map((r) => {
          const out = {
            transaction_id: r.id,
            date: r.occurred_on,
            merchant: label(r),
            amount: fromMinor(r.amount_minor),
            currency: r.currency,
            category: r.category || "",
            type: r.direction === "debit" ? "Debit" : "Credit",
            user: r.forwarder || ""
          };
          if (r.split_id || r.settlement_id) {
            out.split = true;
            out.your_share = fromMinor(r.effective_minor);
          }
          return out;
        })
      };
    },
    async update_transaction(args) {
      const txn = args.transaction_id && (await getTransaction(ctx.db, tenantId, args.transaction_id));
      if (!txn || txn.status !== "confirmed")
        return { ok: false, error: "Transaction not found for transaction_id: " + args.transaction_id };
      const patch = {};
      const changes = [];
      let direction = txn.direction;
      if (args.transaction_type) {
        const t = String(args.transaction_type);
        if (t !== "Debit" && t !== "Credit")
          return { ok: false, error: "transaction_type must be 'Debit' or 'Credit'" };
        direction = t.toLowerCase();
        if (direction !== txn.direction) {
          patch.direction = direction;
          changes.push({ field: "transaction_type", from: txn.direction === "debit" ? "Debit" : "Credit", to: t });
        }
      }
      let category = txn.category;
      if (args.category) {
        const valid = categoriesFor(direction);
        if (!valid.includes(args.category)) {
          return {
            ok: false,
            error: "Invalid category for a " + direction + " transaction. Valid: " + valid.join(", ")
          };
        }
        category = args.category;
        patch.category = category;
        changes.push({ field: "category", from: txn.category, to: category });
      }
      if (args.merchant) {
        const tag = String(args.merchant).trim();
        if (!tag || tag.length > TAG_MAX_LEN)
          return { ok: false, error: "merchant must be 1–" + TAG_MAX_LEN + " characters" };
        patch.merchant = tag;
        changes.push({ field: "merchant", from: label(txn), to: tag });
      }
      if (!changes.length)
        return { ok: false, error: "Nothing to update — pass at least one of: category, merchant, transaction_type" };
      if (patch.direction || patch.category) patch.kind = defaultKind(direction, category);
      await updateTransaction(ctx.db, tenantId, txn.id, patch, ctx.now());
      if (patch.category && (txn.merchant || txn.merchant_raw)) {
        await upsertMerchantRule(ctx.db, tenantId, txn.merchant || txn.merchant_raw, { category }, ctx.now());
      }
      await refreshCardMessage(ctx, tenantId, txn.id);
      return { ok: true, transaction_id: txn.id, changes };
    },
    async get_groups() {
      const groups = await groupsForMember(ctx.db, tenantId);
      const out = [];
      for (const g of groups) {
        const members = [];
        for (const [index, id] of (await getGroupMembers(ctx.db, g.id)).entries()) {
          members.push({ index, chat_id: id, name: await memberName(ctx, g.id, id) });
        }
        out.push({ chat_id: g.id, name: g.name, primary_currency: g.primary_currency, members });
      }
      return { ok: true, count: out.length, groups: out };
    },
    async split_transaction(args) {
      if (!args.transaction_id) return { ok: false, error: "transaction_id is required" };
      if (!args.mode) return { ok: false, error: "mode is required (e.g. '50', 'all', 'p100', 'wN', 'iN')" };
      let groupId = args.group_chat_id;
      if (!groupId) {
        const groups = await groupsForMember(ctx.db, tenantId);
        if (groups.length === 0) return { ok: false, error: "You are not in any active group." };
        if (groups.length > 1)
          return { ok: false, error: "Multiple groups available — call get_groups and pass group_chat_id explicitly." };
        groupId = groups[0].id;
      }
      const res = await splitTransaction(ctx, {
        payerId: tenantId,
        txnId: args.transaction_id,
        groupId,
        mode: args.mode
      });
      if (!res.ok) return { ok: false, error: res.error };
      await refreshCardMessage(ctx, tenantId, args.transaction_id);
      return {
        ok: true,
        transaction_id: args.transaction_id,
        group_chat_id: String(groupId),
        merchant: label(res.txn),
        amount: fromMinor(res.txn.amount_minor),
        currency: res.txn.currency,
        holders: res.holders,
        shares: res.shares.map(fromMinor)
      };
    }
  };

  return async (name, args) => (tools[name] ? tools[name](args || {}) : { error: "Unknown tool: " + name });
}

// ─── Quota copy ──────────────────────────────────────────────────────

export function capHitMessage(nowMs) {
  const istMs = nowMs + 5.5 * 3600 * 1000;
  const secs = Math.floor((istMs % 86400000) / 1000);
  const left = Math.max(1, 1440 - Math.ceil(secs / 60));
  const h = Math.floor(left / 60);
  const m = left % 60;
  const until = h === 0 ? m + "m" : m === 0 ? h + "h" : h + "h " + m + "m";
  return (
    "🔒 *Daily /ask limit reached*\n\nYou've used today's " +
    FREE_ASK_LIMIT +
    " /ask questions.\nResets at midnight IST (in " +
    until +
    ")."
  );
}

// ─── Flow ────────────────────────────────────────────────────────────

const ERROR_TEXT = "❌ Something went wrong. Try /stats for preset analytics, or ask again in a moment.";

// One /ask turn: quota → tool loop → answer / question / error.
async function runAsk(ctx, chatId, messages, turn) {
  if (turn > ASK_MAX_TURNS) {
    await ctx.tg.sendMessage(
      chatId,
      "This /ask conversation has too many follow-ups. Start over with /ask <full question>.",
      {
        parse_mode: null
      }
    );
    return;
  }
  const day = istDate(ctx.now());
  const quota = await consumeAsk(ctx.db, chatId, day, FREE_ASK_LIMIT);
  if (!quota.allowed) {
    await ctx.tg.sendMessage(chatId, capHitMessage(ctx.now()), {
      reply_markup: { inline_keyboard: [[{ text: "💎 Upgrade to Premium", callback_data: "premium_info" }]] }
    });
    return;
  }
  let result;
  try {
    result = await runToolLoop(ctx.llm, {
      messages,
      tools: ASK_TOOLS,
      executeTool: askToolExecutor(ctx, chatId),
      maxIterations: ASK_MAX_ITERATIONS,
      maxTokens: 800,
      suspendOn: ["ask_user"],
      onIteration: () => ctx.tg.sendChatAction(chatId).catch(() => {})
    });
  } catch (e) {
    console.error("[ask] failed:", e && e.message);
    await refundAsk(ctx.db, chatId, day, FREE_ASK_LIMIT);
    await ctx.tg.sendMessage(chatId, ERROR_TEXT, { parse_mode: null });
    return;
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
        { messages: result.messages, askCallId: result.toolCall.id, turn },
        CONVO_TTL_SEC,
        ctx.now()
      );
    }
    return;
  }
  if (result.kind === "exhausted") {
    await ctx.tg.sendMessage(
      chatId,
      "I took too many steps trying to answer that. Try a simpler question or use /stats.",
      {
        parse_mode: null
      }
    );
    return;
  }
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
      { messages: result.messages, askCallId: null, turn },
      CONVO_TTL_SEC,
      ctx.now()
    );
  }
}

function startAsk(ctx, chatId, question) {
  const messages = [
    { role: "system", content: askSystemPrompt(istDate(ctx.now())) },
    { role: "user", content: question }
  ];
  return runAsk(ctx, chatId, messages, 1);
}

export async function handleAsk(ctx, m) {
  const question = m.text.replace(/^\/ask(@\w+)?\s*/i, "").trim();
  if (!question) {
    await setPending(ctx, "ask", m.chatId);
    await ctx.tg.sendMessage(
      m.chatId,
      "❓ What would you like to know about your spending?\n\nExamples:\n• How much did I spend on food last month?\n• Top merchants this month\n• Who owes whom in my group?\n• Compare grocery spending Feb vs Mar\n\nReply with your question, or send /ask <question> directly.",
      { parse_mode: null, reply_markup: { force_reply: true, input_field_placeholder: "Ask about your spending…" } }
    );
    return;
  }
  await clearPending(ctx, "ask", m.chatId);
  await startAsk(ctx, m.chatId, question);
}

// Plain-text steps. Each returns true when it consumed the message.
export async function handleAskResume(ctx, m) {
  if (!m.replyTo || !m.replyTo.message_id) return false;
  const convo = await takeEphemeral(ctx.db, convoKey(m.chatId, m.replyTo.message_id), ctx.now());
  if (!convo) return false;
  const reply = convo.askCallId
    ? { role: "tool", tool_call_id: convo.askCallId, content: m.text }
    : { role: "user", content: m.text };
  await runAsk(ctx, m.chatId, convo.messages.concat([reply]), convo.turn + 1);
  return true;
}

export async function handlePendingAsk(ctx, m) {
  if (!(await takePending(ctx, "ask", m.chatId))) return false;
  const question = m.text.trim();
  if (!question) await ctx.tg.sendMessage(m.chatId, "❌ Empty question, /ask cancelled.", { parse_mode: null });
  else await startAsk(ctx, m.chatId, question);
  return true;
}

// 💬 Follow up: single-use; re-key the conversation to a force-reply prompt.
export async function handleAskFollowUp(ctx, chatId, messageId) {
  await ctx.tg.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] }).catch(() => {});
  const convo = await takeEphemeral(ctx.db, convoKey(chatId, messageId), ctx.now());
  if (!convo) {
    await ctx.tg.sendMessage(chatId, "_That follow-up window has expired. Start a fresh /ask whenever you're ready._");
    return;
  }
  const sent = await ctx.tg.sendMessage(chatId, "_What's your follow-up?_", {
    reply_markup: { force_reply: true, selective: true }
  });
  if (sent && sent.message_id) {
    await putEphemeral(ctx.db, convoKey(chatId, sent.message_id), convo, CONVO_TTL_SEC, ctx.now());
  }
}
