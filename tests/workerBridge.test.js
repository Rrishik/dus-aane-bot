import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { loadAppsScript } from "./_loader.js";
import { callAppsScript } from "../worker/src/app/appsScript.js";
import { verifySignedRequest } from "../worker/src/app/auth.js";

const SECRET = "int-secret";
const NOW = Date.UTC(2026, 9, 7, 8, 0);

// Apps Script returns signed Java bytes.
const Utilities = {
  computeHmacSha256Signature: (message, secret) =>
    Array.from(createHmac("sha256", secret).update(message, "utf8").digest()).map((b) => (b > 127 ? b - 256 : b)),
  base64EncodeWebSafe: (v) => Buffer.from(Array.isArray(v) ? v.map((b) => (b + 256) % 256) : v).toString("base64url")
};

function fakeProps(initial = {}) {
  const store = { ...initial };
  return {
    store,
    getProperty: (k) => (k in store ? store[k] : null),
    setProperty: (k, v) => {
      store[k] = String(v);
    },
    deleteProperty: (k) => {
      delete store[k];
    }
  };
}

function fakeMessage(id, { body = "Rs.100 debited", date = NOW } = {}) {
  return { getId: () => id, getPlainBody: () => body, getDate: () => new Date(date) };
}

// replies: (path, payload) => { code, json }
function load({ replies, props = fakeProps(), messages = {}, extra = {} } = {}) {
  const posts = [];
  const labelled = [];
  const triggers = [];
  let uid = 0;
  const api = loadAppsScript(
    ["Forwarding.js", "WorkerBridge.js"],
    [
      "verifyWorkerAction",
      "handleWorkerAction",
      "isWorkerActionBody",
      "postToWorker",
      "ingestEmailViaWorker",
      "ingestBatchViaWorker",
      "workerBackfillBucket",
      "continueWorkerBackfill",
      "buildVerifyForwardingUrl",
      "verifyVerifyToken",
      "hmacHex",
      "WORKER_ACTIONS"
    ],
    {
      Utilities,
      INTERNAL_SECRET: SECRET,
      WORKER_PROXY_URL: "https://worker.example/",
      PropertiesService: { getScriptProperties: () => props },
      ContentService: {
        MimeType: { JSON: "json" },
        createTextOutput: (text) => ({ text, setMimeType: (m) => ({ text, mime: m }) })
      },
      UrlFetchApp: {
        fetch: (url, opts) => {
          posts.push({ url, opts, payload: JSON.parse(opts.payload) });
          const r = replies ? replies(url.replace("https://worker.example", ""), JSON.parse(opts.payload)) : {};
          return { getResponseCode: () => r.code || 200, getContentText: () => JSON.stringify(r.json || {}) };
        }
      },
      ScriptApp: {
        newTrigger: (fn) => ({
          timeBased: () => ({
            after: (ms) => ({
              create: () => {
                const t = { fn, ms, id: "t" + ++uid, getUniqueId: () => "t" + uid };
                triggers.push(t);
                return t;
              }
            })
          })
        })
      },
      GmailApp: { getMessageById: (id) => messages[id] || null },
      getMessageHeaders: (id) => (messages[id] ? { id, xForwardedFor: "a@x.com" } : null),
      markProcessed: (m) => labelled.push(m.getId()),
      beginProcessedBatch: () => {},
      endProcessedBatch: () => {},
      deleteOwnTrigger: () => {},
      extractForwarderFromHeaders: (h) => h.xForwardedFor || null,
      ...extra
    }
  );
  return { api, posts, labelled, triggers, props };
}

const signAction = (action, payload, ts = NOW, secret = SECRET) => {
  const p = JSON.stringify(payload);
  const sig = createHmac("sha256", secret)
    .update(ts + "." + action + "." + p)
    .digest("hex");
  return { action, ts: String(ts), payload: p, sig };
};

