# 💰 Dus Aane Bot

A Telegram bot that automatically extracts transaction details from Gmail using AI and logs them to Google Sheets. Built with Google Apps Script, with a Cloudflare Worker proxy for reliable webhook delivery.

## 🌟 Features

- **Automatic Transaction Parsing**: Uses Azure OpenAI (or Google Gemini) to extract transaction details from emails
- **Gmail Integration**: Monitors specified Gmail labels for transaction emails
- **Google Sheets Logging**: Automatically logs transactions with detailed categorization
- **Multi-Currency Support**: Extracts and displays currency (INR, USD, etc.) per transaction
- **Telegram Bot Interface**: Interactive bot for viewing and managing transactions
- **Transaction Splitting**: Mark transactions as personal or split with others
- **Summary & Analytics**: View spending summaries by category, grouped by currency
- **Backfill**: Backfill transactions for a date range via `/backfill` command
- **Cloudflare Worker Proxy**: Eliminates Telegram webhook retries caused by Apps Script's 302 redirect
- **Time-based Triggers**: Automatically processes emails at scheduled intervals
- **Pluggable AI Providers**: Switch between Azure OpenAI and Google Gemini via config

## 📋 Prerequisites

- Google Account
- Telegram Account
- Azure OpenAI API Key (or Google Gemini API Key)
- Telegram Bot Token (from [@BotFather](https://t.me/botfather))
- Cloudflare Account (free tier)

## 🚀 Setup

### 1. Clone the Repository

```bash
git clone https://github.com/Rrishik/dus-aane-bot.git
cd dus-aane-bot
```

### 2. Install Clasp (Google Apps Script CLI)

```bash
npm install -g @google/clasp
clasp login
```

### 3. Configure Secrets

Create a `Lol.js` file (gitignored) with the following constants:

- `BOT_TOKEN` - Your Telegram bot token
- `PERSONAL_CHAT_ID` - Your Telegram chat ID for debugging
- `GROUP_CHAT_ID` - Group chat ID for production
- `SCRIPT_APP_URL` - Apps Script web app URL
- `TEST_SCRIPT_APP_URL` - Test deployment URL
- `WORKER_PROXY_URL` - Cloudflare Worker proxy URL
- `TEST_SHEET_ID` - Google Sheet ID for testing
- `PROD_SHEET_ID` - Google Sheet ID for production
- `SHEET_NAME` - Sheet tab name
- `AZURE_OPENAI_ENDPOINT` - Azure OpenAI endpoint
- `AZURE_OPENAI_API_KEY` - Azure OpenAI API key
- `AZURE_OPENAI_DEPLOYMENT_NAME` - Azure OpenAI deployment name
- `AZURE_OPENAI_API_VERSION` - Azure OpenAI API version
- `GEMINI_BASE_URL` - Gemini API base URL
- `GEMINI_API_KEY` - Gemini API key
- `GMAIL_LABEL` - Gmail label to monitor

### 4. Set Up Cloudflare Worker

```bash
cd worker
npx wrangler login
npx wrangler secret put APPS_SCRIPT_URL   # paste your Apps Script /exec URL
npx wrangler deploy
```

Note the worker URL (e.g. `https://dus-aane-bot-proxy.<subdomain>.workers.dev`) and set it as `WORKER_PROXY_URL`.

### 5. Deploy the Script

```bash
clasp push
```

### 6. Set Up Webhook

Run `setTelegramWebhook()` from the Apps Script editor. This points Telegram at your Cloudflare Worker proxy, which forwards requests to Apps Script.

### 7. Register Bot Commands

Run `setTelegramCommands()` from the Apps Script editor.

### 8. Configure Triggers

Set up a time-based trigger in Google Apps Script to run `triggerEmailProcessing` at your desired interval (e.g., hourly).

## 🎯 Usage

### Bot Commands

- `/summary [N]` - View spending summary (default: last 10 transactions)
  - `/summary 20` - Last 20 transactions
- `/recent [N] [user]` - View recent transactions (default: last 5)
  - `/recent 10` - Last 10 transactions
  - `/recent rishik` - Filter by user
  - `/recent 10 rishik` - Both filters
- `/help` - Show available commands

### Interactive Features

- **Split Toggle**: After each transaction, use the "✂️ Split this?" button to toggle between Split and Personal
- **Backfill Details**: After backfill, use "📋 Show Details" to view individual transactions

## 📁 Project Structure

```
dus-aane-bot/
├── Code.js                    # Webhook endpoint (doPost) and triggers
├── Constants.js               # Configuration constants and enums
├── AIProviders.js             # Pluggable AI provider dispatcher
├── GoogleSheetUtils.js        # Google Sheets read/write utilities
├── TelegramUtils.js           # Telegram API utilities
├── BotHandlers.js             # Bot command and callback handlers
├── TransactionProcessor.js    # Email processing, AI parsing, backfill
├── appsscript.json           # Apps Script manifest
├── .clasp.json               # Clasp configuration
├── .claspignore              # Files excluded from clasp push
├── .prettierrc               # Prettier config
├── worker/                   # Cloudflare Worker proxy
│   ├── src/index.js          # Worker code (~20 lines)
│   └── wrangler.toml         # Worker config
└── .github/workflows/
    └── deploy.yml            # CI/CD: format check, clasp push, worker deploy
```

## 🔧 Configuration

### Debug Mode

Set `DEBUG = true` in `Constants.js` to use test credentials and shorter lookback periods.

### Backfill

Use the `/backfill <start_date> [end_date]` command in Telegram, or set `BACKFILL_FROM` in `Constants.js` and run `extractTransactions()` manually.

### AI Provider

Set `AI_PROVIDER` in `Constants.js` to switch between providers:

- `AI_PROVIDERS.AZURE_OPENAI` (default) — requires Azure OpenAI endpoint, key, deployment name, and API version
- `AI_PROVIDERS.GEMINI` — requires Gemini base URL and API key

### Gmail Label

Ensure emails are labeled with the label specified in `GMAIL_LABEL` for automatic processing.

## 📊 Google Sheet Format

| Email Date | Transaction Date | Merchant | Amount | Category | Transaction Type | User | Split | Message ID | Currency |
|------------|-----------------|----------|---------|----------|------------------|------|-------|------------|----------|
| 12/1/2024  | 2024-12-01      | Amazon   | 1500    | Shopping | Debit            | user | Personal | 12345 | INR |

## 🤖 How It Works

1. **Email Monitoring**: Time-based trigger checks Gmail for emails with the specified label
2. **AI Extraction**: Uses Azure OpenAI (or Gemini) to extract structured transaction data including currency
3. **Sheet Logging**: Appends transaction details to Google Sheets (10 columns)
4. **Telegram Notification**: Sends notification with transaction details and "Split this?" button
5. **Interactive Management**: Users toggle split/personal via inline buttons

### Architecture

```
Telegram → Cloudflare Worker (instant 200 OK) → Apps Script doPost → process command
```

The Cloudflare Worker proxy solves the Apps Script 302 redirect issue that causes Telegram to retry webhooks. The Worker follows the redirect and returns a clean 200 to Telegram.

## 🔐 Security Notes

- Keep your `BOT_TOKEN`, `AZURE_OPENAI_API_KEY`, and `GEMINI_API_KEY` secure
- All secrets are stored in `Lol.js` (gitignored) and injected via GitHub Actions secrets in CI
- Restrict Google Sheet access to authorized users only

## 🛠️ Development

### Local Development

```bash
# Pull latest changes from Apps Script
clasp pull

# Make changes to .js files

# Push changes to Apps Script
clasp push
```

### Deployment

The project includes a GitHub Actions workflow that:
1. Checks formatting with Prettier
2. Generates `Lol.js` from GitHub secrets
3. Pushes to Apps Script via clasp
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
