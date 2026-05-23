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

// --- Pending group-invite stash ---
// When an unregistered user is added to a group, we record the group(s) they
// were invited to so /register can retro-add them on activation. Stash lives
// in ScriptProperties keyed by user.id; value is a CSV of group chat_ids.
// Stays small (4 members × handful of groups) — well within the 9KB-per-key
// and 500KB-total ScriptProperties limits.

var _PENDING_GROUP_INVITE_PREFIX = "pending_group_invite_";

function _pendingInviteKey(userChatId) {
  return _PENDING_GROUP_INVITE_PREFIX + String(userChatId);
}

function addPendingGroupInvite(userChatId, groupChatId) {
  var props = PropertiesService.getScriptProperties();
  var key = _pendingInviteKey(userChatId);
  var existing = props.getProperty(key) || "";
  var set = existing
    .split(",")
    .map(function (s) {
      return s.trim();
    })
    .filter(function (s) {
      return s.length > 0;
    });
  var g = String(groupChatId);
  if (set.indexOf(g) !== -1) return false;
  set.push(g);
  props.setProperty(key, set.join(","));
  return true;
}

function getPendingGroupInvites(userChatId) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(_pendingInviteKey(userChatId)) || "";
  return raw
    .split(",")
    .map(function (s) {
      return s.trim();
    })
    .filter(function (s) {
      return s.length > 0;
    });
}

function clearPendingGroupInvites(userChatId) {
  PropertiesService.getScriptProperties().deleteProperty(_pendingInviteKey(userChatId));
}

// Walk every pending invite for this newly-activated user and add them to the
// corresponding group's member list. Posts a "joined" message in each group.
// Called from activatePendingTenantForEmail right after activation.
//
// Skips groups whose status isn't active (bot was removed, etc.) and groups
// already at the member cap.
function consumePendingGroupInvitesForUser(userChatId, displayName) {
  var pending = getPendingGroupInvites(userChatId);
  if (!pending.length) return [];
  var added = [];
  for (var i = 0; i < pending.length; i++) {
    var groupId = pending[i];
    var group = findGroupTenantByChatId(groupId);
    if (!group || group.status !== TENANT_STATUS.ACTIVE) continue;
    if (group.group_members.length >= MAX_GROUP_MEMBERS) {
      // Group filled up while they were registering. Notify the admin.
      var adminId = getGroupAdminChatId(group);
      if (adminId) {
        try {
          sendTelegramMessage(
            adminId,
            "⚠️ *" +
              escapeMarkdown(displayName || String(userChatId)) +
              "* finished registering, but *" +
              escapeMarkdown(group.name || "your group") +
              "* is already at the " +
              MAX_GROUP_MEMBERS +
              "-member cap. Remove someone and ask them to /start in the group again.",
            { parse_mode: "Markdown" }
          );
        } catch (_) {}
      }
      continue;
    }
    if (addGroupMember(groupId, userChatId)) {
      added.push(group);
      try {
        sendTelegramMessage(
          groupId,
          "✅ *" + escapeMarkdown(displayName || String(userChatId)) + "* joined the splits.",
          { parse_mode: "Markdown" }
        );
      } catch (e) {
        console.error("[consumePendingGroupInvitesForUser] post failed: " + e.message);
      }
    }
  }
  clearPendingGroupInvites(userChatId);
  return added;
}

// chat_member dispatch: another user's membership in a chat we know about
// changed. Telegram delivers these only when the bot is admin (and we
// enforced bot-admin at /start), so this is the canonical join/leave signal.
//
// Ignores my_chat_member territory (events about ourselves) — those flow
// through handleBotMembershipChange.
function handleChatMemberChange(update) {
  var ev = update.chat_member;
  if (!ev || !ev.chat) return;
  var chatType = ev.chat.type;
  if (chatType !== "group" && chatType !== "supergroup") return;

  var group = findGroupTenantByChatId(ev.chat.id);
  if (!group || group.status !== TENANT_STATUS.ACTIVE) return; // unprovisioned/disabled — ignore

  var user = ev.new_chat_member && ev.new_chat_member.user;
  if (!user || user.is_bot) return; // skip bots (incl. self)

  var oldStatus = ev.old_chat_member && ev.old_chat_member.status;
  var newStatus = ev.new_chat_member && ev.new_chat_member.status;
  var wasIn =
    oldStatus === "member" || oldStatus === "administrator" || oldStatus === "creator" || oldStatus === "restricted";
  var isIn =
    newStatus === "member" || newStatus === "administrator" || newStatus === "creator" || newStatus === "restricted";

  var userChatId = String(user.id);
  var displayName = user.first_name || user.username || userChatId;

  // Joined: was out, now in.
  if (!wasIn && isIn) {
    if (group.group_members.indexOf(userChatId) !== -1) return; // already tracked
    if (group.group_members.length >= MAX_GROUP_MEMBERS) {
      // Cap exceeded. DM the admin so they can decide who to remove. Don't
      // post in the group — avoids embarrassing the new member publicly.
      var adminCap = getGroupAdminChatId(group);
      if (adminCap) {
        try {
          sendTelegramMessage(
            adminCap,
            "⚠️ *" +
              escapeMarkdown(displayName) +
              "* joined *" +
              escapeMarkdown(group.name || "your group") +
              "* but it's already at the " +
              MAX_GROUP_MEMBERS +
              "-member cap. They won't be included in splits until you remove someone.",
            { parse_mode: "Markdown" }
          );
        } catch (_) {}
      }
      return;
    }

    var personal = findTenantByChatId(userChatId);
    if (personal && personal.status === TENANT_STATUS.ACTIVE && personal.chat_type === TENANT_CHAT_TYPE.PERSONAL) {
      addGroupMember(ev.chat.id, userChatId);
      try {
        sendTelegramMessage(ev.chat.id, "👋 *" + escapeMarkdown(displayName) + "* joined the splits.", {
          parse_mode: "Markdown"
        });
      } catch (_) {}
    } else {
      // Unregistered: stash the invite + DM /register prompt. They'll be
      // retro-added on activation via consumePendingGroupInvitesForUser.
      addPendingGroupInvite(userChatId, ev.chat.id);
      try {
        sendTelegramMessage(
          userChatId,
          "👋 You've been added to *" +
            escapeMarkdown(group.name || "a group") +
            "* on Dus Aane Bot.\n\n" +
            "Send me `/register your.email@gmail.com` here in DM to start splitting expenses with the group.",
          { parse_mode: "Markdown" }
        );
      } catch (_) {
        // User hasn't started a DM with the bot yet — sendMessage 403s.
        // Nothing actionable; the in-group flow will surface them later.
      }
    }
    return;
  }

  // Left: was in, now out.
  if (wasIn && !isIn) {
    if (removeGroupMember(ev.chat.id, userChatId)) {
      try {
        sendTelegramMessage(
          ev.chat.id,
          "👋 *" + escapeMarkdown(displayName) + "* left. Their share of past splits stays on record.",
          { parse_mode: "Markdown" }
        );
      } catch (_) {}
    }
  }
}

// --- Group-context commands ---

// /help in a group: show only the commands that are meaningful in groups.
// /split (the inline split UI) lands in step 3; until then this lists only
// what's wired up.
function handleGroupHelpCommand(update) {
  var chatId = update.message.chat.id;
  var group = findGroupTenantByChatId(chatId);
  if (!group || group.status !== TENANT_STATUS.ACTIVE) {
    sendTelegramMessage(chatId, "👋 This group isn't set up yet. Promote me to admin and run `/start`.", {
      parse_mode: "Markdown"
    });
    return;
  }
  var msg =
    "*Group commands*\n" +
    "• `/start` — re-sync the member list from this chat\n" +
    "• `/account` — show this group's setup\n" +
    "• `/stats` — who owes whom (per currency)\n" +
    "• `/settle @member <amount>` — record a cash payment to a member\n" +
    "• `/help` — this message\n\n" +
    "_Email-based settlements: forward the UPI confirmation in DM, tap_ 👥 *Split with <group>* _→_ 🤝 *Settle up* _→ recipient._";
  var opts = { parse_mode: "Markdown" };
  if (group.sheet_id) {
    opts.reply_markup = {
      inline_keyboard: [[{ text: "📋 Open group sheet", url: sheetUrl(group.sheet_id) }]]
    };
  }
  sendTelegramMessage(chatId, msg, opts);
}

