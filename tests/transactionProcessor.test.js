// Coverage tests for TransactionProcessor.js entry points that aren't
// already exercised by historyProcessing / fetchAndFilter / messageHeaders /
// forwarderEmail tests. Loads TransactionProcessor.js standalone with every
// cross-module call stubbed.

import { describe, it, expect, vi } from "vitest";
import { loadAppsScript } from "./_loader.js";

const SYMBOLS = [
  "getExtractionSystemPrompt",
  "executeExtractionTool",
  "getBootstrapCutoffDate",
  "isAlreadyProcessed",
  "saveTransaction",
  "processSingleEmail",
  "backfillTransactions",
  "beginProcessedBatch",
  "endProcessedBatch",
  "EXTRACTION_TOOLS"
];

function makeProps(initial) {
  var store = Object.assign({}, initial || {});
  return {
    store: store,
    api: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in store ? store[k] : null),
        setProperty: (k, v) => {
          store[k] = String(v);
        },
        deleteProperty: (k) => {
          delete store[k];
        }
      })
    }
  };
}

function makeCache() {
  var c = {};
  return {
    store: c,
    api: {
      getScriptCache: () => ({
        get: (k) => (k in c ? c[k] : null),
        put: (k, v) => {
          c[k] = String(v);
        }
      })
    }
  };
}

function fakeMessage(id, opts) {
  opts = opts || {};
  return {
    getId: () => id,
    getDate: () => opts.date || new Date("2026-05-01T10:00:00Z"),
    getPlainBody: () => opts.body || "DUMMY BODY"
  };
}

function baseStubs(overrides) {
  var props = makeProps();
  var cache = makeCache();
  var sent = [];
  var appended = [];
  var stubs = Object.assign(
    {
      CATEGORIES: ["Shopping", "Groceries", "Food & Dining", "Healthcare"],
      CREDIT_CATEGORIES: ["Salary", "Refund"],
      BOOTSTRAP_WINDOW_MINUTES: 60,
      PROCESSED_LABEL_NAME: "processed-by-bot",
      MESSAGE_ID_COLUMN: 9,
      PropertiesService: props.api,
      CacheService: cache.api,
      Utilities: { sleep: () => {} },
      Gmail: {
        Users: {
          Labels: {
            list: vi.fn(() => ({ labels: [{ id: "label-1", name: "processed-by-bot" }] })),
            create: vi.fn(() => ({ id: "label-1" }))
          },
          Messages: {
            modify: vi.fn(),
            batchModify: vi.fn(),
            list: vi.fn(() => ({ messages: [] })),
            get: vi.fn((_userId, id) => ({
              id: id,
              payload: {
                headers: [
                  { name: "From", value: "alerts@bank.test" },
                  { name: "Subject", value: "Txn" },
                  { name: "X-Forwarded-For", value: "a@x.com" }
                ]
              }
            }))
          },
          getProfile: vi.fn(() => ({ historyId: "h-1" })),
          History: { list: vi.fn() }
        }
      },
      // Cross-module helpers.
      lookupMerchantCategory: vi.fn(() => null),
      resolveMerchant: vi.fn((name) => ({ merchant: name, category: "" })),
      addNewMerchantIfNeeded: vi.fn(),
      findRowByColumnValue: vi.fn(() => -1),
      appendRowToGoogleSheet: vi.fn((row) => appended.push(row)),
      sendTelegramMessage: (chat, text, opts) => sent.push({ chat: chat, text: text, opts: opts }),
      sendTransactionMessage: vi.fn(),
      escapeMarkdown: (s) => String(s == null ? "" : s),
      getTenantChatId: () => "111",
      findTenantByChatId: () => ({ chat_id: "111", emails: ["a@x.com"] }),
      callAIWithTools: vi.fn(),
      ensureSheetHeaders: vi.fn(),
      // Note: fetchAndFilterMessages, extractForwarderFromHeaders, getMessageHeaders,
      // shouldIgnoreByHeaders, isBankFromHeader, isFromAllowedBank are all
      // defined inside TransactionProcessor.js itself, so function declarations
      // there overwrite any stub of the same name. The backfill tests below
      // instead stub the underlying Gmail.* and GmailApp.* APIs that those
      // helpers consult, plus the constants they read (GMAIL_SEARCH_QUERY,
      // IGNORE_SENDERS, IGNORE_SUBJECTS, BANK_FROM_DOMAINS).
      GMAIL_SEARCH_QUERY: "in:inbox",
      IGNORE_SENDERS: [],
      IGNORE_SUBJECTS: [],
      BANK_FROM_DOMAINS: ["bank.test"],
      GmailApp: { getMessageById: (id) => fakeMessage(id) },
      getMerchantResolutions: vi.fn(() => []),
      getMerchantResolutionsForTenant: vi.fn(() => []),
      getCategoryListForType: (t) =>
        /credit/i.test(String(t || ""))
          ? ["Salary", "Refund"]
          : ["Shopping", "Groceries", "Food & Dining", "Healthcare"],
      getParserMode: vi.fn(() => "shadow"),
      isParserTemplateDisabled: vi.fn(() => false),
      logParserEvent: vi.fn(),
      PARSER_EVENT: {
        SAVED: "saved",
        SHADOW_MATCH: "shadow_match",
        SHADOW_MISMATCH: "shadow_mismatch",
        SHADOW_NOMATCH: "shadow_nomatch",
        SHADOW_EXTRA: "shadow_extra"
      },
      markTenantActivity: vi.fn()
    },
    overrides || {}
  );
  return { stubs: stubs, props: props, cache: cache, sent: sent, appended: appended };
}

