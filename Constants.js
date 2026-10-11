// Apps Script constants: the bot inbox, Gmail filtering and the setup email.

// Public email address that users forward their bank emails to.
const BOT_INBOX_EMAIL = "dusaanebot.inbox@gmail.com";

// Demo + setup-guide links in the setup email. Replace with the real share
// URLs after recording / authoring.
const DEMO_VIDEO_URL = "https://drive.google.com/file/d/REPLACE_WITH_VIDEO_FILE_ID/view";
const SETUP_GUIDE_URL = "https://drive.google.com/file/d/REPLACE_WITH_GUIDE_FILE_ID/view";

// Gmail
// Trigger flow is history-driven (Gmail.Users.History.list) — incremental,
// no time-window scan in the steady state. This constant is used only when
// the script has no `gmail.lastHistoryId` yet (first deploy) or when Gmail
// has invalidated the cursor (~7 days of inactivity), in which case we fall
// back to a one-shot time-window scan to catch in-flight mail.
const BOOTSTRAP_WINDOW_MINUTES = 70;

// Gmail label applied to messages once the Worker has handled them.
// Applied per-message via the Advanced Gmail Service so multi-message threads
// (some banks reuse subjects → Gmail bundles alerts into one thread) get
// labelled correctly without hiding newer siblings from search.
const PROCESSED_LABEL_NAME = "processed-by-bot";

// Bank sender domains — matched as substrings by Gmail's `from:` operator.
// Add new banks here; no label setup needed.
const BANK_FROM_DOMAINS = [
  "bank.in",
  "bank.com",
  "bank.net",
  "bank.co.in",
  "sbi.co.in",
  "hsbc.co.in",
  "idbi.co.in",
  "idfcfirstbank.com",
  "pnbindia.in",
  "bobmail.in",
  "bankofbaroda.com",
  "bobcard.in",
  "sc.com",
  "standardchartered.com",
  "citi.com",
  "kotak.com",
  "indusind.com",
  "americanexpress.com",
  "goniyo.com",
  "sbicard.com",
  "aubank.in"
];

// Verified transaction-alert senders — exact addresses we expect bank debit/credit
// alerts from. This is the allowlist users should paste into their Gmail filter
// so that only transactional mail (not OTPs, statements, marketing) leaves their
// inbox. Keep narrow; add addresses as users discover them.
const TRANSACTION_SENDERS = [
  "alerts@axis.bank.in",
  "alerts@hdfcbank.net",
  "alert@hdfcbank.net",
  "alerts@hdfcbank.bank.in",
  "alerts@icicibank.com",
  "credit_cards@icicibank.com",
  "credit_cards@icici.bank.in",
  "customernotification@icici.bank.in",
  "credit_cards@axisbank.com",
  "transactionalerts@citibank.com",
  "AlertsfromAmericanExpress@americanexpress.com",
  "AmericanExpress@welcome.americanexpress.com",
  "transaction-alerts@idfcfirstbank.com",
  "transaction.alerts@idfcfirstbank.com",
  "noreply@idfcfirstbank.com",
  "alerts@kotak.com",
  "donotreply@kotak.com",
  "alerts@indusind.com",
  "transactionalert@indusind.com",
  "alerts@sbicard.com",
  "onlinesbicard@sbicard.com",
  "noreply@sbi.co.in",
  "onlinesbi@alerts.sbi.co.in",
  "hsbc@mail.hsbc.co.in",
  "alerts@yes.bank.in",
  "esfb-alerts@equitas.bank.in",
  "donotreply@bobcard.in",
  "aucreditcard.alerts@aubank.in",
  "aucreditcards.alerts@aubank.in"
];

// Specific senders / marketing subdomains to ignore even though they match BANK_FROM_DOMAINS.
// Quote phrases with spaces; plain addresses and subdomains don't need quoting.
const IGNORE_SENDERS = [
  "services@custcomm.icici.bank.in",
  "email.americanexpress.com",
  "cc.statements@axis.bank.in",
  "statements@axis.bank.in",
  "statements@hdfcbank.net",
  "digital.axisbankmail.bank.in",
  "information@yes.bank.in",
  "customer.communication@custcom.yes.bank.in",
  "information@hdfcbank.bank.in",
  "information@mailers.hdfcbank.bank.in",
  "communications.sbi.co.in",
  "no-reply@alerts.sbi.co.in",
  "noreply@alerts.sbi.co.in",
  "cbssbi.info@alerts.sbi.co.in",
  "feedbackemail.americanexpress.com",
  "global@goniyo.com",
  "global.escalation@goniyo.com",
  "paylink.india@citi.com",
  "yonosbi@alerts.sbi.co.in",
  "no-reply@goniyo.com",
  "indusind_bank@indusind.com",
  "yonobysbi@alerts.sbi.co.in",
  "yonobysbi@sbi.co.in",
  "investor@indusind.com",
  "sbm-global@goniyo.com",
  "hsbc@informationservices.hsbc.co.in",
  "custcomm.hsbc.co.in",
  "kycEmailintimation@hdfcbank.bank.in",
  "customer-support@equitas.bank.in",
  "HSBC-CreditCard@notification.hsbc.co.in",
  "hsbc-ckycr@hsbc.co.in",
  "CkycEmailintimation@hdfcbank.bank.in",
  "cmdnoreply@indusind.com",
  "customerinfo@hdfcbank.bank.in",
  "advices@idfcfirst.bank.in",
  "alwaysyoufirst@emailer.idfcfirstbank.com",
  "Creditcard.closure@indusind.com"
];

// Subject keywords/phrases that indicate non-transaction mail (OTPs, statements, security alerts, marketing).
const IGNORE_SUBJECTS = [
  "statement",
  '"e-statement"',
  '"scheduled maintenance"',
  "maintenance",
  "OTP",
  "MPIN",
  '"one time password"',
  '"one-time password"',
  '"temporary security code"',
  '"security code"',
  "verification",
  "verify",
  '"security alert"',
  "password",
  "login",
  '"sign in"',
  '"sign-in"',
  '"trusted device"',
  '"new device"',
  '"device added"',
  '"payment due"',
  '"payment reminder"',
  '"due reminder"',
  '"transaction limit"',
  '"transaction limits"',
  '"upcoming autopay"',
  '"autopay reminder"',
  '"upcoming transaction"',
  '"successful log on"',
  '"logged on"',
  '"logged in"',
  '"pin reset"',
  '"reset pin"',
  '"pin change"',
  '"face id"',
  '"biometric"',
  '"mobile banking"',
  "offer",
  "offers"
];

// Narrow subset of IGNORE_SUBJECTS used in the user-facing Gmail filter
// (the one /setup emails out). Server-side IGNORE_SUBJECTS already drops
// everything non-transactional, so the Gmail filter only needs to prevent
// OTP / auth-code mail from being auto-forwarded — security-sensitive, must
// stay in the user's inbox. Keeping this list short makes the pasted query
// readable and predictable for the user.
const FILTER_OTP_SUBJECTS = [
  "OTP",
  "MPIN",
  '"one time password"',
  '"one-time password"',
  '"temporary security code"',
  '"security code"',
  "verification",
  '"verification code"',
  '"login code"'
];

// Gmail search query: process any email that arrives in the bot inbox.
// The bot account exists only for this bot, so every inbox message is a
// forwarded bank alert. Users forward directly to dusaanebot.inbox@gmail.com.
// The forwarder's email is extracted from the From: header per-message to tag
// the transaction's user.
const GMAIL_SEARCH_QUERY = `in:inbox`;
