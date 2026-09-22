import { Store, LocalStorageAdapter, MemoryAgent, SLOTS, DAY, describeAge, describeIn, pct, halfLifeMs, subjectLabel } from './engine/index.js';
import { SCENARIO } from './engine/scenario.js';

const store = new Store(new LocalStorageAdapter());
const agent = new MemoryAgent(store);
const $ = (id) => document.getElementById(id);
const TRANSCRIPT_KEY = 'memory-transcript.v1';

// Everything is built with textContent (never innerHTML), so user text cannot inject markup.
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

// ---------------------------------------------------------------- transcript
let transcript = [];
try { transcript = JSON.parse(localStorage.getItem(TRANSCRIPT_KEY) || '[]'); } catch { transcript = []; }
const saveTranscript = () => { try { localStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(transcript.slice(-200))); } catch { /* ignore */ } };

const labelOf = (subject, key) => (subject === 'user' ? SLOTS[key].label : `${subject}'s ${SLOTS[key].label}`);
const REASONS = { 'sensitive-on-shared-screen': 'sensitive, shared screen', contested: 'contradiction unresolved', faded: 'too old to trust' };
const USAGE = { applied: 'used', hedged: 'used, hedged', asked: 'not used, asked you', stated: '' };

function addMsg(msg) { transcript.push(msg); saveTranscript(); renderLog(); }

function chip(r) {
  const cls = r.sourceType === 'inferred' ? `${r.band} inferred` : r.band;
  const usage = USAGE[r.usage] ? ` · ${USAGE[r.usage]}` : '';
  const el = h('button', { class: `chip ${cls}`, type: 'button', title: 'Show this memory', dataset: { id: r.id } },
    `${labelOf(r.subject, r.key)}: `, h('b', {}, r.value), ` · ${pct(r.effective)}${usage}${r.sourceType === 'inferred' ? ' · guess' : ''}`);
  el.addEventListener('click', () => flashCard(r.id));
  return el;
}

function renderMsg(m, isLast) {
  if (m.role === 'user') return h('div', { class: 'msg user' }, m.text);
  if (m.role === 'system') return h('div', { class: 'msg system' }, m.text);
  const body = m.text.split('\n').filter(Boolean).map((line) => h('p', {}, line));
  const el = h('div', { class: 'msg agent' }, body);
  if (m.relied?.length || m.withheld?.length) {
    const row = h('div', { class: 'chips' }, h('span', { class: 'chips-label' }, 'Relying on:'));
    if (m.relied?.length) m.relied.forEach((r) => row.append(chip(r)));
    else row.append(h('span', { class: 'chips-label' }, 'nothing stored that I trust'));
    (m.withheld ?? []).forEach((w) => row.append(h('span', { class: 'chip withheld' }, `${labelOf(w.subject, w.key)} not used: ${REASONS[w.reason] ?? w.reason}`)));
    el.append(row);
  }
  if (isLast && store.state.session.pending?.type === 'confirm') {
    el.append(h('div', { class: 'replies' },
      h('button', { type: 'button', onclick: () => send('Yes') }, 'Yes, still true'),
      h('button', { type: 'button', onclick: () => send('No') }, 'No, that is wrong')));
  }
  return el;
}

function renderLog() {
  const log = $('log');
  log.replaceChildren(...transcript.map((m, i) => renderMsg(m, i === transcript.length - 1)));
  log.scrollTop = log.scrollHeight;
}

// ---------------------------------------------------------------- inspector
const fmtDays = (d) => (d < 2 ? `${Math.round(d * 24)} hours` : d < 60 ? `${Math.round(d)} days` : d < 700 ? `${Math.round(d / 30.4)} months` : `${(d / 365).toFixed(d > 3650 ? 0 : 1)} years`);
const SOURCE = { user_stated: 'You said it', user_confirmed: 'You confirmed it', inferred: 'Inferred, never said' };

