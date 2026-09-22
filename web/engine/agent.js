// The agent is where confidence becomes behaviour:
//   confident -> use it        hedge -> use it, say how sure
//   verify    -> do not rely; ask     contested/faded -> do not rely; ask
// Every reply carries the list of memories it relied on and what it withheld.

import { splitSentences, interpret } from './extract.js';
import { write, confirm } from './write.js';
import { retrieve, inspect } from './retrieve.js';
import { sweep, forgetSlot, forgetValue, forgetSubject, forgetInferred, forgetAll, reject } from './forget.js';
import { slotDef, sayValue, SLOTS, SUPERSEDED_RETENTION_DAYS } from './schema.js';
import { describeAge, describeIn, pct } from './confidence.js';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const HIDDEN = '[hidden: sensitive]';
const SMALLTALK = /^(?:ok(?:ay)?|thanks?(?: you)?|thx|cool|great|nice|hi|hello|hey|lol|hmm|good (?:morning|evening))$/i;

export class MemoryAgent {
  constructor(store) { this.store = store; }

  get session() { return this.store.state.session; }
  get audience() { return this.session.audience ?? 'private'; }
  setAudience(a) { this.session.audience = a === 'shared' ? 'shared' : 'private'; this.store.save(); }
  setInference(on) { this.store.settings.allowInference = !!on; this.store.save(); }
  inspect() { return inspect(this.store); }

  // Simulated time: jump forward, then let the forgetting policy catch up.
  advanceTime(days) {
    this.store.advance(days);
    const trace = [];
    const swept = sweep(this.store, trace);
    this.#cleanSession();
    return { swept, trace };
  }

