// Central conversational orchestrator for personal DMs.
//
// Plain-text messages flow through either a fast deterministic pre-router
// (when intent is unambiguous, saving an LLM hop) or `TriageAgent`, landing in
// one of four focused specialists:
//   1. analytics — read-only spending summaries, trends, search (quota-metered)
//   2. ledger    — tagging, batch categorization, edits, unfamiliar alert ingest (exempt)
//   3. groups    — splits, group balances, cash settlements, undo split (exempt)
//   4. account   — email registration, setup resend, backfill, CSV/Sheet export,
//                  delete-data prompt, live dashboard pin (exempt)
import { defineAgent, runAgentLoop } from "../llm/agents.js";
import { listEffectiveTransactions } from "../db/analytics.js";
import {
  getTransaction,
  findTransactionByCardMessage,
  updateTransaction,
  listUntaggedTransactions,
  isUntaggedTransaction
} from "../db/transactions.js";
import { upsertMerchantRule } from "../db/merchantRules.js";
import { getTenant, getTenantEmails, groupsForMember, getGroupMembers } from "../db/tenants.js";
import { groupBalances, recordSettlement, setSettlementGroupMessage, deleteSettlement } from "../db/splits.js";
import { consumeAsk, refundAsk } from "../db/quota.js";
import { putEphemeral, takeEphemeral, deleteEphemeral } from "../db/ephemeral.js";
import { setPending, takePending, clearPending } from "./pending.js";
import { refreshCardMessage } from "./cardState.js";
import { teachCategoryRules, applyLearnedCategoryToUntagged } from "./cardActions.js";
import { refreshPersonalPin, ensurePersonalPin } from "./personalPin.js";
import { splitTransaction, undoGroupLink, simplifyDebts, refreshBalancesPin, memberName } from "./groups.js";
import { monthlyTrends, weeklyTrends } from "./analytics.js";
import { registerEmailForChat, sendSetupEmail } from "./commands.js";
import { handleBackfill } from "./backfill.js";
import { handleExport, handleDeleteMyData } from "./data.js";
import { handleSmsPaste } from "./sms.js";
import { escapeMarkdown, money } from "./format.js";
import { CATEGORIES, CREDIT_CATEGORIES, FREE_ASK_LIMIT, TAG_MAX_LEN, categoriesFor } from "./constants.js";
import { istDate, shiftIsoDate } from "../util/dates.js";
import { defaultKind } from "../util/kind.js";
import { fromMinor, toMinor } from "../util/money.js";

export const ASK_MAX_ITERATIONS = 6;
export const ASK_MAX_TURNS = 5;
const CONVO_TTL_SEC = 600;
const NON_SPEND = ["CC Bill Payment", "Transfer Out", "Investment"];

const convoKey = (chatId, messageId) => "ask:" + chatId + ":" + messageId;
export const openAskKey = (chatId) => "ask_open:" + chatId;

const DATE_PARAMS = {
  start_date: { type: "string", description: "Start date in YYYY-MM-DD format" },
  end_date: { type: "string", description: "End date in YYYY-MM-DD format" }
};

const fn = (name, description, properties = {}, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } }
});

// ─── Tool schemas ────────────────────────────────────────────────────

const ASK_USER_TOOL = fn(
  "ask_user",
  "Ask the user a short clarifying question and wait for a free-text reply. Use when a required parameter is genuinely missing and cannot be inferred from context, OR when multiple transactions match before mutating/splitting. Never use for confirmations on read-only queries.",
  { question: { type: "string", description: "The question to ask. Max 200 chars. Plain text, no markdown." } },
  ["question"]
);

const SEARCH_TOOL = fn(
  "search_transactions",
  "Search transactions by date, merchant, category, untagged status, forwarder, or amount range.",
  {
    ...DATE_PARAMS,
    merchant: { type: "string", description: "Merchant name (case-insensitive partial match)" },
    category: { type: "string", description: "Exact category filter" },
    untagged_only: {
      type: "boolean",
      description:
        "When true, return only untagged rows (missing merchant/'Unknown' OR missing category/'Uncategorized')."
    },
    user: { type: "string", description: "Forwarder filter (partial match)" },
    min_amount: { type: "number", description: "Minimum transaction amount" },
    max_amount: { type: "number", description: "Maximum transaction amount" },
    transaction_type: { type: "string", description: "Debit or Credit" },
    limit: { type: "number", description: "Max results to return. Default 10." }
  }
);