function memCard(m, shared) {
  const hide = shared && m.scope.sensitivity === 'sensitive';
  const now = store.now();
  const cls = m.status === 'superseded' ? 'superseded' : m.status === 'contested' ? 'contested' : m.stage === 'fading' || m.band === 'faded' ? 'faded' : m.band;
  const pill = { superseded: 'replaced', contested: 'contested', faded: 'fading', confident: 'confident', hedge: 'hedge: say "I think"', verify: 'ask before using' }[cls];

  const life = m.status === 'superseded' ? `Replaced. Value erased ${describeIn(m.purgeAt - now)}.`
    : m.expiresAt && m.expiresAt - now > 0 ? `Expires ${describeIn(m.expiresAt - now)}.`
    : m.stage === 'fading' ? `Below the trust line. Erased ${describeIn(m.purgeAt - now)}.`
    : m.dormantAt > now ? `Falls below the trust line ${describeIn(m.dormantAt - now)}; erased ${describeIn(m.purgeAt - now)}.` : '';

  const acts = m.status === 'superseded'
    ? [h('button', { type: 'button', onclick: () => act('forgetMemory', m.id) }, 'Erase now')]
    : [
      h('button', { type: 'button', onclick: () => act('confirmMemory', m.id) }, 'Still true'),
      h('button', { type: 'button', onclick: () => act('rejectMemory', m.id) }, 'Wrong'),
      h('button', { type: 'button', class: 'danger', onclick: () => act('forgetMemory', m.id) }, 'Forget'),
    ];

  return h('article', { class: `mem ${cls}${m.source.type === 'inferred' ? ' inferred' : ''}`, dataset: { id: m.id } },
    h('div', { class: 'mem-top' },
      h('span', { class: 'mem-label' }, labelOf(m.subject, m.key)),
      h('span', {}, m.source.type === 'inferred' ? h('span', { class: 'pill inferred' }, 'guess ') : null, h('span', { class: `pill ${cls}` }, pill))),
    h('div', { class: 'mem-value' }, hide ? '••••••••' : m.value),
    h('div', { class: 'bar', role: 'img', 'aria-label': `Effective confidence ${pct(m.effective)}` },
      h('div', { class: 'fill', style: `width:${Math.round(m.effective * 100)}%` }),
      h('div', { class: 'base', style: `left:${Math.round(m.baseConfidence * 100)}%`, title: 'confidence at last confirmation' })),
    h('div', { class: 'bar-caption' }, h('span', {}, `${pct(m.effective)} now`), h('span', {}, `${pct(m.baseConfidence)} when last confirmed`)),
    h('ul', { class: 'meta' },
      h('li', {}, h('b', {}, 'Source: '), SOURCE[m.source.type], m.source.hedged ? ' (sounded unsure)' : '', hide ? '' : [' · ', h('q', {}, m.source.quote)]),
      h('li', {}, h('b', {}, 'Freshness: '), `${pct(m.freshness)} · confirmed ${describeAge(m.ageMs)} · half-life ${fmtDays(halfLifeMs(m) / DAY)}`),
      h('li', {}, h('b', {}, 'Scope: '), `about ${subjectLabel(m.subject)} · ${m.scope.context} · ${m.scope.sensitivity === 'sensitive' ? 'sensitive, hidden on shared screens' : 'private'}`),
      life ? h('li', {}, h('b', {}, 'Forgetting: '), life) : null),
    h('div', { class: 'acts' }, acts));
}

function renderInspector() {
  const snap = agent.inspect();
  const shared = agent.audience === 'shared';
  const c = snap.counts;
  const live = c.total - c.superseded;
  $('counts').replaceChildren(
    h('span', { class: 'pill confident' }, `${c.confident} confident`),
    h('span', { class: 'pill hedge' }, `${c.hedge} hedge`),
    h('span', { class: 'pill verify' }, `${c.verify} ask first`),
    h('span', { class: 'pill contested' }, `${c.contested} contested`),
    h('span', { class: 'pill inferred' }, `${c.inferred} guessed`),
    h('span', { class: 'pill superseded' }, `${c.superseded} replaced`),
    h('span', { class: 'muted small' }, `${live} live · ${snap.doNotRelearn} on do-not-relearn list`));
  $('cards').replaceChildren(...(snap.memories.length
    ? snap.memories.map((m) => memCard(m, shared))
    : [h('div', { class: 'empty' }, 'Nothing stored yet. Tell the agent something about yourself, e.g. "I live in Berlin".')]));
  $('audit-count').textContent = `(${snap.audit.length})`;
  $('audit').replaceChildren(...(snap.audit.length
    ? snap.audit.map((a) => h('li', {}, h('span', {}, `${a.type}${a.key ? ` · ${a.subject === 'user' ? '' : `${a.subject}.`}${a.key}` : ''}`), h('span', { class: 'muted' }, a.reason)))
    : [h('li', { class: 'muted' }, 'Nothing forgotten yet.')]));
}

