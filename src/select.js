// Pure provider-selection policies. No I/O, no clock reads except an injected `now`.

/** The primary (5-hour) window is the first one each sensor surfaces. */
export function primaryUtilization(reading) {
  const w = reading?.windows?.[0];
  return typeof w?.utilization === 'number' ? w.utilization : null;
}

/** Eligible unless limited, or the primary window is at/over threshold. */
export function isEligible(reading, threshold) {
  if (!reading) return true;
  if (reading.state === 'limited') return false;
  const util = primaryUtilization(reading);
  if (util !== null && util >= threshold) return false;
  return true;
}

/** Earliest future reset time across every provider's windows. */
export function earliestResetAt(entries, now = Date.now()) {
  let earliest = null;
  for (const e of entries) {
    for (const w of e.reading?.windows ?? []) {
      if (w.resetsAt && w.resetsAt.getTime() > now) {
        if (!earliest || w.resetsAt.getTime() < earliest.getTime()) earliest = w.resetsAt;
      }
    }
  }
  return earliest;
}

function describe(e) {
  const util = primaryUtilization(e.reading);
  if (util !== null) return `${e.name}@${util}%`;
  return `${e.name}(${e.reading?.state ?? 'none'})`;
}

/**
 * select(entries, { policy, threshold, now, previous, exclude })
 *   entries: [{ name, reading, priority?, cost? }]
 * Returns { name, reason, resetAt } — name is null when nothing is eligible,
 * in which case resetAt carries the earliest future reset (for `wait`).
 */
export function select(entries, opts = {}) {
  const { policy = 'failover', threshold = 90, now = Date.now(), previous = null, exclude = [] } = opts;

  const sorted = [...entries].sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity));
  const keep = (e) => !exclude.includes(e.name);
  const eligible = sorted.filter((e) => keep(e) && isEligible(e.reading, threshold));
  const skipped = sorted.filter((e) => keep(e) && !isEligible(e.reading, threshold));

  if (eligible.length === 0) {
    const why = skipped.length
      ? skipped.map(describe).join(', ')
      : 'no providers configured';
    return { name: null, reason: `no eligible provider (${why})`, resetAt: earliestResetAt(sorted, now) };
  }

  let chosen;
  switch (policy) {
    case 'least-used':
      chosen = eligible.reduce((a, b) => {
        const ua = primaryUtilization(a.reading) ?? Number.MAX_SAFE_INTEGER;
        const ub = primaryUtilization(b.reading) ?? Number.MAX_SAFE_INTEGER;
        if (ub < ua) return b;
        if (ub === ua) return (a.priority ?? Infinity) <= (b.priority ?? Infinity) ? a : b;
        return a;
      });
      break;
    case 'round-robin': {
      const idx = eligible.findIndex((e) => e.name === previous);
      chosen = idx >= 0 ? eligible[(idx + 1) % eligible.length] : eligible[0];
      break;
    }
    case 'cheapest-first':
      chosen = eligible.reduce((a, b) => {
        const ca = a.cost ?? Infinity;
        const cb = b.cost ?? Infinity;
        if (cb < ca) return b;
        if (cb === ca) return (a.priority ?? Infinity) <= (b.priority ?? Infinity) ? a : b;
        return a;
      });
      break;
    case 'failover':
    default:
      chosen = eligible[0];
      break;
  }

  const parts = [describe(chosen)];
  if (skipped.length) parts.push(`skipped ${skipped.map(describe).join(', ')}`);
  return { name: chosen.name, reason: parts.join('; '), resetAt: null };
}
