import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgent, Store, MemoryAdapter, MemoryAgent, effective, bandOf, statements, interpret, retrieve, write, sweep, DAY } from '../web/engine/index.js';
import { FileAdapter } from '../web/engine/store-node.js';
import { SCENARIO } from '../web/engine/scenario.js';

const T0 = Date.UTC(2026, 0, 1);
const fresh = () => createAgent({ nowFn: () => T0 });
const live = (store, key, subject = 'user') => store.live(subject, key);
const val = (store, key, subject = 'user') => live(store, key, subject).map((m) => m.value);

// ---------- 1. the memory model: every fact is tagged ----------
test('every stored fact carries source, confidence, freshness and scope', () => {
  const { store, agent } = fresh();
  agent.respond('I live in Berlin');
  const [m] = live(store, 'home_city');
  assert.equal(m.value, 'Berlin');
  assert.equal(m.source.type, 'user_stated');
  assert.equal(m.source.quote, 'I live in Berlin');
  assert.ok(m.baseConfidence > 0.8 && m.baseConfidence < 1);
  assert.equal(m.lastConfirmedAt, T0);
  assert.deepEqual(m.scope, { subject: 'user', context: 'personal', sensitivity: 'normal' });
});

test('hedged language lowers confidence at write time', () => {
  const { store, agent } = fresh();
  agent.respond('I think I live in Berlin');
  const [m] = live(store, 'home_city');
  assert.equal(m.source.hedged, true);
  assert.ok(effective(m, T0) < 0.6);
});

// ---------- 2. freshness: confidence decays with time ----------
test('effective confidence decays and moves through bands without any deletion', () => {
  const { store, agent } = fresh();
  agent.respond('I live in Berlin');
  const [m] = live(store, 'home_city');
  const seen = [0, 200, 420, 548, 900].map((d) => bandOf(effective(m, T0 + d * DAY)));
  assert.deepEqual(seen, ['confident', 'hedge', 'hedge', 'verify', 'verify']);
  agent.advanceTime(548);
  assert.equal(live(store, 'home_city').length, 1, 'still stored, only doubted');
});

test('fast-moving slots decay much faster than stable ones', () => {
  const { store, agent } = fresh();
  agent.respond('I am working on the Atlas migration. My name is Sam');
  const proj = live(store, 'current_project')[0];
  const name = live(store, 'name')[0];
  const t = T0 + 60 * DAY;
  assert.ok(effective(proj, t) < 0.25);
  assert.ok(effective(name, t) > 0.85);
});

// ---------- 3. behaviour follows confidence ----------
test('confident memory is used directly; hedged memory is used with a hedge; doubtful memory is not used', () => {
  const { agent } = fresh();
  agent.respond('I live in Berlin');
  let r = agent.respond('Where do I live?');
  assert.match(r.text, /^You live in Berlin/);
  assert.equal(r.relied[0].usage, 'applied');

  agent.advanceTime(420);
  r = agent.respond('Where do I live?');
  assert.match(r.text, /^I think you live in Berlin/);
  assert.equal(r.relied[0].usage, 'hedged');

  agent.advanceTime(130);
  r = agent.respond('Recommend a dinner spot');
  assert.doesNotMatch(r.text, /try /, 'must not build a plan on a doubtful city');
  assert.match(r.text, /Before I suggest anything/);
  assert.equal(r.relied[0].usage, 'asked');
});

test('answers always list what they relied on and how sure they are', () => {
  const { agent } = fresh();
  agent.respond('I live in Berlin and I am allergic to peanuts');
  const r = agent.respond('Recommend a dinner spot');
  const keys = r.relied.map((x) => x.key).sort();
  assert.deepEqual(keys, ['allergy', 'home_city']);
  for (const x of r.relied) assert.ok(x.effective > 0 && x.effective <= 1 && x.band && x.sourceType);
});

// ---------- 4. FAILURE TEST: contradictions ----------
test('contradiction: two fresh claims are contested, neither is relied on, the user resolves it', () => {
  const { store, agent } = fresh();
  agent.respond('I work at Acme');
  const r = agent.respond('I work at Globex');
  assert.match(r.text, /conflicts/);
  const both = store.live('user', 'employer');
  assert.equal(both.length, 2);
  assert.ok(both.every((m) => m.status === 'contested'));
  assert.ok(both.every((m) => m.baseConfidence < 0.6));

  const q = agent.respond('Where do I work?');
  assert.deepEqual(q.relied, []);
  assert.equal(q.withheld[0].reason, 'contested');

  const fix = agent.respond('Globex');
  assert.match(fix.text, /Settled/);
  assert.deepEqual(val(store, 'employer'), ['Globex']);
  assert.equal(live(store, 'employer')[0].source.type, 'user_confirmed');
  assert.equal(store.slot('user', 'employer').find((m) => m.value === 'Acme').status, 'superseded');
});

