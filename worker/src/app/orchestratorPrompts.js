// Specialist system prompts, quota-cap copy, and the deterministic fast
// pre-router for personal DM messages.
import { CATEGORIES, CREDIT_CATEGORIES, FREE_ASK_LIMIT } from "./constants.js";
import { shiftIsoDate } from "../util/dates.js";

const NON_SPEND = ["CC Bill Payment", "Transfer Out", "Investment"];

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

export function ledgerSystemPrompt(today) {
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

export function groupSystemPrompt(today) {
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

export function accountSystemPrompt(today, status) {
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

export function triageSystemPrompt(today) {
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
