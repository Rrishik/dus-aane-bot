// Point a bot's Telegram webhook at a Worker and register its command menus.
// Idempotent; run on every deploy so a rotated BOT_TOKEN or WEBHOOK_SECRET
// takes effect without a manual step.
//
//   BOT_TOKEN=… WEBHOOK_SECRET=… node worker/scripts/set-webhook.mjs <worker url> [--drop-pending]
import { createTelegram } from "../src/telegram/client.js";

export const ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "my_chat_member", "chat_member"];

// Zero-argument commands only: tapping a menu item sends it immediately.
export const PRIVATE_COMMANDS = [
  { command: "start", description: "Onboard / show welcome" },
  { command: "ask", description: "Ask anything about your spending" },
  { command: "stats", description: "Dashboard: recent, trends" },
  { command: "recent", description: "Latest transactions" },
  { command: "export", description: "Download your data" },
  { command: "account", description: "Account & settings" },
  { command: "help", description: "Show available commands" }
];

export const GROUP_COMMANDS = [
  { command: "start", description: "Set up / re-sync this group" },
  { command: "stats", description: "Who owes whom" },
  { command: "account", description: "This group's setup" },
  { command: "help", description: "Group commands" }
];

export async function setWebhook(tg, url, { secret, dropPending = false }) {
  if (!secret) throw new Error("WEBHOOK_SECRET is required");
  await tg.call("setWebhook", {
    url: new URL(url).origin + "/",
    secret_token: secret,
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: dropPending
  });
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
