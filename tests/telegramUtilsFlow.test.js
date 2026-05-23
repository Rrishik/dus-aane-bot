// Coverage tests for TelegramUtils.js. Drives every payload-shaping function +
// the sendRequest retry/error/no-op-edit logic by stubbing UrlFetchApp.fetch.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadAppsScript } from "./_loader.js";

const SYMBOLS = [
  "deleteWebhook",
  "setTelegramWebhook",
  "setTelegramCommands",
  "sendTelegramMessage",
  "answerCallbackQuery",
  "deleteTelegramMessage",
  "editTelegramReplyMarkup",
  "sendChatAction",
  "getTelegramChat",
  "getTelegramChatAdministrators",
  "getTelegramChatMemberInfo",
  "getTelegramChatMemberName",
  "getTelegramBotUserId",
  "sendRequest",
  "buildReplyMarkup",
  "buildCategoryKeyboard",
  "buildHelpMenuKeyboard",
  "buildDeleteConfirmKeyboard",
  "getTransactionMessageAsString",
  "pillLabel",
  "sendTransactionMessage",
  "escapeMarkdown"
];

function makeResponse(code, body) {
  return {
    getResponseCode: () => code,
    getContentText: () => (typeof body === "string" ? body : JSON.stringify(body || {}))
  };
}

function makeProps(initial) {
  var store = Object.assign({}, initial || {});
  return {
    store: store,
    api: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in store ? store[k] : null),
        setProperty: (k, v) => {
          store[k] = String(v);
        }
      })
    }
  };
}

function baseStubs(overrides) {
  var props = makeProps();
  var fetchCalls = [];
  // The default fetch stub returns a 200 with `{ok:true,result:{}}`. Tests
  // that need different behaviour pass their own `UrlFetchApp` override.
  var defaultFetch = vi.fn((url, opts) => {
    fetchCalls.push({ url: url, opts: opts });
    return makeResponse(200, { ok: true, result: {} });
  });
  var stubs = Object.assign(
    {
      // URL constants referenced by the wrappers.
      BOT_DELETE_WEBHOOK_URL: "https://api/deleteWebhook",
      WORKER_PROXY_URL: "https://proxy/",
      BOT_SET_WEBHOOK_URL: "https://api/setWebhook",
      BOT_SET_COMMANDS_URL: "https://api/setMyCommands",
      BOT_SEND_MESSAGE_URL: "https://api/sendMessage",
      BOT_EDIT_MESSAGE_URL: "https://api/editMessageText",
      BOT_ANSWER_CALLBACK_QUERY_URL: "https://api/answerCallbackQuery",
      BOT_DELETE_MESSAGE_URL: "https://api/deleteMessage",
      BOT_EDIT_REPLY_MARKUP_URL: "https://api/editMessageReplyMarkup",
      BOT_SEND_CHAT_ACTION_URL: "https://api/sendChatAction",
      BOT_GET_CHAT_URL: "https://api/getChat",
      BOT_GET_CHAT_ADMINISTRATORS_URL: "https://api/getChatAdministrators",
      BOT_GET_CHAT_MEMBER_URL: "https://api/getChatMember",
      BOT_GET_ME_URL: "https://api/getMe",
      // Domain constants for buildCategoryKeyboard.
      CATEGORIES: ["Shopping", "Groceries", "Food & Dining", "Healthcare"],
      CATEGORY_EMOJIS: { Shopping: "🛍️", Groceries: "🛒", "Food & Dining": "🍔", Healthcare: "🩺" },
      // Cross-module helpers used by sendTransactionMessage + getTransactionMessageAsString.
      currencySymbol: (c) => (c === "USD" ? "$" : "₹"),
      formatAmount: (n) => Number(n).toFixed(2),
      isDebit: (t) => String(t || "").toLowerCase() === "debit",
      shortCategoryName: (c) => c || "",
      getTenantChatId: () => "111",
      buildGroupParentButtonRows: () => [],
      // Apps-Script-isms.
      UrlFetchApp: { fetch: defaultFetch },
      Utilities: {
        sleep: vi.fn(),
        formatDate: (d, _tz, fmt) => "FMT(" + d.toISOString() + "," + fmt + ")"
      },
      Session: { getScriptTimeZone: () => "UTC" },
      PropertiesService: props.api,
      console: { log: () => {}, warn: () => {}, error: () => {} }
    },
    overrides || {}
  );
  return { stubs: stubs, props: props, fetchCalls: fetchCalls };
}

