// WRITE PATH
//   candidate -> privacy gate -> conflict detection -> (insert | reinforce |
//   supersede | contest | resolve | retract) -> persist
// Nothing is ever silently overwritten: every outcome is returned to the caller
// (so the agent can tell the user) and narrated into the trace.

import { SOURCE_BASE, HEDGE_FACTOR, CONTEST_FACTOR, REINFORCE_STEP, BANDS, slotDef, norm } from './schema.js';
import { effective } from './confidence.js';

const INFERRED_CAP = 0.55; // repeating a guess does not make it true

export function write(store, candidates, trace = []) {
  const results = candidates.map((c) => writeOne(store, c, trace));
  store.save();
  return results;
}

function writeOne(store, c, trace) {
  const t = (step, detail) => trace.push({ path: 'write', step, detail });
  const now = store.now();
  const def = slotDef(c.subject, c.key);
  const src = c.source.type;
  const tag = `${c.subject}.${c.key}`;

  if (!def) {
    t('reject', `${tag}: not a slot this memory is allowed to hold`);
    return { action: 'rejected', reason: 'unknown-slot', candidate: c };
  }

  // 1. Privacy gate -- inferences are the invasive part of memory, so they get the strictest rules.
  if (src === 'inferred') {
    if (!store.settings.allowInference) {
      t('gate', `${tag}: inference is switched off, guess discarded`);
      return { action: 'rejected', reason: 'inference-disabled', candidate: c };
    }
    if (def.neverInfer) {
      t('gate', `${tag}: sensitive slot, may only be stored if the user says it themselves`);
      return { action: 'rejected', reason: 'never-infer', candidate: c };
    }
    if (store.isBlocked(c.subject, c.key, c.value)) {
      t('gate', `${tag}: user previously rejected/forgot this, will not silently re-learn it`);
      return { action: 'rejected', reason: 'blocked', candidate: c };
    }
  }

  // 2. Retraction ("I no longer work at Acme")
  if (c.op === 'retract') {
    const hits = store.live(c.subject, c.key).filter((m) => c.value == null || m.valueNorm === norm(c.value));
    if (!hits.length) {
      t('retract', `${tag}: nothing stored matches, nothing to retract`);
      return { action: 'rejected', reason: 'nothing-to-retract', candidate: c };
    }
    for (const m of hits) supersede(store, m, null, now);
    store.audit('retracted', { subject: c.subject, key: c.key, reason: 'user-said-no-longer-true' });
    t('retract', `${tag}: marked no-longer-true; value kept only for the retention window, then erased`);
    settleContests(store);
    return { action: 'retracted', memories: hits, candidate: c };
  }

  const existing = store.live(c.subject, c.key);
  const sameValue = existing.find((m) => m.valueNorm === norm(c.value));

  // 3. Multi-valued slot: values accumulate, each with its own confidence.
  if (def.cardinality === 'multi') {
    if (sameValue) return reinforce(store, sameValue, c, now, t);
    const mem = insert(store, c, def, now);
    t('insert', `${tag}: new value added (${describeBase(mem)})`);
    return { action: 'inserted', memory: mem, candidate: c };
  }

  // 4. Single-valued slot.
  if (sameValue) {
    const others = existing.filter((m) => m !== sameValue);
    const wasContested = sameValue.status === 'contested';
    if (wasContested && src !== 'inferred') {
      others.forEach((m) => supersede(store, m, sameValue, now));
      sameValue.status = 'active';
      sameValue.contestedWith = [];
      sameValue.source = { type: 'user_confirmed', quote: quote(c), at: now, hedged: false };
      sameValue.baseConfidence = SOURCE_BASE.user_confirmed;
      sameValue.lastConfirmedAt = now;
      sameValue.confirmations += 1;
      t('resolve', `${tag}: user picked the surviving value; the contradiction is closed`);
      store.audit('resolved', { subject: c.subject, key: c.key, reason: 'user-picked-side' });
      return { action: 'resolved', memory: sameValue, previous: others, candidate: c };
    }
    return reinforce(store, sameValue, c, now, t);
  }

  if (!existing.length) {
    const mem = insert(store, c, def, now);
    t('insert', `${tag}: slot was empty (${describeBase(mem)})`);
    return { action: 'inserted', memory: mem, candidate: c };
  }

  // A different value already lives in this slot.
  if (src === 'inferred') {
    t('conflict', `${tag}: a guess never overturns something already on file, discarded`);
    return { action: 'rejected', reason: 'inference-cannot-overturn', candidate: c };
  }

  const strongest = existing.reduce((a, b) => (effective(a, now) >= effective(b, now) ? a : b));
  const inContest = existing.some((m) => m.status === 'contested');
  const stale = effective(strongest, now) < BANDS.HEDGE;
  const overInferred = strongest.source.type === 'inferred';

  if (inContest || c.correction || stale || overInferred) {
    const reason = inContest ? 'resolved-by-user' : c.correction ? 'explicit-correction' : stale ? 'old-value-was-stale' : 'stated-beats-inferred';
    const mem = insert(store, c, def, now);
    existing.forEach((m) => supersede(store, m, mem, now));
    settleContests(store);
    t('supersede', `${tag}: new value replaces old (${reason}); old value kept for retention window only`);
    store.audit('superseded', { subject: c.subject, key: c.key, reason });
    return { action: 'superseded', memory: mem, previous: existing, reason, candidate: c };
  }

  // Two fresh, comparable claims, no marker saying which is right -> do not guess. Contest.
  const mem = insert(store, c, def, now);
  const group = [...existing, mem];
  for (const m of group) {
    m.status = 'contested';
    m.baseConfidence *= CONTEST_FACTOR;
    m.contestedWith = group.filter((o) => o !== m).map((o) => o.id);
  }
  t('contest', `${tag}: two fresh claims disagree with no sign of a change; both kept, both confidence x${CONTEST_FACTOR}, neither will be relied on`);
  store.audit('contested', { subject: c.subject, key: c.key, reason: 'fresh-claims-disagree' });
  return { action: 'contested', memory: mem, previous: existing, candidate: c };
}