function load(stubs) {
  return loadAppsScript(["BankTemplates.js", "Parser.js", "TransactionProcessor.js"], SYMBOLS, stubs);
}

// ── getExtractionSystemPrompt ───────────────────────────────────────────────

describe("getExtractionSystemPrompt", () => {
  it("interpolates the debit and credit category lists into the prompt", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var prompt = api.getExtractionSystemPrompt();

    expect(prompt).toMatch(/Shopping, Groceries, Food & Dining, Healthcare/);
    expect(prompt).toMatch(/Salary, Refund/);
    expect(prompt).toMatch(/get_merchant_category/);
    expect(prompt).toMatch(/transaction_type/);
  });
});

describe("EXTRACTION_TOOLS shape", () => {
  it("declares get_merchant_category as a function tool with a `merchant` required arg", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    expect(api.EXTRACTION_TOOLS).toHaveLength(1);
    var tool = api.EXTRACTION_TOOLS[0];
    expect(tool.type).toBe("function");
    expect(tool.function.name).toBe("get_merchant_category");
    expect(tool.function.parameters.required).toEqual(["merchant"]);
  });
});

// ── executeExtractionTool ───────────────────────────────────────────────────

describe("executeExtractionTool", () => {
  it("returns the lookup result when the merchant resolves", () => {
    var env = baseStubs({
      lookupMerchantCategory: vi.fn(() => ({ merchant: "Swiggy", category: "Food & Dining" }))
    });
    var api = load(env.stubs);

    var out = JSON.parse(api.executeExtractionTool("get_merchant_category", { merchant: "swiggy" }, []));
    expect(out).toEqual({ merchant: "Swiggy", category: "Food & Dining" });
    expect(env.stubs.lookupMerchantCategory).toHaveBeenCalledWith("swiggy", []);
  });

  it("returns 'no mapping found' when lookup misses", () => {
    var env = baseStubs();
    var api = load(env.stubs);

    var out = JSON.parse(api.executeExtractionTool("get_merchant_category", { merchant: "obscure" }, []));
    expect(out.merchant).toBe("obscure");
    expect(out.category).toBeNull();
    expect(out.message).toMatch(/No mapping found/);
  });

  it("returns an Unknown tool error for any other tool name", () => {
    var env = baseStubs();
    var api = load(env.stubs);

    var out = JSON.parse(api.executeExtractionTool("not_a_tool", {}, []));
    expect(out.error).toBe("Unknown tool");
  });
});

// ── getBootstrapCutoffDate ──────────────────────────────────────────────────

describe("getBootstrapCutoffDate", () => {
  it("returns now minus BOOTSTRAP_WINDOW_MINUTES", () => {
    var env = baseStubs({ BOOTSTRAP_WINDOW_MINUTES: 30 });
    var api = load(env.stubs);

    var before = Date.now();
    var cutoff = api.getBootstrapCutoffDate();
    var after = Date.now();

    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 30 * 60 * 1000 - 5);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - 30 * 60 * 1000 + 5);
  });
});

// ── isAlreadyProcessed ──────────────────────────────────────────────────────

