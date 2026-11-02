#!/usr/bin/env node
import process from 'node:process';
import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import {
  loadRuntime, resolveKeys, senseAll, applyFake, select, DEFAULT_CONFIG, configPath,
} from './index.js';
import { run as supervise } from './supervise.js';
import { redact } from './config.js';
import { primaryUtilization } from './select.js';
import { untilText } from './util/parse.js';

const SUBCOMMANDS = ['status', 'statusline', 'switch', 'wait', 'doctor', 'init'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseArgs(argv) {
  const own = { provider: null, policy: null, threshold: null, noSwitch: false, dryRun: false, json: false, print: false, help: false };
  const passthrough = [];
  let sub = null;
  let endOfFlags = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!endOfFlags && i === 0 && SUBCOMMANDS.includes(a)) {
      sub = a;
      continue;
    }
    if (!endOfFlags && a === '--') {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && a.startsWith('--')) {
      const eq = a.indexOf('=');
      const flag = eq >= 0 ? a.slice(0, eq) : a;
      const inline = eq >= 0 ? a.slice(eq + 1) : null;
      switch (flag) {
        case '--dry-run': own.dryRun = true; break;
        case '--no-switch': own.noSwitch = true; break;
        case '--json': own.json = true; break;
        case '--print': own.print = true; break;
        case '--help': own.help = true; break;
        case '--provider':
        case '--policy':
        case '--threshold': {
          let v = inline;
          if (v === null) v = argv[++i];
          if (v === undefined || v === '') throw new Error(`${flag} needs a value`);
          if (flag === '--provider') own.provider = v;
          else if (flag === '--policy') own.policy = v;
          else own.threshold = v;
          break;
        }
        default:
          passthrough.push(a);
          break;
      }
      continue;
    }
    if (!endOfFlags && a === '-h') {
      own.help = true;
      continue;
    }
    passthrough.push(a);
  }
  return { sub, own, passthrough };
}

export function printHelp() {
  console.log(`aiswitch — quota-aware failover between AI coding subscriptions

USAGE
  aiswitch [agent args…]             sense → select → launch → supervise
  aiswitch status [--json]           per-provider utilization table
  aiswitch statusline                one line for settings.json statusLine
  aiswitch switch [provider] [--print]  force a tier (--print emits eval-able exports)
  aiswitch wait                      block until a provider is eligible
  aiswitch doctor                    check env, settings.json, keys, model vars
  aiswitch init                      write the default config

OWN FLAGS (everything else passes through to the agent)
  --dry-run          print the choice + child env, launch nothing
  --provider NAME    force a tier
  --policy NAME      failover | least-used | round-robin | cheapest-first
  --threshold N      switch threshold percent (default 90)
  --no-switch        never fail over on a limit
  --json             JSON output (status)
  --help             this help

EXAMPLES
  aiswitch -p "explain this code"
  aiswitch status
  aiswitch --dry-run
  eval "$(aiswitch switch kimi --print)"
`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(`aiswitch: ${err.message}`);
    return 2;
  }
  const { sub, own, passthrough } = parsed;
  if (own.help) {
    printHelp();
    return 0;
  }
  try {
    if (sub) return await runSubcommand(sub, own, passthrough, env);
    return await runLaunch(own, passthrough, env);
  } catch (err) {
    console.error(`aiswitch: ${err.message}`);
    return 1;
  }
}

async function runSubcommand(sub, own, args, env) {
  switch (sub) {
    case 'status': return runStatus(own, env);
    case 'statusline': return runStatusline(env);
    case 'switch': return runSwitch(own, args, env);
    case 'wait': return runWait(own, env);
    case 'doctor': return runDoctor(env);
    case 'init': return runInit(env);
  }
}

