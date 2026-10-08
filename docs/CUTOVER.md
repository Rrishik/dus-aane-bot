# D1 cutover runbook

How to move the bot from Apps Script + Google Sheets to the Cloudflare Worker + D1, check it, and roll back if needed. One repository variable, `NATIVE_MODE`, switches both sides:

|                  | `NATIVE_MODE` unset (today)   | `NATIVE_MODE=1`                                              |
| ---------------- | ----------------------------- | ------------------------------------------------------------ |
| Telegram updates | Worker proxies to Apps Script | Worker handles them (D1)                                     |
| Gmail poller     | Apps Script saves to Sheets   | Apps Script posts each email to the Worker's `/ingest/email` |
| Weekly jobs      | Apps Script triggers          | Worker cron (Apps Script triggers return early)              |
| Data             | Sheets                        | D1 (`/export` gives a CSV or a Google Sheet copy)            |

The Telegram webhook URL doesn't change: it already points at the Worker.

## 1. Staging

A second bot on its own Worker, D1 database and queue (`worker/wrangler.staging.toml`), always native, with no cron jobs.

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`, e.g. `DusAaneStagingBot`) and store its token — don't paste it anywhere else:
   ```powershell
   gh secret set STAGING_BOT_TOKEN
   ```
2. Run **Actions → Staging → `deploy`**. It creates the D1 database and queue if missing, applies migrations, deploys, points the staging bot at the staging Worker and runs the smoke test (`worker/scripts/smoke.mjs`).
3. Run **Staging → `import`** to load a copy of the live sheets (strict verification).
4. In a private chat with the staging bot (your chat id is the same as with the real bot, so you'll see your real history):
   - `/help`, `/account`, `/recent`, `/stats` → Trends. Totals match the real bot's `/stats`.
   - Paste a bank SMS → card. Try 🏷 tag, 📂 category, ⋯ → Re-read / Delete. Paste the same SMS again → "Already recorded".
   - `/ask how much did I spend on food last month?` → same answer as the real bot. Try 💬 Follow up, and a question that makes it ask you something back (reply to its question).
   - `/export` and `/export 2026-09` → CSV; tap **Open in Google Sheets**.
   - Groups (optional, needs a second registered person): new Telegram group with them + the staging bot, promote the bot to admin, `/start`, then 👥 Split / 🤝 Settle up / ↩️ undo from a card, group `/stats`, `/settle @name 100`, the pinned balance.
   - `/deletemydata` → **Keep my data**, then again → **Delete everything** (staging copy only), then `/start`. Re-run **Staging → `import`** to restore.
   - Not testable on staging: forwarded emails and `/backfill` (Apps Script only talks to the production Worker). The smoke test covers the signed email route, and the unit tests the rest.
5. Watch **Cloudflare → Workers → dus-aane-bot-staging → Logs** while testing: no errors, no "Exceeded CPU" (if you see those, move to the Workers Paid plan before cutover).

## 2. Cutover (~10 min)

Pick a quiet time. Steps 2–4 should run back-to-back.

1. **Import + verify** — Actions → _Import Sheets into D1_ → `apply`. Must end with `✅ D1 matches the sheets`.
2. **Switch**:
   ```powershell
   gh variable set NATIVE_MODE --body 1
   gh workflow run deploy.yml
   gh run watch (gh run list --workflow deploy.yml --limit 1 --json databaseId -q '.[0].databaseId')
   ```
   This redeploys Apps Script (poller → Worker, triggers off) and the Worker (`MODE=native`).
3. **Catch-up** — _Import Sheets into D1_ → `catch-up`. Picks up anything Sheets saved between step 1 and the switch. Insert-only, so nothing changed in the bot since is overwritten; verification is lenient. (Avoid undoing splits in the bot until this finishes.)
4. **Smoke test** — the deploy run from step 2 ends with _Smoke test the native Worker_ (it runs on every deploy while `NATIVE_MODE=1`). All ✅.
5. **Check by hand** with the real bot: `/help`, paste an SMS, forward a bank email (card within ~5 min, the poller interval), `/ask`, a split in your group, the pinned balance updates.
6. **Watch for a day**: Cloudflare Worker logs; Apps Script → Executions for `triggerEmailProcessing` (`worker {"handled":…,"failed":0}`).

## Troubleshooting

**Actions → Diagnose** (read-only; logs counts only) shows the webhook state, D1 activity, and for recent bot-inbox mail whether each email passed the poller's filters, is labelled or is waiting to retry, plus the last Worker failure (status + error). Options:

- `poll_now` — run the Gmail poller once before reporting.
- `requeue` — put recent unlabelled bank mail back on the retry list (e.g. after fixing a Worker failure). Failed emails are retried for about a day on their own.

## 3. Rollback

```powershell
gh variable delete NATIVE_MODE
gh workflow run deploy.yml
```

The bot is back on Apps Script + Sheets within a couple of minutes. Anything saved, edited or split in D1 since the switch isn't in Sheets: send `/export` (from the date of the switch) before rolling back if you need it. D1 is untouched, so switching back on later is step 2 + 3 again.

## 4. After a stable week

- Rotate the bot token: BotFather `/revoke`, `gh secret set BOT_TOKEN`, push (or run `deploy.yml`), then run `setTelegramWebhook` once from the Apps Script editor.
- Staging → `teardown` (removes the staging Worker, queue and its copy of the data), then delete the staging bot in BotFather and `gh secret delete STAGING_BOT_TOKEN`.
- Remove the weekly Apps Script triggers (`sendWeeklySummaries`, `nudgeDormantTenants`, `sendParserDigest`); keep `triggerEmailProcessing`.
- Clean up the Sheets code paths in Apps Script (task 16).
