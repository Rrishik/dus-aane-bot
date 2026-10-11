// Read-only aggregates for the admin dashboard. Counts, statuses and
// timestamps only — never amounts, merchants, names, emails or message text.
// Users and groups appear under short hashed ids.
import { sha256Hex } from "../app/auth.js";
import { istDate } from "../util/dates.js";

const DAY_MS = 86400000;
const IST_DAY = "date((%s) / 1000, 'unixepoch', '+330 minutes')";

export async function maskId(prefix, id) {
  return prefix + "-" + (await sha256Hex(String(id))).slice(0, 6);
}

async function all(db, sql, ...params) {
  return (
    await db
      .prepare(sql)
      .bind(...params)
      .all()
  ).results;
}

async function setting(db, key) {
  return db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first("value");
}

export async function collectSummary(db, { now = Date.now(), days = 30 } = {}) {
  const since = now - days * DAY_MS;
  const today = istDate(now);

  const [
    tenants,
    signups,
    sourcesByDay,
    readers,
    parserByTemplate,
    parserFields,
    backlog,
    latest,
    users,
    groups,
    rules
  ] = await Promise.all([
    all(db, "SELECT kind, status, COUNT(*) AS n FROM tenants GROUP BY 1, 2 ORDER BY 1, 2"),
    all(
      db,
      "SELECT " +
        IST_DAY.replace("%s", "created_at") +
        " AS day, COUNT(*) AS n FROM tenants WHERE kind = 'personal' AND created_at >= ? GROUP BY 1 ORDER BY 1",
      since
    ),
    all(
      db,
      "SELECT " +
        IST_DAY.replace("%s", "received_at") +
        " AS day, source, COUNT(*) AS n FROM transaction_sources WHERE received_at >= ? GROUP BY 1, 2 ORDER BY 1",
      since
    ),
    all(
      db,
      "SELECT source, CASE WHEN parsed_by IS NULL THEN 'imported' WHEN parsed_by = 'llm' THEN 'llm' ELSE 'parser' END AS reader, " +
        "COUNT(*) AS n FROM transaction_sources WHERE received_at >= ? GROUP BY 1, 2 ORDER BY 1, 2",
      since
    ),
    all(
      db,
      "SELECT COALESCE(template_id, '(none)') AS template, event, COUNT(*) AS n FROM parser_events WHERE ts >= ? GROUP BY 1, 2",
      since
    ),
    all(
      db,
      "SELECT COALESCE(template_id, '(none)') AS template, event, fields_changed AS fields, COUNT(*) AS n FROM parser_events " +
        "WHERE ts >= ? AND fields_changed IS NOT NULL GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 50",
      since
    ),
    db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM transactions WHERE status = 'review') AS review, " +
          "(SELECT COUNT(*) FROM backfill_jobs) AS backfills, " +
          "(SELECT COUNT(*) FROM ephemeral WHERE expires_at > ?) AS ephemeral_live, " +
          "(SELECT COUNT(*) FROM ephemeral WHERE expires_at <= ?) AS ephemeral_expired"
      )
      .bind(now, now)
      .first(),
    all(db, "SELECT source, MAX(received_at) AS at FROM transaction_sources GROUP BY 1"),
    all(
      db,
      "SELECT t.id, t.status, t.created_at, t.last_activity_at, t.last_nag_at, t.nag_count, " +
        "(SELECT COUNT(*) FROM tenant_emails e WHERE e.tenant_id = t.id) AS emails, " +
        "(SELECT COUNT(*) FROM transactions x WHERE x.tenant_id = t.id AND x.status <> 'deleted') AS txns_total, " +
        "(SELECT COUNT(*) FROM transactions x WHERE x.tenant_id = t.id AND x.status <> 'deleted' AND x.created_at >= ?) AS txns_window, " +
        "(SELECT COUNT(*) FROM transactions x WHERE x.tenant_id = t.id AND x.status = 'review') AS review, " +
        "(SELECT COUNT(*) FROM transaction_sources s WHERE s.tenant_id = t.id AND s.source = 'sms' AND s.received_at >= ?) AS sms_window, " +
        "(SELECT COUNT(*) FROM group_members m WHERE m.member_id = t.id) AS groups, " +
        "COALESCE(a.lifetime, 0) AS ask_lifetime, COALESCE(a.cap_hits, 0) AS ask_cap_hits, " +
        "CASE WHEN a.used_on = ? THEN a.used_today ELSE 0 END AS ask_today " +
        "FROM tenants t LEFT JOIN ask_usage a ON a.tenant_id = t.id WHERE t.kind = 'personal' ORDER BY t.created_at",
      since,
      since,
      today
    ),
    all(
      db,
      "SELECT g.id, g.status, g.pin_message_id IS NOT NULL AS pinned, " +
        "(SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS members, " +
        "(SELECT COUNT(*) FROM splits s WHERE s.group_id = g.id) AS splits_total, " +
        "(SELECT COUNT(*) FROM splits s WHERE s.group_id = g.id AND s.created_at >= ?) AS splits_window, " +
        "(SELECT COUNT(*) FROM settlements s WHERE s.group_id = g.id AND s.created_at >= ?) AS settlements_window " +
        "FROM tenants g WHERE g.kind = 'group' ORDER BY g.created_at",
      since,
      since
    ),
    db.prepare("SELECT SUM(tenant_id = '') AS shared, SUM(tenant_id <> '') AS personal FROM merchant_rules").first()
  ]);

  const templates = {};
  for (const r of parserByTemplate) {
    templates[r.template] = templates[r.template] || {};
    templates[r.template][r.event] = r.n;
  }

  return {
    generatedAt: now,
    days,
    tenants,
    signups,
    sourcesByDay,
    readers,
    parser: {
      mode: (await setting(db, "parser.mode")) || "shadow",
      disabled: String((await setting(db, "parser.disabledTemplates")) || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      templates: Object.entries(templates)
        .map(([template, events]) => ({ template, ...summarizeTemplate(events) }))
        .sort((a, b) => b.reads - a.reads || (a.template < b.template ? -1 : 1)),
      fields: parserFields
    },
    backlog,
    latest: Object.fromEntries(latest.map((r) => [r.source, r.at])),
    users: await Promise.all(users.map(async ({ id, ...rest }) => ({ id: await maskId("u", id), ...rest }))),
    groups: await Promise.all(groups.map(async ({ id, ...rest }) => ({ id: await maskId("g", id), ...rest }))),
    merchantRules: { shared: (rules && rules.shared) || 0, personal: (rules && rules.personal) || 0 }
  };
}

// Per-template counts plus the derived rates the dashboard shows.
export function summarizeTemplate(e) {
  const n = (k) => e[k] || 0;
  const shadow = n("shadow_match") + n("shadow_mismatch");
  const saved = n("saved");
  const wrong = n("reparse_accepted") + n("user_fix");
  return {
    events: e,
    reads: saved + shadow + n("shadow_extra"),
    saved,
    shadowCompared: shadow,
    shadowAgreement: shadow ? n("shadow_match") / shadow : null,
    corrections: wrong,
    correctionRate: saved ? wrong / saved : null,
    reports: n("report")
  };
}