function load(stubs) {
  return loadAppsScript(["TelegramUtils.js"], SYMBOLS, stubs);
}

// Helper to pull the parsed payload off a UrlFetchApp.fetch call.
function payloadOf(call) {
  return JSON.parse(call[1].payload);
}

// ── Simple wrappers ────────────────────────────────────────────────────────

describe("simple Telegram wrappers", () => {
  it("deleteWebhook posts to BOT_DELETE_WEBHOOK_URL with an empty payload", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    api.deleteWebhook();
    expect(env.stubs.UrlFetchApp.fetch).toHaveBeenCalledTimes(1);
    var call = env.stubs.UrlFetchApp.fetch.mock.calls[0];
    expect(call[0]).toBe("https://api/deleteWebhook");
    expect(call[1].method).toBe("post");
    expect(payloadOf(call)).toEqual({});
  });

  it("setTelegramWebhook deletes then sets, passing allowed_updates including chat_member events", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    api.setTelegramWebhook();

    var calls = env.stubs.UrlFetchApp.fetch.mock.calls;
    expect(calls.map((c) => c[0])).toEqual(["https://api/deleteWebhook", "https://api/setWebhook"]);
    var payload = payloadOf(calls[1]);
    expect(payload.url).toBe("https://proxy/");
    expect(payload.allowed_updates).toContain("my_chat_member");
    expect(payload.allowed_updates).toContain("chat_member");
  });

  it("setTelegramCommands registers separate command lists for private vs group scopes", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    api.setTelegramCommands();

    var calls = env.stubs.UrlFetchApp.fetch.mock.calls;
    expect(calls).toHaveLength(2);
    var personal = payloadOf(calls[0]);
    var group = payloadOf(calls[1]);
    expect(personal.scope.type).toBe("all_private_chats");
    expect(group.scope.type).toBe("all_group_chats");
    expect(personal.commands.find((c) => c.command === "/ask")).toBeTruthy();
    expect(group.commands.find((c) => c.command === "/ask")).toBeUndefined();
  });

  it("sendTelegramMessage hits sendMessage and returns the response body text", () => {
    var env = baseStubs({
      UrlFetchApp: { fetch: vi.fn(() => makeResponse(200, { ok: true, result: { message_id: 42 } })) }
    });
    var api = load(env.stubs);
    var out = api.sendTelegramMessage("111", "hi");

    var call = env.stubs.UrlFetchApp.fetch.mock.calls[0];
    expect(call[0]).toBe("https://api/sendMessage");
    var p = payloadOf(call);
    expect(p).toEqual({
      chat_id: "111",
      text: "hi",
      parse_mode: "Markdown"
    });
    expect(JSON.parse(out)).toEqual({ ok: true, result: { message_id: 42 } });
  });

  it("sendTelegramMessage routes to editMessageText when options.message_id is present + serializes reply_markup", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    api.sendTelegramMessage("111", "hi", {
      message_id: 7,
      reply_markup: { inline_keyboard: [[{ text: "x", callback_data: "y" }]] },
      parse_mode: "HTML"
    });

    var call = env.stubs.UrlFetchApp.fetch.mock.calls[0];
    expect(call[0]).toBe("https://api/editMessageText");
    var p = payloadOf(call);
    expect(p.message_id).toBe(7);
    expect(p.parse_mode).toBe("HTML");
    expect(JSON.parse(p.reply_markup).inline_keyboard).toBeInstanceOf(Array);
  });

  it("answerCallbackQuery sends id + text + show_alert", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    api.answerCallbackQuery("cb-1", "Done", true);

    var p = payloadOf(env.stubs.UrlFetchApp.fetch.mock.calls[0]);
    expect(p).toEqual({ callback_query_id: "cb-1", text: "Done", show_alert: true });
  });

  it("deleteTelegramMessage sends chat_id + message_id to deleteMessage endpoint", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    api.deleteTelegramMessage("111", 7);

    var call = env.stubs.UrlFetchApp.fetch.mock.calls[0];
    expect(call[0]).toBe("https://api/deleteMessage");
    expect(payloadOf(call)).toEqual({ chat_id: "111", message_id: 7 });
  });

  it("editTelegramReplyMarkup posts serialized reply_markup to editMessageReplyMarkup", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    api.editTelegramReplyMarkup("111", 7, { inline_keyboard: [] });

    var call = env.stubs.UrlFetchApp.fetch.mock.calls[0];
    expect(call[0]).toBe("https://api/editMessageReplyMarkup");
    var p = payloadOf(call);
    expect(typeof p.reply_markup).toBe("string");
    expect(JSON.parse(p.reply_markup)).toEqual({ inline_keyboard: [] });
  });

  it("sendChatAction defaults to 'typing' and swallows fetch errors", () => {
    var env = baseStubs({
      UrlFetchApp: {
        fetch: vi.fn(() => {
          throw new Error("boom");
        })
      }
    });
    var api = load(env.stubs);
    expect(() => api.sendChatAction("111")).not.toThrow();
    var p = payloadOf(env.stubs.UrlFetchApp.fetch.mock.calls[0]);
    expect(p.action).toBe("typing");
  });
});