// /account in a group: show the group tenant's status — name, sheet link,
// member roster (registered + pending invites), admin, currency.
function handleGroupAccountCommand(update) {
  var chatId = update.message.chat.id;
  var group = findGroupTenantByChatId(chatId);
  if (!group || group.status !== TENANT_STATUS.ACTIVE) {
    sendTelegramMessage(chatId, "👋 This group isn't set up yet. Promote me to admin and run `/start`.", {
      parse_mode: "Markdown"
    });
    return;
  }
  var lines = [];
  lines.push("*" + escapeMarkdown(group.name || "Group") + "*");
  lines.push("Status: `" + group.status + "`");
  lines.push("Currency: `" + group.primary_currency + "`");
  var memberLabels = group.group_members.map(function (m) {
    var t = findTenantByChatId(m);
    return t && t.name ? escapeMarkdown(t.name) : "`" + m + "`";
  });
  lines.push(
    "Members (" +
      group.group_members.length +
      "/" +
      MAX_GROUP_MEMBERS +
      "): " +
      (memberLabels.length ? memberLabels.join(", ") : "_none yet_")
  );
  var adminId = getGroupAdminChatId(group);
  if (adminId) {
    var adminTenant = findTenantByChatId(adminId);
    var adminLabel = adminTenant && adminTenant.name ? escapeMarkdown(adminTenant.name) : "`" + adminId + "`";
    lines.push("Admin: " + adminLabel);
  }
  if (group.sheet_id) lines.push("Sheet: [open](" + sheetUrl(group.sheet_id) + ")");
  sendTelegramMessage(chatId, lines.join("\n"), { parse_mode: "Markdown", disable_web_page_preview: true });
}

// --- Split-UI callback encoding ---
// Telegram caps callback_data at 64 bytes. Our format keeps each callback
// under 50 bytes for the worst case (16-byte gmail message id + 14-byte
// negative group chat id + 4-byte action + separators).
//
// Action codes:
//   gnav   parent tap, render Level 1 split picker for a group
//   gsp    leaf, record a split (mode = 50 | all | wN where N is member idx)
//   gset   render Level 2 settlement picker
//   gst    leaf, record a settlement (target = member idx)
//   gbk    back nav (dest = 0 to return to the top-level transaction view)
//   gun    undo a recorded split, restore Level 0 buttons
//
// All multi-arg callbacks use ":" as the separator (vs. the legacy "_") so the
// existing personal callback dispatch (which splits on the first "_") doesn't
// fight us.

function encodeGroupCallback(action, parts) {
  var arr = [action].concat(parts || []);
  return arr.join(":");
}

function decodeGroupCallback(data) {
  if (!data) return null;
  var bits = String(data).split(":");
  return { action: bits[0], parts: bits.slice(1) };
}

// True iff the callback_data starts with one of the group-UI action codes.
// Used by the legacy callback dispatcher in BotHandlers to bail out early.
function isGroupCallback(data) {
  if (!data) return false;
  var head = String(data).split(":")[0];
  return (
    head === "gnav" ||
    head === "gsp" ||
    head === "gset" ||
    head === "gst" ||
    head === "gbk" ||
    head === "gun" ||
    head === "gstats"
  );
}

// Build the Level 0 row(s) for a transaction-notification keyboard:
// one parent button per active group the personal tenant belongs to.
// Returns [] when the user is in zero groups — caller falls back to the
// legacy ✂️ Split (2-person personal flow).
function buildGroupParentButtonRows(personalChatId, emailMessageId) {
  var groups = findGroupsForMember(personalChatId);
  if (!groups.length) return [];
  var rows = [];
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    var label = "👥 Split with " + (g.name || "Group") + " ▾";
    rows.push([{ text: label, callback_data: encodeGroupCallback("gnav", [emailMessageId, g.chat_id]) }]);
  }
  return rows;
}

// Top-level dispatcher for group-UI callbacks. Step 3.1 only handles gnav
// (the parent tap) with a placeholder toast; the full Level 1/2 menus and
// leaf handlers land in step 3.2 / step 4.
function handleGroupCallback(update) {
  var cb = update.callback_query;
  if (!cb || !cb.data) return;

  // Ack the callback immediately so the Telegram client clears the spinner
  // (~150ms) instead of waiting on sheet I/O, group posts, etc. Telegram
  // honors only one answerCallbackQuery per callback_query_id; later branches
  // surface errors as chat messages instead of toasts.
  answerCallbackQuery(cb.id, "");

  var decoded = decodeGroupCallback(cb.data);
  if (!decoded || !decoded.action) {
    return;
  }

  var callerChatId = String(cb.from && cb.from.id);
  var chatId = cb.message && cb.message.chat && cb.message.chat.id;
  var telegramMessageId = cb.message && cb.message.message_id;
  var bodyText = (cb.message && cb.message.text) || "";

  if (decoded.action === "gnav") {
    // parts: [emailMessageId, groupChatId] → render Level 1 split picker.
    var emailMessageId = decoded.parts[0];
    var groupChatId = decoded.parts[1];
    var group = findGroupTenantByChatId(groupChatId);
    if (!group || group.status !== TENANT_STATUS.ACTIVE) {
      sendTelegramMessage(chatId, "❌ *Group is no longer active.*");
      return;
    }
    if (group.group_members.indexOf(callerChatId) === -1) {
      sendTelegramMessage(chatId, "❌ *You're not a member of this group.*");
      return;
    }
    var kb = buildSplitLevel1Keyboard(group, callerChatId, emailMessageId);
    sendTelegramMessage(chatId, bodyText, {
      parse_mode: "Markdown",
      message_id: telegramMessageId,
      reply_markup: kb
    });
    return;
  }

  if (decoded.action === "gset") {
    // parts: [emailMessageId, groupChatId] → render Level 2 settlement picker.
    var emailMessageIdSet = decoded.parts[0];
    var groupChatIdSet = decoded.parts[1];
    var groupSet = findGroupTenantByChatId(groupChatIdSet);
    if (!groupSet || groupSet.status !== TENANT_STATUS.ACTIVE) {
      sendTelegramMessage(chatId, "❌ *Group is no longer active.*");
      return;
    }
    if (groupSet.group_members.indexOf(callerChatId) === -1) {
      sendTelegramMessage(chatId, "❌ *You're not a member of this group.*");
      return;
    }
    var kbSet = buildSplitLevel2Keyboard(groupSet, callerChatId, emailMessageIdSet);
    sendTelegramMessage(chatId, bodyText, {
      parse_mode: "Markdown",
      message_id: telegramMessageId,
      reply_markup: kbSet
    });
    return;
  }

  if (decoded.action === "gbk") {
    // parts: [emailMessageId, groupChatId, destLevel]
    //   destLevel = "0" → restore the top-level transaction keyboard.
    //   destLevel = "1" → return from Level 2 (settlement) to Level 1.
    var emailMessageIdBk = decoded.parts[0];
    var groupChatIdBk = decoded.parts[1];
    var destLevel = decoded.parts[2];
    if (destLevel === "1") {
      var groupBk = findGroupTenantByChatId(groupChatIdBk);
      if (!groupBk) {
        sendTelegramMessage(chatId, "❌ *Group is no longer active.*");
        return;
      }
      var kbBack1 = buildSplitLevel1Keyboard(groupBk, callerChatId, emailMessageIdBk);
      sendTelegramMessage(chatId, bodyText, {
        parse_mode: "Markdown",
        message_id: telegramMessageId,
        reply_markup: kbBack1
      });
    } else {
      // Restore the pre-split keyboard with the row's current Tag / Category
      // values so the pills mirror what's in the body text.
      var pillRow = findRowByColumnValue(MESSAGE_ID_COLUMN, emailMessageIdBk);
      var pillMerchant = "";
      var pillCategory = "";
      if (pillRow > 0) {
        var pillData = getSpreadsheet().getSheets()[0].getRange(pillRow, 1, 1, CATEGORY_COLUMN).getValues()[0];
        pillMerchant = (pillData[MERCHANT_COLUMN - 1] || "").toString().trim();
        pillCategory = (pillData[CATEGORY_COLUMN - 1] || "").toString().trim();
      }
      var kbBack0 = buildTransactionLevel0Keyboard(callerChatId, emailMessageIdBk, pillMerchant, pillCategory);
      sendTelegramMessage(chatId, bodyText, {
        parse_mode: "Markdown",
        message_id: telegramMessageId,
        reply_markup: kbBack0
      });
    }
    return;
  }

  if (decoded.action === "gsp") {
    executeGroupSplit(cb, decoded, callerChatId, chatId, telegramMessageId, bodyText);
    return;
  }

  if (decoded.action === "gun") {
    executeGroupUndo(cb, decoded, callerChatId, chatId, telegramMessageId, bodyText);
    return;
  }

  if (decoded.action === "gst") {
    executeGroupSettlement(cb, decoded, callerChatId, chatId, telegramMessageId, bodyText);
    return;
  }

  if (decoded.action === "gstats") {
    // parts: [mode]  mode='s' → simplify, 'd' → detailed
    var mode = decoded.parts[0] === "s" ? "s" : "d";
    var groupStats = findGroupTenantByChatId(chatId);
    if (!groupStats || groupStats.status !== TENANT_STATUS.ACTIVE) {
      sendTelegramMessage(chatId, "❌ *Group is no longer active.*");
      return;
    }
    if (groupStats.group_members.indexOf(callerChatId) === -1) {
      sendTelegramMessage(chatId, "❌ *You're not a member of this group.*");
      return;
    }
    var sheetStats = openGroupSheet(groupStats.sheet_id);
    var lastRowStats = sheetStats.getLastRow();
    var rowsStats = [];
    if (lastRowStats > 1) {
      rowsStats = sheetStats.getRange(2, 1, lastRowStats - 1, G_COL_COUNT).getValues();
    }
    var detailed = aggregatePairwiseDebts(rowsStats);
    var data = mode === "s" ? simplifyDebtsGreedy(detailed) : detailed;
    var nameOfStats = function (id) {
      var t = findTenantByChatId(id);
      return t && t.name ? t.name : id;
    };
    var textStats = formatGroupStats(data, nameOfStats, groupStats.name, mode === "s");
    sendTelegramMessage(chatId, textStats, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      message_id: telegramMessageId,
      reply_markup: buildGroupStatsKeyboard(mode)
    });
    return;
  }
}

