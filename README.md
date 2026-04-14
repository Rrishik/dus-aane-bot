# 💰 Dus Aane Bot

Telegram bot that parses transaction emails via AI and logs them to Google Sheets. Built on Google Apps Script with a Cloudflare Worker proxy.

## Features

- **AI-powered extraction** — Azure OpenAI (GPT-5.2) or Gemini extracts transaction details from emails using tool calling
- **Smart merchant resolution** — MerchantResolution sheet maps raw names to clean ones (e.g., FLIPKART_MWS_MERCH → Flipkart) with default categories
- **Google Sheets logging** — 11-column format with multi-currency support
- **Telegram bot** — `/summary`, `/recent`, `/stats`, `/ask`, `/backfill` commands with inline buttons
- **Analytics dashboard** — Monthly breakdown, spending trends, split settlement via `/stats`
- **AI-powered queries** — Natural language questions about your spending via `/ask`
- **Split tracking** — Mark transactions as Personal or Split
- **Category management** — Separate debit/credit category lists with inline picker
- **Non-transaction filtering** — AI skips surveys, OTPs, marketing emails and notifies you
- **Empty merchant handling** — "Set Merchant" button for generic bank alerts
- **Auto-register merchants** — New merchants added to MerchantResolution tab automatically
- **Cloudflare Worker proxy** — Eliminates Telegram retries from Apps Script 302 redirects
- **CI/CD** — GitHub Actions auto-deploys to Apps Script and Cloudflare on push

## Setup

### Prerequisites

- Google Account, Telegram Bot Token, Azure OpenAI or Gemini API key, Cloudflare account (free)

### Quick Start

1. `npm install -g @google/clasp && clasp login`
2. Create `Lol.js` (gitignored) with secrets: `BOT_TOKEN`, `GROUP_CHAT_ID`, `SCRIPT_APP_URL`, `WORKER_PROXY_URL`, `PROD_SHEET_ID`, `SHEET_NAME`, Azure/Gemini keys, `GMAIL_LABEL`
3. `clasp push`
4. Deploy Cloudflare Worker: `cd worker && npx wrangler secret put APPS_SCRIPT_URL && npx wrangler deploy`
5. Run `setTelegramWebhook()` and `setTelegramCommands()` from Apps Script editor
6. Set up a time-based trigger for `triggerEmailProcessing` in Apps Script

## Commands

| Command | Description |
|---------|-------------|
| `/summary [N]` | Spending summary (default: last 10) |
| `/recent [N] [user]` | Recent transactions with optional filters |
| `/stats` | Analytics dashboard — monthly, trends, who owes |
| `/ask <question>` | AI-powered spending queries (e.g., "food spending last month") |
| `/backfill 3 days` | Backfill last 3 days/weeks/months |
| `/backfill YYYY-MM-DD YYYY-MM-DD` | Backfill a date range |
| `/help` | Show commands |

## Inline Buttons

Each transaction notification shows action buttons:

- **✂️ Split** — Toggles between Personal/Split
- **✏️ Category** — Shows category picker (debit or credit categories based on transaction type)
- **🗑️ Delete** — Removes the transaction row
- **🏪 Set Merchant** — Appears when merchant is empty; prompts you to type the merchant name, auto-fills category if matched in MerchantResolution

## Extraction Flow

```
📧 Email arrives (Gmail label trigger)
    ↓
🧠 AI extracts: merchant, amount, date, type, currency
    ↓ (if unsure about category)
🔧 Tool call: get_merchant_category("merchant_name")
    ↓
📋 MerchantResolution tab lookup → returns default category
    ↓
🔄 Merchant name resolved (FLIPKART_MWS_MERCH → Flipkart)
    ↓
💾 Saved to Google Sheet
    ↓
💬 Telegram notification with action buttons
```

- Well-known merchants (Amazon, Swiggy) → categorized directly in 1 LLM call
- Unknown merchants → tool call checks MerchantResolution → 2 LLM calls
- Non-transaction emails (surveys, OTPs) → skipped with notification
- New merchants → auto-registered to MerchantResolution tab

## `/ask` — AI Queries

Ask natural language questions about your transactions:

```
/ask how much did I spend on food last week?
/ask top 5 merchants this month
/ask show all credit transactions
```

Uses 6 tools: `get_spending_summary`, `get_category_breakdown`, `get_top_merchants`, `get_user_spend`, `get_split_summary`, `search_transactions`

## `/stats` — Analytics Dashboard

Three views accessible via inline buttons:

- **📊 Monthly** — Total spend, category breakdown, top merchants, user spend (supports 1M/2M/3M/6M periods)
- **📈 Trends** — Month-over-month spending comparison
- **💰 Who Owes** — Split settlement calculation between users

Navigate months with ◀️/▶️ buttons.

## Project Structure

```
├── Code.js                 # Webhook endpoint, async triggers, backfill orchestration
├── Constants.js            # Categories (debit + credit), column mappings, config
├── AIProviders.js          # AI provider dispatcher (Azure OpenAI / Gemini), tool-calling
├── TransactionProcessor.js # Email extraction with tool-calling, merchant resolution
├── BotHandlers.js          # Command & callback handlers, set-merchant flow
├── TelegramUtils.js        # Telegram API, message formatting, command registration
├── GoogleSheetUtils.js     # Sheet CRUD, MerchantResolution tab helpers
├── Analytics.js            # Shared aggregation helpers, analytics data & formatters
├── AskTools.js             # /ask tool definitions, executor, system prompt
├── worker/src/index.js     # Cloudflare Worker proxy
└── .github/workflows/deploy.yml  # CI/CD pipeline
```

## Google Sheets

### Main Sheet (columns)

| Email Date | Transaction Date | Merchant | Amount | Category | Type | User | Split | Message ID | Currency | Email Link |
|------------|-----------------|----------|--------|----------|------|------|-------|------------|----------|------------|

### MerchantResolution Tab

| Raw Pattern | Resolved Name | Default Category |
|-------------|---------------|------------------|
| flipkart | Flipkart | Shopping |
| swiggy | Swiggy | Food & Dining |
| mudavath srinu | Mudavath Srinu | Food & Dining |

- **Raw Pattern** — Substring match (case-insensitive) against AI-extracted merchant names
- **Resolved Name** — Clean display name saved to the main sheet
- **Default Category** — Used by the `get_merchant_category` tool and Set Merchant flow
- New merchants are auto-registered with blank Resolved Name/Category for you to fill in
- Run `populateResolutionSheet()` once to seed from existing data

### Categories

**Debit:** Shopping, Groceries, Food & Dining, Healthcare, Fuel, Entertainment, Travel, Bills & Utilities, Education, Investment, Subscriptions, CC Bill Payment

**Credit:** Salary, Refund, Cashback, Transfer In, Reimbursement, Interest/Dividend

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
- Verify Gmail label exists and has emails
- Check AI provider API quota
- Review Apps Script logs for errors

### Wrong categories
- Fill in Default Category in MerchantResolution tab
- Use ✏️ Category button to correct — the AI uses tool calling to look up mappings

## 📝 License

This project is available for personal and educational use.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## 👥 Authors

- Project maintained by the dus-aane team

## 🙏 Acknowledgments

- Azure OpenAI / Google Gemini for transaction extraction
- Telegram Bot API for bot interface
- Google Apps Script for serverless execution
- Cloudflare Workers for webhook proxy
