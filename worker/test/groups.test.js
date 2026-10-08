import { describe, it, expect } from "vitest";
import { loadAppsScript } from "../../tests/_loader.js";
import { testContext, seedTenant, seedGroup } from "./helpers/app.js";
import { handleUpdate } from "../src/app/webhook.js";
import { ingest } from "../src/app/ingest.js";
import { getTenant, getGroupMembers, takeGroupInvites } from "../src/db/tenants.js";
import { getSplitForTransaction, getSettlementForTransaction, groupBalances } from "../src/db/splits.js";
import { computeSplitShareSet, simplifyDebts, parseSettleCommand, formatBalancesPin } from "../src/app/groups.js";

const legacy = loadAppsScript(["Groups.js"], ["computeSplitShareSet", "simplifyDebtsGreedy", "parseSettleCommand"]);

const SMS = "Sent Rs.900.00 From HDFC Bank A/C *1234 To SWIGGY On 07/10/26 Ref 628012345678 Not You? Call 18002586161";

const tap = (data, { chat = 111, from = 111, messageId = 100 } = {}) => ({
  callback_query: { id: "cb", data, from: { id: from }, message: { chat: { id: chat }, message_id: messageId } }
});
const groupMsg = (text, from = 111, chat = -100) => ({
  message: { chat: { id: chat, type: "group", title: "Flat" }, from: { id: from, first_name: "U" + from }, text }
});
const sent = (ctx) => ctx.tg.of("sendMessage").map((c) => ({ chat: String(c.args[0]), text: c.args[1] }));

async function groupWithCard(members = ["111", "222"]) {
  const ctx = testContext();
  for (const id of members) await seedTenant(ctx, id);
  await seedGroup(ctx, "-100", members);
  const tenant = await getTenant(ctx.db, "111");
  const res = await ingest(ctx, { tenant, source: "sms", sourceRef: "s1", text: SMS });
  ctx.tg.calls.length = 0;
  return { ctx, id: res.transactionId };
}

describe("pure helpers match Groups.js", () => {
  const members = ["111", "222", "333", "444"];
  it.each([
    [["111", "222"], "50", 90001],
    [["111", "222"], "p100", 90000],
    [members, "all", 100000],
    [members, "w2", 100001],
    [members, "i3", 33333],
    [members, "w0", 100],
    [["111", "222", "333"], "50", 100],
    [members, "x1", 100]
  ])("computeSplitShareSet %j %s %d", (m, mode, minor) => {
    const want = legacy.computeSplitShareSet({ group_members: m }, "111", mode, minor / 100);
    const got = computeSplitShareSet(m, "111", mode, minor);
    if (!want) return expect(got).toBeNull();
    expect(got.holders).toEqual(want.holders);
    expect(got.shares.map((s) => s / 100)).toEqual(want.shares);
    expect(got.shares.reduce((a, b) => a + b, 0)).toBe(minor);
  });

  it("simplifyDebts", () => {
    const input = {
      INR: [
        { debtor: "a", creditor: "b", amountMinor: 30000 },
        { debtor: "b", creditor: "c", amountMinor: 30000 },
        { debtor: "c", creditor: "a", amountMinor: 5000 }
      ],
      USD: [{ debtor: "x", creditor: "y", amountMinor: 1050 }]
    };
    const asMajor = (o) =>
      Object.fromEntries(
        Object.entries(o).map(([k, v]) => [
          k,
          v.map((e) => ({ debtor: e.debtor, creditor: e.creditor, amount: e.amountMinor / 100 }))
        ])
      );
    expect(asMajor(simplifyDebts(input))).toEqual(legacy.simplifyDebtsGreedy(asMajor(input)));
    expect(simplifyDebts(input).INR).toEqual([{ debtor: "a", creditor: "c", amountMinor: 25000 }]);
  });

  it.each([
    "/settle @alice 500",
    "/settle@Bot alice 1,250.5",
    "/settle @alice",
    "/settle @alice -3",
    "/settle",
    "/settle <x> 5"
  ])("parseSettleCommand %s", (text) => {
    const want = legacy.parseSettleCommand(text);
    const got = parseSettleCommand(text);
    if (want.error) return expect(got).toEqual(want);
    expect(got).toEqual({ mention: want.mention, amountMinor: Math.round(want.amount * 100) });
  });

  it("pin caps currencies", () => {
    const per = {};
    for (const [c, a] of [
      ["INR", 5],
      ["USD", 4],
      ["EUR", 3],
      ["GBP", 2],
      ["AED", 1]
    ]) {
      per[c] = [{ debtor: "a", creditor: "b", amountMinor: a * 100 }];
    }
    const text = formatBalancesPin(per, (id) => id.toUpperCase(), "Flat");
    expect(text).toContain("• A → B: ₹5");
    expect(text).not.toContain("GBP");
    expect(text).toContain("_+2 more currencies (see /stats)_");
    expect(formatBalancesPin({}, String, "Flat")).toContain("All settled up");
  });
});