// --- Split menu keyboards (UI only — writes ship in step 4) ---

// Pure helper: list other members (excluding the caller), preserving the
// CSV/insertion order from group_members. Each entry: { chat_id, label }.
// label = personal tenant's name when available, else the chat_id.
// Pure helper: list other members (excluding the caller), preserving the
// CSV/insertion order from group_members. Each entry: { chat_id, label }.
//
// Label resolution chain (first non-empty wins):
//   1. personal tenant's `name` column (set at /register time)
//   2. Telegram getChatMember.first_name / username (covers members who
//      haven't registered yet, or whose tenant row has an empty name)
//   3. raw chat_id (last-resort fallback so buttons never break)
function listOtherMembers(group, callerChatId) {
  var others = [];
  for (var i = 0; i < group.group_members.length; i++) {
    var m = group.group_members[i];
    if (m === String(callerChatId)) continue;
    var t = findTenantByChatId(m);
    var label = (t && t.name) || "";
    if (!label && typeof getTelegramChatMemberName === "function") {
      // Tenant missing or unnamed — ask Telegram who this user is in the
      // group. Best-effort; falls back to chat_id if the API call fails.
      label = getTelegramChatMemberName(group.chat_id, m);
    }
    if (!label) label = m;
    others.push({ chat_id: m, label: label });
  }
  return others;
}

// Level 1: split picker for one group. Layout depends on member count.
//   2-person: [👥 50-50 with <other>]   [💝 <other> owes 100%]
//   3-person: [👥 All 3]                 [➖ Without <X>]    [➖ Without <Y>]
//   4-person: [👥 All 4]
//             [➖ Without <X>]   [➖ Without <Y>]   [➖ Without <Z>]
//             [👥 With <X>]      [👥 With <Y>]      [👥 With <Z>]
// Plus a [🤝 Settle up ▾] row and [← Back] row.
function buildSplitLevel1Keyboard(group, callerChatId, emailMessageId) {
  var groupChatId = group.chat_id;
  var others = listOtherMembers(group, callerChatId);
  var n = others.length + 1; // total participants including caller
  var rows = [];

  if (n === 2) {
    var other = others[0];
    rows.push([
      {
        text: "👥 50-50 with " + other.label,
        callback_data: encodeGroupCallback("gsp", [emailMessageId, groupChatId, "50"])
      }
    ]);
    rows.push([
      {
        text: "💝 " + other.label + " owes 100%",
        callback_data: encodeGroupCallback("gsp", [emailMessageId, groupChatId, "p100"])
      }
    ]);
  } else if (n >= 3) {
    rows.push([
      {
        text: "👥 All " + n,
        callback_data: encodeGroupCallback("gsp", [emailMessageId, groupChatId, "all"])
      }
    ]);
    // "Without X" buttons — one row of up to 3, indexed by position in
    // group_members (so step 4 can resolve back to a chat_id deterministically).
    var withoutRow = [];
    for (var j = 0; j < others.length; j++) {
      // Index in group_members (CSV order). Step 4 uses this to compute the
      // share holder set.
      var idx = group.group_members.indexOf(others[j].chat_id);
      withoutRow.push({
        text: "➖ Without " + others[j].label,
        callback_data: encodeGroupCallback("gsp", [emailMessageId, groupChatId, "w" + idx])
      });
    }
    rows.push(withoutRow);
    // For n=4 only, add a "With X" row for the 2-person sub-splits that
    // "Without" can't reach (e.g. just caller + member B in a 4-person
    // group). 3-person groups don't need this — "Without X" already covers
    // every 2-person subset that includes the caller.
    if (n === 4) {
      var withRow = [];
      for (var k = 0; k < others.length; k++) {
        var idxI = group.group_members.indexOf(others[k].chat_id);
        withRow.push({
          text: "👥 With " + others[k].label,
          callback_data: encodeGroupCallback("gsp", [emailMessageId, groupChatId, "i" + idxI])
        });
      }
      rows.push(withRow);
    }
  }

  // Settlement sub-menu
  rows.push([
    {
      text: "🤝 Settle up ▾",
      callback_data: encodeGroupCallback("gset", [emailMessageId, groupChatId])
    }
  ]);

  // Back to top-level
  rows.push([
    {
      text: "← Back",
      callback_data: encodeGroupCallback("gbk", [emailMessageId, groupChatId, "0"])
    }
  ]);

  return { inline_keyboard: rows };
}

// Level 2: settlement picker — one button per other member.
function buildSplitLevel2Keyboard(group, callerChatId, emailMessageId) {
  var groupChatId = group.chat_id;
  var others = listOtherMembers(group, callerChatId);
  var rows = [];
  for (var i = 0; i < others.length; i++) {
    var idx = group.group_members.indexOf(others[i].chat_id);
    rows.push([
      {
        text: "→ " + others[i].label,
        callback_data: encodeGroupCallback("gst", [emailMessageId, groupChatId, String(idx)])
      }
    ]);
  }
  rows.push([
    {
      text: "← Back",
      callback_data: encodeGroupCallback("gbk", [emailMessageId, groupChatId, "1"])
    }
  ]);
  return { inline_keyboard: rows };
}

// Restore the original transaction-notification keyboard (group parent rows
// + the action row). Used by back nav.
//
// Mirrors sendTransactionMessage's keyboard rules: the legacy ✂️ Split is
// dropped when the user has at least one group (the 👥 Split with <Group>
// parent buttons are the canonical path then; keeping both clutters the UI).
//
// merchant + category are optional — callers that already have the row in
// hand pass them so the 🏷 / 📂 pills mirror the body text. When omitted
// (e.g. tests) the pills render with the "Untagged" / "Uncategorized"
// fallbacks rather than triggering an extra sheet read here.
function buildTransactionLevel0Keyboard(callerChatId, emailMessageId, merchant, category) {
  var rows = buildGroupParentButtonRows(callerChatId, emailMessageId);
  var tagPill = "🏷 " + pillLabel(merchant, "Untagged") + " ▾";
  var catPill = "📂 " + pillLabel(shortCategoryName(category), "Uncategorized") + " ▾";
  rows.push([
    { text: tagPill, callback_data: "tag_" + emailMessageId },
    { text: catPill, callback_data: "editcat_" + emailMessageId },
    { text: "❓", callback_data: "help_" + emailMessageId }
  ]);
  return { inline_keyboard: rows };
}