const LIST_UNTAGGED_TOOL = fn(
  "list_untagged_transactions",
  "List confirmed transactions that are untagged — i.e. missing a merchant tag ('Unknown' / 'Untagged') OR missing a category ('Uncategorized'). Supports optional start_date and end_date filters.",
  {
    ...DATE_PARAMS,
    limit: { type: "number", description: "Max rows to return. Default 15." }
  }
);

export const ANALYTICS_TOOLS = [
  fn(
    "get_spending_summary",
    "Get total spending and income summary for a date range. spend_by_currency excludes card bill payments, transfers out and investments (reported separately as non_spend_debits_by_currency).",
    DATE_PARAMS,
    ["start_date", "end_date"]
  ),
  fn(
    "get_category_breakdown",
    "Get spending breakdown by category for a date range, including untagged count.",
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
    "get_spending_trends",
    "Get multi-week or multi-month spending trend buckets and category movers.",
    {
      granularity: { type: "string", description: "'weekly' (last 5 weeks) or 'monthly' (last 6 months)" }
    },
    ["granularity"]
  ),
  SEARCH_TOOL,
  LIST_UNTAGGED_TOOL,
  ASK_USER_TOOL
];

export const LEDGER_TOOLS = [
  LIST_UNTAGGED_TOOL,
  SEARCH_TOOL,
  fn(
    "update_transaction",
    "Update a single transaction's category, merchant tag, or transaction type. Identify via transaction_id from search_transactions or list_untagged_transactions.",
    {
      transaction_id: { type: "string", description: "The transaction_id." },
      category: { type: "string", description: "Valid debit or credit category." },
      merchant: { type: "string", description: "Short merchant / tag name (1–18 chars)." },
      transaction_type: { type: "string", description: "Debit or Credit." }
    },
    ["transaction_id"]
  ),
  fn(
    "batch_update_transactions",
    "Update multiple transactions at once (for example when the user categorizes several untagged expenses in one reply).",
    {
      items: {
        type: "array",
        description: "Transactions to update.",
        items: {
          type: "object",
          properties: {
            transaction_id: { type: "string" },
            category: { type: "string" },
            merchant: { type: "string" },
            transaction_type: { type: "string" }
          },
          required: ["transaction_id"]
        }
      }
    },
    ["items"]
  ),
  fn(
    "ingest_transaction_text",
    "Parse and save a pasted bank alert / payment notification message that wasn't caught automatically.",
    {
      text: { type: "string", description: "Verbatim transaction alert text from the user." }
    },
    ["text"]
  ),
  ASK_USER_TOOL
];

export const GROUP_TOOLS = [
  fn("get_groups", "List the active groups the current user belongs to, with member chat_ids and names."),
  fn("get_group_balances", "Show who owes whom in a group (or all groups if omitted).", {
    group_chat_id: { type: "string", description: "Optional group chat_id from get_groups." },
    simplified: { type: "boolean", description: "True for simplified minimum transfers (default true)." }
  }),
  SEARCH_TOOL,
  fn(
    "split_transaction",
    "Split a personal transaction into a group. Posts the split notification in the group chat. Never split a transaction that already shows split=true.",
    {
      transaction_id: { type: "string", description: "The transaction_id from search_transactions." },
      group_chat_id: { type: "string", description: "Optional if the user belongs to only one group." },
      mode: {
        type: "string",
        description:
          "Split mode: '50' (50/50 between 2 members), 'p100' (other 2-member owes 100%), 'all' (even across all), 'wu<chat_id>' (everyone except member), 'iu<chat_id>' (just payer + member)."
      }
    },
    ["transaction_id", "mode"]
  ),
  fn(
    "record_cash_settlement",
    "Record an off-email cash or direct settlement paid to another group member.",
    {
      group_chat_id: { type: "string", description: "Optional if the user belongs to only one group." },
      to_member_id: { type: "string", description: "Recipient member's chat_id from get_groups." },
      amount: { type: "number", description: "Positive settlement amount." },
      currency: { type: "string", description: "3-letter currency code, default INR." }
    },
    ["to_member_id", "amount"]
  ),
  fn(
    "undo_split",
    "Revert a group split or settlement on a personal transaction (makes it personal again).",
    { transaction_id: { type: "string", description: "The transaction_id to unsplit." } },
    ["transaction_id"]
  ),
  ASK_USER_TOOL
];

