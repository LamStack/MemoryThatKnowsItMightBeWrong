// RETRIEVAL PATH
//   (subject, needed slots, audience) -> scope + privacy filter -> lifecycle
//   filter -> effective confidence -> band -> {relied, contested, withheld, missing}
// Retrieval is purpose-scoped: only the slots a task declares it needs are
// loaded. There is no "dump everything into the prompt" mode.

import { effective, freshness, bandOf, stageOf, purgeAt, dormantAt } from './confidence.js';
import { slotDef } from './schema.js';

export function toItem(mem, now, band) {
  const eff = effective(mem, now);
  return {
    id: mem.id,
    subject: mem.subject,
    key: mem.key,
    value: mem.value,
    effective: eff,
    band: band ?? bandOf(eff),
    sourceType: mem.source.type,
    hedged: mem.source.hedged,
    ageMs: now - mem.lastConfirmedAt,
    confirmedAt: mem.lastConfirmedAt,
  };
}

export function retrieve(store, { subject = 'user', keys, audience = 'private' }, trace = []) {
  const t = (step, detail) => trace.push({ path: 'retrieve', step, detail });
  const now = store.now();
  const out = { items: [], contested: [], withheld: [], missing: [] };

  for (const key of keys) {
    const tag = `${subject}.${key}`;
    const def = slotDef(subject, key);
    if (!def) { out.missing.push({ subject, key }); continue; }
    const mems = store.live(subject, key).filter((m) => {
      const s = stageOf(m, now);
      return s !== 'expired' && s !== 'purge';
    });
    if (!mems.length) { out.missing.push({ subject, key }); t('miss', `${tag}: nothing stored`); continue; }

    if (def.sensitivity === 'sensitive' && audience === 'shared') {
      out.withheld.push({ subject, key, reason: 'sensitive-on-shared-screen', count: mems.length });
      t('withhold', `${tag}: sensitive and the audience is "shared", ${mems.length} value(s) not loaded`);
      continue;
    }

    const contested = mems.filter((m) => m.status === 'contested');
    if (contested.length > 1) {
      out.contested.push({ subject, key, items: contested.map((m) => toItem(m, now)) });
      t('contested', `${tag}: ${contested.length} conflicting values, none will be relied on`);
      continue;
    }

    for (const m of mems) {
      const item = toItem(m, now);
      if (item.band === 'faded') {
        if (def.safetyCritical) {
          // Asymmetric risk: forgetting an allergy is worse than remembering one too long.
          item.band = 'verify';
          item.safetyOverride = true;
          t('safety', `${tag}: faded, but safety-critical so it is still honoured conservatively`);
        } else {
          out.withheld.push({ subject, key, reason: 'faded', count: 1 });
          t('withhold', `${tag}: effective ${item.effective.toFixed(2)} < 0.25, treated as unknown`);
          continue;
        }
      }
      out.items.push(item);
      t('load', `${tag}: "${m.value}" effective ${item.effective.toFixed(2)} (${item.band}, ${m.source.type})`);
    }
  }
  return out;
}

// Everything the memory inspector needs, computed at read time.
export function inspect(store) {
  const now = store.now();
  const memories = store.memories.map((m) => {
    const eff = effective(m, now);
    return {
      ...m,
      effective: eff,
      band: bandOf(eff),
      freshness: freshness(m, now),
      stage: stageOf(m, now),
      ageMs: now - m.lastConfirmedAt,
      dormantAt: dormantAt(m),
      purgeAt: m.expiresAt != null ? Math.min(m.expiresAt, purgeAt(m)) : purgeAt(m),
    };
  });
  const rank = (m) => (m.status === 'superseded' ? 2 : m.status === 'contested' ? 0 : 1);
  memories.sort((a, b) => rank(a) - rank(b) || (a.subject === 'user' ? -1 : 1) - (b.subject === 'user' ? -1 : 1) || a.key.localeCompare(b.key));
  const live = memories.filter((m) => m.status !== 'superseded');
  return {
    now,
    memories,
    counts: {
      total: memories.length,
      confident: live.filter((m) => m.status === 'active' && m.band === 'confident').length,
      hedge: live.filter((m) => m.status === 'active' && m.band === 'hedge').length,
      verify: live.filter((m) => m.status === 'active' && (m.band === 'verify' || m.band === 'faded')).length,
      contested: live.filter((m) => m.status === 'contested').length,
      inferred: live.filter((m) => m.source.type === 'inferred').length,
      superseded: memories.length - live.length,
    },
    settings: { ...store.settings },
    doNotRelearn: store.state.blocklist.length,
    audit: store.state.audit.slice(-40).reverse(),
  };
}
