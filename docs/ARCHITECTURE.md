# Architecture snapshot

This is **not** plain vector RAG. Memory is a set of *typed slots* with a lifecycle. Confidence, freshness and scope are first-class fields that change what the agent does. The forgetting policy is code, not a hope.

```
                      ┌────────────────────────────── one JSON document (Store) ──────────────────────────────┐
 user message         │  memories[]        blocklist[]              audit[]              session   clockOffset │
      │               └─────▲──────────────────▲───────────────────────▲──────────────────────────────────────┘
      ▼                     │                  │                       │
  extract.js  ──► candidates (subject, key, value, source, hedged, correction, expiry)
      │
      ├──► WRITE PATH      write.js     gate → conflict → insert | reinforce | supersede | contest | resolve | retract
      ├──► RETRIEVAL PATH  retrieve.js  scope + audience filter → lifecycle → effective confidence → band
      └──► FORGETTING PATH forget.js    expire | fade | supersede-retention | reject | revoke      (sweep runs every turn)
                                        │
                     agent.js  ◄────────┘   band → behaviour:  use | hedge | ask first | withhold
```

## The memory record

Every memory is one fact in one slot (`subject` + `key`), e.g. `user.home_city = "Berlin"`.

| Field | Meaning |
|---|---|
| `source` | `{ type: user_stated \| user_confirmed \| inferred, quote, at, hedged }`. The quote is the sentence it came from. |
| `baseConfidence` | Confidence at the last confirmation. Derived from source type (0.97 / 0.90 / 0.40), ×0.65 if the user hedged ("I think…"), ×0.6 while contested. |
| `lastConfirmedAt` | Freshness anchor. Restating or confirming a fact resets it. |
| `halfLifeDays` (per slot) | How fast this *kind* of fact goes stale: mood/project ~3–21 days, city ~18 months, employer ~14 months, name ~20 years, allergy ~10 years. Guesses decay 4× faster. |
| `scope` | `{ subject (you / your sister / your dog), context (personal / work / health / third-party), sensitivity (normal / sensitive) }`. |
| `status` | `active`, `contested`, `superseded`. Fading and expiry are *computed from time*, not stored. |
| `expiresAt` | Set by phrases like "this week" or "today". |

**Effective confidence** is never stored. It is recomputed on every read:

```
effective = baseConfidence × 0.5 ^ ( (now − lastConfirmedAt) / halfLife )
```

| Band | Effective | Agent behaviour |
|---|---|---|
| confident | ≥ 0.75 | Use it. State source and confidence. |
| hedge | 0.50 – 0.75 | Use it but say "I think…", how old it is, how sure. |
| verify | 0.25 – 0.50 | **Do not rely on it.** Ask. Tasks that need it stop and ask first. |
| faded | < 0.25 | Treated as unknown. Erased after a 45-day grace window. |

Because decay is a pure function of time, the moment a memory crosses any line is deterministic (`dormantAt`), so a sweep that runs late still forgets on schedule.

## Write path (`write.js`)

1. **Privacy gate.** Guesses are dropped if inference is off, if the slot is `neverInfer` (allergies, health, phone, email), or if the user previously rejected or forgot that exact guess (hashed do-not-relearn list).
2. **Retraction.** "I no longer work at Acme" marks the value superseded without inventing a replacement.
3. **Conflict detection** for single-valued slots:

| Situation | Outcome |
|---|---|
| Same value | **Reinforce**: confidence up (`1−(1−b)·0.6`, capped 0.98; a repeated *guess* capped 0.55), freshness reset. A guess restated by the user is upgraded to `user_stated`. |
| Different value, new one is a **guess** | **Rejected.** A guess never overturns something on file. |
| Different value, user flagged a change ("actually", "moved to", "no longer") | **Supersede.** Old value kept 30 days, then erased. |
| Different value, old one is **stale** (< 0.5) or was itself a guess | **Supersede**, and the agent says why. |
| Different value, both **fresh**, no signal which is right | **Contest.** Both kept, both ×0.6, neither is relied on. The agent asks. |
| A contested slot and the user states a value | **Resolve.** The chosen one becomes `user_confirmed`; the rest are superseded. |

4. Multi-valued slots (allergies, likes, languages) accumulate; each value has its own confidence.

## Retrieval path (`retrieve.js`)

Retrieval is **purpose-scoped**. A caller names the slots it needs (a dinner recommendation asks for city, diet and allergies; an intro email asks for name, job and employer). There is no "load everything into the prompt" mode.

1. Look up live memories per slot; drop expired/purgeable ones.
2. **Audience filter.** On a shared screen, `sensitive` slots are not loaded at all. The agent says something is withheld and never echoes the value.
3. **Contested slot** → returned as a conflict, relied on by nobody.
4. Compute effective confidence and band. `faded` items are withheld, *except* safety-critical slots (allergies): forgetting an allergy is worse than remembering it too long, so it is still honoured, conservatively, with a "still true?" prompt.
5. The reply returns `relied[]` (each with value, confidence, band, source, and how it was used: `applied` / `hedged` / `asked`) and `withheld[]` (with the reason). The UI renders these as chips under every answer.

## Forgetting path (`forget.js`)

| Trigger | Mechanism | What remains afterwards |
|---|---|---|
| Says "this week" | `expiresAt` reached → **expired** | audit line (slot, reason) |
| Time passes | Below 0.25 for 45 days → **faded** | audit line |
| Replaced or retracted | **Superseded**, value kept 30 days (undo/audit), then erased | audit line |
| "That's wrong" / ✗ | **Rejected**: record deleted; a rejected *guess* is added to do-not-relearn | audit line + value hash |
| "Forget my allergies" / "Forget that I live in Berlin" / "Forget my sister" / "Forget what you guessed" | **Revoked**: hard delete of the slot *including replaced history*, plus do-not-relearn | audit line (slot only) |
| "Forget everything" | Memories, do-not-relearn list and audit trail all deleted | one "wiped" line |

Deletion removes the record from the store. There is no soft-delete flag. The tests serialize the store and assert the deleted value and its quote do not appear anywhere in the bytes. The audit trail never contains values. The do-not-relearn list contains hashes only.

## Privacy model

- **Minimal disclosure**: purpose-scoped retrieval; sensitive categories withheld on shared screens; masked in the inspector too.
- **No silent inference of sensitive categories.** Inference is limited to two low-stakes rules, is capped below "confident", is visibly labelled, can be switched off, and can be erased in bulk.
- **Third parties** ("my sister lives in Cairo") are scoped to that person, treated as sensitive, and erasable as a group.
- **User inspector** with per-memory *Still true / Wrong / Forget*, plus export.

## Where a real deployment would extend this

The extractor (`extract.js`) is rule-based so the demo is deterministic and keyless. It emits exactly the candidate shape an LLM extractor would, so it can be swapped without touching the rest. An embedding index could sit in front of the slot store for open-domain recall; it would feed candidates into the same write path and be filtered through the same retrieval path. The confidence and forgetting model would not change.
