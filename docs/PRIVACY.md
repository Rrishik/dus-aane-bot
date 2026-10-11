# Privacy

This bot runs on **your** infrastructure: a Cloudflare Worker with a Cloudflare D1 database, plus a small Google Apps Script project that reads the bot's own Gmail inbox. Nothing in here is a binding legal policy — it's an engineering description of what the code actually does. The code is open source; audit it for yourself.

## TL;DR

- The bot only ever receives emails you explicitly forward to it, and SMS you paste into the chat.
- Your Gmail filter is the primary privacy boundary — only senders on the `TRANSACTION_SENDERS` allowlist ever leave your inbox.
- The bot never sees OTPs, statements, login codes, marketing, or anything else not on the allowlist.
- Transactions are stored in the deployment's D1 database, scoped to your Telegram chat. Nobody else using the bot can see them.
- Bank emails and SMS are read by a deterministic parser first. The LLM (Azure OpenAI) only sees a message when the parser can't read it confidently, when the parser is in comparison ("shadow") mode, or when you tap 🔄 Re-read.
- `/export` gives you all your data; `/deletemydata` removes it.

## What the bot reads

A single dedicated Gmail account (`dusaanebot.inbox@gmail.com` by default) receives forwarded mail. Apps Script checks this inbox every 5 minutes and passes each matching message to the Worker.

**For each message it reads:**

- Email headers (`From:`, `Subject:`, `X-Forwarded-For:`) — to filter out non-bank mail and to find which registered user forwarded it
- The plain-text body
- The Gmail message id (the dedupe key)

**It does not read:**

- Attachments.
- Any mail in your own Gmail — the bot has no OAuth access to user Gmail accounts. You forward to it; it never pulls from you.

**Pasted SMS.** Bank SMS text you paste into your DM with the bot is processed the same way as an email body. Nothing is read from your phone — only what you paste.

## What the LLM sees

A forwarded email or pasted SMS is sent to Azure OpenAI when:

- the deterministic parser can't read it confidently,
- the parser is running in `shadow` mode for emails (the LLM read is saved, the parser read is only compared), or
- you tap **🔄 Re-read** on a transaction.

**For extraction, the LLM sees** one message body at a time, a fixed system prompt and the category list. When it's unsure of a category it can look up a merchant name in the merchant rules (the deployment's shared defaults and your own corrections) and gets back that merchant's category.

**For `/ask`, the LLM sees** your question, the follow-ups in that conversation, and the results of the tools it calls on **your** data only: totals and breakdowns, and, for `search_transactions`, the matching transactions (date, merchant, amount, currency, category, type, forwarder). It can't query anyone else's data.

Azure OpenAI's data handling follows Microsoft's Azure terms — prompts are not used for training. Review Microsoft's current policy; the code doesn't override it.

## What the bot stores

In the D1 database (owned by the Cloudflare account running the deployment):

| Table                                   | What                                                                                                                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenants`, `tenant_emails`              | Your Telegram chat id, first name, registered Gmail addresses, status, activity/nudge timestamps. Group chats: title, admin, pinned-message id.                                                                                       |
| `transactions`                          | One row per transaction: date, amount, currency, debit/credit, kind, merchant (raw and cleaned), category, last 4 digits of the account/card when the message shows them, UPI/reference number, forwarder name, status                |
| `transaction_sources`                   | Where each transaction came from: Gmail message id or SMS hash, parser template id, and **for pasted SMS only** the raw text (kept so 🔄 Re-read works). Email bodies are not stored — Re-read fetches them again from the bot inbox. |
| `splits`, `split_shares`, `settlements` | Group splits (who paid, each member's share) and settlements, with the group message id                                                                                                                                               |
| `group_members`, `group_invites`        | Which registered users are in which group; pending invites for people who haven't registered yet                                                                                                                                      |
| `merchant_rules`                        | Your 🏷 / 📂 corrections (only used for your transactions) and the admin's shared defaults                                                                                                                                            |
| `ask_usage`                             | Daily `/ask` counter                                                                                                                                                                                                                  |
| `parser_events`                         | Parser telemetry: time, template id, event, names of fields that differed. **No amounts, merchants or message text.**                                                                                                                 |
| `ephemeral`                             | Short-lived state: "waiting for your reply" prompts and `/ask` conversations (10 minutes), Re-read results (1 hour). Purged daily once expired.                                                                                       |

Slow requests (`/ask`, pasted SMS, exports) pass through a Cloudflare Queue for a few seconds. Worker logs record errors and request metadata, not message content.

**Old Google Sheets.** Before the move to D1, transactions were written to Google Sheets owned by the bot's Google account and shared with each user. Those sheets are no longer updated and stay as read-only archives; ask the admin to delete yours.

**Export to Sheet.** Tapping **📊 Open in Google Sheets** under an `/export` writes a snapshot into a sheet owned by the bot's Google account and shared with your registered Gmail as editor. Each export rewrites the same sheet.

## What leaves the deployment

Outbound network calls made by the code:

1. **Telegram Bot API** (`api.telegram.org`) — your transaction cards, answers and group notifications; incoming updates arrive by webhook, checked against a secret token.
2. **Azure OpenAI** — as described above.
3. **Apps Script ↔ Worker** — forwarded emails, setup-email requests, `/backfill` progress and Export-to-Sheet rows, signed with a shared secret (`INTERNAL_SECRET`) in both directions.
4. **Gmail (via Apps Script)** — the setup email sent to your registered address.

Nothing else leaves. No third-party analytics or SDKs.

## Who can see what

- **You** — your own transactions (in the chat, `/ask`, `/export`), and splits / balances in groups you're a member of.
- **Group members** — the split notifications, balances and settlements of that group. Not your personal transactions.
- **The admin** (whoever runs the deployment) — has access to the D1 database, the bot inbox and the bot's Google account, so technically to everything above. The admin dashboard shows counts, statuses and parser statistics under masked user ids. To check and improve the parser, the admin can also re-read stored emails with the parser and open individual messages (for example where the parser and the LLM disagreed, a read was corrected, or you reported an error): that view shows the original email or SMS and the saved transaction (amount, merchant, account digits, reference), still under a masked user id. If you don't trust the admin, self-host.
- **Nobody else.**

## Retention

Transactions are kept until you delete them. Forwarded mail stays in the bot inbox until the admin clears it. D1 keeps point-in-time recovery history (30 days on the Workers Paid plan, 7 on Free), so deleted rows remain recoverable by the admin for that long.

## Export & deletion

- **`/export`** — a CSV of all your transactions (or a month / date range), plus an optional Google Sheet copy.
- **🗑️ Delete** on a card — removes that transaction from your stats and `/ask` (kept as deleted so the same message isn't re-imported).
- **`/deletemydata`** — after a confirmation, removes your account, registered emails, transactions and their sources, merchant corrections, and settings. Group splits you paid are removed from the group's balances. What stays, so other members' balances still add up: your shares in splits other people paid, and settlements between you and them. Parser telemetry rows are kept with your chat id removed.
- **Stop forwarding** — delete the Gmail filter and the forwarding address `dusaanebot.inbox@gmail.com` in your Gmail settings. Exported sheets and the old archive sheet aren't affected by `/deletemydata`; ask the admin to delete those.

## Telegram's own data

Telegram sees every command you send and every message the bot sends you — standard for any Telegram bot. Review Telegram's own privacy terms; nothing in this codebase changes them.

## Changes to this document

This file is maintained in the repo. Material changes to what the bot reads or stores will be reflected in commits here; watch the repo if you care.

## Questions / concerns

Open an issue on the repo, or contact the person running your deployment.
