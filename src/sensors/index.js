import { sense as senseClaude } from './claude.js';
import { sense as senseKimi } from './kimi.js';

/** Dispatch one provider to its sensor, or a reactive-only unknown reading. */
export async function senseProvider(provider, { env = process.env, now = Date.now() } = {}) {
  switch (provider.sensor) {
    case 'claude':
      return senseClaude({ env, now });
    case 'kimi':
      return senseKimi({ apiKey: provider.key ?? null, baseUrl: provider.baseUrl ?? null, env, now });
    default:
      return { state: 'unknown', windows: [], stale: true, fetchedAt: null, detail: 'no sensor — reactive-only' };
  }
}

/** Sense every provider in parallel; returns { name: reading }. */
export async function senseAll(providers, { env = process.env, now = Date.now() } = {}) {
  const readings = {};
  await Promise.all(providers.map(async (p) => {
    readings[p.name] = await senseProvider(p, { env, now });
  }));
  return readings;
}
