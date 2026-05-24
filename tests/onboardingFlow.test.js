import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadAppsScript } from "./_loader.js";

const TENANT_STATUS = { ACTIVE: "active", PENDING: "pending", DISABLED: "disabled" };

// In-memory PropertiesService that records writes/deletes.
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

function makeStubs(overrides) {
  var props = makeProps();
  var sent = [];
  var emailed = [];
  var stubs = {
    TENANT_STATUS: TENANT_STATUS,
    PropertiesService: props.api,
    TRANSACTION_SENDERS: ["alerts@hdfcbank.net"],
    FILTER_OTP_SUBJECTS: ["OTP"],
    BOT_INBOX_EMAIL: "bot@inbox.test",
    DEMO_VIDEO_URL: "https://demo.example",
    SETUP_GUIDE_URL: "https://guide.example",
    sendTelegramMessage: (chat, text, opts) => sent.push({ chat: chat, text: text, opts: opts }),
    answerCallbackQuery: vi.fn(),
    sheetUrl: (id) => "https://sheets/" + id,
    sameChatId: (a, b) => String(a) === String(b),
    findTenantByChatId: vi.fn(() => null),
    findTenantByEmail: vi.fn(() => null),
    findPendingTenantByEmail: vi.fn(() => null),
    upsertPendingTenant: vi.fn(),
    activateTenant: vi.fn(() => true),
    adminProvisionTenantSheet: vi.fn(() => "sheet-id-xyz"),
    consumePendingGroupInvitesForUser: vi.fn(),
    handleHelpCommand: vi.fn(),
    buildVerifyForwardingUrl: vi.fn((url, chat) => url + "?verify=" + chat),
    ScriptApp: { getService: () => ({ getUrl: () => "https://script.test/exec" }) },
    MailApp: { sendEmail: vi.fn() }
  };
  Object.assign(stubs, overrides || {});
  return { stubs: stubs, props: props, sent: sent, emailed: emailed };
}

const SYMBOLS = [
  "handleStartCommand",
  "handleRegisterCommand",
  "handleRegisterEmailReply",
  "registerEmailForChat",
  "getWebAppUrl",
  "sendSetupInstructions",
  "handleAccountCommand",
  "handleResendSetupCallback",
  "activatePendingTenantForEmail",
  "gateTenantForCommand"
];

function load(stubs) {
  return loadAppsScript(["Onboarding.js"], SYMBOLS, stubs);
}

describe("handleStartCommand", () => {
  it("delegates to handleHelpCommand when an ACTIVE tenant already exists", () => {
    var env = makeStubs({
      findTenantByChatId: () => ({ chat_id: "1", status: TENANT_STATUS.ACTIVE, emails: ["a@b.com"] })
    });
    var api = load(env.stubs);
    api.handleStartCommand("1", "alice");

    expect(env.stubs.handleHelpCommand).toHaveBeenCalledWith("1", "alice");
    expect(env.sent).toEqual([]); // help command path; no welcome message sent here
  });

  it("sends the welcome message for new chats and personalises with username", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.handleStartCommand("1", "alice");

    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].text).toMatch(/Hey alice/);
    expect(env.sent[0].text).toMatch(/register/);
    expect(env.sent[0].opts.disable_web_page_preview).toBe(true);
  });

  it("omits the greeting prefix when username is empty", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.handleStartCommand("1", "");

    expect(env.sent[0].text.startsWith("✌️ Track")).toBe(true);
  });
});

describe("handleRegisterCommand", () => {
  it("stashes the pending_register flag and prompts when no address is supplied", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.handleRegisterCommand("42", "alice", "/register");

    expect(env.props.store.pending_register_42).toBe("1");
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].text).toMatch(/What's the Gmail address/);
  });

  it("dispatches to registerEmailForChat when an address is supplied inline", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.handleRegisterCommand("42", "alice", "/register me@example.com");

    // upsert was called → registerEmailForChat path ran.
    expect(env.stubs.upsertPendingTenant).toHaveBeenCalledWith("42", "me@example.com", "alice");
    expect(env.props.store.pending_register_42).toBeUndefined();
  });
});

