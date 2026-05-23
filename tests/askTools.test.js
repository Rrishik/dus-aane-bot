// Unit tests for AskTools.js — focuses on runAskLoop suspend/resume
// semantics (Pattern 3) and the ASK_MAX_TURNS guard. The existing
// callAIWithTools is stubbed so we can script exact LLM responses.

import { describe, it, expect, vi } from "vitest";
import { loadAppsScript } from "./_loader.js";

function makeCacheStore() {
  var store = {};
  return {
    store: store,
    api: {
      get: (k) => (k in store ? store[k] : null),
      put: (k, v) => {
        store[k] = v;
      },
      remove: (k) => {
        delete store[k];
      }
    }
  };
}

function baseStubs(overrides) {
  var cache = makeCacheStore();
  var stubs = Object.assign(
    {
      CATEGORIES: ["Shopping", "Groceries"],
      CREDIT_CATEGORIES: ["Salary", "Refund"],
      // Personal-sheet column constants — match Constants.js. Needed by
      // executeAskTool's mutation paths (update_transaction).
      MESSAGE_ID_COLUMN: 9,
      MERCHANT_COLUMN: 3,
      CATEGORY_COLUMN: 5,
      TRANSACTION_TYPE_COLUMN: 6,
      TAG_MAX_LEN: 18,
      Session: { getScriptTimeZone: () => "Asia/Kolkata" },
      Utilities: {
        formatDate: (d, _tz, fmt) => "FMT(" + (d && d.toISOString ? d.toISOString() : d) + "," + fmt + ")"
      },
      CacheService: { getScriptCache: () => cache.api },
      getAllTransactions: vi.fn(() => []),
      callAIWithTools: vi.fn(),
      filterByDateRange: (txns) => txns,
      sumByCurrency: () => ({}),
      aggregateByField: () => [],
      aggregateByUser: () => [],
      // Mutation helpers — stubbed; tests override per-case.
      findRowByColumnValue: vi.fn(() => -1),
      updateGoogleSheetCellWithFeedback: vi.fn(() => ({ success: true })),
      setCategoryOverride: vi.fn(),
      findGroupsForMember: vi.fn(() => []),
      findTenantByChatId: vi.fn(() => null),
      recordGroupSplit: vi.fn(() => ({ ok: true }))
    },
    overrides || {}
  );
  return { stubs: stubs, cache: cache };
}

const SYMBOLS = [
  "ASK_TOOLS",
  "runAskLoop",
  "executeAskTool",
  "execUpdateTransaction",
  "execGetGroups",
  "execSplitTransaction",
  "saveAskConvo",
  "loadAskConvo",
  "clearAskConvo",
  "ASK_MAX_TURNS"
];

function load(stubs) {
  return loadAppsScript(["AskTools.js"], SYMBOLS, stubs);
}

// ── ASK_TOOLS schema ────────────────────────────────────────────────

describe("ASK_TOOLS", () => {
  it("includes the ask_user tool with a required 'question' parameter", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var askUser = api.ASK_TOOLS.find((t) => t.function.name === "ask_user");
    expect(askUser).toBeTruthy();
    expect(askUser.function.parameters.required).toEqual(["question"]);
  });
});

// ── runAskLoop: final answer (regression) ───────────────────────────