async function runLaunch(own, args, env) {
  const rt = await loadRuntime(env);
  if (own.policy) rt.config.policy = own.policy;
  if (own.threshold !== null) {
    const n = Number(own.threshold);
    if (!Number.isFinite(n)) throw new Error(`invalid threshold "${own.threshold}"`);
    rt.config.threshold = n;
  }
  await resolveKeys(rt.providers);

  let forceName = null;
  let chosen = null;
  if (own.provider) {
    const p = rt.providers.find((x) => x.name === own.provider);
    if (!p) throw new Error(`unknown provider "${own.provider}" (have: ${rt.providers.map((x) => x.name).join(', ')})`);
    forceName = p.name;
    chosen = { name: p.name, reason: 'forced' };
  }

  const readings = applyFake(await senseAll(rt.providers, { env }), env);
  const entries = rt.providers.map((p) => ({ name: p.name, reading: readings[p.name], priority: p.priority, cost: p.cost }));

  if (!chosen) {
    chosen = select(entries, { policy: rt.config.policy, threshold: rt.config.threshold });
  }

  if (own.dryRun) {
    printDryRun(rt, entries, chosen);
    return chosen.name ? 0 : 1;
  }

  if (!chosen.name) {
    console.error(`aiswitch: no provider eligible — ${chosen.reason}`);
    if (chosen.resetAt) console.error(`  earliest reset: ${chosen.resetAt.toISOString()}`);
    return 1;
  }

  return await supervise({
    adapter: rt.adapter,
    providers: rt.providers,
    senseAll: async () => applyFake(await senseAll(rt.providers, { env }), env),
    args,
    baseEnv: env,
    policy: rt.config.policy,
    threshold: rt.config.threshold,
    switchCap: rt.config.switchCap ?? 3,
    noSwitch: own.noSwitch || Boolean(forceName),
    forceName,
  });
}

function printDryRun(rt, entries, chosen) {
  console.log(`agent:      ${rt.adapter.id} (command: ${rt.adapter.command})`);
  console.log(`policy:     ${rt.config.policy}   threshold: ${rt.config.threshold}%`);
  console.log('');
  for (const e of entries) {
    const r = e.reading;
    const util = primaryUtilization(r);
    const pct = util !== null ? `${util}%` : '—';
    const mark = e.name === chosen.name ? '→' : ' ';
    console.log(`${mark} ${e.name.padEnd(9)} state=${(r.state ?? '?').padEnd(9)} 5h=${pct.padStart(4)}  ${r.detail ?? ''}`);
  }
  console.log('');
  if (!chosen.name) {
    console.log('result:     NO PROVIDER ELIGIBLE');
    if (chosen.resetAt) console.log(`            earliest reset: ${chosen.resetAt.toISOString()}`);
    return;
  }
  console.log(`selected:   ${chosen.name} — ${chosen.reason}`);
  const provider = rt.providers.find((p) => p.name === chosen.name);
  const secrets = provider.key ? [provider.key] : [];
  console.log(`child env:  clears ${rt.adapter.managedEnv.join(', ')}`);
  const keys = Object.keys(provider.resolvedEnv ?? {}).sort();
  if (keys.length === 0) {
    console.log('            (no variables set — native subscription auth)');
  } else {
    for (const k of keys) console.log(`            ${k}=${redact(provider.resolvedEnv[k], secrets)}`);
  }
}

