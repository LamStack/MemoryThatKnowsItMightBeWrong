# Two-year thesis: agent memory done right

By 2028 every serious agent will have memory. The winners will be the ones whose memory can be audited.

**Memory is a claim, not a fact.** Today's memory stores strings. It should store claims: who said it, when, how sure, about whom, and until when. Once memory is a claim, the agent can behave like a good colleague: "I think you're still in Berlin, but that was a year ago. Still right?" The most valuable sentence an agent can say is "I might be wrong about this", and it is only honest if the number behind it decays.

**Forgetting is a feature with a schedule.** Retrieval is a solved-enough problem; retraction is not. Stale facts, contradictions and revoked consent will decide whether people trust agents with real context. So forgetting must be first-class: time decay, explicit supersession, hard deletes that really delete, and a do-not-relearn list that stops a rejected fact sneaking back in through inference.

**Inference is where memory turns invasive.** The gap between "you told me" and "I worked it out" is the privacy boundary. Guesses must be labelled, capped below "confident", never applied to sensitive categories, and killable in one sentence.

**Where this goes in two years:**

1. Memory becomes user-owned and portable: an inspector as normal as a browser's cookie panel, but readable, with a per-memory "wrong" and "forget" button.
2. Buyers and regulators ask for provenance and deletion receipts the way they now ask for access logs.
3. Benchmarks stop rewarding recall alone and score *calibration*: does stated confidence match the hit rate, and does the agent ask when it should?

A tool remembers. A colleague remembers, doubts, and forgets when asked. That is the product.