// ── Group / member getters ─────────────────────────────────────────────────

describe("Telegram chat/member getters", () => {
  it("getTelegramChat returns body.result when ok:true", () => {
    var env = baseStubs({
      UrlFetchApp: { fetch: vi.fn(() => makeResponse(200, { ok: true, result: { id: -100, title: "G" } })) }
    });
    var api = load(env.stubs);
    expect(api.getTelegramChat("-100")).toEqual({ id: -100, title: "G" });
  });

  it("getTelegramChat returns null when ok:false", () => {
    var env = baseStubs({
      UrlFetchApp: { fetch: vi.fn(() => makeResponse(200, { ok: false, description: "fail" })) }
    });
    var api = load(env.stubs);
    expect(api.getTelegramChat("-100")).toBeNull();
  });

  it("getTelegramChat returns null when sendRequest throws", () => {
    var env = baseStubs({
      UrlFetchApp: {
        fetch: vi.fn(() => {
          throw new Error("network down");
        })
      }
    });
    var api = load(env.stubs);
    expect(api.getTelegramChat("-100")).toBeNull();
  });

  it("getTelegramChatAdministrators returns the admin list on ok:true", () => {
    var env = baseStubs({
      UrlFetchApp: { fetch: vi.fn(() => makeResponse(200, { ok: true, result: [{ user: { id: 1 } }] })) }
    });
    var api = load(env.stubs);
    expect(api.getTelegramChatAdministrators("-100")).toEqual([{ user: { id: 1 } }]);
  });

  it("getTelegramChatMemberInfo returns {name, username} from chat member result", () => {
    var env = baseStubs({
      UrlFetchApp: {
        fetch: vi.fn(() => makeResponse(200, { ok: true, result: { user: { first_name: "Alice", username: "ali" } } }))
      }
    });
    var api = load(env.stubs);
    var info = api.getTelegramChatMemberInfo("-100", "1");
    expect(info).toEqual({ name: "Alice", username: "ali" });
  });

  it("getTelegramChatMemberInfo memoizes per (chat_id,user_id) — second call doesn't refetch", () => {
    var fetch = vi.fn(() =>
      makeResponse(200, { ok: true, result: { user: { first_name: "Alice", username: "ali" } } })
    );
    var env = baseStubs({ UrlFetchApp: { fetch: fetch } });
    var api = load(env.stubs);
    api.getTelegramChatMemberInfo("-100", "1");
    api.getTelegramChatMemberInfo("-100", "1");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("getTelegramChatMemberInfo falls back to username for name when first_name is missing", () => {
    var env = baseStubs({
      UrlFetchApp: {
        fetch: vi.fn(() => makeResponse(200, { ok: true, result: { user: { username: "ali" } } }))
      }
    });
    var api = load(env.stubs);
    expect(api.getTelegramChatMemberInfo("-100", "2")).toEqual({ name: "ali", username: "ali" });
  });

  it("getTelegramChatMemberInfo returns {name:'',username:''} on error and still caches the miss", () => {
    var fetch = vi.fn(() => {
      throw new Error("boom");
    });
    var env = baseStubs({ UrlFetchApp: { fetch: fetch } });
    var api = load(env.stubs);
    expect(api.getTelegramChatMemberInfo("-100", "3")).toEqual({ name: "", username: "" });
    api.getTelegramChatMemberInfo("-100", "3");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("getTelegramChatMemberName is the name-only convenience wrapper", () => {
    var env = baseStubs({
      UrlFetchApp: {
        fetch: vi.fn(() => makeResponse(200, { ok: true, result: { user: { first_name: "Bob" } } }))
      }
    });
    var api = load(env.stubs);
    expect(api.getTelegramChatMemberName("-100", "9")).toBe("Bob");
  });

  it("getTelegramBotUserId uses cached property if present, never fetches", () => {
    var env = baseStubs();
    env.props.store["bot_user_id"] = "12345";
    var api = load(env.stubs);
    expect(api.getTelegramBotUserId()).toBe("12345");
    expect(env.stubs.UrlFetchApp.fetch).not.toHaveBeenCalled();
  });

  it("getTelegramBotUserId fetches + caches when property is absent", () => {
    var env = baseStubs({
      UrlFetchApp: {
        fetch: vi.fn(() => makeResponse(200, { ok: true, result: { id: 67890 } }))
      }
    });
    var api = load(env.stubs);
    expect(api.getTelegramBotUserId()).toBe("67890");
    expect(env.props.store["bot_user_id"]).toBe("67890");
  });

  it("getTelegramBotUserId returns null on fetch throw", () => {
    var env = baseStubs({
      UrlFetchApp: {
        fetch: vi.fn(() => {
          throw new Error("boom");
        })
      }
    });
    var api = load(env.stubs);
    expect(api.getTelegramBotUserId()).toBeNull();
  });
});

// ── sendRequest retries / 400-noop / failure ───────────────────────────────

describe("sendRequest retry + tolerance logic", () => {
  it("returns immediately on 200", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var resp = api.sendRequest("https://api/x", "post", {});
    expect(resp).toBeTruthy();
    expect(env.stubs.UrlFetchApp.fetch).toHaveBeenCalledTimes(1);
  });

  it("retries with exponential backoff when 429 has no retry_after, eventually succeeding", () => {
    var responses = [
      makeResponse(429, JSON.stringify({})),
      makeResponse(429, JSON.stringify({})),
      makeResponse(200, JSON.stringify({ ok: true }))
    ];
    var fetch = vi.fn(() => responses.shift());
    var env = baseStubs({ UrlFetchApp: { fetch: fetch } });
    var api = load(env.stubs);

    var resp = api.sendRequest("https://api/x", "post", {});
    expect(resp.getResponseCode()).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(3);
    // Two sleeps between three attempts: 1s then 2s (initial * 2^attempt).
    var sleepCalls = env.stubs.Utilities.sleep.mock.calls.map((c) => c[0]);
    expect(sleepCalls).toEqual([1000, 2000]);
  });

  it("honors Telegram parameters.retry_after + 1s buffer", () => {
    var responses = [
      makeResponse(429, JSON.stringify({ parameters: { retry_after: 3 } })),
      makeResponse(200, JSON.stringify({ ok: true }))
    ];
    var fetch = vi.fn(() => responses.shift());
    var env = baseStubs({ UrlFetchApp: { fetch: fetch } });
    var api = load(env.stubs);

    api.sendRequest("https://api/x", "post", {});
    expect(env.stubs.Utilities.sleep).toHaveBeenCalledWith(4000); // 3s + 1s buffer
  });

  it("parses 'Please retry in Xs' out of error.message", () => {
    var responses = [
      makeResponse(429, JSON.stringify({ error: { message: "Please retry in 2.5s buddy" } })),
      makeResponse(200, JSON.stringify({ ok: true }))
    ];
    var env = baseStubs({ UrlFetchApp: { fetch: vi.fn(() => responses.shift()) } });
    var api = load(env.stubs);

    api.sendRequest("https://api/x", "post", {});
    // 2.5 → ceil = 3 → 3000 + 1000 buffer = 4000.
    expect(env.stubs.Utilities.sleep).toHaveBeenCalledWith(4000);
  });

  it("parses Google RPC RetryInfo retryDelay (e.g. '52s')", () => {
    var details = [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "52s" }];
    var responses = [
      makeResponse(429, JSON.stringify({ error: { details: details } })),
      makeResponse(200, JSON.stringify({ ok: true }))
    ];
    var env = baseStubs({ UrlFetchApp: { fetch: vi.fn(() => responses.shift()) } });
    var api = load(env.stubs);

    api.sendRequest("https://api/x", "post", {});
    expect(env.stubs.Utilities.sleep).toHaveBeenCalledWith(53000);
  });

  it("throws after MAX_RETRIES of 429s", () => {
    var fetch = vi.fn(() => makeResponse(429, JSON.stringify({})));
    var env = baseStubs({ UrlFetchApp: { fetch: fetch } });
    var api = load(env.stubs);

    expect(() => api.sendRequest("https://api/x", "post", {})).toThrow(/rate limiting/i);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("treats 400 'message is not modified' as a successful no-op (no throw, returns response)", () => {
    var env = baseStubs({
      UrlFetchApp: {
        fetch: vi.fn(() => makeResponse(400, JSON.stringify({ description: "Bad Request: message is not modified" })))
      }
    });
    var api = load(env.stubs);

    var resp = api.sendRequest("https://api/x", "post", {});
    expect(resp.getResponseCode()).toBe(400);
  });

  it("throws on other 400 responses", () => {
    var env = baseStubs({
      UrlFetchApp: {
        fetch: vi.fn(() => makeResponse(400, JSON.stringify({ description: "Bad Request: chat not found" })))
      }
    });
    var api = load(env.stubs);

    expect(() => api.sendRequest("https://api/x", "post", {})).toThrow(/Response Code: 400/);
  });

  it("throws on a 5xx response", () => {
    var env = baseStubs({
      UrlFetchApp: { fetch: vi.fn(() => makeResponse(500, JSON.stringify({}))) }
    });
    var api = load(env.stubs);
    expect(() => api.sendRequest("https://api/x", "post", {})).toThrow(/Response Code: 500/);
  });
});

// ── Keyboards + message composition ────────────────────────────────────────

describe("keyboard builders", () => {
  it("buildReplyMarkup wraps inline_keyboard", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    expect(api.buildReplyMarkup([[{ text: "x", callback_data: "y" }]])).toEqual({
      inline_keyboard: [[{ text: "x", callback_data: "y" }]]
    });
  });

  it("buildCategoryKeyboard lays categories into rows of 3 + a Back row", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var kb = api.buildCategoryKeyboard("M1");
    // 4 categories: row of 3 + row of 1 + back row = 3 rows.
    expect(kb.inline_keyboard).toHaveLength(3);
    expect(kb.inline_keyboard[0]).toHaveLength(3);
    expect(kb.inline_keyboard[1]).toHaveLength(1);
    var back = kb.inline_keyboard[2][0];
    expect(back.text).toMatch(/Back/);
    expect(back.callback_data).toBe("back_M1");
  });

  it("buildCategoryKeyboard uses the provided categories + prefix", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var kb = api.buildCategoryKeyboard("M2", ["Food"], "gcat");
    expect(kb.inline_keyboard[0][0].callback_data).toBe("gcat_M2_0");
  });

  it("buildCategoryKeyboard prefixes category labels with the matching CATEGORY_EMOJIS entry", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var kb = api.buildCategoryKeyboard("M3");
    expect(kb.inline_keyboard[0][0].text).toMatch(/🛍️ Shopping/);
  });

  it("buildHelpMenuKeyboard exposes Report, Delete, and Back callbacks scoped to the messageId", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var kb = api.buildHelpMenuKeyboard("M9");
    var flat = kb.inline_keyboard.flat();
    expect(flat.find((b) => b.callback_data === "report_M9")).toBeTruthy();
    expect(flat.find((b) => b.callback_data === "del_M9")).toBeTruthy();
    expect(flat.find((b) => b.callback_data === "back_M9")).toBeTruthy();
  });

  it("buildDeleteConfirmKeyboard offers delyes_ + back_ buttons", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var kb = api.buildDeleteConfirmKeyboard("M10");
    expect(kb.inline_keyboard[0][0].callback_data).toBe("delyes_M10");
    expect(kb.inline_keyboard[0][1].callback_data).toBe("back_M10");
  });
});

