# Contributing

Thanks for looking! This is a small, opinionated codebase. A few notes so your PR lands smoothly.

## Ground rules

- **Google Apps Script V8 only.** No modules, no `import`/`export`, no TypeScript. Everything is globals-on-the-same-runtime.
- **`var` over `const`/`let` at the top level.** Apps Script treats each `.js` file as a separate script and re-declaring a `const` in two files is a syntax error at load time. `var` silently redeclares. Inside functions, use whatever's clearest.
- **No build step.** What's in the repo is what ships. Don't add bundlers.
- **No external npm deps for runtime code.** The `scripts/` folder is gitignored and can use anything you like locally.

## Project layout (high level)

```
Code.js                 # Webhook / async trigger orchestration
Constants.js            # Categories, bank senders, column indexes
BotHandlers.js          # Telegram command + callback routers
TelegramUtils.js        # Telegram API wrappers, retry/backoff
TransactionProcessor.js # Email → parser/LLM → validate → Sheet pipeline
Parser.js               # Deterministic email/SMS parser + shared validation (plain JS only)
BankTemplates.js        # Per-bank templates + scrubbed samples (data only)
ParserTelemetry.js      # parser.mode, disabled templates, ParserEvents log, digest
SmsPaste.js             # Pasted SMS → cards
PendingInput.js         # Expiring "waiting for your reply" flags
Forwarding.js           # Verify-forwarding-address one-tap helper
GoogleSheetUtils.js     # Sheet CRUD + merchant resolution tabs
Analytics.js            # /stats aggregations and formatters
AskTools.js             # /ask tool-calling definitions
AIProviders.js          # Azure OpenAI HTTP client
TenantRegistry.js       # Tenants tab CRUD
Onboarding.js           # /start, /register, /account, activation
Groups.js               # Group provisioning + split/settle/stats UI + writes
GroupSheet.js           # Group sheet β-schema headers + open helper
Backfill.js             # /backfill parser, chunked async orchestration
Nudge.js                # Dormant-tenant weekly nudge
Quota.js                # Per-tenant LLM cost / call quotas
AdminHelpers.js         # Manually-run maintenance (create template, seed, etc.)
worker/                 # Cloudflare Worker proxy
```

See [../README.md](../README.md) for the runtime architecture.

## Local setup

```powershell
npm install
# Log in to the bot's Google account
npx clasp login
# Pull the current project or create one — see README admin steps
```

You'll also need a local `AConfig.js` (gitignored) with all the constants listed in the README. CI generates this from GitHub secrets; for local dev, just create it.

## Running & deploying locally

- `npx clasp push --force` — push local files to Apps Script.
- Open the script editor → run functions manually (e.g. `triggerEmailProcessing`, `adminCreateTemplateSheet`).
- CI runs on push to `main`; avoid force-pushing directly.

## Tests

```powershell
npm test
```

Tests load source files into a `vm` sandbox via `tests/_loader.js` and stub the Apps Script services. The loader also supplies defaults for a few shared constants/predicates (`SHARED_DEFAULTS`); a loaded file's own declarations and per-test stubs always win.

## Worker (D1 migration in progress)

The Cloudflare Worker in `worker/` is being built up to replace the Apps Script runtime (see the migration plan). Until cutover it only proxies Telegram updates to Apps Script; the D1 schema, data layer and API clients land ahead of the switch.

- **Schema** — `worker/migrations/NNNN_*.sql`, applied to the `dus-aane-bot` D1 database by CI (`wrangler d1 migrations apply --remote`) before each Worker deploy. Never edit an applied migration; add a new one.
- **Tests** — `worker/test/*.test.js` run under the same `npm test`, in Node, against `worker/test/helpers/d1.js`: a D1-compatible wrapper over `node:sqlite` (Node 22.13+/24) that applies the real migrations. No `workerd`/`wrangler` needed locally.
- **Data access** — every query in `worker/src/db/` takes a `tenantId` and filters on it; D1 has no row-level security, so keep it that way (the isolation tests in `db.tenantsTransactions.test.js` guard it).
- **Parser** — `worker/src/parser/parser.gen.js` is generated from the root `BankTemplates.js` + `Parser.js`. After editing either, run `npm run parser:sync`; CI fails if the generated file is stale.
- **Mode switch** — the repository variable `NATIVE_MODE=1` deploys the Worker with `MODE=native` (it runs the bot on D1) and Apps Script with `NATIVE_MODE = "1"` (the Gmail poller hands emails to `POST /ingest/email`; its crons stand down). Unset, everything stays on Apps Script.
- **Bridge** — `WorkerBridge.js` (Apps Script) and `worker/src/app/appsScript.js` + `auth.js` (Worker) sign every call with the `INTERNAL_SECRET` GitHub secret. Apps Script only does what the Worker can't: send the setup email, read the bot's Gmail (poller, `/backfill`, Re-read).

## Formatting

```powershell
npx prettier --write .
```

Runs pre-commit via CI too. Please keep it clean.

## Adding a new bank

The narrowest change: add verified transaction-alert senders to `TRANSACTION_SENDERS` in [Constants.js](Constants.js). Also:

- Add the bank's domain to `BANK_FROM_DOMAINS` if it's not covered.
- Add any known marketing/statement addresses for that bank to `IGNORE_SENDERS`.
- Regenerate the user-facing Gmail filter (the bot sends the fresh query on `/register`, so existing tenants can re-paste if they want new banks covered).

Then add a parser template in [BankTemplates.js](../BankTemplates.js) for the bank's email and/or SMS format:

- One entry per format, with an `id` ending in a version (`hdfc_cc_spent_sms_v1`), a `channel` (`email` / `sms` / `both`) and a strict regex with named groups (`amount` required; `cur`, `date`, `merchant`, `account`, `reference` optional).
- Add `samples` with the expected read. `tests/parser.test.js` runs every sample automatically.
- **Never commit real messages** — this repo is public. Replace names, account digits and reference numbers with fakes before adding a sample.
- Email templates run in `shadow` mode first (`parser.mode` script property): the LLM result is saved and the parser's read is only compared in the `ParserEvents` tab. Switch to `on` once agreement is consistently high.
- If you change a template's behaviour, bump its version suffix so telemetry for the old and new versions stays separate.

## Adding a new command

1. Add the handler to `BotHandlers.js` (`switch` in `handleMessage`).
2. If it's an onboarding command, add it to the `ONBOARDING` allowlist array too.
3. Add an entry to `setTelegramCommands()` in `TelegramUtils.js` (and manually run that function once in the script editor to register it with Telegram).
4. Document it in `README.md`.

## Adding a new `/ask` tool

1. Append a tool definition to `ASK_TOOLS` in `AskTools.js`.
2. Implement it in `executeAskTool`.
3. If it needs aggregation helpers, put them in `Analytics.js`.

Keep tool inputs simple (flat JSON). The LLM is better at short parameter lists.

## Parse modes — read before touching Telegram copy

This codebase uses **legacy `Markdown`** (not `MarkdownV2`) almost everywhere. That's deliberate:

- MarkdownV2 requires escaping `.`, `-`, `(`, `)`, `!`, `+`, `=`, etc. — which means every email address, date, and `➡️` emoji-adjacent text needs escaping.
- Legacy `Markdown` only requires escaping `_`, `*`, backticks — much saner for our messages that contain `user@gmail.com` and `₹1,234.56`.

Rules:

- Use `escapeMarkdown()` (defined in `TelegramUtils.js`) for any user-supplied text (merchant, username) before concatenating into a message.
- Keep `parse_mode: "Markdown"` consistent in a single message.
- If you must use `MarkdownV2`, do it for the whole message and escape every literal special char.

## Tenant context

Every entry point that touches sheets or sends Telegram messages must be tenant-aware:

- **`extractTransactions`** — sets `setCurrentTenant(tenant)` per-message based on the forwarder's email.
- **`doPost`** — sets tenant from the incoming Telegram `chat_id`.
- **Async triggers (`continueBackfill`, `processWebhookUpdate`)** — restore tenant from state keyed by the invoking trigger's `triggerUid` (so concurrent users don't clobber each other).

Never call `getSpreadsheet()` or `sendTelegramMessage(CHAT_ID, ...)` in a code path that could be shared between tenants. Use `getTenantSheetId()` and `getTenantChatId()` accessors.

## Security checklist for PRs

- Don't commit `AConfig.js` or any `.env`. Double-check with `git diff` before pushing.
- Don't log full email bodies or Azure keys. It's fine to log message ids, chat ids, tenant names.
- Don't bypass `shouldIgnoreMessage` / `isFromAllowedBank` in the happy path — these are the defense-in-depth layer when users misconfigure their Gmail filter.
- Validate `chat_id` ownership before mutating any tenant data — don't trust `chat_id` parameters from callback payloads; re-look up the tenant from the incoming update.
- Avoid regex DoS — anchor patterns, don't build regex from user input.

## Debugging tips

- Apps Script → **Executions** tab shows logs for every run including triggers. Search by function name.
- `console.error` and `console.warn` surface as severity levels in Stackdriver / Executions.
- For local-ish debugging of parsing, paste a raw email body into a scratch function in the script editor and run it directly.
- Test webhook flow: `POST` a Telegram-shaped JSON payload at the `/exec?k=<WEBHOOK_SECRET>` URL with `curl` or a REST client (without `k` the update is dropped when a secret is configured).
- Test parsing locally: `npx vitest run tests/parser.test.js`, or load `BankTemplates.js` + `Parser.js` into a Node `vm` context and call `parseTransactionText(text, { channel, receivedAt })`.

## Pull request checklist

- [ ] `prettier --write` clean
- [ ] No secrets / tokens / personal email addresses in the diff
- [ ] Updated `README.md` / `PRIVACY.md` if behavior changes
- [ ] Verified tenant isolation (no new hard-coded `SHEET_ID` / `CHAT_ID` usage without a fallback through `getTenantSheetId` / `getTenantChatId`)
- [ ] Manual smoke test of the affected flow (command, callback, email processing, `/backfill`, etc.)

Thanks!