describe("Worker → Apps Script actions", () => {
  it("verifies bodies produced by the Worker's callAppsScript", async () => {
    const { api } = load();
    let body;
    const ctx = {
      env: { APPS_SCRIPT_URL: "https://as/", INTERNAL_SECRET: SECRET },
      now: () => NOW,
      fetch: async (_u, init) => {
        body = JSON.parse(init.body);
        return new Response(JSON.stringify({ ok: true }));
      }
    };
    await callAppsScript(ctx, "get_email_body", { messageId: "m1" });
    expect(api.isWorkerActionBody(body)).toBe(true);
    expect(api.verifyWorkerAction(body, NOW)).toEqual({ messageId: "m1" });
    expect(api.verifyWorkerAction({ ...body, payload: '{"messageId":"m2"}' }, NOW)).toBeNull();
    expect(api.verifyWorkerAction(body, NOW + 6 * 60 * 1000)).toBeNull();
    expect(api.isWorkerActionBody({ update_id: 1, message: {} })).toBe(false);
  });

  it("dispatches actions and reports errors as JSON", () => {
    const mailed = [];
    const { api } = load({
      messages: { m1: fakeMessage("m1", { body: "hello" }) },
      extra: { mailSetupInstructions: (...a) => mailed.push(a) }
    });
    const run = (body) => JSON.parse(api.handleWorkerAction(body).text);
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      expect(run(signAction("send_setup_email", { chatId: "111", emails: ["a@x.com"] }))).toEqual({ ok: true });
      expect(mailed).toEqual([["111", ["a@x.com"], ["a@x.com"]]]);
      expect(run(signAction("get_email_body", { messageId: "m1" }))).toEqual({
        ok: true,
        text: "hello",
        receivedAt: NOW
      });
      expect(run(signAction("get_email_body", { messageId: "nope" }))).toEqual({
        ok: false,
        error: "message not found"
      });
      expect(run(signAction("rm_rf", {}))).toEqual({ ok: false, error: "unknown action" });
      expect(run(signAction("get_email_body", { messageId: "m1" }, NOW, "wrong"))).toEqual({
        ok: false,
        error: "unauthorized"
      });
    } finally {
      Date.now = realNow;
    }
  });
});

describe("Apps Script → Worker", () => {
  it("signs requests the Worker accepts", async () => {
    const { api, posts } = load({ replies: () => ({ json: { ok: true } }) });
    api.postToWorker("/ingest/email", { messageId: "m1" });
    const { url, opts } = posts[0];
    expect(url).toBe("https://worker.example/ingest/email");
    const req = new Request(url, { method: "POST", headers: opts.headers, body: opts.payload });
    const ts = Number(opts.headers["X-Dab-Timestamp"]);
    expect(await verifySignedRequest(req, SECRET, ts)).toEqual({ ok: true, body: opts.payload });
  });

  it("labels handled emails only", () => {
    const status = {
      m1: [200, "saved"],
      m2: [503, "failed"],
      m3: [200, "no_tenant"],
      m4: [400, null],
      m5: [200, "ignored"]
    };
    const { api, labelled, posts } = load({
      replies: (_p, body) => ({ code: status[body.messageId][0], json: { status: status[body.messageId][1] } })
    });
    const out = Object.keys(status).map((id) => api.ingestEmailViaWorker(fakeMessage(id), "a@x.com", false));
    expect(out).toEqual(["saved", "failed", "no_tenant", "failed", "ignored"]);
    expect(labelled).toEqual(["m1", "m4", "m5"]);
    expect(posts[0].payload).toEqual({
      messageId: "m1",
      forwarder: "a@x.com",
      receivedAt: NOW,
      text: "Rs.100 debited",
      silent: false
    });
  });

  it("retries failed emails on later runs, up to 6 attempts", () => {
    const props = fakeProps();
    let down = true;
    const messages = { m1: fakeMessage("m1"), m2: fakeMessage("m2") };
    const { api, posts } = load({
      props,
      messages,
      replies: (_p, body) => (down && body.messageId === "m2" ? { code: 503 } : { json: { status: "saved" } })
    });
    const entries = ["m1", "m2"].map((id) => ({ msg: messages[id], headers: { xForwardedFor: "a@x.com" } }));
    expect(api.ingestBatchViaWorker(entries)).toEqual({ handled: 1, failed: 1, skipped: 0 });
    expect(JSON.parse(props.store["gmail.workerRetry"])).toEqual({ m2: 1 });

    expect(api.ingestBatchViaWorker([])).toEqual({ handled: 0, failed: 1, skipped: 0 });
    expect(JSON.parse(props.store["gmail.workerRetry"])).toEqual({ m2: 2 });
    for (let i = 0; i < 4; i++) api.ingestBatchViaWorker([]);
    expect(JSON.parse(props.store["gmail.workerRetry"])).toEqual({});

    props.store["gmail.workerRetry"] = JSON.stringify({ m2: 3 });
    down = false;
    expect(api.ingestBatchViaWorker([])).toEqual({ handled: 1, failed: 0, skipped: 0 });
    expect(posts.at(-1).payload.messageId).toBe("m2");
  });
});