export const ACCOUNT_TOOLS = [
  fn("get_account_status", "Show account status, registered forwarder emails, groups, and untagged expense count."),
  fn(
    "register_email",
    "Register a Gmail address to forward bank emails from and email the setup instructions.",
    { email: { type: "string", description: "Email address to register, e.g. alice@gmail.com" } },
    ["email"]
  ),
  fn("resend_setup_email", "Resend the Gmail auto-forwarding setup email to registered addresses."),
  fn(
    "start_backfill",
    "Scan past bank emails in the bot inbox for a recent duration or date range.",
    {
      range: {
        type: "string",
        description: "Duration like '3 days', '2 weeks', '1 month', or 'YYYY-MM-DD YYYY-MM-DD'."
      }
    },
    ["range"]
  ),
  fn("export_transactions", "Send a CSV export (plus Open in Google Sheets button) for all time or a date range.", {
    range: {
      type: "string",
      description: "Optional '' for all time, 'YYYY-MM' for a month, or 'YYYY-MM-DD YYYY-MM-DD'."
    }
  }),
  fn(
    "prompt_delete_all_data",
    "Send the confirmation card with Delete / Keep buttons so the user can permanently delete all stored data."
  ),
  fn("show_dashboard", "Post and pin the live monthly spending summary card in this chat."),
  ASK_USER_TOOL
];

// Combined tool schema list preserved for compatibility / introspection.
export const ASK_TOOLS = [
  ...ANALYTICS_TOOLS.filter((t) => t.function.name !== "ask_user"),
  ...LEDGER_TOOLS.filter(
    (t) => !["search_transactions", "list_untagged_transactions", "ask_user"].includes(t.function.name)
  ),
  ...GROUP_TOOLS.filter((t) => !["search_transactions", "ask_user"].includes(t.function.name)),
  ...ACCOUNT_TOOLS.filter((t) => t.function.name !== "ask_user"),
  ASK_USER_TOOL
];

// ─── Prompts ─────────────────────────────────────────────────────────

const CURRENCY_RULE =
  "- Format currency amounts with the symbol and a rounded whole number, no thousands separator or decimals (e.g. ₹1234, $550, €99). Currency symbols: INR=₹, USD=$, EUR=€, GBP=£, JPY/CNY=¥, AUD=A$, CAD=C$, SGD=S$, HKD=HK$, NZD=NZ$. For others use 3-letter code prefix (e.g. AED 500).\n" +
  "- Keep answers concise (2–5 sentences max, bullet points for lists). Plain text only — do NOT use Markdown bold/italic.\n" +
  "- CRITICAL: A final text reply MUST be a statement, never a question. If you need user input, call ask_user instead.\n";

export function askSystemPrompt(today) {
  return (
    "You are a concise spending analyst for Dus Aane Bot.\n" +
    "Today's date is " +
    today +
    ".\n\n" +
    "Rules:\n" +
    "- Default date range when unspecified: last 10 days (" +
    shiftIsoDate(today, -10) +
    " to " +
    today +
    ").\n" +
    "- Default user filter when unspecified: all users combined.\n" +
    CURRENCY_RULE +
    "- 'Spending' means spend_by_currency (excludes " +
    NON_SPEND.join(", ") +
    "). Mention non-spend debits only when asked or when explaining totals.\n" +
    "- Split transactions count only your_share.\n" +
    "- Available debit categories: " +
    CATEGORIES.join(", ") +
    "\n- Available credit categories: " +
    CREDIT_CATEGORIES.join(", ") +
    "\n- Fix obvious merchant typos before searching (flipart → flipkart, swiggi → swiggy, amzn → amazon).\n" +
    "- An 'untagged' transaction is any row missing its merchant tag (Unknown/Untagged) OR missing its category (Uncategorized). Use list_untagged_transactions (passing start_date and end_date when a timeframe is given; e.g. 'past 2 days' means " +
    shiftIsoDate(today, -2) +
    " to " +
    today +
    ") to count or list them.\n" +
    "- If untagged_count > 0 in category breakdown, briefly mention how many transactions still need tagging.\n" +
    "- If the user wants to tag/edit, split/settle, or export/backfill/manage their account, transfer via the matching route_to_* tool."
  );
}