// Keyboard shown on the DM card after a personal txn has been split or
// settled. Undo gets a full-width top row; pills + ❓ overflow share the
// bottom row. Keeps ❓ as the last item in the last row across every
// txn-card surface so users can always reach it in the same spot.
function buildPostSplitDMKeyboard(emailMessageId, merchant, category) {
  return {
    inline_keyboard: [
      [{ text: "↩️ Make personal again", callback_data: encodeGroupCallback("gun", [emailMessageId]) }],
      [
        { text: "🏷 " + pillLabel(merchant, "Untagged") + " ▾", callback_data: "tag_" + emailMessageId },
        {
          text: "📂 " + pillLabel(shortCategoryName(category), "Uncategorized") + " ▾",
          callback_data: "editcat_" + emailMessageId
        },
        { text: "❓", callback_data: "help_" + emailMessageId }
      ]
    ]
  };
}

// --- Step 4 pure helpers (share computation + notification text) ---

// Compute the share-holder set and per-holder amounts for a split.
// Pure helper — no I/O, no Telegram, no Sheet. Easy to unit-test.
//
// Inputs:
//   group         — group tenant ({ group_members: [chat_id...] })
//   callerChatId  — the member who paid (will be Paid By)
//   mode          — split mode encoded in the callback:
//                     "50"   2-person 50/50 split (only valid for n=2)
//                     "p100" 2-person partner-owes-100% (only valid for n=2)
//                     "all"  every member pays an equal share
//                     "wK"   every member except group_members[K] pays equally
//                     "iK"   only caller + group_members[K] pay equally (for
//                              4-person groups where the user wants a 2-way
//                              split with one specific other member)
//   totalAmount   — the original transaction amount (number)
//
// Output: { holders: [chat_id...], shares: [number...] } parallel arrays.
//   holders[i] holds shares[i]. shares[0] absorbs the rounding remainder so
//   sum(shares) === totalAmount exactly. Returns null on invalid input
//   (mode/group mismatch, empty group, etc.) — caller toasts an error.
function computeSplitShareSet(group, callerChatId, mode, totalAmount) {
  if (!group || !group.group_members || !group.group_members.length) return null;
  if (typeof totalAmount !== "number" || isNaN(totalAmount)) return null;
  var members = group.group_members.slice();
  var n = members.length;
  var caller = String(callerChatId);

  var holders = null;
  if (mode === "50") {
    if (n !== 2) return null;
    holders = members.slice(); // both
  } else if (mode === "p100") {
    if (n !== 2) return null;
    // Caller paid; the other member owes 100%. Caller's share is 0 (no row
    // written for them — only debt-holders appear in the group sheet).
    holders = members.filter(function (m) {
      return m !== caller;
    });
  } else if (mode === "all") {
    holders = members.slice();
  } else if (mode && mode.charAt(0) === "w") {
    var idx = parseInt(mode.slice(1), 10);
    if (isNaN(idx) || idx < 0 || idx >= n) return null;
    var excluded = members[idx];
    if (excluded === caller) return null; // can't exclude the payer
    holders = members.filter(function (m) {
      return m !== excluded;
    });
  } else if (mode && mode.charAt(0) === "i") {
    var idxI = parseInt(mode.slice(1), 10);
    if (isNaN(idxI) || idxI < 0 || idxI >= n) return null;
    var partner = members[idxI];
    if (partner === caller) return null; // "just me + me" is a no-op
    holders = [caller, partner];
  } else {
    return null;
  }

  if (!holders.length) return null;

  // Round to 2 decimal places. Give the residual to holders[0] so the sum
  // matches totalAmount exactly (settlement math doesn't drift).
  var k = holders.length;
  var per = Math.round((totalAmount / k) * 100) / 100;
  var shares = new Array(k);
  for (var i = 1; i < k; i++) shares[i] = per;
  var residual = Math.round((totalAmount - per * (k - 1)) * 100) / 100;
  shares[0] = residual;
  return { holders: holders, shares: shares };
}

// Format the group-chat notification for a recorded split. Pure formatter.
// Member names come from a lookup function so we don't import findTenantByChatId
// at test time.
//
// Layout — first two lines mirror the personal transaction card exactly
// (same 🔴/🟢 lead emoji, same merchant — money headline, same category·date
// row), with two extra lines for the split context:
//   🔴 *<merchant>* — ₹<amount>
//   📂 <short category> · <date>
//   👤 *<Payer>* paid
//   👥 Alice ₹100 · Bob ₹100
function formatGroupSplitNotification(opts) {
  var merchant = opts.merchant || "";
  var amount = opts.amount;
  var currency = opts.currency || "INR";
  var category = opts.category || "";
  var rawDate = opts.date;
  var txType = opts.txType || "Debit";
  var payerName = opts.payerName || String(opts.payerChatId || "");
  var holders = opts.holders || [];
  var shares = opts.shares || [];
  var nameOf =
    opts.nameOf ||
    function (id) {
      return String(id);
    };

  var sym = currencySymbol(currency);
  var money = sym + formatAmount(amount);
  var typeEmoji = isDebit(txType) ? "🔴" : "🟢";

  var date = "";
  if (rawDate) {
    date = escapeMarkdown(
      rawDate instanceof Date ? Utilities.formatDate(rawDate, Session.getScriptTimeZone(), "dd MMM yyyy") : rawDate
    );
  }

  var sharePieces = [];
  for (var i = 0; i < holders.length; i++) {
    var name = nameOf(holders[i]) || String(holders[i]);
    sharePieces.push(escapeMarkdown(name) + " " + sym + formatAmount(shares[i]));
  }

  var lines = [];
  lines.push(merchant ? typeEmoji + " *" + escapeMarkdown(merchant) + "* — " + money : typeEmoji + " *" + money + "*");
  if (category && date) {
    lines.push("📂 " + escapeMarkdown(shortCategoryName(category)) + " · " + date);
  } else if (category) {
    lines.push("📂 " + escapeMarkdown(shortCategoryName(category)));
  } else if (date) {
    lines.push("🗓 " + date);
  }
  lines.push("👤 *" + escapeMarkdown(payerName) + "* paid");
  if (sharePieces.length) lines.push("👥 " + sharePieces.join(" · "));
  return lines.join("\n");
}

// gsp executor — record a split. Writes N share rows to the group sheet,
// posts a notification in the group chat, stamps the personal row with
// group_ref + group_message_id, and swaps the DM keyboard to a single
// "↩️ Make personal again" button (preserving Category / Delete).
//
// The caller's tenant context (their personal sheet) is set by doPost before
// the callback is dispatched; tests must call setCurrentTenant beforehand.
function executeGroupSplit(cb, decoded, callerChatId, dmChatId, telegramMessageId, bodyText) {
  // Serialize against double-taps and webhook retries. Without this, two
  // dispatches can both pass the GROUP_REF "already split" guard, then both
  // post to the group + write to the sheet — yielding duplicate posts and
  // duplicate rows. tryLock fails-open after 5s: better to risk a rare
  // duplicate than to silently drop a legitimate split.
  var __lock = LockService.getScriptLock();
  if (!__lock.tryLock(5000)) {
    sendTelegramMessage(dmChatId, "⏳ *Busy — try again in a moment.*", { parse_mode: "Markdown" });
    return;
  }
  try {
    return _executeGroupSplitLocked(cb, decoded, callerChatId, dmChatId, telegramMessageId, bodyText);
  } finally {
    __lock.releaseLock();
  }
}

function _executeGroupSplitLocked(cb, decoded, callerChatId, dmChatId, telegramMessageId, bodyText) {
  var emailMessageId = decoded.parts[0];
  var groupChatId = decoded.parts[1];
  var mode = decoded.parts[2];

  var result = _recordGroupSplitLocked({
    emailMessageId: emailMessageId,
    groupChatId: groupChatId,
    mode: mode,
    payerChatId: callerChatId
  });

  if (!result.ok) {
    sendTelegramMessage(dmChatId, result.message || "❌ *Split failed.*");
    return;
  }

  // Replace the DM keyboard. Group parent buttons are gone (would re-split);
  // 🏷 Tag, 📂 Category and ❓ overflow still apply to the personal row.
  var newKb = buildPostSplitDMKeyboard(emailMessageId, result.merchant, result.category);
  sendTelegramMessage(dmChatId, bodyText, {
    parse_mode: "Markdown",
    message_id: telegramMessageId,
    reply_markup: newKb
  });
}

