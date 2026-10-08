// Onboarding pieces shared by ingest and the command handlers.
import {
  findTenantByEmail,
  findPendingTenantByEmail,
  activateTenant,
  getTenant,
  takeGroupInvites,
  getGroupMembers,
  addGroupMember
} from "../db/tenants.js";
import { BOT_INBOX_EMAIL, MAX_GROUP_MEMBERS } from "./constants.js";
import { escapeMarkdown } from "./format.js";

export function isUsable(tenant) {
  return !!tenant && (tenant.status === "active" || tenant.status === "dormant");
}

// What an unregistered / not-yet-active chat is told when it tries to use the bot.
export function gateText(tenant) {
  return tenant && tenant.status === "pending"
    ? "⏳ Your setup isn't active yet. Forward any bank email to `" +
        BOT_INBOX_EMAIL +
        "` (or paste a bank SMS here) to activate, or run `/account` to resend setup instructions."
    : "👋 I don't know this chat yet. Send `/start` to onboard.";
}

// Pending → active on the first real transaction (forwarded email or pasted
// SMS). There's no sheet to provision any more, so activation is instant.
export async function activateWithWelcome(ctx, tenant) {
  if (!(await activateTenant(ctx.db, tenant.id))) return getTenant(ctx.db, tenant.id);
  try {
    await ctx.tg.sendMessage(
      tenant.id,
      "🎉 *Your first transaction is in!*\n\nEvery bank email you forward (or SMS you paste) becomes a card here. Send /export any time for a copy of your data."
    );
  } catch (e) {
    console.error("[activate] welcome DM failed:", e && e.message);
  }
  await consumeGroupInvites(ctx, tenant);
  return getTenant(ctx.db, tenant.id);
}

// Add a newly active user to every group they joined before registering.
export async function consumeGroupInvites(ctx, tenant) {
  const groupIds = await takeGroupInvites(ctx.db, tenant.id);
  const name = escapeMarkdown(tenant.name || String(tenant.id));
  for (const gid of groupIds) {
    const group = await getTenant(ctx.db, gid);
    if (!group || group.kind !== "group" || group.status !== "active") continue;
    const members = await getGroupMembers(ctx.db, gid);
    try {
      if (members.length >= MAX_GROUP_MEMBERS) {
        if (group.admin_id) {
          await ctx.tg.sendMessage(
            group.admin_id,
            "⚠️ *" +
              name +
              "* finished registering, but *" +
              escapeMarkdown(group.name || "your group") +
              "* is already at the " +
              MAX_GROUP_MEMBERS +
              "-member cap. Remove someone and ask them to /start in the group again."
          );
        }
        continue;
      }
      if (await addGroupMember(ctx.db, gid, tenant.id, ctx.now())) {
        await ctx.tg.sendMessage(gid, "✅ *" + name + "* joined the splits.");
      }
    } catch (e) {
      console.error("[invites] group " + gid + ":", e && e.message);
    }
  }
}

// Route a forwarded email to its tenant, activating a pending one.
export async function tenantForForward(ctx, email) {
  const active = await findTenantByEmail(ctx.db, email);
  if (active) return active;
  const pending = await findPendingTenantByEmail(ctx.db, email);
  return pending ? activateWithWelcome(ctx, pending) : null;
}
