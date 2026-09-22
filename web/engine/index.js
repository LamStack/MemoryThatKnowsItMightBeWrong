import { Store, MemoryAdapter, LocalStorageAdapter } from './store.js';
import { MemoryAgent } from './agent.js';

export * from './schema.js';
export * from './confidence.js';
export { Store, MemoryAdapter, LocalStorageAdapter, MemoryAgent };
export { write, confirm } from './write.js';
export { retrieve, inspect } from './retrieve.js';
export { sweep, forgetSlot, forgetValue, forgetSubject, forgetInferred, forgetAll, reject } from './forget.js';
export { interpret, statements, splitSentences } from './extract.js';

export function createAgent({ adapter = new MemoryAdapter(), nowFn } = {}) {
  const store = new Store(adapter, nowFn);
  return { store, agent: new MemoryAgent(store) };
}
