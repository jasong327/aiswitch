import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeArgs, isLimitError, buildEnv } from '../src/agents/claude-code.js';

test('resumeArgs adds --continue when absent', () => {
  assert.deepEqual(resumeArgs(['-p', 'hi']), ['--continue', '-p', 'hi']);
});

test('resumeArgs is idempotent', () => {
  assert.deepEqual(resumeArgs(['--continue', '-p']), ['--continue', '-p']);
});

test('isLimitError matches native limit phrasing', () => {
  assert.equal(isLimitError({ output: "You've reached your usage limit for Claude." }), true);
  assert.equal(isLimitError({ output: 'error: rate limit exceeded' }), true);
  assert.equal(isLimitError({ output: 'something else entirely' }), false);
});

test('buildEnv never inherits a managed var without a provider value', () => {
  const env = buildEnv({ ANTHROPIC_API_KEY: 'leak' }, { resolvedEnv: {} });
  assert.equal('ANTHROPIC_API_KEY' in env, false);
});
