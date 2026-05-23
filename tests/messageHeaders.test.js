import { describe, it, expect, beforeEach } from "vitest";
import { loadAppsScript } from "./_loader.js";

// Mirrors Constants.js so we don't have to load Constants.js (it depends on
// BOT_TOKEN being globally defined, which other tests deliberately avoid).
const IGNORE_SENDERS = ["noreply@marketing.bank.com", '"alerts@promo.bank.com"'];
const IGNORE_SUBJECTS = ["survey", '"feedback request"'];
const BANK_FROM_DOMAINS = ["hdfcbank.net", "icicibank.com", "axisbank.com"];

function loadHelpers() {
  return loadAppsScript(
    ["TransactionProcessor.js"],
    ["getMessageHeaders", "shouldIgnoreByHeaders", "isBankFromHeader"],
    { IGNORE_SENDERS, IGNORE_SUBJECTS, BANK_FROM_DOMAINS, Gmail: { Users: { Messages: { get: () => ({}) } } } }
  );
}

describe("getMessageHeaders", () => {
  let gmail;

  function load() {
    return loadAppsScript(["TransactionProcessor.js"], ["getMessageHeaders"], { Gmail: gmail }).getMessageHeaders;
  }

  beforeEach(() => {
    gmail = { Users: { Messages: { get: () => ({}) } } };
  });

  it("requests format=metadata with the expected metadataHeaders list", () => {
    var getArgs = null;
    gmail.Users.Messages.get = (userId, id, params) => {
      getArgs = { userId, id, params };
      return { id: id, payload: { headers: [] } };
    };
    var getMessageHeaders = load();

    getMessageHeaders("msg_xyz");

    expect(getArgs.userId).toBe("me");
    expect(getArgs.id).toBe("msg_xyz");
    expect(getArgs.params.format).toBe("metadata");
    expect(getArgs.params.metadataHeaders.sort()).toEqual(["From", "Subject", "X-Forwarded-For"].sort());
  });

  it("parses headers case-insensitively into the headers object", () => {
    gmail.Users.Messages.get = () => ({
      id: "m1",
      internalDate: "1716480000000",
      payload: {
        headers: [
          { name: "From", value: "alerts@hdfcbank.net" },
          { name: "subject", value: "Txn Alert" },
          { name: "X-FORWARDED-FOR", value: "alice@gmail.com dest@gmail.com" }
        ]
      }
    });

    var headers = load()("m1");

    expect(headers).toEqual({
      id: "m1",
      internalDate: 1716480000000,
      from: "alerts@hdfcbank.net",
      subject: "Txn Alert",
      xForwardedFor: "alice@gmail.com dest@gmail.com"
    });
  });

  it("defaults missing headers to empty string", () => {
    gmail.Users.Messages.get = () => ({ id: "m2", payload: { headers: [{ name: "From", value: "x@y.com" }] } });

    var headers = load()("m2");

    expect(headers.from).toBe("x@y.com");
    expect(headers.subject).toBe("");
    expect(headers.xForwardedFor).toBe("");
    expect(headers.internalDate).toBeNull();
  });

  it("returns null when Gmail throws (deleted message, network blip)", () => {
    gmail.Users.Messages.get = () => {
      throw new Error("Not Found");
    };

    expect(load()("missing_id")).toBeNull();
  });

  it("handles a response with no payload.headers gracefully", () => {
    gmail.Users.Messages.get = () => ({ id: "m3", payload: {} });

    var headers = load()("m3");

    expect(headers.from).toBe("");
    expect(headers.subject).toBe("");
    expect(headers.xForwardedFor).toBe("");
  });
});

describe("shouldIgnoreByHeaders", () => {
  let shouldIgnoreByHeaders;

  beforeEach(() => {
    ({ shouldIgnoreByHeaders } = loadHelpers());
  });

  it("drops messages whose From: matches an IGNORE_SENDERS entry", () => {
    expect(shouldIgnoreByHeaders({ from: "noreply@marketing.bank.com", subject: "Anything" })).toBe(true);
  });

  it("strips surrounding double-quotes on ignore tokens before matching", () => {
    expect(shouldIgnoreByHeaders({ from: "alerts@promo.bank.com", subject: "" })).toBe(true);
  });

  it("drops messages whose Subject contains an IGNORE_SUBJECTS token", () => {
    expect(shouldIgnoreByHeaders({ from: "alerts@hdfcbank.net", subject: "Customer Survey 2026" })).toBe(true);
  });

  it("matches case-insensitively against both From and Subject", () => {
    expect(shouldIgnoreByHeaders({ from: "alerts@hdfcbank.net", subject: "FEEDBACK Request please" })).toBe(true);
  });

  it("returns false when neither field matches", () => {
    expect(shouldIgnoreByHeaders({ from: "alerts@hdfcbank.net", subject: "Txn Alert" })).toBe(false);
  });

  it("tolerates missing fields", () => {
    expect(shouldIgnoreByHeaders({})).toBe(false);
  });
});

describe("isBankFromHeader", () => {
  let isBankFromHeader;

  beforeEach(() => {
    ({ isBankFromHeader } = loadHelpers());
  });

  it("matches a substring of any BANK_FROM_DOMAINS entry", () => {
    expect(isBankFromHeader("HDFC Bank <alerts@hdfcbank.net>")).toBe(true);
    expect(isBankFromHeader("alerts@icicibank.com")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isBankFromHeader("ALERTS@HDFCBank.NET")).toBe(true);
  });

  it("returns false for non-bank senders", () => {
    expect(isBankFromHeader("noreply@example.com")).toBe(false);
  });

  it("handles empty / null input", () => {
    expect(isBankFromHeader("")).toBe(false);
    expect(isBankFromHeader(null)).toBe(false);
    expect(isBankFromHeader(undefined)).toBe(false);
  });
});
