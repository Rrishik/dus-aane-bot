// "Waiting for your next message" state (bare /ask, bare /register, 🏷 Tag).
// Expires after 10 minutes so a forgotten prompt can't swallow an unrelated
// later message such as a pasted SMS.
import { putEphemeral, getEphemeral, takeEphemeral, deleteEphemeral } from "../db/ephemeral.js";

export const PENDING_TTL_SEC = 600;
const key = (kind, id) => "pending:" + kind + ":" + id;

export function setPending(ctx, kind, id, value = true) {
  return putEphemeral(ctx.db, key(kind, id), value, PENDING_TTL_SEC, ctx.now());
}

export function getPending(ctx, kind, id) {
  return getEphemeral(ctx.db, key(kind, id), ctx.now());
}

export function takePending(ctx, kind, id) {
  return takeEphemeral(ctx.db, key(kind, id), ctx.now());
}

export function clearPending(ctx, kind, id) {
  return deleteEphemeral(ctx.db, key(kind, id));
}
