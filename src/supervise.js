import { spawn } from 'node:child_process';
import { select } from './select.js';

const TAIL_BYTES = 65536;

/**
 * Spawn the agent once. Interactive (TTY) sessions inherit stdio so the agent
 * keeps its TUI; otherwise stdout/stderr are teed through while the tail is
 * buffered for limit-pattern matching.
 */
export function spawnOnce(adapter, provider, args, env) {
  return new Promise((resolve) => {
    const isTTY = Boolean(process.stdout.isTTY && process.stderr.isTTY);
    const stdio = isTTY ? 'inherit' : ['inherit', 'pipe', 'pipe'];
    const child = spawn(adapter.command, args, { env, stdio });
    let tail = '';
    const capture = (buf) => {
      tail = (tail + buf.toString()).slice(-TAIL_BYTES);
    };
    if (!isTTY) {
      child.stdout?.on('data', (d) => {
        process.stdout.write(d);
        capture(d);
      });
      child.stderr?.on('data', (d) => {
        process.stderr.write(d);
        capture(d);
      });
    }
    const forward = (sig) => child.kill(sig);
    if (!isTTY) {
      process.on('SIGINT', forward);
      process.on('SIGTERM', forward);
    }
    const cleanup = () => {
      if (!isTTY) {
        process.off('SIGINT', forward);
        process.off('SIGTERM', forward);
      }
    };
    child.on('error', (err) => {
      cleanup();
      resolve({ code: 127, signal: null, output: tail, spawnError: err.message });
    });
    child.on('close', (code, signal) => {
      cleanup();
      resolve({ code, signal, output: tail, spawnError: null });
    });
  });
}

/** Limit classification = agent-native signals + provider limitPatterns. */
export function isLimit(adapter, provider, { code, output }) {
  if (adapter.isLimitError({ code, output })) return true;
  const text = String(output).toLowerCase();
  return (provider.limitPatterns ?? []).some((p) => text.includes(String(p).toLowerCase()));
}

/**
 * Launch → supervise → (on limit) re-sense, select the next tier, relaunch with
 * the resume flag, up to `switchCap` switches.
 */
export async function run({
  adapter,
  providers,
  senseAll,
  args,
  baseEnv,
  policy = 'failover',
  threshold = 90,
  switchCap = 3,
  noSwitch = false,
  forceName = null,
  log = (m) => console.error(m),
  onSwitch = () => {},
}) {
  const makeEntries = (readings) => providers.map((p) => ({
    name: p.name,
    reading: readings[p.name],
    priority: p.priority,
    cost: p.cost,
  }));

  let readings = await senseAll();
  const chosen = forceName
    ? { name: forceName, reason: 'forced' }
    : select(makeEntries(readings), { policy, threshold });

  if (!chosen.name) {
    log(`aiswitch: no provider eligible — ${chosen.reason}`);
    return 1;
  }

  let current = chosen.name;
  let runArgs = args;
  let switches = 0;
  const byName = (n) => providers.find((p) => p.name === n);

  while (true) {
    const provider = byName(current);
    const env = adapter.buildEnv(baseEnv, provider);
    const result = await spawnOnce(adapter, provider, runArgs, env);

    if (result.spawnError) {
      log(`aiswitch: ${adapter.command} failed to start: ${result.spawnError}`);
      return result.code ?? 1;
    }
    if (result.code === 0 && !result.signal) return 0;

    readings = await senseAll();
    const fresh = readings[current];
    const limit = isLimit(adapter, provider, result) || (fresh?.state === 'limited');
    if (!limit) return result.code ?? 1;

    if (forceName || noSwitch || switches >= switchCap) {
      const why = forceName
        ? 'forced tier, not switching'
        : noSwitch
          ? 'switching disabled (--no-switch)'
          : `switch cap reached (${switchCap})`;
      log(`aiswitch: ${current} hit its limit (${fresh?.detail || 'limit reached'}); ${why}`);
      return result.code ?? 1;
    }

    const next = select(makeEntries(readings), { policy, threshold, exclude: [current] });
    if (!next.name) {
      const all = select(makeEntries(readings), { policy, threshold });
      log(`aiswitch: ${current} hit its limit and no other provider is eligible${all.resetAt ? ` (earliest reset ${all.resetAt.toISOString()})` : ''}`);
      return result.code ?? 1;
    }

    switches += 1;
    onSwitch(current, next.name, next.reason);
    runArgs = adapter.resumeArgs(args);
    current = next.name;
  }
}
