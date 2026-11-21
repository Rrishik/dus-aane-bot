// ISO "YYYY-MM-DD" helpers (UTC arithmetic, so no timezone drift).
export const IST_OFFSET_MS = 5.5 * 3600 * 1000;

export function shiftIsoDate(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

// Calendar date of an instant in IST — the bot's reference timezone.
export function istDate(ms = Date.now()) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}
