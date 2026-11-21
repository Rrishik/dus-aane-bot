// Point a bot's Telegram webhook at a Worker and register its command menus.
// Idempotent; run on every deploy so a rotated BOT_TOKEN or WEBHOOK_SECRET
// takes effect without a manual step.
//
//   BOT_TOKEN=… WEBHOOK_SECRET=… node worker/scripts/set-webhook.mjs <worker url> [--drop-pending]
import { createTelegram } from "../src/telegram/client.js";

export const ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "my_chat_member", "chat_member"];

// Minimalist personal menu: everything else is plain-English chat.
export const PRIVATE_COMMANDS = [
  { command: "start", description: "Welcome & live summary" },
  { command: "cancel", description: "Cancel current prompt" }
];

export const GROUP_COMMANDS = [
  { command: "stats", description: "Who owes whom & simplify debts" },
  { command: "settle", description: "Record a cash payment (@member <amount>)" },
  { command: "start", description: "Set up / re-sync group members" }
];

export async function setWebhook(tg, url, { secret, dropPending = false }) {
  if (!secret) throw new Error("WEBHOOK_SECRET is required");
  await tg.setWebhook(new URL(url).origin + "/", {
    secretToken: secret,
    allowedUpdates: ALLOWED_UPDATES,
    dropPending
  });
  await tg.call("deleteMyCommands", { scope: { type: "default" } });
  await tg.call("deleteMyCommands", { scope: { type: "all_chat_administrators" } });
  await tg.call("setMyCommands", { scope: { type: "all_private_chats" }, commands: PRIVATE_COMMANDS });
  await tg.call("setMyCommands", { scope: { type: "all_group_chats" }, commands: GROUP_COMMANDS });
  const me = await tg.call("getMe");
  const info = await tg.call("getWebhookInfo");
  return { username: me.username, pending: info.pending_update_count || 0, lastError: info.last_error_message || null };
}

async function main() {
  const url = process.argv[2];
  if (!url || !process.env.BOT_TOKEN) {
    console.error("usage: BOT_TOKEN=… WEBHOOK_SECRET=… node worker/scripts/set-webhook.mjs <worker url>");
    process.exit(2);
  }
  const tg = createTelegram({ token: process.env.BOT_TOKEN });
  const out = await setWebhook(tg, url, {
    secret: process.env.WEBHOOK_SECRET,
    dropPending: process.argv.includes("--drop-pending")
  });
  console.log(
    "@" + out.username + " → webhook set; pending " + out.pending + ", last error: " + (out.lastError || "none")
  );
}

if (process.argv[1] && process.argv[1].endsWith("set-webhook.mjs")) {
  main().catch((e) => {
    console.error("set-webhook failed:", e.message);
    process.exit(1);
  });
}