test('contradiction: an explicit correction replaces the old value instead of contesting it', () => {
  const { store, agent } = fresh();
  agent.respond('I live in Berlin');
  const r = agent.respond('Actually I moved to Lisbon');
  assert.match(r.text, /^Updated/);
  assert.deepEqual(val(store, 'home_city'), ['Lisbon']);
  assert.equal(store.slot('user', 'home_city').find((m) => m.value === 'Berlin').status, 'superseded');
});

test('"Actually, I live in X" keeps its correction marker (clause must not be split)', () => {
  const { store, agent } = fresh();
  agent.respond('I live in Berlin');
  agent.respond('Actually, I live in Lisbon');
  assert.deepEqual(val(store, 'home_city'), ['Lisbon']);
});

test('contradiction: a stale old value is replaced rather than argued with', () => {
  const { store, agent } = fresh();
  agent.respond('I live in Berlin');
  agent.advanceTime(600);
  const r = agent.respond('I live in Lisbon');
  assert.match(r.text, /^Updated/);
  assert.match(r.text, /old and already doubtful/);
  assert.deepEqual(val(store, 'home_city'), ['Lisbon']);
});

test('contradiction: a guess can never overturn something the user said', () => {
  const { store, agent } = fresh();
  agent.respond('I live in Berlin');
  agent.respond('It is so rainy in Seattle');
  agent.respond("It's raining in Seattle");
  assert.deepEqual(val(store, 'home_city'), ['Berlin']);
});

test('repeating a guess never makes it confident', () => {
  const { store, agent } = fresh();
  for (let i = 0; i < 6; i++) agent.respond("It's raining in Seattle");
  const [m] = live(store, 'home_city');
  assert.equal(m.source.type, 'inferred');
  assert.ok(effective(m, T0) <= 0.55);
  assert.notEqual(bandOf(effective(m, T0)), 'confident');
});

test('a guess upgrades to user-stated when the user says it themselves', () => {
  const { store, agent } = fresh();
  agent.respond('I ordered a veggie burger');
  assert.equal(live(store, 'diet')[0].source.type, 'inferred');
  agent.respond('I am vegetarian');
  assert.equal(live(store, 'diet')[0].source.type, 'user_stated');
  assert.equal(live(store, 'diet').length, 1);
});

test('retraction: "I no longer work at X" marks it not-true without inventing a new value', () => {
  const { store, agent } = fresh();
  agent.respond('I work at Acme');
  agent.respond('I no longer work at Acme');
  assert.equal(live(store, 'employer').length, 0);
  assert.equal(store.slot('user', 'employer')[0].status, 'superseded');
});

// ---------- 5. FAILURE TEST: stale data ----------
test('stale data is forgotten on a deterministic schedule even if the sweep runs late', () => {
  const { store, agent } = fresh();
  agent.respond('I am working on the Atlas migration');
  const [m] = live(store, 'current_project');
  const before = store.memories.length;
  agent.advanceTime(45); // below the verify line (day ~39), inside the grace window (until day ~84)
  assert.equal(store.memories.length, before, 'kept during the grace window');
  assert.equal(retrieve(store, { keys: ['current_project'] }).items.length, 0, 'but not used');
  agent.advanceTime(200); // way past dormant + 45 days, sweep runs once, late
  assert.equal(store.find(m.id), undefined);
  assert.ok(store.state.audit.some((a) => a.type === 'erased' && a.reason === 'faded' && a.key === 'current_project'));
});

test('temporary facts expire on their own ("this week")', () => {
  const { store, agent } = fresh();
  const r = agent.respond("I'm in Tokyo this week");
  assert.match(r.text, /drop it automatically/);
  assert.deepEqual(val(store, 'current_location'), ['Tokyo']);
  agent.advanceTime(6);
  assert.equal(live(store, 'current_location').length, 1);
  agent.advanceTime(2);
  assert.equal(live(store, 'current_location').length, 0);
  assert.ok(store.state.audit.some((a) => a.reason === 'expired'));
});

test('a temporary location overrides the home city for a task, then the home city returns', () => {
  const { agent } = fresh();
  agent.respond('I live in Berlin');
  agent.respond("I'm in Tokyo this week");
  assert.match(agent.respond('Recommend a dinner spot').text, /in Tokyo/);
  agent.advanceTime(9);
  assert.match(agent.respond('Recommend a dinner spot').text, /in Berlin/);
});

