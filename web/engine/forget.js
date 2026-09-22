// FORGETTING PATH -- five distinct ways a memory ends, each explicit:
//   expired     a fact that said "this week" reaches its end date
//   faded       effective confidence stayed below the VERIFY line for the grace period
//   superseded  replaced/retracted; the old value is kept briefly, then erased
//   rejected    the user said "that's wrong"
//   revoked     the user said "forget it" (hard delete, plus do-not-relearn)
// Erasure removes the record from the store entirely. What is left behind is
// only an audit line (slot name + reason, never the value) and, for revoked or
// rejected items, a hashed do-not-relearn marker.

import { stageOf } from './confidence.js';
import { norm } from './schema.js';
import { settleContests } from './write.js';

const t = (trace, step, detail) => trace.push({ path: 'forget', step, detail });

// Time-driven forgetting. Safe to run at any moment; run at the start of every turn.
export function sweep(store, trace = []) {
  const now = store.now();
  const removed = [];
  for (const m of [...store.memories]) {
    const stage = stageOf(m, now);
    if (stage !== 'expired' && stage !== 'purge') continue;
    const reason = stage === 'expired' ? 'expired' : m.status === 'superseded' ? 'superseded-retention-ended' : 'faded';
    store.remove(m.id);
    store.audit('erased', { subject: m.subject, key: m.key, reason });
    removed.push({ subject: m.subject, key: m.key, reason });
    t(trace, reason, `${m.subject}.${m.key}: erased (${reason})`);
  }
  if (removed.length) { settleContests(store); store.save(); }
  return removed;
}

function erase(store, mems, type, reason, trace) {
  for (const m of mems) {
    store.remove(m.id);
    store.audit(type, { subject: m.subject, key: m.key, reason });
    t(trace, type, `${m.subject}.${m.key}: hard-deleted (value, quote and history removed)`);
  }
  settleContests(store);
}

// "Forget my allergies" -> delete the whole slot, history included, and stop guessing it.
export function forgetSlot(store, subject, key, trace = [], { block = true } = {}) {
  const mems = store.slot(subject, key);
  erase(store, mems, 'revoked', 'user-revoked-slot', trace);
  if (block) { store.block(subject, key); t(trace, 'do-not-relearn', `${subject}.${key}: will not be inferred again`); }
  store.save();
  return mems.length;
}

// "Forget that I live in Berlin" -> delete that value; if it was the live one, its replaced history goes too.
export function forgetValue(store, subject, key, value, trace = [], { block = true } = {}) {
  const hits = store.slot(subject, key).filter((m) => m.valueNorm === norm(value));
  const wasLive = hits.some((m) => m.status !== 'superseded');
  const doomed = wasLive ? [...new Set([...hits, ...store.slot(subject, key).filter((m) => m.status === 'superseded')])] : hits;
  erase(store, doomed, 'revoked', 'user-revoked-value', trace);
  if (hits.length && block) { store.block(subject, key, value); t(trace, 'do-not-relearn', `${subject}.${key}: this value will not be inferred again`); }
  store.save();
  return hits.length;
}

// "Forget my sister" -> everything about that person.
export function forgetSubject(store, subject, trace = []) {
  const mems = store.memories.filter((m) => m.subject === subject);
  const keys = new Set(mems.map((m) => m.key));
  erase(store, mems, 'revoked', 'user-revoked-subject', trace);
  keys.forEach((k) => store.block(subject, k));
  store.save();
  return mems.length;
}

// "Forget everything you guessed about me."
export function forgetInferred(store, trace = []) {
  const mems = store.memories.filter((m) => m.source.type === 'inferred');
  mems.forEach((m) => store.block(m.subject, m.key, m.value));
  erase(store, mems, 'revoked', 'user-revoked-inferences', trace);
  store.save();
  return mems.length;
}

// "Forget everything." Clean slate: memories, do-not-relearn list and audit trail all go.
export function forgetAll(store, trace = []) {
  const n = store.memories.length;
  store.state.memories = [];
  store.state.blocklist = [];
  store.state.audit = [];
  store.state.session = { pending: null, lastRelied: [] };
  store.audit('revoked-all', { reason: 'user-wiped-everything' });
  t(trace, 'wipe', `${n} memories, the do-not-relearn list and the audit trail were deleted`);
  store.save();
  return n;
}

// "That's wrong." Erase the one memory the agent relied on; if it was a guess, never re-guess it.
export function reject(store, mem, trace = []) {
  if (mem.source.type === 'inferred') { store.block(mem.subject, mem.key, mem.value); t(trace, 'do-not-relearn', `${mem.subject}.${mem.key}: this guess will not be repeated`); }
  erase(store, [mem], 'rejected', 'user-said-wrong', trace);
  store.save();
}
