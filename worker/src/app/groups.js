// Group chats: provisioning, membership, split / settle / undo from a DM
// card, group /stats with simplification, /settle cash payments, and the
// pinned live-balance message.
import {
  getTenant,
  createGroup,
  getGroupMembers,
  addGroupMember,
  removeGroupMember,
  setGroupMembers,
  setTenantStatus,
  setPinMessageId,
  addGroupInvite
} from "../db/tenants.js";
import {
  createSplit,
  deleteSplit,
  setSplitGroupMessage,
  recordSettlement,
  setSettlementGroupMessage,
  deleteSettlement,
  groupBalances
} from "../db/splits.js";
import { loadCardState, renderCard, defaultKeyboard } from "./cardState.js";
import { MAX_GROUP_MEMBERS } from "./constants.js";
import { escapeMarkdown, money, currencySymbol, formatAmount, shortCategoryName } from "./format.js";
import { isUsable } from "./onboarding.js";
import { fromMinor, toMinor } from "../util/money.js";

const NOT_SET_UP = "👋 This group isn't set up yet. Promote me to admin and run `/start`.";
const PIN_SKIP = "skip";
const PIN_CURRENCY_CAP = 3;
const IN_STATUSES = ["member", "administrator", "creator", "restricted"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function longDate(iso) {
  const [y, m, d] = iso.split("-");
  return d + " " + MONTHS[Number(m) - 1] + " " + y;
}

async function activeGroup(ctx, groupId) {
  const g = await getTenant(ctx.db, groupId);
  return g && g.kind === "group" && g.status === "active" ? g : null;
}

// Display name: tenant name, else Telegram first name/username, else id.
export async function memberName(ctx, groupId, id, cache = {}) {
  if (cache[id]) return cache[id];
  const t = await getTenant(ctx.db, id);
  let name = t && t.name;
  if (!name) {
    try {
      const m = await ctx.tg.getChatMember(groupId, id);
      name = m && m.user && (m.user.first_name || m.user.username);
    } catch (_) {}
  }
  cache[id] = name || String(id);
  return cache[id];
}

// ─── Pure helpers ────────────────────────────────────────────────────

// A member in callback data: "u<user id>", or a 0-based position on cards
// posted before the move to D1. null if they're no longer a member.
export function resolveMemberRef(members, ref) {
  const s = String(ref || "");
  if (/^u\d+$/.test(s)) return members.includes(s.slice(1)) ? s.slice(1) : null;
  if (/^\d+$/.test(s)) return members[parseInt(s, 10)] || null;
  return null;
}

// Share holders + amounts (minor units) for a split mode; null if invalid.
//   "50"   2-person 50/50          "p100" 2-person, the other owes 100%
//   "all"  everyone                "w<ref>" everyone except that member
//   "i<ref>" just payer + that member      (ref: see resolveMemberRef)
// holders[0] absorbs the rounding remainder so shares sum to the total.
export function computeSplitShareSet(members, payerId, mode, totalMinor) {
  const n = members.length;
  const payer = String(payerId);
  let holders = null;
  if (mode === "50" || mode === "p100") {
    if (n !== 2) return null;
    holders = mode === "50" ? members.slice() : members.filter((m) => m !== payer);
  } else if (mode === "all") {
    holders = members.slice();
  } else if (/^[wi]/.test(mode || "")) {
    const other = resolveMemberRef(members, mode.slice(1));
    if (!other || other === payer) return null;
    holders = mode[0] === "w" ? members.filter((m) => m !== other) : [payer, other];
  } else {
    return null;
  }
  if (!holders.length) return null;
  const k = holders.length;
  const per = Math.round(totalMinor / k);
  const shares = holders.map(() => per);
  shares[0] = totalMinor - per * (k - 1);
  return { holders, shares };
}

// Greedy minimum-ish payment set per currency (≤ N-1 payments).
export function simplifyDebts(perCurrency) {
  const out = {};
  for (const ccy of Object.keys(perCurrency || {})) {
    const net = {};
    for (const e of perCurrency[ccy]) {
      net[e.debtor] = (net[e.debtor] || 0) - e.amountMinor;
      net[e.creditor] = (net[e.creditor] || 0) + e.amountMinor;
    }
    const payments = [];
    for (let guard = Object.keys(net).length ** 2 + 4; guard > 0; guard--) {
      let creditor = null;
      let debtor = null;
      for (const p of Object.keys(net)) {
        if (net[p] > 0 && (!creditor || net[p] > net[creditor])) creditor = p;
        if (net[p] < 0 && (!debtor || net[p] < net[debtor])) debtor = p;
      }
      if (!creditor || !debtor) break;
      const pay = Math.min(net[creditor], -net[debtor]);
      payments.push({ debtor, creditor, amountMinor: pay });
      net[creditor] -= pay;
      net[debtor] += pay;
    }
    if (payments.length) {
      payments.sort(
        (x, y) =>
          y.amountMinor - x.amountMinor ||
          (x.debtor < y.debtor ? -1 : x.debtor > y.debtor ? 1 : x.creditor < y.creditor ? -1 : 1)
      );
      out[ccy] = payments;
    }
  }
  return out;
}

export function formatGroupStats(perCurrency, nameOf, groupName, simplified) {
  const lines = [
    "📊 *" + escapeMarkdown(groupName || "Group") + "* " + (simplified ? "— simplified payments" : "— who owes whom")
  ];
  const currencies = Object.keys(perCurrency || {}).sort();
  if (!currencies.length) return lines.concat("", "_All settled up — no outstanding balances._").join("\n");
  for (const ccy of currencies) {
    lines.push("", "*" + escapeMarkdown(ccy) + "*");
    for (const e of perCurrency[ccy]) {
      lines.push(
        "• " +
          escapeMarkdown(nameOf(e.debtor)) +
          (simplified ? " → " : " owes ") +
          escapeMarkdown(nameOf(e.creditor)) +
          " " +
          ccy +
          " " +
          formatAmount(fromMinor(e.amountMinor))
      );
    }
  }
  return lines.join("\n");
}

export function formatBalancesPin(perCurrency, nameOf, groupName) {
  const header = "📌 *" + escapeMarkdown(groupName || "Group") + "* — live balances";
  const ranked = Object.keys(perCurrency || {})
    .map((ccy) => ({ ccy, total: perCurrency[ccy].reduce((s, e) => s + e.amountMinor, 0) }))
    .sort((a, b) => b.total - a.total || (a.ccy < b.ccy ? -1 : 1));
  if (!ranked.length) return header + "\n\n✅ _All settled up._\n\n_Auto-updates after each split or settle._";
  const shown = ranked.slice(0, PIN_CURRENCY_CAP);
  const lines = [header, ""];
  shown.forEach(({ ccy }, i) => {
    lines.push("*" + escapeMarkdown(ccy) + "*");
    for (const e of perCurrency[ccy]) {
      lines.push(
        "• " +
          escapeMarkdown(nameOf(e.debtor)) +
          " → " +
          escapeMarkdown(nameOf(e.creditor)) +
          ": " +
          money(e.amountMinor, ccy)
      );
    }
    if (i < shown.length - 1) lines.push("");
  });
  const hidden = ranked.length - shown.length;
  if (hidden > 0) lines.push("", "_+" + hidden + " more currenc" + (hidden === 1 ? "y" : "ies") + " (see /stats)_");
  return lines.join("\n");
}

// "/settle @alice 500" → { mention, amountMinor } | { error: "syntax" | "amount" }
export function parseSettleCommand(text) {
  const stripped = String(text || "")
    .replace(/^\/settle(@\w+)?\s*/i, "")
    .trim();
  const parts = stripped.split(/\s+/);
  if (!stripped || parts.length < 2 || !/^@?[A-Za-z0-9_.]+$/.test(parts[0])) return { error: "syntax" };
  const amount = Number(parts[1].replace(/,/g, ""));
  if (!isFinite(amount) || amount <= 0) return { error: "amount" };
  return { mention: parts[0].replace(/^@/, ""), amountMinor: toMinor(amount) };
}

function splitNotification(txn, payerName, holders, shares, nameOf) {
  const amount = money(txn.amount_minor, txn.currency);
  const emoji = txn.direction === "debit" ? "🔴" : "🟢";
  const lines = [
    txn.merchant ? emoji + " *" + escapeMarkdown(txn.merchant) + "* — " + amount : emoji + " *" + amount + "*"
  ];
  const date = escapeMarkdown(longDate(txn.occurred_on));
  lines.push(txn.category ? "📂 " + escapeMarkdown(shortCategoryName(txn.category)) + " · " + date : "🗓 " + date);
  lines.push("👤 *" + escapeMarkdown(payerName) + "* paid");
  lines.push(
    "👥 " +
      holders
        .map(
          (h, i) => escapeMarkdown(nameOf(h)) + " " + currencySymbol(txn.currency) + formatAmount(fromMinor(shares[i]))
        )
        .join(" · ")
  );
  return lines.join("\n");
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Ledger operations (shared by card buttons and /ask) ─────────────

// Returns { ok: true, txn, holders, shares } or { ok: false, error }.
export async function splitTransaction(ctx, { payerId, txnId, groupId, mode }) {
  const payer = String(payerId);
  const group = await activeGroup(ctx, groupId);
  if (!group) return { ok: false, error: "Group is no longer active." };
  const members = await getGroupMembers(ctx.db, group.id);
  if (!members.includes(payer)) return { ok: false, error: "You're not a member of this group." };
  const state = await loadCardState(ctx, payer, txnId);
  if (!state || state.txn.status !== "confirmed") return { ok: false, error: "Transaction not found." };
  if (state.isSplit) return { ok: false, error: "Already split — undo first." };
  const set = computeSplitShareSet(members, payer, mode, state.txn.amount_minor);
  if (!set) return { ok: false, error: "Invalid split for this group." };

  // Claim the split in D1 first (one split per transaction), then post.
  let splitId;
  try {
    splitId = await createSplit(ctx.db, {
      transactionId: state.txn.id,
      groupId: group.id,
      payerId: payer,
      mode,
      shares: set.holders.map((h, i) => ({ holderId: h, amountMinor: set.shares[i] })),
      now: ctx.now()
    });
  } catch (e) {
    return {
      ok: false,
      error: /UNIQUE/.test(String(e && e.message)) ? "Already split — undo first." : "Split failed."
    };
  }
  const names = {};
  for (const id of [payer, ...set.holders]) names[id] = await memberName(ctx, group.id, id);
  let posted;
  try {
    posted = await ctx.tg.sendMessage(
      group.id,
      splitNotification(state.txn, names[payer], set.holders, set.shares, (id) => names[id]),
      { disable_web_page_preview: true }
    );
  } catch (e) {
    console.error("[split] group post failed:", e && e.message);
  }
  if (!posted || !posted.message_id) {
    await deleteSplit(ctx.db, group.id, splitId);
    return { ok: false, error: "Couldn't post in the group." };
  }
  await setSplitGroupMessage(ctx.db, splitId, posted.message_id);
  await refreshBalancesPin(ctx, group);
  return { ok: true, txn: state.txn, group, holders: set.holders, shares: set.shares };
}

export async function settleTransaction(ctx, { payerId, txnId, groupId, target: targetRef }) {
  const payer = String(payerId);
  const group = await activeGroup(ctx, groupId);
  if (!group) return { ok: false, error: "Group is no longer active." };
  const members = await getGroupMembers(ctx.db, group.id);
  if (!members.includes(payer)) return { ok: false, error: "You're not a member of this group." };
  const target = resolveMemberRef(members, targetRef);
  if (!target) return { ok: false, error: "That member is no longer in the group." };
  if (target === payer) return { ok: false, error: "Can't settle with yourself." };
  const state = await loadCardState(ctx, payer, txnId);
  if (!state || state.txn.status !== "confirmed") return { ok: false, error: "Transaction not found." };
  if (state.isSplit) return { ok: false, error: "Already split — undo first." };

  let settlementId;
  try {
    settlementId = await recordSettlement(ctx.db, {
      groupId: group.id,
      fromId: payer,
      toId: target,
      amountMinor: state.txn.amount_minor,
      currency: state.txn.currency,
      transactionId: state.txn.id,
      now: ctx.now()
    });
  } catch (e) {
    return {
      ok: false,
      error: /UNIQUE/.test(String(e && e.message)) ? "Already split — undo first." : "Settle failed."
    };
  }
  const [payerName, targetName] = [await memberName(ctx, group.id, payer), await memberName(ctx, group.id, target)];
  let posted;
  try {
    posted = await ctx.tg.sendMessage(
      group.id,
      "🤝 *" +
        escapeMarkdown(payerName) +
        "* settled *" +
        money(state.txn.amount_minor, state.txn.currency) +
        "* with *" +
        escapeMarkdown(targetName) +
        "*",
      { disable_web_page_preview: true }
    );
  } catch (e) {
    console.error("[settle] group post failed:", e && e.message);
  }
  if (!posted || !posted.message_id) {
    await deleteSettlement(ctx.db, group.id, settlementId);
    return { ok: false, error: "Couldn't post in the group." };
  }
  await setSettlementGroupMessage(ctx.db, settlementId, posted.message_id);
  await refreshBalancesPin(ctx, group);
  return { ok: true, txn: state.txn, group, targetName };
}

// Undo a split or settlement. Strikes through the group post first; if that
// edit fails (48h edit limit, bot removed) nothing is deleted.
export async function undoGroupLink(ctx, { payerId, txnId }) {
  const state = await loadCardState(ctx, payerId, txnId);
  if (!state) return { ok: false, error: "Transaction not found." };
  const link = state.split || state.settlement;
  if (!link) return { ok: false, error: "Not a group split." };
  const group = await getTenant(ctx.db, link.group_id);
  if (link.group_message_id) {
    try {
      await ctx.tg.editMessageText(
        link.group_id,
        link.group_message_id,
        "<s>✂️ " + escapeHtml(state.txn.merchant || "(transaction)") + " — split reverted</s>",
        { parse_mode: "HTML" }
      );
    } catch (e) {
      return { ok: false, error: "Couldn't edit the group message (older than 48h?). Nothing was changed." };
    }
  }
  if (state.split) await deleteSplit(ctx.db, link.group_id, link.id);
  else await deleteSettlement(ctx.db, link.group_id, link.id);
  if (group) await refreshBalancesPin(ctx, group);
  return { ok: true };
}

// ─── Live balance pin ────────────────────────────────────────────────

export async function refreshBalancesPin(ctx, group) {
  if (!group || group.status !== "active" || group.pin_message_id === PIN_SKIP) return;
  try {
    const names = {};
    for (const m of await getGroupMembers(ctx.db, group.id)) names[m] = await memberName(ctx, group.id, m);
    const text = formatBalancesPin(
      simplifyDebts(await groupBalances(ctx.db, group.id)),
      (id) => names[id] || id,
      group.name
    );
    if (group.pin_message_id) {
      try {
        await ctx.tg.editMessageText(group.id, Number(group.pin_message_id), text, { disable_web_page_preview: true });
        return;
      } catch (_) {
        // Pin deleted or stale — re-bootstrap below.
      }
    }
    const sent = await ctx.tg.sendMessage(group.id, text, { disable_web_page_preview: true });
    if (!sent || !sent.message_id) return;
    try {
      await ctx.tg.pinChatMessage(group.id, sent.message_id, true);
      await setPinMessageId(ctx.db, group.id, sent.message_id);
    } catch (_) {
      await setPinMessageId(ctx.db, group.id, PIN_SKIP);
      await ctx.tg.sendMessage(
        group.id,
        "ℹ️ *Couldn't pin the live balance.* Promote me to admin with _Pin messages_ permission and the next split will set it up."
      );
      if (group.admin_id) {
        await ctx.tg.sendMessage(
          group.admin_id,
          "ℹ️ *" +
            escapeMarkdown(group.name || "Your group") +
            "*: I tried to pin a live balance message but don't have permission. Promote me to admin with _Pin messages_ in the group, then trigger any split/settle to retry."
        );
      }
    }
  } catch (e) {
    console.error("[pin] refresh failed:", e && e.message);
  }
}

// ─── DM card callbacks (":"-separated) ───────────────────────────────

async function level1Keyboard(ctx, group, payerId, txnId) {
  const members = await getGroupMembers(ctx.db, group.id);
  const others = [];
  for (const m of members) if (m !== String(payerId)) others.push({ id: m, label: await memberName(ctx, group.id, m) });
  const n = others.length + 1;
  const cb = (...p) => p.join(":");
  const rows = [];
  if (n === 2) {
    rows.push([{ text: "👥 50-50 with " + others[0].label, callback_data: cb("gsp", txnId, group.id, "50") }]);
    rows.push([{ text: "💝 " + others[0].label + " owes 100%", callback_data: cb("gsp", txnId, group.id, "p100") }]);
  } else if (n >= 3) {
    rows.push([{ text: "👥 All " + n, callback_data: cb("gsp", txnId, group.id, "all") }]);
    rows.push(
      others.map((o) => ({ text: "➖ Without " + o.label, callback_data: cb("gsp", txnId, group.id, "wu" + o.id) }))
    );
    if (n === 4) {
      rows.push(
        others.map((o) => ({ text: "👥 With " + o.label, callback_data: cb("gsp", txnId, group.id, "iu" + o.id) }))
      );
    }
  }
  rows.push([{ text: "🤝 Settle up ▾", callback_data: cb("gset", txnId, group.id) }]);
  rows.push([{ text: "← Back", callback_data: cb("gbk", txnId, group.id, "0") }]);
  return { inline_keyboard: rows };
}

async function level2Keyboard(ctx, group, payerId, txnId) {
  const members = await getGroupMembers(ctx.db, group.id);
  const rows = [];
  for (const m of members) {
    if (m === String(payerId)) continue;
    rows.push([
      {
        text: "→ " + (await memberName(ctx, group.id, m)),
        callback_data: ["gst", txnId, group.id, "u" + m].join(":")
      }
    ]);
  }
  rows.push([{ text: "← Back", callback_data: ["gbk", txnId, group.id, "1"].join(":") }]);
  return { inline_keyboard: rows };
}

export function isGroupCallback(data) {
  return /^(gnav|gsp|gset|gst|gbk|gun|gstats):/.test(String(data || ""));
}

export async function handleGroupCallback(ctx, cb) {
  const [action, ...parts] = String(cb.data).split(":");
  const chatId = String(cb.message.chat.id);
  const messageId = cb.message.message_id;
  const caller = String(cb.from.id);

  if (action === "gstats") return groupStatsView(ctx, chatId, caller, parts[0] === "s" ? "s" : "d", messageId);

  const txnId = parts[0];
  const refreshCard = async () => {
    const state = await loadCardState(ctx, chatId, txnId);
    if (state)
      await ctx.tg.editMessageText(chatId, messageId, renderCard(state), { reply_markup: defaultKeyboard(state) });
  };
  const fail = (error) => ctx.tg.sendMessage(chatId, "❌ *" + escapeMarkdown(error) + "*");

  if (action === "gnav" || action === "gset" || (action === "gbk" && parts[2] === "1")) {
    const group = await activeGroup(ctx, parts[1]);
    if (!group) return fail("Group is no longer active.");
    if (!(await getGroupMembers(ctx.db, group.id)).includes(caller)) return fail("You're not a member of this group.");
    const kb =
      action === "gset"
        ? await level2Keyboard(ctx, group, caller, txnId)
        : await level1Keyboard(ctx, group, caller, txnId);
    return ctx.tg.editMessageReplyMarkup(chatId, messageId, kb);
  }
  if (action === "gbk") {
    const state = await loadCardState(ctx, chatId, txnId);
    if (state) await ctx.tg.editMessageReplyMarkup(chatId, messageId, defaultKeyboard(state));
    return;
  }
  if (action === "gsp") {
    const res = await splitTransaction(ctx, { payerId: caller, txnId, groupId: parts[1], mode: parts[2] });
    return res.ok ? refreshCard() : fail(res.error);
  }
  if (action === "gst") {
    const res = await settleTransaction(ctx, { payerId: caller, txnId, groupId: parts[1], target: parts[2] });
    return res.ok ? refreshCard() : fail(res.error);
  }
  if (action === "gun") {
    const res = await undoGroupLink(ctx, { payerId: caller, txnId });
    if (!res.ok) return ctx.tg.sendMessage(chatId, "⚠️ *" + escapeMarkdown(res.error) + "*");
    return refreshCard();
  }
}

// ─── Group commands ──────────────────────────────────────────────────

async function requireGroup(ctx, chatId) {
  const group = await activeGroup(ctx, chatId);
  if (!group) await ctx.tg.sendMessage(chatId, NOT_SET_UP);
  return group;
}

async function groupStatsView(ctx, groupId, caller, mode, messageId) {
  const group = await requireGroup(ctx, groupId);
  if (!group) return;
  const members = await getGroupMembers(ctx.db, group.id);
  if (messageId && !members.includes(caller)) {
    await ctx.tg.sendMessage(groupId, "❌ *You're not a member of this group.*");
    return;
  }
  const detailed = await groupBalances(ctx.db, group.id);
  const data = mode === "s" ? simplifyDebts(detailed) : detailed;
  const names = {};
  for (const id of new Set(
    Object.values(detailed)
      .flat()
      .flatMap((e) => [e.debtor, e.creditor])
  )) {
    names[id] = await memberName(ctx, group.id, id);
  }
  const text = formatGroupStats(data, (id) => names[id] || id, group.name, mode === "s");
  const opts = { disable_web_page_preview: true };
  if (Object.keys(detailed).length) {
    opts.reply_markup = {
      inline_keyboard: [
        [
          mode === "s"
            ? { text: "📋 Detailed", callback_data: "gstats:d" }
            : { text: "🔀 Simplify", callback_data: "gstats:s" }
        ]
      ]
    };
  }
  if (messageId) await ctx.tg.editMessageText(groupId, messageId, text, opts);
  else await ctx.tg.sendMessage(groupId, text, opts);
}

export async function handleGroupStart(ctx, m) {
  const chatId = m.chatId;
  const chat = m.raw.chat;
  const groupName = chat.title || "Group";
  let me;
  let admins;
  try {
    me = await ctx.tg.getMe();
    admins = await ctx.tg.getChatAdministrators(chatId);
  } catch (e) {
    await ctx.tg.sendMessage(
      chatId,
      "⚠️ I couldn't read this group's admin list. Make sure I have access and try `/start` again."
    );
    return;
  }
  const registered = [];
  const unregistered = [];
  let botPresent = false;
  for (const a of admins || []) {
    if (!a || !a.user) continue;
    const uid = String(a.user.id);
    if (me && uid === String(me.id)) {
      botPresent = true;
      continue;
    }
    if (a.user.is_bot) continue;
    const name = a.user.first_name || a.user.username || uid;
    const t = await getTenant(ctx.db, uid);
    (isUsable(t) && t.kind === "personal" ? registered : unregistered).push({ id: uid, name });
  }
  if (!botPresent) {
    await ctx.tg.sendMessage(
      chatId,
      "🔒 *Make me an admin first.*\n\nI need admin rights so I can detect members joining and leaving. Open the group settings, promote me to admin, then send `/start` again.\n\n_Default admin permissions are fine — I don't need to delete messages or ban users._"
    );
    return;
  }
  if (registered.length + unregistered.length > MAX_GROUP_MEMBERS) {
    await ctx.tg.sendMessage(
      chatId,
      "🚧 *Too many admins.*\n\nDus Aane Bot supports up to " +
        MAX_GROUP_MEMBERS +
        " members per group. Demote some admins (or remove them from the group) and try `/start` again."
    );
    return;
  }
  const existing = await getTenant(ctx.db, chatId);
  let prefix = "";
  if (existing && existing.kind === "group") {
    // Re-sync: add registered admins, keep members who joined since.
    const current = await getGroupMembers(ctx.db, chatId);
    const merged = [...current, ...registered.map((r) => r.id).filter((id) => !current.includes(id))].slice(
      0,
      MAX_GROUP_MEMBERS
    );
    await setGroupMembers(ctx.db, chatId, merged, ctx.now());
    if (existing.status !== "active") await setTenantStatus(ctx.db, chatId, "active");
    prefix = "🔄 Already set up — re-synced member list.\n\n";
  } else {
    await createGroup(ctx.db, {
      id: chatId,
      name: groupName,
      adminId: m.userId,
      members: registered.map((r) => r.id),
      now: ctx.now()
    });
  }
  const total = registered.length + unregistered.length;
  const lines = [
    "✅ *" + escapeMarkdown((existing && existing.name) || groupName) + "* is set up!",
    registered.length + " of " + total + " admin" + (total === 1 ? "" : "s") + " ready to split."
  ];
  if (registered.length) lines.push("", "*Ready:* " + registered.map((r) => escapeMarkdown(r.name)).join(", "));
  if (unregistered.length) {
    lines.push(
      "",
      "*Need to register:* " +
        unregistered.map((r) => escapeMarkdown(r.name)).join(", ") +
        " — DM me `/register` first."
    );
  }
  await ctx.tg.sendMessage(chatId, prefix + lines.join("\n"), { disable_web_page_preview: true });
  for (const u of unregistered) {
    await addGroupInvite(ctx.db, u.id, chatId, ctx.now());
    try {
      await ctx.tg.sendMessage(
        u.id,
        "👋 You've been added to *" +
          escapeMarkdown(groupName) +
          "* on Dus Aane Bot.\n\nTo start splitting expenses, send me `/register your.email@gmail.com` here in DM."
      );
    } catch (_) {}
  }
}

export async function handleGroupHelp(ctx, m) {
  if (!(await requireGroup(ctx, m.chatId))) return;
  await ctx.tg.sendMessage(
    m.chatId,
    "*Group commands*\n" +
      "• `/start` — re-sync the member list from this chat\n" +
      "• `/account` — show this group's setup\n" +
      "• `/stats` — who owes whom (per currency)\n" +
      "• `/settle @member <amount>` — record a cash payment to a member\n" +
      "• `/help` — this message\n\n" +
      "_Email-based settlements: forward the UPI confirmation in DM, tap_ 👥 *Split with <group>* _→_ 🤝 *Settle up* _→ recipient._"
  );
}

export async function handleGroupAccount(ctx, m) {
  const group = await requireGroup(ctx, m.chatId);
  if (!group) return;
  const members = await getGroupMembers(ctx.db, group.id);
  const labels = [];
  for (const id of members) labels.push(escapeMarkdown(await memberName(ctx, group.id, id)));
  const lines = [
    "*" + escapeMarkdown(group.name || "Group") + "*",
    "Status: `" + group.status + "`",
    "Currency: `" + group.primary_currency + "`",
    "Members (" + members.length + "/" + MAX_GROUP_MEMBERS + "): " + (labels.length ? labels.join(", ") : "_none yet_")
  ];
  if (group.admin_id) lines.push("Admin: " + escapeMarkdown(await memberName(ctx, group.id, group.admin_id)));
  await ctx.tg.sendMessage(m.chatId, lines.join("\n"), { disable_web_page_preview: true });
}

export async function handleGroupSheet(ctx, m) {
  if (!(await requireGroup(ctx, m.chatId))) return;
  await ctx.tg.sendMessage(
    m.chatId,
    "📋 Group balances now live with the bot — see /stats or the pinned live-balance message.",
    {
      parse_mode: null
    }
  );
}

export async function handleGroupStats(ctx, m) {
  await groupStatsView(ctx, m.chatId, m.userId, "d", null);
}

export async function handleGroupSettle(ctx, m) {
  const group = await requireGroup(ctx, m.chatId);
  if (!group) return;
  const members = await getGroupMembers(ctx.db, group.id);
  if (!members.includes(m.userId)) {
    await ctx.tg.sendMessage(m.chatId, "❌ You're not a member of this group.", { parse_mode: null });
    return;
  }
  const parsed = parseSettleCommand(m.text);
  if (parsed.error === "syntax") {
    await ctx.tg.sendMessage(m.chatId, "Usage: `/settle @member <amount>`\nExample: `/settle @alice 500`");
    return;
  }
  if (parsed.error === "amount") {
    await ctx.tg.sendMessage(m.chatId, "❌ Amount must be a positive number.", { parse_mode: null });
    return;
  }
  const needle = parsed.mention.toLowerCase();
  const hits = [];
  for (const id of members) {
    if (id === m.userId) continue;
    const cands = [];
    const t = await getTenant(ctx.db, id);
    if (t && t.name) cands.push(t.name);
    try {
      const cm = await ctx.tg.getChatMember(group.id, id);
      if (cm && cm.user) cands.push(cm.user.first_name, cm.user.username);
    } catch (_) {}
    if (cands.some((c) => c && String(c).toLowerCase() === needle)) hits.push(id);
  }
  if (hits.length !== 1) {
    await ctx.tg.sendMessage(
      m.chatId,
      hits.length
        ? "❌ `@" + escapeMarkdown(parsed.mention) + "` matches multiple members — try the exact first name."
        : "❌ No group member matches `@" + escapeMarkdown(parsed.mention) + "`."
    );
    return;
  }
  const target = hits[0];
  const currency = group.primary_currency || "INR";
  const payerName = await memberName(ctx, group.id, m.userId);
  const targetName = await memberName(ctx, group.id, target);
  let posted;
  try {
    posted = await ctx.tg.sendMessage(
      group.id,
      "💸 *" +
        escapeMarkdown(payerName) +
        "* settled " +
        currency +
        " " +
        formatAmount(fromMinor(parsed.amountMinor)) +
        " with *" +
        escapeMarkdown(targetName) +
        "* _(cash)_",
      { disable_web_page_preview: true }
    );
  } catch (_) {}
  if (!posted || !posted.message_id) {
    await ctx.tg.sendMessage(m.chatId, "❌ Couldn't post the settlement.", { parse_mode: null });
    return;
  }
  await recordSettlement(ctx.db, {
    groupId: group.id,
    fromId: m.userId,
    toId: target,
    amountMinor: parsed.amountMinor,
    currency,
    groupMessageId: posted.message_id,
    now: ctx.now()
  });
  await refreshBalancesPin(ctx, group);
}

// ─── Membership events ───────────────────────────────────────────────

export async function handleMembershipUpdate(ctx, update) {
  if (update.my_chat_member) return botMembershipChanged(ctx, update.my_chat_member);
  if (update.chat_member) return memberChanged(ctx, update.chat_member);
}

async function botMembershipChanged(ctx, ev) {
  if (!ev.chat || (ev.chat.type !== "group" && ev.chat.type !== "supergroup")) return;
  const oldStatus = ev.old_chat_member && ev.old_chat_member.status;
  const newStatus = ev.new_chat_member && ev.new_chat_member.status;
  const wasOut = !oldStatus || oldStatus === "left" || oldStatus === "kicked";
  const isIn = newStatus === "member" || newStatus === "administrator";
  const chatId = String(ev.chat.id);
  if (wasOut && isIn) {
    await ctx.tg.sendMessage(
      chatId,
      "👋 Hey! I'm *Dus Aane Bot* — track shared expenses by forwarding bank emails.\n\nTo set up *" +
        escapeMarkdown(ev.chat.title || "this group") +
        "* as a shared expense group:\n1. Promote me to admin (default permissions are fine).\n2. Send `/start` here."
    );
    return;
  }
  if (!isIn && !wasOut) {
    const group = await getTenant(ctx.db, chatId);
    if (!group || group.kind !== "group") return;
    await setTenantStatus(ctx.db, chatId, "disabled");
    if (group.admin_id) {
      try {
        await ctx.tg.sendMessage(
          group.admin_id,
          "ℹ️ I was removed from *" +
            escapeMarkdown(group.name || "your group") +
            "*. Balances are preserved — re-add me and run `/start` to reactivate."
        );
      } catch (_) {}
    }
  }
}

async function memberChanged(ctx, ev) {
  if (!ev.chat || (ev.chat.type !== "group" && ev.chat.type !== "supergroup")) return;
  const group = await activeGroup(ctx, ev.chat.id);
  const user = ev.new_chat_member && ev.new_chat_member.user;
  if (!group || !user || user.is_bot) return;
  const wasIn = IN_STATUSES.includes(ev.old_chat_member && ev.old_chat_member.status);
  const isIn = IN_STATUSES.includes(ev.new_chat_member && ev.new_chat_member.status);
  const uid = String(user.id);
  const name = escapeMarkdown(user.first_name || user.username || uid);
  const members = await getGroupMembers(ctx.db, group.id);

  if (!wasIn && isIn) {
    if (members.includes(uid)) return;
    if (members.length >= MAX_GROUP_MEMBERS) {
      if (group.admin_id) {
        await ctx.tg.sendMessage(
          group.admin_id,
          "⚠️ *" +
            name +
            "* joined *" +
            escapeMarkdown(group.name || "your group") +
            "* but it's already at the " +
            MAX_GROUP_MEMBERS +
            "-member cap. They won't be included in splits until you remove someone."
        );
      }
      return;
    }
    const personal = await getTenant(ctx.db, uid);
    if (isUsable(personal) && personal.kind === "personal") {
      await addGroupMember(ctx.db, group.id, uid, ctx.now());
      await ctx.tg.sendMessage(group.id, "👋 *" + name + "* joined the splits.");
    } else {
      await addGroupInvite(ctx.db, uid, group.id, ctx.now());
      try {
        await ctx.tg.sendMessage(
          uid,
          "👋 You've been added to *" +
            escapeMarkdown(group.name || "a group") +
            "* on Dus Aane Bot.\n\nSend me `/register your.email@gmail.com` here in DM to start splitting expenses with the group."
        );
      } catch (_) {}
    }
    return;
  }
  if (wasIn && !isIn && (await removeGroupMember(ctx.db, group.id, uid))) {
    await ctx.tg.sendMessage(group.id, "👋 *" + name + "* left. Their share of past splits stays on record.");
  }
}
