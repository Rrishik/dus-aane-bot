# 💰 Dus Aane Bot

A Telegram bot that automatically extracts transaction details from Gmail using Google Gemini AI and logs them to Google Sheets. Built with Google Apps Script.

## 🌟 Features

- **Automatic Transaction Parsing**: Uses Google Gemini AI to extract transaction details from emails
- **Gmail Integration**: Monitors specified Gmail labels for transaction emails
- **Google Sheets Logging**: Automatically logs transactions to a Google Sheet with detailed categorization
- **Telegram Bot Interface**: Interactive bot for viewing and managing transactions
- **Transaction Splitting**: Mark transactions as personal or split with others
- **Summary & Analytics**: View spending summaries by category
- **Manual Transaction Entry**: Add transactions manually via Telegram commands
- **Time-based Triggers**: Automatically processes emails at scheduled intervals

## 📋 Prerequisites

- Google Account
- Telegram Account
- Google Gemini API Key
- Telegram Bot Token (from [@BotFather](https://t.me/botfather))

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

### 3. Configure Script Properties

Create a Google Apps Script project and set the following script properties:

- `BOT_TOKEN` - Your Telegram bot token
- `GEMINI_API_KEY` - Your Google Gemini API key
- `GMAIL_LABEL` - Gmail label to monitor (e.g., "Transactions")
- `TEST_SHEET_ID` - Google Sheet ID for testing
- `PROD_SHEET_ID` - Google Sheet ID for production
- `PERSONAL_CHAT_ID` - Your Telegram chat ID for debugging
- `GROUP_CHAT_ID` - Group chat ID for production notifications
- `GEMINI_BASE_URL` - Gemini API base URL
- `BOT_API_URL` - Telegram Bot API URL

### 4. Deploy the Script

```bash
clasp push
```

### 5. Set Up Webhook

Deploy the script as a web app and set the webhook for your Telegram bot to point to the deployed URL.

### 6. Configure Triggers

Set up a time-based trigger in Google Apps Script to run `triggerEmailProcessing` at your desired interval (e.g., hourly).

## 🎯 Usage

### Bot Commands

- `/start` - Start the bot and see available commands
- `/addtransaction <amount> <category> <merchant>` - Add a transaction manually
  - Example: `/addtransaction 1000 Food Zomato`
- `/summary` - View transaction summary with category-wise breakdown
- `/recent` - View last 5 transactions
- `/help` - Show help information

### Interactive Features

- **Split Toggle**: After each transaction, you can mark it as "Split" or "Personal" using inline buttons
- **Keyboard Shortcuts**: Quick access buttons for common actions

## 📁 Project Structure

```
dus-aane-bot/
├── Code.js                    # Main bot logic and handlers
├── Constants.js               # Configuration constants
├── GoogleSheetUtils.js        # Google Sheets utilities
├── TelegramUtils.js           # Telegram API utilities
├── BotHandlers.js             # Bot command handlers
├── MessageUtils.js            # Message formatting utilities
├── TransactionProcessor.js    # Transaction processing logic
├── appsscript.json           # Apps Script manifest
└── .clasp.json               # Clasp configuration
```

## 🔧 Configuration

### Debug Mode

Set `DEBUG = true` in `Constants.js` to use test credentials and shorter lookback periods.

### Backfill

To backfill historical transactions:

1. Set `BACKFILL_FROM` to a date (format: `YYYY/MM/DD`)
2. Run `extractTransactionsWithGemini()`

### Gmail Label

Ensure emails are labeled with the label specified in `GMAIL_LABEL` for automatic processing.

## 📊 Google Sheet Format

The bot creates/uses a sheet with the following columns:

| Email Date | Transaction Date | Merchant | Amount | Category | Transaction Type | User | Split |
|------------|-----------------|----------|---------|----------|------------------|------|-------|
| 12/1/2024  | 2024-12-01      | Amazon   | 1500    | Shopping | Debit            | user | Personal |

## 🤖 How It Works

1. **Email Monitoring**: The bot periodically checks Gmail for emails with the specified label
2. **AI Extraction**: Uses Google Gemini to extract structured transaction data from email content
3. **Sheet Logging**: Appends transaction details to Google Sheets
4. **Telegram Notification**: Sends notification to Telegram with transaction details
5. **Interactive Management**: Users can mark transactions as split or personal via Telegram

## 🔐 Security Notes

- Keep your `BOT_TOKEN` and `GEMINI_API_KEY` secure
- Use Script Properties in Google Apps Script (never commit secrets to Git)
- Restrict Google Sheet access to authorized users only
- Consider using a service account for production deployments

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

The project includes GitHub Actions workflow for automated deployment using Clasp.

## 🐛 Troubleshooting

### Bot not responding
- Verify webhook is set correctly
- Check Apps Script execution logs
- Ensure bot token is valid

### Transactions not being logged
- Verify Gmail label exists and has emails
- Check Gemini API quota
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

- Google Gemini AI for transaction extraction
- Telegram Bot API for bot interface
- Google Apps Script for serverless execution