describe("group setup + membership", () => {
  it("/start needs the bot as admin, then creates the group and invites unregistered admins", async () => {
    const ctx = testContext();
    await seedTenant(ctx, "111");
    const admin = (id, extra = {}) => ({ user: { id, first_name: "N" + id, ...extra } });
    ctx.tg.getChatAdministrators = async () => [admin(111), admin(222)];
    await handleUpdate(ctx, groupMsg("/start"));
    expect(sent(ctx).at(-1).text).toContain("Make me an admin first");
    expect(await getTenant(ctx.db, "-100")).toBeNull();

    ctx.tg.getChatAdministrators = async () => [
      admin(111),
      admin(222),
      admin(999000, { is_bot: true }),
      admin(5, { is_bot: true })
    ];
    await handleUpdate(ctx, groupMsg("/start@dusaanebot"));
    expect(await getTenant(ctx.db, "-100")).toMatchObject({
      kind: "group",
      name: "Flat",
      status: "active",
      admin_id: "111"
    });
    expect(await getGroupMembers(ctx.db, "-100")).toEqual(["111"]);
    const msgs = sent(ctx);
    expect(msgs.find((m) => m.chat === "-100" && m.text.includes("is set up"))).toBeTruthy();
    expect(msgs.find((m) => m.chat === "222").text).toContain("/register");
    expect(await takeGroupInvites(ctx.db, "222")).toEqual(["-100"]);

    await handleUpdate(ctx, groupMsg("/start"));
    expect(
      sent(ctx)
        .filter((m) => m.chat === "-100")
        .at(-1).text
    ).toContain("Already set up");
  });

  it("tracks joins, leaves, the member cap, and bot removal", async () => {
    const ctx = testContext();
    for (const id of ["111", "222", "333", "444", "555"]) await seedTenant(ctx, id);
    await seedGroup(ctx, "-100", ["111", "222"]);
    const ev = (id, oldStatus, newStatus) => ({
      chat_member: {
        chat: { id: -100, type: "supergroup" },
        old_chat_member: { status: oldStatus, user: { id } },
        new_chat_member: { status: newStatus, user: { id, first_name: "N" + id } }
      }
    });
    await handleUpdate(ctx, ev(333, "left", "member"));
    await handleUpdate(ctx, ev(666, "left", "member"));
    expect(await getGroupMembers(ctx.db, "-100")).toEqual(["111", "222", "333"]);
    expect(await takeGroupInvites(ctx.db, "666")).toEqual(["-100"]);
    await handleUpdate(ctx, ev(444, "left", "member"));
    await handleUpdate(ctx, ev(555, "left", "member"));
    expect(await getGroupMembers(ctx.db, "-100")).toHaveLength(4);
    expect(sent(ctx).find((m) => m.chat === "111" && m.text.includes("member cap"))).toBeTruthy();

    await handleUpdate(ctx, ev(222, "member", "left"));
    expect(await getGroupMembers(ctx.db, "-100")).toEqual(["111", "333", "444"]);
    expect(sent(ctx).at(-1).text).toContain("left");

    await handleUpdate(ctx, {
      my_chat_member: {
        chat: { id: -100, type: "supergroup", title: "Flat" },
        old_chat_member: { status: "administrator" },
        new_chat_member: { status: "left" }
      }
    });
    expect((await getTenant(ctx.db, "-100")).status).toBe("disabled");
    await handleUpdate(ctx, groupMsg("/stats"));
    expect(sent(ctx).at(-1).text).toContain("isn't set up");
  });
});