describe("handleRegisterEmailReply", () => {
  it("returns false (does not consume) when no pending flag is set", () => {
    var env = makeStubs();
    var api = load(env.stubs);

    expect(api.handleRegisterEmailReply("42", "alice", "me@example.com")).toBe(false);
    expect(env.stubs.upsertPendingTenant).not.toHaveBeenCalled();
  });

  it("consumes the reply, clears the flag, and registers the trimmed address", () => {
    var env = makeStubs();
    env.props.store.pending_register_42 = "1";
    var api = load(env.stubs);

    expect(api.handleRegisterEmailReply("42", "alice", "  me@example.com  ")).toBe(true);
    expect(env.props.store.pending_register_42).toBeUndefined();
    expect(env.stubs.upsertPendingTenant).toHaveBeenCalledWith("42", "me@example.com", "alice");
  });
});

describe("registerEmailForChat", () => {
  it("rejects malformed email addresses", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.registerEmailForChat("1", "alice", "not-an-email");

    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].text).toMatch(/doesn't look like a valid email/);
    expect(env.stubs.upsertPendingTenant).not.toHaveBeenCalled();
  });

  it("rejects an email already attached to a different tenant (active conflict)", () => {
    var env = makeStubs({
      findTenantByEmail: () => ({ chat_id: "999", emails: ["me@x.com"] })
    });
    var api = load(env.stubs);
    api.registerEmailForChat("1", "alice", "me@x.com");

    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].text).toMatch(/already registered to another account/);
    expect(env.stubs.upsertPendingTenant).not.toHaveBeenCalled();
  });

  it("rejects an email already attached to a different pending tenant", () => {
    var env = makeStubs({
      findPendingTenantByEmail: () => ({ chat_id: "999", emails: ["me@x.com"] })
    });
    var api = load(env.stubs);
    api.registerEmailForChat("1", "alice", "me@x.com");

    expect(env.sent[0].text).toMatch(/already registered/);
    expect(env.stubs.upsertPendingTenant).not.toHaveBeenCalled();
  });

  it("allows same-chat re-registration (merge case)", () => {
    var env = makeStubs({
      findTenantByEmail: () => ({ chat_id: "1", emails: ["me@x.com"] }),
      findTenantByChatId: () => null
    });
    var api = load(env.stubs);
    api.registerEmailForChat("1", "alice", "me@x.com");

    expect(env.stubs.upsertPendingTenant).toHaveBeenCalledWith("1", "me@x.com", "alice");
  });

  it("normalizes the email to lowercase before persisting", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.registerEmailForChat("1", "alice", "  Me@Example.COM  ");

    expect(env.stubs.upsertPendingTenant).toHaveBeenCalledWith("1", "me@example.com", "alice");
  });

  it("on extending an ACTIVE tenant: sends the 'added to forwarder list' DM + setup email for only the new addr", () => {
    var calls = 0;
    var env = makeStubs({
      findTenantByChatId: vi.fn(() => {
        calls++;
        // First call (pre-upsert): existing emails. Second call (post-upsert): updated list.
        return calls === 1
          ? { chat_id: "1", status: TENANT_STATUS.ACTIVE, emails: ["a@b.com"] }
          : { chat_id: "1", status: TENANT_STATUS.ACTIVE, emails: ["a@b.com", "new@x.com"] };
      })
    });
    var api = load(env.stubs);
    api.registerEmailForChat("1", "alice", "new@x.com");

    // Two messages: the "added" ack and the setup-instructions ack.
    expect(env.sent).toHaveLength(2);
    expect(env.sent[0].text).toMatch(/Added.*new@x\.com/s);
    expect(env.sent[0].text).toMatch(/a@b\.com/); // shows the full list
    // MailApp.sendEmail target should be ONLY the newly-added forwarder.
    expect(env.stubs.MailApp.sendEmail).toHaveBeenCalledTimes(1);
    expect(env.stubs.MailApp.sendEmail.mock.calls[0][0].to).toBe("new@x.com");
  });

  it("on first-time pending registration: sends only the setup-instructions ack", () => {
    var calls = 0;
    var env = makeStubs({
      findTenantByChatId: () => {
        calls++;
        return calls === 1
          ? null // pre-upsert
          : { chat_id: "1", status: TENANT_STATUS.PENDING, emails: ["new@x.com"] }; // post-upsert (inside sendSetupInstructions)
      }
    });
    var api = load(env.stubs);
    api.registerEmailForChat("1", "alice", "new@x.com");

    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].text).toMatch(/Auto-forwarding setup emailed to/);
    expect(env.stubs.MailApp.sendEmail).toHaveBeenCalledTimes(1);
    expect(env.stubs.MailApp.sendEmail.mock.calls[0][0].to).toBe("new@x.com");
  });
});

