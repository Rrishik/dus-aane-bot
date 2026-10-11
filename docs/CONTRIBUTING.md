# Contributing

Thanks for looking! This is a small, opinionated codebase. A few notes so your PR lands smoothly.

## Layout

The bot is a **Cloudflare Worker** (`worker/`) with a **D1** (SQLite) database. A small **Google Apps Script** project (repo root) does only what needs the bot's own Google account.

```
worker/
  src/index.js          # Routes: Telegram webhook, /ingest/email, /internal/backfill, /healthz; cron; queue consumer
  src/app/              # Bot logic: webhook.js (dispatch), commands, cards + cardActions, ingest, sms,
                        #   groups, ask (/ask tools), cron (weekly jobs), data (/export, /deletemydata),
                        #   appsScript.js + auth.js (signed calls to/from Apps Script)
  src/db/               # D1 data layer — every query is scoped by tenant id
  src/parser/           # Deterministic parser: templates.js (data) + parser.js (rules, validation)
  src/llm/, src/telegram/  # Azure OpenAI and Telegram clients
  migrations/           # D1 schema (NNNN_*.sql)
  scripts/              # set-webhook.mjs, smoke.mjs (run by CI)
  test/                 # Worker tests (Node + node:sqlite)
Code.js                 # Apps Script entry points: doGet, doPost, the 5-minute trigger
Gmail.js                # Poller: finds new forwarded bank mail, filters it
WorkerBridge.js         # Hands emails to the Worker; signed actions the Worker calls
SetupEmail.js           # The auto-forwarding setup email
Forwarding.js           # One-tap "verify forwarding address" link
Constants.js            # Bot inbox, bank sender allowlists, Gmail ignore lists
tests/                  # Apps Script tests (vm sandbox)
```

Operations (deploys, diagnosis, staging, token rotation): [OPERATIONS.md](OPERATIONS.md). Runtime architecture: [../README.md](../README.md).

## Ground rules

- **Worker:** ES modules, no runtime npm dependencies, no build step beyond what `wrangler deploy` does.
- **Apps Script:** V8, no modules — every `.js` file shares one global namespace. Use `var` / `function` at the top level (two files declaring the same `const` fail at load time).
- **Data access** — every query in `worker/src/db/` takes a `tenantId` and filters on it. D1 has no row-level security, so keep it that way (the isolation tests in `db.tenantsTransactions.test.js` guard it). Never trust ids from callback data without checking they belong to the caller.
- **Schema** — add a new `worker/migrations/NNNN_*.sql`; never edit an applied one. CI applies migrations before each Worker deploy.

## Tests & formatting

```powershell
npm install
npm test                 # Worker + Apps Script tests
npx prettier --write .   # CI fails on unformatted files
```

- Worker tests run in Node against `worker/test/helpers/d1.js`, a D1-compatible wrapper over `node:sqlite` (Node 22.13+/24) that applies the real migrations. `worker/test/helpers/app.js` has fake Telegram / LLM clients and a seeded context. No `wrangler` needed locally.
- Apps Script tests load source files into a `vm` sandbox via `tests/_loader.js` and stub the Google services.

## Deploying

Push to `main`. CI runs the tests, pushes Apps Script (`clasp`), applies D1 migrations, deploys the Worker, re-points the Telegram webhook and runs a smoke test. For risky changes, try them on the staging bot first (see [OPERATIONS.md](OPERATIONS.md)).

## Adding a new bank

The narrowest change: add verified transaction-alert senders to `TRANSACTION_SENDERS` in [Constants.js](../Constants.js). Also:

- Add the bank's domain to `BANK_FROM_DOMAINS` if it's not covered.
- Add any known marketing/statement addresses for that bank to `IGNORE_SENDERS`.
- The setup email always carries the current filter; existing users re-paste it from `/account` → Resend setup if they want the new bank covered.

Then add a parser template in [worker/src/parser/templates.js](../worker/src/parser/templates.js) for the bank's email and/or SMS format:

- One entry per format, with an `id` ending in a version (`hdfc_cc_spent_sms_v1`), a `channel` (`email` / `sms` / `both`) and a strict regex with named groups (`amount` required; `cur`, `date`, `merchant`, `account`, `reference` optional).
- Add `samples` with the expected read. `worker/test/parser.test.js` runs every sample automatically.
- **Never commit real messages** — this repo is public. Replace names, account digits and reference numbers with fakes before adding a sample.
- Email templates are checked in `shadow` mode first (the `parser.mode` setting in D1's `settings` table): the LLM result is saved and the parser's read is only compared (`parser_events`). Switch to `on` once agreement is consistently high; the Monday parser digest shows the numbers.
- If you change a template's behaviour, bump its version suffix so telemetry for the old and new versions stays separate.

## Adding a command

1. Write the handler (usually in `worker/src/app/commands.js`) and register it in `PERSONAL_COMMANDS` or `GROUP_COMMANDS` in `webhook.js`. Commands usable before registration also go in `ONBOARDING`.
2. If it calls the LLM or Apps Script, add it to `SLOW_COMMANDS` in `worker/src/index.js` so it runs from the queue.
3. Zero-argument commands can go in the slash menu: `PRIVATE_COMMANDS` / `GROUP_COMMANDS` in `worker/scripts/set-webhook.mjs` (applied on the next deploy).
4. Document it in `README.md` and the `/help` text.

## Adding a `/ask` tool

Add a definition to `ASK_TOOLS` and an implementation in `askToolExecutor` (`worker/src/app/ask.js`). Keep inputs flat and few — the LLM is better at short parameter lists. Tools only ever read the calling user's data.

## Telegram formatting

Messages use **legacy `Markdown`** (the client default), not `MarkdownV2`: it only needs `_`, `*` and backticks escaped, which suits text full of `user@gmail.com` and `₹1,234.56`. Pass user-supplied text (merchant names, first names) through `escapeMarkdown()`; use `parse_mode: null` for plain text such as LLM answers.

## Security checklist for PRs

- Don't commit `AConfig.js`, `.env` or any token. Double-check with `git diff` before pushing.
- Don't log message bodies, amounts or merchants — the Worker's logs are retained by Cloudflare. Ids and counts are fine.
- Keep the Gmail allowlist / ignore-list checks (`Gmail.js`) in the happy path — they're the defense in depth when a user's filter is misconfigured.
- Keep every D1 query tenant-scoped, and re-check that a transaction or group belongs to the caller before mutating it.
- Calls between Apps Script and the Worker must stay signed (`INTERNAL_SECRET`); the Telegram webhook must stay behind `WEBHOOK_SECRET`.
- Avoid regex DoS — anchor patterns, don't build regex from user input.

## Pull request checklist

- [ ] `npm test` and `prettier --check .` clean
- [ ] No secrets / tokens / personal email addresses in the diff
- [ ] Updated `README.md` / `docs/PRIVACY.md` if what the bot reads, stores or sends changes
- [ ] Tenant isolation verified for any new query or callback
- [ ] Tried on the staging bot if it touches webhooks, groups or the Gmail poller

Thanks!