describe("isAlreadyProcessed", () => {
  it("returns true when the cache already has the key (no sheet scan)", () => {
    var env = baseStubs();
    env.cache.store["processed:msg-A"] = "1";
    var api = load(env.stubs);

    expect(api.isAlreadyProcessed("msg-A")).toBe(true);
    expect(env.stubs.findRowByColumnValue).not.toHaveBeenCalled();
  });

  it("falls back to a sheet scan + caches the hit when sheet has the row", () => {
    var env = baseStubs({
      findRowByColumnValue: vi.fn(() => 42)
    });
    var api = load(env.stubs);

    expect(api.isAlreadyProcessed("msg-A")).toBe(true);
    expect(env.stubs.findRowByColumnValue).toHaveBeenCalledWith(9, "msg-A");
    expect(env.cache.store["processed:msg-A"]).toBe("1");
  });

  it("returns false (and does not cache) when neither cache nor sheet has it", () => {
    var env = baseStubs();
    var api = load(env.stubs);

    expect(api.isAlreadyProcessed("msg-A")).toBe(false);
    expect(env.cache.store["processed:msg-A"]).toBeUndefined();
  });
});

// ── handleAIResponse ────────────────────────────────────────────────────────

describe("processSingleEmail — LLM result handling", () => {
  var BODY = "Rs 450.00 debited from A/c XX1234 at SWIGGY on 01-05-26.";

  function call(env, api, raw, extra) {
    env.stubs.callAIWithTools.mockReturnValue({ choices: [{ message: { content: raw } }] });
    return api.processSingleEmail(
      fakeMessage("msg-1", { body: (extra && extra.body) || BODY }),
      "a@x.com",
      (extra && extra.silent) || false,
      (extra && extra.resolutions) || []
    );
  }

  it("strips ```json fences before parsing", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var out = call(env, api, '```json\n{"merchant":"Swiggy","amount":450,"transaction_type":"Debit"}\n```');
    expect(out.saved).toBe(true);
    expect(env.appended).toHaveLength(1);
  });

  it("not_a_transaction → no save, no 'skipped' DM, still labels the message", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    var out = call(env, api, '{"not_a_transaction":true,"reason":"OTP code"}');
    expect(out.saved).toBe(false);
    expect(env.appended).toHaveLength(0);
    expect(env.sent).toEqual([]);
    expect(env.stubs.Gmail.Users.Messages.modify).toHaveBeenCalled();
  });

  it("success → resolves the merchant, stores parser metadata, never pools the raw merchant", () => {
    var env = baseStubs({
      resolveMerchant: vi.fn(() => ({ merchant: "Swiggy", category: "Food & Dining" }))
    });
    var api = load(env.stubs);
    var out = call(env, api, '{"merchant":"swiggy bangalore","amount":450,"transaction_type":"Debit"}', {
      resolutions: [{}]
    });

    expect(out.saved).toBe(true);
    expect(env.stubs.resolveMerchant).toHaveBeenCalledWith("swiggy bangalore", [{}]);
    expect(env.stubs.addNewMerchantIfNeeded).not.toHaveBeenCalled();
    var row = env.appended[0];
    expect(row).toHaveLength(14);
    expect(row[2]).toBe("Swiggy");
    expect(row[11]).toBe("llm"); // Parsed By
    expect(row[12]).toBe(""); // Source Text only stored for SMS
    expect(row[13]).toBe(""); // Status: confirmed
  });

  it("uses resolved category when AI returned Uncategorized", () => {
    var env = baseStubs({
      resolveMerchant: vi.fn(() => ({ merchant: "Swiggy", category: "Food & Dining" }))
    });
    var api = load(env.stubs);
    call(env, api, '{"merchant":"swiggy","amount":450,"category":"Uncategorized","transaction_type":"Debit"}', {
      resolutions: [{}]
    });
    expect(env.appended[0][4]).toBe("Food & Dining");
  });

  it("keeps AI's explicit category over a shared default", () => {
    var env = baseStubs({
      resolveMerchant: vi.fn(() => ({ merchant: "Swiggy", category: "Food & Dining" }))
    });
    var api = load(env.stubs);
    call(env, api, '{"merchant":"swiggy","amount":450,"category":"Groceries","transaction_type":"Debit"}', {
      resolutions: [{}]
    });
    expect(env.appended[0][4]).toBe("Groceries");
  });

  it("the user's own category correction beats the AI's category", () => {
    var env = baseStubs({
      resolveMerchant: vi.fn(() => ({ merchant: "Swiggy", category: "Groceries", personalCategory: true }))
    });
    var api = load(env.stubs);
    call(env, api, '{"merchant":"swiggy","amount":450,"category":"Food & Dining","transaction_type":"Debit"}', {
      resolutions: [{}]
    });
    expect(env.appended[0][4]).toBe("Groceries");
  });

  it("ignores a resolved category that doesn't fit the transaction type", () => {
    var env = baseStubs({
      resolveMerchant: vi.fn(() => ({ merchant: "Swiggy", category: "Food & Dining", personalCategory: true }))
    });
    var api = load(env.stubs);
    call(env, api, '{"merchant":"swiggy","amount":450,"category":"Refund","transaction_type":"Credit"}', {
      resolutions: [{}],
      body: "Refund of Rs 450.00 from SWIGGY credited on 01-05-26"
    });
    expect(env.appended[0][4]).toBe("Refund");
  });

  it("flags the row for review when the amount isn't in the email", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    call(env, api, '{"merchant":"Swiggy","amount":4500,"transaction_type":"Debit"}');
    expect(env.appended[0][13]).toBe("review");
    expect(env.stubs.sendTransactionMessage.mock.calls[0][0].status).toBe("review");
  });

  it("silent (backfill) saves never use review status — there's no card to confirm from", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    call(env, api, '{"merchant":"Swiggy","amount":4500,"transaction_type":"Debit"}', { silent: true });
    expect(env.appended[0][13]).toBe("");
    expect(env.stubs.sendTransactionMessage).not.toHaveBeenCalled();
  });

  it("falls back to the email date when the AI date is missing or out of window", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    call(env, api, '{"merchant":"Swiggy","amount":450,"transaction_type":"Debit","transaction_date":"N/A"}');
    expect(env.appended[0][1]).toBe("2026-05-01");
  });

  it("returns saved=false when the text doesn't start with {", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    expect(call(env, api, "Sorry, I cannot extract this.").saved).toBe(false);
    expect(env.appended).toEqual([]);
  });

  it("returns saved=false when JSON parsing throws", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    expect(call(env, api, '{"merchant": broken json').saved).toBe(false);
    expect(env.appended).toEqual([]);
  });
});

