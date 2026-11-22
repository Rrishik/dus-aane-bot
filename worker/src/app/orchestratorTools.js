// Specialist tool schemas and tenant-scoped tool executor for the DM orchestrator.
import { listEffectiveTransactions } from "../db/analytics.js";
import { listUntaggedTransactions, isUntaggedTransaction } from "../db/transactions.js";
import { getTenant, getTenantEmails, groupsForMember, getGroupMembers } from "../db/tenants.js";
import { getAccountLabels, getCardLabelsMap, upsertAccountLabel, listSeenAccounts } from "../db/accountLabels.js";
import { groupBalances } from "../db/splits.js";
import { refreshCardMessage } from "./cardState.js";
import { mutateTransaction, batchMutateTransactions, removeTransaction } from "./ledger.js";
import { normalizeMerchantName } from "./merchants.js";
import { ensurePersonalPin } from "./personalPin.js";
import { splitTransaction, undoGroupLink, simplifyDebts, recordCashSettlement, memberName } from "./groups.js";
import { monthlyTrends, weeklyTrends } from "./analytics.js";
import { registerEmailForChat, sendSetupEmail } from "./commands.js";
import { handleBackfill } from "./backfill.js";
import { handleExport, handleDeleteMyData } from "./data.js";
import { handleSmsPaste } from "./sms.js";
import { extractIstTimeInfo } from "./tagSuggester.js";
import { fromMinor, toMinor } from "../util/money.js";

const DATE_PARAMS = {
  start_date: { type: "string", description: "Start date in YYYY-MM-DD format" },
  end_date: { type: "string", description: "End date in YYYY-MM-DD format" }
};

const fn = (name, description, properties = {}, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } }
});

const ASK_USER_TOOL = fn(
  "ask_user",
  "Ask the user a short clarifying question and wait for a free-text reply. Use when a required parameter is genuinely missing and cannot be inferred from context, when multiple transactions match before mutating/splitting, OR when listing untagged/unknown transactions for the user to name/tag. Never use for confirmations on read-only queries.",
  {
    question: {
      type: "string",
      description: "Concise plain text (up to ~600 chars when listing numbered items). No markdown."
    }
  },
  ["question"]
);

const CARD_PARAM = {
  card: {
    type: "string",
    description: "Optional card/account filter: last 3-4 digits (e.g. '5678') or saved card label (e.g. 'Infinia')."
  }
};

const LIST_CARDS_TOOL = fn(
  "list_cards",
  "List saved card/account labels and all card/account last-4 digits seen in the user's transactions."
);

