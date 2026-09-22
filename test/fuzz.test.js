// Seeded, deterministic fuzz: random messages, clock jumps, audience flips and inspector-button
// clicks. After every step the store must satisfy the memory model's invariants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgent, SLOTS, effective } from '../web/engine/index.js';

const T0 = Date.UTC(2026, 0, 1);
const cities = ['Berlin', 'Lisbon', 'Cairo', 'Tokyo', 'Paris', 'Rome'];
const orgs = ['Acme', 'Globex', 'Initech'];

function makeRng(seed) {
  let s = seed >>> 0;
  const next = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  return { next, pick: (a) => a[Math.floor(next() * a.length)] };
}

function messages(pick) {
  return [
    () => `I live in ${pick(cities)}`, () => `Actually I moved to ${pick(cities)}`, () => `I work at ${pick(orgs)}`,
    () => `I no longer work at ${pick(orgs)}`, () => `I am allergic to ${pick(['peanuts', 'eggs', 'shellfish'])}`,
    () => `I'm no longer allergic to ${pick(['peanuts', 'eggs'])}`, () => 'I am vegetarian', () => "I'm not vegetarian anymore",
    () => 'I ordered a veggie burger', () => `It's raining in ${pick(cities)}`, () => `I'm in ${pick(cities)} this week`,
    () => 'Where do I live?', () => 'Where do I work?', () => 'Am I allergic to anything?', () => 'Recommend a dinner spot',
    () => 'Plan my weekend', () => 'Draft an intro email', () => 'What do you remember about me?', () => 'yes', () => 'no', () => "that's wrong",
    () => `Forget my ${pick(['allergies', 'work', 'name', 'diet', 'sister'])}`, () => `Forget that I live in ${pick(cities)}`,
    () => `My sister Nora lives in ${pick(cities)}`, () => pick(cities), () => `I think I live in ${pick(cities)}`,
    () => 'Forget everything you guessed', () => 'Stop guessing', () => 'You can guess', () => 'Call me Sam', () => 'I like jazz and hiking',
    () => '<b>x</b> ???', () => '', () => '!!!',
  ];
}

function checkInvariants(store, trail) {
  const now = store.now();
  const fail = (msg) => assert.fail(`${msg}\n  last steps: ${trail.slice(-8).join(' | ')}`);
  for (const m of store.memories) {
    if (!(m.baseConfidence >= 0 && m.baseConfidence <= 0.98)) fail(`base confidence out of range: ${m.baseConfidence}`);
    const e = effective(m, now);
    if (!(e >= 0 && e <= 1)) fail(`effective confidence out of range: ${e}`);
    if (!m.source?.type || m.lastConfirmedAt == null || !m.scope) fail(`memory ${m.id} is missing source/freshness/scope`);
  }
  const bySlot = new Map();
  for (const m of store.memories.filter((x) => x.status !== 'superseded')) {
    const k = `${m.subject}.${m.key}`;
    bySlot.set(k, [...(bySlot.get(k) ?? []), m]);
  }
  for (const [k, ms] of bySlot) {
    const single = SLOTS[k.split('.')[1]].cardinality === 'single';
    if (single && ms.length > 1 && !ms.every((m) => m.status === 'contested')) fail(`single-valued slot ${k} holds several live values that are not marked contested`);
    if (single && ms.length === 1 && ms[0].status === 'contested') fail(`lone contested memory in ${k}`);
    if (new Set(ms.map((m) => m.valueNorm)).size !== ms.length) fail(`duplicate value in ${k}`);
  }
  const ids = store.memories.map((m) => m.id);
  if (new Set(ids).size !== ids.length) fail('duplicate memory ids');
  if (/Berlin|Lisbon|Cairo|Tokyo|Paris|Rome|peanut|egg|shellfish/i.test(JSON.stringify(store.state.blocklist))) fail('plaintext value in the do-not-relearn list');
  if (store.state.audit.some((a) => 'value' in a)) fail('audit trail contains a value');
}

test('fuzz: 80 random sessions never crash and never break the memory invariants', () => {
  const { next, pick } = makeRng(12345);
  const gens = messages(pick);
  for (let run = 0; run < 80; run++) {
    const { store, agent } = createAgent({ nowFn: () => T0 });
    const trail = [];
    for (let i = 0; i < 120; i++) {
      const r = next();
      if (r < 0.12) { const d = pick([1, 7, 30, 200, 548, 3000]); trail.push(`advance ${d}`); agent.advanceTime(d); }
      else if (r < 0.16) { const a = pick(['private', 'shared']); trail.push(`audience ${a}`); agent.setAudience(a); }
      else if (r < 0.2 && store.memories.length) {
        const m = pick(store.memories); const action = pick(['confirmMemory', 'rejectMemory', 'forgetMemory']);
        trail.push(`${action} ${m.key}=${m.value}/${m.status}`); agent[action](m.id);
      } else {
        const text = pick(gens)();
        trail.push(`say "${text}"`);
        assert.equal(typeof agent.respond(text).text, 'string');
      }
      checkInvariants(store, trail);
    }
  }
});