function ledgerSystemPrompt(today) {
  return (
    "You are the transaction tagging and ledger editor for Dus Aane Bot.\n" +
    "Today's date is " +
    today +
    ".\n\n" +
    "Rules:\n" +
    CURRENCY_RULE +
    "- Debit categories: " +
    CATEGORIES.join(", ") +
    "\n- Credit categories: " +
    CREDIT_CATEGORIES.join(", ") +
    "\n- An 'untagged' transaction is any confirmed row missing its merchant tag (Unknown/Untagged) OR missing its category (Uncategorized). Call list_untagged_transactions (passing start_date and end_date when a timeframe is asked, e.g. 'past 2 days' = " +
    shiftIsoDate(today, -2) +
    " to " +
    today +
    ") to count or list them.\n" +
    "- Never guess transaction_id: find it via list_untagged_transactions or search_transactions first.\n" +
    "- When multiple plausible rows match, call ask_user to disambiguate before mutating.\n" +
    "- When the user categorizes multiple items in one message (e.g. 'Rahul is Food, Kirana is Groceries'), call batch_update_transactions.\n" +
    "- Only call ingest_transaction_text when the user pasted a genuine bank/card payment alert that wasn't auto-saved. If a message like 'paid 500 to Rahul' matches an existing untagged ₹500 row from today, tag that row instead of creating a duplicate.\n" +
    "- Briefly confirm what changed (e.g. 'Tagged Rahul Sharma as Food & Dining')."
  );
}

function groupSystemPrompt(today) {
  return (
    "You are the group expense & settlement specialist for Dus Aane Bot.\n" +
    "Today's date is " +
    today +
    ".\n\n" +
    "Rules:\n" +
    CURRENCY_RULE +
    "- For who-owes-whom / balances, call get_group_balances.\n" +
    "- Before split_transaction, locate transaction_id via search_transactions (default last 10 days: " +
    shiftIsoDate(today, -10) +
    " to " +
    today +
    "). If >1 match, call ask_user.\n" +
    "- Never split a row with split=true.\n" +
    "- If the user has multiple groups and didn't specify one, call get_groups and disambiguate with ask_user."
  );
}

function accountSystemPrompt(today, status) {
  return (
    "You are the account & data operations assistant for Dus Aane Bot.\n" +
    "Today's date is " +
    today +
    ". Account status: " +
    (status || "active") +
    ".\n\n" +
    "Rules:\n" +
    CURRENCY_RULE +
    "- Use register_email when the user gives a Gmail address to add; if they ask to register without giving an email, call ask_user for their Gmail address.\n" +
    "- Use start_backfill when they ask to scan/import past bank emails (ask_user for the timeframe if missing).\n" +
    "- Use export_transactions for CSV / Google Sheet exports.\n" +
    "- Use prompt_delete_all_data when they ask to delete/wipe their data (it posts confirmation buttons; never claim data is already deleted).\n" +
    "- Use show_dashboard when they ask for a quick overview card or pinned dashboard.\n" +
    "- When a tool returns already_sent_to_chat=true, return an empty reply unless extra clarification is needed."
  );
}

function triageSystemPrompt(today) {
  return (
    "You are the central router for Dus Aane Bot, a personal and shared expense tracker on Telegram.\n" +
    "Today's date is " +
    today +
    ".\n\n" +
    "Route every expense, transaction, tagging, group split, settlement, onboarding, backfill, or export message immediately to the right specialist:\n" +
    "- route_to_analytics: spending totals, category breakdowns, top merchants, trends, searching transactions.\n" +
    "- route_to_ledger: tagging/categorizing untagged spends, editing merchant/category/type, or saving a pasted bank alert.\n" +
    "- route_to_groups: splitting expenses, checking who owes whom, settling balances, undoing splits.\n" +
    "- route_to_account: registering Gmail, resending setup instructions, backfilling emails, exporting CSV/Sheets, pinning dashboard, or deleting account data.\n\n" +
    "Only answer directly (plain text, 1–2 sentences, no markdown, no questions) if the user sends a greeting/help question (summarize what they can ask in plain English) or an off-topic non-finance request (politely decline)."
  );
}

// ─── Deterministic fast pre-router (saves 1 LLM hop when unambiguous) ─

const ACCOUNT_RE =
  /^(?:\/?(?:register|account|export|backfill|deletemydata|sheet)\b)|(?:\b(?:export|csv|google\s+sheet|backfill|resend\s+setup|setup\s+(?:email|instructions|steps)|account\s+status|my\s+account|delete\s+(?:all\s+)?my\s+data|wipe\s+my\s+data|(?:pin|show)\s+(?:my\s+)?dashboard|add\s+(?:an?\s+|another\s+|my\s+)?email)\b)/i;