async function runStatus(own, env) {
  const rt = await loadRuntime(env);
  await resolveKeys(rt.providers);
  const readings = applyFake(await senseAll(rt.providers, { env }), env);
  const entries = rt.providers.map((p) => ({ name: p.name, reading: readings[p.name], priority: p.priority, cost: p.cost }));
  const chosen = select(entries, { policy: rt.config.policy, threshold: rt.config.threshold });

  if (own.json) {
    const rows = rt.providers.map((p) => {
      const r = readings[p.name];
      return {
        name: p.name,
        label: p.label,
        chosen: p.name === chosen.name,
        state: r.state,
        stale: r.stale,
        windows: r.windows,
        detail: r.detail,
        monthly: r.monthly ?? null,
        weekly: r.weekly ?? null,
      };
    });
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }

  console.log(`policy=${rt.config.policy}  threshold=${rt.config.threshold}%`);
  console.log(`${'name'.padEnd(10)} ${'state'.padEnd(10)} ${'5h'.padStart(4)} ${'resets'.padEnd(10)} detail`);
  for (const e of entries) {
    const r = e.reading;
    const w = r.windows?.[0];
    const pct = typeof w?.utilization === 'number' ? `${w.utilization}%` : '—';
    const resets = w?.resetsAt ? untilText(w.resetsAt) : '—';
    const mark = e.name === chosen.name ? '→' : ' ';
    console.log(`${mark}${e.name.padEnd(10)} ${(r.state ?? '?').padEnd(10)} ${pct.padStart(4)} ${resets.padEnd(10)} ${r.detail ?? ''}`);
  }
  return 0;
}

async function runStatusline(env) {
  const rt = await loadRuntime(env);
  await resolveKeys(rt.providers);
  const readings = applyFake(await senseAll(rt.providers, { env }), env);
  const entries = rt.providers.map((p) => ({ name: p.name, reading: readings[p.name], priority: p.priority }));
  const chosen = select(entries, { policy: rt.config.policy, threshold: rt.config.threshold });
  const parts = entries.map((e) => {
    const util = primaryUtilization(e.reading);
    const pct = util !== null ? `${util}%` : '—';
    return `${e.name === chosen.name ? '→' : ' '}${e.name} ${pct}`;
  });
  console.log(parts.join(' | '));
  return 0;
}

async function runSwitch(own, args, env) {
  if (!args.length) {
    const rt = await loadRuntime(env);
    await resolveKeys(rt.providers);
    const readings = applyFake(await senseAll(rt.providers, { env }), env);
    const entries = rt.providers.map((p) => ({ name: p.name, reading: readings[p.name], priority: p.priority }));
    const chosen = select(entries, { policy: rt.config.policy, threshold: rt.config.threshold });
    console.log('providers: ' + rt.providers.map((p) => `${p.name}${p.name === chosen.name ? ' (current)' : ''}`).join(', '));
    return 0;
  }
  const name = args[0];
  const rest = args.slice(1);
  const rt = await loadRuntime(env);
  const provider = rt.providers.find((p) => p.name === name);
  if (!provider) throw new Error(`unknown provider "${name}" (have: ${rt.providers.map((p) => p.name).join(', ')})`);
  await resolveKeys(rt.providers);
  if (own.print) {
    for (const k of Object.keys(provider.resolvedEnv ?? {}).sort()) {
      console.log(`export ${k}='${provider.resolvedEnv[k]}'`);
    }
    console.error(`aiswitch: printed ${name} env (including its API key) to stdout — intended for eval`);
    return 0;
  }
  return await supervise({
    adapter: rt.adapter,
    providers: rt.providers,
    senseAll: async () => applyFake(await senseAll(rt.providers, { env }), env),
    args: rest,
    baseEnv: env,
    policy: rt.config.policy,
    threshold: rt.config.threshold,
    switchCap: rt.config.switchCap ?? 3,
    noSwitch: true,
    forceName: name,
  });
}

async function runWait(own, env) {
  const rt = await loadRuntime(env);
  await resolveKeys(rt.providers);
  const threshold = own.threshold !== null ? Number(own.threshold) : rt.config.threshold;
  const policy = own.policy ?? rt.config.policy;
  while (true) {
    const readings = applyFake(await senseAll(rt.providers, { env }), env);
    const entries = rt.providers.map((p) => ({ name: p.name, reading: readings[p.name], priority: p.priority, cost: p.cost }));
    const chosen = select(entries, { policy, threshold });
    if (chosen.name) {
      console.log(`${chosen.name} ready (${chosen.reason})`);
      return 0;
    }
    const resetAt = chosen.resetAt;
    if (resetAt) {
      const delay = Math.max(resetAt.getTime() - Date.now() + 3000, 1000);
      console.error(`aiswitch: all providers limited; earliest reset ${resetAt.toISOString()} (${Math.round(delay / 1000)}s)`);
      await sleep(Math.min(delay, 3600000));
    } else {
      console.error('aiswitch: no provider eligible and no reset time known; retrying in 60s');
      await sleep(60000);
    }
  }
}

