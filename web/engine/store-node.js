// Node-only adapter: persists the store as a JSON file. Kept out of store.js so
// the browser bundle never imports 'node:fs'.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class FileAdapter {
  constructor(path) { this.path = path; }
  load() { return existsSync(this.path) ? readFileSync(this.path, 'utf8') : null; }
  save(text) {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, text, 'utf8');
  }
}