const GROUP_RE =
  /^(?:\/?settle\b)|(?:\b(?:split|50[-\/]50|who\s+owes|owe(?:s|d)?\s+(?:me|whom|bob|alice)?|group\s+balance|settle(?:\s+up|\s+with)?|settled\s+with|simplify\s+debts?|make\s+.+\s+personal|undo\s+split)\b)/i;
const LEDGER_RE =
  /\b(?:untagged|uncategorized|categorize|recategorize|re-?tag|tag\s+(?:this|that|it|the|my)?|mark\s+.+\s+as\b|change\s+.*category|update\s+transaction)\b|\bmake\s+\S+\s+(?:shopping|groceries|food|healthcare|fuel|entertainment|travel|bills|education|investment|subscriptions|transfer|salary|refund|cashback|reimbursement)\b/i;
const ALERT_WORDS_RE = /\b(?:debited|credited|charged|withdrawn|utr|rrn|avl\s*bal|card\s+ending)\b/i;
const ANALYTICS_RE =
  /^(?:\/?(?:stats|recent)\b)|(?:\b(?:how\s+much|total\s+spend|top\s+merchants?|category\s+breakdown|spending|trends?|compare|recent|latest\s+transactions?|what\s+did\s+i\s+spend|spent\s+on|food\s+spend)\b)/i;

export function classifyFastAgent(text, tenantStatus = "active") {
  if (tenantStatus === "pending") return "account";
  const s = String(text || "").trim();
  if (!s) return null;
  if (ACCOUNT_RE.test(s)) return "account";
  if (GROUP_RE.test(s)) return "groups";
  if (LEDGER_RE.test(s)) return "ledger";
  if (!ALERT_WORDS_RE.test(s) && ANALYTICS_RE.test(s)) return "analytics";
  return null;
}

// ─── Tool implementations (strictly tenant-scoped) ───────────────────

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