describe("processSingleEmail — parser modes", () => {
  var BODY = "Rs 450.00 debited from A/c XX1234 at SWIGGY on 01-05-26. Ref 628012345678";
  var LLM = '{"merchant":"Swiggy","amount":450,"transaction_type":"Debit","transaction_date":"2026-05-01"}';

  function run(mode, llmRaw) {
    var env = baseStubs({ getParserMode: () => mode });
    env.stubs.callAIWithTools.mockReturnValue({ choices: [{ message: { content: llmRaw || LLM } }] });
    var api = load(env.stubs);
    var out = api.processSingleEmail(fakeMessage("msg-P", { body: BODY }), "a@x.com", true, []);
    return { env: env, out: out };
  }

  it("on: a confident parse saves without calling the LLM", () => {
    var r = run("on");
    expect(r.out.saved).toBe(true);
    expect(r.env.stubs.callAIWithTools).not.toHaveBeenCalled();
    expect(r.env.appended[0][3]).toBe(450);
    expect(r.env.appended[0][4]).toBe("Food & Dining"); // keyword guess
    expect(r.env.appended[0][11]).toBe("generic_v1");
    expect(r.env.stubs.logParserEvent.mock.calls[0][0].event).toBe("saved");
  });

  it("on: a disabled template falls back to the LLM", () => {
    var env = baseStubs({ getParserMode: () => "on", isParserTemplateDisabled: () => true });
    env.stubs.callAIWithTools.mockReturnValue({ choices: [{ message: { content: LLM } }] });
    var api = load(env.stubs);
    api.processSingleEmail(fakeMessage("msg-P", { body: BODY }), "a@x.com", true, []);
    expect(env.stubs.callAIWithTools).toHaveBeenCalledTimes(1);
    expect(env.appended[0][11]).toBe("llm");
  });

  it("shadow: saves the LLM read and logs agreement", () => {
    var r = run("shadow");
    expect(r.env.stubs.callAIWithTools).toHaveBeenCalledTimes(1);
    expect(r.env.appended[0][11]).toBe("llm");
    var evt = r.env.stubs.logParserEvent.mock.calls[0][0];
    expect(evt.event).toBe("shadow_match");
    expect(evt.templateId).toBe("generic_v1");
  });

  it("shadow: logs which fields disagree", () => {
    var r = run(
      "shadow",
      '{"merchant":"Swiggy","amount":45,"transaction_type":"Credit","transaction_date":"2026-05-01"}'
    );
    var evt = r.env.stubs.logParserEvent.mock.calls[0][0];
    expect(evt.event).toBe("shadow_mismatch");
    expect(evt.fieldsChanged).toEqual(["amount", "transaction_type"]);
  });

  it("off: never runs the parser or logs", () => {
    var r = run("off");
    expect(r.env.stubs.logParserEvent).not.toHaveBeenCalled();
    expect(r.env.appended[0][11]).toBe("llm");
  });
});