test('replaced values are erased after the retention window', () => {
  const { store, agent } = fresh();
  agent.respond('I live in Berlin');
  agent.respond('Actually I moved to Lisbon');
  assert.equal(store.slot('user', 'home_city').length, 2);
  agent.advanceTime(20);
  assert.equal(store.slot('user', 'home_city').length, 2);
  agent.advanceTime(20);
  assert.equal(store.slot('user', 'home_city').length, 1);
});

test('safety-critical facts are honoured conservatively even after they fade', () => {
  const { store, agent } = fresh();
  agent.respond('I am allergic to peanuts');
  agent.advanceTime(6760); // just past the verify line, still inside the grace window
  const r = retrieve(store, { keys: ['allergy'] });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].safetyOverride, true);
  agent.respond('I live in Berlin');
  const t = agent.respond('Recommend a dinner spot');
  assert.match(t.text, /steer away from peanuts/);
  assert.match(t.text, /is it current/);
});

// ---------- 6. FAILURE TEST: privacy revocation ----------
test('revocation is a real delete: no value, quote or history survives in the stored bytes', () => {
  const adapter = new MemoryAdapter();
  const { store, agent } = createAgent({ adapter, nowFn: () => T0 });
  agent.respond('I am allergic to peanuts and shellfish');
  agent.respond('I live in Berlin');
  assert.match(adapter.raw, /peanuts/);

  const r = agent.respond('Forget my allergies');
  assert.match(r.text, /Forgotten/);
  assert.doesNotMatch(adapter.raw, /peanuts|shellfish/i, 'value and source quote must be gone');
  assert.equal(store.slot('user', 'allergy').length, 0);
  assert.match(adapter.raw, /Berlin/, 'unrelated memory is untouched');
  assert.ok(store.state.audit.some((a) => a.type === 'revoked' && a.key === 'allergy'));
  assert.ok(store.state.audit.every((a) => !('value' in a)), 'audit trail never holds values');
});

test('forgetting a value also erases the replaced history for that slot', () => {
  const adapter = new MemoryAdapter();
  const { agent } = createAgent({ adapter, nowFn: () => T0 });
  agent.respond('I live in Berlin');
  agent.respond('Actually I moved to Lisbon');
  agent.respond('Forget that I live in Lisbon');
  assert.doesNotMatch(adapter.raw, /Berlin|Lisbon/);
});

test('"forget everything" leaves nothing behind', () => {
  const adapter = new MemoryAdapter();
  const { store, agent } = createAgent({ adapter, nowFn: () => T0 });
  agent.respond('Call me Sam. I live in Berlin and I am allergic to peanuts');
  agent.respond('My sister Nora lives in Cairo');
  agent.respond('Forget everything');
  assert.equal(store.memories.length, 0);
  assert.doesNotMatch(adapter.raw, /Sam|Berlin|peanuts|Nora|Cairo/);
});

test('rejecting a guess deletes it and blocks the same guess; explicit statements still work', () => {
  const { store, agent } = fresh();
  agent.respond('I ordered a veggie burger');
  agent.respond('That is wrong');
  assert.equal(live(store, 'diet').length, 0);
  const again = agent.respond('I had a veggie wrap');
  assert.match(again.text, /told me not to guess/);
  assert.equal(live(store, 'diet').length, 0);
  agent.respond('I am vegetarian');
  assert.deepEqual(val(store, 'diet'), ['vegetarian']);
});

test('the do-not-relearn list stores hashes, never plaintext', () => {
  const { store, agent } = fresh();
  agent.respond("It's raining in Seattle");
  agent.respond("That's wrong");
  assert.equal(store.state.blocklist.length, 1);
  assert.doesNotMatch(JSON.stringify(store.state.blocklist), /Seattle/i);
  agent.respond("It's raining in Seattle");
  assert.equal(live(store, 'home_city').length, 0);
});

test('"forget what you guessed" removes every inference and blocks them', () => {
  const { store, agent } = fresh();
  agent.respond('I live in Berlin');
  agent.respond('I ordered a veggie burger');
  agent.respond('Forget everything you guessed');
  assert.equal(live(store, 'diet').length, 0);
  assert.deepEqual(val(store, 'home_city'), ['Berlin']);
});

test('switching guessing off stops inference but not direct statements', () => {
  const { store, agent } = fresh();
  agent.respond("Stop guessing things about me");
  agent.respond('I ordered a veggie burger');
  assert.equal(live(store, 'diet').length, 0);
  agent.respond('I am vegan');
  assert.deepEqual(val(store, 'diet'), ['vegan']);
});

