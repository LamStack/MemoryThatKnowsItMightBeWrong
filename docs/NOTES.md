# Notes

## AI tools used

- **Claude Code** (Claude Sonnet 5) wrote the engine, tests, UI and docs in a single session, driven by the challenge brief. I ran the tests and drove the finished page in headless Chrome to check it.

## Key decisions

1. **Slots, not documents.** A fact is `subject.key = value`. Slots give us conflict detection, per-kind half-lives and clean deletion. Free-text vector chunks give us none of these.
2. **Confidence is computed, not stored.** Only the confidence *at last confirmation* is stored; effective confidence is a function of time. This makes staleness impossible to forget to update and makes the forgetting schedule deterministic.
3. **Confidence drives behaviour.** Bands decide whether the agent uses a memory, hedges, or stops and asks. A number that only appears in a tooltip would not count.
4. **Contest instead of guess.** Two fresh, disagreeing claims are both kept and neither is used. Picking the newest is right most of the time and badly wrong the rest.
5. **Inference is the invasive part**, so it is capped, labelled, never applied to sensitive slots, switchable off, and rejected guesses go on a do-not-relearn list (hashes only).
6. **Hard delete.** No soft-delete flag; tests grep the serialized store.
7. **Asymmetric risk.** Allergies keep protecting the user after they fade.
8. **Deterministic, rule-based extractor** so the demo is reproducible and needs no API key. It emits the same candidate shape an LLM extractor would.
9. **Simulated clock** stored in the state, so "eighteen months later" can be shown in seconds and survives a reload.
10. **Zero dependencies**, plain ES modules. A clean clone runs with `npm test` / `npm run serve`; the demo is static files.

## Out of scope / known limitations

- **English-only regex extraction.** It handles the phrasings the demo and tests cover, not arbitrary language. An LLM extractor is the intended replacement.
- **No server, accounts or sync.** Memory lives in the browser's `localStorage` (or a JSON file in Node). Nothing is encrypted at rest.
- **Hashes are not a security boundary.** The do-not-relearn list uses a small non-cryptographic hash so no plaintext is stored, but a short low-entropy value could be brute-forced. A production system would use a keyed hash.
- **Deleting from the store does not scrub backups**, browser history, or OneDrive/file-sync copies of an exported file.
- **Half-lives and thresholds are hand-set** priors, not fitted to data. Calibrating them against real hit rates is the obvious next step.
- **No embedding / open-domain recall.** See the last section of `ARCHITECTURE.md` for where it would plug in.
- **Single user, single conversation.** No multi-agent or multi-session scope beyond the private / shared-screen audience.