// ── saveTransaction ────────────────────────────────────────────────────────

describe("saveTransaction", () => {
  function call(api, data, extra) {
    return api.saveTransaction(
      data,
      new Date("2026-05-01T10:00:00Z"),
      (extra && extra.userEmail) || "alice@x.com",
      "msg-A",
      (extra && extra.silent) || false,
      extra && extra.meta
    );
  }

  it("writes all 14 cells with sensible defaults when data is sparse", () => {
    var env = baseStubs();
    var api = load(env.stubs);

    call(api, {});
    expect(env.appended).toHaveLength(1);
    var row = env.appended[0];
    expect(row).toHaveLength(14);
    expect(row[1]).toBe("N/A"); // transaction_date default
    expect(row[2]).toBe("Unknown"); // merchant default
    expect(row[3]).toBe(0); // amount default
    expect(row[4]).toBe("Uncategorized"); // category default
    expect(row[5]).toBe("Unknown"); // type default
    expect(row[6]).toBe("alice"); // userEmail local-part
    expect(row[7]).toBe("msg-A"); // messageId
    expect(row[8]).toBe("INR"); // currency default
    expect(row.slice(9)).toEqual(["", "", "", "", ""]);
  });

  it("writes parser metadata into the hidden columns", () => {
    var env = baseStubs();
    var api = load(env.stubs);
    call(api, { amount: 1 }, { meta: { parsedBy: "tpl_v1", sourceText: "SMS", status: "review" } });
    expect(env.appended[0].slice(11)).toEqual(["tpl_v1", "SMS", "review"]);
  });

  it("does NOT pass a displayUser to the notification when tenant has a single forwarder", () => {
    var env = baseStubs({
      findTenantByChatId: () => ({ chat_id: "111", emails: ["a@x.com"] })
    });
    var api = load(env.stubs);

    call(api, { merchant: "Swiggy", amount: 100, transaction_type: "Debit" });
    expect(env.stubs.sendTransactionMessage).toHaveBeenCalled();
    expect(env.stubs.sendTransactionMessage.mock.calls[0][2]).toBeNull();
  });

  it("passes the username when tenant has multiple forwarders", () => {
    var env = baseStubs({
      findTenantByChatId: () => ({ chat_id: "111", emails: ["a@x.com", "b@x.com"] })
    });
    var api = load(env.stubs);

    call(api, { merchant: "Swiggy", amount: 100, transaction_type: "Debit" }, { userEmail: "bob@x.com" });
    expect(env.stubs.sendTransactionMessage.mock.calls[0][2]).toBe("bob");
  });

  it("skips the Telegram notification entirely when silent=true (backfill path)", () => {
    var env = baseStubs();
    var api = load(env.stubs);

    call(api, { merchant: "Swiggy", amount: 100, transaction_type: "Debit" }, { silent: true });
    expect(env.stubs.sendTransactionMessage).not.toHaveBeenCalled();
    expect(env.appended).toHaveLength(1);
  });
});
// ── processSingleEmail ─────────────────────────────────────────────────────