async function runDoctor(env) {
  const issues = [];
  const ok = [];
  let rt;
  try {
    rt = await loadRuntime(env);
  } catch (err) {
    console.log('aiswitch doctor');
    console.log(`  ISSUE config: ${err.message}`);
    console.log('\n1 issue(s) found');
    return 1;
  }

  // Constraint 1: stray managed exports in the shell.
  const stray = rt.adapter.managedEnv.filter((k) => env[k]);
  if (stray.length) issues.push(`stray shell exports hijack the subscription leg: ${stray.join(', ')}`);
  else ok.push('no stray ANTHROPIC_*/CLAUDE_CODE_* exports in the shell');

  // Constraint 2: settings.json env block overrides process env.
  const settings = await readSettings(env);
  if (settings.error) issues.push(`cannot read ${settings.path}: ${settings.error}`);
  else if (settings.keys.length) issues.push(`${settings.path} env block sets ${settings.keys.join(', ')} — overrides process env and would hijack native Claude`);
  else ok.push(`no env block in ${settings.path}`);

  // Constraint 5: keys resolvable.
  await resolveKeys(rt.providers);
  for (const p of rt.providers) {
    if (p.requiresKey) {
      if (p.key) ok.push(`${p.name}: key resolved via keyCommand`);
      else issues.push(`${p.name}: requires a key but keyCommand resolved nothing (${p.keyCommand})`);
    }
  }

  // Some providers (Kimi) require one model id across every model variable.
  const modelVars = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];
  for (const p of rt.providers) {
    if (!p.sameModelRequired) continue;
    const vals = modelVars.map((k) => p.resolvedEnv?.[k]).filter((v) => v !== undefined && v !== '');
    const distinct = new Set(vals);
    if (vals.length && distinct.size > 1) issues.push(`${p.name}: model variables disagree (${[...distinct].join(' vs ')}) — this provider needs one model id everywhere`);
  }

  console.log('aiswitch doctor');
  for (const o of ok) console.log(`  ok    ${o}`);
  for (const i of issues) console.log(`  ISSUE ${i}`);
  console.log(issues.length ? `\n${issues.length} issue(s) found` : '\nall checks passed');
  return issues.length ? 1 : 0;
}

async function readSettings(env) {
  const candidates = [join(homedir(), '.claude', 'settings.json')];
  if (env.CLAUDE_CONFIG_DIR) candidates.unshift(join(env.CLAUDE_CONFIG_DIR, 'settings.json'));
  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf8');
      const s = JSON.parse(raw);
      const keys = Object.keys(s?.env ?? {}).filter((k) => k.startsWith('ANTHROPIC') || k.startsWith('CLAUDE_CODE'));
      return { path, keys };
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      return { path, keys: [], error: err.message };
    }
  }
  return { path: candidates[candidates.length - 1], keys: [] };
}

async function runInit(env) {
  const path = configPath(env);
  try {
    await access(path);
    console.log(`${path} already exists — leaving it alone`);
    return 0;
  } catch {}
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  console.log(`wrote ${path}`);
  console.log('providers: ' + DEFAULT_CONFIG.providers.map((p) => p.name).join(', '));
  console.log('store keys with: security add-generic-password -s aiswitch-kimi -a "$USER" -w');
  return 0;
}

function isMain() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(self);
  } catch {
    return process.argv[1] === self;
  }
}

if (isMain()) {
  process.exitCode = await main();
}
