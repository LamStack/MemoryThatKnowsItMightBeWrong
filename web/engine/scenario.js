// The guided demo, as data. The UI plays it step by step; scripts/demo.js and the
// tests replay it headlessly. Each step is one of:
//   { note }               narration
//   { say }                a user message
//   { advance, label }     jump the simulated clock forward N days
//   { audience }           'private' | 'shared'
export const SCENARIO = [
  { note: '1. Teach it a few things. Each fact is stored with source, confidence, freshness and scope.' },
  { say: 'Call me Sam. I live in Berlin and I am allergic to peanuts.' },
  { note: '2. Something I only hinted at. The agent may guess, but it labels the guess and will not rely on it.' },
  { say: 'I ordered the veggie burger yesterday.' },
  { say: 'Recommend a dinner spot' },
  { note: '3. The guess was wrong. Rejecting it deletes it and blocks the same guess from coming back.' },
  { say: 'No' },
  { say: 'I had a veggie wrap for lunch.' },
  { note: '4. Eighteen months pass. Nothing was deleted, but confidence in "Berlin" has quietly decayed.' },
  { advance: 548, label: '+18 months' },
  { say: 'Where do I live?' },
  { note: '5. It does not just answer. It says it is unsure, and it refuses to build a plan on the doubtful fact.' },
  { say: 'Recommend a dinner spot' },
  { say: 'Actually I moved to Lisbon' },
  { say: 'Recommend a dinner spot' },
  { note: '6. Contradiction: two fresh claims, no sign of a change. It will not pick a winner.' },
  { say: 'I work at Acme' },
  { say: 'I work at Globex' },
  { say: 'Where do I work?' },
  { say: 'Globex' },
  { note: '7. Privacy: sensitive memories are withheld on a shared screen, and "forget" is a hard delete.' },
  { audience: 'shared' },
  { say: 'Am I allergic to anything?' },
  { audience: 'private' },
  { say: 'Forget my allergies' },
  { say: 'Am I allergic to anything?' },
  { note: '8. The inspector: everything it holds, and how sure it is.' },
  { say: 'What do you remember about me?' },
];
