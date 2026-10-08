// Tenants (personal users and group chats), their forwarder emails, group
// membership and pending group invites.
const USABLE = "('active', 'dormant')";

export async function getTenant(db, id) {
  return db.prepare("SELECT * FROM tenants WHERE id = ?").bind(String(id)).first();
}

export async function listTenants(db, { kind, statuses } = {}) {
  const where = [];
  const params = [];
  if (kind) {
    where.push("kind = ?");
    params.push(kind);
  }
  if (statuses && statuses.length) {
    where.push("status IN (" + statuses.map(() => "?").join(", ") + ")");
    params.push(...statuses);
  }
  const sql = "SELECT * FROM tenants" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY created_at";
  return (
    await db
      .prepare(sql)
      .bind(...params)
      .all()
  ).results;
}

export async function getTenantEmails(db, tenantId) {
  const rows = await db
    .prepare("SELECT email FROM tenant_emails WHERE tenant_id = ? ORDER BY email")
    .bind(String(tenantId))
    .all();
  return rows.results.map((r) => r.email);
}

// Routing for forwarded mail: only usable personal tenants own forwarders.
export async function findTenantByEmail(db, email) {
  return db
    .prepare(
      "SELECT t.* FROM tenant_emails e JOIN tenants t ON t.id = e.tenant_id " +
        "WHERE e.email = ? AND t.kind = 'personal' AND t.status IN " +
        USABLE
    )
    .bind(normalizeEmail(email))
    .first();
}

