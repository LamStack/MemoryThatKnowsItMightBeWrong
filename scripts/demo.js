// Replays the guided demo in the terminal:  npm run demo
import { createAgent } from '../web/engine/index.js';
import { SCENARIO } from '../web/engine/scenario.js';

const { store, agent } = createAgent({ nowFn: () => Date.UTC(2026, 0, 1) });
const trace = process.argv.includes('--trace');
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

for (const step of SCENARIO) {
  if (step.note) { console.log(`\n${bold(step.note)}`); continue; }
  if (step.audience) { agent.setAudience(step.audience); console.log(dim(`[audience -> ${step.audience}]`)); continue; }
  if (step.advance) {
    const { swept } = agent.advanceTime(step.advance);
    console.log(dim(`[clock ${step.label}${swept.length ? `; erased: ${swept.map((s) => `${s.key} (${s.reason})`).join(', ')}` : ''}]`));
    continue;
  }
  const res = agent.respond(step.say);
  console.log(`\n> ${step.say}\n${res.text}`);
  if (res.relied.length) console.log(dim(`  relied on: ${res.relied.map((r) => `${r.key}=${r.value} ${Math.round(r.effective * 100)}% ${r.band}/${r.usage}`).join(' | ')}`));
  if (res.withheld.length) console.log(dim(`  withheld:  ${res.withheld.map((w) => `${w.key} (${w.reason})`).join(' | ')}`));
  if (trace) res.trace.forEach((t) => console.log(dim(`  [${t.path}:${t.step}] ${t.detail}`)));
}
void store;
