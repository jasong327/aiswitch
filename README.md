# aiswitch

Automatic quota-aware failover between Claude Code and Kimi Code subscriptions.

You hold a Claude Pro/Max subscription and a Kimi Code subscription. Both enforce a
rolling **5-hour** usage window. `aiswitch` runs Claude until its window is nearly
spent, then continues on Kimi, then back again — automatically.

> **cc-switch switches when *you* click; aiswitch switches when your *quota* runs out.**

## Prior art

| Project | Quota-triggered? | Cross-provider? |
|---|---|---|
| [cc-switch](https://github.com/farion1231/cc-switch) 151k★ | ✗ manual; routing-mode failover on request *failure* | ✓ incl. Kimi presets + quota display |
| [claude-swap](https://github.com/realiti4/claude-swap) 4.3k★ | ✓ polls, 90% default | ✗ Anthropic accounts only |
| [quotas](https://github.com/clankercode/quotas) | n/a | ✓ 11 providers, read-only |

None of these does quota-triggered *cross-vendor* switching. That is this tool's
entire job.

## Why not a proxy?

Pointing Claude Code at a local proxy (`LiteLLM`, `claude-code-router`, …) **cannot
work for a subscription-primary setup**: Claude Code compares `ANTHROPIC_BASE_URL`
against the official endpoint and withdraws subscription auth for anything else
([#87876](https://github.com/anthropics/claude-code/issues/87876),
[#91746](https://github.com/anthropics/claude-code/issues/91746)). Claude, Kimi Code
and DeepSeek all speak the Anthropic Messages protocol natively, so switching is
**environment variables only**. `aiswitch` spawns the agent as a child process with a
composed environment and never sits in the request path — it holds no credentials in
flight, loses no prompt caching, and runs no background service.

## Install

```sh
npm install -g aiswitch
# or run from a checkout:
node src/cli.js --help
```

Requires Node >= 20. Zero runtime dependencies.

## Quick start

**1. Install**

```sh
npm install -g aiswitch
```

**2. Scaffold the config**

```sh
aiswitch init
```

This writes the default config with three providers: `claude`, `kimi`,
`deepseek`.

**3. Store your API keys in Keychain**

The `keyCommand` in the config reads a key back by service name, so the service
must match exactly — `aiswitch-kimi` for Kimi Code, `aiswitch-deepseek` for
DeepSeek:

```sh
security add-generic-password -s aiswitch-kimi -a "$USER" -w
security add-generic-password -s aiswitch-deepseek -a "$USER" -w
```

Each command prompts for the key — paste the API key from the provider's
console. (Claude needs no key: it uses your existing native login.)

**4. Verify**

```sh
aiswitch doctor   # "all checks passed" — or fix what it flags
aiswitch status   # shows each provider's 5-hour utilization
```

**5. Preview without launching**

```sh
aiswitch --dry-run
```

This prints which provider would be chosen and the exact child environment,
with any key redacted.

**6. Run**

```sh
aiswitch -p "explain this code"   # non-interactive
aiswitch                          # interactive
```

> If `doctor` flags "stray shell exports", a `~/.zshrc`/`~/.bashrc` alias is
> exporting `ANTHROPIC_*` variables. `aiswitch` clears those from the child it
> launches, but plain `claude` is still hijacked — remove the export to be safe.

## Usage

```
aiswitch [agent args…]            sense → select → launch → supervise
aiswitch status [--json]          per-provider utilization table
aiswitch statusline               one line for settings.json statusLine
aiswitch switch [provider] [--print]  force a tier (--print emits eval-able exports)
aiswitch wait                     block until a provider is eligible
aiswitch doctor                   check env, settings.json, keys, model vars
aiswitch init                     write the default config
```

`aiswitch` consumes only its own flags — `--dry-run`, `--provider=`, `--policy=`,
`--threshold=`, `--no-switch`, `--json`, `--help` — plus a `--` end-of-flags escape.
Everything else passes through to the agent:

```sh
aiswitch -p "explain this code"   # non-interactive run
aiswitch status
aiswitch --dry-run                # print the choice + child env, launch nothing
```

## Configuration

`aiswitch init` writes the default config to `~/.config/aiswitch/config.json`
(`$XDG_CONFIG_HOME/aiswitch/config.json` when set). Provider presets live in
`src/providers/*.json` as data; a fourth provider is a JSON pull request, not a
refactor.

```json
{
  "policy": "failover",
  "threshold": 90,
  "agent": "claude-code",
  "providers": [
    { "name": "claude", "preset": "anthropic-subscription", "priority": 1 },
    { "name": "kimi",   "preset": "kimi-code", "priority": 2,
      "keyCommand": "security find-generic-password -s aiswitch-kimi -w" },
    { "name": "deepseek", "preset": "deepseek", "priority": 3,
      "keyCommand": "security find-generic-password -s aiswitch-deepseek -w" }
  ]
}
```

Keys are never stored in plaintext config — they are resolved through a
`keyCommand` (macOS Keychain by default), mirroring Claude Code's own
`apiKeyHelper`. Keys are redacted in all output except `switch --print`, which is
meant to be eval'd.

Store a key with:

```sh
security add-generic-password -s aiswitch-kimi -a "$USER" -w
```

### Policies

`failover` (default), `least-used`, `round-robin`, `cheapest-first`. The switch
threshold defaults to **90%**, chosen so you are never walled mid-task. A provider is
eligible unless its reading is `limited` or its 5-hour window is at/over the
threshold; `unknown`, `stale` and `error` readings are treated optimistically and
fall through to the reactive path.

### Providers

| Provider | Sensor | Notes |
|---|---|---|
| Claude (subscription) | proactive — reads `~/.claude.json` `cachedUsageUtilization` (read-only) | native auth |
| Kimi Code | proactive — `GET /v1/usages` | one model id across every model var; thinking-only `k3.1-pro` |
| DeepSeek | reactive-only | no quota endpoint; Anthropic-compatible endpoint; no images |

## Honest limitations

- **A switch is not free.** It costs one relaunch and an **uncached transcript
  replay** (`--continue`). Large transcripts are expensive to replay.
- **Automatic relaunch is reliable for non-interactive (`-p`) runs.** Interactive
  sessions do not exit when a limit hits — Claude Code blocks and reports a reset
  time — so `aiswitch` decides at launch for interactive use; use `aiswitch switch`
  for an explicit mid-session handoff. Do not expect "seamless".
- **The Claude reading is a cache.** It is only as fresh as the last Claude Code API
  call. Stale readings are treated optimistically and the reactive path catches a
  real wall.
- **Real limit events cannot be summoned.** The 90%-threshold crossing and
  mid-session wall are only observable when they occur; log `aiswitch status --json`
  on launch to capture the first one.

## Testing & fault injection

```sh
npm test
# Force selection branches without a real limit:
AISWITCH_FAKE='claude:95,kimi:10' node src/cli.js --dry-run
```

## Credits

The Kimi `/usages` response shape was derived from the public-domain
[`quotas`](https://github.com/clankercode/quotas) project (Unlicense/CC0), which read
it out of `kimi-cli`.

## License

MIT