// Callback-less split entry point. Same lock + body as executeGroupSplit but
// returns a structured result instead of pushing chat messages or swapping
// keyboards. Used by the /ask split_transaction tool, which has no DM card
// to refresh and surfaces the outcome via the LLM's own answer.
//
// Return shape:
//   { ok: true,  merchant, category, amount, currency, holders, shares, groupMsgId }
//   { ok: false, error: "<plain text>", message: "<markdown for DM>" }
function recordGroupSplit(args) {
  var __lock = LockService.getScriptLock();
  if (!__lock.tryLock(5000)) {
    return { ok: false, error: "Busy — try again in a moment.", message: "⏳ *Busy — try again in a moment.*" };
  }
  try {
    return _recordGroupSplitLocked(args);
  } finally {
    __lock.releaseLock();
  }
}

function _recordGroupSplitLocked(args) {
  var emailMessageId = args.emailMessageId;
  var groupChatId = args.groupChatId;
  var mode = args.mode;
  var callerChatId = args.payerChatId;

  var group = findGroupTenantByChatId(groupChatId);
  if (!group || group.status !== TENANT_STATUS.ACTIVE) {
    return { ok: false, error: "Group is no longer active.", message: "❌ *Group is no longer active.*" };
  }
  if (group.group_members.indexOf(callerChatId) === -1) {
    return {
      ok: false,
      error: "You're not a member of this group.",
      message: "❌ *You're not a member of this group.*"
    };
  }

  var rowNumber = findRowByColumnValue(MESSAGE_ID_COLUMN, emailMessageId);
  if (rowNumber < 0) {
    return { ok: false, error: "Transaction not found.", message: "❌ *Transaction not found.*" };
  }
  // Read the row at the full 13-column width directly. getRowData() only
  // reaches EMAIL_LINK_COLUMN (col 11) so it can't see GROUP_REF / GROUP_MESSAGE_ID.
  var personalSheet = getSpreadsheet().getSheets()[0];
  var rowData = personalSheet.getRange(rowNumber, 1, 1, GROUP_MESSAGE_ID_COLUMN).getValues()[0];
  // Re-split guard. Caller must undo before splitting again.
  if (rowData[GROUP_REF_COLUMN - 1]) {
    return { ok: false, error: "Already split — undo first.", message: "ℹ️ *Already split — undo first.*" };
  }

  var amount = Number(rowData[AMOUNT_COLUMN - 1]);
  var shareSet = computeSplitShareSet(group, callerChatId, mode, amount);
  if (!shareSet) {
    return { ok: false, error: "Invalid split for this group.", message: "❌ *Invalid split for this group.*" };
  }

  var emailDate = rowData[EMAIL_DATE_COLUMN - 1];
  var txDate = rowData[TRANSACTION_DATE_COLUMN - 1];
  var merchant = rowData[MERCHANT_COLUMN - 1];
  var currency = rowData[CURRENCY_COLUMN - 1] || group.primary_currency || "INR";
  var category = rowData[CATEGORY_COLUMN - 1];
  var txType = rowData[TRANSACTION_TYPE_COLUMN - 1];
  var emailLink = rowData[EMAIL_LINK_COLUMN - 1];

  var txId = Utilities.getUuid();

  var nameOf = function (id) {
    var t = findTenantByChatId(id);
    return t && t.name ? t.name : id;
  };
  var notificationText = formatGroupSplitNotification({
    merchant: merchant,
    amount: amount,
    currency: currency,
    category: category,
    date: txDate || emailDate,
    txType: txType,
    payerChatId: callerChatId,
    payerName: nameOf(callerChatId),
    holders: shareSet.holders,
    shares: shareSet.shares,
    nameOf: nameOf
  });

  // Post to the group chat first so we have a message_id to stamp on every
  // group sheet row. Failure here aborts before we write — keeps state
  // consistent (no orphan group rows pointing at a missing message).
  var sendResp = sendTelegramMessage(group.chat_id, notificationText, {
    parse_mode: "Markdown",
    disable_web_page_preview: true
  });
  var groupMsgId = "";
  try {
    var parsed = JSON.parse(sendResp || "{}");
    if (parsed && parsed.result && parsed.result.message_id) {
      groupMsgId = String(parsed.result.message_id);
    }
  } catch (_) {}
  if (!groupMsgId) {
    return { ok: false, error: "Couldn't post in the group.", message: "❌ *Couldn't post in the group.*" };
  }

  var groupSheet = openGroupSheet(group.sheet_id);
  for (var i = 0; i < shareSet.holders.length; i++) {
    groupSheet.appendRow([
      emailDate,
      txDate,
      merchant,
      amount,
      currency,
      callerChatId,
      shareSet.holders[i],
      shareSet.shares[i],
      txId,
      category,
      txType,
      groupMsgId,
      emailLink
    ]);
  }

  // Stamp the personal row so /undo + future re-splits see the linkage.
  personalSheet.getRange(rowNumber, GROUP_REF_COLUMN).setValue(group.chat_id + ":" + txId);
  personalSheet.getRange(rowNumber, GROUP_MESSAGE_ID_COLUMN).setValue(groupMsgId);

  return {
    ok: true,
    merchant: merchant,
    category: category,
    amount: amount,
    currency: currency,
    holders: shareSet.holders,
    shares: shareSet.shares,
    groupMsgId: groupMsgId
  };
}

// gun executor — undo a previously-recorded split. Strikes through the group
// notification (preserves replies/reactions), hard-deletes every group share
// row for the Tx ID, clears the personal row's group_ref + group_message_id,
// and restores the original DM keyboard (group parents + legacy split row).
//
// Telegram's editMessageText API has a server-side 48h cutoff. If the edit
// fails (older message, bot kicked, etc.) we abort BEFORE deleting group
// rows — keeping state consistent and prompting the user to clean the sheet
// manually.
function executeGroupUndo(cb, decoded, callerChatId, dmChatId, telegramMessageId, bodyText) {
  var __lock = LockService.getScriptLock();
  if (!__lock.tryLock(5000)) {
    sendTelegramMessage(dmChatId, "⏳ *Busy — try again in a moment.*", { parse_mode: "Markdown" });
    return;
  }
  try {
    return _executeGroupUndoLocked(cb, decoded, callerChatId, dmChatId, telegramMessageId, bodyText);
  } finally {
    __lock.releaseLock();
  }
}

function _executeGroupUndoLocked(cb, decoded, callerChatId, dmChatId, telegramMessageId, bodyText) {
  var emailMessageId = decoded.parts[0];

  var rowNumber = findRowByColumnValue(MESSAGE_ID_COLUMN, emailMessageId);
  if (rowNumber < 0) {
    sendTelegramMessage(dmChatId, "❌ *Transaction not found.*");
    return;
  }
  var personalSheet = getSpreadsheet().getSheets()[0];
  var rowData = personalSheet.getRange(rowNumber, 1, 1, GROUP_MESSAGE_ID_COLUMN).getValues()[0];
  var groupRef = rowData[GROUP_REF_COLUMN - 1];
  var groupMsgId = rowData[GROUP_MESSAGE_ID_COLUMN - 1];
  if (!groupRef) {
    sendTelegramMessage(dmChatId, "ℹ️ *Not a group split.*");
    return;
  }

  var refBits = String(groupRef).split(":");
  var groupChatId = refBits[0];
  var txId = refBits.slice(1).join(":");
  var group = findGroupTenantByChatId(groupChatId);
  if (!group) {
    // Group disappeared (rare). Clear the local refs so the row stops
    // pointing at a phantom; nothing else we can clean up.
    personalSheet.getRange(rowNumber, GROUP_REF_COLUMN).setValue("");
    personalSheet.getRange(rowNumber, GROUP_MESSAGE_ID_COLUMN).setValue("");
    sendTelegramMessage(dmChatId, "ℹ️ *Group no longer exists — cleared local link.*");
    return;
  }

  // Try to strike through the group notification first. If we can't (48h
  // edit cutoff, bot kicked), abort: deleting group rows without editing
  // the message would leave the group chat lying about a split that no
  // longer exists in the sheet.
  var strikeText = "<s>✂️ " + escapeHtml(rowData[MERCHANT_COLUMN - 1] || "(transaction)") + " — split reverted</s>";
  var editOk = false;
  try {
    var editResp = sendTelegramMessage(groupChatId, strikeText, {
      parse_mode: "HTML",
      message_id: groupMsgId
    });
    var parsed = JSON.parse(editResp || "{}");
    editOk = !!(parsed && parsed.ok);
  } catch (e) {
    // sendRequest throws on persistent non-200 (e.g. 400 "message can't be
    // edited" past the 48h cutoff). Treat as edit failure.
    editOk = false;
  }
  if (!editOk) {
    sendTelegramMessage(dmChatId, "⚠️ *Couldn't edit the group message (older than 48h?). Edit your sheet manually.*");
    return;
  }

  // Delete every share row in the group sheet matching this Tx ID. Walk
  // bottom-up so row numbers stay valid as we splice.
  var groupSheet = openGroupSheet(group.sheet_id);
  var lastRow = groupSheet.getLastRow();
  if (lastRow > 1) {
    var txIds = groupSheet.getRange(2, G_TX_ID_COLUMN, lastRow - 1, 1).getValues();
    for (var i = txIds.length - 1; i >= 0; i--) {
      if (String(txIds[i][0]) === String(txId)) {
        groupSheet.deleteRow(i + 2);
      }
    }
  }

  // Clear personal row's group ref + msg id so the row goes back to "personal".
  personalSheet.getRange(rowNumber, GROUP_REF_COLUMN).setValue("");
  personalSheet.getRange(rowNumber, GROUP_MESSAGE_ID_COLUMN).setValue("");

  // Restore the original transaction keyboard (group parents + status / action rows).
  var personalRow = personalSheet.getRange(rowNumber, 1, 1, CATEGORY_COLUMN).getValues()[0];
  var newKb = buildTransactionLevel0Keyboard(
    callerChatId,
    emailMessageId,
    (personalRow[MERCHANT_COLUMN - 1] || "").toString().trim(),
    (personalRow[CATEGORY_COLUMN - 1] || "").toString().trim()
  );
  sendTelegramMessage(dmChatId, bodyText, {
    parse_mode: "Markdown",
    message_id: telegramMessageId,
    reply_markup: newKb
  });
}

