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
    "• `/help` — this message\n\n" +
    "_Splitting expenses, settlements, and group analytics arrive in upcoming releases._";
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
  return head === "gnav" || head === "gsp" || head === "gset" || head === "gst" || head === "gbk" || head === "gun";
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
  var decoded = decodeGroupCallback(cb.data);
  if (!decoded) {
    answerCallbackQuery(cb.id, "❌ Bad callback", false);
    return;
  }
  if (decoded.action === "gnav") {
    // parts: [emailMessageId, groupChatId]
    var groupChatId = decoded.parts[1];
    var group = findGroupTenantByChatId(groupChatId);
    var name = group && group.name ? group.name : "the group";
    answerCallbackQuery(cb.id, "🚧 Split picker for " + name + " — wiring up in step 3.2", true);
    return;
  }
  // Other group actions (gsp, gset, gst, gbk, gun) ship in 3.2 / step 4.
  answerCallbackQuery(cb.id, "🚧 Coming in step 3.2", true);
}