describe("getTransactionMessageAsString", () => {
  it("renders merchant + money on line 1 and the formatted date on line 2", () => {
    var env = baseStubs();
    var api = load(env.stubs);

    var msg = api.getTransactionMessageAsString({
      email_date: new Date("2026-05-01T10:00:00Z"),
      merchant: "Swiggy",
      amount: 450.5,
      currency: "INR",
      transaction_type: "Debit"
    });
    expect(msg).toMatch(/\*Swiggy\* — ₹450.50/);
    expect(msg).toMatch(/🔴/);
    expect(msg).toMatch(/🗓 FMT/);
  });

  it("uses transaction_date when email_date is absent, and 'Unknown Date' when both are absent", () => {
    var env = baseStubs();
    var api = load(env.stubs);

    var withTxDate = api.getTransactionMessageAsString({
      transaction_date: "01 May 2026",
      merchant: "Swiggy",
      amount: 100,
      transaction_type: "Debit"
    });
    expect(withTxDate).toMatch(/01 May 2026/);

    var none = api.getTransactionMessageAsString({ merchant: "X", amount: 1, transaction_type: "Debit" });
    expect(none).toMatch(/Unknown Date/);
  });

  it("renders the 'Debited/Credited' header style when merchant is empty", () => {
    var env = baseStubs();
    var api = load(env.stubs);

    var msg = api.getTransactionMessageAsString({
      email_date: new Date("2026-05-01T10:00:00Z"),
      merchant: "",
      amount: 100,
      currency: "INR",
      transaction_type: "Debit"
    });
    expect(msg).toMatch(/\*₹100.00 Debited\*/);
  });

  it("uses the green emoji for non-debit transactions", () => {
    var env = baseStubs();
    var api = load(env.stubs);

    var msg = api.getTransactionMessageAsString({
      email_date: new Date("2026-05-01T10:00:00Z"),
      merchant: "Acme",
      amount: 100,
      transaction_type: "Credit"
    });
    expect(msg).toMatch(/🟢/);
  });

  it("appends a 👤 line when a user is provided", () => {
    var env = baseStubs();
    var api = load(env.stubs);

    var msg = api.getTransactionMessageAsString(
      { email_date: new Date("2026-05-01T10:00:00Z"), merchant: "M", amount: 1, transaction_type: "Debit" },
      "alice"
    );
    expect(msg).toMatch(/👤 alice/);
  });
});