function flashCard(id) {
  const el = document.querySelector(`.mem[data-id="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1400);
}

function renderTrace(trace) {
  const list = $('trace');
  if (!trace?.length) { list.replaceChildren(h('li', { class: 'muted' }, 'No memory operations on that turn.')); return; }
  list.replaceChildren(...trace.slice(0, 40).map((t) => h('li', {}, h('span', { class: `tag ${t.path}` }, t.path), h('span', { class: 'step' }, t.step), h('span', {}, t.detail))));
}

function renderClock() {
  const off = Math.round(store.state.clockOffsetMs / DAY);
  $('clock').textContent = `${new Date(store.now()).toISOString().slice(0, 10)}${off ? `  (+${off} days)` : ''}`;
}

function renderControls() {
  const shared = agent.audience === 'shared';
  $('aud-private').classList.toggle('on', !shared);
  $('aud-shared').classList.toggle('on', shared);
  $('aud-shared').classList.toggle('warn', shared);
  $('aud-private').setAttribute('aria-checked', String(!shared));
  $('aud-shared').setAttribute('aria-checked', String(shared));
  $('allow-infer').checked = store.settings.allowInference;
}

function renderAll() { renderClock(); renderControls(); renderInspector(); renderLog(); }

// ---------------------------------------------------------------- actions
let busy = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const human = (days) => {
  if (days >= 365) { const y = +(days / 365).toFixed(1); return `${y} year${y === 1 ? '' : 's'}`; }
  return days >= 60 ? `${Math.round(days / 30.4)} months` : `${days} days`;
};

function setBusy(on) {
  busy = on;
  $('input').disabled = on;
  document.querySelectorAll('[data-advance], #quick button, #form button, #reset, #demo-step').forEach((b) => { b.disabled = on; });
}

function send(text) {
  const t = text.trim();
  if (!t || busy) return;
  addMsg({ role: 'user', text: t });
  const res = agent.respond(t);
  addMsg({ role: 'agent', text: res.text, relied: res.relied, withheld: res.withheld });
  if (res.swept.length) addMsg({ role: 'system', text: `Forgotten automatically: ${res.swept.map((s) => `${SLOTS[s.key].label} (${s.reason})`).join(', ')}` });
  renderTrace(res.trace);
  renderAll();
  (store.state.session.lastRelied ?? []).forEach((id) => flashCard(id));
}

function advance(days) {
  const { swept, trace } = agent.advanceTime(days);
  addMsg({ role: 'system', text: `Clock moved forward ${human(days)}. Nothing was edited by hand: only time passed.${swept.length ? ` Forgotten automatically: ${swept.map((s) => `${SLOTS[s.key].label} (${s.reason})`).join(', ')}.` : ''}` });
  renderTrace(trace);
  renderAll();
}

function setAudience(a) {
  agent.setAudience(a);
  addMsg({ role: 'system', text: a === 'shared' ? 'Shared-screen mode: sensitive memories are now withheld from answers and masked in the inspector.' : 'Private mode: sensitive memories may be shown again.' });
  renderAll();
}

function act(method, id) {
  const res = agent[method](id);
  addMsg({ role: 'system', text: res.text });
  renderTrace(res.trace);
  renderAll();
}

function reset(silent = false) {
  if (!silent && store.memories.length && !window.confirm('Delete everything, reset the clock and clear the conversation?')) return false;
  store.reset();
  transcript = [];
  stopDemo();
  demo.beat = 0;
  $('demo-progress').textContent = 'Not started';
  $('demo-note').textContent = 'Press play: it will teach the agent a few things, let time pass, then show it doubting itself, handling a contradiction, and forgetting on request. Or just type below.';
  renderTrace([]);
  addMsg({ role: 'system', text: 'Fresh start. Memory is empty and the clock is back to today.' });
  renderAll();
  return true;
}

// ---------------------------------------------------------------- guided demo
const beats = [];
for (const step of SCENARIO) {
  if (step.note) beats.push({ note: step.note, actions: [] });
  else beats.at(-1).actions.push(step);
}
const demo = { beat: 0, playing: false, stop: false };

function stopDemo() { demo.stop = true; demo.playing = false; $('demo-auto').textContent = 'Play guided demo (~1 min)'; }

async function runAction(a, pace) {
  if (a.say) {
    addMsg({ role: 'user', text: a.say });
    await sleep(pace * 0.5);
    const res = agent.respond(a.say);
    addMsg({ role: 'agent', text: res.text, relied: res.relied, withheld: res.withheld });
    renderTrace(res.trace);
    renderAll();
    (store.state.session.lastRelied ?? []).forEach((id) => flashCard(id));
  } else if (a.advance) {
    advance(a.advance);
  } else if (a.audience) {
    setAudience(a.audience);
  }
  await sleep(pace);
}

async function runBeat(pace) {
  const b = beats[demo.beat];
  $('demo-note').textContent = b.note;
  $('demo-progress').textContent = `Step ${demo.beat + 1} of ${beats.length}`;
  await sleep(pace);
  for (const a of b.actions) { if (demo.stop) return false; await runAction(a, pace); }
  demo.beat += 1;
  if (demo.beat >= beats.length) { $('demo-progress').textContent = 'Demo complete'; demo.beat = 0; return false; }
  return true;
}

async function playDemo(auto) {
  if (busy) return;
  if (demo.beat === 0 && store.memories.length && !window.confirm('The demo starts from an empty memory. Reset everything first?')) return;
  if (demo.beat === 0) reset(true);
  demo.stop = false;
  demo.playing = true;
  setBusy(true);
  if (auto) {
    $('demo-auto').disabled = false;
    $('demo-auto').textContent = 'Stop demo';
  }
  try {
    const pace = auto ? 1500 : 500;
    let more = true;
    while (more && !demo.stop) { more = await runBeat(pace); if (!auto) break; }
  } finally {
    demo.playing = false;
    setBusy(false);
    $('demo-auto').textContent = 'Play guided demo (~1 min)';
    renderLog();
  }
}

// ---------------------------------------------------------------- wiring
$('form').addEventListener('submit', (e) => { e.preventDefault(); const v = $('input').value; $('input').value = ''; send(v); });
document.querySelectorAll('[data-advance]').forEach((b) => b.addEventListener('click', () => !busy && advance(Number(b.dataset.advance))));
$('aud-private').addEventListener('click', () => setAudience('private'));
$('aud-shared').addEventListener('click', () => setAudience('shared'));
$('allow-infer').addEventListener('change', (e) => { agent.setInference(e.target.checked); addMsg({ role: 'system', text: e.target.checked ? 'Guessing is on: inferences are stored as low-confidence, clearly labelled guesses.' : 'Guessing is off: only what you tell me directly is stored.' }); });
$('reset').addEventListener('click', () => reset(false));
$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(store.state, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: 'my-memory.json' });
  document.body.append(a); a.click(); a.remove();
});
$('demo-auto').addEventListener('click', () => (demo.playing ? stopDemo() : playDemo(true)));
$('demo-step').addEventListener('click', () => playDemo(false));

const QUICK = ['Where do I live?', 'Recommend a dinner spot', 'Am I allergic to anything?', 'What do you remember about me?', 'Forget my allergies', "That's wrong"];
$('quick').replaceChildren(...QUICK.map((q) => h('button', { type: 'button', onclick: () => send(q) }, q)));

if (!transcript.length) transcript.push({ role: 'system', text: 'Try: "I live in Berlin", "I am allergic to peanuts", then jump the clock forward a year and ask "Where do I live?"' });
renderAll();
renderTrace([]);
window.__memory = { store, agent }; // handy for poking around in the console
