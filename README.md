# 💰 Dus Aane Bot

Telegram bot that parses transaction emails via AI and logs them to Google Sheets. Built on Google Apps Script with a Cloudflare Worker proxy.

## Features

- **AI-powered extraction** — Azure OpenAI (GPT-5.2) extracts transaction details from emails using tool calling
- **Zero-config email discovery** — Finds bank transaction emails via a sender-based Gmail search query (no label setup required)
- **Smart merchant resolution** — `MerchantResolution` tab maps raw bank names to clean ones (e.g., `FLIPKART_MWS_MERCH` → `Flipkart`)
- **Category overrides** — Separate `CategoryOverrides` tab maps resolved merchants to categories; reviewable/editable in bulk
- **Google Sheets logging** — 11-column format with multi-currency support
- **Telegram bot** — `/recent`, `/stats`, `/ask`, `/backfill` commands with inline buttons
- **Analytics dashboard** — Monthly breakdown, spending trends, split settlement via `/stats`
- **AI-powered queries** — Natural language questions about your spending via `/ask`
- **Split tracking** — Mark transactions as Personal, Split (50/50), or Partner (I paid on behalf of the other user)
- **One-tap merchant mapping** — New-merchant detections get inline `Save` / `Edit Merchant` buttons on the transaction itself
- **Category management** — Separate debit/credit category lists with inline picker
- **Non-transaction filtering** — LLM skips surveys, OTPs, marketing, declined transactions and notifies you with reason + who it was for
- **Empty merchant handling** — "Set Merchant" button for generic bank alerts
- **Bulk maintenance scripts** — Reapply resolutions, populate categories for review, apply category overrides across the main sheet
- **Cloudflare Worker proxy** — Eliminates Telegram retries from Apps Script 302 redirects
- **CI/CD** — GitHub Actions auto-deploys to Apps Script and Cloudflare on push

## Setup

### Prerequisites

- Google Account, Telegram Bot Token, Azure OpenAI API key, Cloudflare account (free)

### Quick Start

1. `npm install -g @google/clasp && clasp login`
2. Create `Lol.js` (gitignored) with secrets: `BOT_TOKEN`, `GROUP_CHAT_ID`, `SCRIPT_APP_URL`, `WORKER_PROXY_URL`, `PROD_SHEET_ID`, `SHEET_NAME`, Azure OpenAI keys
3. (Optional) Edit `GMAIL_SEARCH_QUERY` in [Constants.js](Constants.js) if your bank sender isn't already in the default list
4. `clasp push`
5. Deploy Cloudflare Worker: `cd worker && npx wrangler secret put APPS_SCRIPT_URL && npx wrangler deploy`
6. Run `setTelegramWebhook()` and `setTelegramCommands()` from Apps Script editor
7. Set up a time-based trigger for `triggerEmailProcessing` in Apps Script

## Commands

| Command                           | Description                                                      |
| --------------------------------- | ---------------------------------------------------------------- |
| `/recent [N] [user]`              | Recent transactions with optional filters                        |
| `/stats`                          | Analytics dashboard — monthly, trends, who owes                  |
| `/ask <question>`                 | AI-powered spending queries (e.g., "food spending last month")   |
| `/backfill 10m`                   | Backfill last N minutes/hours (compact: `10m`, `2h`, `3d`, `1w`) |
| `/backfill 3 days`                | Backfill last N days/weeks/months                                |
| `/backfill YYYY-MM-DD YYYY-MM-DD` | Backfill a date range                                            |
| `/help`                           | Show commands                                                    |

## Inline Buttons

Each transaction notification shows action buttons:

- **✂️ Split** — Cycles through `Personal` → `Split` (50/50) → `Partner` (you paid 100% on behalf of the other user) → `Personal`
- **✏️ Category** — Shows category picker (debit or credit categories based on transaction type)
- **🗑️ Delete** — Removes the transaction row
- **🏠 Set Merchant** — Appears when merchant is empty; prompts you to type the merchant name, auto-fills category if `CategoryOverrides` has an entry for it

### New-merchant flow

When a brand-new merchant is detected, two extra buttons appear above the standard row:

- **🆕 Save: `<merchant>` → `<category>`** — One-tap confirm. Writes the LLM's resolved name to `MerchantResolution` and the category to `CategoryOverrides`.
- **🏪 Edit Merchant** — Force-reply prompt for the merchant name, then shows the category picker. Updates both sheets plus the transaction row itself.

