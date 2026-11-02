import { readFile, readdir } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PRESETS_DIR = join(__dirname, 'providers');

export const DEFAULT_CONFIG = {
  policy: 'failover',
  threshold: 90,
  agent: 'claude-code',
  switchCap: 3,
  providers: [
    { name: 'claude', preset: 'anthropic-subscription', priority: 1 },
    { name: 'kimi', preset: 'kimi-code', priority: 2, keyCommand: 'security find-generic-password -s aiswitch-kimi -w' },
    { name: 'deepseek', preset: 'deepseek', priority: 3, keyCommand: 'security find-generic-password -s aiswitch-deepseek -w' },
  ],
};

export function configDir(env = process.env) {
  return env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'aiswitch') : join(homedir(), '.config', 'aiswitch');
}

export function configPath(env = process.env) {
  return join(configDir(env), 'config.json');
}

/** Load every preset JSON in src/providers/, keyed by preset id. */
export async function loadPresets() {
  const files = await readdir(PRESETS_DIR);
  const presets = {};
  for (const f of files.sort()) {
    if (!f.endsWith('.json')) continue;
    const raw = await readFile(join(PRESETS_DIR, f), 'utf8');
    const p = JSON.parse(raw);
    presets[p.id] = p;
  }
  return presets;
}

/** Read the user config, or null when it does not exist yet. */
export async function loadUserConfig(env = process.env) {
  try {
    const raw = await readFile(configPath(env), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`cannot read config ${configPath(env)}: ${err.message}`);
  }
}

export function mergeConfig(user) {
  const cfg = { ...DEFAULT_CONFIG, ...(user ?? {}) };
  if (typeof cfg.threshold === 'string') cfg.threshold = Number(cfg.threshold);
  return cfg;
}

/** Resolve a config's provider entries against presets, into runtime objects. */
export function resolveProviders(config, presets) {
  const providers = [];
  for (const entry of config.providers ?? []) {
    const preset = presets[entry.preset];
    if (!preset) throw new Error(`unknown preset "${entry.preset}" for provider "${entry.name}"`);
    const defaults = { ...(preset.defaults ?? {}), ...(entry.defaults ?? {}) };
    const env = { ...(preset.env ?? {}) };
    for (const [k, v] of Object.entries(entry.env ?? {})) {
      if (v === null) delete env[k];
      else env[k] = v;
    }
    providers.push({
      name: entry.name,
      id: preset.id,
      label: preset.label,
      protocol: preset.protocol,
      sensor: preset.sensor ?? null,
      requiresKey: preset.requiresKey ?? false,
      sameModelRequired: preset.sameModelRequired ?? false,
      defaults,
      env,
      limitPatterns: preset.limitPatterns ?? [],
      priority: entry.priority ?? 999,
      keyCommand: entry.keyCommand ?? null,
      baseUrl: entry.baseUrl ?? null,
      cost: entry.cost ?? preset.cost ?? null,
      console: preset.console ?? null,
      docs: preset.docs ?? null,
      notes: preset.notes ?? null,
    });
  }
  providers.sort((a, b) => a.priority - b.priority);
  return providers;
}

/** Substitute {{key}}, {{model}}, {{fastModel}}, {{contextTokens}}, {{effort}}. */
export function renderEnv(template, vars) {
  const out = {};
  for (const [k, v] of Object.entries(template ?? {})) {
    out[k] = String(v).replace(/\{\{(\w+)\}\}/g, (_, name) => (vars[name] ?? ''));
  }
  return out;
}

/** Build the provider's env block from defaults + a resolved key. */
export function envVarsFor(provider) {
  return renderEnv(provider.env, {
    key: provider.key ?? '',
    model: provider.defaults.model ?? '',
    fastModel: provider.defaults.fastModel ?? '',
    contextTokens: provider.defaults.contextTokens ?? '',
    effort: provider.defaults.effort ?? '',
  });
}

/** Run a provider's keyCommand; never throws. Returns null on failure. */
export async function resolveKey(provider, { timeout = 10000 } = {}) {
  if (!provider.keyCommand) return null;
  try {
    const { stdout } = await execAsync(provider.keyCommand, { timeout, encoding: 'utf8' });
    const key = (stdout ?? '').trim();
    return key || null;
  } catch {
    return null;
  }
}

/** Redact known secret values from a string. */
export function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) {
    if (s) out = out.split(s).join('***');
  }
  return out;
}
