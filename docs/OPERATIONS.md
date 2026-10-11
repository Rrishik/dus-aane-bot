# Operations

Day-to-day running of a deployment. The bot is a Cloudflare Worker (`dus-aane-bot-proxy`) with a D1 database (`dus-aane-bot`) and a queue (`dus-aane-bot-updates`); a small Apps Script project reads the bot's Gmail inbox.

## Deploys

Every push to `main` runs **Actions → Deploy**: tests → Apps Script (`clasp push` + deploy) → D1 migrations → Worker deploy → Telegram webhook + command menus → smoke test (`worker/scripts/smoke.mjs`). Re-run it by hand with **Run workflow** after changing a secret.

GitHub secrets it uses: `BOT_TOKEN`, `WEBHOOK_SECRET`, `INTERNAL_SECRET`, `GROUP_CHAT_ID` (admin chat, becomes `ADMIN_CHAT_ID`), `AZURE_OPENAI_ENDPOINT` / `_API_KEY` / `_DEPLOYMENT_NAME` / `_API_VERSION`, `WORKER_PROXY_URL` (the Worker's URL), `SCRIPT_APP_URL` (the Apps Script `/exec` URL), `CLASP_TOKEN`, `DEPLOYMENT_ID`, `CLOUDFLARE_API_TOKEN` (needs Workers, D1 and Queues edit).

## Rotating secrets

| Secret            | Steps                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `BOT_TOKEN`       | BotFather → `/revoke` → `gh secret set BOT_TOKEN` → run Deploy (it re-points the webhook with the new token).                |
| `WEBHOOK_SECRET`  | `gh secret set WEBHOOK_SECRET` (A–Z, a–z, 0–9, `_`, `-`) → run Deploy. Updates sent between the two are retried by Telegram. |
| `INTERNAL_SECRET` | `gh secret set INTERNAL_SECRET` → run Deploy. Emails that fail in the meantime are retried for about a day.                  |
| `AZURE_OPENAI_*`  | Update the secret → run Deploy.                                                                                              |

## Diagnosis

**Actions → Diagnose** (read-only; logs counts only) shows:

- whether the Telegram webhook points at the Worker, pending updates and Telegram's last delivery error;
- D1 activity over the last few hours;
- for recent bot-inbox mail: whether each email passed the poller's filters, was labelled, or is waiting to retry, plus the last Worker error (status + message) and the installed Apps Script triggers.

Options: `poll_now` runs the Gmail poller once first; `requeue` puts recent unlabelled bank mail back on the retry list (e.g. after fixing a Worker failure). Failed emails are retried for about a day on their own.

Logs: Cloudflare → Workers → `dus-aane-bot-proxy` → Logs (look for errors and "Exceeded CPU" — move to the Workers Paid plan if those appear). Apps Script → Executions → `triggerEmailProcessing` logs `worker {"handled":…,"failed":…}` each run.

### Common problems

- **Bot not answering** — Diagnose: is the webhook pointing at the Worker, and what's Telegram's last error? `401` means `WEBHOOK_SECRET` differs between Telegram and the Worker: run Deploy.
- **Forwarded email didn't arrive** — Diagnose with `poll_now`. Not in the list → the user's Gmail filter isn't forwarding (they can resend the setup email from `/account`). `ignoredByHeaders` / `allowedBank: false` → the sender isn't on the allowlist ([Constants.js](../Constants.js)). Waiting to retry → see the last Worker error. `no_tenant` → the forwarding address isn't registered; the user can `/register` it, then `/backfill`.
- **Parser read something wrong** — users tap ⋯ → 🔄 Re-read. A template with 3 accepted Re-reads in 7 days is auto-disabled (its messages go to the LLM) and the admin gets a DM.

### Settings in D1

```powershell
cd worker
npx wrangler d1 execute dus-aane-bot --remote --command "SELECT * FROM settings"
# Parser mode for emails: shadow (default) | on | off
npx wrangler d1 execute dus-aane-bot --remote --command "UPDATE settings SET value = 'on' WHERE key = 'parser.mode'"
# Re-enable templates after fixing them: edit the comma-separated list
npx wrangler d1 execute dus-aane-bot --remote --command "UPDATE settings SET value = '' WHERE key = 'parser.disabledTemplates'"
```

## Backups and restore

D1 keeps point-in-time history (Time Travel): 30 days on the Workers Paid plan, 7 on Free.

```powershell
cd worker
npx wrangler d1 time-travel info dus-aane-bot --timestamp 2026-10-10T12:00:00Z
npx wrangler d1 time-travel restore dus-aane-bot --timestamp 2026-10-10T12:00:00Z
```

Users can take their own copy at any time with `/export`.

## Staging

**Actions → Staging** runs a second bot (`STAGING_BOT_TOKEN`) on its own Worker, D1 database and queue, without cron jobs — for trying webhook, group or ingest changes before they reach `main`.

- `deploy` — creates the database and queue if missing, migrates, deploys the current `main`, points the staging bot at it and runs the smoke test. To test a branch, run the workflow on that branch.
- `teardown` — deletes the staging Worker, queue and database.

Staging can't receive forwarded email (Apps Script only talks to the production Worker); use pasted SMS.

## Admin dashboard

`https://admin.healthvault.online` — a read-only dashboard (a separate Worker, `dus-aane-bot-admin`, reading the same D1 database). It shows:

- users, groups and transactions per day; items awaiting review;
- ingestion health: the Telegram webhook, the Gmail poller's last run, retry list and last Worker failure, recent bot-inbox mail and what happened to it;
- parser accuracy per reader (each bank template, the generic rules, and the LLM): saves, shadow agreement, corrections (accepted Re-reads + ✏️ Fix) and correction rate;
- **cases**: each disagreement, parser miss, correction and report in the window. Clicking one shows the original message (email fetched live from the bot inbox, or the stored SMS), the saved values next to the parser's read with today's templates, and the differing fields highlighted;
- per-user and per-group counts under masked ids (`u-1a2b3c`).

The overview shows only counts and statuses. Opening a case shows that message in full, including amounts, merchants and account digits; each opened case is logged in the Worker's logs with the admin's email.

**Access.** Cloudflare Access (Zero Trust) asks for a login before any request reaches the Worker, and the Worker re-checks Access's signed token on every request — it refuses everything if the Access settings are missing. The Worker has no `workers.dev` URL. The site on the bare `healthvault.online` (GitHub Pages) is unaffected; only an `admin` DNS record is added.

**One-time setup:**

1. **API token** — add to `CLOUDFLARE_API_TOKEN` (Cloudflare → My Profile → API Tokens → edit), for zone `healthvault.online`: _Zone → Zone → Read_, _Zone → DNS → Edit_, _Zone → Workers Routes → Edit_. Then run **Actions → Admin dashboard**; it deploys the Worker on `admin.healthvault.online` (refusing every request until step 2–3).
2. **Access application** — Cloudflare → Zero Trust (pick a team name on first visit; the Free plan is enough) → Access → Applications → **Add an application → Self-hosted**: domain `admin.healthvault.online`; session e.g. 24 h; policy **Allow** → _Emails_ → your address. Login method: one-time PIN works out of the box. Save, then copy the application's **Application Audience (AUD) Tag**.
3. **Secrets** —
   ```powershell
   gh secret set ACCESS_TEAM_DOMAIN --body "<team>.cloudflareaccess.com"
   gh secret set ACCESS_AUD          # paste the AUD tag
   gh secret set ADMIN_EMAILS --body "you@example.com"
   gh workflow run admin.yml
   ```

To add another admin, add their email to both the Access policy and `ADMIN_EMAILS`. The workflow ends by checking that `/api/summary` answers with a login redirect or 403 when not signed in.

## Apps Script

The Apps Script project needs only the 5-minute `triggerEmailProcessing` trigger (and short-lived `continueWorkerBackfill` triggers during `/backfill`). Any other trigger is removed automatically on the next poller run. If the email trigger is ever missing, run `installEmailTrigger()` once from the script editor.

The pre-D1 Google Sheets are kept in the bot's Drive as read-only archives; nothing reads or writes them any more.
