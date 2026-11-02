import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKimiUsage, selectWindow } from '../src/sensors/kimi.js';

const now = Date.parse('2026-11-02T12:00:00Z');

test('selects the 5-hour window explicitly', () => {
  const limits = [
    { window: { duration: 10080, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '1000', remaining: '500' } },
    { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '10' } },
  ];
  assert.equal(selectWindow(limits).window.duration, 300);
});

test('falls back to first entry when no 5-hour window', () => {
  const limits = [{ window: { duration: 60, timeUnit: 'TIME_UNIT_MINUTE' }, detail: {} }];
  assert.equal(selectWindow(limits).window.duration, 60);
});

test('coerces string numbers and derives utilization', () => {
  const r = parseKimiUsage({
    limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '10', resetTime: '2026-11-02T15:00:00Z' } }],
  }, now);
  assert.equal(r.state, 'available');
  assert.equal(r.windows[0].name, '5h');
  assert.equal(r.windows[0].utilization, 90);
});

test('5h window exhausted → limited', () => {
  const r = parseKimiUsage({
    limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '0', resetTime: '2026-11-02T15:00:00Z' } }],
  }, now);
  assert.equal(r.state, 'limited');
});

test('totalQuota frozen only when remaining <= 0', () => {
  const base = {
    limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '50', resetTime: null } }],
  };
  assert.equal(parseKimiUsage({ ...base, totalQuota: { remaining: '0' } }, now).state, 'limited');
  assert.equal(parseKimiUsage({ ...base, totalQuota: { remaining: '5' } }, now).state, 'available');
  // used > 0 but remaining > 0 is NOT frozen (rejects the `quotas` misreading)
  assert.equal(parseKimiUsage({ ...base, totalQuota: { used: '99', remaining: '1' } }, now).state, 'available');
});

test('no limits and no quota → unknown', () => {
  assert.equal(parseKimiUsage({}, now).state, 'unknown');
});

test('monthly and weekly metadata are surfaced', () => {
  const r = parseKimiUsage({
    limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '50', resetTime: null } }],
    totalQuota: { limit: '1000', used: '100', remaining: '900' },
    usage: { limit: '500', remaining: '400', resetTime: '2026-11-08T00:00:00Z' },
  }, now);
  assert.equal(r.monthly.used, 100);
  assert.equal(r.weekly.utilization, 20);
});