describe("split / settle / undo from the DM card", () => {
  it("50-50 split posts to the group, pins balances and swaps the card", async () => {
    const { ctx, id } = await groupWithCard();
    await handleUpdate(ctx, tap("gnav:" + id + ":-100"));
    const kb = ctx.tg.of("editMessageReplyMarkup").at(-1).args[2].inline_keyboard;
    expect(kb.map((r) => r[0].callback_data)).toEqual([
      "gsp:" + id + ":-100:50",
      "gsp:" + id + ":-100:p100",
      "gset:" + id + ":-100",
      "gbk:" + id + ":-100:0"
    ]);

    await handleUpdate(ctx, tap("gsp:" + id + ":-100:50"));
    const split = await getSplitForTransaction(ctx.db, id);
    expect(split.shares).toEqual([
      { holder_id: "111", amount_minor: 45000 },
      { holder_id: "222", amount_minor: 45000 }
    ]);
    const groupPosts = sent(ctx).filter((m) => m.chat === "-100");
    expect(groupPosts[0].text).toContain("👤 *U111* paid");
    expect(groupPosts[0].text).toContain("U111 ₹450 · U222 ₹450");
    expect(groupPosts[1].text).toContain("• U222 → U111: ₹450");
    expect(ctx.tg.of("pinChatMessage")).toHaveLength(1);
    expect((await getTenant(ctx.db, "-100")).pin_message_id).toBe(String(ctx.tg.of("pinChatMessage")[0].args[1]));

    const [, , body, opts] = ctx.tg.of("editMessageText").at(-1).args;
    expect(body).toContain("👥 Split with *Flat*");
    expect(opts.reply_markup.inline_keyboard[0][0].callback_data).toBe("gun:" + id);

    await handleUpdate(ctx, tap("gsp:" + id + ":-100:50"));
    expect(sent(ctx).at(-1).text).toContain("Already split");
  });

  it("undo strikes the group post, deletes the split and refreshes the pin", async () => {
    const { ctx, id } = await groupWithCard();
    await handleUpdate(ctx, tap("gsp:" + id + ":-100:p100"));
    const pinId = Number((await getTenant(ctx.db, "-100")).pin_message_id);
    await handleUpdate(ctx, tap("gun:" + id));
    expect(await getSplitForTransaction(ctx.db, id)).toBeNull();
    const edits = ctx.tg.of("editMessageText").map((c) => c.args);
    expect(edits.find((a) => a[0] === "-100" && a[2].includes("split reverted"))).toBeTruthy();
    expect(edits.find((a) => a[0] === "-100" && a[1] === pinId && a[2].includes("All settled up"))).toBeTruthy();
    expect(edits.at(-1)[3].reply_markup.inline_keyboard[0][0].callback_data).toBe("gnav:" + id + ":-100");
  });

  it("undo keeps the split when the group post can't be edited", async () => {
    const { ctx, id } = await groupWithCard();
    await handleUpdate(ctx, tap("gsp:" + id + ":-100:50"));
    ctx.tg.editMessageText = async () => {
      throw new Error("message can't be edited");
    };
    await handleUpdate(ctx, tap("gun:" + id));
    expect(await getSplitForTransaction(ctx.db, id)).not.toBeNull();
    expect(sent(ctx).at(-1).text).toContain("older than 48h");
  });

  it("rolls the split back when the group post fails", async () => {
    const { ctx, id } = await groupWithCard();
    const send = ctx.tg.sendMessage;
    ctx.tg.sendMessage = async (chat, ...rest) => {
      if (String(chat) === "-100") throw new Error("bot was kicked");
      return send(chat, ...rest);
    };
    await handleUpdate(ctx, tap("gsp:" + id + ":-100:50"));
    expect(await getSplitForTransaction(ctx.db, id)).toBeNull();
    expect(sent(ctx).at(-1).text).toContain("Couldn't post in the group");
  });

  it("settle-up from a card records a settlement against the transaction", async () => {
    const { ctx, id } = await groupWithCard(["111", "222", "333"]);
    await handleUpdate(ctx, tap("gset:" + id + ":-100"));
    const kb = ctx.tg.of("editMessageReplyMarkup").at(-1).args[2].inline_keyboard;
    expect(kb.map((r) => r[0].callback_data)).toEqual([
      "gst:" + id + ":-100:1",
      "gst:" + id + ":-100:2",
      "gbk:" + id + ":-100:1"
    ]);

    await handleUpdate(ctx, tap("gst:" + id + ":-100:0"));
    expect(sent(ctx).at(-1).text).toContain("Can't settle with yourself");
    await handleUpdate(ctx, tap("gst:" + id + ":-100:2"));
    expect(await getSettlementForTransaction(ctx.db, id)).toMatchObject({
      from_id: "111",
      to_id: "333",
      amount_minor: 90000
    });
    expect(await groupBalances(ctx.db, "-100")).toEqual({
      INR: [{ debtor: "333", creditor: "111", amountMinor: 90000 }]
    });
    expect(ctx.tg.of("editMessageText").at(-1).args[2]).toContain("🤝 Settled with *U333*");

    await handleUpdate(ctx, tap("gun:" + id));
    expect(await getSettlementForTransaction(ctx.db, id)).toBeNull();
  });

  it("non-members can't split into the group", async () => {
    const { ctx, id } = await groupWithCard();
    await seedGroup(ctx, "-200", ["222"], "Other");
    await handleUpdate(ctx, tap("gsp:" + id + ":-200:50"));
    expect(sent(ctx).at(-1).text).toContain("not a member");
    expect(await getSplitForTransaction(ctx.db, id)).toBeNull();
  });
});

