# Future Plan

Roadmap / scratchpad for things to do next. Keep it short and actionable; move items into issues when they mature.

## Admin commands (deferred from Phase 5)

Gate with `ADMIN_CHAT_ID` from `Lol.js`. Silently ignore if the caller isn't the admin.

- `/admin_tenants` — list all tenants: status, name, chat_id, emails, sheet link, created_at
- `/admin_activate <chat_id>` — force a pending tenant to active (support escape hatch)
- `/admin_suspend <chat_id>` / `/admin_resume <chat_id>` — flip `status` to/from `disabled`
- `/admin_remove <chat_id>` — delete Tenants row (sheet left in Drive for audit)
- `/admin_stats` — counters: tenants by status, txns last 24h, inbox lag, recent errors

Nice-to-have hooks:

- `/admin_broadcast <msg>` — DM all active tenants (for downtime/migration notices)
- `/admin_reindex <chat_id>` — re-run `reapplyMerchantResolutions` for a tenant

## Ops & reliability

- **Error DM to admin** — wrap `extractTransactions` / `backfillTransactions` / `doPost` entry points with a single try/catch that DMs the admin (deduped via a ScriptProperty hash to avoid repeat spam)
- **Structured logging** — replace `console.log` with a tiny `log(level, event, fields)` helper that emits JSON so Stackdriver queries are easy
- **Trigger self-heal** — `adminEnsureTriggers()` that installs the hourly `triggerEmailProcessing` if missing (useful after rotating Apps Script project)
- **Stale-pending cleanup** — daily trigger to drop Tenants rows with `status=pending` and `created_at` older than 7 days
- **Quota monitoring** — count UrlFetch calls per execution (Azure OpenAI + Telegram) and log a warning if > 80% of daily limit

## Privacy & data hygiene

- **Tenant data export** — `/admin_export <chat_id>` → CSV dump mailed to the tenant's registered address. Lets users take their data out on demand.
- **Tenant self-delete** — `/forgetme` command: delete tenant row + rename their sheet to `_deleted_<timestamp>_<chat_id>` and revoke editor share. Hard-delete after 30 days.
- **Secret rotation runbook** — document steps for rotating `BOT_TOKEN`, Azure key, `TEMPLATE_SHEET_ID`
- **Audit log** — append a row per activation / suspension to a separate `AuditLog` tab with timestamp, actor, tenant, action

## Codebase cleanup (post Phase 5)

- ~~Move `SHEET_ID` / `CHAT_ID` out of `Constants.js` into the Tenants registry~~ (done in Phase 5 legacy cleanup — tenant 0 now resolves through `findTenantByChatId`)
- Split `Constants.js` — sender allowlists to a standalone `BankSenders.js`; leave UI/category constants in `Constants.js`
- Convert `PropertiesService` scratch state (`pending_merchant_*`, `ask_thinking_msg_id`, `backfill_*`) to a thin `KV` helper with namespacing + TTLs so we stop touching the raw API in 6 places
- Replace the hand-rolled retry/backoff in `sendRequest` with a `requestWithRetry(url, opts)` utility, used by both Telegram and Azure calls
- Centralise `escapeMarkdown` use; `/ask` currently double-escapes some outputs because the AI answer is already plain text

## UX polish

- **Onboarding nudge** — if a user runs `/register` twice with the same email and fails the ownership check, send a short troubleshooting message (check forwarding address, verify Gmail filter, try `/register` again after a minute)
- **Sheet preview in activation DM** — instead of just a link, include a one-line sample of the headers so the user sees what they're getting
- **`/myinfo` — last 24h txn count** — surface liveness to the user ("I've processed 12 txns for you today")
- **Multi-language `/start`** — auto-detect Telegram language code and switch copy (low priority)

## Code review — known minor issues

These came out of the Phase 5 audit but weren't urgent enough to fix inline:

- `processSingleEmail` can loop up to `maxIterations` without breaking when the LLM returns neither content nor tool_calls; currently exits naturally but could log
- `buildCategoryKeyboard` packs 3 per row; for Credit categories (6 items) that's 2 rows of 3 — fine; just note if we add new credits
- `showRecentTransactions` doesn't cap `limit` — a tenant could run `/recent 9999` and time out the webhook. Cap to something like 50.
- `/ask` answer goes through `escapeMarkdown` but the LLM is told "Do NOT use Markdown" — the escape is still useful for `_` in merchant names; keep but document
- `findRecentForwardFromEmail` reads up to 70 message raw contents which is slow. If we ever hit quota, switch to a `labels:` based filter set up once per tenant during `/register`.

## Stretch goals

- **Web dashboard** — a tiny read-only web app (Apps Script HtmlService) using the tenant's `sheet_id` as auth
- **Shared budgets** — mark a category with a monthly cap, alert when crossed
- **Recurring-txn detection** — cluster by merchant + amount + cadence, tag in sheet
- **Cross-tenant splits** — "X owes Y" across two tenants (probably a rabbit hole; needs careful invite/link flow)
