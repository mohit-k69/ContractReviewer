import { FactWithEvidence } from './types';

/**
 * Lightweight, deterministic comparison of two FOUND facts about the same topic.
 *
 * Different wording is never a conflict by itself. Two facts are only compared
 * when their topic has a comparable value (a duration, a place, or a date) AND
 * they describe the same situation (e.g. both are late-payment terms, or both
 * are cure periods for a material breach). Then:
 *   - overlapping values        -> COMPATIBLE
 *   - disjoint values           -> CONFLICT
 *   - cannot tell confidently   -> UNCERTAIN (reported as AMBIGUOUS)
 * Every other topic is treated as COMPATIBLE, so provisions covering different
 * aspects (source code vs. documentation, different obligations, different IP
 * aspects) are kept together instead of being flagged.
 */
export type FactRelation =
  | { kind: 'COMPATIBLE' }
  | { kind: 'CONFLICT'; detail: string }
  | { kind: 'UNCERTAIN'; detail: string };

type ValueKind = 'duration' | 'place' | 'date' | 'amount' | 'taxbasis';

const TOPIC_VALUE_KIND: Record<string, ValueKind> = {
  'Payment Terms': 'duration',
  'Termination for Convenience': 'duration',
  'Termination for Cause': 'duration',
  'Confidentiality Duration': 'duration',
  'Term Duration': 'duration',
  'Governing Jurisdiction': 'place',
  'Venue & Forum': 'place',
  'Effective Date': 'date',
  'Execution Date': 'date',
  'Commencement Date': 'date',
  'Expiration Date': 'date',
  // Contractor-intelligence topics
  'Breach Notification': 'duration',
  'Renewal Duration': 'duration',
  'Non-Renewal Notice': 'duration',
  'Warranty Duration': 'duration',
  'Rates & Amounts': 'amount',
  'Minimum Insurance Coverage': 'amount',
  'Amounts Tax Basis': 'taxbasis',
};

// ---------------------------------------------------------------------------
// Value extraction
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  twelve: 12, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45,
  sixty: 60, ninety: 90,
};
const NUMBER_WORD_PATTERN = Object.keys(NUMBER_WORDS).join('|');

/** Returns normalized values like "15 days", "10 business days", "2 years". */
export function extractDurations(text: string): Set<string> {
  let t = text.toLowerCase();
  // "thirty (30) days" -> "30 days"; "(30) days" -> "30 days"
  t = t.replace(new RegExp(`\\b(?:${NUMBER_WORD_PATTERN})\\s*\\((\\d+)\\)`, 'g'), '$1');
  t = t.replace(/\((\d+)\)/g, '$1');

  const out = new Set<string>();
  const re = new RegExp(
    `\\b(\\d+(?:\\.\\d+)?|${NUMBER_WORD_PATTERN})[\\s-]*(business\\s+|working\\s+|calendar\\s+)?(hour|day|week|month|year)s?\\b`,
    'g'
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const n = /^\d/.test(m[1]) ? parseFloat(m[1]) : NUMBER_WORDS[m[1]];
    const business = !!m[2] && /business|working/.test(m[2]);
    const unit = m[3];
    if (unit === 'hour') out.add(`${n} hours`);
    else if (unit === 'day') out.add(`${n} ${business ? 'business days' : 'days'}`);
    else if (unit === 'week') out.add(business ? `${n * 5} business days` : `${n * 7} days`);
    else if (unit === 'month') out.add(`${n} months`);
    else out.add(`${n} years`);
  }
  // "Net 30"
  const net = /\bnet[\s-]*(\d+)\b/g;
  while ((m = net.exec(t)) !== null) out.add(`${parseFloat(m[1])} days`);
  return out;
}