describe("getWebAppUrl", () => {
  it("returns the WEBAPP_URL script property when set", () => {
    var env = makeStubs();
    env.props.store.WEBAPP_URL = "https://stored.example/exec";
    var api = load(env.stubs);

    expect(api.getWebAppUrl()).toBe("https://stored.example/exec");
  });

  it("falls back to ScriptApp.getService().getUrl() when the property is unset", () => {
    var env = makeStubs();
    var api = load(env.stubs);

    expect(api.getWebAppUrl()).toBe("https://script.test/exec");
  });

  it("returns null when both lookups fail", () => {
    var env = makeStubs({
      ScriptApp: {
        getService: () => {
          throw new Error("not deployed");
        }
      }
    });
    var api = load(env.stubs);

    expect(api.getWebAppUrl()).toBeNull();
  });
});

describe("sendSetupInstructions", () => {
  it("warns the user when there is no registered email yet", () => {
    var env = makeStubs({
      findTenantByChatId: () => ({ chat_id: "1", status: TENANT_STATUS.PENDING, emails: [] })
    });
    var api = load(env.stubs);
    api.sendSetupInstructions("1");

    expect(env.stubs.MailApp.sendEmail).not.toHaveBeenCalled();
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].text).toMatch(/No registered email yet/);
  });

  it("emails every registered address when no subset is provided", () => {
    var env = makeStubs({
      findTenantByChatId: () => ({ chat_id: "1", status: TENANT_STATUS.ACTIVE, emails: ["a@x.com", "b@x.com"] })
    });
    var api = load(env.stubs);
    api.sendSetupInstructions("1");

    expect(env.stubs.MailApp.sendEmail).toHaveBeenCalledTimes(1);
    expect(env.stubs.MailApp.sendEmail.mock.calls[0][0].to).toBe("a@x.com,b@x.com");
    expect(env.sent[0].text).toMatch(/a@x\.com.*b@x\.com/s);
  });

  it("emails only the subset when onlyEmails is provided", () => {
    var env = makeStubs({
      findTenantByChatId: () => ({ chat_id: "1", status: TENANT_STATUS.ACTIVE, emails: ["a@x.com", "b@x.com"] })
    });
    var api = load(env.stubs);
    api.sendSetupInstructions("1", ["b@x.com"]);

    expect(env.stubs.MailApp.sendEmail.mock.calls[0][0].to).toBe("b@x.com");
  });

  it("falls back to a friendly Telegram error when MailApp throws", () => {
    var env = makeStubs({
      findTenantByChatId: () => ({ chat_id: "1", status: TENANT_STATUS.PENDING, emails: ["a@x.com"] }),
      MailApp: {
        sendEmail: vi.fn(() => {
          throw new Error("quota");
        })
      }
    });
    var api = load(env.stubs);
    api.sendSetupInstructions("1");

    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].text).toMatch(/Couldn't email setup instructions/);
  });
});

