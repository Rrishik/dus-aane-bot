// Everything needed to render a transaction card in its current state.
import { getTransaction, getSources } from "../db/transactions.js";
import { getTenant, groupsForMember } from "../db/tenants.js";
import { escapeMarkdown } from "./format.js";
import { getSplitForTransaction, getSettlementForTransaction } from "../db/splits.js";
import { cardText, keyboardFor, canReread } from "./cards.js";

// Cards posted before the move to D1 carry the Gmail message id (or SMS id)
// instead of the transaction id; resolve those through the sources.
async function findTxn(ctx, tid, id) {
  const txn = await getTransaction(ctx.db, tid, id);
  if (txn) return txn;
  const legacy = await ctx.db
    .prepare("SELECT transaction_id FROM transaction_sources WHERE tenant_id = ? AND source_ref = ? LIMIT 1")
    .bind(tid, String(id))
    .first("transaction_id");
  return legacy ? getTransaction(ctx.db, tid, legacy) : null;
}

export async function loadCardState(ctx, tenantId, txnId) {
  const tid = String(tenantId);
  const txn = await findTxn(ctx, tid, txnId);
  if (!txn) return null;
  const [sources, groups, split, settlement, emailCount] = await Promise.all([
    getSources(ctx.db, tid, txn.id),
    groupsForMember(ctx.db, tid),
    getSplitForTransaction(ctx.db, txn.id),
    getSettlementForTransaction(ctx.db, txn.id),
    ctx.db.prepare("SELECT COUNT(*) AS n FROM tenant_emails WHERE tenant_id = ?").bind(tid).first("n")
  ]);
  const isSplit = !!(split || settlement);
  let linkLine = null;
  if (split) {
    const g = groups.find((x) => x.id === split.group_id) || (await getTenant(ctx.db, split.group_id));
    linkLine = "👥 Split with *" + escapeMarkdown((g && g.name) || "group") + "*";
  } else if (settlement) {
    const to = await getTenant(ctx.db, settlement.to_id);
    linkLine = "🤝 Settled with *" + escapeMarkdown((to && to.name) || settlement.to_id) + "*";
  }
  return {
    txn,
    sources,
    groups,
    split,
    settlement,
    isSplit,
    linkLine,
    // 👤 only helps tenants with more than one forwarder.
    user: emailCount > 1 ? txn.forwarder : null,
    canReread: canReread(sources, isSplit)
  };
}

export function renderCard(state, extraLine) {
  return cardText(state.txn, { user: state.user, extraLine: [state.linkLine, extraLine].filter(Boolean).join("\n") });
}

export function defaultKeyboard(state) {
  return keyboardFor(state.txn, state);
}

// Re-render a transaction's DM card after a change made elsewhere (/ask).
export async function refreshCardMessage(ctx, tenantId, txnId) {
  const state = await loadCardState(ctx, tenantId, txnId);
  if (!state || !state.txn.card_message_id) return;
  try {
    await ctx.tg.editMessageText(String(tenantId), state.txn.card_message_id, renderCard(state), {
      reply_markup: defaultKeyboard(state)
    });
  } catch (_) {}
}