describe("group commands", () => {
  it("/settle, /stats and the simplify toggle", async () => {
    const ctx = testContext();
    for (const id of ["111", "222", "333"]) await seedTenant(ctx, id);
    await seedGroup(ctx, "-100", ["111", "222", "333"]);

    await handleUpdate(ctx, groupMsg("/settle @nobody 5"));
    expect(sent(ctx).at(-1).text).toContain("No group member matches");
    await handleUpdate(ctx, groupMsg("/settle @u222 300"));
    await handleUpdate(ctx, groupMsg("/settle u333 100", 222));
    expect(sent(ctx).find((m) => m.text.includes("settled INR 300 with *U222* _(cash)_"))).toBeTruthy();

    await handleUpdate(ctx, groupMsg("/stats"));
    const stats = ctx.tg.of("sendMessage").at(-1);
    expect(stats.args[1]).toContain("• U222 owes U111 INR 300");
    expect(stats.args[1]).toContain("• U333 owes U222 INR 100");
    expect(stats.args[2].reply_markup.inline_keyboard[0][0].callback_data).toBe("gstats:s");

    await handleUpdate(ctx, tap("gstats:s", { chat: -100, from: 222, messageId: 500 }));
    const view = ctx.tg.of("editMessageText").at(-1).args;
    expect(view[2]).toContain("simplified payments");
    expect(view[2]).toContain("• U222 → U111 INR 200");
    expect(view[2]).toContain("• U333 → U111 INR 100");

    await handleUpdate(ctx, groupMsg("/help"));
    expect(sent(ctx).at(-1).text).toContain("/settle @member");
    await handleUpdate(ctx, groupMsg("/account"));
    expect(sent(ctx).at(-1).text).toContain("Members (3/4): U111, U222, U333");
    await handleUpdate(ctx, groupMsg("/unknown"));
    expect(sent(ctx).at(-1).text).toContain("Members (3/4)");
  });
});