describe("handleAccountCommand", () => {
  it("nudges to /start when there's no tenant on file", () => {
    var env = makeStubs();
    var api = load(env.stubs);
    api.handleAccountCommand("1");

    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].text).toMatch(/Use `\/start`/);
    expect(env.sent[0].opts.reply_markup).toBeUndefined();
  });

  it("renders status + emails + sheet hint + resend button for an ACTIVE tenant", () => {
    var env = makeStubs({
      findTenantByChatId: () => ({
        chat_id: "1",
        status: TENANT_STATUS.ACTIVE,
        name: "Alice",
        emails: ["a@x.com"],
        sheet_id: "sheet-1"
      })
    });
    var api = load(env.stubs);
    api.handleAccountCommand("1");

    var msg = env.sent[0];
    expect(msg.text).toMatch(/Status.*active/s);
    expect(msg.text).toMatch(/Name: Alice/);
    expect(msg.text).toMatch(/a@x\.com/);
    // Sheet URL is intentionally NOT in /account anymore — user opens via Gmail share notification.
    expect(msg.text).not.toMatch(/https:\/\/sheets\//);
    expect(msg.text).toMatch(/Sheet: shared with `a@x\.com`/);
    expect(msg.opts.reply_markup.inline_keyboard[0][0].callback_data).toBe("resend_setup");
  });

  it("indicates 'sheet not provisioned yet' for a PENDING tenant", () => {
    var env = makeStubs({
      findTenantByChatId: () => ({
        chat_id: "1",
        status: TENANT_STATUS.PENDING,
        name: "Alice",
        emails: ["a@x.com"],
        sheet_id: null
      })
    });
    var api = load(env.stubs);
    api.handleAccountCommand("1");

    expect(env.sent[0].text).toMatch(/not provisioned yet/);
  });

  it("omits the resend button when the tenant has no registered emails", () => {
    var env = makeStubs({
      findTenantByChatId: () => ({
        chat_id: "1",
        status: TENANT_STATUS.PENDING,
        name: "",
        emails: [],
        sheet_id: null
      })
    });
    var api = load(env.stubs);
    api.handleAccountCommand("1");

    expect(env.sent[0].opts.reply_markup).toBeUndefined();
  });
});

