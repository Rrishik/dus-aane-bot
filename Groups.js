// Group-chat lifecycle handlers.
//
// Scope (step 2b.2): bot added/removed from groups, and /start in a group
// (provisioning). Member-change events (chat_member) and personal-tenant
// retro-add land in 2b.3; group-context command dispatch (/help, /account,
// /recent, ...) lands in 2b.4.
//
// Design constraints (locked in /memories/session/groups-feature-design.md):
//  - Bot MUST be a group admin to manage members reliably (chat_member events
//    are gated on admin in privacy mode). We enforce this at /start time.
//  - Group display name is taken from chat.title and frozen at provisioning.
//  - Members must have an active personal tenant to participate. Unregistered
//    admins get a DM nudge to /register; regular non-admin members are not
//    enumerable via API and join later via chat_member events (2b.3).
//  - Hard cap of MAX_GROUP_MEMBERS (4). Enforced on the visible admin list at
//    /start; further enforcement on join lives in 2b.3.

// Pure helper: classify the admin list returned by getChatAdministrators.
// Inputs:
//   admins       — array of Telegram ChatMember objects (each has .user)
//   botUserId    — string id of the bot's own user (we exclude self + any bots)
//   findActive   — function(chatId) -> personal-tenant object or null
// Output: { registered: [{chat_id, name}], unregistered: [{chat_id, name}], botPresent }
//
// botPresent reflects whether the bot itself appears in the admin list (i.e.
// whether the bot is a group admin). Caller decides what to do about it.
function classifyGroupAdmins(admins, botUserId, findActive) {
  var out = { registered: [], unregistered: [], botPresent: false };
  if (!admins || !admins.length) return out;
  var botKey = String(botUserId || "");
  for (var i = 0; i < admins.length; i++) {
    var m = admins[i];
    if (!m || !m.user) continue;
    var uid = String(m.user.id);
    if (botKey && uid === botKey) {
      out.botPresent = true;
      continue;
    }
    if (m.user.is_bot) continue; // skip other bots
    var name = m.user.first_name || m.user.username || uid;
    var tenant = findActive(uid);
    if (tenant) out.registered.push({ chat_id: uid, name: name });
    else out.unregistered.push({ chat_id: uid, name: name });
  }
  return out;
}

// Format the /start success/status message posted into the group.
// Pure formatter — no I/O. Tested directly.
function formatGroupSetupMessage(groupName, registered, unregistered, sheetUrl) {
  var lines = [];
  lines.push("✅ *" + escapeMarkdown(groupName || "Group") + "* is set up!");
  var total = registered.length + unregistered.length;
  lines.push(registered.length + " of " + total + " admin" + (total === 1 ? "" : "s") + " ready to split.");
  if (registered.length) {
    lines.push("");
    lines.push("*Ready:* " + registered.map((m) => escapeMarkdown(m.name)).join(", "));
  }
  if (unregistered.length) {
    lines.push("");
    lines.push(
      "*Need to register:* " +
        unregistered.map((m) => escapeMarkdown(m.name)).join(", ") +
        " — DM me `/register` first."
    );
  }
  if (sheetUrl) {
    lines.push("");
    lines.push("[Open group sheet](" + sheetUrl + ")");
  }
  return lines.join("\n");
}

