// Turns one user message into structured intents. Deliberately rule-based:
// the demo is reproducible, runs with no API key, and every write can be traced
// to a sentence. The output shape (candidates with source/hedge/correction/expiry)
// is exactly what an LLM extractor would have to produce, so it can be swapped in.

import { RELATIONS, DAY } from './schema.js';

const REL = Object.keys(RELATIONS).join('|');
const HEDGE = /\b(?:i think|i believe|i guess|maybe|probably|perhaps|not sure|might be|i suppose)\b/i;
const LEAD_CORRECTION = /^(?:no|nope|actually|correction|wait|sorry|oops|well|hmm)\b[,.:! ]*/i;
const INLINE_CHANGE = /\b(?:no longer|not anymore|any ?more|these days|switched|changed|new job|now)\b/i;
const CLAUSE_SPLIT = /\s*,\s*(?:(?:and|but)\s+)?(?=(?:i|i'm|i am|i've|my)\b)|\s+(?:and|but|also)\s+(?=(?:i|i'm|i am|i've|my)\b)/i;

const smartCase = (v) => (v === v.toLowerCase() ? v.replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : v);
const cutTail = (v) => v.replace(/\s+(?:now|these days|at the moment|currently|since|because|but|though|so|as of|right now|lately|again|for (?:\d+|a|the|years|ages))\b.*$/i, '');
const tidy = (v) => v.trim().replace(/\s+/g, ' ').replace(/^["'“]+|["'”.!,;:]+$/g, '').trim();
const splitList = (v) => v.split(/\s*(?:,|&|\band\b|\bor\b)\s*/i).map((x) => tidy(x).replace(/^(?:to|the|any|all)\s+/i, '')).filter(Boolean);

const LEAD_ONLY = /^(?:no|nope|actually|correction|wait|sorry|oops|well|hmm)$/i;

// "Actually, I live in Lisbon" must stay one clause so the correction marker survives.
function mergeLeads(parts) {
  const out = [];
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    if (out.length && LEAD_ONLY.test(out[out.length - 1])) out[out.length - 1] += `, ${p}`;
    else out.push(p);
  }
  return out;
}

export function splitSentences(text) {
  return text
    .split(/[.!?;\n]+(?=\s|$)/)
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => mergeLeads(s.split(CLAUSE_SPLIT)));
}

// ---- control intents ------------------------------------------------------
const SLOT_WORDS = [
  [/\bname\b/, ['name']],
  [/\b(?:where i live|home|city|address|hometown)\b/, ['home_city']],
  [/\b(?:where i am|location)\b/, ['current_location']],
  [/\b(?:work|job|employer|company|career)\b/, ['employer', 'job_title', 'current_project']],
  [/\bproject\b/, ['current_project']],
  [/\b(?:diet|vegetarian|vegan|pescatarian)\b/, ['diet']],
  [/\ballerg/, ['allergy']],
  [/\b(?:health|medical|condition)/, ['health_condition', 'allergy']],
  [/\b(?:likes?|interests?|hobbies|preferences?)\b/, ['likes', 'dislikes']],
  [/\bbirthday\b/, ['birthday']],
  [/\b(?:phone|mobile)\b/, ['phone']],
  [/\be-?mail\b/, ['email']],
  [/\blanguages?\b/, ['languages']],
];

function interpretForget(rest, ctx) {
  const rel = rest.match(new RegExp(`^(?:everything (?:about|on) )?my\\s+(${REL})(?:\\s+[\\p{L}'-]+)?$`, 'iu'));
  if (rel) return { kind: 'forget', target: { type: 'subject', subject: rel[1].toLowerCase() } };
  const st = statements(rest.replace(/^that\s+/i, ''), ctx);
  if (st.candidates.length) return { kind: 'forget', target: { type: 'values', candidates: st.candidates } };
  for (const [re, keys] of SLOT_WORDS) {
    if (re.test(rest.toLowerCase())) return { kind: 'forget', target: { type: 'slots', subject: 'user', keys } };
  }
  return { kind: 'forget', target: { type: 'unknown', text: rest } };
}

