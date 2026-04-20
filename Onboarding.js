// Onboarding commands: /start, /email, /myinfo.
// Plus auto-activation: when a pending tenant forwards their first valid bank
// email, we provision their sheet and flip them to active.
//
// Uses Telegram "Markdown" (legacy) parse mode to avoid MarkdownV2 escaping
// pitfalls with `.` and `-` in email addresses.

/**
 * /start — welcome message, differs for new vs onboarded chats.
 */
function handleStartCommand(chatId, username) {
  var tenant = findTenantByChatId(chatId);
  if (tenant && tenant.status === TENANT_STATUS.ACTIVE) {
    handleHelpCommand(chatId, username);
    return;
  }

  var greeting = username ? "👋 Hey " + username + "! " : "";
  var msg =
    greeting +
    "Welcome to Dus Aane Bot.\n\n" +
    "I track your bank transactions automatically by reading forwarded emails.\n\n" +
    "*🔒 Your privacy:* I only read emails from verified bank transaction-alert addresses " +
    "(e.g. `alerts@axis.bank.in`, `alerts@hdfcbank.net`). I *never* see OTPs, statements, " +
    "security codes, or login alerts — the Gmail filter excludes them.\n\n" +
    "*Setup (3 steps):*\n" +
    "1. Register your Gmail with `/email your.name@gmail.com`\n" +
    "2. Run `/filter` — I'll DM you a ready-to-paste Gmail filter query\n" +
    "3. Create a Gmail filter with that query → forward matches to `" +
    BOT_INBOX_EMAIL +
    "`\n\n" +
    "Your first forwarded bank email will finish the setup and create your personal sheet.";
  sendTelegramMessage(chatId, msg, { parse_mode: "Markdown" });
}

/**
 * /email <addr> — register a forwarder email for this chat.
 */
function handleEmailCommand(chatId, username, messageText) {
  var parts = messageText.split(/\s+/);
  if (parts.length < 2) {
    sendTelegramMessage(
      chatId,
      "Usage: `/email your.name@gmail.com`\n\nSend me the Gmail address you'll forward bank emails from.",
      { parse_mode: "Markdown" }
    );
    return;
  }
  var email = parts[1].trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    sendTelegramMessage(chatId, "❌ That doesn't look like a valid email. Try: `/email your.name@gmail.com`", {
      parse_mode: "Markdown"
    });
    return;
  }

  // Prevent stealing another active tenant's email.
  var existingActive = findTenantByEmail(email);
  if (existingActive && String(existingActive.chat_id) !== String(chatId)) {
    sendTelegramMessage(chatId, "❌ That email is already registered to another account.");
    return;
  }

  upsertPendingTenant(chatId, email, username || "");

  var tenant = findTenantByChatId(chatId);
  var alreadyActive = tenant && tenant.status === TENANT_STATUS.ACTIVE;
  var msg;
  if (alreadyActive) {
    msg =
      "✅ Added `" +
      email +
      "` to your forwarder list.\n\nRegistered emails:\n" +
      tenant.emails.map((e) => "• `" + e + "`").join("\n");
  } else {
    msg =
      "✅ Got it — `" +
      email +
      "` is registered (pending).\n\n" +
      "*Next:* send `/filter` to get the Gmail filter query. Paste it into a new Gmail filter " +
      "in that account and forward matches to `" +
      BOT_INBOX_EMAIL +
      "`.\n\n" +
      "When your first forwarded bank email arrives, I'll create your sheet and finish setup.";
  }
  sendTelegramMessage(chatId, msg, { parse_mode: "Markdown" });
}

/**
 * /filter — DM the narrow Gmail search query so users can copy-paste it into
 * a Gmail filter. Also reassures privacy (only transaction alerts forwarded).
 */
