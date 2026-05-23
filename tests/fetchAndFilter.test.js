import { describe, it, expect, beforeEach } from "vitest";
import { loadAppsScript } from "./_loader.js";

// Constants stubbed inline (Constants.js itself is hard to load — pulls in
// BOT_TOKEN side-effects). Match the production values that fetchAndFilterMessages
// actually consults.
const PROCESSED_LABEL_NAME = "processed-by-bot";
const GMAIL_SEARCH_QUERY = "in:inbox";
const BANK_FROM_DOMAINS = ["hdfcbank.net", "icicibank.com"];
const IGNORE_SENDERS = ["noreply@marketing.bank.com"];
const IGNORE_SUBJECTS = ["survey"];

// Build a fake Gmail.Users.Messages.list response from a flat list of ids.
function listResponse(ids, nextPageToken) {
  return { messages: ids.map((id) => ({ id: id })), nextPageToken: nextPageToken || undefined };
}

// Build a metadata-format Messages.get response.
function metaResponse(id, { from = "alerts@hdfcbank.net", subject = "Txn", xff = "" } = {}) {
  return {
    id: id,
    internalDate: String(1716480000000),
    payload: {
      headers: [
        { name: "From", value: from },
        { name: "Subject", value: subject },
        ...(xff ? [{ name: "X-Forwarded-For", value: xff }] : [])
      ]
    }
  };
}

function makeMockMsg(id, { from = "alerts@hdfcbank.net", body = "" } = {}) {
  return {
    getId: () => id,
    getFrom: () => from,
    getPlainBody: () => body
  };
}

