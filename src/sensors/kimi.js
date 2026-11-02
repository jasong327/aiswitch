import { num, utilizationFrom, untilText, date } from '../util/parse.js';

// Kimi Code quota sensor (IMPLEMENTATION_PLAN §4). The /usages endpoint is
// undocumented; its shape was derived from kimi-cli via the public-domain
// `quotas` project (https://github.com/clankercode/quotas, Unlicense/CC0).
// Therefore: short timeout, catch everything, fail soft to `unknown`.

const FALLBACK_BASES = ['https://api.kimi.ai/coding', 'https://api.kimi.com/coding'];
const TIMEOUT_MS = 5000;

/** Pick the rolling 5-hour window, else the first limits[] entry. */
export function selectWindow(limits) {
  if (!Array.isArray(limits) || limits.length === 0) return null;
  const fiveHour = limits.find((l) => {
    const w = l?.window;
    return w && num(w.duration) === 300 && w.timeUnit === 'TIME_UNIT_MINUTE';
  });
  return fiveHour ?? limits[0] ?? null;
}

/**
 * Pure: build a reading from an already-parsed /usages payload.
 * All numerics arrive as strings — coerce via num().
 */
export function parseKimiUsage(payload, now = Date.now()) {
  const win = selectWindow(payload?.limits);
  let windows = [];
  let primary = null;
  if (win) {
    const d = win.detail ?? {};
    const utilization = utilizationFrom(d.limit, d.remaining);
    const resetsAt = date(d.resetTime);
    primary = { name: '5h', utilization, resetsAt, lockedReason: null };
    windows = [primary];
  }

  // totalQuota: monthly membership cap. Frozen ONLY when `remaining` is present
  // and <= 0. (The `quotas` source infers frozen from `used != 0`; do not copy
  // that — it would hard-block a working provider.)
  const totalQuota = payload?.totalQuota ?? null;
  const rem = num(totalQuota?.remaining);
  const frozen = !!(totalQuota && rem !== null && rem <= 0);

  // `usage` is a legacy weekly window; `used`/`name` are absent live.
  const usage = payload?.usage ?? null;
  const weekly = usage
    ? { utilization: utilizationFrom(usage.limit, usage.remaining), resetsAt: date(usage.resetTime) }
    : null;

  const limited = frozen || (primary?.utilization !== null && primary?.utilization !== undefined && primary.utilization >= 100);

  const detail = frozen
    ? 'monthly membership quota exhausted'
    : limited
      ? `5h window exhausted, resets ${untilText(primary?.resetsAt, now)}`
      : (windows.length === 0 ? 'no 5h window in /usages response' : '');

  return {
    state: limited ? 'limited' : (windows.length ? 'available' : 'unknown'),
    windows,
    stale: false,
    fetchedAt: new Date(now),
    detail,
    frozen,
    weekly,
    monthly: totalQuota
      ? { used: num(totalQuota.used), limit: num(totalQuota.limit), remaining: num(totalQuota.remaining) }
      : null,
  };
}

async function fetchJson(base, apiKey, { timeout = TIMEOUT_MS } = {}) {
  const url = `${base.replace(/\/+$/, '')}/v1/usages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the live /usages endpoint. Try baseUrl, then .ai, then .com.
 * Never throws; a changed/broken endpoint degrades to reactive-only.
 */
export async function sense({ apiKey, baseUrl = null, env = process.env, now = Date.now() } = {}) {
  if (!apiKey) {
    return { state: 'unknown', windows: [], stale: true, fetchedAt: null, detail: 'no Kimi API key — reactive-only' };
  }
  const bases = baseUrl ? [baseUrl, ...FALLBACK_BASES.filter((b) => b !== baseUrl)] : FALLBACK_BASES;
  let lastErr = null;
  for (const base of bases) {
    try {
      const payload = await fetchJson(base, apiKey);
      return parseKimiUsage(payload, now);
    } catch (err) {
      lastErr = err;
    }
  }
  return {
    state: 'unknown',
    windows: [],
    stale: true,
    fetchedAt: null,
    detail: `Kimi /usages unreachable: ${lastErr?.message ?? 'unknown error'}`,
  };
}