## Email Discovery

The bot locates bank transaction emails via a Gmail search query defined in [Constants.js](Constants.js) as `GMAIL_SEARCH_QUERY`. No Gmail labels or filters needed — the query matches common Indian bank domains directly:

```
from:(bank.in OR bank.com OR bank.net OR bank.co.in
      OR sbi.co.in OR hsbc.co.in OR idbi.co.in OR pnbindia.in
      OR bobmail.in OR bankofbaroda.com OR bobcard.in
      OR sc.com OR standardchartered.com
      OR citi.com OR kotak.com OR indusind.com
      OR americanexpress.com OR goniyo.com)
-subject:(statement OR "e-statement")
-category:(promotions OR social OR forums)
```

Covers HDFC, Axis, ICICI, SBI, Kotak, IndusInd, HSBC, SC, Citi, AmEx, IDFC First, AU Small Finance, Equitas, Yes Bank, Bank of Baroda, SBM, and more. Edit the list in `Constants.js` to add banks. The LLM's `not_a_transaction` branch handles any remaining noise.

## Data Model

The spreadsheet has three tabs:

| Tab                    | Columns                                                                                               | Purpose                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Main sheet**         | Email Date, Txn Date, Merchant, Amount, Category, Type, User, Split, Message ID, Currency, Email Link | One row per transaction                                          |
| **MerchantResolution** | Raw Pattern, Resolved Name                                                                            | Maps raw bank strings to clean merchant names                    |
| **CategoryOverrides**  | Merchant, Category                                                                                    | Maps resolved merchants to categories (separate from resolution) |

## Tool-Calling Architecture (MCP-like pattern)

Both extraction and querying use OpenAI function calling in an MCP-like pattern — the LLM is given tool definitions and decides autonomously whether to call them. This is a deliberate architectural choice over two common alternatives:

**Why not RAG?** Transaction data is structured (rows and columns), not unstructured text. Embedding rows into a vector DB and retrieving "similar" transactions adds complexity (chunking, embedding costs, retrieval latency) with no benefit. A direct function call that queries the structured data and returns precise results is simpler and more accurate.

**Why not context injection?** The naive approach is to dump all historical data (merchant→category mappings, past transactions) into the prompt. This floods the context window — 100 merchants × ~40 tokens each = ~4,000 wasted tokens per email. It scales linearly with data and most of the injected context is irrelevant to the current email. Tool calling keeps the base prompt small (~600 tokens) and only fetches data when the LLM needs it.

### Extraction — 1 tool

The LLM extracts transaction details from emails. For well-known merchants (Amazon, Swiggy), it categorizes directly in a single round-trip. For unfamiliar merchants, it calls a tool to look up the category:

```
📧 Email arrives
    ↓
🧠 LLM receives: system prompt + email text + 1 tool definition
    ↓
┌─ High confidence → returns JSON directly (1 round-trip)
│
└─ Low confidence → calls get_merchant_category("merchant_name")
                   → tool queries data, returns category
                   → LLM returns final JSON (2 round-trips)
```

| Tool                    | Description                                                                   |
| ----------------------- | ----------------------------------------------------------------------------- |
| `get_merchant_category` | Looks up default category for a merchant. Only called when the LLM is unsure. |

The LLM self-optimizes: common merchants cost 1 API call, rare merchants cost 2. No tokens wasted on irrelevant merchant history.

### `/ask` Queries — 6 tools

The LLM answers natural language spending questions by calling tools that query the transaction data:

```
/ask how much did I spend on food last week?
/ask top 5 merchants this month
/ask compare my spending with rishik
```

| Tool                     | Description                                                  |
| ------------------------ | ------------------------------------------------------------ |
| `get_spending_summary`   | Total debits/credits by currency for a date range            |
| `get_category_breakdown` | Spending grouped by category                                 |
| `get_top_merchants`      | Top N merchants by spend amount                              |
| `get_user_spend`         | Per-user spending totals                                     |
| `get_split_summary`      | Split vs personal totals, settlement calculation             |
| `search_transactions`    | Filter by merchant, category, user, amount, type, date range |

