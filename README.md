# 💰 Dus Aane Bot

Open-source, multi-tenant Telegram bot that reads forwarded bank transaction emails, extracts structured data with an LLM, and logs it to a per-user Google Sheet.

Built on Google Apps Script + a Cloudflare Worker proxy. Self-host your own instance or run it for a group of friends — each tenant gets their own isolated sheet.

- 🔒 **Privacy by construction** — the bot's Gmail only ever receives the narrow allowlist of transaction-alert senders you configure. OTPs, statements, security codes and marketing are excluded at the Gmail-filter layer before anything reaches the bot.
- 🔓 **Auditable** — the full code lives in this repo. See [docs/PRIVACY.md](docs/PRIVACY.md) for what the bot reads, stores and shares.
- 🏠 **Multi-tenant** — one deploy serves many users. Each tenant is onboarded with a single `/register` command after proving inbox ownership.

## How is this different from Cred / Walnut / CashKaro?

Closed-source finance apps typically ask for **full Gmail read access** via OAuth — which means they can (and do) scan everything: OTPs, statements, personal mail, receipts, newsletters. You trust them to look only at what they claim.

Dus Aane Bot inverts that:

|                                       | Cred / Walnut / etc.                          | Dus Aane Bot                                                                  |
| ------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------- |
| **Access scope**                      | Full Gmail read (all mail, all labels)        | Only emails you forward to the bot inbox                                      |
| **OTPs / statements / personal mail** | Readable by the app                           | Never leaves your Gmail                                                       |
| **Data location**                     | Their servers, their schema                   | Your Google Sheet, your account                                               |
| **Export / delete**                   | Via their UI, if offered                      | Native Google Sheets — yours forever                                          |
| **Source code**                       | Closed                                        | [This repo](https://github.com/Rrishik/dus-aane-bot) — audit before you trust |
| **Revoke access**                     | OAuth revoke (still had full read until then) | Delete the Gmail filter                                                       |

The trust model is: you set up a one-time Gmail filter that matches a **fixed allowlist of ~30 verified bank sender addresses** (see [`TRANSACTION_SENDERS`](Constants.js)). Nothing else is ever forwarded. If you don't trust the allowlist, read it — it's in this repo.

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [How is this different from Cred / Walnut / CashKaro?](#how-is-this-different-from-cred--walnut--cashkaro)
- [User onboarding (`/start` → `/register`)](#user-onboarding)
- [Commands](#commands)
- [Admin setup (one-time, per deployment)](#admin-setup)
- [Data model](#data-model)
- [Architecture](#architecture)
- [Project structure](#project-structure)
- [CI/CD](#cicd)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

## Features

- **Multi-tenant** — Tenants registry (`Tenants` tab on the admin sheet) maps `chat_id`/`email` → per-tenant `sheet_id`. Each tenant's transactions are written to their own spreadsheet.
- **AI-powered extraction** — Azure OpenAI with tool calling pulls merchant, amount, date, category, currency and type from emails. Falls back to a `get_merchant_category` tool when unsure.
- **Forward-based ingestion** — Users auto-forward bank emails from their own Gmail to `dusaanebot.inbox@gmail.com`. No Gmail OAuth per user.
- **Smart merchant resolution** — `MerchantResolution` tab maps raw bank strings to clean names (`FLIPKART_MWS_MERCH` → `Flipkart`).
- **Category overrides** — Separate `CategoryOverrides` tab maps merchant → category, reviewable in bulk.
- **Inline action buttons** — `✂️ Split` / `✏️ Category` / `🗑️ Delete` / `🏠 Set Merchant` on every transaction message.
- **Analytics** — `/stats` for monthly/trends/who-owes dashboards; `/ask` for natural-language queries via tool calling.
- **`/backfill`** — reprocess a date range in 5-minute chunks with progress updates.
- **CI/CD** — GitHub Actions push to Apps Script and Cloudflare on every commit to `main`.

## How it works

```
Bank → your Gmail (filter auto-forwards) → dusaanebot.inbox@gmail.com
     → Apps Script (hourly trigger, per-message tenant routing) → your sheet
     → Telegram (transaction DM with inline buttons)
```

1. Each user sets up a Gmail filter that forwards only verified transaction-alert senders (see `TRANSACTION_SENDERS` in [Constants.js](Constants.js)) to the bot inbox.
2. An hourly Apps Script trigger polls the bot inbox, extracts the forwarder's email from the `X-Forwarded-For` or `From:` header, looks up the tenant, and writes to their sheet.
3. For each saved transaction the bot DMs the user with inline buttons for split status, category edit and delete.

The Gmail filter on the user's side is the **primary privacy boundary** — the bot literally never sees mail that doesn't match the allowlist.

## User onboarding

This is the flow once the bot is deployed.

**From Telegram (this chat):**

1. `/start` — bot shows the welcome + 2-step setup
2. **Forward any recent bank transaction email** from your Gmail to `dusaanebot.inbox@gmail.com`
3. `/register your.name@gmail.com` — bot searches its inbox for the forward to prove ownership, then:
   - Provisions a new Google Sheet (a copy of the template)
   - Shares the sheet with `your.name@gmail.com` as editor
   - DMs you the sheet link + a Gmail filter query to automate future forwards

**Automate forwarding (one-time, in your Gmail):**

1. Gmail → Settings → Forwarding and POP/IMAP → **Add forwarding address** → `dusaanebot.inbox@gmail.com`. Gmail emails a verification code to the bot inbox; the bot relays it to you on Telegram.
2. Settings → Filters and Blocked Addresses → **Create a new filter** → paste the query the bot sent you into **Has the words** → **Forward it to** `dusaanebot.inbox@gmail.com`. Optional: **Skip the Inbox** if you don't want these in your Gmail inbox.

From here, every matching transaction email auto-forwards; the hourly trigger processes it and you get a Telegram notification within the hour.

## Commands

| Command                           | Description                                                      |
| --------------------------------- | ---------------------------------------------------------------- |
| `/start`                          | Welcome + onboarding instructions                                |
| `/register <email>`               | Claim a Gmail address (after forwarding a bank email to the bot) |
| `/myinfo`                         | Show your tenant status, registered emails, sheet link           |
| `/recent [N] [user]`              | Recent transactions with optional filters                        |
| `/stats`                          | Analytics dashboard — monthly / trends / who owes                |
| `/ask <question>`                 | AI-powered spending queries (e.g., "food spending last month")   |
| `/help`                           | Show commands                                                    |
| `/backfill 10m`                   | Backfill last N minutes/hours (compact: `10m`, `2h`, `3d`, `1w`) |
| `/backfill 3 days`                | Backfill last N days/weeks/months                                |
| `/backfill YYYY-MM-DD YYYY-MM-DD` | Backfill a date range                                            |

### Inline buttons

Each transaction notification includes action buttons:

- **✂️ Split** — cycles `Personal` → `Split (50/50)` → `Partner (I paid 100% on their behalf)` → `Personal`
- **✏️ Category** — shows a category picker (debit or credit categories based on the row's type)
- **🗑️ Delete** — removes the transaction row
- **🏠 Set Merchant** — shown when the LLM couldn't identify a merchant; you type the name and the category auto-fills if there's a `CategoryOverrides` entry

### New-merchant flow

When a brand-new merchant is detected, two extra buttons appear above the standard row:

- **🆕 Save: `<merchant>` → `<category>`** — one-tap confirm. Writes the resolved name to `MerchantResolution` and the category to `CategoryOverrides`.
- **🏪 Edit Merchant** — force-reply prompt for the merchant name, then shows the category picker. Updates both sheets plus the transaction row.

## Admin setup

Admin = the person deploying and operating the bot. Users don't need any of this.

### Prerequisites

- Dedicated Gmail account for the bot (this is where all tenant forwards land)
- Telegram bot token, Azure OpenAI API key, Cloudflare account (free, for the Telegram proxy Worker)
- Node.js + `npm install -g @google/clasp`

### One-time setup

1. **Bot Gmail account** — create `dusaanebot.inbox@gmail.com` (or your own address — update `BOT_INBOX_EMAIL` in [Constants.js](Constants.js) if different).
2. **Apps Script project** — `clasp login` as the bot Gmail → `clasp create --type standalone --title "dus-aane-bot" --rootDir .`.
3. **Secrets (`AConfig.js`, gitignored)** — create it locally with these constants:
   ```js
   const BOT_TOKEN = "...";
   const ADMIN_CHAT_ID = "..."; // admin / founder chat id (tenant 0)
   const SCRIPT_APP_URL = "https://script.google.com/macros/s/.../exec";
   const WORKER_PROXY_URL = "https://your-worker.workers.dev";
   const ADMIN_SHEET_ID = "..."; // admin sheet — hosts the Tenants registry + tenant 0's data
   const SHEET_NAME = "Transactions";
   const TEMPLATE_SHEET_ID = ""; // filled in step 6 below
   const AZURE_OPENAI_ENDPOINT = "...";
   const AZURE_OPENAI_API_KEY = "...";
   const AZURE_OPENAI_DEPLOYMENT_NAME = "...";
   const AZURE_OPENAI_API_VERSION = "2024-08-01-preview";
   ```
4. `clasp push` → open the project in the script editor → authorize all OAuth scopes (Gmail, Sheets, Drive, URL fetch).
5. Deploy as Web App (execute as bot account, access: Anyone) → note the `/exec` URL + deployment ID.
6. **Create the template sheet** — in the script editor, run `adminCreateTemplateSheet()`. It copies your admin sheet structure, clears the data, and logs the new sheet ID. Put that ID in `AConfig.js` as `TEMPLATE_SHEET_ID` and in the GitHub secret.
7. **Cloudflare Worker** — set `APPS_SCRIPT_URL` secret, `wrangler deploy` (or use the GitHub Actions workflow).
8. **Bot wiring** — from the script editor, run `setTelegramWebhook()` (points Telegram at the worker) and `setTelegramCommands()` (registers the slash-menu).
9. **Trigger** — add an hourly trigger for `triggerEmailProcessing` (Triggers panel in the script editor).
10. **Seed tenant 0** — run `adminSeedTenantZero()` once; optionally `adminAddEmailToTenantZero("you@gmail.com")` for each forwarder.

That's it — the bot is live. Share it with others by just giving them the Telegram handle; they self-onboard with `/start`.

### Updating the bank sender allowlist

Edit `TRANSACTION_SENDERS` in [Constants.js](Constants.js) to add a new bank. The `scripts/gen-gmail-filter.js` script regenerates the Gmail filter query from that list, but **users don't need to re-paste their filter** when you add a sender — their existing filter just won't match the new sender until they re-paste. The bot now auto-sends the fresh query on `/register` so new tenants always get the latest.

## Data model

Each tenant's spreadsheet has **one** tab — their transactions:

| Columns                                                                                               | Purpose                 |
| ----------------------------------------------------------------------------------------------------- | ----------------------- |
| Email Date, Txn Date, Merchant, Amount, Category, Type, User, Split, Message ID, Currency, Email Link | One row per transaction |

The admin sheet (pointed at by `PROD_SHEET_ID`) hosts **shared registry + mapping** tabs used across all tenants:

| Tab                    | Columns                                                    | Purpose                                                                  |
| ---------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Tenants**            | chat_id, name, emails, sheet_id, status, created_at, notes | Registry — maps Telegram chat / forwarder gmail → per-tenant spreadsheet |
| **MerchantResolution** | Raw Pattern, Resolved Name                                 | Raw bank strings (`FLIPKART_MWS_MERCH`) → clean names (`Flipkart`)       |
| **CategoryOverrides**  | Merchant, Category                                         | Default category per merchant                                            |

**Why `MerchantResolution` and `CategoryOverrides` are shared:** these mappings are universal — every bank sends the same raw patterns to every tenant. Centralising means new tenants inherit a pre-trained bot on day 1 and every tenant's new-merchant taps improve the pool for everyone. Per-transaction category edits (the ✏️ Category button) still write to the tenant's main sheet only — customising your own categorisation doesn't affect anyone else.

## Architecture

```
User's bank → User's Gmail (filter) → dusaanebot.inbox@gmail.com
    → Apps Script (hourly trigger) → per-message tenant routing
    → AI extraction → tenant's Google Sheet → Telegram DM

Telegram → Cloudflare Worker (200 OK) → Apps Script Web App → process & respond
```

- **Inbound email path** is async via Gmail polling; no webhook from Cloudflare.
- **Inbound Telegram path** goes through the Worker proxy so Apps Script 302 redirects don't retry webhooks.
- **Per-message tenant routing** — `extractForwarderEmail(msg)` reads `X-Forwarded-For` (Gmail filter auto-forward) first, falls back to `From:` (manual forwards). That email keys into the Tenants registry.
- **`/backfill` and `/ask`** are deferred to async time-based triggers (keeps the webhook under Telegram's 60s budget). `/backfill` self-schedules in 5-minute chunks until the range is done.
- **`/ask`** sends an immediate "🤔 Thinking..." message and edits it with the final answer.

### Tool-calling (MCP-like pattern)

Both extraction and `/ask` use OpenAI function calling. Tools are defined once, the LLM decides when to call them, and only the tool's response (not the full dataset) enters the context.

**Why not RAG or context injection?** Transaction data is structured — embedding rows into a vector DB adds cost with no benefit, and stuffing all merchant→category mappings into the prompt floods the context window. Tool calling stays at ~600 base tokens regardless of data volume.

**Extraction — 1 tool** (`get_merchant_category`): the LLM categorises well-known merchants directly; calls the tool only for unfamiliar ones. Self-optimises: common merchants cost 1 round-trip, rare ones cost 2.

**`/ask` — 6 tools**:

| Tool                     | Description                                                  |
| ------------------------ | ------------------------------------------------------------ |
| `get_spending_summary`   | Total debits/credits by currency for a date range            |
| `get_category_breakdown` | Spending grouped by category                                 |
| `get_top_merchants`      | Top N merchants by spend amount                              |
| `get_user_spend`         | Per-user spending totals                                     |
| `get_split_summary`      | Split vs personal totals, settlement calc                    |
| `search_transactions`    | Filter by merchant, category, user, amount, type, date range |

The LLM chains up to 3 tool calls per query.

## Project structure

```
├── Code.js                 # Webhook endpoint, async dispatch, time-based triggers
├── Backfill.js             # /backfill parser, command handler, chunked orchestration
├── Constants.js            # Categories, column mappings, bank sender allowlists, Gmail query
├── AIProviders.js          # Azure OpenAI tool-calling client
├── TransactionProcessor.js # Email extraction, forwarder-email parsing, merchant resolution, saving
├── BotHandlers.js          # Command / callback handlers, merchant-edit flow
├── TelegramUtils.js        # Telegram API, message formatting, retry/backoff
├── GoogleSheetUtils.js     # Sheet CRUD, MerchantResolution + CategoryOverrides, bulk scripts
├── Analytics.js            # /stats data + formatters, split settlement
├── AskTools.js             # /ask tool definitions, executor, system prompt
├── TenantRegistry.js       # Tenants tab CRUD, tenant lookup helpers
├── Onboarding.js           # /start, /register, /myinfo, sheet provisioning, filter-query DM
├── AdminHelpers.js         # adminCreateTemplateSheet, adminProvisionTenantSheet, seed helpers
├── worker/src/index.js     # Cloudflare Worker proxy
└── .github/workflows/deploy.yml  # CI/CD pipeline
```

## CI/CD

GitHub Actions on push to `main`:

1. Prettier format check
2. Generate `AConfig.js` from GitHub secrets
3. `clasp push --force` to Apps Script
4. `clasp deploy` with deployment ID
5. Deploy Cloudflare Worker via wrangler

**Required GitHub Secrets**: `CLASP_TOKEN`, `DEPLOYMENT_ID`, `APPS_SCRIPT_URL`, plus every variable in `AConfig.js` (see step 3 above) — in particular `PROD_SHEET_ID` and `TEMPLATE_SHEET_ID`. Secret names remain `GROUP_CHAT_ID` and `PROD_SHEET_ID`; the deploy step maps them to `ADMIN_CHAT_ID` and `ADMIN_SHEET_ID` in the generated file.

## Troubleshooting

### Bot not responding

- Run `setTelegramWebhook()` from the script editor; check the webhook URL points at the Worker.
- Check Apps Script → Executions for errors.
- Verify `BOT_TOKEN` is valid (`GET https://api.telegram.org/bot<token>/getMe`).

### Transactions not showing up

- Check the bot inbox — is the forward actually landing? If not, the user's Gmail filter isn't matching. Regenerate via `node scripts/gen-gmail-filter.js` and re-paste.
- Run `/checknow`-style manual trigger: from the script editor, run `triggerEmailProcessing` — it processes everything since the last run without waiting for the hourly trigger.
- Check `Tenants` tab — is the user's email registered against their `chat_id`? Multi-forwarder setups need `upsertPendingTenant(chatId, email)` for each.
- Check Apps Script logs for `[extractTransactions] No tenant for <email>` lines — that's a forward from an unregistered address.

### `/register` says "I haven't seen any forward"

- The user must forward from the _same_ Gmail address they're trying to register. `X-Forwarded-For` (auto-forward) or `From:` (manual forward) must match.
- Forwards are searched for the last 2 days only.
- Check the bot inbox in a browser — is the forward actually there?

### "I couldn't create your sheet" (Dutch / localized Drive error)

- `TEMPLATE_SHEET_ID` in `AConfig.js` / CI secret is wrong or the script account can't access it.
- Run `adminCreateTemplateSheet()` from the script editor, copy the logged ID, update `TEMPLATE_SHEET_ID` secret, redeploy.

### Wrong category on a transaction

- Use the **✏️ Category** button on the row to fix that transaction only.
- For bulk cleanup: edit `CategoryOverrides` manually, then run `applyCategoryOverridesToMainSheet()`.
- New merchants get a one-tap **🆕 Save** button to persist the mapping.

## Contributing

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

## Privacy

See [docs/PRIVACY.md](docs/PRIVACY.md) for what the bot reads, stores and shares, and how to take your data out.

## License

MIT. The code is open — audit it, fork it, self-host it.

## Acknowledgments

- Azure OpenAI for transaction extraction
- Telegram Bot API
- Google Apps Script
- Cloudflare Workers