describe("pillLabel + sendTransactionMessage", () => {
  it("pillLabel returns fallback on empty input", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    expect(api.pillLabel("", "Untagged")).toBe("Untagged");
    expect(api.pillLabel(null, "X")).toBe("X");
  });

  it("pillLabel truncates labels longer than TAG_MAX_LEN with an ellipsis", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var out = api.pillLabel("12345678901234567890", "f");
    expect(out.length).toBe(18);
    expect(out.endsWith("…")).toBe(true);
  });

  it("sendTransactionMessage with no messageId sends a plain message (no reply_markup)", () => {
    var env = baseStubs();
    var api = load(env.stubs);

    api.sendTransactionMessage(
      { email_date: new Date("2026-05-01T10:00:00Z"), merchant: "M", amount: 1, transaction_type: "Debit" },
      null,
      null
    );

    var p = payloadOf(env.stubs.UrlFetchApp.fetch.mock.calls[0]);
    expect(p.chat_id).toBe("111");
    expect(p.reply_markup).toBeUndefined();
  });

  it("sendTransactionMessage with messageId builds tag/cat/help row + prepends group rows above pills", () => {
    var env = baseStubs({
      buildGroupParentButtonRows: () => [
        [{ text: "Split to Roomies", callback_data: "gsplit_M1_g1" }],
        [{ text: "Split to Travel", callback_data: "gsplit_M1_g2" }]
      ]
    });
    var api = load(env.stubs);

    api.sendTransactionMessage(
      { email_date: new Date("2026-05-01T10:00:00Z"), merchant: "M", amount: 1, transaction_type: "Debit" },
      "M1",
      null
    );

    var p = payloadOf(env.stubs.UrlFetchApp.fetch.mock.calls[0]);
    var kb = JSON.parse(p.reply_markup).inline_keyboard;
    // Group rows pushed to the top, pills + ❓ row last.
    expect(kb).toHaveLength(3);
    expect(kb[0][0].callback_data).toBe("gsplit_M1_g1");
    expect(kb[1][0].callback_data).toBe("gsplit_M1_g2");
    var pills = kb[2];
    expect(pills[0].callback_data).toBe("tag_M1");
    expect(pills[1].callback_data).toBe("editcat_M1");
    expect(pills[2].callback_data).toBe("help_M1");
  });
});
