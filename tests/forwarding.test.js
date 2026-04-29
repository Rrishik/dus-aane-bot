import { describe, it, expect, beforeAll, vi } from "vitest";
import { loadAppsScript } from "./_loader.js";

let signVerifyToken,
  verifyVerifyToken,
  buildVerifyForwardingUrl,
  extractForwardingConfirmUrl,
  handleVerifyForwardingClick,
  findPendingForwardingConfirmations;

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
    findPendingForwardingConfirmations
  } = loadAppsScript(
    ["Forwarding.js"],
    [
      "signVerifyToken",
      "verifyVerifyToken",
      "buildVerifyForwardingUrl",
      "extractForwardingConfirmUrl",
      "handleVerifyForwardingClick",
      "findPendingForwardingConfirmations"
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

  // Real-data fixture: actual Gmail forwarding-confirmation mail body (with
  // requester/destination addresses redacted but URL token shape preserved).
  // Contains BOTH the confirm (vf-) and cancel (uf-) URLs in that order, plus
  // the surrounding boilerplate. Guards against three regressions:
  //   1. URL-encoded brackets %5B / %5D in the token must not break matching.
  //   2. The cancel uf- URL must NOT be returned (would silently revoke the
  //      forwarding the user just set up).
  //   3. The plaintext-body shape Gmail actually sends is what we parse, not
  //      a hand-crafted shorter version.
  it("picks the vf- confirm URL and ignores the uf- cancel URL in real Gmail body", () => {
    var body =
      "rishikramena@gmail.com has requested to automatically forward mail to your email\n" +
      "address dus-aane-bot@healthvault.online.\n\n" +
      "To allow rishikramena@gmail.com to automatically forward mail to your address,\n" +
      "please click the link below to confirm the request:\n\n" +
      "https://mail-settings.google.com/mail/vf-%5BANGjdJ9m_MKB23WZVALRU-0FlkRgveaNAcBKL_mqY5e12GFOkDqq0_vhkHANE4XTopLPm-zlfPFqE6yU7Yx6MM-DrgOWDl57RrndnKnAyQ%5D-1W_oD4IDrdOEG6rAF3hEBDp70ME\n\n" +
      "If you click the link and it appears to be broken, please copy and paste it\n" +
      "into a new browser window.\n\n" +
      "If you accidentally clicked the link, click this link to cancel:\n" +
      "https://mail-settings.google.com/mail/uf-%5BANGjdJ80HyFa-p9Zyw-AYBFDWcUzVAw9zXiOHv-_fb1wmap0OClsQ1FTvcjZwskGuFpmgFHD6AhXB8_dB92DKklQQ9ru0tiT7lEQGqhWqg%5D-1W_oD4IDrdOEG6rAF3hEBDp70ME\n";
    var url = extractForwardingConfirmUrl(body);
    expect(url).toMatch(/^https:\/\/mail-settings\.google\.com\/mail\/vf-/);
    expect(url).not.toMatch(/\/uf-/);
    // Sanity: full token captured (no premature termination on -, %, brackets).
    expect(url).toContain("DrgOWDl57RrndnKnAyQ%5D-1W_oD4IDrdOEG6rAF3hEBDp70ME");
  });
});

describe("findPendingForwardingConfirmations", () => {
  it("returns the vf URL and parsed address for each unread thread", () => {
    fakeThreads.length = 0;
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
    var result = findPendingForwardingConfirmations();
    expect(result.urls).toEqual([
      "https://mail-settings.google.com/mail/vf-token1",
      "https://mail-settings.google.com/mail/vf-token2"
    ]);
    expect(result.addresses).toEqual(["user@example.com", "other@example.com"]);
  });

  it("skips threads with no extractable URL", () => {
    fakeThreads.length = 0;
    fakeThreads.push(makeThread([makeMessage("Gmail Forwarding Confirmation", "No link in body.")]));
    var result = findPendingForwardingConfirmations();
    expect(result.urls).toEqual([]);
  });
});

describe("handleVerifyForwardingClick", () => {
  it("returns redirect HTML targeting the vf URL when token valid and confirmation found", () => {
    fakeThreads.length = 0;
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
    expect(html).toContain("Almost there");
    expect(html).toContain("https://mail-settings.google.com/mail/vf-abc");
    expect(html).toContain("u@example.com");
    // top-level redirect (escapes the Apps Script iframe)
    expect(html).toContain("window.top.location.href");
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
