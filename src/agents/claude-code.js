// Claude Code agent adapter. Kept intentionally small; a new agent is a new file
// exporting the same shape (id, protocols, command, managedEnv, buildEnv,
// resumeArgs, isLimitError).

export const id = 'claude-code';
export const protocols = ['anthropic-messages'];
export const command = 'claude';

// Constraint 1 (IMPLEMENTATION_PLAN §6): every managed ANTHROPIC_*/CLAUDE_CODE_*
// variable must be cleared from the child env before a provider's block is
// applied, so an inherited shell export can never hijack the subscription leg.
export const managedEnv = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
];

export function buildEnv(baseEnv, provider) {
  const env = { ...baseEnv };
  for (const k of managedEnv) delete env[k];
  Object.assign(env, provider.resolvedEnv ?? {});
  return env;
}

/** Add --continue if absent, so a relaunch resumes rather than starts fresh. */
export function resumeArgs(args) {
  if (args.some((a) => a === '--continue' || a === '-c')) return args;
  return ['--continue', ...args];
}

/** Agent-native limit signals, matched against buffered child output. */
export function isLimitError({ code = 0, output = '' } = {}) {
  const text = String(output).toLowerCase();
  return (
    text.includes('usage limit') ||
    text.includes('rate limit') ||
    /reached your .*limit/.test(text) ||
    text.includes('5-hour') ||
    /resets in/.test(text)
  );
}
