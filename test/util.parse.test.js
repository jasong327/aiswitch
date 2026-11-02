import test from 'node:test';
import assert from 'node:assert/strict';
import { num, date, utilizationFrom, untilText } from '../src/util/parse.js';

test('num coerces strings and rejects junk', () => {
  assert.equal(num('100'), 100);
  assert.equal(num(42), 42);
  assert.equal(num(' 7 '), 7);
  assert.equal(num(null), null);
  assert.equal(num(undefined), null);
  assert.equal(num(''), null);
  assert.equal(num('abc'), null);
});

test('date parses ISO and ms, tolerates junk', () => {
  assert.ok(date('2026-11-02T10:50:00Z') instanceof Date);
  assert.ok(date(1793607174323) instanceof Date);
  assert.equal(date(null), null);
  assert.equal(date('junk'), null);
});

test('utilizationFrom derives a clamped percentage', () => {
  assert.equal(utilizationFrom(100, 90), 10);
  assert.equal(utilizationFrom('100', '0'), 100);
  assert.equal(utilizationFrom(0, 0), null);
  assert.equal(utilizationFrom(null, 10), null);
  assert.equal(utilizationFrom(100, 150), 0);
});

test('untilText formats durations', () => {
  const now = Date.now();
  assert.equal(untilText(new Date(now - 1000), now), 'now');
  assert.equal(untilText(new Date(now + 30 * 60000), now), 'in 30m');
  assert.equal(untilText(new Date(now + 2 * 3600000 + 14 * 60000), now), 'in 2h 14m');
  assert.equal(untilText(null, now), '');
});