// Minimal HTML escaper for Telegram parse_mode=HTML. Apps Script doesn't
// ship one and we only need the four characters Telegram flags as unsafe.
function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// gst executor — record a settlement (one-way payment from caller to a
// specific other member). Writes a single Category=Settlement / TxType=
// Settlement row to the group sheet and posts a settlement notification.
//
// Mirrors executeGroupSplit's external contract (post group msg first, then
// write rows, then stamp the personal row, then swap the DM keyboard) so
// gun undoes a settlement the same way it undoes a split.
function executeGroupSettlement(cb, decoded, callerChatId, dmChatId, telegramMessageId, bodyText) {
  var __lock = LockService.getScriptLock();
  if (!__lock.tryLock(5000)) {
    sendTelegramMessage(dmChatId, "⏳ *Busy — try again in a moment.*", { parse_mode: "Markdown" });
    return;
  }
  try {
    return _executeGroupSettlementLocked(cb, decoded, callerChatId, dmChatId, telegramMessageId, bodyText);
  } finally {
    __lock.releaseLock();
  }
}

function _executeGroupSettlementLocked(cb, decoded, callerChatId, dmChatId, telegramMessageId, bodyText) {
  var emailMessageId = decoded.parts[0];
  var groupChatId = decoded.parts[1];
  var targetIdxRaw = decoded.parts[2];

  var group = findGroupTenantByChatId(groupChatId);
  if (!group || group.status !== TENANT_STATUS.ACTIVE) {
    sendTelegramMessage(dmChatId, "❌ *Group is no longer active.*");
    return;
  }
  if (group.group_members.indexOf(callerChatId) === -1) {
    sendTelegramMessage(dmChatId, "❌ *You're not a member of this group.*");
    return;
  }

  var targetIdx = parseInt(targetIdxRaw, 10);
  if (isNaN(targetIdx) || targetIdx < 0 || targetIdx >= group.group_members.length) {
    sendTelegramMessage(dmChatId, "❌ *Invalid settlement target.*");
    return;
  }
  var targetChatId = group.group_members[targetIdx];
  if (targetChatId === callerChatId) {
    sendTelegramMessage(dmChatId, "❌ *Can't settle with yourself.*");
    return;
  }

  var rowNumber = findRowByColumnValue(MESSAGE_ID_COLUMN, emailMessageId);
  if (rowNumber < 0) {
    sendTelegramMessage(dmChatId, "❌ *Transaction not found.*");
    return;
  }
  var personalSheet = getSpreadsheet().getSheets()[0];
  var rowData = personalSheet.getRange(rowNumber, 1, 1, GROUP_MESSAGE_ID_COLUMN).getValues()[0];
  if (rowData[GROUP_REF_COLUMN - 1]) {
    sendTelegramMessage(dmChatId, "ℹ️ *Already split — undo first.*");
    return;
  }

  var amount = Number(rowData[AMOUNT_COLUMN - 1]);
  if (isNaN(amount) || amount <= 0) {
    sendTelegramMessage(dmChatId, "❌ *Invalid transaction amount.*");
    return;
  }

  var emailDate = rowData[EMAIL_DATE_COLUMN - 1];
  var txDate = rowData[TRANSACTION_DATE_COLUMN - 1];
  var merchant = rowData[MERCHANT_COLUMN - 1];
  var category = rowData[CATEGORY_COLUMN - 1];
  var currency = rowData[CURRENCY_COLUMN - 1] || group.primary_currency || "INR";
  var emailLink = rowData[EMAIL_LINK_COLUMN - 1];

  var txId = Utilities.getUuid();

  var nameOf = function (id) {
    var t = findTenantByChatId(id);
    return t && t.name ? t.name : id;
  };
  var payerName = nameOf(callerChatId);
  var targetName = nameOf(targetChatId);

  var notificationText =
    "🤝 *" +
    escapeMarkdown(payerName) +
    "* settled *" +
    currencySymbol(currency) +
    formatAmount(amount) +
    "* with *" +
    escapeMarkdown(targetName) +
    "*";

  var sendResp = sendTelegramMessage(group.chat_id, notificationText, {
    parse_mode: "Markdown",
    disable_web_page_preview: true
  });
  var groupMsgId = "";
  try {
    var parsed = JSON.parse(sendResp || "{}");
    if (parsed && parsed.result && parsed.result.message_id) {
      groupMsgId = String(parsed.result.message_id);
    }
  } catch (_) {}
  if (!groupMsgId) {
    sendTelegramMessage(dmChatId, "❌ *Couldn't post in the group.*");
    return;
  }

  var groupSheet = openGroupSheet(group.sheet_id);
  groupSheet.appendRow([
    emailDate,
    txDate,
    merchant,
    amount,
    currency,
    callerChatId,
    targetChatId,
    amount,
    txId,
    "Settlement",
    "Settlement",
    groupMsgId,
    emailLink
  ]);

  personalSheet.getRange(rowNumber, GROUP_REF_COLUMN).setValue(group.chat_id + ":" + txId);
  personalSheet.getRange(rowNumber, GROUP_MESSAGE_ID_COLUMN).setValue(groupMsgId);

  // Replace the DM card body with a settlement summary so the message text
  // actually matches the keyboard underneath it. The original card said
  // "🔴 <merchant> — <amount>" which is the *outgoing* payment — confusing
  // once it's been settled with someone.
  var settledDate = "";
  try {
    var rawDate = txDate || emailDate;
    if (rawDate instanceof Date) {
      settledDate = Utilities.formatDate(rawDate, Session.getScriptTimeZone(), "dd MMM yyyy");
    } else if (rawDate) {
      settledDate = String(rawDate);
    }
  } catch (_) {}
  var newBody =
    "🤝 *Settled " +
    currencySymbol(currency) +
    formatAmount(amount) +
    " with " +
    escapeMarkdown(targetName) +
    "*" +
    (settledDate ? "\n🗓 " + escapeMarkdown(settledDate) : "");

  // Same DM keyboard as gsp — undo wires through the same gun path.
  var newKb = buildPostSplitDMKeyboard(emailMessageId, merchant, category);
  sendTelegramMessage(dmChatId, newBody, {
    parse_mode: "Markdown",
    message_id: telegramMessageId,
    reply_markup: newKb
  });
}

// --- Step 5.1 group /stats: per-currency raw pairwise summary ---

