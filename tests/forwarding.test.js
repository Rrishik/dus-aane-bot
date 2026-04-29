import { describe, it, expect, beforeAll, vi } from "vitest";
import { loadAppsScript } from "./_loader.js";

let signVerifyToken,
  verifyVerifyToken,
  buildVerifyForwardingUrl,
  extractForwardingConfirmUrl,
  handleVerifyForwardingClick,
  confirmForwardingAddresses;

// Capture state for stubs so tests can assert against it.
var propsStore;
var fetchedUrls;
var sentTelegramMessages;
var fakeThreads;

function makeMessage(subject, body) {
  return {
    getSubject: () => subject,
    getPlainBody: () => body,
    getBody: () => body
  };
}

function makeThread(messages) {
  var marked = false;
  return {
    getMessages: () => messages,
    markRead: () => {
      marked = true;
    },
    wasMarkedRead: () => marked
  };
}

beforeAll(() => {
  propsStore = {};
  fetchedUrls = [];
  sentTelegramMessages = [];
  fakeThreads = [];

  ({
    signVerifyToken,
    verifyVerifyToken,
    buildVerifyForwardingUrl,
    extractForwardingConfirmUrl,
    handleVerifyForwardingClick,
    confirmForwardingAddresses
  } = loadAppsScript(
    ["Forwarding.js"],
    [
      "signVerifyToken",
      "verifyVerifyToken",
      "buildVerifyForwardingUrl",
      "extractForwardingConfirmUrl",
      "handleVerifyForwardingClick",
      "confirmForwardingAddresses"
    ],
    {
      BOT_INBOX_EMAIL: "bot@gmail.com",
      PropertiesService: {
        getScriptProperties: () => ({
          getProperty: (k) => (k in propsStore ? propsStore[k] : null),
          setProperty: (k, v) => {
            propsStore[k] = v;
          }
        })
      },
      Utilities: {
        getUuid: () => "uuid-" + Math.random().toString(36).slice(2),
        base64EncodeWebSafe: (s) => {
          // Accept both string and byte-array inputs (Apps Script returns bytes
          // from computeHmacSha256Signature). Stringify for deterministic test
          // output.
          if (Array.isArray(s)) return Buffer.from(s).toString("base64url");
          if (s && typeof s === "object" && typeof s.length === "number") {
            return Buffer.from(s).toString("base64url");
          }
          return Buffer.from(String(s), "utf8").toString("base64url");
        },
        computeHmacSha256Signature: (payload, key) => {
          // Deterministic fake HMAC: bytes of `${key}|${payload}`. Good enough
          // for sign/verify roundtrip + tamper detection.
          return Buffer.from(String(key) + "|" + String(payload), "utf8");
        }
      },
      GmailApp: {
        search: (q) => {
          fetchedUrls.lastSearchQuery = q;
          return fakeThreads;
        }
      },
      UrlFetchApp: {
        fetch: (url) => {
          fetchedUrls.push(url);
          return {
            getResponseCode: () => 200,
            getContentText: () => "ok"
          };
        }
      },
      sendTelegramMessage: (chatId, msg) => {
        sentTelegramMessages.push({ chatId: chatId, msg: msg });
        return "{}";
      },
      _escHtml: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    }
  ));
});

describe("signVerifyToken / verifyVerifyToken", () => {
  it("roundtrips for matching chatId + iat", () => {
    var iat = 1700000000000;
    var sig = signVerifyToken("12345", iat);
    expect(verifyVerifyToken("12345", iat, sig, iat + 1000)).toBe(true);
  });

  it("rejects tampered chatId", () => {
    var iat = 1700000000000;
    var sig = signVerifyToken("12345", iat);
    expect(verifyVerifyToken("99999", iat, sig, iat + 1000)).toBe(false);
  });

  it("rejects tampered signature", () => {
    var iat = 1700000000000;
    var sig = signVerifyToken("12345", iat);
    expect(verifyVerifyToken("12345", iat, sig + "x", iat + 1000)).toBe(false);
  });

  it("rejects expired token (>7 days old)", () => {
    var iat = 1700000000000;
    var sig = signVerifyToken("12345", iat);
    var farFuture = iat + 8 * 24 * 60 * 60 * 1000;
    expect(verifyVerifyToken("12345", iat, sig, farFuture)).toBe(false);
  });

  it("rejects far-future iat (clock-skew defense)", () => {
    var iat = 1700000000000;
    var sig = signVerifyToken("12345", iat);
    var nowBefore = iat - 5 * 60 * 1000;
    expect(verifyVerifyToken("12345", iat, sig, nowBefore)).toBe(false);
  });

  it("rejects missing fields", () => {
    expect(verifyVerifyToken("", "1", "x", 1)).toBe(false);
    expect(verifyVerifyToken("1", "", "x", 1)).toBe(false);
    expect(verifyVerifyToken("1", "1", "", 1)).toBe(false);
  });
});

