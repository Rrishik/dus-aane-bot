# 💰 Dus Aane Bot

Telegram bot that parses transaction emails via AI and logs them to Google Sheets. Built on Google Apps Script with a Cloudflare Worker proxy.

## Features

- **AI-powered parsing** — Azure OpenAI or Gemini extracts transaction details from emails
- **Google Sheets logging** — 10-column format with multi-currency support
- **Telegram bot** — `/summary`, `/recent`, `/backfill` commands with inline buttons
- **Split tracking** — mark transactions as Personal or Split
- **Category management** — edit categories via inline picker, AI learns from corrections
- **Delete transactions** — remove unwanted entries from the bot
- **Cloudflare Worker proxy** — eliminates Telegram retries from Apps Script 302 redirects

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
| `/backfill 3 days` | Backfill last 3 days/weeks/months |
| `/backfill YYYY-MM-DD YYYY-MM-DD` | Backfill date range |
| `/help` | Show commands |

## Inline Buttons

Each transaction notification shows: `[✂️ Split] [✏️ Category] [🗑️ Delete]`

- **Split** — toggles between Personal/Split
- **Category** — shows emoji picker grid, updates sheet + saves merchant preference
- **Delete** — removes the transaction row

## Project Structure

```
├── Code.js                 # Webhook endpoint, triggers
├── Constants.js            # Config, categories, column mappings
├── AIProviders.js          # AI provider dispatcher
├── TransactionProcessor.js # Email parsing, AI calls, backfill
├── BotHandlers.js          # Command & callback handlers
├── TelegramUtils.js        # Telegram API, message formatting
├── GoogleSheetUtils.js     # Sheet CRUD, category overrides
├── worker/src/index.js     # Cloudflare Worker proxy
└── .github/workflows/deploy.yml  # CI/CD pipeline
```

## Sheet Format

| Email Date | Transaction Date | Merchant | Amount | Category | Type | User | Split | Message ID | Currency |
|------------|-----------------|----------|--------|----------|------|------|-------|------------|----------|

A second tab `CategoryOverrides` stores merchant→category frequency counts used as AI hints.

## Architecture

```
Telegram → Cloudflare Worker (200 OK) → Apps Script → process & respond
```

## CI/CD

GitHub Actions on push to `main`: Prettier check → generate `Lol.js` from secrets → `clasp push` → `wrangler deploy`
4. Deploys the Cloudflare Worker

**Note:** After CI pushes to Apps Script, you must create a new version manually: Deploy → Manage deployments → Edit → New version.

## 🐛 Troubleshooting

### Bot not responding
- Verify webhook is set correctly
- Check Apps Script execution logs
- Ensure bot token is valid

### Transactions not being logged
- Verify Gmail label exists and has emails
- Check AI provider API quota (Azure OpenAI or Gemini)
- Review Apps Script logs for errors

### Sheet errors
- Ensure sheet ID is correct
- Verify sheet permissions
- Check that the first sheet exists

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
