/** Helpers for parsing provider payloads, which are inconsistently typed. */

/**
 * Coerce a value that may arrive as a number or a numeric string.
 * Kimi's /usages endpoint returns every figure as a string (e.g. "100").
 * @returns {number|null} null when the value is absent or unparseable.
 */
export function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

/** Parse a timestamp into a Date, tolerating nulls and junk. */
export function date(value) {
  if (!value) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Percentage used, from a limit/remaining pair. Null if not derivable. */
export function utilizationFrom(limit, remaining) {
  const l = num(limit);
  const r = num(remaining);
  if (l === null || r === null || l <= 0) return null;
  const used = Math.min(Math.max(l - r, 0), l);
  return Math.round((used / l) * 100);
}

/** Human-readable "in 2h 14m", or "now" / "" when unknown. */
export function untilText(when, now = Date.now()) {
  if (!when) return '';
  const ms = when.getTime() - now;
  if (ms <= 0) return 'now';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}