export function askToolExecutor(ctx, tenantId, runMeta = {}) {
  const tid = String(tenantId);
  const cache = {};
  const rowsFor = (args = {}) => {
    const key = (args.start_date || "") + "|" + (args.end_date || "");
    cache[key] = cache[key] || listEffectiveTransactions(ctx.db, tid, { from: args.start_date, to: args.end_date });
    return cache[key];
  };
  const invalidateCache = () => {
    for (const k of Object.keys(cache)) delete cache[k];
  };

  async function applySingleUpdate(args) {
    const txn = args.transaction_id && (await getTransaction(ctx.db, tid, args.transaction_id));
    if (!txn || txn.status !== "confirmed") {
      return { ok: false, error: "Transaction not found for transaction_id: " + args.transaction_id };
    }
    const patch = {};
    const changes = [];
    let direction = txn.direction;
    if (args.transaction_type) {
      const t = String(args.transaction_type);
      if (t !== "Debit" && t !== "Credit") {
        return { ok: false, error: "transaction_type must be 'Debit' or 'Credit'" };
      }
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
      if (!tag || tag.length > TAG_MAX_LEN) {
        return { ok: false, error: "merchant must be 1–" + TAG_MAX_LEN + " characters" };
      }
      patch.merchant = tag;
      changes.push({ field: "merchant", from: label(txn), to: tag });
    }
    if (!changes.length) {
      return { ok: false, error: "Nothing to update — pass at least one of: category, merchant, transaction_type" };
    }
    if (patch.direction || patch.category) patch.kind = defaultKind(direction, category);
    await updateTransaction(ctx.db, tid, txn.id, patch, ctx.now());
    const updatedTxn = { ...txn, ...patch };
    if (patch.merchant && (txn.merchant || txn.merchant_raw)) {
      await upsertMerchantRule(ctx.db, tid, txn.merchant || txn.merchant_raw, { name: patch.merchant }, ctx.now());
    }
    if (patch.category) {
      await teachCategoryRules(ctx.db, tid, updatedTxn, category, ctx.now());
      await applyLearnedCategoryToUntagged(ctx, tid);
    }
    await refreshCardMessage(ctx, tid, txn.id);
    await refreshPersonalPin(ctx, tid);
    invalidateCache();
    return { ok: true, transaction_id: txn.id, changes };
  }

  const tools = {
    async get_spending_summary(args) {
      const rows = await rowsFor(args);
      const spend = rows.filter((r) => r.kind === "spend");
      const credits = rows.filter((r) => r.direction === "credit");
      const untagged = rows.filter(isUntaggedTransaction);
      return {
        total_transactions: rows.length,
        spend_count: spend.length,
        credit_count: credits.length,
        untagged_count: untagged.length,
        spend_by_currency: sumByCurrency(spend),
        non_spend_debits_by_currency: sumByCurrency(rows.filter((r) => r.direction === "debit" && r.kind !== "spend")),
        credits_by_currency: sumByCurrency(credits)
      };
    },

    async get_category_breakdown(args) {
      const allRows = await rowsFor(args);
      const debits = allRows.filter((r) => r.direction === "debit");
      const untaggedCount = allRows.filter(isUntaggedTransaction).length;
      return {
        untagged_count: untaggedCount,
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

    async get_spending_trends(args) {
      const monthly = String(args.granularity || "").toLowerCase() === "monthly";
      const buckets = monthly
        ? await monthlyTrends(ctx.db, tid, ctx.now())
        : await weeklyTrends(ctx.db, tid, ctx.now());
      return {
        granularity: monthly ? "monthly" : "weekly",
        buckets: buckets.map((b) => ({
          label: b.label,
          txn_count: b.txnCount,
          spend_by_currency: b.debitByCurrency,
          credits_by_currency: b.creditByCurrency,
          top_categories: Object.entries(b.categorySpend)
            .sort((a, c) => c[1] - a[1])
            .slice(0, 4)
            .map(([category, amount]) => ({ category, amount }))
        }))
      };
    },

    async search_transactions(args) {
      let rows = await rowsFor(args);
      if (args.untagged_only) rows = rows.filter(isUntaggedTransaction);
      if (args.merchant) {
        const m = String(args.merchant).toLowerCase();
        rows = rows.filter(
          (r) => (r.merchant || "").toLowerCase().includes(m) || (r.merchant_raw || "").toLowerCase().includes(m)
        );
      }
      if (args.category) rows = rows.filter((r) => r.category === args.category);
      if (args.user) {
        rows = rows.filter((r) => (r.forwarder || "").toLowerCase().includes(String(args.user).toLowerCase()));
      }
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
          if (isUntaggedTransaction(r)) out.untagged = true;
          if (r.split_id || r.settlement_id) {
            out.split = true;
            out.your_share = fromMinor(r.effective_minor);
          }
          return out;
        })
      };
    },

    async list_untagged_transactions(args) {
      const rows = await listUntaggedTransactions(ctx.db, tid, {
        from: args.start_date,
        to: args.end_date,
        limit: Math.min(25, Math.max(1, args.limit || 15))
      });
      return {
        count: rows.length,
        transactions: rows.map((r) => {
          const m = String(r.merchant || "").trim();
          const c = String(r.category || "").trim();
          const missingMerchant = !m || m.toLowerCase() === "unknown";
          const missingCategory = !c || c.toLowerCase() === "uncategorized";
          return {
            transaction_id: r.id,
            date: r.occurred_on,
            merchant: missingMerchant ? "Untagged" : m,
            category: missingCategory ? "Uncategorized" : c,
            missing_merchant: missingMerchant,
            missing_category: missingCategory,
            amount: fromMinor(r.amount_minor),
            currency: r.currency,
            type: r.direction === "debit" ? "Debit" : "Credit"
          };
        })
      };
    },

    update_transaction: applySingleUpdate,

    async batch_update_transactions(args) {
      const items = Array.isArray(args.items) ? args.items.slice(0, 20) : [];
      if (!items.length) return { ok: false, error: "items array is required" };
      const results = [];
      for (const item of items) results.push(await applySingleUpdate(item || {}));
      return { ok: results.every((r) => r.ok), updated: results.filter((r) => r.ok).length, results };
    },

    async ingest_transaction_text(args) {
      const text = String(args.text || "").trim();
      if (!text) return { ok: false, error: "text is required" };
      const tenant = await getTenant(ctx.db, tid);
      const handled = await handleSmsPaste(ctx, tenant, tid, text, { force: true });
      if (!handled) return { ok: false, error: "No transaction amount found in that text." };
      runMeta.suppressFinalText = true;
      invalidateCache();
      return { ok: true, already_sent_to_chat: true };
    },

    async get_groups() {
      const groups = await groupsForMember(ctx.db, tid);
      const out = [];
      for (const g of groups) {
        const members = [];
        for (const id of await getGroupMembers(ctx.db, g.id)) {
          members.push({ chat_id: id, name: await memberName(ctx, g.id, id) });
        }
        out.push({ chat_id: g.id, name: g.name, primary_currency: g.primary_currency, members });
      }
      return { ok: true, count: out.length, groups: out };
    },

    async get_group_balances(args) {
      let groups = await groupsForMember(ctx.db, tid);
      if (args.group_chat_id) groups = groups.filter((g) => g.id === String(args.group_chat_id));
      const simplify = args.simplified !== false;
      const out = [];
      for (const g of groups) {
        const raw = await groupBalances(ctx.db, g.id);
        const perCcy = simplify ? simplifyDebts(raw) : raw;
        const names = {};
        for (const id of await getGroupMembers(ctx.db, g.id)) names[id] = await memberName(ctx, g.id, id);
        const balances = {};
        for (const ccy of Object.keys(perCcy)) {
          balances[ccy] = perCcy[ccy].map((e) => ({
            from_id: e.debtor,
            from_name: names[e.debtor] || e.debtor,
            to_id: e.creditor,
            to_name: names[e.creditor] || e.creditor,
            amount: fromMinor(e.amountMinor)
          }));
        }
        out.push({ group_chat_id: g.id, name: g.name, simplified: simplify, balances });
      }
      return { ok: true, groups: out };
    },

    async split_transaction(args) {
      if (!args.transaction_id) return { ok: false, error: "transaction_id is required" };
      if (!args.mode) return { ok: false, error: "mode is required (e.g. '50', 'all', 'p100', 'wu<id>', 'iu<id>')" };
      let groupId = args.group_chat_id;
      if (!groupId) {
        const groups = await groupsForMember(ctx.db, tid);
        if (groups.length === 0) return { ok: false, error: "You are not in any active group." };
        if (groups.length > 1) {
          return { ok: false, error: "Multiple groups available — call get_groups and pass group_chat_id explicitly." };
        }
        groupId = groups[0].id;
      }
      const res = await splitTransaction(ctx, {
        payerId: tid,
        txnId: args.transaction_id,
        groupId,
        mode: args.mode
      });
      if (!res.ok) return { ok: false, error: res.error };
      await refreshCardMessage(ctx, tid, args.transaction_id);
      invalidateCache();
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
    },

    async record_cash_settlement(args) {
      const amount = Number(args.amount);
      if (!isFinite(amount) || amount <= 0) return { ok: false, error: "amount must be a positive number" };
      let groupId = args.group_chat_id;
      const groups = await groupsForMember(ctx.db, tid);
      if (!groupId) {
        if (groups.length === 0) return { ok: false, error: "You are not in any active group." };
        if (groups.length > 1) return { ok: false, error: "Multiple groups — specify group_chat_id." };
        groupId = groups[0].id;
      }
      const group = groups.find((g) => g.id === String(groupId));
      if (!group) return { ok: false, error: "Group not found." };
      const members = await getGroupMembers(ctx.db, group.id);
      const target = String(args.to_member_id || "");
      if (!members.includes(target) || target === tid) return { ok: false, error: "Invalid recipient member." };
      const ccy = String(args.currency || group.primary_currency || "INR").toUpperCase();
      const amountMinor = toMinor(amount);
      const settlementId = await recordSettlement(ctx.db, {
        groupId: group.id,
        fromId: tid,
        toId: target,
        amountMinor,
        currency: ccy,
        transactionId: null,
        now: ctx.now()
      });
      const [fromName, toName] = [await memberName(ctx, group.id, tid), await memberName(ctx, group.id, target)];
      let posted;
      try {
        posted = await ctx.tg.sendMessage(
          group.id,
          "🤝 *" +
            escapeMarkdown(fromName) +
            "* settled *" +
            money(amountMinor, ccy) +
            "* with *" +
            escapeMarkdown(toName) +
            "*",
          { disable_web_page_preview: true }
        );
      } catch (_) {}
      if (!posted || !posted.message_id) {
        await deleteSettlement(ctx.db, group.id, settlementId);
        return { ok: false, error: "Couldn't post settlement in the group chat." };
      }
      await setSettlementGroupMessage(ctx.db, settlementId, posted.message_id);
      await refreshBalancesPin(ctx, group);
      return { ok: true, group_chat_id: group.id, to_name: toName, amount, currency: ccy };
    },

    async undo_split(args) {
      if (!args.transaction_id) return { ok: false, error: "transaction_id is required" };
      const res = await undoGroupLink(ctx, { payerId: tid, txnId: args.transaction_id });
      if (!res.ok) return res;
      await refreshCardMessage(ctx, tid, args.transaction_id);
      invalidateCache();
      return { ok: true, transaction_id: args.transaction_id };
    },

    async get_account_status() {
      const tenant = await getTenant(ctx.db, tid);
      const [emails, groups, untagged] = await Promise.all([
        getTenantEmails(ctx.db, tid),
        groupsForMember(ctx.db, tid),
        listUntaggedTransactions(ctx.db, tid, { limit: 50 })
      ]);
      return {
        ok: true,
        status: (tenant && tenant.status) || "unregistered",
        name: (tenant && tenant.name) || "",
        emails,
        groups: groups.map((g) => ({ chat_id: g.id, name: g.name })),
        untagged_count: untagged.length
      };
    },

    async register_email(args) {
      await registerEmailForChat(ctx, tid, runMeta.username || "", args.email);
      runMeta.suppressFinalText = true;
      return { ok: true, already_sent_to_chat: true };
    },

    async resend_setup_email() {
      const emails = await getTenantEmails(ctx.db, tid);
      await sendSetupEmail(ctx, tid, emails);
      runMeta.suppressFinalText = true;
      return { ok: true, already_sent_to_chat: true };
    },

    async start_backfill(args) {
      const range = String(args.range || "").trim();
      await handleBackfill(ctx, tid, "/backfill " + range);
      runMeta.suppressFinalText = true;
      return { ok: true, already_sent_to_chat: true };
    },

    async export_transactions(args) {
      const range = String(args.range || "").trim();
      await handleExport(ctx, tid, range ? "/export " + range : "/export");
      runMeta.suppressFinalText = true;
      return { ok: true, already_sent_to_chat: true };
    },

    async prompt_delete_all_data() {
      const tenant = await getTenant(ctx.db, tid);
      await handleDeleteMyData(ctx, tid, tenant);
      runMeta.suppressFinalText = true;
      return { ok: true, already_sent_to_chat: true };
    },

    async show_dashboard() {
      await ensurePersonalPin(ctx, tid);
      runMeta.suppressFinalText = true;
      return { ok: true, already_sent_to_chat: true };
    }
  };

  return async (name, args) => (tools[name] ? tools[name](args || {}) : { error: "Unknown tool: " + name });
}

