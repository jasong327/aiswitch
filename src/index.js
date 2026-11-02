import {
  loadPresets, loadUserConfig, mergeConfig, resolveProviders, resolveKey, envVarsFor,
  configPath, configDir, DEFAULT_CONFIG, redact,
} from './config.js';
import * as claudeCode from './agents/claude-code.js';
import { senseAll as senseProviders } from './sensors/index.js';
import { select, earliestResetAt } from './select.js';
import { run as superviseRun } from './supervise.js';

export { select, earliestResetAt };
export { configPath, configDir, DEFAULT_CONFIG, loadPresets, loadUserConfig, mergeConfig, resolveProviders, resolveKey, envVarsFor, redact };
export { parseClaudeUsage, sense as senseClaude } from './sensors/claude.js';
export { parseKimiUsage, sense as senseKimi } from './sensors/kimi.js';
export { run as supervise } from './supervise.js';
export const senseAll = senseProviders;

export function adapterFor(id) {
  if (id === 'claude-code') return claudeCode;
  throw new Error(`unknown agent adapter "${id}"`);
}

/** Load presets + user config, resolve providers, and run the protocol gate. */
export async function loadRuntime(env = process.env) {
  const presets = await loadPresets();
  const user = await loadUserConfig(env);
  const config = mergeConfig(user);
  const adapter = adapterFor(config.agent);
  const providers = resolveProviders(config, presets);
  for (const p of providers) {
    if (!adapter.protocols.includes(p.protocol)) {
      throw new Error(
        `agent "${config.agent}" speaks [${adapter.protocols.join(', ')}] but provider "${p.name}" (${p.id}) ` +
        `uses protocol "${p.protocol}". Add a matching agent adapter or drop the provider.`,
      );
    }
  }
  return { presets, config, providers, adapter };
}

/** Resolve keyCommands and attach key + resolvedEnv to each provider. */
export async function resolveKeys(providers) {
  const keys = {};
  await Promise.all(providers.map(async (p) => {
    const key = p.requiresKey ? await resolveKey(p) : null;
    keys[p.name] = key;
    p.key = key;
    p.resolvedEnv = envVarsFor(p);
  }));
  return keys;
}

/**
 * Fault injection: AISWITCH_FAKE="claude:95,kimi:10" overrides readings to force
 * every selection branch. Also accepts `limited`, `unknown`, `error`, `stale`.
 */
export function applyFake(readings, env = process.env) {
  const spec = env.AISWITCH_FAKE;
  if (!spec) return readings;
  const out = { ...readings };
  for (const part of spec.split(',')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    const r = out[name];
    if (!r) continue;
    if (val === 'limited' || val === 'unknown' || val === 'error') {
      out[name] = { ...r, state: val, stale: val !== 'error', detail: `fault-injected ${val}` };
    } else if (val === 'stale') {
      out[name] = { ...r, stale: true, detail: 'fault-injected stale' };
    } else {
      const util = Number(val);
      if (Number.isFinite(util)) {
        const windows = r.windows?.length
          ? r.windows.map((w, i) => (i === 0 ? { ...w, utilization: util, lockedReason: null } : w))
          : [{ name: '5h', utilization: util, resetsAt: null, lockedReason: null }];
        out[name] = { ...r, state: util >= 100 ? 'limited' : 'available', windows, stale: false, detail: `fault-injected ${util}%` };
      }
    }
  }
  return out;
}

/** Programmatic one-shot: sense → select → launch → supervise. */
export async function launch(argv, env = process.env, opts = {}) {
  const { config, providers, adapter } = await loadRuntime(env);
  await resolveKeys(providers);
  return superviseRun({
    adapter,
    providers,
    senseAll: async () => applyFake(await senseProviders(providers, { env }), env),
    args: argv,
    baseEnv: env,
    policy: opts.policy ?? config.policy,
    threshold: opts.threshold ?? config.threshold,
    switchCap: config.switchCap ?? 3,
    noSwitch: opts.noSwitch ?? false,
    forceName: opts.forceName ?? null,
    log: opts.log ?? ((m) => console.error(m)),
    onSwitch: opts.onSwitch ?? ((from, to, reason) => console.error(`aiswitch: ${from} → ${to} (${reason})`)),
  });
}