describe("runAskLoop — final answer", () => {
  it("returns { kind: 'final', text } when the LLM stops with content", () => {
    var env = baseStubs({
      callAIWithTools: vi.fn(() => ({
        choices: [{ finish_reason: "stop", message: { content: "you spent ₹500 on food" } }]
      }))
    });
    var api = load(env.stubs);
    var result = api.runAskLoop("food spend?");
    expect(result).toEqual({ kind: "final", text: "you spent ₹500 on food" });
  });

  it("returns { kind: 'error', ... } when callAIWithTools returns null", () => {
    var env = baseStubs({ callAIWithTools: vi.fn(() => null) });
    var api = load(env.stubs);
    var result = api.runAskLoop("anything");
    expect(result.kind).toBe("error");
    expect(result.text).toMatch(/couldn't process/);
  });
});

// ── runAskLoop: ask_user suspend ────────────────────────────────────

describe("runAskLoop — ask_user suspend", () => {
  it("suspends when the LLM calls ask_user, returning messages + askCallId", () => {
    var env = baseStubs({
      callAIWithTools: vi.fn(() => ({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "call_abc",
                  function: { name: "ask_user", arguments: JSON.stringify({ question: "which month?" }) }
                }
              ]
            }
          }
        ]
      }))
    });
    var api = load(env.stubs);
    var result = api.runAskLoop("how much?");
    expect(result.kind).toBe("suspend");
    expect(result.text).toBe("which month?");
    expect(result.askCallId).toBe("call_abc");
    expect(result.turn).toBe(1);
    // The assistant message must be in the persisted history so the
    // pending tool_call has somewhere to attach its eventual tool reply.
    expect(result.messages[result.messages.length - 1].tool_calls[0].id).toBe("call_abc");
  });

  it("when ask_user is one of several tool calls, executes siblings and then suspends", () => {
    var executor = vi.fn(() => ({ ok: true }));
    var env = baseStubs({
      aggregateByField: executor, // search uses this; just need any deterministic stub
      callAIWithTools: vi.fn(() => ({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "t1",
                  function: {
                    name: "get_category_breakdown",
                    arguments: JSON.stringify({ start_date: "2026-05-01", end_date: "2026-05-23" })
                  }
                },
                {
                  id: "t2",
                  function: { name: "ask_user", arguments: JSON.stringify({ question: "scope?" }) }
                }
              ]
            }
          }
        ]
      }))
    });
    var api = load(env.stubs);
    var result = api.runAskLoop("breakdown?");
    expect(result.kind).toBe("suspend");
    expect(result.askCallId).toBe("t2");
    // Sibling tool result should be in messages so the next LLM round
    // has the full context. The assistant message + sibling tool result.
    var roles = result.messages.map((m) => m.role);
    expect(roles).toContain("tool");
    // Ensure the t1 tool result was pushed (its tool_call_id is in messages).
    var t1Reply = result.messages.find((m) => m.role === "tool" && m.tool_call_id === "t1");
    expect(t1Reply).toBeTruthy();
  });

  it("handles malformed ask_user arguments gracefully (empty question fallback)", () => {
    var env = baseStubs({
      callAIWithTools: vi.fn(() => ({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              tool_calls: [{ id: "x", function: { name: "ask_user", arguments: "not-json" } }]
            }
          }
        ]
      }))
    });
    var api = load(env.stubs);
    var result = api.runAskLoop("vague");
    expect(result.kind).toBe("suspend");
    expect(result.text).toMatch(/more detail/i);
  });
});

// ── runAskLoop: resume ─────────────────────────────────────────────

