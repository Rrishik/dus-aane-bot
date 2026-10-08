import { describe, it, expect } from "vitest";
import worker, { healthz, isSlowUpdate } from "../src/index.js";
import { ulid } from "../src/util/ids.js";
import { toMinor, fromMinor } from "../src/util/money.js";
import { defaultKind } from "../src/util/kind.js";
import { shiftIsoDate, istDate } from "../src/util/dates.js";
import { createTestD1 } from "./helpers/d1.js";

describe("router", () => {
  const ctx = { waitUntil: () => {} };

  it("GET /healthz reports a missing D1 binding as db:null", async () => {
    const res = await worker.fetch(new Request("https://w/healthz"), {}, ctx);
    expect(await res.json()).toEqual({ ok: true, db: null });
  });

  it("GET /healthz checks the D1 binding when present", async () => {
    const res = await healthz({ DB: createTestD1() });
    expect(await res.json()).toEqual({ ok: true, db: true });
    const broken = await healthz({
      DB: {
        prepare: () => {
          throw new Error("down");
        }
      }
    });
    expect(broken.status).toBe(503);
  });

  it("keeps the pre-migration behaviour: other GETs are 405", async () => {
    const res = await worker.fetch(new Request("https://w/"), {}, ctx);
    expect(res.status).toBe(405);
  });

  it("POST still goes through the secret-checked Apps Script proxy", async () => {
    const calls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (u) => {
      calls.push(String(u));
      return new Response("ok");
    };
    try {
      const env = { APPS_SCRIPT_URL: "https://script.example/exec", WEBHOOK_SECRET: "k1" };
      const post = (h) => new Request("https://w/", { method: "POST", headers: h, body: "{}" });
      expect((await worker.fetch(post({}), env, ctx)).status).toBe(401);
      expect((await worker.fetch(post({ "X-Telegram-Bot-Api-Secret-Token": "k1" }), env, ctx)).status).toBe(200);
      expect(calls).toEqual(["https://script.example/exec?k=k1"]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("slow updates go through the queue", () => {
  const dm = (text, extra = {}) => ({ message: { chat: { id: 1, type: "private" }, text, ...extra } });
  const tap = (data) => ({ callback_query: { data } });

  it("classifies LLM / Apps Script work as slow", () => {
    expect(
      [
        dm("/ask food?"),
        dm("/register a@x.com"),
        dm("/export"),
        dm("Sent Rs.250.00 From HDFC Bank A/C *1234 To SWIGGY On 05/10/26 Ref 628012345678"),
        dm("October", { reply_to_message: { message_id: 5 } }),
        tap("rr_X"),
        tap("export_sheet_all"),
        tap("resend_setup")
      ].map(isSlowUpdate)
    ).toEqual([true, true, true, true, true, true, true, true]);
    expect(
      [dm("/help"), dm("/stats"), dm("Coffee"), tap("rra_X"), tap("cat_X_1"), tap("gsp:X:-1:50")].map(isSlowUpdate)
    ).toEqual([false, false, false, false, false, false]);
  });

  it("queues slow updates, handles the rest inline, and falls back when the queue fails", async () => {
    const sent = [];
    const waited = [];
    const ctx = { waitUntil: (p) => waited.push(p) };
    const env = {
      MODE: "native",
      DB: createTestD1(),
      UPDATES: { send: async (u) => sent.push(u) }
    };
    const post = (u) => new Request("https://w/", { method: "POST", body: JSON.stringify(u) });
    await worker.fetch(post(dm("/ask x")), env, ctx);
    expect(sent).toHaveLength(1);
    expect(waited).toHaveLength(0);
    env.UPDATES.send = async () => {
      throw new Error("queue down");
    };
    await worker.fetch(post(dm("/ask y")), env, ctx);
    expect(waited).toHaveLength(1);
    await Promise.allSettled(waited);
  });

  it("the consumer acks every message and does nothing outside native mode", async () => {
    const acked = [];
    const batch = { messages: [{ body: {}, ack: () => acked.push(1) }] };
    await worker.queue(batch, {});
    expect(acked).toEqual([1]);
  });
});

describe("utilities", () => {
  it("ulid is 26 Crockford chars and sorts by time", () => {
    const a = ulid(1000);
    const b = ulid(2000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
    expect(ulid()).not.toBe(ulid());
  });

  it("money converts to a fixed ×100 integer scale", () => {
    expect(toMinor("1,23,456.78")).toBe(12345678);
    expect(toMinor(12.99)).toBe(1299);
    expect(fromMinor(1299)).toBe(12.99);
    expect(() => toMinor("abc")).toThrow();
  });

  it("defaultKind maps categories to kinds", () => {
    expect(defaultKind("debit", "Food & Dining")).toBe("spend");
    expect(defaultKind("debit", "CC Bill Payment")).toBe("card_payment");
    expect(defaultKind("debit", "Transfer Out")).toBe("transfer");
    expect(defaultKind("debit", "Investment")).toBe("investment");
    expect(defaultKind("credit", "Salary")).toBe("income");
    expect(defaultKind("credit", "Refund")).toBe("refund");
    expect(defaultKind("credit", "Transfer In")).toBe("transfer");
  });

  it("date helpers shift ISO dates across months and use IST for 'today'", () => {
    expect(shiftIsoDate("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftIsoDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(istDate(Date.UTC(2026, 9, 7, 19, 0))).toBe("2026-10-08");
  });
});
