# Memory That Knows It Might Be Wrong

> How can AI remember without becoming inaccurate, invasive, or overconfident?

An agent memory layer where **every fact carries its source, confidence, freshness and scope**, where confidence **decays** and changes what the agent does, and where **forgetting is explicit**: stale, contradicted and user-revoked memories each have their own path.

**Live demo:** https://lamstack.github.io/MemoryThatKnowsItMightBeWrong/ (served from `web/` by the included GitHub Pages workflow; enable it once under *Settings → Pages → Source: GitHub Actions*).

**Run it locally** (no install, no dependencies, Node ≥ 18):

```bash
npm test          # 42 tests: model, decay, contradictions, revocation, privacy, storage, fuzzed invariants
npm run demo      # the guided demo in your terminal  (add --trace to see the pipeline)
npm run serve     # the web demo at http://localhost:8080
```

## The 20-second version

```
> I live in Berlin.                        Got it: you live in Berlin. ~90% reliable.
  ...eighteen months pass. Nothing is deleted...
> Where do I live?                         I have "Berlin" on file, but you told me 18 months ago and
                                           I'm only ~45% sure it's still true, so I won't rely on it.
                                           Is it still right?
> Recommend a dinner spot                  Before I suggest anything: I have you in Berlin, but I'm
                                           only ~45% sure, so I won't build on it. Are you in Berlin?
> Actually I moved to Lisbon               Updated. It replaces Berlin. Old value erased in 30 days.
```

## What is in the box

| You asked for | Where it is |
|---|---|
| Each fact tagged with **source, confidence, freshness, scope** | [`web/engine/write.js`](web/engine/write.js), [`schema.js`](web/engine/schema.js), [`confidence.js`](web/engine/confidence.js) |
| Retrieval **shows what it relies on and how sure it is** | Chips under every reply; [`retrieve.js`](web/engine/retrieve.js), [`agent.js`](web/engine/agent.js) |
| **Forgetting policy**: stale, contradicted, user-revoked | [`forget.js`](web/engine/forget.js), [`write.js`](web/engine/write.js) (contest / supersede / resolve) |
| Demo where memory says **"I might be wrong"** and acts on it | Press *Play guided demo (~1 min)*; step 4–5 |
| **Architecture snapshot** (write / retrieval / forgetting paths) | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| **Failure tests**: contradiction, stale data, revocation | [`docs/FAILURE_TESTS.md`](docs/FAILURE_TESTS.md) and [`test/engine.test.js`](test/engine.test.js) |
| **Two-year thesis** (≤300 words) | [`docs/THESIS.md`](docs/THESIS.md) |
| Notes: AI tools, key decisions, out of scope | [`docs/NOTES.md`](docs/NOTES.md) |
| Bonus: **"what do you remember about me?"** inspector | Right-hand panel, per-memory *Still true / Wrong / Forget*, export |
| Bonus: **privacy controls demoed** | Shared-screen toggle, "allow guesses" switch, hard delete, do-not-relearn list |

## Try these in the demo

| Say or click | What you should see |
|---|---|
| "I live in Berlin", then **+1 year**, then "Where do I live?" | "I think you live in Berlin… only ~56% sure" |
| …then **+6 months** more | Confidence drops below the line; it asks instead of asserting |
| "I work at Acme" then "I work at Globex" | It refuses to pick; asks which is current |
| "I ordered a veggie burger" | A labelled 35% guess it will not act on; "No" deletes it for good |
| "I'm allergic to peanuts", flip to **Shared screen**, ask about allergies | Withheld and masked |
| "Forget my allergies" | Hard delete; only the slot name and reason stay in the audit trail |
| "I'm in Tokyo this week", then **+2 weeks** | The fact expires on its own |
| "My sister Nora lives in Cairo", "Forget my sister" | Scoped to her, treated as sensitive, erased as a group |

## Layout

```
web/                 static site (this is what gets deployed)
  engine/            the memory layer: schema, confidence, store, write, retrieve, forget, extract, agent
  index.html app.js styles.css
test/                engine tests + a seeded fuzz test (node:test, no dependencies)
scripts/             demo.js (terminal walkthrough), serve.js (static server)
docs/                architecture, failure tests, thesis, notes
```

## Honest limits

The extractor is rule-based English (deterministic and keyless, by design; an LLM extractor can emit the same candidate shape). There is no server or encryption at rest. Half-lives are hand-set priors. Full list in [`docs/NOTES.md`](docs/NOTES.md).

MIT licensed.