  // ---- the chat entry point ---------------------------------------------------
  respond(text) {
    const trace = [];
    const swept = sweep(this.store, trace);
    this.#cleanSession();
    const ctx = { now: this.store.now() };
    const pieces = [];
    for (const sentence of splitSentences(text)) pieces.push(this.#handle(interpret(sentence, ctx), sentence, trace));
    if (!pieces.length) pieces.push({ text: 'Tell me something about yourself, or ask what I remember.' });

    const relied = [];
    const withheld = [];
    const changes = [];
    let focus = null;
    for (const p of pieces) {
      for (const r of p.relied ?? []) if (!relied.some((x) => x.id === r.id)) relied.push(r);
      withheld.push(...(p.withheld ?? []));
      changes.push(...(p.changes ?? []));
      if (p.focus) focus = [...(focus ?? []), ...p.focus];
    }
    if (focus) this.session.lastRelied = [...new Set(focus)];
    this.#cleanSession();
    this.store.save();
    return { text: pieces.map((p) => p.text).filter(Boolean).join('\n'), relied, withheld, changes, swept, trace, pending: this.session.pending };
  }

  // ---- buttons on a memory card in the inspector ---------------------------------
  confirmMemory(id) {
    const trace = [];
    const mem = this.store.find(id);
    if (!mem) return { text: 'That memory no longer exists.', trace };
    if (!confirm(this.store, mem, trace)) return { text: "That value was already replaced by a newer one, so there's nothing to confirm.", trace };
    if (this.session.pending?.id === id) this.session.pending = null;
    this.store.save();
    return { text: `Confirmed: ${sayValue(mem.subject, mem.key, this.#show(mem))}. Confidence reset to ${pct(mem.baseConfidence)}.`, trace };
  }

  rejectMemory(id) {
    const trace = [];
    const mem = this.store.find(id);
    if (!mem) return { text: 'That memory no longer exists.', trace };
    return { text: this.#reject(mem, trace), trace };
  }

  forgetMemory(id) {
    const trace = [];
    const mem = this.store.find(id);
    if (!mem) return { text: 'That memory no longer exists.', trace };
    const label = this.#label(mem.subject, mem.key);
    forgetValue(this.store, mem.subject, mem.key, mem.value, trace);
    this.#cleanSession();
    this.store.save();
    return { text: `Forgotten. Your ${label} entry is deleted (value, source quote and replaced history). I won't guess it again.`, trace };
  }

  // ---- internals ----------------------------------------------------------------
  #cleanSession() {
    const s = this.session;
    const isLive = (id) => { const m = this.store.find(id); return !!m && m.status !== 'superseded'; };
    s.lastRelied = (s.lastRelied ?? []).filter(isLive);
    if (s.pending?.id && !isLive(s.pending.id)) s.pending = null;
  }

  #show(mem) {
    const def = slotDef(mem.subject, mem.key);
    return def?.sensitivity === 'sensitive' && this.audience === 'shared' ? HIDDEN : mem.value;
  }
  #showRaw(subject, key, value) {
    const def = slotDef(subject, key);
    return def?.sensitivity === 'sensitive' && this.audience === 'shared' ? HIDDEN : value;
  }
  #label(subject, key) { return subject === 'user' ? SLOTS[key].label : `${subject}'s ${SLOTS[key].label}`; }

  #rel(item, usage) {
    return { id: item.id, subject: item.subject, key: item.key, value: this.#showRaw(item.subject, item.key, item.value), effective: item.effective, band: item.band, sourceType: item.sourceType, ageMs: item.ageMs, usage };
  }

  #src(item) {
    if (item.sourceType === 'inferred') return 'I inferred it, you never said it';
    if (item.sourceType === 'user_confirmed') return `you confirmed it ${describeAge(item.ageMs)}`;
    return `you told me ${describeAge(item.ageMs)}`;
  }

  #handle(intent, sentence, trace) {
    switch (intent.kind) {
      case 'statement': return this.#statement(intent, trace);
      case 'question': return this.#question(intent, trace);
      case 'task': return this.#task(intent.task, trace);
      case 'forget_all': {
        const n = forgetAll(this.store, trace);
        return { text: `Done. I deleted everything: ${n} memories, the do-not-relearn list and my audit trail. I keep nothing about you now.` };
      }
      case 'forget_inferred': {
        const n = forgetInferred(this.store, trace);
        return { text: n ? `Deleted ${n} thing${n === 1 ? '' : 's'} I had only guessed, and I won't guess those again.` : "I hadn't guessed anything about you, so there was nothing to delete." };
      }
      case 'forget': return this.#forget(intent.target, trace);
      case 'settings':
        this.setInference(intent.allowInference);
        return { text: intent.allowInference ? "Okay, I may make low-confidence guesses again. They'll always be labelled as guesses." : "Okay, I've stopped guessing. From now on I only store what you tell me directly." };
      case 'inspect': return { text: this.#inspectReply() };
      case 'yes': return this.#yes(trace);
      case 'no': return this.#no(trace);
      case 'wrong': return this.#wrong(trace);
      default: return this.#other(intent, sentence, trace);
    }
  }

  // ---- write path ---------------------------------------------------------------
  #statement(intent, trace) {
    const cands = intent.candidates.map((c) => ({ ...c, correction: c.correction || intent.correction }));
    const results = write(this.store, cands, trace);
    const lines = [];
    const focus = [];
    const changes = [];
    let pendingSet = false;
    for (const r of results) {
      const c = r.candidate;
      const val = this.#showRaw(c.subject, c.key, c.value);
      const say = (v = val) => sayValue(c.subject, c.key, v);
      if (this.session.pending && this.session.pending.subject === c.subject && this.session.pending.key === c.key && r.action !== 'contested') this.session.pending = null;
      switch (r.action) {
        case 'inserted': {
          const m = r.memory;
          focus.push(m.id);
          changes.push({ action: 'inserted', key: c.key, subject: c.subject });
          if (m.source.type === 'inferred') {
            lines.push(`I'm guessing ${say()}, from “${c.source.quote}”. You didn't say it, so that's only a guess (~${pct(m.baseConfidence)}) and I won't act on it without checking. Is that right?`);
            this.session.pending = { type: 'confirm', id: m.id, subject: m.subject, key: m.key };
            pendingSet = true;
          } else {
            const extras = [];
            if (m.source.hedged) extras.push('you sounded unsure');
            if (m.expiresAt) extras.push(`I'll drop it automatically ${describeIn(m.expiresAt - this.store.now())}`);
            if (m.scope.sensitivity === 'sensitive') extras.push("marked sensitive, so I won't surface it on a shared screen");
            lines.push(`Got it: ${say()}. I'll treat that as ~${pct(m.baseConfidence)} reliable${extras.length ? ` (${extras.join('; ')})` : ''}.`);
          }
          break;
        }
        case 'reinforced':
          focus.push(r.memory.id);
          changes.push({ action: 'reinforced', key: c.key, subject: c.subject });
          lines.push(r.upgraded
            ? `Thanks. ${cap(say())}: my guess is now something you told me directly (~${pct(r.memory.baseConfidence)}).`
            : `Noted again: ${say()}. Confidence up to ~${pct(r.memory.baseConfidence)} and the freshness clock is reset.`);
          break;
        case 'superseded': {
          focus.push(r.memory.id);
          changes.push({ action: 'superseded', key: c.key, subject: c.subject });
          const old = r.previous.map((m) => this.#showRaw(m.subject, m.key, m.value)).join(' / ');
          const why = {
            'explicit-correction': 'You flagged it as a change, so I replaced it.',
            'old-value-was-stale': 'What I had was old and already doubtful, so I replaced it instead of arguing.',
            'stated-beats-inferred': 'That replaces my earlier guess.',
            'resolved-by-user': 'That settles the conflict.',
          }[r.reason];
          lines.push(`Updated: ${say()}. It replaces ${old}. ${why} The old value is kept ${SUPERSEDED_RETENTION_DAYS} days in case that was a slip, then erased (say “forget” to erase it now).`);
          break;
        }
        case 'contested': {
          const m = r.memory;
          focus.push(m.id);
          changes.push({ action: 'contested', key: c.key, subject: c.subject });
          const old = r.previous.map((p) => `${this.#showRaw(p.subject, p.key, p.value)} (${describeAge(this.store.now() - p.lastConfirmedAt)})`).join(' / ');
          lines.push(`That conflicts with what I have: ${old}. Both are recent and nothing says which changed, so I won't guess. I've lowered my confidence in both and I won't use either until you tell me. Which one is current?`);
          this.session.pending = { type: 'resolve', subject: c.subject, key: c.key };
          pendingSet = true;
          break;
        }
        case 'resolved':
          focus.push(r.memory.id);
          changes.push({ action: 'resolved', key: c.key, subject: c.subject });
          lines.push(`Settled: ${say()}. I dropped the other value and set this one to ${pct(r.memory.baseConfidence)}.`);
          break;
        case 'retracted':
          changes.push({ action: 'retracted', key: c.key, subject: c.subject });
          lines.push(`Understood: I've marked ${r.memories.map((m) => this.#showRaw(m.subject, m.key, m.value)).join(' / ')} as no longer true. It's kept ${SUPERSEDED_RETENTION_DAYS} days, then erased.`);
          break;
        case 'rejected':
          if (r.reason === 'blocked') lines.push(`(I noticed a hint about your ${SLOTS[c.key].label}, but you told me not to guess that, so I discarded it.)`);
          else if (r.reason === 'inference-disabled') lines.push("(I noticed a possible hint, but guessing is switched off, so I stored nothing.)");
          else if (r.reason === 'nothing-to-retract') lines.push("I didn't have that stored, so there's nothing to change.");
          break;
      }
    }
    if (!pendingSet && this.session.pending?.type === 'resolve') this.session.pending = null;
    return { text: lines.join(' '), focus, changes };
  }

  // ---- retrieval path: answering a question -----------------------------------------
  #question({ subject, key }, trace) {
    const r = retrieve(this.store, { subject, keys: [key], audience: this.audience }, trace);
    const label = this.#label(subject, key);
    const def = slotDef(subject, key);

    if (r.withheld.length) {
      const w = r.withheld[0];
      if (w.reason === 'sensitive-on-shared-screen') {
        return { text: `I have something about your ${label}, but it's marked sensitive and this is a shared screen, so I'm not showing it. Switch to private mode to see it.`, withheld: r.withheld };
      }
      this.session.pending = def.cardinality === 'single' ? { type: 'ask', subject, key } : null;
      return { text: `I used to have something about your ${label}, but it faded (too old to trust) so I dropped it. What is it now?`, withheld: r.withheld };
    }
    if (r.contested.length) {
      const c = r.contested[0];
      this.session.pending = { type: 'resolve', subject, key };
      const opts = c.items.map((i) => `${i.value} (${describeAge(i.ageMs)})`).join(' and ');
      return { text: `You've told me different things about your ${label}: ${opts}. Both are recent so I won't guess. Which is current?`, withheld: [{ subject, key, reason: 'contested' }], focus: c.items.map((i) => i.id) };
    }
    if (!r.items.length) {
      this.session.pending = def.cardinality === 'single' ? { type: 'ask', subject, key } : null;
      return { text: `I don't have anything stored about your ${label}. Tell me and I'll remember it, and you can make me forget it any time.` };
    }

    if (def.cardinality === 'multi') return this.#answerMulti(subject, key, r.items);
    const item = r.items[0];
    const val = this.#showRaw(subject, key, item.value);
    const say = sayValue(subject, key, val);
    const relied = [this.#rel(item, 'stated')];
    if (item.sourceType === 'inferred') {
      this.session.pending = { type: 'confirm', id: item.id, subject, key };
      relied[0].usage = 'asked';
      const q = this.store.find(item.id)?.source.quote;
      return { text: `I've only guessed that ${say}: you never told me, I inferred it from “${q}” (~${pct(item.effective)}). Is that right?`, relied, focus: [item.id] };
    }
    if (item.band === 'confident') {
      relied[0].usage = 'applied';
      return { text: `${cap(say)}. (${cap(this.#src(item))}; I'm ${pct(item.effective)} confident.)`, relied, focus: [item.id] };
    }
    if (item.band === 'hedge') {
      relied[0].usage = 'hedged';
      const unsure = item.hedged ? " You also sounded unsure when you said it." : '';
      return { text: `I think ${say}. But ${this.#src(item)}, so I'm only about ${pct(item.effective)} sure.${unsure} Tell me if it has changed.`, relied, focus: [item.id] };
    }
    relied[0].usage = 'asked';
    this.session.pending = { type: 'confirm', id: item.id, subject, key };
    return { text: `I have “${val}” on file for your ${label}, but ${this.#src(item)} and I'm only ~${pct(item.effective)} sure it's still true, so I won't rely on it. Is it still right?`, relied, focus: [item.id] };
  }

  #answerMulti(subject, key, items) {
    const label = this.#label(subject, key);
    const parts = items.map((i) => {
      const note = i.sourceType === 'inferred' ? ', a guess' : i.band === 'verify' ? ', worth double-checking' : i.band === 'hedge' ? ', fairly sure' : '';
      return `${this.#showRaw(subject, key, i.value)} (${pct(i.effective)}${note})`;
    });
    const doubtful = items.find((i) => i.band === 'verify');
    if (doubtful) this.session.pending = { type: 'confirm', id: doubtful.id, subject, key };
    return {
      text: `On file for your ${label}: ${parts.join(', ')}. ${cap(this.#src(items[0]))}.${doubtful ? ` I'm not sure ${this.#showRaw(subject, key, doubtful.value)} is still current, so is it?` : ''}`,
      relied: items.map((i) => this.#rel(i, i.band === 'verify' ? 'asked' : i.band === 'hedge' ? 'hedged' : 'applied')),
      focus: items.map((i) => i.id),
    };
  }

  // ---- tasks: acting on memory --------------------------------------------------------
  #location(trace) {
    const r = retrieve(this.store, { keys: ['current_location', 'home_city'], audience: this.audience }, trace);
    const cur = r.items.find((i) => i.key === 'current_location' && i.sourceType !== 'inferred' && (i.band === 'confident' || i.band === 'hedge'));
    if (cur) return { item: cur, note: ` (you said you're there right now, so I'm using that over your home city)` };
    const contested = r.contested.find((c) => c.key === 'home_city');
    if (contested) {
      this.session.pending = { type: 'resolve', subject: 'user', key: 'home_city' };
      const opts = contested.items.map((i) => i.value).join(' or ');
      return { ask: { text: `Before I suggest anything: you've told me different cities (${opts}) and I don't know which is current. Which one?`, withheld: [{ subject: 'user', key: 'home_city', reason: 'contested' }], focus: contested.items.map((i) => i.id) } };
    }
    const home = r.items.find((i) => i.key === 'home_city');
    if (!home) {
      this.session.pending = { type: 'ask', subject: 'user', key: 'home_city' };
      return { ask: { text: "Before I suggest anything, I don't know where you are (I have no city on file). Which city?", withheld: r.withheld } };
    }
    if (home.sourceType === 'inferred' || home.band === 'verify') {
      this.session.pending = { type: 'confirm', id: home.id, subject: 'user', key: 'home_city' };
      const why = home.sourceType === 'inferred' ? `I only guessed ${home.value} from a passing remark (~${pct(home.effective)})` : `I have you in ${home.value}, but ${this.#src(home)} and I'm only ~${pct(home.effective)} sure`;
      return { ask: { text: `Before I suggest anything: ${why}, so I won't build on it. Are you in ${home.value}?`, relied: [this.#rel(home, 'asked')], focus: [home.id] } };
    }
    const note = home.band === 'hedge' ? ` (assuming you're still in ${home.value}: ${this.#src(home)}, ~${pct(home.effective)} sure)` : '';
    return { item: home, note };
  }

  #task(task, trace) {
    if (task === 'email') return this.#email(trace);
    const loc = this.#location(trace);
    if (loc.ask) return loc.ask;
    const relied = [this.#rel(loc.item, loc.item.band === 'confident' ? 'applied' : 'hedged')];
    const focus = [loc.item.id];
    const city = loc.item.value;
    const withheld = [];
    let text = '';

    if (task === 'food') {
      const prof = retrieve(this.store, { keys: ['diet', 'allergy'], audience: this.audience }, trace);
      withheld.push(...prof.withheld);
      const notes = [];
      let veg = false;
      const diet = prof.items.find((i) => i.key === 'diet');
      if (diet) {
        focus.push(diet.id);
        if (diet.sourceType !== 'inferred' && diet.band === 'confident') { veg = /vegetarian|vegan|pescatarian/.test(diet.value); relied.push(this.#rel(diet, 'applied')); notes.push(`filtering for ${diet.value} (${this.#src(diet)})`); }
        else if (diet.sourceType !== 'inferred' && diet.band === 'hedge') { veg = /vegetarian|vegan|pescatarian/.test(diet.value); relied.push(this.#rel(diet, 'hedged')); notes.push(`assuming ${diet.value}: ${this.#src(diet)}, ~${pct(diet.effective)} sure, so say so if that changed`); }
        else {
          relied.push(this.#rel(diet, 'asked'));
          this.session.pending = { type: 'confirm', id: diet.id, subject: 'user', key: 'diet' };
          notes.push(diet.sourceType === 'inferred'
            ? `I have a weak hint you might be ${diet.value} (I inferred it from “${this.store.find(diet.id)?.source.quote}”, ~${pct(diet.effective)}, never confirmed), so I am NOT filtering for it. Should I? (yes/no)`
            : `I have ${diet.value} on file but it's ${this.#src(diet)} (~${pct(diet.effective)}), so I'm not filtering for it. Still true? (yes/no)`);
        }
      }
      const allergies = prof.items.filter((i) => i.key === 'allergy');
      const avoid = allergies.map((a) => a.value);
      allergies.forEach((a) => {
        focus.push(a.id);
        relied.push(this.#rel(a, a.band === 'verify' ? 'asked' : 'applied'));
      });
      if (allergies.some((a) => a.band === 'verify')) {
        const a = allergies.find((x) => x.band === 'verify');
        if (!this.session.pending) this.session.pending = { type: 'confirm', id: a.id, subject: 'user', key: 'allergy' };
        notes.push(`your ${a.value} allergy note is old (~${pct(a.effective)}); I'm still avoiding it to be safe, but is it current?`);
      }
      if (prof.withheld.some((w) => w.key === 'allergy')) notes.push("I hold a sensitive dietary note that I can't show on a shared screen, so double-check menus yourself or switch to private mode for a tailored answer");
      const picks = veg
        ? ['a Middle Eastern mezze place', 'a South Indian dosa spot', 'a wood-fired pizzeria with veggie toppings']
        : ['a ramen bar', 'a grill house', 'a neighbourhood trattoria'];
      text = `For dinner in ${city}${loc.note ?? ''}, try ${picks.join(', ')}.`;
      if (avoid.length) text += ` I'll steer away from ${avoid.join(' and ')} (please still ask the kitchen).`;
      if (notes.length) text += ` Notes: ${notes.join('. ')}.`;
    } else if (task === 'local') {
      const prof = retrieve(this.store, { keys: ['likes'], audience: this.audience }, trace);
      const likes = prof.items.filter((i) => i.sourceType !== 'inferred' && (i.band === 'confident' || i.band === 'hedge'));
      likes.forEach((l) => { focus.push(l.id); relied.push(this.#rel(l, l.band === 'hedge' ? 'hedged' : 'applied')); });
      text = likes.length
        ? `For a weekend in ${city}${loc.note ?? ''}: plan one ${likes[0].value}-centred outing, then something low-key in the evening${likes[1] ? `, and a ${likes[1].value} detour if there's time` : ''}.`
        : `For a weekend in ${city}${loc.note ?? ''}: I don't know your interests yet, so here's a neutral plan: a long walk through a neighbourhood you haven't seen, then a good meal. Tell me what you like and I'll tailor it.`;
    }
    return { text, relied, withheld, focus };
  }

  // Drafting an intro email: needs no location, so it must not ask for one.
  #email(trace) {
    const r = retrieve(this.store, { keys: ['name', 'job_title', 'employer'], audience: this.audience }, trace);
    const use = (k) => r.items.find((i) => i.key === k && i.sourceType !== 'inferred' && (i.band === 'confident' || i.band === 'hedge'));
    const fields = [['name', use('name')], ['job title', use('job_title')], ['employer', use('employer')]];
    const [name, job, emp] = fields.map(([, i]) => i);
    const relied = [];
    const unsure = [];
    for (const [label, i] of fields) {
      if (!i) continue;
      relied.push(this.#rel(i, i.band === 'hedge' ? 'hedged' : 'applied'));
      if (i.band === 'hedge') unsure.push(`${label} (~${pct(i.effective)})`);
    }
    const missing = fields.filter(([, i]) => !i).map(([label]) => label);
    const intro = `Hi, I'm ${name ? name.value : '[your name]'}${job ? `, ${/^[aeiou]/i.test(job.value) ? 'an' : 'a'} ${job.value}` : ''}${emp ? ` at ${emp.value}` : ''}. I'd love to connect.`;
    let text = `Draft: “${intro}”`;
    if (missing.length) text += ` I left placeholders for ${missing.join(', ')} because I don't have them or don't trust what I have.`;
    if (unsure.length) text += ` Please check ${unsure.join(', ')}: I'm only moderately sure.`;
    return { text, relied, focus: relied.map((x) => x.id) };
  }

  // ---- forgetting on request --------------------------------------------------------------
  #forget(target, trace) {
    let n = 0;
    let text;
    if (target.type === 'subject') {
      n = forgetSubject(this.store, target.subject, trace);
      text = n ? `Forgotten: everything about your ${target.subject} (${n} record${n === 1 ? '' : 's'}). I won't guess it back.` : `I had nothing stored about your ${target.subject}.`;
    } else if (target.type === 'slots') {
      for (const k of target.keys) n += forgetSlot(this.store, target.subject, k, trace);
      const names = target.keys.map((k) => SLOTS[k].label).join(' / ');
      text = n ? `Forgotten: your ${names} (${n} record${n === 1 ? '' : 's'}, including any replaced history). The values are deleted, not hidden, and I won't guess them again.` : `I had nothing stored about your ${names}. I've also noted not to guess it.`;
    } else if (target.type === 'values') {
      for (const c of target.candidates) if (c.op !== 'retract') n += forgetValue(this.store, c.subject, c.key, c.value, trace);
      text = n ? `Forgotten: deleted ${n} record${n === 1 ? '' : 's'} (including any replaced history for that slot). I won't guess it back.` : "I didn't have that stored, so there was nothing to delete.";
    } else {
      text = "I'm not sure what to forget. Try “forget my allergies”, “forget that I live in Berlin”, “forget my sister”, or “forget everything”.";
    }
    this.#cleanSession();
    return { text };
  }

  #reject(mem, trace) {
    const label = this.#label(mem.subject, mem.key);
    const wasInferred = mem.source.type === 'inferred';
    const def = slotDef(mem.subject, mem.key);
    reject(this.store, mem, trace);
    this.#cleanSession();
    if (def.cardinality === 'single') this.session.pending = { type: 'ask', subject: mem.subject, key: mem.key };
    this.store.save();
    return wasInferred
      ? `Okay, that guess is deleted and I won't make it again. What is your ${label}, if you'd like to tell me?`
      : `Okay, I've erased that ${label}. What's the right one?`;
  }

  #yes() {
    const p = this.session.pending;
    if (p?.type === 'confirm') {
      const mem = this.store.find(p.id);
      if (mem) {
        confirm(this.store, mem, []);
        this.session.pending = null;
        return { text: `Thanks. I've marked ${sayValue(mem.subject, mem.key, this.#show(mem))} as confirmed by you (${pct(mem.baseConfidence)}), and the freshness clock is reset.`, focus: [mem.id], changes: [{ action: 'confirmed', key: mem.key, subject: mem.subject }] };
      }
    }
    if (p?.type === 'resolve') return { text: 'Which one? Just tell me the value that is current.' };
    const targets = (this.session.lastRelied ?? []).map((id) => this.store.find(id)).filter(Boolean);
    if (targets.length) {
      targets.forEach((m) => confirm(this.store, m, []));
      return { text: `Great. I've confirmed ${targets.length} memor${targets.length === 1 ? 'y' : 'ies'} I just used and reset their freshness.`, focus: targets.map((m) => m.id) };
    }
    return { text: "Yes to what? I don't have an open question right now." };
  }

  #no(trace) {
    const p = this.session.pending;
    if (p?.type === 'confirm') {
      const mem = this.store.find(p.id);
      if (mem) return { text: this.#reject(mem, trace) };
    }
    if (p?.type === 'resolve') {
      this.session.pending = { type: 'ask', subject: p.subject, key: p.key };
      return { text: 'Neither is right? Tell me the correct value and I will replace both.' };
    }
    return { text: "No to what? I don't have an open question. You can say “that's wrong” right after I use a memory." };
  }

  #wrong(trace) {
    const targets = (this.session.lastRelied ?? []).map((id) => this.store.find(id)).filter(Boolean);
    if (targets.length === 1) return { text: this.#reject(targets[0], trace) };
    if (targets.length > 1) {
      const names = targets.map((m) => `${SLOTS[m.key].label} (${this.#show(m)})`).join(', ');
      return { text: `I used several memories there: ${names}. Which one is wrong? Say “forget my <thing>”, or use the ✗ button on its card.` };
    }
    return { text: "I'm not sure what you mean is wrong, since I haven't just used a memory. Tell me the correct fact, or say “forget my <thing>”." };
  }

  #other(intent, sentence, trace) {
    const text = (intent.text ?? sentence).trim();
    const p = this.session.pending;
    const words = text.split(/\s+/);
    if (p && (p.type === 'ask' || p.type === 'resolve' || p.type === 'confirm') && words.length <= 4 && !SMALLTALK.test(text) && !/[?]/.test(text)) {
      const def = slotDef(p.subject, p.key);
      if (def) {
        const value = /^[a-z\s'-]+$/.test(text) && ['home_city', 'employer', 'name'].includes(p.key) ? text.replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : text;
        return this.#statement({ candidates: [{ subject: p.subject, key: p.key, value, op: 'assert', hedged: false, correction: true, source: { type: 'user_stated', quote: text } }], correction: true }, trace);
      }
    }
    if (/^(?:hi|hello|hey)\b/i.test(text)) return { text: 'Hi! Tell me something about yourself and watch how I store it, or ask what I remember about you.' };
    if (/^thanks?/i.test(text)) return { text: "You're welcome." };
    return { text: "I'm a memory demo, not a general assistant. Try: “I live in Berlin”, “Where do I live?”, “Recommend a dinner spot”, “What do you remember about me?” or “Forget my allergies”." };
  }

  #inspectReply() {
    const snap = inspect(this.store);
    const live = snap.memories.filter((m) => m.status !== 'superseded');
    if (!live.length) return snap.counts.superseded ? `I'm holding nothing current about you, only ${snap.counts.superseded} replaced value(s) waiting to be erased.` : "I'm not holding anything about you. You can tell me things, and you can always make me forget them.";
    const c = snap.counts;
    const head = `I'm holding ${live.length} thing${live.length === 1 ? '' : 's'} about you: ${c.confident} I'm confident about, ${c.hedge} I'd hedge on, ${c.verify} I'd double-check, ${c.contested} contested, ${c.inferred} guessed.`;
    const bullets = live.map((m) => {
      const what = cap(`${m.subject === 'user' ? '' : `${m.subject}'s `}${SLOTS[m.key].label}`);
      return `• ${what}: ${this.#show(m)} (${pct(m.effective)}, ${m.status === 'contested' ? 'contested' : m.source.type.replace('_', ' ')}, ${describeAge(m.ageMs)})`;
    });
    return `${head}\n${bullets.join('\n')}\nThe panel on the right shows each one with its source, confidence, freshness and when it will be erased. Ask me to forget any of it.`;
  }
}
