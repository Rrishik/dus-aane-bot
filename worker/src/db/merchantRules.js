// Merchant rules (name / category / kind per pattern). tenant_id '' holds the
// shared defaults; a tenant's own rows are returned first so they win.
const SHARED = "";

export async function getMerchantRules(db, tenantId) {
  const rows = await db
    .prepare(
      "SELECT tenant_id, pattern, name, category, kind FROM merchant_rules WHERE tenant_id IN (?, ?) " +
        "ORDER BY CASE WHEN tenant_id = ? THEN 0 ELSE 1 END, length(pattern) DESC"
    )
    .bind(String(tenantId), SHARED, String(tenantId))
    .all();
  return rows.results.map((r) => ({
    pattern: r.pattern,
    name: r.name,
    category: r.category,
    kind: r.kind,
    personal: r.tenant_id !== SHARED
  }));
}

// Upsert; omitted fields keep their stored value. tenantId null/'' = shared.
export async function upsertMerchantRule(db, tenantId, pattern, fields, now = Date.now()) {
  const p = String(pattern || "")
    .trim()
    .toLowerCase();
  if (!p) throw new Error("upsertMerchantRule: pattern required");
  const has = (k) => Object.prototype.hasOwnProperty.call(fields, k);
  await db
    .prepare(
      "INSERT INTO merchant_rules (tenant_id, pattern, name, category, kind, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (tenant_id, pattern) DO UPDATE SET " +
        "name = CASE WHEN ? THEN excluded.name ELSE merchant_rules.name END, " +
        "category = CASE WHEN ? THEN excluded.category ELSE merchant_rules.category END, " +
        "kind = CASE WHEN ? THEN excluded.kind ELSE merchant_rules.kind END, " +
        "updated_at = excluded.updated_at"
    )
    .bind(
      tenantId ? String(tenantId) : SHARED,
      p,
      has("name") ? fields.name : null,
      has("category") ? fields.category : null,
      has("kind") ? fields.kind : null,
      now,
      has("name"),
      has("category"),
      has("kind")
    )
    .run();
}

// Resolve a raw merchant against rules (case-insensitive substring). Name,
// category and kind resolve independently: the first matching rule that has
// each one supplies it, so a category-only personal rule doesn't mask a
// shared name. `personalCategory` marks a user's own category, which beats
// the LLM's guess.
export function resolveMerchant(rawName, rules) {
  const out = { merchant: rawName, category: null, kind: null, personalCategory: false };
  if (!rawName || !rules || rules.length === 0) return out;
  const lower = String(rawName).toLowerCase();
  let nameDone = false;
  for (const r of rules) {
    if (!lower.includes(r.pattern)) continue;
    if (!nameDone && r.name) {
      out.merchant = r.name;
      nameDone = true;
    }
    if (!out.category && r.category) {
      out.category = r.category;
      out.personalCategory = r.personal;
    }
    if (!out.kind && r.kind) out.kind = r.kind;
  }
  // A rule keyed on the resolved name (e.g. a 📂 tap on "Swiggy") also counts,
  // and a personal one overrides a shared category found via the raw string.
  if (nameDone) {
    const byName = rules.filter((r) => r.pattern === String(out.merchant).toLowerCase());
    for (const r of byName) {
      if (r.category && (!out.category || (r.personal && !out.personalCategory))) {
        out.category = r.category;
        out.personalCategory = r.personal;
      }
      if (!out.kind && r.kind) out.kind = r.kind;
    }
  }
  return out;
}

// Privacy-safe k-anonymity promotion: when >= 2 independent tenants map the
// same merchant pattern (>= 4 chars) to the same (name, category), promote it
// into shared `merchant_rules (tenant_id = '')`.
export async function promoteConsensusMerchantRules(db, now = Date.now()) {
  const candidates = (
    await db
      .prepare(
        "SELECT pattern, COALESCE(name, '') AS norm_name, category, MAX(kind) AS kind, COUNT(DISTINCT tenant_id) AS tenants " +
          "FROM merchant_rules " +
          "WHERE tenant_id <> '' AND category IS NOT NULL AND TRIM(category) <> '' AND length(pattern) >= 4 " +
          "GROUP BY pattern, COALESCE(name, ''), category " +
          "HAVING COUNT(DISTINCT tenant_id) >= 2"
      )
      .all()
  ).results;

  const promoted = [];
  for (const c of candidates) {
    const existing = await db
      .prepare("SELECT name, category FROM merchant_rules WHERE tenant_id = '' AND pattern = ?")
      .bind(c.pattern)
      .first();
    if (existing && (existing.name || "") === c.norm_name && existing.category === c.category) continue;
    const fields = { category: c.category };
    if (c.norm_name) fields.name = c.norm_name;
    if (c.kind) fields.kind = c.kind;
    await upsertMerchantRule(db, SHARED, c.pattern, fields, now);
    promoted.push({ pattern: c.pattern, name: c.norm_name || null, category: c.category, tenants: c.tenants });
  }
  return promoted;
}

export async function recentLearnedRules(db, sinceMs, limit = 8) {
  return (
    await db
      .prepare(
        "SELECT pattern, MAX(name) AS name, category, COUNT(DISTINCT tenant_id) AS tenants " +
          "FROM merchant_rules WHERE tenant_id <> '' AND updated_at >= ? AND category IS NOT NULL " +
          "GROUP BY pattern, category ORDER BY tenants DESC, MAX(updated_at) DESC LIMIT ?"
      )
      .bind(sinceMs, limit)
      .all()
  ).results;
}
