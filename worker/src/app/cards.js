// Transaction cards: body text and every keyboard shape, from D1 rows.
// Callback data carries the transaction id (26-char ULID); group callbacks
// use ":" separators, card callbacks "_".
import { CATEGORY_EMOJIS, categoriesFor } from "./constants.js";
import { escapeMarkdown, money, pillLabel, shortCategoryName, formatDayMonth } from "./format.js";

// txn: transactions row. opts: { user, extraLine }.
export function cardText(txn, opts = {}) {
  const amount = money(txn.amount_minor, txn.currency);
  const emoji = txn.direction === "debit" ? "🔴" : "🟢";
  const base = txn.merchant
    ? emoji + " *" + escapeMarkdown(txn.merchant) + "* — " + amount
    : emoji + " *" + amount + " " + (txn.direction === "debit" ? "Debited" : "Credited") + "*";
  const lines = [base + " · _" + escapeMarkdown(formatDayMonth(txn.occurred_on)) + "_"];
  if (opts.user) lines.push("👤 " + escapeMarkdown(opts.user));
  if (txn.status === "review") {
    lines.push("⚠️ *Check this* — " + escapeMarkdown(txn.review_note || "not counted until you save it"));
  }
  if (opts.extraLine) lines.push(opts.extraLine);
  return lines.join("\n");
}

export function pillsRow(txnId, merchant, category) {
  const catText = category ? (CATEGORY_EMOJIS[category] || "📂") + " ▾" : "📂 All ▾";
  return [
    { text: "🏷 " + pillLabel(merchant, "Untagged") + " ▾", callback_data: "tag_" + txnId },
    { text: catText, callback_data: "editcat_" + txnId },
    { text: "⋯", callback_data: "help_" + txnId }
  ];
}

const QUICK_DEBIT_CATEGORIES = [
  "Food & Dining",
  "Groceries",
  "Shopping",
  "Travel",
  "Bills & Utilities",
  "Entertainment"
];
const QUICK_CREDIT_CATEGORIES = ["Transfer In", "Refund", "Reimbursement", "Salary", "Cashback", "Interest/Dividend"];

// Compact 1-row emoji strip shown on arrival when a confirmed transaction has
// no category yet (6 icons on a single horizontal row).
export function quickCategoryRows(txnId, direction) {
  const all = categoriesFor(direction);
  const picks = (direction === "credit" ? QUICK_CREDIT_CATEGORIES : QUICK_DEBIT_CATEGORIES).filter((c) =>
    all.includes(c)
  );
  return [
    picks.slice(0, 6).map((c) => ({
      text: CATEGORY_EMOJIS[c] || shortCategoryName(c),
      callback_data: "cat_" + txnId + "_" + all.indexOf(c)
    }))
  ];
}

// groups: tenants rows of the groups the payer belongs to. quickSplit
// ({ groupId, otherName }) puts the common case — 50-50 in a 2-person
// group — one tap away, with the full menu next to it.
export function level0Keyboard(txn, groups, quickSplit) {
  const rows = [];
  if (!txn.category) rows.push(...quickCategoryRows(txn.id, txn.direction));
  rows.push(
    ...(groups || []).map((g) =>
      quickSplit && quickSplit.groupId === g.id
        ? [
            {
              text: "👥 50-50 with " + pillLabel(quickSplit.otherName, "partner"),
              callback_data: "gsp:" + txn.id + ":" + g.id + ":50"
            },
            { text: "Split ▾", callback_data: "gnav:" + txn.id + ":" + g.id }
          ]
        : [{ text: "👥 Split with " + (g.name || "Group") + " ▾", callback_data: "gnav:" + txn.id + ":" + g.id }]
    )
  );
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

// ⋯ menu. canEdit is false while the transaction is split into a group
// (changing or deleting it would move other people's balances).
export function helpMenuKeyboard(txnId, { canReread = false, canEdit = true } = {}) {
  const rows = [];
  const first = [];
  if (canReread) first.push({ text: "🔄 Re-read", callback_data: "rr_" + txnId });
  if (canEdit) first.push({ text: "✏️ Fix", callback_data: "fix_" + txnId });
  if (first.length) rows.push(first);
  const second = [{ text: "⚠️ Report error", callback_data: "report_" + txnId }];
  if (canEdit) second.push({ text: "🗑️ Delete", callback_data: "del_" + txnId });
  rows.push(second);
  rows.push([{ text: "← Back", callback_data: "back_" + txnId }]);
  return { inline_keyboard: rows };
}

export function fixMenuKeyboard(txn) {
  return {
    inline_keyboard: [
      [
        {
          text: txn.direction === "debit" ? "🟢 It was money in" : "🔴 It was money out",
          callback_data: "flip_" + txn.id
        },
        { text: "💰 Amount", callback_data: "amt_" + txn.id }
      ],
      [{ text: "← Back", callback_data: "help_" + txn.id }]
    ]
  };
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
export function keyboardFor(txn, { sources, groups, isSplit, quickSplit }) {
  if (txn.status === "review") return reviewKeyboard(txn.id, canReread(sources, isSplit));
  if (isSplit) return postSplitKeyboard(txn);
  return level0Keyboard(txn, groups, quickSplit);
}
