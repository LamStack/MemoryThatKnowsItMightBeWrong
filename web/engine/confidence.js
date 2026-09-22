// Confidence is never a stored number you trust blindly. What is stored is the
// *base* confidence at the moment of the last confirmation; what the agent uses
// is the *effective* confidence, recomputed from age every time it reads.

import {
  DAY, BANDS, DORMANT_GRACE_DAYS, SUPERSEDED_RETENTION_DAYS,
  INFERRED_HALF_LIFE_FACTOR, slotDef,
} from './schema.js';

export function halfLifeMs(mem) {
  const def = slotDef(mem.subject, mem.key);
  let days = mem.halfLifeDays ?? def?.halfLifeDays ?? 365;
  if (mem.source.type === 'inferred') days *= INFERRED_HALF_LIFE_FACTOR;
  return days * DAY;
}

export function freshness(mem, now) {
  const age = Math.max(0, now - mem.lastConfirmedAt);
  return Math.pow(0.5, age / halfLifeMs(mem));
}

export function effective(mem, now) {
  return mem.baseConfidence * freshness(mem, now);
}

export function bandOf(eff) {
  if (eff >= BANDS.CONFIDENT) return 'confident';
  if (eff >= BANDS.HEDGE) return 'hedge';
  if (eff >= BANDS.VERIFY) return 'verify';
  return 'faded';
}

// The exact moment effective confidence crosses below the VERIFY line.
// Deterministic, so a sweep that runs late still forgets on the right schedule.
export function dormantAt(mem) {
  if (mem.baseConfidence <= BANDS.VERIFY) return mem.lastConfirmedAt;
  const halves = Math.log2(mem.baseConfidence / BANDS.VERIFY);
  return mem.lastConfirmedAt + halves * halfLifeMs(mem);
}

export function purgeAt(mem) {
  if (mem.status === 'superseded') return mem.supersededAt + SUPERSEDED_RETENTION_DAYS * DAY;
  return dormantAt(mem) + DORMANT_GRACE_DAYS * DAY;
}

export function isExpired(mem, now) {
  return mem.expiresAt != null && now >= mem.expiresAt;
}

// Where a memory is in its life, computed from time alone.
export function stageOf(mem, now) {
  if (isExpired(mem, now)) return 'expired';
  if (mem.status === 'superseded') return now >= purgeAt(mem) ? 'purge' : 'superseded';
  if (now >= purgeAt(mem)) return 'purge';
  if (effective(mem, now) < BANDS.VERIFY) return 'fading';
  return mem.status; // active | contested
}

export function describeAge(ms) {
  const d = ms / DAY;
  if (d < 1 / 24) return 'just now';
  if (d < 1) return `${Math.max(1, Math.round(d * 24))} hour${Math.round(d * 24) === 1 ? '' : 's'} ago`;
  if (d < 14) return `${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'} ago`;
  if (d < 60) return `${Math.round(d / 7)} weeks ago`;
  if (d < 700) return `${Math.round(d / 30.4)} months ago`;
  const y = d / 365;
  return `about ${y.toFixed(y < 3 ? 1 : 0).replace(/\.0$/, '')} years ago`;
}

export function describeIn(ms) {
  const d = ms / DAY;
  if (d < 1) return 'within a day';
  if (d < 60) return `in ${Math.round(d)} days`;
  if (d < 700) return `in ${Math.round(d / 30.4)} months`;
  return `in ${(d / 365).toFixed(1)} years`;
}

export const pct = (x) => `${Math.round(x * 100)}%`;