// /start handler when chat.type is group/supergroup. Idempotent: re-running
// on an already-provisioned group re-syncs the visible admin list rather
// than creating a duplicate tenant.
function handleGroupStartCommand(update) {
  var chat = update.message.chat;
  var groupChatId = chat.id;
  var groupName = chat.title || "Group";
  var inviterChatId = update.message.from && update.message.from.id;

  // 1) Bot-admin enforcement. getChatAdministrators works without admin
  // privileges, but we want the bot ITSELF in the admin list so chat_member
  // events fire reliably (Telegram strips them for non-admin bots in privacy
  // mode). If the bot isn't admin, refuse — re-running /start after promotion
  // will go through.
  var botUserId = getTelegramBotUserId();
  if (!botUserId) {
    sendTelegramMessage(
      groupChatId,
      "⚠️ I couldn't verify my own identity right now. Try `/start` again in a moment.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  var admins = getTelegramChatAdministrators(groupChatId);
  if (!admins) {
    sendTelegramMessage(
      groupChatId,
      "⚠️ I couldn't read this group's admin list. Make sure I have access and try `/start` again.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  var classified = classifyGroupAdmins(admins, botUserId, function (uid) {
    var t = findTenantByChatId(uid);
    return t && t.status === TENANT_STATUS.ACTIVE && t.chat_type === TENANT_CHAT_TYPE.PERSONAL ? t : null;
  });

  if (!classified.botPresent) {
    sendTelegramMessage(
      groupChatId,
      "🔒 *Make me an admin first.*\n\n" +
        "I need admin rights so I can detect members joining and leaving. " +
        "Open the group settings, promote me to admin, then send `/start` again.\n\n" +
        "_Default admin permissions are fine — I don't need to delete messages or ban users._",
      { parse_mode: "Markdown" }
    );
    return;
  }

  var visibleCount = classified.registered.length + classified.unregistered.length;
  if (visibleCount > MAX_GROUP_MEMBERS) {
    sendTelegramMessage(
      groupChatId,
      "🚧 *Too many admins.*\n\n" +
        "Dus Aane Bot supports up to " +
        MAX_GROUP_MEMBERS +
        " members per group. Demote some admins (or remove them from the group) and try `/start` again.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // 2) Idempotency: if the group already has a tenant, just re-sync members.
  var existing = findGroupTenantByChatId(groupChatId);
  if (existing) {
    var nextMembers = classified.registered.map((m) => m.chat_id);
    setGroupMembers(groupChatId, nextMembers);
    var sheetUrlExisting = existing.sheet_id ? sheetUrl(existing.sheet_id) : "";
    sendTelegramMessage(
      groupChatId,
      "🔄 Already set up — re-synced member list.\n\n" +
        formatGroupSetupMessage(
          existing.name || groupName,
          classified.registered,
          classified.unregistered,
          sheetUrlExisting
        ),
      { parse_mode: "Markdown", disable_web_page_preview: true }
    );
    nudgeUnregisteredAdmins(classified.unregistered, groupName);
    return;
  }

  // 3) Provision a new group sheet. Share with registered members' emails so
  // they can open the spreadsheet directly. Unregistered members get added
  // later when they /register (2b.3).
  var registeredEmails = [];
  classified.registered.forEach(function (m) {
    var t = findTenantByChatId(m.chat_id);
    if (t && t.emails && t.emails.length) registeredEmails = registeredEmails.concat(t.emails);
  });

  var sheetId;
  try {
    sheetId = adminProvisionGroupSheet(groupName, registeredEmails);
  } catch (e) {
    console.error("[handleGroupStartCommand] provision failed: " + e.message);
    sendTelegramMessage(
      groupChatId,
      "⚠️ I couldn't provision a group sheet right now. The bot operator has been notified — try `/start` again later.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // 4) Insert the tenant row. Members CSV holds only the registered admins;
  // unregistered ones are added via 2b.3 retro-add when they /register.
  var memberIds = classified.registered.map((m) => m.chat_id);
  insertGroupTenant(groupChatId, groupName, sheetId, memberIds, inviterChatId);

  // 5) Confirm in the group + DM unregistered admins.
  sendTelegramMessage(
    groupChatId,
    formatGroupSetupMessage(groupName, classified.registered, classified.unregistered, sheetUrl(sheetId)),
    { parse_mode: "Markdown", disable_web_page_preview: true }
  );
  nudgeUnregisteredAdmins(classified.unregistered, groupName);
}

// DM each unregistered admin with a one-shot /register prompt. Best-effort:
// if the user hasn't started a DM with the bot, sendMessage fails silently
// (no reliable way to detect this without an extra API call). The fallback
// is the in-group "Need to register: ..." line.
function nudgeUnregisteredAdmins(unregistered, groupName) {
  if (!unregistered || !unregistered.length) return;
  for (var i = 0; i < unregistered.length; i++) {
    var u = unregistered[i];
    try {
      sendTelegramMessage(
        u.chat_id,
        "👋 You've been added to *" +
          escapeMarkdown(groupName) +
          "* on Dus Aane Bot.\n\n" +
          "To start splitting expenses, send me `/register your.email@gmail.com` here in DM.",
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      console.error("[nudgeUnregisteredAdmins] DM " + u.chat_id + " failed: " + e.message);
    }
  }
}

// my_chat_member dispatch: bot's own membership in some chat changed.
// Telegram fires this whenever the bot is added/removed/promoted. We only
// care about group additions (welcome message) and removals (mark group
// tenant disabled — history stays).
function handleBotMembershipChange(update) {
  var ev = update.my_chat_member;
  if (!ev || !ev.chat) return;
  var chatType = ev.chat.type;
  if (chatType !== "group" && chatType !== "supergroup") return;

  var oldStatus = ev.old_chat_member && ev.old_chat_member.status;
  var newStatus = ev.new_chat_member && ev.new_chat_member.status;
  var wasOut = oldStatus === "left" || oldStatus === "kicked" || !oldStatus;
  var isIn = newStatus === "member" || newStatus === "administrator";

  if (wasOut && isIn) {
    // Welcome: prompt the inviter to make us admin + run /start.
    var groupName = ev.chat.title || "this group";
    sendTelegramMessage(
      ev.chat.id,
      "👋 Hey! I'm *Dus Aane Bot* — track shared expenses by forwarding bank emails.\n\n" +
        "To set up *" +
        escapeMarkdown(groupName) +
        "* as a shared expense group:\n" +
        "1. Promote me to admin (default permissions are fine).\n" +
        "2. Send `/start` here.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (!isIn && !wasOut) {
    // Bot was removed (or kicked). Mark the group tenant disabled so it
    // stops receiving writes. History rows remain for audit / reactivation.
    var t = findGroupTenantByChatId(ev.chat.id);
    if (t) {
      var rowNum = _findRowIndexByChatId(ev.chat.id);
      if (rowNum !== -1) {
        var tab = _getOrCreateTenantsTab();
        tab.getRange(rowNum, TENANT_COLS.STATUS).setValue(TENANT_STATUS.DISABLED);
        invalidateTenantCache();
      }
      // Best-effort DM the admin so they know.
      var adminId = getGroupAdminChatId(t);
      if (adminId) {
        try {
          sendTelegramMessage(
            adminId,
            "ℹ️ I was removed from *" +
              escapeMarkdown(t.name || "your group") +
              "*. The group sheet is preserved — re-add me and run `/start` to reactivate.",
            { parse_mode: "Markdown" }
          );
        } catch (_) {}
      }
    }
  }
}