describe("runAskLoop — resume", () => {
  it("uses opts.messages when provided and skips system+user build", () => {
    var aiCalls = [];
    var env = baseStubs({
      callAIWithTools: vi.fn((messages) => {
        aiCalls.push(messages.slice());
        return { choices: [{ finish_reason: "stop", message: { content: "got it: May" } }] };
      })
    });
    var api = load(env.stubs);
    var priorMessages = [
      { role: "system", content: "sys" },
      { role: "user", content: "how much?" },
      { role: "assistant", tool_calls: [{ id: "c", function: { name: "ask_user", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c", content: "May" }
    ];
    var result = api.runAskLoop(null, null, { messages: priorMessages, turn: 2 });
    expect(result.kind).toBe("final");
    expect(result.text).toBe("got it: May");
    // The exact prior messages should have been the LLM input — no fresh
    // system prompt was prepended.
    expect(aiCalls[0]).toEqual(priorMessages);
  });

  it("refuses with kind='error' when turn exceeds ASK_MAX_TURNS", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var result = api.runAskLoop(null, null, { messages: [], turn: api.ASK_MAX_TURNS + 1 });
    expect(result.kind).toBe("error");
    expect(result.text).toMatch(/too many follow-ups/);
    // Should NOT have called the LLM at all.
    expect(env.stubs.callAIWithTools).not.toHaveBeenCalled();
  });
});

// ── Cache helpers ────────────────────────────────────────────────────

describe("ask convo cache", () => {
  it("save → load roundtrips messages, askCallId, turn", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var msgs = [{ role: "user", content: "hi" }];
    api.saveAskConvo("42", 100, msgs, "call_xyz", 2);
    var got = api.loadAskConvo("42", 100);
    expect(got).toEqual({ messages: msgs, askCallId: "call_xyz", turn: 2 });
  });

  it("load returns null when key is missing or after clear", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    expect(api.loadAskConvo("42", 999)).toBeNull();
    api.saveAskConvo("42", 100, [], "c", 1);
    api.clearAskConvo("42", 100);
    expect(api.loadAskConvo("42", 100)).toBeNull();
  });

  it("isolates by chatId and messageId", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    api.saveAskConvo("A", 1, [{ role: "user", content: "a" }], "ca", 1);
    api.saveAskConvo("B", 1, [{ role: "user", content: "b" }], "cb", 1);
    expect(api.loadAskConvo("A", 1).askCallId).toBe("ca");
    expect(api.loadAskConvo("B", 1).askCallId).toBe("cb");
    expect(api.loadAskConvo("A", 2)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Mutation tools — update_transaction, get_groups, split_transaction.
// Cover the executor branches directly via executeAskTool so we exercise
// the snapshot lookup + tool dispatch + ctx threading at the same time.

function makeTxn(over) {
  return Object.assign(
    {
      messageId: "msg-1",
      date: new Date("2026-05-17T12:00:00Z"),
      merchant: "Swiggy",
      amount: 250,
      currency: "INR",
      category: "Food",
      type: "Debit",
      user: "Alice"
    },
    over || {}
  );
}

describe("executeAskTool — update_transaction", () => {
  it("rejects when transaction_id is missing", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var res = api.executeAskTool("update_transaction", { category: "Groceries" }, [makeTxn()], {});
    expect(res).toEqual({ ok: false, error: "transaction_id is required" });
  });

  it("rejects when the txn is not in the snapshot", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var res = api.executeAskTool(
      "update_transaction",
      { transaction_id: "missing", category: "Groceries" },
      [makeTxn()],
      {}
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Transaction not found/);
  });

  it("rejects when the sheet row is missing", () => {
    var env = baseStubs({ findRowByColumnValue: vi.fn(() => -1) });
    var api = load(env.stubs);
    var res = api.executeAskTool(
      "update_transaction",
      { transaction_id: "msg-1", category: "Groceries" },
      [makeTxn()],
      {}
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Sheet row missing/);
  });

  it("rejects category not in the type's category list", () => {
    var env = baseStubs({ findRowByColumnValue: vi.fn(() => 5) });
    var api = load(env.stubs);
    var res = api.executeAskTool(
      "update_transaction",
      { transaction_id: "msg-1", category: "Salary" }, // credit category on a debit
      [makeTxn()],
      {}
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Invalid category/);
    expect(env.stubs.updateGoogleSheetCellWithFeedback).not.toHaveBeenCalled();
  });

  it("rejects merchant longer than TAG_MAX_LEN", () => {
    var env = baseStubs({ findRowByColumnValue: vi.fn(() => 5) });
    var api = load(env.stubs);
    var longTag = "x".repeat(env.stubs.TAG_MAX_LEN + 1);
    var res = api.executeAskTool("update_transaction", { transaction_id: "msg-1", merchant: longTag }, [makeTxn()], {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/characters/);
  });

  it("rejects invalid transaction_type", () => {
    var env = baseStubs({ findRowByColumnValue: vi.fn(() => 5) });
    var api = load(env.stubs);
    var res = api.executeAskTool(
      "update_transaction",
      { transaction_id: "msg-1", transaction_type: "Refund" },
      [makeTxn()],
      {}
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Debit.*Credit/);
  });

  it("rejects when no updatable fields were provided", () => {
    var env = baseStubs({ findRowByColumnValue: vi.fn(() => 5) });
    var api = load(env.stubs);
    var res = api.executeAskTool("update_transaction", { transaction_id: "msg-1" }, [makeTxn()], {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Nothing to update/);
  });

  it("updates category, calls setCategoryOverride, and returns change diff", () => {
    var env = baseStubs({ findRowByColumnValue: vi.fn(() => 7) });
    var api = load(env.stubs);
    var res = api.executeAskTool(
      "update_transaction",
      { transaction_id: "msg-1", category: "Groceries" },
      [makeTxn({ category: "Food" })],
      {}
    );
    expect(res).toEqual({
      ok: true,
      transaction_id: "msg-1",
      changes: [{ field: "category", from: "Food", to: "Groceries" }]
    });
    expect(env.stubs.updateGoogleSheetCellWithFeedback).toHaveBeenCalledWith(7, 5, "Groceries", "Food");
    expect(env.stubs.setCategoryOverride).toHaveBeenCalledWith("Swiggy", "Groceries");
  });

  it("updates merchant + transaction_type together", () => {
    var env = baseStubs({ findRowByColumnValue: vi.fn(() => 4) });
    var api = load(env.stubs);
    var res = api.executeAskTool(
      "update_transaction",
      { transaction_id: "msg-1", merchant: "swiggy2", transaction_type: "Credit" },
      [makeTxn()],
      {}
    );
    expect(res.ok).toBe(true);
    expect(res.changes).toEqual([
      { field: "merchant", from: "Swiggy", to: "swiggy2" },
      { field: "transaction_type", from: "Debit", to: "Credit" }
    ]);
    // Two cell updates fired — one for merchant col, one for type col.
    expect(env.stubs.updateGoogleSheetCellWithFeedback).toHaveBeenCalledTimes(2);
    // setCategoryOverride must NOT fire when no category change happened.
    expect(env.stubs.setCategoryOverride).not.toHaveBeenCalled();
  });

  it("propagates sheet write failures", () => {
    var env = baseStubs({
      findRowByColumnValue: vi.fn(() => 4),
      updateGoogleSheetCellWithFeedback: vi.fn(() => ({ success: false, message: "race" }))
    });
    var api = load(env.stubs);
    var res = api.executeAskTool(
      "update_transaction",
      { transaction_id: "msg-1", category: "Groceries" },
      [makeTxn()],
      {}
    );
    expect(res).toEqual({ ok: false, error: "race" });
  });
});

describe("executeAskTool — get_groups", () => {
  it("rejects when caller chat id is missing", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var res = api.executeAskTool("get_groups", {}, [], {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Caller chat id/);
    expect(res.groups).toEqual([]);
  });

  it("returns empty list when the user is in no groups", () => {
    var env = baseStubs({ findGroupsForMember: vi.fn(() => []) });
    var api = load(env.stubs);
    var res = api.executeAskTool("get_groups", {}, [], { chatId: "u1" });
    expect(res).toEqual({ ok: true, count: 0, groups: [] });
  });

  it("shapes group + member listing with 0-based indexes", () => {
    var env = baseStubs({
      findGroupsForMember: vi.fn(() => [
        {
          chat_id: -100,
          name: "Trip",
          primary_currency: "USD",
          group_members: ["u1", "u2", "u3"]
        }
      ]),
      findTenantByChatId: vi.fn((id) => ({ name: "name_" + id }))
    });
    var api = load(env.stubs);
    var res = api.executeAskTool("get_groups", {}, [], { chatId: "u1" });
    expect(res.ok).toBe(true);
    expect(res.count).toBe(1);
    expect(res.groups[0]).toEqual({
      chat_id: "-100",
      name: "Trip",
      primary_currency: "USD",
      members: [
        { index: 0, chat_id: "u1", name: "name_u1" },
        { index: 1, chat_id: "u2", name: "name_u2" },
        { index: 2, chat_id: "u3", name: "name_u3" }
      ]
    });
  });

  it("falls back gracefully when findGroupsForMember throws", () => {
    var env = baseStubs({
      findGroupsForMember: vi.fn(() => {
        throw new Error("boom");
      })
    });
    var api = load(env.stubs);
    var res = api.executeAskTool("get_groups", {}, [], { chatId: "u1" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/boom/);
  });
});

describe("executeAskTool — split_transaction", () => {
  it("rejects when caller chat id is missing", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var res = api.executeAskTool("split_transaction", { transaction_id: "msg-1", mode: "50" }, [makeTxn()], {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Caller chat id/);
  });

  it("rejects when transaction_id or mode is missing", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var r1 = api.executeAskTool("split_transaction", { mode: "50" }, [makeTxn()], { chatId: "u1" });
    expect(r1).toEqual({ ok: false, error: "transaction_id is required" });
    var r2 = api.executeAskTool("split_transaction", { transaction_id: "msg-1" }, [makeTxn()], { chatId: "u1" });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/mode is required/);
  });

  it("rejects when the txn is not in the snapshot", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var res = api.executeAskTool("split_transaction", { transaction_id: "missing", mode: "50" }, [makeTxn()], {
      chatId: "u1"
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Transaction not found/);
  });

  it("auto-picks the group when the user is in exactly one", () => {
    var rg = vi.fn(() => ({
      ok: true,
      merchant: "Swiggy",
      amount: 250,
      currency: "INR",
      category: "Food",
      holders: ["u1", "u2"],
      shares: [125, 125]
    }));
    var env = baseStubs({
      findGroupsForMember: vi.fn(() => [{ chat_id: -100, group_members: ["u1", "u2"] }]),
      recordGroupSplit: rg
    });
    var api = load(env.stubs);
    var res = api.executeAskTool("split_transaction", { transaction_id: "msg-1", mode: "50" }, [makeTxn()], {
      chatId: "u1"
    });
    expect(rg).toHaveBeenCalledWith({
      emailMessageId: "msg-1",
      groupChatId: "-100",
      mode: "50",
      payerChatId: "u1"
    });
    expect(res).toEqual({
      ok: true,
      transaction_id: "msg-1",
      group_chat_id: "-100",
      merchant: "Swiggy",
      amount: 250,
      currency: "INR",
      category: "Food",
      holders: ["u1", "u2"],
      shares: [125, 125]
    });
  });

  it("refuses when the user is in no groups", () => {
    var env = baseStubs({ findGroupsForMember: vi.fn(() => []) });
    var api = load(env.stubs);
    var res = api.executeAskTool("split_transaction", { transaction_id: "msg-1", mode: "50" }, [makeTxn()], {
      chatId: "u1"
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not in any active group/);
    expect(env.stubs.recordGroupSplit).not.toHaveBeenCalled();
  });

  it("refuses ambiguous group when the user is in multiple and none specified", () => {
    var env = baseStubs({
      findGroupsForMember: vi.fn(() => [{ chat_id: -100 }, { chat_id: -200 }])
    });
    var api = load(env.stubs);
    var res = api.executeAskTool("split_transaction", { transaction_id: "msg-1", mode: "50" }, [makeTxn()], {
      chatId: "u1"
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Multiple groups/);
    expect(env.stubs.recordGroupSplit).not.toHaveBeenCalled();
  });

  it("honours an explicit group_chat_id even when the user is in many groups", () => {
    var rg = vi.fn(() => ({ ok: true, merchant: "X", amount: 10, currency: "INR" }));
    var env = baseStubs({
      findGroupsForMember: vi.fn(() => [{ chat_id: -100 }, { chat_id: -200 }]),
      recordGroupSplit: rg
    });
    var api = load(env.stubs);
    var res = api.executeAskTool(
      "split_transaction",
      { transaction_id: "msg-1", mode: "all", group_chat_id: "-200" },
      [makeTxn()],
      { chatId: "u1" }
    );
    expect(res.ok).toBe(true);
    expect(rg).toHaveBeenCalledWith({
      emailMessageId: "msg-1",
      groupChatId: "-200",
      mode: "all",
      payerChatId: "u1"
    });
  });

  it("propagates recordGroupSplit failure", () => {
    var env = baseStubs({
      findGroupsForMember: vi.fn(() => [{ chat_id: -100 }]),
      recordGroupSplit: vi.fn(() => ({ ok: false, error: "Already split" }))
    });
    var api = load(env.stubs);
    var res = api.executeAskTool("split_transaction", { transaction_id: "msg-1", mode: "50" }, [makeTxn()], {
      chatId: "u1"
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Already split");
  });
});

describe("search_transactions exposes transaction_id", () => {
  it("surfaces messageId as transaction_id so the LLM can mutate the row", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var res = api.executeAskTool(
      "search_transactions",
      { limit: 5 },
      [makeTxn({ messageId: "msg-abc" }), makeTxn({ messageId: "msg-def" })],
      {}
    );
    expect(res.count).toBe(2);
    expect(res.transactions[0].transaction_id).toBe("msg-abc");
    expect(res.transactions[1].transaction_id).toBe("msg-def");
  });
});

describe("runAskLoop threads chatId into tool execution ctx", () => {
  it("passes ctx.chatId from opts to executeAskTool so mutation tools see the caller", () => {
    // Two-turn LLM script: tool_use → final.
    var callAI = vi.fn();
    callAI
      .mockReturnValueOnce({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "call_g1",
                  function: { name: "get_groups", arguments: "{}" }
                }
              ]
            }
          }
        ]
      })
      .mockReturnValueOnce({
        choices: [{ finish_reason: "stop", message: { content: "you have 1 group" } }]
      });

    var groupsCall = vi.fn(() => [{ chat_id: -100, name: "G", group_members: ["uX"] }]);
    var env = baseStubs({
      callAIWithTools: callAI,
      findGroupsForMember: groupsCall
    });
    var api = load(env.stubs);
    var result = api.runAskLoop("how many groups", null, { chatId: "uX" });
    expect(result.kind).toBe("final");
    expect(groupsCall).toHaveBeenCalledWith("uX");
  });
});
