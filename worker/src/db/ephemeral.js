// Short-lived JSON state with an expiry (pending replies, Re-read results,
// /ask conversations). Expired rows read as absent; purgeExpired() runs on
// the scheduled cleanup.

export async function putEphemeral(db, key, value, ttlSec, now = Date.now()) {
  await db
    .prepare(
      "INSERT INTO ephemeral (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at"
    )
    .bind(key, JSON.stringify(value), now + ttlSec * 1000)
    .run();
}

export async function getEphemeral(db, key, now = Date.now()) {
  const row = await db.prepare("SELECT value, expires_at FROM ephemeral WHERE key = ?").bind(key).first();
  if (!row) return null;
  if (row.expires_at <= now) {
    await deleteEphemeral(db, key);
    return null;
  }
  return JSON.parse(row.value);
}

// Read-and-delete in one statement, so a double tap can't consume twice.
export async function takeEphemeral(db, key, now = Date.now()) {
  const row = await db.prepare("DELETE FROM ephemeral WHERE key = ? RETURNING value, expires_at").bind(key).first();
  if (!row || row.expires_at <= now) return null;
  return JSON.parse(row.value);
}

export async function deleteEphemeral(db, key) {
  await db.prepare("DELETE FROM ephemeral WHERE key = ?").bind(key).run();
}

export async function purgeExpired(db, now = Date.now()) {
  const res = await db.prepare("DELETE FROM ephemeral WHERE expires_at <= ?").bind(now).run();
  return res.meta.changes;
}