const PLACES: Array<[string, string]> = [
  ...[
    'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware',
    'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky',
    'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
    'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico',
    'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania',
    'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont',
    'virginia', 'west virginia', 'washington', 'wisconsin', 'wyoming',
  ].map((s): [string, string] => [s, s]),
  ['district of columbia', 'district of columbia'],
  ['washington, d.c.', 'district of columbia'],
  ['england and wales', 'england'],
  ['england', 'england'],
  ['united kingdom', 'united kingdom'],
  ['canada', 'canada'],
  ['ontario', 'ontario'],
  ['british columbia', 'british columbia'],
  ['india', 'india'],
  ['germany', 'germany'],
  ['france', 'france'],
  ['ireland', 'ireland'],
  ['singapore', 'singapore'],
  ['australia', 'australia'],
  ['new south wales', 'new south wales'],
  ['hong kong', 'hong kong'],
  ['switzerland', 'switzerland'],
];
// Longest names first so "west virginia" is matched before "virginia".
const PLACES_BY_LENGTH = [...PLACES].sort((a, b) => b[0].length - a[0].length);

export function extractPlaces(text: string): Set<string> {
  let t = ` ${text.toLowerCase()} `;
  const out = new Set<string>();
  for (const [name, canonical] of PLACES_BY_LENGTH) {
    const re = new RegExp(`(?<![a-z])${name.replace(/[.]/g, '\\.')}(?![a-z])`, 'g');
    if (re.test(t)) {
      out.add(canonical);
      t = t.replace(re, ' ');
    }
  }
  return out;
}


/**
 * Money amounts, normalised to "<number> <unit>" where unit is one of
 * "per hour" | "per day" | "per week" | "per month" | "fixed" | "amount".
 * "$2 million" -> "2000000 amount"; "$85.00 per hour" -> "85 per hour".
 */
export function extractAmounts(text: string): Set<string> {
  const t = text.toLowerCase();
  const out = new Set<string>();
  const re = /(?:\$|usd\s?|eur\s?|gbp\s?|£|€)\s?(\d[\d,]*(?:\.\d+)?)\s?(million|mm|m\b|billion|thousand|k\b)?(?:\s*(?:\/|per|an?|each)\s*(hour|hr|day|week|month|year))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    let n = parseFloat(m[1].replace(/,/g, ''));
    const mult = m[2];
    if (mult === 'million' || mult === 'mm' || mult === 'm') n *= 1_000_000;
    else if (mult === 'billion') n *= 1_000_000_000;
    else if (mult === 'thousand' || mult === 'k') n *= 1_000;
    let unit = 'amount';
    if (m[3]) unit = m[3] === 'hr' ? 'per hour' : `per ${m[3]}`;
    else {
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + 20);
      const before = t.slice(Math.max(0, m.index - 30), m.index);
      if (/^\s*(hourly|an hour)/.test(after)) unit = 'per hour';
      else if (/(fixed|flat|lump[- ]sum)\s+(fee|price|amount|rate)\s*(of|:)?\s*$/.test(before)) unit = 'fixed';
    }
    out.add(`${n} ${unit}`);
  }
  return out;
}

/** "inclusive" / "exclusive" statements about whether amounts include taxes. */
export function extractTaxBasis(text: string): Set<string> {
  const t = text.toLowerCase();
  const out = new Set<string>();
  if (/(inclusive of|including)\s+(all\s+)?(applicable\s+)?(taxes|vat|gst|sales tax)|taxes?\s+(are|is|shall be)\s+included|all[- ]inclusive/.test(t)) out.add('inclusive');
  if (/(exclusive of|exclud(e|es|ing)|plus|net of|before)\s+(all\s+)?(applicable\s+)?(taxes|vat|gst|sales tax)|taxes?\s+(are|is|shall be)\s+(excluded|additional|extra)|(vat|gst|sales tax)\s+(will|shall)\s+be\s+(added|charged|invoiced)/.test(t)) out.add('exclusive');
  return out;
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december',
];
const MONTH_PATTERN = MONTHS.join('|');

function isoDate(y: string, m: number, d: string): string {
  return `${y}-${String(m).padStart(2, '0')}-${d.padStart(2, '0')}`;
}

