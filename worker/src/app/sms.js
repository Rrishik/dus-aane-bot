// Pasted bank SMS → transactions. Each SMS gets a content-hash source ref
// (sms-<16 hex>), so pasting the same text twice is a no-op.
import { looksLikeTransactionText, splitSmsPaste, normalizeTransactionText } from "../parser/index.js";
import { sha256Hex } from "./auth.js";
import { ingest } from "./ingest.js";
import { SMS_PASTE_MAX } from "./constants.js";
import { gateText, isUsable, activateWithWelcome } from "./onboarding.js";

export async function smsSourceRef(sms) {
  return "sms-" + (await sha256Hex(normalizeTransactionText(sms).toLowerCase())).slice(0, 16);
}

// Returns false when the text isn't a paste (no amount) so the caller can
// stay silent, true when handled.
export async function handleSmsPaste(ctx, tenant, chatId, text) {
  if (!looksLikeTransactionText(text)) return false;
  if (!tenant || (!isUsable(tenant) && tenant.status !== "pending")) {
    await ctx.tg.sendMessage(chatId, gateText(tenant));
    return true;
  }
  try {
    await ctx.tg.sendChatAction(chatId, "typing");
  } catch (_) {}

  const now = ctx.now();
  const tally = { saved: 0, review: 0, linked: 0, duplicate: 0, ignored: 0, failed: 0 };
  const list = splitSmsPaste(text).slice(0, SMS_PASTE_MAX);
  for (const sms of list) {
    let status = "failed";
    try {
      const res = await ingest(ctx, {
        tenant,
        source: "sms",
        sourceRef: await smsSourceRef(sms),
        text: sms,
        receivedAt: now,
        forwarder: tenant.name || null
      });
      status = res.status;
    } catch (e) {
      console.error("[sms] ingest threw:", e && e.message);
    }
    tally[status]++;
  }

  if (tenant.status === "pending" && tally.saved + tally.review > 0) await activateWithWelcome(ctx, tenant);

  const notes = [];
  if (tally.duplicate) notes.push(tally.duplicate === 1 ? "Already recorded." : tally.duplicate + " already recorded.");
  if (tally.linked) {
    notes.push(
      tally.linked === 1
        ? "Matched to a transaction you already have."
        : tally.linked + " matched transactions you already have."
    );
  }
  if (tally.ignored) {
    notes.push(list.length === 1 ? "No transaction found in that." : tally.ignored + " had no transaction.");
  }
  if (tally.failed) {
    notes.push(
      tally.failed === 1
        ? "Couldn't read that right now — try again in a bit."
        : tally.failed + " couldn't be read right now."
    );
  }
  if (notes.length) await ctx.tg.sendMessage(chatId, "ℹ️ " + notes.join(" "), { parse_mode: null });
  return true;
}