describe("processSingleEmail", () => {
  it("short-circuits with duplicate=true when already processed (re-applies label)", () => {
    var env = baseStubs();
    env.cache.store["processed:msg-A"] = "1";
    var api = load(env.stubs);

    var out = api.processSingleEmail(fakeMessage("msg-A"), "a@x.com", true, []);
    expect(out).toEqual({ saved: false, duplicate: true, data: null });
    expect(env.stubs.callAIWithTools).not.toHaveBeenCalled();
    // Re-applies label (so future search filter catches it).
    expect(env.stubs.Gmail.Users.Messages.modify).toHaveBeenCalled();
  });

  it("returns saved=true on a direct final response (no tool call)", () => {
    var env = baseStubs({
      callAIWithTools: vi.fn(() => ({
        choices: [{ message: { content: '{"merchant":"Swiggy","amount":450,"transaction_type":"Debit"}' } }]
      }))
    });
    var api = load(env.stubs);

    var out = api.processSingleEmail(fakeMessage("msg-A"), "a@x.com", true, []);
    expect(out.saved).toBe(true);
    expect(env.appended).toHaveLength(1);
    expect(env.stubs.callAIWithTools).toHaveBeenCalledTimes(1);
  });

  it("loops once when the AI returns a tool call, then finalizes on the second iteration", () => {
    var env = baseStubs({
      callAIWithTools: vi
        .fn()
        .mockReturnValueOnce({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "tc-1",
                    function: { name: "get_merchant_category", arguments: '{"merchant":"X"}' }
                  }
                ]
              }
            }
          ]
        })
        .mockReturnValueOnce({
          choices: [{ message: { content: '{"merchant":"X","amount":99,"transaction_type":"Debit"}' } }]
        })
    });
    var api = load(env.stubs);

    var out = api.processSingleEmail(fakeMessage("msg-A"), "a@x.com", true, []);
    expect(out.saved).toBe(true);
    expect(env.stubs.callAIWithTools).toHaveBeenCalledTimes(2);
    // Second call's messages array should now include the tool result.
    var secondMessages = env.stubs.callAIWithTools.mock.calls[1][0];
    expect(secondMessages.some((m) => m.role === "tool")).toBe(true);
  });

  it("returns saved=false when the AI call returns null", () => {
    var env = baseStubs({ callAIWithTools: vi.fn(() => null) });
    var api = load(env.stubs);

    var out = api.processSingleEmail(fakeMessage("msg-A"), "a@x.com", true, []);
    expect(out.saved).toBe(false);
    expect(out.duplicate).toBe(false);
  });

  it("returns saved=false when the AI loop throws (e.g., Azure 500)", () => {
    var env = baseStubs({
      callAIWithTools: vi.fn(() => {
        throw new Error("Azure 500");
      })
    });
    var api = load(env.stubs);

    var out = api.processSingleEmail(fakeMessage("msg-A"), "a@x.com", true, []);
    expect(out.saved).toBe(false);
  });
});

// ── backfillTransactions ───────────────────────────────────────────────────
//
// fetchAndFilterMessages is defined inside TransactionProcessor.js, so we
// can't stub it directly (function decl shadows our stub in the sandbox).
// Instead we drive its underlying Gmail.* + GmailApp.* APIs to control what
// surfaces from the search.

