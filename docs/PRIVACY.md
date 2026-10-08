# Privacy

This bot runs on **your** infrastructure (self-hosted Google Apps Script + Cloudflare Worker + Google Sheets). Nothing in here is a binding legal policy — it's an engineering description of what the code actually does. The code is open source; audit it for yourself.

## TL;DR

- The bot only ever receives emails you explicitly forward to it.
- Your Gmail filter is the primary privacy boundary — only senders on the `TRANSACTION_SENDERS` allowlist ever leave your inbox.
- The bot never sees OTPs, statements, login codes, marketing, or anything else not on the allowlist.
- Each user's transactions live in their own Google Sheet, shared only with the email they registered.
- Bank emails and SMS you paste are read by a deterministic on-server parser first. The LLM (Azure OpenAI) only sees a message body when the parser can't read it confidently, when the parser is in comparison ("shadow") mode, or when you tap 🔄 Re-read. It never sees your other mail.

## What the bot reads

A single dedicated Gmail account (`dusaanebot.inbox@gmail.com` by default) receives forwarded mail. The Apps Script polls this inbox every 5 minutes and processes matching messages.

**For each message it processes, it reads:**

- Email headers (`From:`, `Subject:`, `X-Forwarded-For:`, `Date:`)
- The plain-text body of the message
- The Gmail message id (used as a dedupe key)

**It does not read:**

- Any mail not matching the `in:inbox` search — the poller only looks at recent inbox mail.
- Attachments.
- Any mail from your personal Gmail — the bot has no OAuth access to user Gmail accounts. You forward to it; it never pulls from you.

**Pasted SMS.** Bank SMS text you paste into your DM with the bot is processed the same way as an email body. Nothing is read from your phone — only what you paste.

## What the LLM sees

A forwarded email or pasted SMS is sent to Azure OpenAI (with a system prompt asking for structured transaction extraction) when:

- the deterministic parser can't read it confidently,
- the parser is running in `shadow` mode (the default while a bank format is being verified — the LLM read is saved, the parser read is only compared), or
- you tap **🔄 Re-read** on a transaction.

Messages the parser reads confidently in `on` mode never reach the LLM.

**The LLM sees:**

- The email body or pasted SMS text (one message at a time)
- A fixed system prompt
- The names of your configured categories

**The LLM does not see:**

- Your other transactions
- Merchant history
- Tenant / user metadata beyond what's in the email itself

Azure OpenAI's data handling follows Microsoft's Azure terms — prompts are not used for training. Review Microsoft's current policy; the code doesn't override it.

## What the bot stores

Per-tenant data, in a Google Sheet **owned by your bot's Google account** and shared with your registered Gmail as an editor:

| Where                  | What                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Personal sheet tab** | One row per transaction: email date, txn date, merchant, amount, category, type, user, Gmail message id (or `sms-<hash>` for pasted SMS), currency, group ref, group message id, parsed by (template id or `llm`), source text (**pasted SMS only** — the raw text, kept so 🔄 Re-read works), status (`review` until you confirm) |
| **Group sheet tab**    | One row per **share** (so a 4-way split = 4 rows linked by the same Tx ID): email date, tx date, merchant, amount, currency, paid by, share holder, share amount, tx id, category, tx type, message id. Only exists if you use group splits.                                                                                       |

Group sheets are owned by the bot's Google account and shared with every member of the Telegram group as editor. When you split a personal transaction into a group, both sheets get rows: the personal row gets a `group ref` pointing at the group sheet, and the group sheet gets one row per share-holder.

**Admin sheet** (shared across all tenants — the admin can see it, tenants cannot):

| Tab                  | What                                                                                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Tenants`            | chat_id, name, emails, sheet_id, status (`pending`/`active`/`dormant`/`disabled`), created_at, notes, last_forward_at, last_nag_at, nag_count, chat_type (`personal`/`group`), group_members (CSV of chat_ids, groups only), primary_currency |
| `MerchantResolution` | Raw bank strings → cleaned merchant names (e.g. `FLIPKART_MWS_MERCH` → `Flipkart`). Universal across tenants.                                                                                                                                 |
| `CategoryOverrides`  | Merchant → default category (e.g. `Swiggy` → `Food & Dining`). Universal across tenants.                                                                                                                                                      |
| `ParserEvents`       | Parser telemetry: time, chat_id, channel (`email`/`sms`), template id, event (e.g. `saved`, `reparse_accepted`, `report`), names of fields that differed, message id. **No amounts, merchants or message text.**                              |

`MerchantResolution` and `CategoryOverrides` are curated by the admin and shared, because the raw patterns banks use are identical for every tenant — new tenants inherit a pre-trained bot. Your own corrections (🏷 Tag, 📂 Category, `/ask` edits) are stored in a `MyMerchants` tab in **your** sheet only; they take priority for your transactions and are never copied to the shared tabs or seen by other users.

The bot also uses Apps Script's `PropertiesService` / `CacheService` for ephemeral state (pending-reply prompts that expire after 10 minutes, per-user backfill progress, async webhook payloads, a 5-minute cache of the Tenants tab, pending Re-read results for up to an hour). These are cleaned up after each operation or expire on their own.

## What leaves your infrastructure

Outbound network calls made by the code:

1. **Telegram Bot API** (`api.telegram.org`) — sends your transaction notifications and receives updates via webhook. Contains: merchant, amount, date, category, sheet link.
2. **Azure OpenAI** — per email: system prompt + email body. Per `/ask`: question + tool results (aggregated numbers, not raw rows).
3. **Cloudflare Worker** — a thin proxy that forwards the Telegram webhook to the Apps Script URL. The Worker is yours; the payload is what Telegram sends it. When `WEBHOOK_SECRET` is configured, the Worker only accepts requests carrying Telegram's secret-token header, and Apps Script only accepts requests forwarded by the Worker — forged updates to the public URL are dropped.

Nothing else leaves. No third-party analytics or SDKs; the only telemetry is the `ParserEvents` tab above, which stays in your admin sheet.

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

Self-service deletion isn't implemented yet — ask the admin running your deployment.

## Telegram's own data

Telegram sees every command you send and every message the bot sends you — standard for any Telegram bot. Review Telegram's own privacy terms; nothing in this codebase changes them.

## Changes to this document

This file is maintained in the repo. Material changes to what the bot reads or stores will be reflected in commits here; subscribe / watch the repo if you care.

## Questions / concerns

Open an issue on the repo, or contact the person running your deployment.
