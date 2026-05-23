import { describe, it, expect, beforeAll } from "vitest";
import { loadAppsScript } from "./_loader.js";

let extractForwardedFrom, extractForwarderFromHeaders;

beforeAll(() => {
  // TransactionProcessor.js's top level only declares EXTRACTION_TOOLS (a plain
  // array literal). All Apps Script globals are referenced inside functions,
  // so loading is safe with no stubs.
  ({ extractForwardedFrom, extractForwarderFromHeaders } = loadAppsScript(
    ["TransactionProcessor.js"],
    ["extractForwardedFrom", "extractForwarderFromHeaders"]
  ));
});

// Mock GmailMessage with the methods extractForwardedFrom needs.
function mockMsg({ plainBody = "" } = {}) {
  return { getPlainBody: () => plainBody };
}

describe("extractForwardedFrom", () => {
  it("extracts email from a Gmail forward preamble with angle brackets", () => {
    var body = [
      "Some intro text",
      "",
      "---------- Forwarded message ---------",
      "From: HDFC Bank <alerts@hdfcbank.net>",
      "Date: Mon, 1 Apr 2026",
      "Subject: Txn Alert"
    ].join("\n");
    expect(extractForwardedFrom(mockMsg({ plainBody: body }))).toBe("alerts@hdfcbank.net");
  });

  it("extracts bare email when no angle brackets", () => {
    var body = "---------- Forwarded message ---------\nFrom: alerts@axisbank.com\nSubject: x";
    expect(extractForwardedFrom(mockMsg({ plainBody: body }))).toBe("alerts@axisbank.com");
  });

  it("lowercases the result", () => {
    var body = "---------- Forwarded message ---------\nFrom: Bank <ALERTS@HDFCBank.Net>\n";
    expect(extractForwardedFrom(mockMsg({ plainBody: body }))).toBe("alerts@hdfcbank.net");
  });

  it("returns null when no forwarded preamble", () => {
    expect(extractForwardedFrom(mockMsg({ plainBody: "just a regular email" }))).toBe(null);
  });

  it("returns null on empty body", () => {
    expect(extractForwardedFrom(mockMsg({ plainBody: "" }))).toBe(null);
  });
});

describe("extractForwarderFromHeaders", () => {
  it("prefers X-Forwarded-For first address (auto-forward case)", () => {
    expect(
      extractForwarderFromHeaders({
        xForwardedFor: "alice@gmail.com dusaanebot.inbox@gmail.com",
        from: "alerts@hdfcbank.net"
      })
    ).toBe("alice@gmail.com");
  });

  it("handles comma-separated X-Forwarded-For", () => {
    expect(extractForwarderFromHeaders({ xForwardedFor: "alice@gmail.com, dest@gmail.com", from: "x@y.com" })).toBe(
      "alice@gmail.com"
    );
  });

  it("falls back to From: header when X-Forwarded-For is missing (manual forward)", () => {
    expect(extractForwarderFromHeaders({ xForwardedFor: "", from: "Alice <alice@gmail.com>" })).toBe("alice@gmail.com");
  });

  it("strips angle brackets and lowercases From: addresses", () => {
    expect(extractForwarderFromHeaders({ xForwardedFor: "", from: "Bob <BOB@Example.COM>" })).toBe("bob@example.com");
  });

  it("accepts a bare From: address", () => {
    expect(extractForwarderFromHeaders({ xForwardedFor: "", from: "bob@example.com" })).toBe("bob@example.com");
  });

  it("returns null when both headers are empty", () => {
    expect(extractForwarderFromHeaders({ xForwardedFor: "", from: "" })).toBe(null);
  });

  it("returns null when given a null/undefined headers object", () => {
    expect(extractForwarderFromHeaders(null)).toBe(null);
    expect(extractForwarderFromHeaders(undefined)).toBe(null);
  });

  it("ignores X-Forwarded-For entries that aren't emails (defensive)", () => {
    expect(extractForwarderFromHeaders({ xForwardedFor: "not-an-email", from: "alice@gmail.com" })).toBe(
      "alice@gmail.com"
    );
  });
});
