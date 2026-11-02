import test from 'node:test';
import assert from 'node:assert/strict';
import { renderEnv, resolveProviders, mergeConfig } from '../src/config.js';
import { managedEnv, buildEnv } from '../src/agents/claude-code.js';

test('renderEnv substitutes placeholders and blanks missing ones', () => {
  const out = renderEnv(
    { A: '{{key}}', B: 'https://{{model}}', C: '{{missing}}', D: 'literal' },
    { key: 'secret', model: 'm1' },
  );
  assert.equal(out.A, 'secret');
  assert.equal(out.B, 'https://m1');
  assert.equal(out.C, '');
  assert.equal(out.D, 'literal');
});

test('resolveProviders merges preset defaults and env, deletes null overrides', () => {
  const presets = {
    p1: { id: 'p1', protocol: 'anthropic-messages', sensor: null, requiresKey: false, defaults: { model: 'a' }, env: { X: '{{model}}' }, limitPatterns: [] },
  };
  const cfg = { providers: [{ name: 'n', preset: 'p1', priority: 1, defaults: { model: 'b' }, env: { X: '{{model}}', Y: null } }] };
  const ps = resolveProviders(cfg, presets);
  assert.equal(ps[0].defaults.model, 'b');
  assert.equal(ps[0].env.X, '{{model}}');
  assert.equal('Y' in ps[0].env, false);
});

test('resolveProviders throws on unknown preset', () => {
  assert.throws(() => resolveProviders({ providers: [{ name: 'n', preset: 'nope' }] }, {}), /unknown preset/);
});

test('mergeConfig applies user overrides and keeps defaults', () => {
  const cfg = mergeConfig({ threshold: '95', providers: [] });
  assert.equal(cfg.threshold, 95);
  assert.deepEqual(cfg.providers, []);
  assert.equal(cfg.agent, 'claude-code');
});

test('managedEnv clears inherited vars then buildEnv applies provider env', () => {
  const base = { ANTHROPIC_BASE_URL: 'stale', KEEP: '1' };
  const provider = { resolvedEnv: { ANTHROPIC_BASE_URL: 'https://new', ANTHROPIC_API_KEY: 'k' } };
  const env = buildEnv(base, provider);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://new');
  assert.equal(env.ANTHROPIC_API_KEY, 'k');
  assert.equal(env.KEEP, '1');
  assert.equal('CLAUDE_CODE_SUBAGENT_MODEL' in env, false);
});

test('managedEnv covers the full constraint-1 list', () => {
  for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS']) {
    assert.ok(managedEnv.includes(k), `missing ${k}`);
  }
});