export async function findPendingTenantByEmail(db, email) {
  return db
    .prepare(
      "SELECT t.* FROM tenant_emails e JOIN tenants t ON t.id = e.tenant_id WHERE e.email = ? AND t.status = 'pending'"
    )
    .bind(normalizeEmail(email))
    .first();
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

// /register: create the tenant as pending if new, then claim the email.
// Returns { ok: true } or { ok: false, conflict: true } when another tenant
// already owns the address (checked after the insert, so a concurrent claim
// can't slip through).
export async function registerEmail(db, tenantId, email, name, now = Date.now()) {
  const id = String(tenantId);
  const addr = normalizeEmail(email);
  await db.batch([
    db
      .prepare(
        "INSERT INTO tenants (id, kind, name, status, created_at) VALUES (?, 'personal', ?, 'pending', ?) " +
          "ON CONFLICT (id) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE tenants.name END"
      )
      .bind(id, name || "", now),
    db.prepare("INSERT OR IGNORE INTO tenant_emails (email, tenant_id) VALUES (?, ?)").bind(addr, id)
  ]);
  const owner = await db.prepare("SELECT tenant_id FROM tenant_emails WHERE email = ?").bind(addr).first("tenant_id");
  return owner === id ? { ok: true } : { ok: false, conflict: true };
}

export async function activateTenant(db, tenantId) {
  const res = await db
    .prepare("UPDATE tenants SET status = 'active' WHERE id = ? AND status IN ('pending', 'dormant')")
    .bind(String(tenantId))
    .run();
  return res.meta.changes > 0;
}

export async function setTenantStatus(db, tenantId, status) {
  const res = await db.prepare("UPDATE tenants SET status = ? WHERE id = ?").bind(status, String(tenantId)).run();
  return res.meta.changes > 0;
}

// Fresh activity (forward, SMS save) stamps last_activity_at and undoes a
// dormant verdict. Returns { reactivated }.
export async function touchActivity(db, tenantId, now = Date.now()) {
  const id = String(tenantId);
  const [reactivate] = await db.batch([
    db
      .prepare(
        "UPDATE tenants SET status = 'active', nag_count = 0, last_nag_at = NULL WHERE id = ? AND status = 'dormant'"
      )
      .bind(id),
    db.prepare("UPDATE tenants SET last_activity_at = ? WHERE id = ?").bind(now, id)
  ]);
  return { reactivated: reactivate.meta.changes > 0 };
}

// One nudge sent; the maxNudges-th flips the tenant to dormant.
export async function recordNag(db, tenantId, maxNudges, now = Date.now()) {
  return db
    .prepare(
      "UPDATE tenants SET nag_count = nag_count + 1, last_nag_at = ?, " +
        "status = CASE WHEN nag_count + 1 >= ? THEN 'dormant' ELSE status END WHERE id = ? RETURNING status, nag_count"
    )
    .bind(now, maxNudges, String(tenantId))
    .first();
}

// ─── Groups ──────────────────────────────────────────────────────────

export async function createGroup(db, { id, name, adminId, members = [], now = Date.now() }) {
  const gid = String(id);
  await db.batch([
    db
      .prepare(
        "INSERT INTO tenants (id, kind, name, status, admin_id, created_at) VALUES (?, 'group', ?, 'active', ?, ?)"
      )
      .bind(gid, name || "", adminId ? String(adminId) : null, now),
    ...members.map((m, i) =>
      db
        .prepare("INSERT OR IGNORE INTO group_members (group_id, member_id, joined_at) VALUES (?, ?, ?)")
        .bind(gid, String(m), now + i)
    )
  ]);
}

// Join order matters: split modes address members by 0-based index.
export async function getGroupMembers(db, groupId) {
  const rows = await db
    .prepare("SELECT member_id FROM group_members WHERE group_id = ? ORDER BY joined_at, rowid")
    .bind(String(groupId))
    .all();
  return rows.results.map((r) => r.member_id);
}

export async function addGroupMember(db, groupId, memberId, now = Date.now()) {
  const res = await db
    .prepare("INSERT OR IGNORE INTO group_members (group_id, member_id, joined_at) VALUES (?, ?, ?)")
    .bind(String(groupId), String(memberId), now)
    .run();
  return res.meta.changes > 0;
}

export async function removeGroupMember(db, groupId, memberId) {
  const res = await db
    .prepare("DELETE FROM group_members WHERE group_id = ? AND member_id = ?")
    .bind(String(groupId), String(memberId))
    .run();
  return res.meta.changes > 0;
}

// Replace the roster, keeping join order for members who stay.
export async function setGroupMembers(db, groupId, members, now = Date.now()) {
  const gid = String(groupId);
  const keep = members.map(String);
  const current = await getGroupMembers(db, gid);
  const stmts = [];
  current
    .filter((m) => !keep.includes(m))
    .forEach((m) =>
      stmts.push(db.prepare("DELETE FROM group_members WHERE group_id = ? AND member_id = ?").bind(gid, m))
    );
  keep
    .filter((m) => !current.includes(m))
    .forEach((m, i) =>
      stmts.push(
        db.prepare("INSERT INTO group_members (group_id, member_id, joined_at) VALUES (?, ?, ?)").bind(gid, m, now + i)
      )
    );
  if (stmts.length) await db.batch(stmts);
}

export async function groupsForMember(db, memberId) {
  const rows = await db
    .prepare(
      "SELECT t.* FROM group_members m JOIN tenants t ON t.id = m.group_id " +
        "WHERE m.member_id = ? AND t.kind = 'group' AND t.status = 'active' ORDER BY t.created_at"
    )
    .bind(String(memberId))
    .all();
  return rows.results;
}

export async function setPinMessageId(db, groupId, pinMessageId) {
  await db
    .prepare("UPDATE tenants SET pin_message_id = ? WHERE id = ? AND kind = 'group'")
    .bind(pinMessageId == null ? null : String(pinMessageId), String(groupId))
    .run();
}

export async function addGroupInvite(db, userId, groupId, now = Date.now()) {
  await db
    .prepare("INSERT OR IGNORE INTO group_invites (user_id, group_id, created_at) VALUES (?, ?, ?)")
    .bind(String(userId), String(groupId), now)
    .run();
}

// Consume all pending invites for a user (called on activation).
export async function takeGroupInvites(db, userId) {
  const rows = await db
    .prepare("DELETE FROM group_invites WHERE user_id = ? RETURNING group_id")
    .bind(String(userId))
    .all();
  return rows.results.map((r) => r.group_id);
}