// Pure helper. Walks every β row of a group sheet (excluding the header) and
// produces, per currency, the net amount each (debtor → creditor) pair owes
// after settlement netting.
//
// Input:
//   rows   — array of arrays (the values returned by getRange().getValues(),
//            EXCLUDING the header). Each row is the full G_COL_COUNT (13)
//            wide. May be empty.
//
// Output:
//   { <currency>: [ { debtor, creditor, amount } ... ] }
//   - Each pair appears at most once per currency, with `amount > 0` and
//     `debtor` being the member who net-owes.
//   - Rows where holder === payer are skipped (they paid for their own share).
//   - Rows where Category === "Settlement" subtract from what the payer owes
//     the holder (i.e. add to the holder's positive balance with payer).
//   - Empty input or fully-netted balances return an empty object.
//
// No Telegram, no Sheet, no global state — easy to unit-test.
function aggregatePairwiseDebts(rows) {
  // balances[currency][debtor][creditor] = amount debtor owes creditor.
  // We collapse to a single signed value per unordered pair at the end.
  var balances = {};
  for (var i = 0; i < (rows || []).length; i++) {
    var r = rows[i];
    if (!r || !r.length) continue;
    var currency = String(r[G_CURRENCY_COLUMN - 1] || "").trim();
    if (!currency) continue;
    var payer = String(r[G_PAID_BY_COLUMN - 1] || "").trim();
    var holder = String(r[G_SHARE_HOLDER_COLUMN - 1] || "").trim();
    var amt = Number(r[G_SHARE_AMOUNT_COLUMN - 1]);
    var category = String(r[G_CATEGORY_COLUMN - 1] || "").trim();
    if (!payer || !holder || !isFinite(amt) || amt <= 0) continue;
    if (payer === holder) continue; // self-share — not a debt

    if (!balances[currency]) balances[currency] = {};

    if (category === "Settlement") {
      // payer paid holder amt — REDUCE what payer owes holder.
      _bumpBalance(balances[currency], payer, holder, -amt);
    } else {
      // Normal split row: holder owes payer amt.
      _bumpBalance(balances[currency], holder, payer, amt);
    }
  }

  // Collapse: for each unordered pair (a, b), net = balance[a][b] - balance[b][a].
  // Emit one entry per pair with the signed result.
  var out = {};
  for (var ccy in balances) {
    if (!Object.prototype.hasOwnProperty.call(balances, ccy)) continue;
    var entries = [];
    var seen = {};
    var ledger = balances[ccy];
    for (var a in ledger) {
      if (!Object.prototype.hasOwnProperty.call(ledger, a)) continue;
      for (var b in ledger[a]) {
        if (!Object.prototype.hasOwnProperty.call(ledger[a], b)) continue;
        var key = a < b ? a + "|" + b : b + "|" + a;
        if (seen[key]) continue;
        seen[key] = true;
        var ab = (ledger[a] && ledger[a][b]) || 0;
        var ba = (ledger[b] && ledger[b][a]) || 0;
        var net = ab - ba;
        // Round to 2 dp to keep small floating residuals from displaying
        // (e.g. 99.99999 → 100.00). Drop near-zero pairs entirely.
        net = Math.round(net * 100) / 100;
        if (Math.abs(net) < 0.005) continue;
        if (net > 0) entries.push({ debtor: a, creditor: b, amount: net });
        else entries.push({ debtor: b, creditor: a, amount: -net });
      }
    }
    if (entries.length) {
      // Stable-ish ordering: largest amount first; ties by debtor then creditor.
      entries.sort(function (x, y) {
        if (y.amount !== x.amount) return y.amount - x.amount;
        if (x.debtor !== y.debtor) return x.debtor < y.debtor ? -1 : 1;
        return x.creditor < y.creditor ? -1 : 1;
      });
      out[ccy] = entries;
    }
  }
  return out;
}

function _bumpBalance(ledger, debtor, creditor, delta) {
  if (!ledger[debtor]) ledger[debtor] = {};
  ledger[debtor][creditor] = (ledger[debtor][creditor] || 0) + delta;
}

// Pure helper: collapse the pairwise output of aggregatePairwiseDebts into
// the minimum-ish set of payments using the greedy heuristic:
//
//   1. Per currency, compute net[p] = sum of incoming - sum of outgoing
//      across all pairwise entries. Sum across the group is exactly 0.
//   2. While any net is non-zero, pick the largest creditor (max positive)
//      and the largest debtor (max negative). Settle min(creditor, |debtor|)
//      between them — emit one payment, subtract from both. At least one
//      side zeroes out and drops.
//   3. Stop when all nets are within rounding noise (< 0.005).
//
// Produces ≤ N-1 entries per currency. Greedy is optimal whenever no proper
// subset of the group sums to zero (the common case for ≤4-person groups);
// the truly minimum-transactions problem is NP-hard but moot at this scale.
//
// Output shape matches aggregatePairwiseDebts: { ccy: [{debtor, creditor, amount}] }.
// Entries within a currency are sorted by amount desc, then by debtor/creditor
// chat_id for deterministic test output.
function simplifyDebtsGreedy(perCurrency) {
  var out = {};
  var currencies = Object.keys(perCurrency || {});
  for (var c = 0; c < currencies.length; c++) {
    var ccy = currencies[c];
    var entries = perCurrency[ccy] || [];
    // Build net[p] for this currency.
    var net = {};
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var amt = Number(e.amount) || 0;
      net[e.debtor] = (net[e.debtor] || 0) - amt;
      net[e.creditor] = (net[e.creditor] || 0) + amt;
    }

    var simplified = [];
    // Greedy match — bounded loop guard at N^2 to be defensive against
    // pathological floating-point residuals slipping past the < 0.005 cutoff.
    var people = Object.keys(net);
    var guard = people.length * people.length + 4;
    while (guard-- > 0) {
      var maxCreditor = null;
      var maxDebtor = null;
      var maxPos = 0;
      var maxNeg = 0;
      for (var p in net) {
        if (!Object.prototype.hasOwnProperty.call(net, p)) continue;
        if (net[p] > maxPos) {
          maxPos = net[p];
          maxCreditor = p;
        }
        if (net[p] < maxNeg) {
          maxNeg = net[p];
          maxDebtor = p;
        }
      }
      if (!maxCreditor || !maxDebtor) break;
      if (maxPos < 0.005 && -maxNeg < 0.005) break;
      var pay = Math.min(maxPos, -maxNeg);
      pay = Math.round(pay * 100) / 100;
      if (pay < 0.005) break;
      simplified.push({ debtor: maxDebtor, creditor: maxCreditor, amount: pay });
      net[maxCreditor] = Math.round((net[maxCreditor] - pay) * 100) / 100;
      net[maxDebtor] = Math.round((net[maxDebtor] + pay) * 100) / 100;
    }

    if (simplified.length) {
      simplified.sort(function (x, y) {
        if (y.amount !== x.amount) return y.amount - x.amount;
        if (x.debtor !== y.debtor) return x.debtor < y.debtor ? -1 : 1;
        return x.creditor < y.creditor ? -1 : 1;
      });
      out[ccy] = simplified;
    }
  }
  return out;
}

// Pure formatter. Renders the per-currency pairwise stats text.
// Inputs:
//   perCurrency — output of aggregatePairwiseDebts (or simplifyDebtsGreedy)
//   nameOf      — function(chat_id) → display name
//   groupName   — string for the header
//   simplified  — when true, header reads "simplified payments" and the
//                 row arrow uses → instead of "owes" (the entries are
//                 directed payments, not debt statements)
function formatGroupStats(perCurrency, nameOf, groupName, simplified) {
  var lines = [];
  var heading = simplified ? "— simplified payments" : "— who owes whom";
  lines.push("📊 *" + escapeMarkdown(groupName || "Group") + "* " + heading);
  var resolveName =
    nameOf ||
    function (id) {
      return String(id);
    };
  var currencies = Object.keys(perCurrency || {}).sort();
  if (!currencies.length) {
    lines.push("");
    lines.push("_All settled up — no outstanding balances._");
    return lines.join("\n");
  }
  for (var i = 0; i < currencies.length; i++) {
    var ccy = currencies[i];
    lines.push("");
    lines.push("*" + escapeMarkdown(ccy) + "*");
    var entries = perCurrency[ccy];
    for (var j = 0; j < entries.length; j++) {
      var e = entries[j];
      var debtorName = resolveName(e.debtor) || e.debtor;
      var creditorName = resolveName(e.creditor) || e.creditor;
      var verb = simplified ? " → " : " owes ";
      lines.push(
        "• " +
          escapeMarkdown(debtorName) +
          verb +
          escapeMarkdown(creditorName) +
          " " +
          ccy +
          " " +
          formatAmount(e.amount)
      );
    }
  }
  return lines.join("\n");
}