describe("buildVerifyForwardingUrl", () => {
  it("appends signed query params to the web-app URL", () => {
    var url = buildVerifyForwardingUrl("https://script.google.com/macros/s/abc/exec", "12345", 1700000000000);
    expect(url).toMatch(/^https:\/\/script\.google\.com\/macros\/s\/abc\/exec\?action=verify_forwarding/);
    expect(url).toContain("&t=12345");
    expect(url).toContain("&iat=1700000000000");
    expect(url).toMatch(/&sig=[A-Za-z0-9_-]+/);
  });

  it("uses & when web-app URL already has a query string", () => {
    var url = buildVerifyForwardingUrl("https://example.com/?x=1", "12345", 1700000000000);
    expect(url).toMatch(/example\.com\/\?x=1&action=verify_forwarding/);
  });
});

describe("extractForwardingConfirmUrl", () => {
  it("extracts the vf-... URL from a typical confirmation body", () => {
    var body = "Confirm by clicking https://mail-settings.google.com/mail/vf-%5BANGjdJ_xyz%5D-AbC123 then refresh.";
    var url = extractForwardingConfirmUrl(body);
    expect(url).toBe("https://mail-settings.google.com/mail/vf-%5BANGjdJ_xyz%5D-AbC123");
  });

  it("returns null when no vf URL present", () => {
    expect(extractForwardingConfirmUrl("No confirmation link here.")).toBe(null);
    expect(extractForwardingConfirmUrl("")).toBe(null);
    expect(extractForwardingConfirmUrl(null)).toBe(null);
  });
});

describe("confirmForwardingAddresses", () => {
  it("fetches the vf URL for each unread thread and reports counts", () => {
    fakeThreads.length = 0;
    fetchedUrls.length = 0;
    fakeThreads.push(
      makeThread([
        makeMessage(
          "(#1) Gmail Forwarding Confirmation - Receive Mail from user@example.com",
          "Click https://mail-settings.google.com/mail/vf-token1 to confirm."
        )
      ]),
      makeThread([
        makeMessage(
          "(#2) Gmail Forwarding Confirmation - Receive Mail from other@example.com",
          "Visit https://mail-settings.google.com/mail/vf-token2 to confirm."
        )
      ])
    );
    var result = confirmForwardingAddresses();
    expect(result.confirmed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.addresses).toEqual(["user@example.com", "other@example.com"]);
    expect(fetchedUrls).toContain("https://mail-settings.google.com/mail/vf-token1");
    expect(fetchedUrls).toContain("https://mail-settings.google.com/mail/vf-token2");
  });

  it("counts threads with no extractable URL as failed", () => {
    fakeThreads.length = 0;
    fetchedUrls.length = 0;
    fakeThreads.push(makeThread([makeMessage("Gmail Forwarding Confirmation", "No link in body.")]));
    var result = confirmForwardingAddresses();
    expect(result.confirmed).toBe(0);
    expect(result.failed).toBe(1);
  });
});

describe("handleVerifyForwardingClick", () => {
  it("returns success HTML when token valid and confirmation found", () => {
    fakeThreads.length = 0;
    fetchedUrls.length = 0;
    sentTelegramMessages.length = 0;
    fakeThreads.push(
      makeThread([
        makeMessage(
          "Gmail Forwarding Confirmation - Receive Mail from u@example.com",
          "Confirm: https://mail-settings.google.com/mail/vf-abc"
        )
      ])
    );
    var iat = Date.now();
    var sig = signVerifyToken("777", iat);
    var html = handleVerifyForwardingClick({ t: "777", iat: String(iat), sig: sig });
    expect(html).toContain("Forwarding address verified");
    expect(html).toContain("u@example.com");
    expect(sentTelegramMessages.length).toBe(1);
    expect(sentTelegramMessages[0].chatId).toBe(777);
  });

  it("returns invalid-link HTML when token signature is bad", () => {
    var html = handleVerifyForwardingClick({ t: "777", iat: String(Date.now()), sig: "bogus" });
    expect(html).toContain("Link expired or invalid");
  });

  it("returns no-pending-confirmation HTML when inbox has no matching mail", () => {
    fakeThreads.length = 0;
    var iat = Date.now();
    var sig = signVerifyToken("888", iat);
    var html = handleVerifyForwardingClick({ t: "888", iat: String(iat), sig: sig });
    expect(html).toContain("No pending confirmation found");
    expect(html).toContain("bot@gmail.com");
  });
});
