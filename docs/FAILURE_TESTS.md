# Failure tests

Every scenario below is an automated test (`npm test`, 42 tests, including a seeded fuzz test that checks the memory invariants after every step) and most also appear in the guided demo (`npm run demo`). Transcripts are real output from the demo script.

## 1. Contradictory facts

*Test: "contradiction: two fresh claims are contested, neither is relied on, the user resolves it"*

```
> I work at Acme
Got it: you work at Acme. I'll treat that as ~90% reliable.

> I work at Globex
That conflicts with what I have: Acme (just now). Both are recent and nothing says which changed,
so I won't guess. I've lowered my confidence in both and I won't use either until you tell me.
Which one is current?

> Where do I work?
You've told me different things about your employer: Acme (just now) and Globex (just now).
Both are recent so I won't guess. Which is current?          [relied on: nothing]

> Globex
Settled: you work at Globex. I dropped the other value and set this one to 97%.
```

What is verified: both records exist with status `contested` and confidence ×0.6; retrieval returns no relied-on items; the user's answer supersedes the loser and upgrades the winner to `user_confirmed`.

Related tests: an explicit correction ("Actually I moved to Lisbon") supersedes instead of contesting; a **stale** old value is replaced rather than argued with; a **guess can never overturn** something the user said; repeating a guess never makes it confident.

## 2. Stale data

*Tests: "effective confidence decays…", "stale data is forgotten on a deterministic schedule even if the sweep runs late", "temporary facts expire on their own", "replaced values are erased after the retention window"*

```
> Where do I live?                          (18 months after "I live in Berlin")
I have "Berlin" on file for your home city, but you told me 18 months ago and I'm only ~45% sure
it's still true, so I won't rely on it. Is it still right?

> Recommend a dinner spot
Before I suggest anything: I have you in Berlin, but you told me 18 months ago and I'm only ~45%
sure, so I won't build on it. Are you in Berlin?              [no plan is produced]
```

Nothing was deleted; the agent simply stopped trusting the fact and changed its behaviour. Confidence walks confident → hedge (≈5 months) → verify (≈15 months) → faded (≈33 months) → erased 45 days later. "I'm in Tokyo this week" expires by itself after 7 days and the home city takes over again.

## 3. Privacy revocation

*Tests: "revocation is a real delete…", "forgetting a value also erases the replaced history", "forget everything leaves nothing behind", "rejecting a guess deletes it and blocks the same guess", "the do-not-relearn list stores hashes, never plaintext", "sensitive memories are withheld on a shared screen and never echoed"*

```
> [shared screen]  Am I allergic to anything?
I have something about your allergies, but it's marked sensitive and this is a shared screen,
so I'm not showing it. Switch to private mode to see it.

> Forget my allergies
Forgotten: your allergies (1 record, including any replaced history). The values are deleted,
not hidden, and I won't guess them again.

> Am I allergic to anything?
I don't have anything stored about your allergies. ...
```

What is verified: after "forget", the serialized store contains **no** trace of the value or the sentence it came from; unrelated memories are untouched; the audit trail holds only slot names and reasons.

**Revocation of a guess:**

```
> I ordered the veggie burger yesterday.
I'm guessing you're vegetarian ... only a guess (~35%) and I won't act on it without checking. Is that right?
> No
Okay, that guess is deleted and I won't make it again.
> I had a veggie wrap for lunch.
(I noticed a hint about your diet, but you told me not to guess that, so I discarded it.)
```

The user can still *say* "I'm vegetarian" later; the block is on silent re-learning, not on the user's own words.

## Other failure modes covered

| Failure | Behaviour |
|---|---|
| Allergy record fades to below the trust line | Still honoured conservatively, with a "still true?" prompt (asymmetric risk) |
| Sensitive fact stated on a shared screen | Acknowledgement masks the value; inspector masks it too |
| Inference switched off / "stop guessing" | No guesses stored; direct statements still work |
| Guess of a sensitive category (allergy, health, phone, email) | Rejected at the write gate; can only be *stated* |
| Third-party facts ("my sister lives in Cairo") | Scoped to the sister, treated as sensitive, erasable as a group |
| Corrupt or unknown-version storage | Not trusted; starts empty rather than guessing |
| User text containing HTML | Rendered as text (verified in a real browser: no injected nodes, no script execution) |