const SEARCH_TOOL = fn(
  "search_transactions",
  "Search transactions by date, merchant, category, card/account, untagged/unnamed status, forwarder, or amount range.",
  {
    ...DATE_PARAMS,
    ...CARD_PARAM,
    merchant: { type: "string", description: "Merchant name (case-insensitive partial match)" },
    category: { type: "string", description: "Exact category filter" },
    untagged_only: {
      type: "boolean",
      description: "When true, return only uncategorized rows."
    },
    unnamed_only: {
      type: "boolean",
      description: "When true, return only rows missing a merchant name (Unknown / unnamed)."
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
  "List confirmed transactions missing a category, and optionally also categorized transactions missing a merchant name (Unknown / unnamed).",
  {
    ...DATE_PARAMS,
    include_unnamed: {
      type: "boolean",
      description:
        "When true, also include categorized transactions whose merchant name is missing/Unknown. Set true when the user asks to tag, name, or review unknown/unnamed transactions."
    },
    spend_only: {
      type: "boolean",
      description:
        "When true, restrict results to spend transactions (excludes Transfer and Invest). Useful when naming unknown spend transactions."
    },
    limit: { type: "number", description: "Max rows to return. Default 15." }
  }
);

export const ANALYTICS_TOOLS = [
  fn(
    "get_spending_summary",
    "Get total spending and income summary for a date range (optionally filtered to a specific card). spend_by_currency excludes Transfer and Invest debits (reported separately as non_spend_debits_by_currency).",
    { ...DATE_PARAMS, ...CARD_PARAM },
    ["start_date", "end_date"]
  ),
  fn(
    "get_category_breakdown",
    "Get spending breakdown by category for a date range (optionally filtered to a specific card), including untagged count.",
    { ...DATE_PARAMS, ...CARD_PARAM },
    ["start_date", "end_date"]
  ),
  fn(
    "get_top_merchants",
    "Get top merchants by spending amount for a date range (optionally filtered to a specific card).",
    {
      ...DATE_PARAMS,
      ...CARD_PARAM,
      limit: { type: "number", description: "Number of merchants to return. Default 5." }
    },
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
  LIST_CARDS_TOOL,
  ASK_USER_TOOL
];

export const LEDGER_TOOLS = [
  LIST_UNTAGGED_TOOL,
  SEARCH_TOOL,
  fn(
    "update_transaction",
    "Update a single transaction's category, merchant tag, amount (only when personal/unsplit), or transaction type. Identify via transaction_id from search_transactions or list_untagged_transactions.",
    {
      transaction_id: { type: "string", description: "The transaction_id." },
      category: { type: "string", description: "Valid debit or credit category." },
      merchant: { type: "string", description: "Short merchant / tag name (1–18 chars)." },
      amount: { type: "number", description: "Corrected positive transaction amount." },
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
            amount: { type: "number" },
            transaction_type: { type: "string" }
          },
          required: ["transaction_id"]
        }
      }
    },
    ["items"]
  ),
  fn(
    "delete_transaction",
    "Delete (soft-delete) a personal transaction and remove its DM card message. Refuses if split into a group (undo_split first). Always confirm transaction_id via search_transactions or list_untagged_transactions first.",
    {
      transaction_id: { type: "string", description: "The transaction_id to delete." }
    },
    ["transaction_id"]
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
  LIST_CARDS_TOOL,
  fn(
    "set_card_label",
    "Save a friendly name for a card or bank account's last 3-4 digits (e.g. last4='5678', label='Infinia') and upgrade past CC Bill rows for that card.",
    {
      last4: { type: "string", description: "Last 3 or 4 digits of the card/account, e.g. '5678'." },
      label: { type: "string", description: "Friendly name, e.g. 'Infinia' or 'Amazon ICICI'." },
      kind: { type: "string", description: "'card' (default) or 'account'." }
    },
    ["last4", "label"]
  ),
  ASK_USER_TOOL
];

// ─── Tool implementations (strictly tenant-scoped) ───────────────────

const label = (r) => r.merchant || normalizeMerchantName(r.merchant_raw) || "Unknown";
const isUnnamedMerchant = (r) => label(r) === "Unknown";
const UNKNOWN_QUERY_WORDS = new Set(["unknown", "unnamed", "no merchant", "unidentified"]);

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
  const rowsFor = async (args = {}) => {
    const key = (args.start_date || "") + "|" + (args.end_date || "");
    cache[key] = cache[key] || listEffectiveTransactions(ctx.db, tid, { from: args.start_date, to: args.end_date });
    const allRows = await cache[key];
    if (!args.card) return allRows;
    const query = String(args.card)
      .trim()
      .toLowerCase()
      .replace(/^[*x#]+/, "");
    if (!query) return allRows;
    const saved = await getAccountLabels(ctx.db, tid);
    const matchingDigits = new Set(
      saved.filter((s) => s.label.toLowerCase().includes(query) || s.last4 === query).map((s) => s.last4)
    );
    if (/^\d{3,4}$/.test(query)) matchingDigits.add(query);
    return allRows.filter((r) => r.account_last4 && matchingDigits.has(String(r.account_last4)));
  };
  const invalidateCache = () => {
    for (const k of Object.keys(cache)) delete cache[k];
  };

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
      return {
        untagged_count: allRows.filter(isUntaggedTransaction).length,
        categories: aggregate(debits, (r) => r.category || "Uncategorized").map(({ rows, ...c }) => ({
          ...c,
          counts_as_spend: rows.every((r) => r.kind === "spend")
        }))
      };
    },

    async get_top_merchants(args) {
      const spend = (await rowsFor(args)).filter((r) => r.kind === "spend");
      const named = spend.filter((r) => !isUnnamedMerchant(r));
      const unnamed = spend.filter(isUnnamedMerchant);
      const out = {
        merchants: aggregate(named, label)
          .slice(0, args.limit || 5)
          .map(({ rows, ...m }) => m)
      };
      if (unnamed.length > 0) {
        out.unnamed_spend = {
          count: unnamed.length,
          by_currency: sumByCurrency(unnamed)
        };
      }
      return out;
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
      const merchantQuery = args.merchant ? String(args.merchant).trim().toLowerCase() : "";
      if (args.unnamed_only || UNKNOWN_QUERY_WORDS.has(merchantQuery)) {
        rows = rows.filter(isUnnamedMerchant);
      } else if (merchantQuery) {
        rows = rows.filter(
          (r) =>
            (r.merchant || "").toLowerCase().includes(merchantQuery) ||
            (r.merchant_raw || "").toLowerCase().includes(merchantQuery)
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
      const cardLabelsMap = await getCardLabelsMap(ctx.db, tid);
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
          if (r.account_last4) {
            out.account_last4 = r.account_last4;
            if (cardLabelsMap[r.account_last4]) out.card_label = cardLabelsMap[r.account_last4];
          }
          if (isUnnamedMerchant(r)) out.unnamed = true;
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
      const [rows, cardLabelsMap] = await Promise.all([
        listUntaggedTransactions(ctx.db, tid, {
          from: args.start_date,
          to: args.end_date,
          includeUnnamed: Boolean(args.include_unnamed),
          spendOnly: Boolean(args.spend_only),
          limit: Math.min(25, Math.max(1, args.limit || 15))
        }),
        getCardLabelsMap(ctx.db, tid)
      ]);
      return {
        count: rows.length,
        transactions: rows.map((r) => {
          const m = String(r.merchant || "").trim();
          const c = String(r.category || "").trim();
          const missingMerchant = !m || m.toLowerCase() === "unknown";
          const missingCategory = !c || c.toLowerCase() === "uncategorized";
          const timeInfo = extractIstTimeInfo(r);
          const item = {
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
          if (timeInfo.display12h) item.time_ist = timeInfo.display12h;
          if (r.account_last4) {
            item.account_last4 = r.account_last4;
            if (cardLabelsMap[r.account_last4]) item.card_label = cardLabelsMap[r.account_last4];
          }
          return item;
        })
      };
    },

    async update_transaction(args) {
      const res = await mutateTransaction(ctx, tid, args.transaction_id, {
        merchant: args.merchant,
        category: args.category,
        amount: args.amount,
        transactionType: args.transaction_type
      });
      if (!res.ok) return res;
      invalidateCache();
      return { ok: true, transaction_id: res.transaction_id, changes: res.changes };
    },

    async batch_update_transactions(args) {
      const res = await batchMutateTransactions(ctx, tid, args.items);
      if (res.updated > 0) invalidateCache();
      return res;
    },

    async delete_transaction(args) {
      const res = await removeTransaction(ctx, tid, args.transaction_id);
      if (!res.ok) return res;
      invalidateCache();
      return { ok: true, transaction_id: res.transaction_id, card_deleted: res.cardRemoved };
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
      return recordCashSettlement(ctx, {
        group,
        fromId: tid,
        toId: target,
        amountMinor: toMinor(amount),
        currency: args.currency || group.primary_currency || "INR"
      });
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
      await handleBackfill(ctx, tid, args.range);
      runMeta.suppressFinalText = true;
      return { ok: true, already_sent_to_chat: true };
    },

    async export_transactions(args) {
      await handleExport(ctx, tid, args.range);
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
    },

    async list_cards() {
      const accounts = await listSeenAccounts(ctx.db, tid);
      return { ok: true, cards_and_accounts: accounts };
    },

    async set_card_label(args) {
      return upsertAccountLabel(ctx.db, tid, args.last4, args.label, args.kind || "card", ctx.now());
    }
  };

  return async (name, args) => (tools[name] ? tools[name](args || {}) : { error: "Unknown tool: " + name });
}
