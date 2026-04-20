# Privacy

This bot runs on **your** infrastructure (self-hosted Google Apps Script + Cloudflare Worker + Google Sheets). Nothing in here is a binding legal policy — it's an engineering description of what the code actually does. The code is open source; audit it for yourself.

## TL;DR

- The bot only ever receives emails you explicitly forward to it.
- Your Gmail filter is the primary privacy boundary — only senders on the `TRANSACTION_SENDERS` allowlist ever leave your inbox.
- The bot never sees OTPs, statements, login codes, marketing, or anything else not on the allowlist.
- Each user's transactions live in their own Google Sheet, shared only with the email they registered.
- The LLM (Azure OpenAI) sees the plain-text body of each forwarded transaction email to extract structured fields. It does not see your other mail.

## What the bot reads

A single dedicated Gmail account (`dusaanebot.inbox@gmail.com` by default) receives forwarded mail. The Apps Script polls this inbox on an hourly trigger and processes matching messages.

**For each message it processes, it reads:**

- Email headers (`From:`, `Subject:`, `X-Forwarded-For:`, `Date:`)
- The plain-text body of the message
- The Gmail message id (used as a dedupe key)

**It does not read:**

- Any mail not matching the `in:inbox` search — the hourly poller only looks at recent inbox mail.
- Attachments.
- Any mail from your personal Gmail — the bot has no OAuth access to user Gmail accounts. You forward to it; it never pulls from you.

## What the LLM sees

For every forwarded email that passes the bank-sender / subject filters, the message's plain-text body is sent to Azure OpenAI with a system prompt asking for structured transaction extraction.

**The LLM sees:**

- The email body text (one message at a time)
- A fixed system prompt
- The names of your configured categories

**The LLM does not see:**

- Your other transactions
- Merchant history
- Tenant / user metadata beyond what's in the email itself

Azure OpenAI's data handling follows Microsoft's Azure terms — prompts are not used for training. Review Microsoft's current policy; the code doesn't override it.

## What the bot stores

Per-tenant data, in a Google Sheet **owned by your bot's Google account** and shared with your registered Gmail as an editor:

| Where                  | What                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Main sheet tab**     | One row per transaction: date, merchant, amount, category, type, user tag, split status, Gmail message id, currency, email link |
| **MerchantResolution** | Raw bank string → cleaned merchant name mappings                                                                                |
| **CategoryOverrides**  | Merchant → default category mappings                                                                                            |

**Admin sheet only** (not in per-tenant sheets):

| Tab       | What                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| `Tenants` | chat_id, display name, forwarder emails, sheet id, status (`pending`/`active`/`disabled`), created_at, notes |

The bot also uses Apps Script's `PropertiesService` for ephemeral state (pending merchant-edit prompts, backfill progress markers, async webhook payloads). These are cleaned up after each operation.

## What leaves your infrastructure

Outbound network calls made by the code:

1. **Telegram Bot API** (`api.telegram.org`) — sends your transaction notifications and receives updates via webhook. Contains: merchant, amount, date, category, sheet link.
2. **Azure OpenAI** — per email: system prompt + email body. Per `/ask`: question + tool results (aggregated numbers, not raw rows).
3. **Cloudflare Worker** — a thin proxy that forwards the Telegram webhook to the Apps Script URL. The Worker is yours; the payload is what Telegram sends it.

Nothing else leaves. No analytics, no telemetry, no third-party SDKs.

## What stays on your devices

Nothing. There is no client app.

## Who can see what

- **You (the tenant)** — your own Google Sheet (shared with you as editor), your Telegram chat with the bot.
- **The admin** (person running the deployment) — the admin Google account technically has access to every tenant's sheet because it owns the template they were copied from. This is unavoidable with the current design. If you don't trust the admin, self-host.
- **Nobody else** — sheets are not shared publicly by default.

## Sharing model: your sheet

When you run `/register you@gmail.com`, the bot:

1. Copies the template sheet (owned by the bot's Google account).
2. Calls `DriveApp.File.addEditor(you@gmail.com)` on the new copy.
3. Stores the sheet id in the Tenants registry.

So the bot owns your sheet and you're added as an editor. You can:

- Open, edit, download or export it.
- Use Google Sheets version history.
- **Not** delete it (only the owner can) — if you want the data gone, see "Deletion" below.

## Retention

The code has **no automatic deletion**. All forwarded mail in the bot inbox and all sheet rows persist until manually removed.

Practical implications:

- The bot inbox grows over time. Periodically archive/delete old mail in the bot's Gmail account.
- A tenant's sheet grows forever. That's usually desirable (history), but see below for how to clear or leave.

## Deletion & data export

There's no self-service command yet. To leave:

1. **Export your data** — open your sheet → File → Download → CSV / Excel.
2. **Have the admin remove you** — they delete your `Tenants` row (revokes the bot from routing future forwards to you) and either delete your sheet or transfer ownership to you.
3. **Stop the forwarding** — in your Gmail, delete the filter that forwards to `dusaanebot.inbox@gmail.com` and remove the forwarding address.

Self-service `/forgetme` is on the admin's future roadmap.

## Telegram's own data

Telegram sees every command you send and every message the bot sends you — standard for any Telegram bot. Review Telegram's own privacy terms; nothing in this codebase changes them.

## Changes to this document

This file is maintained in the repo. Material changes to what the bot reads or stores will be reflected in commits here; subscribe / watch the repo if you care.

## Questions / concerns

Open an issue on the repo, or contact the person running your deployment.