export function extractDates(text: string): Set<string> {
  const t = text.toLowerCase();
  const out = new Set<string>();
  let m: RegExpExecArray | null;

  const mdy = new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'g');
  while ((m = mdy.exec(t)) !== null) out.add(isoDate(m[3], MONTHS.indexOf(m[1]) + 1, m[2]));

  const dmy = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_PATTERN}),?\\s+(\\d{4})\\b`, 'g');
  while ((m = dmy.exec(t)) !== null) out.add(isoDate(m[3], MONTHS.indexOf(m[2]) + 1, m[1]));

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = iso.exec(t)) !== null) out.add(`${m[1]}-${m[2]}-${m[3]}`);
  return out;
}

// ---------------------------------------------------------------------------
// Situation matching: "do these two facts describe the same circumstance?"
// ---------------------------------------------------------------------------

type Family = Array<[label: string, pattern: RegExp]>;

const PAYMENT_EVENT: Family = [
  ['late', /\b(late|overdue|past[- ]due|delinquen\w*|interest)\b/],
  ['deposit', /\b(deposit|advance|up-?front|retainer)\b/],
  ['milestone', /\bmilestone/],
  ['final', /\bfinal (invoice|payment)/],
  ['expenses', /\b(expense|reimburs\w*)\b/],
];
const PHASE: Family = [
  ['cure', /\b(cure|cured|remed(y|ied|ies)|rectif\w*)\b/],
  ['notice', /\bnotice\b/],
];
const BREACH_TYPE: Family = [
  ['payment', /\b(non-?payment|failure to pay|unpaid|payment default)\b/],
  ['confidentiality', /\b(confidential\w*|disclos\w*)\b/],
  ['material', /\bmaterial\b/],
];
const PARTY: Family = [
  ['either', /\b(either|each|both) part(y|ies)\b/],
  ['client', /\b(client|customer|company)\b/],
  ['contractor', /\b(contractor|consultant|freelancer|service provider)\b/],
];

const RATE_QUALIFIER: Family = [
  ['overtime', /\b(overtime|after[- ]hours|weekend|holiday|rush|expedit\w*|premium|surcharge)\b/],
  ['travel', /\b(travel|mileage|per diem|expenses?)\b/],
  ['role', /\b(senior|junior|principal|lead|associate|designer|developer|engineer|analyst|consultant|project manager)\b/],
  ['additional', /\b(additional|extra|out[- ]of[- ]scope|change order)\b/],
];
const INSURANCE_TYPE: Family = [
  ['professional', /\b(professional|errors?\s*(and|&)\s*omissions|e\s*&\s*o)\b/],
  ['general', /\b(general|public)\s+liability\b|\bcgl\b/],
  ['cyber', /\bcyber\b/],
];

const TOPIC_SITUATION_FAMILIES: Record<string, Family[]> = {
  'Rates & Amounts': [RATE_QUALIFIER],
  'Minimum Insurance Coverage': [INSURANCE_TYPE],
  'Payment Terms': [PAYMENT_EVENT],
  'Termination for Convenience': [PHASE, PARTY],
  'Termination for Cause': [PHASE, BREACH_TYPE, PARTY],
};

function labelsFor(family: Family, text: string): Set<string> {
  const labels = new Set<string>();
  for (const [label, pattern] of family) {
    if (pattern.test(text)) labels.add(label);
  }
  // A cure period is not also an ordinary notice period.
  if (labels.has('cure')) labels.delete('notice');
  return labels;
}

// Situations that are clearly separate events from the ordinary case (e.g. an
// overdue-interest period is not the invoice payment period). Other specific
// labels (milestone, deposit, ...) may be overrides of a general rule, so a
// general-vs-specific pair stays UNCLEAR.
const DISTINCT_LABELS = new Set(['late', 'expenses', 'overtime', 'travel', 'additional']);

type SituationRelation = 'SAME' | 'DIFFERENT' | 'UNCLEAR';

function compareSituation(topic: string, textA: string, textB: string): SituationRelation {
  const families = TOPIC_SITUATION_FAMILIES[topic] || [];
  let unclear = false;
  for (const family of families) {
    const a = labelsFor(family, textA);
    const b = labelsFor(family, textB);
    if (a.size === 0 && b.size === 0) continue;
    if (a.size === 0 || b.size === 0) {
      const labelled = a.size === 0 ? b : a;
      if ([...labelled].some((l) => DISTINCT_LABELS.has(l))) return 'DIFFERENT';
      unclear = true; // one fact names a specific situation, the other does not
      continue;
    }
    const overlap = [...a].some((l) => b.has(l));
    const sameSet = a.size === b.size && overlap && [...a].every((l) => b.has(l));
    if (sameSet) continue;
    if (!overlap && !a.has('either') && !b.has('either')) return 'DIFFERENT';
    unclear = true;
  }
  return unclear ? 'UNCLEAR' : 'SAME';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function quotesOf(fact: FactWithEvidence): string {
  return (fact.evidence || []).map((e) => e.exact_quote || '').join(' ');
}

function valuesFor(kind: ValueKind, fact: FactWithEvidence): Set<string> {
  const extract =
    kind === 'duration' ? extractDurations
    : kind === 'place' ? extractPlaces
    : kind === 'amount' ? extractAmounts
    : kind === 'taxbasis' ? extractTaxBasis
    : extractDates;
  const fromSummary = extract(fact.summary || '');
  // Prefer the model's summary; fall back to the quoted source text.
  return fromSummary.size > 0 ? fromSummary : extract(quotesOf(fact));
}

function describe(values: Set<string>): string {
  return [...values].sort().join(', ');
}

/**
 * Decides whether two FOUND facts for the same topic are compatible,
 * genuinely incompatible, or cannot be confidently related.
 */
export function compareFoundFacts(
  topic: string,
  a: FactWithEvidence,
  b: FactWithEvidence
): FactRelation {
  const kind = TOPIC_VALUE_KIND[topic];
  if (!kind) return { kind: 'COMPATIBLE' };

  const valsA = valuesFor(kind, a);
  const valsB = valuesFor(kind, b);

  if (valsA.size === 0 && valsB.size === 0) return { kind: 'COMPATIBLE' };
  if (valsA.size === 0 || valsB.size === 0) {
    return {
      kind: 'UNCERTAIN',
      detail: 'only one provision states a comparable value, so the relationship cannot be established',
    };
  }

  // Same-situation check (uses summary + quoted source text).
  const situation = compareSituation(
    topic,
    `${a.summary} ${quotesOf(a)}`.toLowerCase(),
    `${b.summary} ${quotesOf(b)}`.toLowerCase()
  );
  if (situation === 'DIFFERENT') return { kind: 'COMPATIBLE' };

  // Values: compare only like with like (days with days, months with months, ...).
  let shared = false;
  let overlap = false;
  if (kind === 'duration' || kind === 'amount') {
    const unitOf = (v: string) => v.slice(v.indexOf(' ') + 1);
    const unitsA = new Set([...valsA].map(unitOf));
    const sharedUnits = [...new Set([...valsB].map(unitOf))].filter((u) => unitsA.has(u));
    shared = sharedUnits.length > 0;
    overlap = [...valsA].some((v) => valsB.has(v));
    if (!shared) {
      return {
        kind: 'UNCERTAIN',
        detail: `values use different units (${describe(valsA)} vs ${describe(valsB)}) and cannot be compared`,
      };
    }
  } else {
    shared = true;
    overlap = [...valsA].some((v) => valsB.has(v));
  }

  if (overlap) return { kind: 'COMPATIBLE' };

  const detail = `incompatible values: ${describe(valsA)} vs ${describe(valsB)}`;
  if (situation === 'UNCLEAR') {
    return {
      kind: 'UNCERTAIN',
      detail: `values differ (${describe(valsA)} vs ${describe(valsB)}) but it is not clear the provisions apply to the same situation`,
    };
  }
  return { kind: 'CONFLICT', detail };
}