The LLM chains up to 3 tool calls per query. The system prompt provides only metadata (today's date, available categories, field names) — no actual transaction data enters the context until a tool is called and returns targeted results.

### Token comparison

| Approach          | Tokens per email    | Scales with            |
| ----------------- | ------------------- | ---------------------- |
| Context injection | ~4,500+             | Number of merchants    |
| RAG               | ~2,000+ (retrieval) | Corpus size            |
| **Tool calling**  | **~600 base**       | **Nothing** (constant) |

## `/stats` — Analytics Dashboard

Three views accessible via inline buttons:

- **📊 Monthly** — Total spend, category breakdown, top merchants, user spend (supports 1M/2M/3M/6M periods)
- **📈 Trends** — Month-over-month spending comparison
- **💰 Who Owes** — Split settlement calculation between users

Navigate months with ◀️/▶️ buttons.

## Bulk Maintenance Scripts

Run from the Apps Script editor (not wired to Telegram). Useful after manually editing the resolution/override tabs.

| Function                             | Purpose                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `reapplyMerchantResolutions`         | Walks the main sheet; rewrites merchant names using current `MerchantResolution` entries         |
| `populateCategoryOverridesForReview` | Scans main sheet, writes best-guess (most-frequent) category per merchant to `CategoryOverrides` |
| `applyCategoryOverridesToMainSheet`  | Overwrites main-sheet categories based on `CategoryOverrides`                                    |
| `populateResolutionSheet`            | One-time: seed `MerchantResolution` with all unique merchants currently in the main sheet        |

Typical workflow after bulk edits:

1. Manually update `MerchantResolution` → run `reapplyMerchantResolutions()`
2. Run `populateCategoryOverridesForReview()` → review/edit the `CategoryOverrides` tab
3. Run `applyCategoryOverridesToMainSheet()`

## Project Structure

```
├── Code.js                 # Webhook endpoint, async triggers, backfill orchestration
├── Constants.js            # Categories, column mappings, GMAIL_SEARCH_QUERY
├── AIProviders.js          # Azure OpenAI tool-calling client
├── TransactionProcessor.js # Email extraction, merchant resolution, transaction saving
├── BotHandlers.js          # Command & callback handlers, merchant edit flow
├── TelegramUtils.js        # Telegram API, message formatting, command registration
├── GoogleSheetUtils.js     # Sheet CRUD, MerchantResolution + CategoryOverrides helpers, bulk scripts
├── Analytics.js            # Aggregation helpers, /stats data & formatters, split settlement
├── AskTools.js             # /ask tool definitions, executor, system prompt
├── worker/src/index.js     # Cloudflare Worker proxy
└── .github/workflows/deploy.yml  # CI/CD pipeline
```

## Architecture

```
Telegram → Cloudflare Worker (200 OK) → Apps Script → process & respond
```

- `/backfill` and `/ask` are deferred to async triggers (avoids Telegram timeout)
- Backfill runs in 5-minute chunks via time-based triggers
- `/ask` sends an immediate "🤔 Thinking..." message, then edits it with the response

## CI/CD

GitHub Actions on push to `main`:

1. Prettier format check
2. Generate `Lol.js` from GitHub secrets
3. `clasp push --force` to Apps Script
4. `clasp deploy` with deployment ID
5. Deploy Cloudflare Worker via wrangler

**Required GitHub Secrets:** `CLASP_TOKEN`, `DEPLOYMENT_ID`, `APPS_SCRIPT_URL`, plus all `Lol.js` variables

## 🐛 Troubleshooting

### Bot not responding

- Verify webhook: run `setTelegramWebhook()` from Apps Script editor
- Check Apps Script execution logs
- Ensure bot token is valid

### Transactions not being logged

- Verify `GMAIL_SEARCH_QUERY` in [Constants.js](Constants.js) matches your bank senders
- Check AI provider API quota
- Review Apps Script logs for errors

### Wrong categories

- Use the ✏️ Category button on any transaction to fix that row
- For bulk cleanup: edit `CategoryOverrides` manually, then run `applyCategoryOverridesToMainSheet()`
- New merchants get a one-tap 🆕 Save button on the transaction message to persist the mapping

## 📝 License

This project is available for personal and educational use.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## 👥 Authors

- Project maintained by the dus-aane team

## 🙏 Acknowledgments

- Azure OpenAI for transaction extraction
- Telegram Bot API for bot interface
- Google Apps Script for serverless execution
- Cloudflare Workers for webhook proxy
