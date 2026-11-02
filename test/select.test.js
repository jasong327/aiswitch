import test from 'node:test';
import assert from 'node:assert/strict';
import { select } from '../src/select.js';

function reading(state, util) {
  return {
    state,
    windows: util === undefined ? [] : [{ name: '5h', utilization: util, resetsAt: null, lockedReason: null }],
    stale: false,
    detail: '',
  };
}

const entries = [
  { name: 'claude', priority: 1, reading: reading('available', 46) },
  { name: 'kimi', priority: 2, reading: reading('available', 10) },
  { name: 'deepseek', priority: 3, reading: reading('unknown') },
];

test('failover picks first eligible by priority', () => {
  assert.equal(select(entries, { policy: 'failover', threshold: 90 }).name, 'claude');
});

test('skips a provider at the threshold', () => {
  const e = [
    { name: 'claude', priority: 1, reading: reading('available', 90) },
    { name: 'kimi', priority: 2, reading: reading('available', 10) },
  ];
  assert.equal(select(e, { policy: 'failover', threshold: 90 }).name, 'kimi');
});

test('skips a limited provider', () => {
  const e = [
    { name: 'claude', priority: 1, reading: reading('limited', 100) },
    { name: 'kimi', priority: 2, reading: reading('available', 10) },
  ];
  assert.equal(select(e, { policy: 'failover', threshold: 90 }).name, 'kimi');
});

test('unknown/stale/error readings are eligible', () => {
  const e = [
    { name: 'deepseek', priority: 1, reading: reading('unknown') },
    { name: 'kimi', priority: 2, reading: reading('available', 10) },
  ];
  assert.equal(select(e, { policy: 'failover', threshold: 90 }).name, 'deepseek');
});

test('least-used picks the lowest utilization', () => {
  assert.equal(select(entries, { policy: 'least-used', threshold: 90 }).name, 'kimi');
});

test('round-robin advances past previous', () => {
  assert.equal(select(entries, { policy: 'round-robin', threshold: 90, previous: 'claude' }).name, 'kimi');
});

test('cheapest-first uses cost', () => {
  const e = [
    { name: 'a', priority: 1, cost: 5, reading: reading('available', 10) },
    { name: 'b', priority: 2, cost: 1, reading: reading('available', 10) },
  ];
  assert.equal(select(e, { policy: 'cheapest-first', threshold: 90 }).name, 'b');
});

test('all limited returns null and earliest reset', () => {
  const now = Date.parse('2026-11-02T12:00:00Z');
  const e = [
    { name: 'claude', priority: 1, reading: { state: 'limited', windows: [{ name: '5h', utilization: 100, resetsAt: new Date('2026-11-02T15:00:00Z'), lockedReason: null }], stale: false, detail: '' } },
    { name: 'kimi', priority: 2, reading: { state: 'limited', windows: [{ name: '5h', utilization: 100, resetsAt: new Date('2026-11-02T14:00:00Z'), lockedReason: null }], stale: false, detail: '' } },
  ];
  const c = select(e, { policy: 'failover', threshold: 90, now });
  assert.equal(c.name, null);
  assert.equal(c.resetAt.toISOString(), '2026-11-02T14:00:00.000Z');
});

test('exclude removes a provider from consideration', () => {
  const c = select(entries, { policy: 'failover', threshold: 90, exclude: ['claude'] });
  assert.equal(c.name, 'kimi');
});
