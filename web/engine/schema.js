// Shared constants and the slot registry. Every fact lives in a "slot"
// (subject + key). The slot decides how fast the fact goes stale, how many
// values it may hold, and how carefully it is handled.

export const DAY = 86_400_000;

// Effective-confidence bands. These drive *behaviour*, not just display.
export const BANDS = { CONFIDENT: 0.75, HEDGE: 0.5, VERIFY: 0.25 };

export const DORMANT_GRACE_DAYS = 45; // faded memory is erased this long after it drops below VERIFY
export const SUPERSEDED_RETENTION_DAYS = 30; // replaced values are kept briefly (audit / undo), then erased

export const SOURCE_BASE = { user_confirmed: 0.97, user_stated: 0.9, inferred: 0.4 };
export const HEDGE_FACTOR = 0.65; // "I think...", "maybe..."
export const CONTEST_FACTOR = 0.6; // both sides of an unresolved contradiction
export const REINFORCE_STEP = 0.6; // base' = 1 - (1 - base) * step
export const INFERRED_HALF_LIFE_FACTOR = 0.25; // guesses fade 4x faster than statements

export const SLOTS = {
  name: { label: 'name', cardinality: 'single', halfLifeDays: 7300, sensitivity: 'normal', context: 'personal' },
  home_city: { label: 'home city', cardinality: 'single', halfLifeDays: 540, sensitivity: 'normal', context: 'personal' },
  current_location: { label: 'current location', cardinality: 'single', halfLifeDays: 3, sensitivity: 'normal', context: 'personal' },
  employer: { label: 'employer', cardinality: 'single', halfLifeDays: 420, sensitivity: 'normal', context: 'work' },
  job_title: { label: 'job title', cardinality: 'single', halfLifeDays: 420, sensitivity: 'normal', context: 'work' },
  current_project: { label: 'current project', cardinality: 'single', halfLifeDays: 21, sensitivity: 'normal', context: 'work' },
  diet: { label: 'diet', cardinality: 'single', halfLifeDays: 720, sensitivity: 'normal', context: 'health' },
  allergy: { label: 'allergies', cardinality: 'multi', halfLifeDays: 3650, sensitivity: 'sensitive', context: 'health', safetyCritical: true, neverInfer: true },
  health_condition: { label: 'health conditions', cardinality: 'multi', halfLifeDays: 1825, sensitivity: 'sensitive', context: 'health', neverInfer: true },
  likes: { label: 'likes', cardinality: 'multi', halfLifeDays: 720, sensitivity: 'normal', context: 'personal' },
  dislikes: { label: 'dislikes', cardinality: 'multi', halfLifeDays: 720, sensitivity: 'normal', context: 'personal' },
  languages: { label: 'languages', cardinality: 'multi', halfLifeDays: 3650, sensitivity: 'normal', context: 'personal' },
  birthday: { label: 'birthday', cardinality: 'single', halfLifeDays: 7300, sensitivity: 'normal', context: 'personal' },
  phone: { label: 'phone number', cardinality: 'single', halfLifeDays: 1095, sensitivity: 'sensitive', context: 'personal', neverInfer: true },
  email: { label: 'email address', cardinality: 'single', halfLifeDays: 1095, sensitivity: 'sensitive', context: 'personal', neverInfer: true },
};

// Things the user can tell us about besides themselves. Facts about other
// people are treated as sensitive (they never consented to being stored);
// pets are not.
export const RELATIONS = {
  sister: 'person', brother: 'person', mom: 'person', mum: 'person', mother: 'person',
  dad: 'person', father: 'person', wife: 'person', husband: 'person', partner: 'person',
  girlfriend: 'person', boyfriend: 'person', friend: 'person', boss: 'person', manager: 'person',
  dog: 'pet', cat: 'pet',
};
export const THIRD_PARTY_KEYS = ['name', 'home_city', 'employer'];

export function slotDef(subject, key) {
  const base = SLOTS[key];
  if (!base) return null;
  if (subject === 'user') return base;
  if (!(subject in RELATIONS) || !THIRD_PARTY_KEYS.includes(key)) return null;
  const isPet = RELATIONS[subject] === 'pet';
  return { ...base, sensitivity: isPet ? 'normal' : 'sensitive', context: isPet ? 'personal' : 'third-party', neverInfer: !isPet };
}

export function norm(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!,;:]+$/, '');
}

// Tiny non-cryptographic hash so the do-not-relearn list never stores plaintext values.
export function hashValue(value) {
  let h = 5381;
  const s = norm(value);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function subjectLabel(subject) {
  return subject === 'user' ? 'you' : `your ${subject}`;
}

// Natural-language rendering of a fact, used by the agent when it speaks.
export function sayValue(subject, key, value) {
  const who = subject === 'user' ? 'you' : `your ${subject}`;
  const are = subject === 'user' ? "you're" : `your ${subject} is`;
  switch (key) {
    case 'name': return subject === 'user' ? `your name is ${value}` : `your ${subject} is called ${value}`;
    case 'home_city': return `${who} ${subject === 'user' ? 'live' : 'lives'} in ${value}`;
    case 'current_location': return `you're in ${value} right now`;
    case 'employer': return `${who} ${subject === 'user' ? 'work' : 'works'} at ${value}`;
    case 'job_title': return `you work as ${/^[aeiou]/i.test(value) ? 'an' : 'a'} ${value}`;
    case 'current_project': return `you're working on ${value}`;
    case 'diet': return `${are} ${value}`;
    case 'allergy': return `you're allergic to ${value}`;
    case 'health_condition': return `you have ${value}`;
    case 'likes': return `you like ${value}`;
    case 'dislikes': return `you dislike ${value}`;
    case 'languages': return `you speak ${value}`;
    case 'birthday': return `your birthday is ${value}`;
    case 'phone': return `your phone number is ${value}`;
    case 'email': return `your email is ${value}`;
    default: return `${key} is ${value}`;
  }
}
