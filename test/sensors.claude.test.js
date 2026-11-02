import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseClaudeUsage, sense } from '../src/sensors/claude.js';

const now = Date.parse('2026-11-02T12:00:00Z');

function cfg(utilization, fetchedAtMs = now) {
  return { cachedUsageUtilization: { fetchedAtMs, utilization } };
}

test('available reading surfaces 5h and 7d windows', () => {
  const r = parseClaudeUsage(cfg({
    five_hour: { utilization: 46, resets_at: '2026-11-02T10:50:00Z', locked_reason: null },
    seven_day: { utilization: 26, resets_at: '2026-11-08T01:00:00Z', locked_reason: null },
  }), now);
  assert.equal(r.state, 'available');
  assert.equal(r.windows[0].name, '5h');
  assert.equal(r.windows[0].utilization, 46);
  assert.equal(r.windows[1].name, '7d');
});

test('locked_reason → limited', () => {
  const r = parseClaudeUsage(cfg({
    five_hour: { utilization: 50, resets_at: null, locked_reason: 'usage limit reached' },
  }), now);
  assert.equal(r.state, 'limited');
});

test('utilization >= 100 → limited', () => {
  const r = parseClaudeUsage(cfg({
    five_hour: { utilization: 100, resets_at: '2026-11-02T10:50:00Z', locked_reason: null },
  }), now);
  assert.equal(r.state, 'limited');
});

test('null utilization is not treated as exhausted', () => {
  const r = parseClaudeUsage(cfg({
    five_hour: { utilization: null, resets_at: null, locked_reason: null },
  }), now);
  assert.equal(r.state, 'available');
});

test('absent cachedUsageUtilization → unknown', () => {
  const r = parseClaudeUsage({}, now);
  assert.equal(r.state, 'unknown');
});

test('absent windows → unknown', () => {
  const r = parseClaudeUsage(cfg({}), now);
  assert.equal(r.state, 'unknown');
});

test('stale reading is still optimistically available', () => {
  const stale = now - 16 * 60 * 1000;
  const r = parseClaudeUsage(cfg({
    five_hour: { utilization: 10, resets_at: null, locked_reason: null },
  }, stale), now);
  assert.equal(r.stale, true);
  assert.equal(r.state, 'available');
});

test('sense reads a fixture file', async () => {
  const dir = fileURLToPath(new URL('./fixtures/claude', import.meta.url));
  const r = await sense({ env: { CLAUDE_CONFIG_DIR: dir } });
  assert.equal(r.state, 'available');
  assert.equal(r.windows.length, 2);
  assert.equal(r.windows[0].utilization, 46);
});

test('sense on malformed json → error', async () => {
  const dir = fileURLToPath(new URL('./fixtures/claude-malformed', import.meta.url));
  const r = await sense({ env: { CLAUDE_CONFIG_DIR: dir } });
  assert.equal(r.state, 'error');
});

test('sense on missing file → auth_required', async () => {
  const dir = fileURLToPath(new URL('./fixtures/nonexistent', import.meta.url));
  const r = await sense({ env: { CLAUDE_CONFIG_DIR: dir } });
  assert.equal(r.state, 'auth_required');
});