// ─── Agent graph construction ────────────────────────────────────────

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

// ─── Quota copy ──────────────────────────────────────────────────────

export function capHitMessage(nowMs) {
  const istMs = nowMs + 5.5 * 3600 * 1000;
  const secs = Math.floor((istMs % 86400000) / 1000);
  const left = Math.max(1, 1440 - Math.ceil(secs / 60));
  const h = Math.floor(left / 60);
  const m = left % 60;
  const until = h === 0 ? m + "m" : m === 0 ? h + "h" : h + "h " + m + "m";
  return (
    "🔒 *Daily analytics limit reached*\n\nYou've used today's " +
    FREE_ASK_LIMIT +
    " spending analysis questions (tagging, splits, and exports still work anytime).\nResets at midnight IST (in " +
    until +
    ")."
  );
}

// ─── Turn runner & state persistence ─────────────────────────────────

const ERROR_TEXT = "❌ Something went wrong. Tap your pinned summary for recent spends, or try again in a moment.";

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

  // If Triage routed to a quota-exempt specialist (ledger/groups/account), refund the pre-hold.
  if (consumedQuota && result.quotaExempt) {
    await refundAsk(ctx.db, chatId, day, FREE_ASK_LIMIT);
  }
  // Conversely, if a quota-exempt specialist handed off to analytics, charge quota if available.
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

// Resume an explicit swipe-reply or an open ask_user prompt without requiring swipe-reply.
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

// 💬 Follow up: single-use; re-key the conversation to a force-reply prompt.
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
    await putEphemeral(ctx.db, convoKey(chatId, sent.message_id), convo, CONVO_TTL_SEC, ctx.now());
    await putEphemeral(ctx.db, openAskKey(chatId), { messageId: sent.message_id }, CONVO_TTL_SEC, ctx.now());
  }
}