test('sensitive slots can never be inferred, only stated', () => {
  const { store } = fresh();
  const [res] = write(store, [{ subject: 'user', key: 'allergy', value: 'peanuts', op: 'assert', source: { type: 'inferred', quote: 'x' }, baseOverride: 0.4 }]);
  assert.equal(res.action, 'rejected');
  assert.equal(res.reason, 'never-infer');
});

// ---------- 7. scope and audience ----------
test('sensitive memories are withheld on a shared screen and never echoed', () => {
  const { agent } = fresh();
  agent.respond('I am allergic to peanuts');
  agent.setAudience('shared');
  const r = agent.respond('Am I allergic to anything?');
  assert.doesNotMatch(r.text, /peanut/i);
  assert.equal(r.withheld[0].reason, 'sensitive-on-shared-screen');
  const ack = agent.respond('I am allergic to shellfish');
  assert.doesNotMatch(ack.text, /shellfish/i, 'acknowledgements must not leak sensitive values either');
  const insp = agent.respond('What do you remember about me?');
  assert.doesNotMatch(insp.text, /peanut|shellfish/i);
  agent.setAudience('private');
  assert.match(agent.respond('Am I allergic to anything?').text, /peanuts/);
});

test('facts about other people are scoped to them, treated as sensitive, and forgettable as a group', () => {
  const { store, agent } = fresh();
  agent.respond('My sister Nora lives in Cairo');
  assert.deepEqual(val(store, 'home_city', 'sister'), ['Cairo']);
  assert.deepEqual(val(store, 'name', 'sister'), ['Nora']);
  assert.equal(val(store, 'home_city').length, 0, 'not attributed to the user');
  assert.equal(live(store, 'home_city', 'sister')[0].scope.sensitivity, 'sensitive');
  assert.match(agent.respond('Where does my sister live?').text, /Your sister lives in Cairo/);
  agent.respond('Forget my sister');
  assert.equal(store.memories.filter((m) => m.subject === 'sister').length, 0);
});