function quote(c) { return (c.source.quote || '').slice(0, 160); }

function describeBase(mem) {
  return `${mem.source.type}${mem.source.hedged ? ', hedged' : ''}, base ${mem.baseConfidence.toFixed(2)}`;
}

function insert(store, c, def, now) {
  const src = c.source.type;
  let base = c.baseOverride ?? SOURCE_BASE[src];
  if (c.hedged && src !== 'inferred') base *= HEDGE_FACTOR;
  const mem = {
    id: store.nextId(),
    subject: c.subject,
    key: c.key,
    value: c.value,
    valueNorm: norm(c.value),
    source: { type: src, quote: quote(c), at: now, hedged: !!c.hedged },
    baseConfidence: base,
    createdAt: now,
    lastConfirmedAt: now,
    confirmations: 1,
    expiresAt: c.expiresAt ?? null,
    halfLifeDays: c.halfLifeDays ?? null,
    scope: { subject: c.subject, context: def.context, sensitivity: def.sensitivity },
    status: 'active',
    contestedWith: [],
    supersededBy: null,
    supersededAt: null,
  };
  store.state.memories.push(mem);
  return mem;
}

function reinforce(store, mem, c, now, t) {
  const src = c.source.type;
  const incoming = (c.baseOverride ?? SOURCE_BASE[src]) * (c.hedged && src !== 'inferred' ? HEDGE_FACTOR : 1);
  let base = Math.max(1 - (1 - mem.baseConfidence) * REINFORCE_STEP, incoming);
  const wasInferred = mem.source.type === 'inferred';
  if (wasInferred && src !== 'inferred') {
    mem.source = { type: src, quote: quote(c), at: now, hedged: !!c.hedged };
    t('upgrade', `${mem.subject}.${mem.key}: a guess is now something the user said themselves`);
  } else if (wasInferred) {
    base = Math.min(base, INFERRED_CAP);
  }
  mem.baseConfidence = Math.min(0.98, base);
  mem.lastConfirmedAt = now;
  mem.confirmations += 1;
  if (c.expiresAt != null) mem.expiresAt = c.expiresAt;
  t('reinforce', `${mem.subject}.${mem.key}: seen again, confidence -> ${mem.baseConfidence.toFixed(2)}, freshness reset`);
  return { action: 'reinforced', memory: mem, upgraded: wasInferred && src !== 'inferred', candidate: c };
}

function supersede(store, mem, by, now) {
  mem.status = 'superseded';
  mem.supersededAt = now;
  mem.supersededBy = by ? by.id : null;
  mem.contestedWith = [];
}

// After any removal, a contested pair with only one survivor is no longer contested.
export function settleContests(store) {
  for (const m of store.memories) {
    if (m.status !== 'contested') continue;
    const peers = store.live(m.subject, m.key).filter((o) => o !== m && o.status === 'contested');
    if (!peers.length) { m.status = 'active'; m.contestedWith = []; }
  }
}

// The user confirmed a memory the agent asked about (or clicked "still true").
export function confirm(store, mem, trace = []) {
  // A replaced value is history, not a candidate: reviving it would put two live values in one slot.
  if (mem.status === 'superseded') {
    trace.push({ path: 'write', step: 'confirm-refused', detail: `${mem.subject}.${mem.key}: that value was already replaced, nothing to confirm` });
    return null;
  }
  const now = store.now();
  const others = store.live(mem.subject, mem.key).filter((m) => m !== mem && m.status === 'contested');
  others.forEach((m) => supersede(store, m, mem, now));
  mem.status = 'active';
  mem.contestedWith = [];
  mem.source = { ...mem.source, type: 'user_confirmed', at: now, hedged: false };
  mem.baseConfidence = SOURCE_BASE.user_confirmed;
  mem.lastConfirmedAt = now;
  mem.confirmations += 1;
  store.audit('confirmed', { subject: mem.subject, key: mem.key, reason: 'user-confirmed' });
  trace.push({ path: 'write', step: 'confirm', detail: `${mem.subject}.${mem.key}: user confirmed, confidence -> ${mem.baseConfidence}, freshness reset` });
  store.save();
  return mem;
}