describe("fetchAndFilterMessages", () => {
  let gmail;
  let gmailApp;
  let fetchAndFilterMessages;

  function load() {
    return loadAppsScript(["TransactionProcessor.js"], ["fetchAndFilterMessages"], {
      PROCESSED_LABEL_NAME,
      GMAIL_SEARCH_QUERY,
      BANK_FROM_DOMAINS,
      IGNORE_SENDERS,
      IGNORE_SUBJECTS,
      Gmail: gmail,
      GmailApp: gmailApp
    }).fetchAndFilterMessages;
  }

  beforeEach(() => {
    gmail = {
      Users: {
        Messages: {
          list: () => ({ messages: [] }),
          get: (_userId, id) => metaResponse(id)
        }
      }
    };
    gmailApp = {
      getMessageById: (id) => makeMockMsg(id)
    };
  });

  it("builds the q with in:inbox, -label:processed-by-bot, after:<sec>", () => {
    var listArgs = null;
    gmail.Users.Messages.list = (_userId, params) => {
      listArgs = params;
      return { messages: [] };
    };

    fetchAndFilterMessages = load();
    var startDate = new Date(1716480000000);
    fetchAndFilterMessages(startDate);

    expect(listArgs.q).toBe("in:inbox -label:processed-by-bot after:1716480000");
    expect(listArgs.maxResults).toBe(500);
    expect(listArgs.pageToken).toBeUndefined();
  });

  it("appends before:<sec> when endDate is provided", () => {
    var listArgs = null;
    gmail.Users.Messages.list = (_userId, params) => {
      listArgs = params;
      return { messages: [] };
    };

    fetchAndFilterMessages = load();
    fetchAndFilterMessages(new Date(1716480000000), new Date(1716566400000));

    expect(listArgs.q).toBe("in:inbox -label:processed-by-bot after:1716480000 before:1716566400");
  });

  it("paginates via nextPageToken and accumulates ids", () => {
    var pages = [listResponse(["m1", "m2"], "tok2"), listResponse(["m3"], "tok3"), listResponse(["m4"])];
    var calls = [];
    var i = 0;
    gmail.Users.Messages.list = (_userId, params) => {
      calls.push(params);
      return pages[i++];
    };

    fetchAndFilterMessages = load();
    var out = fetchAndFilterMessages(new Date(0));

    expect(calls).toHaveLength(3);
    expect(calls[0].pageToken).toBeUndefined();
    expect(calls[1].pageToken).toBe("tok2");
    expect(calls[2].pageToken).toBe("tok3");
    // All four ids survive (default stubs make every message a bank message).
    expect(out.map((e) => e.headers.id)).toEqual(["m4", "m3", "m2", "m1"]); // reversed: oldest-first
  });

  it("returns oldest-first (reverses Gmail's newest-first order)", () => {
    gmail.Users.Messages.list = () => listResponse(["new", "mid", "old"]);

    fetchAndFilterMessages = load();
    var out = fetchAndFilterMessages(new Date(0));

    expect(out.map((e) => e.headers.id)).toEqual(["old", "mid", "new"]);
  });

  it("returns [] when messages.list throws", () => {
    gmail.Users.Messages.list = () => {
      throw new Error("API blip");
    };

    fetchAndFilterMessages = load();

    expect(fetchAndFilterMessages(new Date(0))).toEqual([]);
  });

  it("returns [] when there are no messages", () => {
    gmail.Users.Messages.list = () => ({});

    fetchAndFilterMessages = load();

    expect(fetchAndFilterMessages(new Date(0))).toEqual([]);
  });

  it("drops messages whose getMessageHeaders fails (deleted between list and get)", () => {
    gmail.Users.Messages.list = () => listResponse(["alive", "dead"]);
    gmail.Users.Messages.get = (_userId, id) => {
      if (id === "dead") throw new Error("Not Found");
      return metaResponse(id);
    };

    fetchAndFilterMessages = load();
    var out = fetchAndFilterMessages(new Date(0));

    expect(out.map((e) => e.headers.id)).toEqual(["alive"]);
  });

  it("drops messages matching IGNORE_SENDERS at the metadata stage", () => {
    var bodyFetched = [];
    gmail.Users.Messages.list = () => listResponse(["promo", "real"]);
    gmail.Users.Messages.get = (_userId, id) => {
      if (id === "promo") return metaResponse(id, { from: "noreply@marketing.bank.com" });
      return metaResponse(id);
    };
    gmailApp.getMessageById = (id) => {
      bodyFetched.push(id);
      return makeMockMsg(id);
    };

    fetchAndFilterMessages = load();
    var out = fetchAndFilterMessages(new Date(0));

    expect(out.map((e) => e.headers.id)).toEqual(["real"]);
    // Verifies #2 (defer body fetch): "promo" never hits GmailApp.
    expect(bodyFetched).toEqual(["real"]);
  });

  it("drops messages matching IGNORE_SUBJECTS at the metadata stage", () => {
    gmail.Users.Messages.list = () => listResponse(["survey-msg", "real"]);
    gmail.Users.Messages.get = (_userId, id) => {
      if (id === "survey-msg") return metaResponse(id, { subject: "Customer Survey" });
      return metaResponse(id);
    };

    fetchAndFilterMessages = load();
    var out = fetchAndFilterMessages(new Date(0));

    expect(out.map((e) => e.headers.id)).toEqual(["real"]);
  });

  it("drops messages whose GmailApp body hydrate throws", () => {
    gmail.Users.Messages.list = () => listResponse(["alive", "gone"]);
    gmailApp.getMessageById = (id) => {
      if (id === "gone") throw new Error("Not Found");
      return makeMockMsg(id);
    };

    fetchAndFilterMessages = load();
    var out = fetchAndFilterMessages(new Date(0));

    expect(out.map((e) => e.headers.id)).toEqual(["alive"]);
  });

  it("drops non-bank messages (header check + body preamble both fail)", () => {
    gmail.Users.Messages.list = () => listResponse(["random"]);
    gmail.Users.Messages.get = () => metaResponse("random", { from: "friend@gmail.com" });
    gmailApp.getMessageById = (id) => makeMockMsg(id, { from: "friend@gmail.com", body: "Hey check this out" });

    fetchAndFilterMessages = load();
    var out = fetchAndFilterMessages(new Date(0));

    expect(out).toEqual([]);
  });

  it("keeps non-bank From: messages whose body preamble shows a bank forward (manual forward)", () => {
    gmail.Users.Messages.list = () => listResponse(["fwd"]);
    gmail.Users.Messages.get = () => metaResponse("fwd", { from: "alice@gmail.com" });
    gmailApp.getMessageById = (id) =>
      makeMockMsg(id, {
        from: "alice@gmail.com",
        body: "FYI\n\n---------- Forwarded message ---------\nFrom: HDFC Bank <alerts@hdfcbank.net>\n"
      });

    fetchAndFilterMessages = load();
    var out = fetchAndFilterMessages(new Date(0));

    expect(out).toHaveLength(1);
    expect(out[0].headers.id).toBe("fwd");
  });

  it("returns {msg, headers} pairs (not bare GmailMessage)", () => {
    gmail.Users.Messages.list = () => listResponse(["m1"]);

    fetchAndFilterMessages = load();
    var out = fetchAndFilterMessages(new Date(0));

    expect(out).toHaveLength(1);
    expect(typeof out[0].msg.getId).toBe("function");
    expect(out[0].msg.getId()).toBe("m1");
    expect(out[0].headers).toMatchObject({
      id: "m1",
      from: "alerts@hdfcbank.net"
    });
  });
});

describe("isFromAllowedBank", () => {
  let isFromAllowedBank;

  beforeEach(() => {
    ({ isFromAllowedBank } = loadAppsScript(["TransactionProcessor.js"], ["isFromAllowedBank"], {
      BANK_FROM_DOMAINS
    }));
  });

  it("returns true on a direct bank From: header", () => {
    expect(isFromAllowedBank({ getFrom: () => "HDFC Bank <alerts@hdfcbank.net>", getPlainBody: () => "" })).toBe(true);
  });

  it("returns false when From: is not a bank and body has no forwarded preamble", () => {
    expect(isFromAllowedBank({ getFrom: () => "friend@gmail.com", getPlainBody: () => "hey" })).toBe(false);
  });

  it("returns true when From: is not a bank but body preamble shows a bank forward", () => {
    var msg = {
      getFrom: () => "alice@gmail.com",
      getPlainBody: () => "Forwarded message\nFrom: HDFC Bank <alerts@hdfcbank.net>\n"
    };
    expect(isFromAllowedBank(msg)).toBe(true);
  });

  it("returns false when neither header nor preamble points at a bank", () => {
    var msg = {
      getFrom: () => "alice@gmail.com",
      getPlainBody: () => "Forwarded message\nFrom: random@example.org\n"
    };
    expect(isFromAllowedBank(msg)).toBe(false);
  });

  it("is case-insensitive on bank domain matches", () => {
    expect(isFromAllowedBank({ getFrom: () => "ALERTS@HDFCBank.NET", getPlainBody: () => "" })).toBe(true);
  });
});