test('retrieval is purpose-scoped: an email draft loads only what it needs and does not ask for a city', () => {
  const { agent } = fresh();
  agent.respond('Call me Sam. I work at Acme as a designer. I am allergic to peanuts. I live in Berlin');
  const r = agent.respond('Draft an intro email');
  assert.match(r.text, /Hi, I'm Sam, a designer at Acme/);
  assert.ok(r.relied.every((x) => ['name', 'job_title', 'employer'].includes(x.key)));
  assert.doesNotMatch(r.text, /Before I suggest/);
});

// ---------- 8. user-driven correction & confirmation ----------
test('confirming a doubtful memory resets its freshness and upgrades its source', () => {
  const { store, agent } = fresh();
  agent.respond('I live in Berlin');
  agent.advanceTime(548);
  agent.respond('Where do I live?');
  const r = agent.respond('yes');
  assert.match(r.text, /confirmed by you/);
  const [m] = live(store, 'home_city');
  assert.equal(m.source.type, 'user_confirmed');
  assert.ok(effective(m, store.now()) > 0.95);
});

test('answering "no" to a doubtful memory erases it and the next short answer fills the slot', () => {
  const { store, agent } = fresh();
  agent.respond('I live in Berlin');
  agent.advanceTime(548);
  agent.respond('Where do I live?');
  agent.respond('no');
  assert.equal(live(store, 'home_city').length, 0);
  agent.respond('lisbon');
  assert.deepEqual(val(store, 'home_city'), ['Lisbon']);
});

test('inspector card actions: confirm, reject and forget', () => {
  const { store, agent } = fresh();
  agent.respond('I live in Berlin. I like jazz');
  const city = live(store, 'home_city')[0];
  const jazz = live(store, 'likes')[0];
  assert.match(agent.confirmMemory(city.id).text, /Confirmed/);
  assert.match(agent.forgetMemory(jazz.id).text, /Forgotten/);
  assert.equal(live(store, 'likes').length, 0);
  agent.rejectMemory(city.id);
  assert.equal(live(store, 'home_city').length, 0);
});

test('a replaced value can never be revived by "yes" or the Still-true button', () => {
  const { store, agent } = fresh();
  agent.respond('I live in Berlin');
  agent.respond('Where do I live?');
  const old = live(store, 'home_city')[0];
  agent.respond('Actually I moved to Lisbon');
  assert.match(agent.confirmMemory(old.id).text, /already replaced/);
  assert.match(agent.respond('yes').text, /confirmed|Yes to what/);
  assert.deepEqual(val(store, 'home_city'), ['Lisbon'], 'exactly one live value');
});

// ---------- 9. storage ----------
test('state survives a restart via the file adapter, including the simulated clock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  try {
    const path = join(dir, 'memory.json');
    const a = createAgent({ adapter: new FileAdapter(path), nowFn: () => T0 });
    a.agent.respond('I live in Berlin');
    a.agent.advanceTime(300);
    const before = effective(a.store.live('user', 'home_city')[0], a.store.now());

    const b = createAgent({ adapter: new FileAdapter(path), nowFn: () => T0 });
    assert.equal(b.store.live('user', 'home_city')[0].value, 'Berlin');
    assert.equal(b.store.now(), T0 + 300 * DAY);
    assert.equal(effective(b.store.live('user', 'home_city')[0], b.store.now()), before);
    assert.ok(JSON.parse(readFileSync(path, 'utf8')).version === 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a corrupt or unknown-version store is not trusted', () => {
  assert.equal(new Store(new MemoryAdapter('{not json'), () => T0).memories.length, 0);
  assert.equal(new Store(new MemoryAdapter(JSON.stringify({ version: 99, memories: [{ id: 'x' }] })), () => T0).memories.length, 0);
});

// ---------- 10. extraction ----------
test('extraction table', () => {
  const c = (s) => statements(s, { now: T0 }).candidates.map((x) => `${x.subject}.${x.key}${x.op === 'retract' ? '-' : ''}=${x.value}`);
  assert.deepEqual(c('My name is Sam'), ['user.name=Sam']);
  assert.deepEqual(c('call me sam'), ['user.name=Sam']);
  assert.deepEqual(c("I'm allergic to peanuts, shellfish and eggs"), ['user.allergy=peanuts', 'user.allergy=shellfish', 'user.allergy=eggs']);
  assert.deepEqual(c('I work at Acme as a data scientist'), ['user.employer=Acme', 'user.job_title=data scientist']);
  assert.deepEqual(c('I am vegetarian'), ['user.diet=vegetarian']);
  assert.deepEqual(c("I'm not vegetarian anymore"), ['user.diet-=vegetarian']);
  assert.deepEqual(c('I speak English and Arabic'), ['user.languages=English', 'user.languages=Arabic']);
  assert.deepEqual(c('My dog is called Max'), ['dog.name=Max']);
  assert.deepEqual(c('I love hiking and jazz'), ['user.likes=hiking', 'user.likes=jazz']);
  assert.deepEqual(c("I'm in a meeting"), []);
  assert.deepEqual(c('I am tired'), []);
  assert.deepEqual(c('I live in the middle of nowhere'), []);
});

test('multi-clause messages are all processed', () => {
  const { store, agent } = fresh();
  agent.respond('My name is Sam, I live in Berlin and my dog is called Max. I like tea and coffee');
  assert.deepEqual(val(store, 'name'), ['Sam']);
  assert.deepEqual(val(store, 'home_city'), ['Berlin']);
  assert.deepEqual(val(store, 'name', 'dog'), ['Max']);
  assert.deepEqual(val(store, 'likes').sort(), ['coffee', 'tea']);
});

test('questions are not mistaken for statements', () => {
  assert.equal(interpret('Where do I live?').kind, 'question');
  assert.equal(interpret('What am I allergic to?').kind, 'question');
  assert.equal(interpret('Am I vegetarian?').kind, 'question');
  assert.equal(interpret('What do you remember about me?').kind, 'inspect');
});

// ---------- 11. the whole guided demo ----------
test('the guided demo replays end to end and ends in the expected state', () => {
  const { store, agent } = fresh();
  const transcript = [];
  for (const step of SCENARIO) {
    if (step.say) transcript.push(agent.respond(step.say));
    else if (step.advance) agent.advanceTime(step.advance);
    else if (step.audience) agent.setAudience(step.audience);
  }
  const said = transcript.map((r) => r.text).join('\n');
  assert.match(said, /only ~45% sure/, 'the "I might be wrong" moment');
  assert.match(said, /Before I suggest anything/);
  assert.match(said, /conflicts/);
  assert.match(said, /shared screen/);
  assert.deepEqual(val(store, 'home_city'), ['Lisbon']);
  assert.deepEqual(val(store, 'employer'), ['Globex']);
  assert.equal(live(store, 'allergy').length, 0);
  assert.equal(live(store, 'diet').length, 0);
  assert.ok(store.state.blocklist.length >= 1);
});

test('sweep is idempotent and cheap on an empty store', () => {
  const { store } = fresh();
  assert.deepEqual(sweep(store), []);
  assert.deepEqual(sweep(store), []);
  assert.ok(new MemoryAgent(store));
});
