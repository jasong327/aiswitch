import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { date, untilText } from '../util/parse.js';

/**
 * Claude subscription quota sensor.
 *
 * Claude Code caches the account's usage utilization in ~/.claude.json under
 * `cachedUsageUtilization`. There is no documented API for this, and the file
 * is Claude Code's own state: we only ever read it.
 *
 * Because it is a *cache*, it is only as fresh as the last time Claude Code
 * talked to the API. Anything older than STALE_MS is reported as stale, and
 * the selector treats stale readings as optimistically available — the
 * reactive path in supervise.js catches a real wall.
 */
const STALE_MS = 15 * 60 * 1000;

/** Windows we surface, in display order. */
const WINDOWS = [
  ['five_hour', '5h'],
  ['seven_day', '7d'],
];

export function configPath(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR || homedir();
  return join(dir, '.claude.json');
}

/** Pure: build a reading from an already-parsed ~/.claude.json object. */
export function parseClaudeUsage(config, now = Date.now()) {
  const cached = config?.cachedUsageUtilization;
  if (!cached?.utilization) {
    return {
      state: 'unknown',
      windows: [],
      stale: true,
      fetchedAt: null,
      detail: 'no cached usage in ~/.claude.json — run Claude Code once',
    };
  }

  const fetchedAt = date(cached.fetchedAtMs);
  const stale = !fetchedAt || now - fetchedAt.getTime() > STALE_MS;

  const windows = [];
  let locked = null;
  for (const [key, label] of WINDOWS) {
    const w = cached.utilization[key];
    if (!w) continue;
    const utilization = typeof w.utilization === 'number' ? w.utilization : null;
    if (w.locked_reason) locked = w.locked_reason;
    windows.push({
      name: label,
      utilization,
      resetsAt: date(w.resets_at),
      lockedReason: w.locked_reason ?? null,
    });
  }

  if (!windows.length) {
    return {
      state: 'unknown',
      windows: [],
      stale,
      fetchedAt,
      detail: 'cached usage present but no recognised windows',
    };
  }

  const exhausted = windows.find(
    (w) => w.lockedReason || (w.utilization !== null && w.utilization >= 100),
  );

  return {
    state: exhausted ? 'limited' : 'available',
    windows,
    stale,
    fetchedAt,
    detail: exhausted
      ? locked
        ? `locked: ${locked}`
        : `${exhausted.name} window exhausted, resets ${untilText(exhausted.resetsAt, now)}`
      : stale
        ? 'cached reading is stale'
        : '',
  };
}

/** Read and parse the live file. Never throws; failures become readings. */
export async function sense({ env = process.env, now = Date.now() } = {}) {
  const path = configPath(env);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    return {
      state: err.code === 'ENOENT' ? 'auth_required' : 'error',
      windows: [],
      stale: true,
      fetchedAt: null,
      detail:
        err.code === 'ENOENT'
          ? `${path} not found — is Claude Code installed and logged in?`
          : `cannot read ${path}: ${err.message}`,
    };
  }

  try {
    return parseClaudeUsage(JSON.parse(raw), now);
  } catch (err) {
    return {
      state: 'error',
      windows: [],
      stale: true,
      fetchedAt: null,
      detail: `cannot parse ${path}: ${err.message}`,
    };
  }
}
