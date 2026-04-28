import { describe, it, expect, beforeAll } from "vitest";
import { loadAppsScript } from "./_loader.js";

let extractForwardedFrom, extractForwarderEmail;

beforeAll(() => {
  // TransactionProcessor.js's top level only declares EXTRACTION_TOOLS (a plain
  // array literal). All Apps Script globals are referenced inside functions,
  // so loading is safe with no stubs.
  ({ extractForwardedFrom, extractForwarderEmail } = loadAppsScript(
    ["TransactionProcessor.js"],
    ["extractForwardedFrom", "extractForwarderEmail"]
  ));
});

// Mock GmailMessage with the methods these helpers actually call.
function mockMsg({ rawContent = "", plainBody = "", from = "" } = {}) {
  return {
    getRawContent: () => rawContent,
    getPlainBody: () => plainBody,
    getFrom: () => from
  };
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

describe("extractForwarderEmail", () => {
  it("prefers X-Forwarded-For first address (auto-forward case)", () => {
    var raw = [
      "Received: from somewhere",
      "X-Forwarded-For: alice@gmail.com dusaanebot.inbox@gmail.com",
      "From: alerts@hdfcbank.net",
      "Subject: Txn",
      "",
      "body"
    ].join("\r\n");
    expect(extractForwarderEmail(mockMsg({ rawContent: raw, from: "alerts@hdfcbank.net" }))).toBe("alice@gmail.com");
  });

  it("handles comma-separated X-Forwarded-For", () => {
    var raw = "X-Forwarded-For: alice@gmail.com, dest@gmail.com\r\nFrom: x@y.com\r\n\r\n";
    expect(extractForwarderEmail(mockMsg({ rawContent: raw, from: "x@y.com" }))).toBe("alice@gmail.com");
  });

  it("unfolds RFC 5322 continuation lines in headers", () => {
    var raw = "X-Forwarded-For:\r\n alice@gmail.com dest@gmail.com\r\nFrom: x@y.com\r\n\r\nbody";
    expect(extractForwarderEmail(mockMsg({ rawContent: raw, from: "x@y.com" }))).toBe("alice@gmail.com");
  });

  it("falls back to From: header when no X-Forwarded-For (manual forward)", () => {
    expect(
      extractForwarderEmail(mockMsg({ rawContent: "From: alice@gmail.com\r\n\r\n", from: "Alice <alice@gmail.com>" }))
    ).toBe("alice@gmail.com");
  });

  it("falls back to From: when raw content is empty", () => {
    expect(extractForwarderEmail(mockMsg({ rawContent: "", from: "Bob <bob@example.com>" }))).toBe("bob@example.com");
  });

  it("returns null when nothing usable is present", () => {
    expect(extractForwarderEmail(mockMsg({ rawContent: "", from: "" }))).toBe(null);
  });

  it("does not match X-Forwarded-For appearing in the body (header-only scan)", () => {
    var raw = "From: alerts@hdfcbank.net\r\n\r\nX-Forwarded-For: spoofed@evil.com other@good.com";
    // Should fall back to From: since the X-Forwarded-For is in the body region.
    expect(extractForwarderEmail(mockMsg({ rawContent: raw, from: "alerts@hdfcbank.net" }))).toBe(
      "alerts@hdfcbank.net"
    );
  });
});