function handleFilterCommand(chatId) {
  var query = "from:(" + TRANSACTION_SENDERS.join(" OR ") + ")";

  var intro =
    "📋 *Your Gmail filter setup*\n\n" +
    "*🔒 What this forwards:* only verified bank transaction alerts " +
    "(debits, credits, card spends). OTPs, statements, security codes, " +
    "promotional emails, and login alerts are *excluded* by construction — " +
    "the query lists specific sender addresses, nothing else.\n\n" +
    "*Steps:*\n" +
    "1. Gmail → ⚙️ → See all settings → *Filters and Blocked Addresses*\n" +
    "2. *Create a new filter*\n" +
    "3. Paste the query below into *Has the words*\n" +
    "4. Click *Create filter* → check *Forward it to* `" +
    BOT_INBOX_EMAIL +
    "` (add and verify this address first if needed)\n" +
    "5. Also check *Apply filter to matching conversations* to backfill existing mail\n\n" +
    "👇 *Copy the query below:*";
  sendTelegramMessage(chatId, intro, { parse_mode: "Markdown" });

  // Send the query in its own message as a code block for easy copy.
  sendTelegramMessage(chatId, "```\n" + query + "\n```", { parse_mode: "Markdown" });
}

/**
 * /myinfo — show this chat's tenant status.
 */
function handleMyInfoCommand(chatId) {
  var tenant = findTenantByChatId(chatId);
  if (!tenant) {
    sendTelegramMessage(chatId, "No account found for this chat. Use `/start` to onboard.", {
      parse_mode: "Markdown"
    });
    return;
  }
  var lines = [];
  lines.push("*Your account*");
  lines.push("Status: `" + tenant.status + "`");
  if (tenant.name) lines.push("Name: " + tenant.name);
  lines.push("Chat ID: `" + tenant.chat_id + "`");
  lines.push("Emails: " + (tenant.emails.length > 0 ? tenant.emails.map((e) => "`" + e + "`").join(", ") : "_none_"));
  if (tenant.sheet_id) {
    lines.push("Sheet: [open](https://docs.google.com/spreadsheets/d/" + tenant.sheet_id + ")");
  } else {
    lines.push("Sheet: _not provisioned yet_");
  }
  sendTelegramMessage(chatId, lines.join("\n"), { parse_mode: "Markdown" });
}

/**
 * Called when extractTransactions sees a forward from an email that matches a
 * pending tenant. Provisions a sheet, activates the tenant, and DMs them a
 * welcome message. Returns the activated tenant or null on failure.
 */
function activatePendingTenantForEmail(email) {
  var pending = findPendingTenantByEmail(email);
  if (!pending) return null;

  var sheetId;
  try {
    var label = pending.name || pending.chat_id;
    sheetId = adminProvisionTenantSheet(label);
  } catch (e) {
    console.error("[activatePendingTenantForEmail] provision failed:", e.message);
    try {
      sendTelegramMessage(
        pending.chat_id,
        "⚠️ I couldn't create your sheet. Please contact the admin. (" + e.message + ")"
      );
    } catch (_) {}
    return null;
  }

  var ok = activateTenant(pending.chat_id, sheetId);
  if (!ok) return null;

  var activated = findTenantByChatId(pending.chat_id);
  var sheetUrl = "https://docs.google.com/spreadsheets/d/" + sheetId;
  try {
    sendTelegramMessage(
      pending.chat_id,
      "🎉 *You're all set!* Your personal sheet is ready and I'm now tracking your forwards.",
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "📋 Open Sheet", url: sheetUrl }]] }
      }
    );
  } catch (e) {
    console.error("[activatePendingTenantForEmail] welcome DM failed:", e.message);
  }
  return activated;
}

/**
 * Gate non-onboarding commands on an active tenant for this chat.
 * Returns true if the command should be allowed, false if already rejected.
 */
function gateTenantForCommand(chatId) {
  var tenant = findTenantByChatId(chatId);
  if (tenant && tenant.status === TENANT_STATUS.ACTIVE) return true;
  sendTelegramMessage(
    chatId,
    tenant && tenant.status === TENANT_STATUS.PENDING
      ? "⏳ Your setup is still pending. Forward a bank email from your registered address to finish setup."
      : "👋 I don't know this chat yet. Send `/start` to onboard.",
    { parse_mode: "Markdown" }
  );
  return false;
}