describe("handleResendSetupCallback", () => {
  it("acks the callback and re-sends setup instructions", () => {
    var env = makeStubs({
      findTenantByChatId: () => ({ chat_id: "1", status: TENANT_STATUS.ACTIVE, emails: ["a@x.com"] })
    });
    var api = load(env.stubs);
    api.handleResendSetupCallback("1", "cb-123");

    expect(env.stubs.answerCallbackQuery).toHaveBeenCalledWith("cb-123", "📬 Sending...", false);
    expect(env.stubs.MailApp.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("still resends even when the ack-callback throws (network blip)", () => {
    var env = makeStubs({
      findTenantByChatId: () => ({ chat_id: "1", status: TENANT_STATUS.ACTIVE, emails: ["a@x.com"] }),
      answerCallbackQuery: vi.fn(() => {
        throw new Error("network");
      })
    });
    var api = load(env.stubs);
    api.handleResendSetupCallback("1", "cb-123");

    expect(env.stubs.MailApp.sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe("activatePendingTenantForEmail", () => {
  it("returns null when no pending tenant matches the email", () => {
    var env = makeStubs();
    var api = load(env.stubs);

    expect(api.activatePendingTenantForEmail("nope@x.com")).toBeNull();
    expect(env.stubs.adminProvisionTenantSheet).not.toHaveBeenCalled();
  });

  it("DMs the tenant + returns null when provisioning throws", () => {
    var env = makeStubs({
      findPendingTenantByEmail: () => ({ chat_id: "1", name: "Alice" }),
      adminProvisionTenantSheet: vi.fn(() => {
        throw new Error("drive quota");
      })
    });
    var api = load(env.stubs);

    expect(api.activatePendingTenantForEmail("a@x.com")).toBeNull();
    expect(env.sent[0].text).toMatch(/couldn't create your sheet/);
  });

  it("returns null when activateTenant fails (registry write blocked)", () => {
    var env = makeStubs({
      findPendingTenantByEmail: () => ({ chat_id: "1", name: "Alice" }),
      activateTenant: vi.fn(() => false)
    });
    var api = load(env.stubs);

    expect(api.activatePendingTenantForEmail("a@x.com")).toBeNull();
  });

  it("on happy path: provisions, activates, DMs welcome (no sheet URL), runs retro-add", () => {
    var env = makeStubs({
      findPendingTenantByEmail: () => ({ chat_id: "1", name: "Alice" }),
      findTenantByChatId: () => ({ chat_id: "1", status: TENANT_STATUS.ACTIVE, name: "Alice" })
    });
    var api = load(env.stubs);

    var activated = api.activatePendingTenantForEmail("a@x.com");
    expect(activated.chat_id).toBe("1");
    expect(env.stubs.adminProvisionTenantSheet).toHaveBeenCalledWith("Alice", "a@x.com");
    expect(env.stubs.activateTenant).toHaveBeenCalledWith("1", "sheet-id-xyz");
    expect(env.sent[0].text).toMatch(/Your first transaction is in/);
    expect(env.sent[0].text).toMatch(/Google just emailed you a share notification/);
    // Sheet URL is intentionally NOT in the welcome DM — user opens via Gmail share notification.
    expect(env.sent[0].opts.reply_markup).toBeUndefined();
    expect(env.stubs.consumePendingGroupInvitesForUser).toHaveBeenCalledWith("1", "Alice");
  });

  it("falls back to chat_id as the sheet label when name is empty", () => {
    var env = makeStubs({
      findPendingTenantByEmail: () => ({ chat_id: "42", name: "" }),
      findTenantByChatId: () => ({ chat_id: "42", status: TENANT_STATUS.ACTIVE, name: "" })
    });
    var api = load(env.stubs);
    api.activatePendingTenantForEmail("a@x.com");

    expect(env.stubs.adminProvisionTenantSheet).toHaveBeenCalledWith("42", "a@x.com");
  });

  it("still returns the activated tenant when the welcome DM throws", () => {
    var env = makeStubs({
      findPendingTenantByEmail: () => ({ chat_id: "1", name: "Alice" }),
      findTenantByChatId: () => ({ chat_id: "1", status: TENANT_STATUS.ACTIVE, name: "Alice" }),
      sendTelegramMessage: vi.fn(() => {
        throw new Error("blocked by user");
      })
    });
    var api = load(env.stubs);

    var activated = api.activatePendingTenantForEmail("a@x.com");
    expect(activated).not.toBeNull();
    // Retro-add still runs.
    expect(env.stubs.consumePendingGroupInvitesForUser).toHaveBeenCalled();
  });

  it("still returns the activated tenant when retro-add throws", () => {
    var env = makeStubs({
      findPendingTenantByEmail: () => ({ chat_id: "1", name: "Alice" }),
      findTenantByChatId: () => ({ chat_id: "1", status: TENANT_STATUS.ACTIVE, name: "Alice" }),
      consumePendingGroupInvitesForUser: vi.fn(() => {
        throw new Error("registry locked");
      })
    });
    var api = load(env.stubs);

    var activated = api.activatePendingTenantForEmail("a@x.com");
    expect(activated).not.toBeNull();
  });
});

describe("gateTenantForCommand", () => {
  it("returns true and is silent for ACTIVE tenants", () => {
    var env = makeStubs({
      findTenantByChatId: () => ({ chat_id: "1", status: TENANT_STATUS.ACTIVE, emails: ["a@x.com"] })
    });
    var api = load(env.stubs);

    expect(api.gateTenantForCommand("1")).toBe(true);
    expect(env.sent).toEqual([]);
  });

  it("returns false and prompts for forward when tenant is PENDING", () => {
    var env = makeStubs({
      findTenantByChatId: () => ({ chat_id: "1", status: TENANT_STATUS.PENDING, emails: ["a@x.com"] })
    });
    var api = load(env.stubs);

    expect(api.gateTenantForCommand("1")).toBe(false);
    expect(env.sent[0].text).toMatch(/setup isn't active yet/);
  });

  it("returns false and prompts /start when no tenant exists", () => {
    var env = makeStubs();
    var api = load(env.stubs);

    expect(api.gateTenantForCommand("1")).toBe(false);
    expect(env.sent[0].text).toMatch(/Send `\/start`/);
  });
});