// /stats handler in group context. Reads every β row, nets debts per
// currency, posts the text. No-op (with a friendly nudge) if the group
// isn't provisioned.
function handleGroupStatsCommand(update) {
  var chatId = update.message.chat.id;
  var group = findGroupTenantByChatId(chatId);
  if (!group || group.status !== TENANT_STATUS.ACTIVE) {
    sendTelegramMessage(chatId, "👋 This group isn't set up yet. Promote me to admin and run `/start`.", {
      parse_mode: "Markdown"
    });
    return;
  }

  var sheet = openGroupSheet(group.sheet_id);
  var lastRow = sheet.getLastRow();
  var rows = [];
  if (lastRow > 1) {
    rows = sheet.getRange(2, 1, lastRow - 1, G_COL_COUNT).getValues();
  }
  var perCurrency = aggregatePairwiseDebts(rows);

  var nameOf = function (id) {
    var t = findTenantByChatId(id);
    return t && t.name ? t.name : id;
  };
  var text = formatGroupStats(perCurrency, nameOf, group.name);
  var hasDebts = Object.keys(perCurrency).length > 0;
  var opts = { parse_mode: "Markdown", disable_web_page_preview: true };
  if (hasDebts) opts.reply_markup = buildGroupStatsKeyboard("d");
  sendTelegramMessage(chatId, text, opts);
}

// Inline keyboard for the /stats reply. mode='d' shows the [🔀 Simplify]
// toggle; mode='s' shows [📋 Detailed] to flip back.
function buildGroupStatsKeyboard(mode) {
  if (mode === "s") {
    return {
      inline_keyboard: [[{ text: "📋 Detailed", callback_data: encodeGroupCallback("gstats", ["d"]) }]]
    };
  }
  return {
    inline_keyboard: [[{ text: "🔀 Simplify", callback_data: encodeGroupCallback("gstats", ["s"]) }]]
  };
}

// --- /settle shortcut command (group context) ---

// Pure parser. Accepts message text like "/settle @alice 500" or "/settle@bot @alice 500".
// Returns { mention, amount } on success, or { error: "syntax" | "amount" }.
// Mention may include or omit the leading @; amount must be a positive number
// (commas allowed as thousands separators).
function parseSettleCommand(text) {
  if (!text) return { error: "syntax" };
  // Strip the leading /settle and any optional @bot suffix (group commands
  // sometimes arrive as "/settle@DusAaneBot @alice 500").
  var stripped = String(text)
    .replace(/^\/settle(@\w+)?\s*/i, "")
    .trim();
  if (!stripped) return { error: "syntax" };
  var parts = stripped.split(/\s+/);
  if (parts.length < 2) return { error: "syntax" };
  var mentionTok = parts[0];
  // Allow letters, digits, dots and underscores (Telegram usernames + most
  // first-name forms). Strip a leading @ if present.
  if (!/^@?[A-Za-z0-9_.]+$/.test(mentionTok)) return { error: "syntax" };
  var mention = mentionTok.replace(/^@/, "");
  var rawAmt = parts[1].replace(/,/g, "");
  var amt = Number(rawAmt);
  if (!isFinite(amt) || amt <= 0) return { error: "amount" };
  amt = Math.round(amt * 100) / 100;
  return { mention: mention, amount: amt };
}

// Pure resolver. Walks group_members (excluding caller), asks `candidatesOf`
// for each member's known names (tenant.name + Telegram first_name + Telegram
// username — caller decides), and returns the unique chat_id whose candidate
// list contains the mention (case-insensitive exact match).
//
// Returns { chat_id } on unique match, or { error: "not_found" | "ambiguous" }.
function resolveMemberByMention(group, mention, callerChatId, candidatesOf) {
  var needle = String(mention || "")
    .trim()
    .toLowerCase();
  if (!needle) return { error: "not_found" };
  var hits = [];
  for (var i = 0; i < group.group_members.length; i++) {
    var m = group.group_members[i];
    if (m === String(callerChatId)) continue;
    var cands = candidatesOf(m) || [];
    var matched = false;
    for (var j = 0; j < cands.length && !matched; j++) {
      var c = cands[j];
      if (c && String(c).toLowerCase() === needle) matched = true;
    }
    if (matched && hits.indexOf(m) === -1) hits.push(m);
  }
  if (hits.length === 0) return { error: "not_found" };
  if (hits.length > 1) return { error: "ambiguous" };
  return { chat_id: hits[0] };
}

// /settle handler in group context. `/settle @alice 500` records a cash
// payment from the caller to @alice in the group sheet only — no personal
// sheet is touched (this is a manual entry, not derived from an email).
//
// The Settlement row reduces what caller owes target in subsequent /stats.
function handleGroupSettleCommand(update) {
  var chatId = update.message.chat.id;
  var messageText = (update.message && update.message.text) || "";
  var callerChatId = String(update.message.from && update.message.from.id);

  var group = findGroupTenantByChatId(chatId);
  if (!group || group.status !== TENANT_STATUS.ACTIVE) {
    sendTelegramMessage(chatId, "👋 This group isn't set up yet. Promote me to admin and run `/start`.", {
      parse_mode: "Markdown"
    });
    return;
  }
  if (group.group_members.indexOf(callerChatId) === -1) {
    sendTelegramMessage(chatId, "❌ You're not a member of this group.");
    return;
  }

  var parsed = parseSettleCommand(messageText);
  if (parsed.error === "syntax") {
    sendTelegramMessage(chatId, "Usage: `/settle @member <amount>`\nExample: `/settle @alice 500`", {
      parse_mode: "Markdown"
    });
    return;
  }
  if (parsed.error === "amount") {
    sendTelegramMessage(chatId, "❌ Amount must be a positive number.");
    return;
  }

  var nameOf = function (id) {
    var t = findTenantByChatId(id);
    return t && t.name ? t.name : "";
  };
  var candidatesOf = function (memberId) {
    var cands = [];
    var n = nameOf(memberId);
    if (n) cands.push(n);
    if (typeof getTelegramChatMemberInfo === "function") {
      var info = getTelegramChatMemberInfo(group.chat_id, memberId);
      if (info) {
        if (info.name) cands.push(info.name);
        if (info.username) cands.push(info.username);
      }
    }
    return cands;
  };
  var resolution = resolveMemberByMention(group, parsed.mention, callerChatId, candidatesOf);
  if (resolution.error === "not_found") {
    sendTelegramMessage(chatId, "❌ No group member matches `@" + escapeMarkdown(parsed.mention) + "`.", {
      parse_mode: "Markdown"
    });
    return;
  }
  if (resolution.error === "ambiguous") {
    sendTelegramMessage(
      chatId,
      "❌ `@" + escapeMarkdown(parsed.mention) + "` matches multiple members — try the exact first name.",
      { parse_mode: "Markdown" }
    );
    return;
  }
  var targetChatId = resolution.chat_id;

  // All checks passed — write Settlement row + post notification.
  var currency = group.primary_currency || "INR";
  var amount = parsed.amount;
  var txId = Utilities.getUuid();
  var now = new Date();

  var payerName = nameOf(callerChatId) || callerChatId;
  var targetName = nameOf(targetChatId) || targetChatId;

  var notificationText =
    "💸 *" +
    escapeMarkdown(payerName) +
    "* settled " +
    currency +
    " " +
    formatAmount(amount) +
    " with *" +
    escapeMarkdown(targetName) +
    "* _(cash)_";

  var sendResp = sendTelegramMessage(group.chat_id, notificationText, {
    parse_mode: "Markdown",
    disable_web_page_preview: true
  });
  var groupMsgId = "";
  try {
    var parsedResp = JSON.parse(sendResp || "{}");
    if (parsedResp && parsedResp.result && parsedResp.result.message_id) {
      groupMsgId = String(parsedResp.result.message_id);
    }
  } catch (_) {}
  if (!groupMsgId) {
    sendTelegramMessage(chatId, "❌ Couldn't post the settlement.");
    return;
  }

  var groupSheet = openGroupSheet(group.sheet_id);
  groupSheet.appendRow([
    now, // Email Date
    now, // Tx Date
    "Cash settlement", // Merchant
    amount, // Amount
    currency, // Currency
    callerChatId, // Paid By
    targetChatId, // Share Holder
    amount, // Share Amount
    txId, // Tx ID
    "Settlement", // Category
    "Settlement", // Tx Type
    groupMsgId, // Message ID
    "" // Email Link
  ]);
}