describe("Worker-driven /backfill", () => {
  it("starts on backfill_range, posts silently, reports progress and finishes", () => {
    const props = fakeProps();
    const messages = { m1: fakeMessage("m1"), m2: fakeMessage("m2"), m3: fakeMessage("m3") };
    const result = { m1: "saved", m2: "duplicate", m3: "failed" };
    const { api, posts, triggers } = load({
      props,
      messages,
      replies: (path, body) =>
        path === "/ingest/email"
          ? { code: result[body.messageId] === "failed" ? 503 : 200, json: { status: result[body.messageId] } }
          : {},
      extra: {
        fetchAndFilterMessages: () => [
          { msg: messages.m1, headers: { xForwardedFor: "a@x.com" } },
          { msg: messages.m2, headers: { xForwardedFor: "a@x.com" } },
          { msg: messages.m3, headers: { xForwardedFor: "a@x.com" } },
          { msg: fakeMessage("other"), headers: { xForwardedFor: "z@x.com" } }
        ]
      }
    });
    api.WORKER_ACTIONS.backfill_range({ chatId: "111", emails: ["A@x.com"], startMs: 1, endMs: 2 });
    expect(triggers).toHaveLength(1);
    api.continueWorkerBackfill({ triggerUid: triggers[0].getUniqueId() });

    const ingests = posts.filter((p) => p.url.endsWith("/ingest/email"));
    expect(ingests.map((p) => [p.payload.messageId, p.payload.silent])).toEqual([
      ["m1", true],
      ["m2", true],
      ["m3", true]
    ]);
    expect(posts.at(-1).payload).toEqual({ chatId: "111", saved: 1, dupes: 1, failed: 1, totalEmails: 3, done: true });
    expect(props.store["wbackfill:111"]).toBeUndefined();
    expect(triggers).toHaveLength(1);
  });

  it("buckets Worker statuses", () => {
    const { api } = load();
    expect(["saved", "review", "linked", "duplicate", "failed", "ignored"].map(api.workerBackfillBucket)).toEqual([
      "saved",
      "saved",
      "dupes",
      "dupes",
      "failed",
      null
    ]);
  });
});

describe("export_to_sheet", () => {
  function sheetStub(existing) {
    const made = [];
    const opened = {};
    const book = (id) => {
      const state = { id, values: null, cleared: 0, frozen: 0, editors: [] };
      const sheet = {
        clear: () => state.cleared++,
        getRange: (r, c, rows, cols) => ({
          setNumberFormats: (f) => {
            state.formats = f[0];
          },
          setValues: (v) => {
            expect([r, c, rows, cols]).toEqual([1, 1, v.length, v[0].length]);
            state.values = v;
          }
        }),
        setFrozenRows: (n) => (state.frozen = n)
      };
      return {
        state,
        getSheets: () => [sheet],
        getId: () => id,
        getUrl: () => "https://docs/" + id,
        addEditor: (e) => {
          if (e === "bad") throw new Error("invalid email");
          state.editors.push(e);
        }
      };
    };
    return {
      made,
      opened,
      SpreadsheetApp: {
        openById: (id) => {
          if (id !== existing) throw new Error("not found");
          return (opened[id] = opened[id] || book(id));
        },
        create: (title) => {
          const b = book("new-" + (made.length + 1));
          made.push({ title, b });
          return b;
        }
      }
    };
  }
  const payload = {
    title: "T",
    header: ["A", "B", "C"],
    rows: [[1, "=HYPERLINK(1)", "0042"]],
    emails: ["a@x.com", "bad"]
  };

  it("creates the sheet on first use, then rewrites it", () => {
    const stub = sheetStub("s1");
    const { api } = load({ extra: { SpreadsheetApp: stub.SpreadsheetApp } });
    expect(api.WORKER_ACTIONS.export_to_sheet({ ...payload, sheetId: "" })).toEqual({
      sheetId: "new-1",
      url: "https://docs/new-1"
    });
    expect(stub.made[0].b.state).toMatchObject({
      values: [
        ["A", "B", "C"],
        [1, "=HYPERLINK(1)", "0042"]
      ],
      formats: ["#,##0.00", "@", "@"],
      frozen: 1,
      editors: ["a@x.com"]
    });

    expect(api.WORKER_ACTIONS.export_to_sheet({ ...payload, sheetId: "s1" }).sheetId).toBe("s1");
    expect(stub.opened.s1.state.cleared).toBe(1);
    expect(api.WORKER_ACTIONS.export_to_sheet({ ...payload, sheetId: "gone" }).sheetId).toBe("new-2");
  });
});

describe("verify-forwarding link", () => {
  it("signs the forwarder emails into the link; old links still verify", () => {
    const { api } = load({ props: fakeProps({ verify_token_secret: "vs" }) });
    const url = api.buildVerifyForwardingUrl("https://script/exec", "111", NOW, ["a@x.com", "b@x.com"]);
    const q = new URL(url).searchParams;
    expect(q.get("e")).toBe("a@x.com,b@x.com");
    expect(api.verifyVerifyToken("111", q.get("iat"), q.get("sig"), NOW, q.get("e"))).toBe(true);
    expect(api.verifyVerifyToken("111", q.get("iat"), q.get("sig"), NOW, "evil@x.com")).toBe(false);

    const old = new URL(api.buildVerifyForwardingUrl("https://script/exec", "111", NOW)).searchParams;
    expect(old.get("e")).toBeNull();
    expect(api.verifyVerifyToken("111", old.get("iat"), old.get("sig"), NOW, "")).toBe(true);
  });
});