// ---- questions ---------------------------------------------------------------
const Q_USER = [
  [/where (?:do|did) i (?:live|stay|reside)|what(?:'s| is) my (?:home ?town|city|home city)|which city (?:do i|am i)|where am i (?:living|based)|where is my home/, 'home_city'],
  [/where am i(?: right now| today| currently| now)?$/, 'current_location'],
  [/where do i work|who do i work for|what(?:'s| is) my (?:employer|company)|which company/, 'employer'],
  [/what do i do(?: for (?:a )?(?:living|work))?$|what(?:'s| is) my (?:job|role|title|profession)/, 'job_title'],
  [/what(?:'s| is) my name|who am i|what do you call me|what should you call me/, 'name'],
  [/what(?:'s| is) my diet|what (?:do|can|should) i eat|am i (?:a )?(?:vegetarian|vegan|pescatarian)|do i (?:eat|follow)/, 'diet'],
  [/am i allergic|what am i allergic to|do i have (?:any )?allergies|what are my allergies/, 'allergy'],
  [/what (?:health|medical) conditions|do i have any (?:health|medical)/, 'health_condition'],
  [/what do i (?:like|love|enjoy)|what are my (?:interests|hobbies)/, 'likes'],
  [/what do i (?:hate|dislike)/, 'dislikes'],
  [/what languages do i speak|which languages/, 'languages'],
  [/when(?:'s| is) my birthday/, 'birthday'],
  [/what am i (?:working on|building)/, 'current_project'],
  [/what(?:'s| is) my (?:phone|mobile)/, 'phone'],
  [/what(?:'s| is) my e-?mail/, 'email'],
];

function interpretQuestion(s) {
  const low = s.toLowerCase().replace(/[?]+$/, '').trim();
  let m = low.match(new RegExp(`where does my (${REL})(?:\\s+[\\p{L}'-]+)? (?:live|stay)`, 'u'));
  if (m) return { kind: 'question', subject: m[1], key: 'home_city' };
  m = low.match(new RegExp(`where does my (${REL})(?:\\s+[\\p{L}'-]+)? work`, 'u'));
  if (m) return { kind: 'question', subject: m[1], key: 'employer' };
  m = low.match(new RegExp(`what(?:'s| is) my (${REL})(?:'s)?(?: name| called| named)?$|what is my (${REL}) (?:called|named)`, 'u'));
  if (m) return { kind: 'question', subject: m[1] || m[2], key: 'name' };
  for (const [re, key] of Q_USER) if (re.test(low)) return { kind: 'question', subject: 'user', key };
  return null;
}

// ---- tasks (things the agent does using memory) ----------------------------------
function interpretTask(s) {
  const low = s.toLowerCase();
  if (/\b(?:recommend|suggest|idea|find me|pick|where (?:should|can|could) i|book)\b/.test(low) && /\b(?:restaurant|dinner|lunch|place to eat|somewhere to eat|food|eat)\b/.test(low)) return { kind: 'task', task: 'food' };
  if (/\b(?:weekend|things to do|activities|what should i do|plan (?:my|a) (?:day|weekend|trip))\b/.test(low)) return { kind: 'task', task: 'local' };
  if (/\b(?:draft|write|compose)\b/.test(low) && /\b(?:email|intro|introduction|message|bio)\b/.test(low)) return { kind: 'task', task: 'email' };
  return null;
}

// ---- statements -------------------------------------------------------------
const NOT_PLACE = /^(?:a|an|the|my|your|our|his|her|no|not|so|too|very|trouble|love|bed|charge|need|between|over|about|good|bad|all|some|line|touch|awe|a hurry|the middle)\b/i;

function tempExpiry(tail, now) {
  const t = tail.toLowerCase();
  if (/\b(?:today|tonight|right now|at the moment|for now)\b/.test(t)) return { expiresAt: now + 2 * DAY };
  if (/\b(?:week|weekend|few days|couple of days|until|till)\b/.test(t)) return { expiresAt: now + 7 * DAY };
  if (/\bmonth\b/.test(t)) return { expiresAt: now + 30 * DAY };
  return {};
}

const DIETS = 'vegetarian|vegan|pescatarian|pescetarian|gluten[- ]free|halal|kosher|keto';
const normDiet = (d) => d.toLowerCase().replace(/\s+/g, '-').replace('pescetarian', 'pescatarian');

export function statements(sentence, { now = Date.now() } = {}) {
  let s = tidy(sentence);
  let correction = false;
  const lead = s.match(LEAD_CORRECTION);
  if (lead && s.length > lead[0].length) { s = s.slice(lead[0].length); correction = true; }
  const hedged = HEDGE.test(s);
  if (INLINE_CHANGE.test(s)) correction = true;

  const user = (key, value, extra = {}) => ({ subject: 'user', key, value, op: 'assert', hedged, correction, source: { type: 'user_stated', quote: sentence }, ...extra });
  const about = (subject, key, value, extra = {}) => ({ subject, key, value, op: 'assert', hedged, correction: false, source: { type: 'user_stated', quote: sentence }, ...extra });
  const out = [];
  let m;

  // -- other people and pets
  m = s.match(new RegExp(`\\bmy\\s+(${REL})(?:\\s+(?!(?:lives|is|works|stays|was|has|name)\\b)([\\p{L}'-]+))?\\s+(?:lives|is living|is based|stays)\\s+in\\s+(.+)$`, 'iu'));
  if (m) {
    const rel = m[1].toLowerCase();
    if (m[2]) out.push(about(rel, 'name', smartCase(tidy(m[2]))));
    out.push(about(rel, 'home_city', smartCase(tidy(cutTail(m[3])))));
  }
  m = s.match(new RegExp(`\\bmy\\s+(${REL})(?:\\s+name)?\\s+(?:is\\s+)?(?:called|named)\\s+([\\p{L}'-]+)`, 'iu'));
  if (m) out.push(about(m[1].toLowerCase(), 'name', smartCase(tidy(m[2]))));
  m = s.match(new RegExp(`\\bmy\\s+(${REL})(?:\\s+(?!(?:works)\\b)[\\p{L}'-]+)?\\s+works\\s+(?:at|for)\\s+(.+)$`, 'iu'));
  if (m) out.push(about(m[1].toLowerCase(), 'employer', smartCase(tidy(cutTail(m[2])))));
  if (out.length) return { candidates: out, correction, hedged };

  // -- name
  m = s.match(/\b(?:my name is|call me|i(?:'m| am) called)\s+([\p{L}'-]+(?:\s+[\p{L}'-]+)?)/iu);
  if (m) {
    const v = tidy(m[1].replace(/\s+(?:please|now|instead|from now on)\b.*$/i, ''));
    if (v) out.push(user('name', smartCase(v)));
  }

  // -- where I live
  m = s.match(/\bi(?:'ve| have)?\s+(?:just\s+|recently\s+)?(?:moved|relocated)\s+to\s+(.+)$/i);
  if (m) out.push(user('home_city', smartCase(tidy(cutTail(m[1]))), { correction: true }));
  else {
    m = s.match(/\bi(?:'m| am)?\s+(?:now\s+|currently\s+)?(?:live|living|based|stay|staying|reside|residing)\s+(?:in|at)\s+(.+)$/i);
    if (m && !/\b(?:in|at)\s+(?:a|an|the|my)\b/i.test(m[0])) out.push(user('home_city', smartCase(tidy(cutTail(m[1])))));
  }

  // -- where I am right now (temporary)
  m = s.match(/\bi(?:'m| am)\s+(?:currently\s+|just\s+)?(?:in|visiting|staying in)\s+(.+)$/i);
  if (m && !out.some((c) => c.key === 'home_city')) {
    const raw = tidy(m[1]);
    const place = tidy(raw.replace(/\s*(?:for\s+(?:the|a)\s+(?:week|weekend|few days|couple of days|day|month)|this (?:week|weekend|month)|until\s+\w+|till\s+\w+|today|tonight|tomorrow|for now|right now|at the moment)\b.*$/i, ''));
    if (place && !NOT_PLACE.test(place) && place.split(' ').length <= 3) {
      out.push(user('current_location', smartCase(place), tempExpiry(raw, now)));
    }
  }

  // -- work: leaving, joining, being
  m = s.match(/\bi\s+(?:no longer work(?:ing)?\s+(?:at|for)|(?:left|quit))\s+(?!my job\b|the job\b)(.+)$/i)
    || s.match(/\bi\s+(?:don'?t|do not)\s+work\s+(?:at|for)\s+(.+?)\s+(?:anymore|any more)$/i);
  if (m) out.push(user('employer', smartCase(tidy(cutTail(m[1]))), { op: 'retract' }));
  else if (/\bi\s+(?:quit|left)\s+(?:my|the)\s+job\b/i.test(s)) out.push(user('employer', null, { op: 'retract' }));
  else {
    m = s.match(/\bi\s+(?:just\s+|recently\s+)?(?:joined|started\s+(?:working\s+)?(?:at|for))\s+(.+)$/i);
    if (m) out.push(user('employer', smartCase(tidy(cutTail(m[1]))), { correction: true }));
    else {
      m = s.match(/\bi(?:'m| am)?\s*(?:now\s+|currently\s+)?(?:work|working)\s+(?:at|for)\s+(.+)$/i);
      if (m) {
        const [emp, title] = m[1].split(/\s+as\s+(?:an?\s+)?/i);
        out.push(user('employer', smartCase(tidy(cutTail(emp)))));
        if (title) out.push(user('job_title', tidy(cutTail(title)).toLowerCase()));
      }
    }
  }
  if (!out.some((c) => c.key === 'job_title')) {
    m = s.match(/\bi\s+work\s+as\s+(?:an?\s+)?(.+)$/i) || s.match(/\bmy job is\s+(?:being\s+)?(?:an?\s+)?(.+)$/i)
      || s.match(/\bi(?:'m| am)\s+an?\s+((?:[\w-]+\s+){0,2}?(?:engineer|developer|designer|teacher|nurse|doctor|student|lawyer|writer|manager|researcher|founder|scientist|accountant|chef|photographer|analyst|consultant|architect|artist|musician))\b/i);
    if (m) out.push(user('job_title', tidy(cutTail(m[1])).toLowerCase()));
  }

  // -- diet: negations first
  m = s.match(new RegExp(`\\bi(?:'m| am)\\s+(?:no longer|not)\\s+(?:a\\s+)?(${DIETS})\\b`, 'i'))
    || s.match(new RegExp(`\\bi\\s+(?:stopped|quit|gave up)\\s+being\\s+(${DIETS})\\b`, 'i'));
  if (m) out.push(user('diet', normDiet(m[1]), { op: 'retract' }));
  else if (/\bi\s+eat\s+meat\s+again\b/i.test(s)) out.push(user('diet', null, { op: 'retract' }));
  else {
    m = s.match(new RegExp(`\\bi(?:'m| am)\\s+(?:now\\s+)?(${DIETS})\\b`, 'i')) || s.match(new RegExp(`\\bi\\s+(?:eat|follow)\\s+(?:a\\s+)?(${DIETS})(?:\\s+diet)?\\b`, 'i'));
    if (m) out.push(user('diet', normDiet(m[1])));
    else if (/\bi\s+(?:don'?t|do not)\s+eat\s+(?:any\s+)?meat\b/i.test(s)) out.push(user('diet', 'vegetarian'));
  }

  // -- allergies and health (sensitive)
  m = s.match(/\bi(?:'m| am)\s+(?:no longer|not)\s+(?:actually\s+)?allergic\s+to\s+(.+?)(?:\s+(?:anymore|any more))?$/i) || s.match(/\bi(?:'ve| have)?\s+outgrown\s+(?:my\s+)?(.+?)\s+allergy/i);
  if (m) splitList(m[1]).forEach((v) => out.push(user('allergy', v.toLowerCase(), { op: 'retract' })));
  else {
    m = s.match(/\bi(?:'m| am)\s+(?:severely\s+|very\s+|deathly\s+|also\s+)?allergic\s+to\s+(.+)$/i) || s.match(/\bi\s+have\s+(?:an?\s+)?(.+?)\s+allergy\b/i);
    if (m) splitList(m[1].replace(/\s+(?:but|because|since|so|though)\b.*$/i, '')).forEach((v) => out.push(user('allergy', v.toLowerCase())));
  }
  m = s.match(/\bi\s+(?:have|was diagnosed with|suffer from)\s+(?:type\s*[12]\s+)?(diabetes|asthma|migraines?|anxiety|depression|adhd|epilepsy|hypertension|celiac disease|arthritis)\b/i);
  if (m) out.push(user('health_condition', m[1].toLowerCase()));

  // -- preferences, languages, project, birthday, contact
  m = s.match(/\bi\s+(?:really\s+)?(?:hate|dislike|can'?t stand|don'?t like)\s+(.+)$/i);
  if (m && !/^(?:it|that|this|when|how|you)\b/i.test(m[1])) splitList(cutTail(m[1])).forEach((v) => out.push(user('dislikes', v.toLowerCase())));
  else {
    m = s.match(/\bi\s+(?:really\s+|absolutely\s+|just\s+)?(?:like|love|enjoy|adore)\s+(.+)$/i) || s.match(/\bi(?:'m| am)\s+into\s+(.+)$/i);
    if (m && !/^(?:it|that|this|when|how|you|the way)\b/i.test(m[1])) splitList(cutTail(m[1])).forEach((v) => out.push(user('likes', v.toLowerCase())));
  }
  m = s.match(/\bi\s+speak\s+(.+)$/i);
  if (m) splitList(cutTail(m[1])).forEach((v) => out.push(user('languages', smartCase(v))));
  m = s.match(/\bi(?:'m| am)\s+(?:currently\s+)?(?:working on|building|writing|studying|learning|developing)\s+(.+)$/i);
  if (m) out.push(user('current_project', tidy(cutTail(m[1]))));
  m = s.match(/\bmy birthday\s+(?:is|falls)\s+(?:on\s+)?(.+)$/i);
  if (m) out.push(user('birthday', tidy(m[1])));
  m = s.match(/\bmy\s+(?:phone|mobile|cell)(?:\s+number)?\s+is\s+(\+?[\d][\d\s().-]{5,})/i);
  if (m) out.push(user('phone', tidy(m[1])));
  m = s.match(/\bmy\s+e-?mail(?:\s+address)?\s+is\s+(\S+@\S+)/i);
  if (m) out.push(user('email', tidy(m[1])));

  // -- inference (only when the user said nothing explicit in this sentence)
  if (!out.length) {
    m = s.match(/\bi\s+(?:just\s+)?(?:had|ate|ordered|cooked|made|grabbed)\s+(?:an?\s+|the\s+|some\s+|my\s+)?(veggie|vegan|plant[- ]based|vegetarian)\b/i);
    if (m) out.push({ subject: 'user', key: 'diet', value: 'vegetarian', op: 'assert', hedged: false, correction: false, baseOverride: 0.35, source: { type: 'inferred', quote: sentence } });
    m = s.match(/\bit(?:'s| is)\s+(?:so\s+|really\s+)?(?:raining|snowing|sunny|freezing|hot|cold|foggy|windy)\s+(?:again\s+)?in\s+(.+)$/i);
    if (m) out.push({ subject: 'user', key: 'home_city', value: smartCase(tidy(cutTail(m[1]))), op: 'assert', hedged: false, correction: false, baseOverride: 0.3, source: { type: 'inferred', quote: sentence } });
  }

  return { candidates: out, correction, hedged };
}

// ---- entry point ---------------------------------------------------------------
export function interpret(raw, ctx = {}) {
  let s = raw.trim().replace(/\s+/g, ' ').replace(/\s+please$/i, '');
  if (!s) return { kind: 'other' };
  let m;

  if (/^(?:please\s+)?(?:forget|delete|erase|wipe|clear)\s+(?:absolutely\s+)?(?:everything|all)(?:\s+(?:about me|you know|you remember|of it))?$/i.test(s)) return { kind: 'forget_all' };
  if (/^(?:please\s+)?(?:forget|delete|erase)\s+(?:everything|all|what|the)\s+(?:that\s+)?(?:you\s+)?(?:guessed|inferred|assumed|guesses|inferences)/i.test(s)) return { kind: 'forget_inferred' };
  if (/\b(?:stop|don'?t|do not)\s+(?:guess|guessing|infer|inferring|assum\w+)\b/i.test(s)) return { kind: 'settings', allowInference: false };
  if (/^(?:you can|feel free to|allow|enable|resume)\s+(?:guess|guessing|infer|inferring|inferences?)/i.test(s)) return { kind: 'settings', allowInference: true };
  m = s.match(/^(?:please\s+)?(?:forget|delete|erase|remove)\s+(.+)$/i);
  if (m) return interpretForget(m[1], ctx);

  if (/what do you (?:remember|know|store|have) (?:about|on) me|what have you (?:stored|saved|remembered)|show (?:me )?(?:my )?(?:memories|memory)|what(?:'s| is) in (?:my )?memory|memory inspector/i.test(s)) return { kind: 'inspect' };

  if (/^(?:that'?s|this is|it'?s|that is)\s+(?:wrong|incorrect|not right|not true|false|outdated|out of date)\b|^(?:wrong|incorrect)\b/i.test(s)) return { kind: 'wrong' };
  if (/^(?:no|nope|nah|not anymore|not any more|not really|that'?s not (?:right|true|correct)|not true)$/i.test(s)) return { kind: 'no' };
  const yes = /^(?:yes|yeah|yep|yup|sure|correct|right|exactly|that'?s (?:right|correct|true)|still (?:true|right|correct)|it is|i do)\b[,.! ]*/i;
  if (yes.test(s)) {
    const rest = s.replace(yes, '');
    if (!rest) return { kind: 'yes' };
    s = rest;
  }

  const task = interpretTask(s);
  if (task) return task;
  if (/^(?:what|where|who|when|which|how|am i|do i|did i|is my|are my|can you tell me|tell me)\b/i.test(s) || /\?$/.test(s)) {
    const q = interpretQuestion(s);
    if (q) return q;
  }
  const st = statements(s, ctx);
  if (st.candidates.length) return { kind: 'statement', candidates: st.candidates, correction: st.correction, hedged: st.hedged };
  return { kind: 'other', text: s };
}
