// Everything needed to render a transaction card in its current state.
import { getTransaction, getSources } from "../db/transactions.js";
import { groupsForMember } from "../db/tenants.js";
import { getSplitForTransaction, getSettlementForTransaction } from "../db/splits.js";
import { cardText, keyboardFor, canReread } from "./cards.js";

export async function loadCardState(ctx, tenantId, txnId) {
  const tid = String(tenantId);
  const txn = await getTransaction(ctx.db, tid, txnId);
  if (!txn) return null;
  const [sources, groups, split, settlement, emailCount] = await Promise.all([
    getSources(ctx.db, tid, txnId),
    groupsForMember(ctx.db, tid),
    getSplitForTransaction(ctx.db, txnId),
    getSettlementForTransaction(ctx.db, txnId),
    ctx.db.prepare("SELECT COUNT(*) AS n FROM tenant_emails WHERE tenant_id = ?").bind(tid).first("n")
  ]);
  const isSplit = !!(split || settlement);
  return {
    txn,
    sources,
    groups,
    split,
    settlement,
    isSplit,
    // 👤 only helps tenants with more than one forwarder.
    user: emailCount > 1 ? txn.forwarder : null,
    canReread: canReread(sources, isSplit)
  };
}

export function renderCard(state, extraLine) {
  return cardText(state.txn, { user: state.user, extraLine });
}

export function defaultKeyboard(state) {
  return keyboardFor(state.txn, state);
}
