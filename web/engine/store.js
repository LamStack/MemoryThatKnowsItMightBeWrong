// Storage. One JSON document behind a tiny adapter interface:
//   adapter.load() -> string | null      adapter.save(string)
// Adapters: in-memory (tests), localStorage (browser), file (Node, in store-node.js).
// Everything the system knows -- memories, the do-not-relearn list, the audit
// trail, the simulated clock -- is in this one document, so "delete" is a real
// delete and can be verified by grepping the serialized state.

import { hashValue } from './schema.js';

const VERSION = 1;
const AUDIT_CAP = 300;

export class MemoryAdapter {
  constructor(initial = null) { this.raw = initial; }
  load() { return this.raw; }
  save(text) { this.raw = text; }
}

export class LocalStorageAdapter {
  constructor(key = 'memory-that-knows.v1') { this.key = key; }
  load() { try { return localStorage.getItem(this.key); } catch { return null; } }
  save(text) { try { localStorage.setItem(this.key, text); } catch { /* storage full or blocked: keep running in memory */ } }
  clear() { try { localStorage.removeItem(this.key); } catch { /* ignore */ } }
}

function freshState() {
  return {
    version: VERSION,
    seq: 0,
    clockOffsetMs: 0,
    settings: { allowInference: true },
    memories: [],
    blocklist: [], // [{ subject, key, valueHash|null, at }] -- "do not silently re-learn this"
    audit: [],     // [{ at, type, subject, key, reason }] -- never contains values
    session: { pending: null, lastRelied: [] },
  };
}

export class Store {
  constructor(adapter = new MemoryAdapter(), nowFn = () => Date.now()) {
    this.adapter = adapter;
    this.nowFn = nowFn;
    this.state = this.#read();
  }

  #read() {
    const raw = this.adapter.load();
    if (!raw) return freshState();
    try {
      const parsed = JSON.parse(raw);
      if (parsed.version !== VERSION) return freshState(); // no migrations yet; unknown formats are not trusted
      return { ...freshState(), ...parsed };
    } catch {
      return freshState();
    }
  }

  now() { return this.nowFn() + this.state.clockOffsetMs; }
  advance(days) { this.state.clockOffsetMs += days * 86_400_000; this.save(); }
  save() { this.adapter.save(JSON.stringify(this.state)); }
  serialize() { return JSON.stringify(this.state); }

  nextId() { this.state.seq += 1; return `m${this.state.seq}`; }
  get memories() { return this.state.memories; }
  get settings() { return this.state.settings; }

  find(id) { return this.state.memories.find((m) => m.id === id); }
  slot(subject, key) { return this.state.memories.filter((m) => m.subject === subject && m.key === key); }
  live(subject, key) { return this.slot(subject, key).filter((m) => m.status !== 'superseded'); }

  remove(id) {
    const i = this.state.memories.findIndex((m) => m.id === id);
    if (i >= 0) this.state.memories.splice(i, 1);
  }

  audit(type, { subject = null, key = null, reason = '' } = {}) {
    this.state.audit.push({ at: this.now(), type, subject, key, reason });
    if (this.state.audit.length > AUDIT_CAP) this.state.audit.splice(0, this.state.audit.length - AUDIT_CAP);
  }

  block(subject, key, value = null) {
    const valueHash = value == null ? null : hashValue(value);
    const exists = this.state.blocklist.some((b) => b.subject === subject && b.key === key && b.valueHash === valueHash);
    if (!exists) this.state.blocklist.push({ subject, key, valueHash, at: this.now() });
  }

  isBlocked(subject, key, value) {
    const h = hashValue(value);
    return this.state.blocklist.some((b) => b.subject === subject && b.key === key && (b.valueHash === null || b.valueHash === h));
  }

  unblock(subject, key) {
    this.state.blocklist = this.state.blocklist.filter((b) => !(b.subject === subject && b.key === key));
  }

  // Factory reset (memories, settings, audit, simulated clock). Used by the demo's Reset button.
  reset() { this.state = freshState(); this.save(); }

  wipe() {
    const settings = this.state.settings;
    const offset = this.state.clockOffsetMs;
    this.state = freshState();
    this.state.settings = settings;
    this.state.clockOffsetMs = offset;
    this.save();
  }
}
