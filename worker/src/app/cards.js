// Transaction cards: body text and every keyboard shape, from D1 rows.
// Callback data carries the transaction id (26-char ULID); group callbacks
// use ":" separators, card callbacks "_".
import { CATEGORY_EMOJIS } from "./constants.js";
import { escapeMarkdown, money, pillLabel, shortCategoryName, formatDateTime } from "./format.js";

// txn: transactions row. opts: { user, extraLine }.
export function cardText(txn, opts = {}) {
  const amount = money(txn.amount_minor, txn.currency);
  const emoji = txn.direction === "debit" ? "🔴" : "🟢";
  const header = txn.merchant
    ? emoji + " *" + escapeMarkdown(txn.merchant) + "* — " + amount
    : emoji + " *" + amount + " " + (txn.direction === "debit" ? "Debited" : "Credited") + "*";
  const lines = [header, "🗓 " + escapeMarkdown(formatDateTime(txn.created_at))];
  if (opts.user) lines.push("👤 " + escapeMarkdown(opts.user));
  if (txn.status === "review") {
    lines.push("⚠️ *Check this* — " + escapeMarkdown(txn.review_note || "not counted until you save it"));
  }
  if (opts.extraLine) lines.push(opts.extraLine);
  return lines.join("\n");
}

export function pillsRow(txnId, merchant, category) {
  return [
    { text: "🏷 " + pillLabel(merchant, "Untagged") + " ▾", callback_data: "tag_" + txnId },
    { text: "📂 " + pillLabel(shortCategoryName(category), "Uncategorized") + " ▾", callback_data: "editcat_" + txnId },
    { text: "⋯", callback_data: "help_" + txnId }
  ];
}

// groups: tenants rows of the groups the payer belongs to.
export function level0Keyboard(txn, groups) {
  const rows = (groups || []).map((g) => [
    { text: "👥 Split with " + (g.name || "Group") + " ▾", callback_data: "gnav:" + txn.id + ":" + g.id }
  ]);
  rows.push(pillsRow(txn.id, txn.merchant, txn.category));
  return { inline_keyboard: rows };
}

export function postSplitKeyboard(txn) {
  return {
    inline_keyboard: [
      [{ text: "↩️ Make personal again", callback_data: "gun:" + txn.id }],
      pillsRow(txn.id, txn.merchant, txn.category)
    ]
  };
}

export function reviewKeyboard(txnId, canReread) {
  const row = [{ text: "✅ Save", callback_data: "rvok_" + txnId }];
  if (canReread) row.push({ text: "🔄 Re-read", callback_data: "rr_" + txnId });
  row.push({ text: "✖ Discard", callback_data: "rvno_" + txnId });
  return { inline_keyboard: [row] };
}

export function helpMenuKeyboard(txnId, { canReread = false, canDelete = true } = {}) {
  const first = canReread
    ? { text: "🔄 Re-read", callback_data: "rr_" + txnId }
    : { text: "⚠️ Report error", callback_data: "report_" + txnId };
  const row = [first];
  if (canDelete) row.push({ text: "🗑️ Delete", callback_data: "del_" + txnId });
  return { inline_keyboard: [row, [{ text: "← Back", callback_data: "back_" + txnId }]] };
}

export function deleteConfirmKeyboard(txnId) {
  return {
    inline_keyboard: [
      [
        { text: "✓ Yes, delete", callback_data: "delyes_" + txnId },
        { text: "← Cancel", callback_data: "back_" + txnId }
      ]
    ]
  };
}

export function categoryKeyboard(txnId, categories) {
  const rows = [];
  for (let i = 0; i < categories.length; i += 3) {
    rows.push(
      categories.slice(i, i + 3).map((c, j) => ({
        text: (CATEGORY_EMOJIS[c] ? CATEGORY_EMOJIS[c] + " " : "") + c,
        callback_data: "cat_" + txnId + "_" + (i + j)
      }))
    );
  }
  rows.push([{ text: "← Back", callback_data: "back_" + txnId }]);
  return { inline_keyboard: rows };
}

// A transaction can be re-read once, only when a parser template read it,
// and not while it's split into a group.
export function canReread(sources, isSplit) {
  if (isSplit) return false;
  const first = (sources || [])[0];
  return !!first && !!first.parsed_by && first.parsed_by !== "llm" && !first.reread;
}

// The default keyboard for a card in its current state.
export function keyboardFor(txn, { sources, groups, isSplit }) {
  if (txn.status === "review") return reviewKeyboard(txn.id, canReread(sources, isSplit));
  if (isSplit) return postSplitKeyboard(txn);
  return level0Keyboard(txn, groups);
}