describe("backfillTransactions", () => {
  function metaHeaders(forwarder) {
    return {
      payload: {
        headers: [
          { name: "From", value: "alerts@bank.test" },
          { name: "Subject", value: "Txn" },
          { name: "X-Forwarded-For", value: forwarder || "a@x.com" }
        ]
      }
    };
  }

  function withMessages(env, ids, opts) {
    opts = opts || {};
    env.stubs.Gmail.Users.Messages.list = vi.fn(() => ({ messages: ids.map((id) => ({ id: id })) }));
    env.stubs.Gmail.Users.Messages.get = vi.fn((_u, id) => metaHeaders(opts.forwarderFor && opts.forwarderFor(id)));
    env.stubs.GmailApp = {
      getMessageById: (id) =>
        Object.assign(fakeMessage(id), {
          getFrom: () => "alerts@bank.test",
          // Empty body — fetchAndFilterMessages doesn't read it, only isFromAllowedBank
          // which matches against getFrom().
          getPlainBody: () => ""
        })
    };
  }

  it("returns zero counts on an empty fetch result", () => {
    var env = baseStubs({ getCurrentTenant: () => null });
    var api = load(env.stubs);

    var out = api.backfillTransactions(new Date("2026-01-01"), new Date("2026-02-01"), 60000);
    expect(out).toEqual({
      savedCount: 0,
      duplicateCount: 0,
      failedCount: 0,
      totalEmails: 0,
      timedOut: false
    });
  });

  it("tallies saved/duplicate/failed across mixed processSingleEmail outcomes", () => {
    var env = baseStubs({
      getCurrentTenant: () => null,
      callAIWithTools: vi
        .fn()
        .mockReturnValueOnce({
          choices: [{ message: { content: '{"merchant":"X","amount":1,"transaction_type":"Debit"}' } }]
        })
        .mockReturnValueOnce({ choices: [{ message: { content: "not json" } }] })
        .mockReturnValueOnce({
          choices: [{ message: { content: '{"merchant":"Y","amount":2,"transaction_type":"Debit"}' } }]
        })
    });
    withMessages(env, ["a", "b", "c"]);
    var api = load(env.stubs);

    var out = api.backfillTransactions(new Date("2026-01-01"), new Date("2026-02-01"), 60000);
    expect(out.totalEmails).toBe(3);
    expect(out.savedCount).toBe(2);
    expect(out.failedCount).toBe(1);
    expect(out.duplicateCount).toBe(0);
  });

  it("counts duplicates separately when isAlreadyProcessed short-circuits", () => {
    var env = baseStubs({ getCurrentTenant: () => null });
    env.cache.store["processed:a"] = "1";
    env.cache.store["processed:b"] = "1";
    withMessages(env, ["a", "b"]);
    var api = load(env.stubs);

    var out = api.backfillTransactions(new Date("2026-01-01"), new Date("2026-02-01"), 60000);
    expect(out.duplicateCount).toBe(2);
    expect(out.savedCount).toBe(0);
    expect(env.stubs.callAIWithTools).not.toHaveBeenCalled();
  });

  it("sets timedOut=true when the clock exceeds timeLimitMs", () => {
    // Drive the clock deterministically: vi.useFakeTimers gives us advanceTimersByTime,
    // but the production code uses `new Date().getTime()` not `Date.now`, so we
    // monkey-patch the Date constructor instead.
    var t = 0;
    var RealDate = Date;
    var FakeDate = function (arg) {
      if (arguments.length === 0) {
        return new RealDate(t);
      }
      return new RealDate(arg);
    };
    FakeDate.now = () => t;
    FakeDate.prototype = RealDate.prototype;

    var env = baseStubs({
      getCurrentTenant: () => null,
      Utilities: {
        sleep: () => {
          t += 200; // each "sleep" advances the clock 200ms
        }
      },
      callAIWithTools: vi.fn(() => ({
        choices: [{ message: { content: '{"merchant":"X","amount":1,"transaction_type":"Debit"}' } }]
      }))
    });
    withMessages(env, ["a", "b", "c"]);
    env.stubs.Date = FakeDate;
    var api = load(env.stubs);

    var out = api.backfillTransactions(new RealDate("2026-01-01"), new RealDate("2026-02-01"), 100);
    expect(out.timedOut).toBe(true);
    expect(out.savedCount).toBeLessThan(3);
  });

  it("filters by tenant emails when a tenant is in context", () => {
    var env = baseStubs({
      getCurrentTenant: () => ({ chat_id: "111", emails: ["alice@x.com"] }),
      callAIWithTools: vi.fn(() => ({
        choices: [{ message: { content: '{"merchant":"X","amount":1,"transaction_type":"Debit"}' } }]
      }))
    });
    withMessages(env, ["alice-1", "stranger-1"], {
      forwarderFor: (id) => (id === "alice-1" ? "alice@x.com" : "stranger@x.com")
    });
    var api = load(env.stubs);

    var out = api.backfillTransactions(new Date("2026-01-01"), new Date("2026-02-01"), 60000);
    expect(out.totalEmails).toBe(1);
    expect(out.savedCount).toBe(1);
  });

  it("calls batchModify exactly once via begin/endProcessedBatch even with multiple saves", () => {
    var env = baseStubs({
      getCurrentTenant: () => null,
      callAIWithTools: vi.fn(() => ({
        choices: [{ message: { content: '{"merchant":"X","amount":1,"transaction_type":"Debit"}' } }]
      }))
    });
    withMessages(env, ["a", "b"]);
    var api = load(env.stubs);

    api.backfillTransactions(new Date("2026-01-01"), new Date("2026-02-01"), 60000);
    expect(env.stubs.Gmail.Users.Messages.batchModify).toHaveBeenCalledTimes(1);
    expect(env.stubs.Gmail.Users.Messages.modify).not.toHaveBeenCalled();
  });
});
