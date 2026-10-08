// Daily /ask quota per tenant, atomic in a single statement each.

// Consume one call for `day` (IST date). Returns { allowed, usedToday }.
// A new day resets the counter; cap_hits counts days the cap was reached.
export async function consumeAsk(db, tenantId, day, cap) {
  const row = await db
    .prepare(
      "INSERT INTO ask_usage (tenant_id, used_on, used_today, lifetime, cap_hits) VALUES (?, ?, 1, 1, CASE WHEN 1 >= ? THEN 1 ELSE 0 END) " +
        "ON CONFLICT (tenant_id) DO UPDATE SET " +
        "used_today = CASE WHEN ask_usage.used_on = excluded.used_on THEN ask_usage.used_today + 1 ELSE 1 END, " +
        "lifetime = ask_usage.lifetime + 1, " +
        "cap_hits = ask_usage.cap_hits + CASE WHEN (CASE WHEN ask_usage.used_on = excluded.used_on THEN ask_usage.used_today + 1 ELSE 1 END) = ? THEN 1 ELSE 0 END, " +
        "used_on = excluded.used_on " +
        "WHERE ask_usage.used_on <> excluded.used_on OR ask_usage.used_today < ? " +
        "RETURNING used_today"
    )
    .bind(String(tenantId), day, cap, cap, cap)
    .first();
  if (row) return { allowed: true, usedToday: row.used_today };
  const current = await db
    .prepare("SELECT used_today FROM ask_usage WHERE tenant_id = ?")
    .bind(String(tenantId))
    .first("used_today");
  return { allowed: false, usedToday: current || 0 };
}

// Undo a same-day consume (the /ask call failed). No-op on another day.
export async function refundAsk(db, tenantId, day, cap) {
  await db
    .prepare(
      "UPDATE ask_usage SET used_today = used_today - 1, lifetime = MAX(lifetime - 1, 0), " +
        "cap_hits = cap_hits - CASE WHEN used_today = ? AND cap_hits > 0 THEN 1 ELSE 0 END " +
        "WHERE tenant_id = ? AND used_on = ? AND used_today > 0"
    )
    .bind(cap, String(tenantId), day)
    .run();
}
