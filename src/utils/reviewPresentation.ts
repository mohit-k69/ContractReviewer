import type {
  Commitment,
  DecisionFinding,
  DecisionReport,
  ExtractedItem,
  ReportEvidence,
  Scenario,
} from '../server/decision/types';

/**
 * Turns the complete Decision Report into a short, three-page review. This is presentation only:
 *  - the full report stays in application state and is never modified;
 *  - every sentence shown comes from the report (a finding, a verified extracted fact, a question);
 *  - an extracted fact is shown only if it passes a plausibility check for what it claims to be. A value that is cut
 *    off, or is a passage about something else (for example a tax clause filed under "late payment"), is left out
 *    instead of being presented as a fact.
 */

// ---------------------------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------------------------

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
const SMALL_WORDS = new Set(['of', 'for', 'and', 'the', 'to', 'in', 'on', 'a', 'an', 'or', 'with', 'by']);

/** "2.2 Payment Due. Invoices are payable..." -> "Invoices are payable..." (a leading clause number and heading). */
export function stripHeading(text: string): string {
  const m = /^\s*(?:section\s+)?\d+(?:\.\d+)*\.?\s+((?:[A-Za-z][\w&/'’-]*\s+){0,6}[A-Za-z][\w&/'’-]*)\.\s+(?=\S)/.exec(text);
  if (!m) return text.trim();
  const words = m[1].split(/\s+/);
  const isHeading = words.every((w) => /^[A-Z0-9]/.test(w) || SMALL_WORDS.has(w.toLowerCase()));
  return isHeading ? text.slice(m[0].length).trim() : text.trim();
}

/** Drops a dangling, cut-off tail ("... valid invoice. Payment"). A short phrase such as "Net 75" is kept as it is. */
export function dropFragment(text: string): string {
  const t = norm(text);
  if (!t) return '';
  if (/[.!?”"]$/.test(t)) return t;
  const complete = /^(.*[.!?])(?:\s+[^.!?]*)?$/.exec(t);
  if (complete) return complete[1].trim();
  // A clause with a verb that stops without punctuation was cut off ("...successive terms of twelv"); a phrase such as
  // "Net 75" or "$60.00 per hour" is complete.
  if (/\b(shall|may|will|must|agrees?|is|are|has|have|provide|pay)\b/i.test(t)) return '';
  return t.length <= 80 ? t : '';
}

/** Recovers the complete sentence for a cut-off fragment from any verified quote in the report that contains it. */
export function expandFromPool(fragment: string, pool: string[]): string {
  const f = norm(fragment).replace(/…$/, '');
  if (f.length < 25) return '';
  for (const quote of pool) {
    const q = norm(quote);
    const at = q.indexOf(f);
    if (at < 0) continue;
    const m = /^.*?[.!?](?=\s|$)/.exec(q.slice(at));
    if (m) return m[0];
  }
  return '';
}

export function sentencesOf(text: string): string[] {
  return norm(text).split(/(?<=[.!?])\s+(?=[A-Z“"(])/).map((s) => s.trim()).filter(Boolean);
}

/** At most `max` characters, ending on a sentence or word boundary. */
export function shorten(text: string, max: number): string {
  const t = norm(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  if (stop > max * 0.5) return cut.slice(0, stop + 1).trim();
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:]$/, '')}…`;
}

/** The first `count` sentences, within `max` characters. */
export function firstSentences(text: string, count = 2, max = 260): string {
  const parts = sentencesOf(text);
  return shorten(parts.slice(0, count).join(' '), max);
}

/** The pieces of a stored value ("a; b" is two pieces), cleaned of headings and cut-off tails, without duplicates. */
export function piecesOf(raw: string | null | undefined, pool: string[] = []): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of raw.split(/;\s+/)) {
    const stripped = stripHeading(piece);
    const cleaned = dropFragment(stripped) || expandFromPool(stripped, pool);
    const key = cleaned.toLowerCase().slice(0, 40);
    if (cleaned && !seen.has(key)) {
      seen.add(key);
      out.push(cleaned);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Plausibility checks for extracted facts
// ---------------------------------------------------------------------------------------------------------------

type Kind =
  | 'services' | 'amount' | 'deadline' | 'trigger' | 'invoicing' | 'late' | 'expenses' | 'tax' | 'milestones'
  | 'duration' | 'renewal' | 'termination' | 'cause' | 'ending-payment' | 'law' | 'generic';

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_RX = new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2},?\\s+\\d{4}\\b|\\b\\d{1,2}\\s+${MONTH}\\.?,?\\s+\\d{4}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b`, 'i');
/** The opening sentence that names the parties. It is never a fact about scope, payment, duration or restrictions. */
const PREAMBLE = /\bby and between\b|\b(?:is|are) made (?:and entered into )?(?:effective|as of)\b|\bentered into (?:as of|by)\b|\(\s*["“]agreement["”]\s*\)/i;
const PAYMENT_WORDS = /invoice|payable|payment|net\s*\d+|\bfees?\b|compensat|\bpay\b/i;

const SPEC: Record<Kind, { rx: RegExp; reject?: RegExp; max: number }> = {
  services: { rx: /\b(provide|perform|render|deliver|develop|design|create|build|write|consult|support|services?|deliverables?)\b/i, max: 230 },
  amount: { rx: /[$€£]\s?\d|\b\d[\d,.]*\s?(?:usd|eur|gbp|inr|dollars|euros|pounds)\b|\b(?:usd|eur|gbp)\s?\d/i, max: 120 },
  deadline: { rx: /\bnet\s*\d+\b|\b\d+\s*(?:\(\d+\)\s*)?(?:business\s+|calendar\s+)?days?\b|\b[a-z]+\s*\(\d+\)\s*days?\b|\bupon\s+receipt\b|\bon\s+receipt\b/i, max: 170 },
  trigger: { rx: /approv|upon|milestone|deliver|accept|complet|hours worked|after|subject to|condition/i, max: 190 },
  invoicing: { rx: /invoice/i, max: 190 },
  late: { rx: /\blate\b|overdue|interest|penalt|past due|delay/i, reject: /indemnif|taxes/i, max: 170 },
  expenses: { rx: /expense|reimburs|out-of-pocket/i, max: 190 },
  tax: { rx: /\btax|\bvat\b|\bgst\b|withhold/i, max: 190 },
  milestones: { rx: /milestone/i, max: 190 },
  duration: { rx: /\b(?:\d+|[a-z]+(?:-[a-z]+)?)\s*(?:\(\d+\)\s*)?(?:day|week|month|year)s?\b|\buntil\b|\bperpetual|\bindefinite|\bterm of\b/i, reject: PAYMENT_WORDS, max: 190 },
  renewal: { rx: /renew|successive|evergreen/i, max: 270 },
  termination: { rx: /terminat|cancel|end this agreement/i, max: 220 },
  cause: { rx: /cause|breach|material|cure/i, max: 220 },
  'ending-payment': { rx: /pay|paid|compensat|fees/i, max: 220 },
  law: { rx: /law|jurisdiction|state of|governed/i, max: 140 },
  generic: { rx: /./, max: 210 },
};

export interface Fact {
  id: string;
  label: string;
  text: string;
  /** The agreement is vague or contradicts itself on this; shown with a plain note, never as a clean fact */
  note?: 'unclear' | 'conflicting';
  /** Verbatim wording that supports the text. Empty when no verified quote actually contains it. */
  evidence: ReportEvidence[];
}

/** Does this quote actually contain (or is it contained in) what is claimed? Prevents a heading standing in as proof. */
function supports(text: string, e: ReportEvidence, rx?: RegExp): boolean {
  const q = norm(e.exact_quote).toLowerCase();
  const t = norm(text).toLowerCase().replace(/…$/, '');
  if (!q || !t) return false;
  const head = t.slice(0, Math.min(24, t.length));
  const qHead = q.slice(0, Math.min(24, q.length));
  return q.includes(head) || t.includes(qHead) || (!!rx && rx.test(q) && (rx !== SPEC.generic.rx));
}

function pickEvidence(text: string, item: ExtractedItem, rx?: RegExp): ReportEvidence[] {
  return item.evidence.filter((e) => supports(text, e, rx)).slice(0, 3);
}

/** The part of a long sentence that is about `focus` (from the clause that mentions it onward). */
function focusOn(sentence: string, focus: RegExp): string {
  const m = focus.exec(sentence);
  if (!m || sentence.length <= 90) return sentence;
  const start = sentence.lastIndexOf(', ', m.index);
  const part = (start >= 0 ? sentence.slice(start + 2) : sentence).replace(/^(?:including|and|but)\s+/i, '').trim();
  return part.charAt(0).toUpperCase() + part.slice(1);
}

/** "...for approved hours worked." -> "For approved hours worked": the condition itself, not the whole fee sentence. */
function triggerPhrase(sentence: string): string {
  const m = /\b(?:for\s+(?:approved|accepted|completed|each)[^.,;]*|conditioned (?:up)?on[^.]*|contingent (?:up)?on[^.]*|subject to[^.]*|(?:upon|after)\s+(?:approval|acceptance|completion|delivery|receipt)[^.]*)/i.exec(sentence);
  if (!m) return sentence;
  const phrase = m[0].replace(/[.,;]$/, '').trim();
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** The best sentence of a value for a kind of fact, or null if nothing in it is plausibly that fact. */
function bestText(item: ExtractedItem, kind: Kind, pool: string[], focus?: RegExp): string | null {
  const spec = SPEC[kind];
  const candidates = [...piecesOf(item.value, pool), ...item.evidence.flatMap((e) => piecesOf(e.exact_quote, pool))];
  for (const piece of candidates) {
    for (const sentence of sentencesOf(piece)) {
      const s = dropFragment(sentence);
      if (!s || !spec.rx.test(s) || PREAMBLE.test(s)) continue;
      if (spec.reject && spec.reject.test(s) && kind !== 'duration') continue;
      if (kind === 'duration' && spec.reject!.test(s) && !/\bterm\b|effective|commenc|expire|remain|continue/i.test(s)) continue;
      let text = focus ? focusOn(s, focus) : s;
      if (kind === 'trigger') text = triggerPhrase(text);
      return shorten(text, spec.max);
    }
  }
  return null;
}

/** A fact for display, or null when the extracted value cannot be confidently tied to what it claims to be. */
export function fact(id: string, label: string, item: ExtractedItem | undefined, kind: Kind = 'generic', pool: string[] = [], focus?: RegExp): Fact | null {
  if (!item || item.status === 'not_found' || item.status === 'not_applicable') return null;
  const text = bestText(item, kind, pool, focus);
  if (!text) return null;
  const rx = SPEC[kind].rx;
  return {
    id,
    label,
    text,
    ...(item.status === 'unclear' ? { note: 'unclear' as const } : item.status === 'conflicting' ? { note: 'conflicting' as const } : {}),
    evidence: pickEvidence(text, item, rx),
  };
}

/** The date written in the agreement (for example "October 1, 2025"), taken from the sentence that states it. */
export function statedDate(item: ExtractedItem | undefined): { text: string; evidence: ReportEvidence[] } | null {
  if (!item || item.status === 'not_found') return null;
  for (const source of [item.value ?? '', ...item.evidence.map((e) => e.exact_quote)]) {
    const m = DATE_RX.exec(source);
    if (m) return { text: m[0], evidence: item.evidence.filter((e) => DATE_RX.test(e.exact_quote)).slice(0, 2) };
  }
  return null;
}

/** Every verified quotation in the report: used only to recover the complete sentence for a cut-off extracted value. */
export function evidencePool(report: DecisionReport): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    if (typeof o.exact_quote === 'string') out.push(o.exact_quote);
    for (const v of Object.values(o)) walk(v);
  };
  walk(report);
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

// ---------------------------------------------------------------------------------------------------------------
// Agreement name
// ---------------------------------------------------------------------------------------------------------------

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(' ')
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** The verified contract name from the report; otherwise the uploaded file name without its extension. */
export function agreementName(report: DecisionReport, fileName?: string): string {
  const item = report.deal.items.find((i) => i.id === 'contract.name');
  const value = norm(item?.value ?? '');
  const reliable =
    item?.status === 'explicit' &&
    item.evidence.length > 0 &&
    value.length >= 5 && value.length <= 90 &&
    value.split(' ').length <= 12 &&
    !/[.;:]$/.test(value) &&
    /agreement|contract|terms|statement of work|\bsow\b|non-disclosure|\bnda\b|proposal|engagement|letter of/i.test(value);
  if (reliable) return value === value.toUpperCase() ? titleCase(value) : value;
  const base = (fileName ?? '').replace(/\.[^.\\/]{1,5}$/, '').trim();
  return base || 'Your agreement';
}

// ---------------------------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------------------------

const CATEGORY_WEIGHT: Record<string, number> = {
  Payment: 20,
  'Liability & Indemnification': 18,
  'Intellectual Property': 18,
  'Non-Compete, Exclusivity & Non-Solicitation': 18,
  Termination: 15,
  Warranties: 10,
  Renewal: 10,
  'Scope of Work': 10,
  Tax: 9,
  'Worker Classification': 8,
  Confidentiality: 7,
  Insurance: 6,
  'Data Protection & Security': 6,
  'Dispute Resolution & Governing Law': 5,
  Subcontracting: 5,
};
const PRIORITY_WEIGHT = { high: 100, medium: 50, low: 10 } as const;
const TYPE_WEIGHT: Record<DecisionFinding['type'], number> = { contradictory: 12, risk: 10, missing: 6, ambiguous: -8 };

export function findingScore(f: DecisionFinding): number {
  return PRIORITY_WEIGHT[f.priority] + (CATEGORY_WEIGHT[f.category] ?? 4) + TYPE_WEIGHT[f.type] + (f.is_cluster_lead ? 5 : 0);
}

const byScore = (a: DecisionFinding, b: DecisionFinding): number => findingScore(b) - findingScore(a) || a.id.localeCompare(b.id);

/**
 * The 3 to 5 findings worth reading before signing: high priority first, spread over different topics (payment,
 * restrictions, IP, liability, termination...), one finding per cluster of overlapping findings.
 */
export function selectKeyFindings(findings: DecisionFinding[]): DecisionFinding[] {
  const ranked = [...findings].sort(byScore);
  const high = ranked.filter((f) => f.priority === 'high').length;
  const target = Math.min(5, Math.max(3, high));
  const picked: DecisionFinding[] = [];
  const clusters = new Set<string>();
  const perCategory = new Map<string, number>();
  const take = (f: DecisionFinding): void => {
    picked.push(f);
    clusters.add(f.cluster_id);
    perCategory.set(f.category, (perCategory.get(f.category) ?? 0) + 1);
  };
  const free = (f: DecisionFinding): boolean => !picked.includes(f) && !clusters.has(f.cluster_id);

  // 1. the most important finding of each different topic
  for (const f of ranked) {
    if (picked.length >= target) break;
    if (free(f) && !perCategory.has(f.category) && (f.priority === 'high' || (f.priority === 'medium' && f.type !== 'ambiguous'))) take(f);
  }
  // 2. then more from the same topics, up to two each
  for (const f of ranked) {
    if (picked.length >= target) break;
    if (free(f) && (perCategory.get(f.category) ?? 0) < 2 && f.priority !== 'low') take(f);
  }
  // 3. only if there still are not three, anything left
  for (const f of ranked) {
    if (picked.length >= Math.min(3, ranked.length)) break;
    if (free(f)) take(f);
  }
  return picked.sort(byScore);
}

export interface KeyFinding {
  id: string;
  heading: string;
  says: string;
  why: string;
  action: string;
  example?: string;
  evidence: ReportEvidence[];
  category: string;
}

export function presentFinding(f: DecisionFinding): KeyFinding {
  return {
    id: f.id,
    heading: f.title,
    says: f.type === 'missing' ? 'The agreement does not address this.' : firstSentences(f.contract_position.text, 2, 260),
    why: firstSentences(f.impact, 2, 260),
    action: firstSentences(f.recommended_action, 1, 260),
    ...(f.illustrative_alternative ? { example: shorten(f.illustrative_alternative, 200) } : {}),
    evidence: f.evidence,
    category: f.category,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Page 1: key terms
// ---------------------------------------------------------------------------------------------------------------

function partyName(item: ExtractedItem | undefined): Fact | null {
  if (!item || item.status === 'not_found') return null;
  const name = norm((item.value ?? '').split(' — ')[0]);
  if (!name || name.length > 80) return null;
  const evidence = item.evidence.filter((e) => norm(e.exact_quote).toLowerCase().includes(name.toLowerCase().slice(0, 20))).slice(0, 2);
  return { id: item.id, label: '', text: name, evidence };
}

export function keyTerms(report: DecisionReport, pool: string[] = evidencePool(report)): Fact[] {
  const get = (id: string): ExtractedItem | undefined => report.deal.items.find((i) => i.id === id);
  const out: Fact[] = [];

  const client = partyName(report.deal.items.find((i) => i.id.startsWith('party.client')));
  if (client) out.push({ ...client, label: 'Client' });
  const you = partyName(report.deal.items.find((i) => i.id.startsWith('party.freelancer')));
  if (you) out.push({ ...you, label: 'You' });

  const services = fact('services', 'Work', get('engagement.description'), 'services', pool);
  if (services) out.push({ ...services, text: firstSentences(services.text, 1, 170) });

  const pay = (() => {
    const item = get('money.compensation');
    if (!item || item.status === 'not_found') return null;
    const piece = piecesOf(item.value, pool).find((p) => SPEC.amount.rx.test(p));
    return piece ? { text: piece, evidence: pickEvidence(piece, item, SPEC.amount.rx) } : null;
  })();
  if (pay) out.push({ id: 'pay', label: 'Pay', ...pay });
  else if (get('money.compensation')?.status === 'not_found') out.push({ id: 'pay', label: 'Pay', text: 'Not stated in the agreement', evidence: [] });

  const due = fact('due', 'Paid', get('invoicing.payment_deadline'), 'deadline', pool);
  const trigger = fact('trigger', 'Payment trigger', get('invoicing.payment_conditions'), 'trigger', pool);
  if (due) out.push({ ...due, label: 'Payment due' });
  if (trigger) out.push({ ...trigger, label: 'Payment trigger', text: firstSentences(trigger.text, 1, 150) });

  const start = statedDate(get('timeline.start_date'));
  const length = fact('length', 'Length', get('timeline.duration'), 'duration', pool);
  if (length) out.push({ ...length, label: 'Duration', text: firstSentences(length.text, 1, 150) });
  else if (start) {
    const status = get('timeline.start_date')?.status;
    out.push({ id: 'start', label: 'Effective from', text: start.text, evidence: start.evidence, ...(status === 'conflicting' ? { note: 'conflicting' as const } : status === 'unclear' ? { note: 'unclear' as const } : {}) });
  }
  else if (get('timeline.duration')?.status === 'not_found') out.push({ id: 'duration', label: 'Duration', text: 'Not stated in the agreement', evidence: [] });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Page 2: categories
// ---------------------------------------------------------------------------------------------------------------

export interface CategoryView {
  id: string;
  title: string;
  blurb: string;
  facts: Fact[];
  /** Headings of key findings (page 1) that already explain a risk in this area */
  coveredOnPage1: string[];
  /** What happens in a relevant situation, when the agreement says something and page 1 does not already cover it */
  consequences: Array<{ title: string; text: string }>;
}

type Source = { deal: string } | { commit: (c: Commitment, party: 'freelancer' | 'client') => boolean };

interface CategorySpec {
  id: string;
  title: string;
  blurb: string;
  findingCategories: string[];
  scenarios: string[];
  facts: Array<{ label: string; kind: Kind; source: Source }>;
}

const commitIn = (...categories: string[]) => ({ commit: (c: Commitment) => categories.includes(c.category) });

const CATEGORY_SPECS: CategorySpec[] = [
  {
    id: 'scope', title: 'Services and scope of work',
    blurb: 'What you are asked to deliver, and how the work is reviewed, accepted and changed.',
    findingCategories: ['Scope of Work'], scenarios: ['scenario.scope_changes', 'scenario.deliverable_rejected'],
    facts: [
      { label: 'Services', kind: 'services', source: { deal: 'engagement.description' } },
      { label: 'Delivery', kind: 'generic', source: commitIn('delivery') },
      { label: 'From the client', kind: 'generic', source: commitIn('cooperation') },
      { label: 'Acceptance and changes', kind: 'generic', source: commitIn('acceptance') },
    ],
  },
  {
    id: 'payment', title: 'Payment and invoicing',
    blurb: 'How much you are paid, when, and what has to happen first.',
    findingCategories: ['Payment', 'Tax'], scenarios: ['scenario.late_payment', 'scenario.taxes'],
    facts: [
      { label: 'Pay', kind: 'amount', source: { deal: 'money.compensation' } },
      { label: 'Payment due', kind: 'deadline', source: { deal: 'invoicing.payment_deadline' } },
      { label: 'Invoicing', kind: 'invoicing', source: { deal: 'invoicing.invoice_requirements' } },
      { label: 'Milestones', kind: 'milestones', source: { deal: 'invoicing.milestones' } },
      { label: 'Payment trigger', kind: 'trigger', source: { deal: 'invoicing.payment_conditions' } },
      { label: 'Late payment', kind: 'late', source: { deal: 'invoicing.late_payment' } },
      { label: 'Expenses', kind: 'expenses', source: { deal: 'money.expenses' } },
      { label: 'Taxes', kind: 'tax', source: { deal: 'money.tax' } },
    ],
  },
  {
    id: 'ip', title: 'Intellectual property and ownership',
    blurb: 'Who owns the work you create, and what you keep.',
    findingCategories: ['Intellectual Property'], scenarios: ['scenario.ip_reuse'],
    facts: [{ label: 'Ownership', kind: 'generic', source: commitIn('ip') }],
  },
  {
    id: 'term', title: 'Contract duration and termination',
    blurb: 'How long the agreement runs, whether it renews, and how either side can end it.',
    findingCategories: ['Termination', 'Renewal'], scenarios: ['scenario.client_ends_early', 'scenario.you_want_to_end', 'scenario.renewal'],
    facts: [
      { label: 'Length', kind: 'duration', source: { deal: 'timeline.duration' } },
      { label: 'Renewal', kind: 'renewal', source: { deal: 'renewal.terms' } },
      { label: 'Ending early', kind: 'termination', source: { deal: 'termination.notice' } },
      { label: 'Your right to end it', kind: 'termination', source: { deal: 'termination.contractor_right' } },
      { label: 'Ending for cause', kind: 'cause', source: { deal: 'termination.conditions' } },
      { label: 'Payment when it ends', kind: 'ending-payment', source: { deal: 'termination.payment_on_termination' } },
    ],
  },
  {
    id: 'restrictions', title: 'Restrictions and exclusivity',
    blurb: 'What you cannot do while working with this client, and after.',
    findingCategories: ['Non-Compete, Exclusivity & Non-Solicitation', 'Worker Classification', 'Subcontracting & Delegation'], scenarios: ['scenario.other_clients', 'scenario.subcontracting'],
    facts: [{ label: 'Restriction', kind: 'generic', source: commitIn('restrictions', 'control', 'subcontracting') }],
  },
  {
    id: 'liability', title: 'Liability and indemnification',
    blurb: 'What you could be responsible for if something goes wrong.',
    findingCategories: ['Liability & Indemnification', 'Warranties', 'Insurance', 'Dispute Resolution & Governing Law'], scenarios: ['scenario.liability_claim', 'scenario.dispute'],
    facts: [
      { label: 'Responsibility', kind: 'generic', source: commitIn('liability', 'warranties', 'insurance') },
      { label: 'Governing law', kind: 'law', source: { deal: 'legal.governing_law' } },
    ],
  },
  {
    id: 'confidentiality', title: 'Confidentiality and data responsibilities',
    blurb: 'What you must keep private and how you must handle data.',
    findingCategories: ['Confidentiality', 'Data Protection & Security'], scenarios: ['scenario.data_incident'],
    facts: [{ label: 'Your duty', kind: 'generic', source: commitIn('confidentiality', 'data') }],
  },
];

/** Some commitments are one long sentence about several things; show the part about the thing the title names. */
function focusFor(title: string): RegExp | undefined {
  if (/repair|replace/i.test(title)) return /revision|repair|replace|correct|redo|rework/i;
  return undefined;
}

const elementIds = (es: ReportEvidence[]): Set<string> => new Set(es.map((e) => e.element_id));

function consequenceOf(s: Scenario): { title: string; text: string } | null {
  const missing = s.missing_protections[0];
  const outcome = s.potential_outcome.contractual[0];
  const text = missing?.text ?? outcome?.text;
  // statements read "Heading: sentence"; the heading is already the topic, so only the sentence is shown
  return text ? { title: s.scenario, text: firstSentences(text.replace(/^[^:]{3,90}:\s+(?=[A-Z])/, ''), 1, 220) } : null;
}

export function buildCategories(report: DecisionReport, keyFindings: DecisionFinding[], pool: string[] = evidencePool(report)): CategoryView[] {
  const covered = new Set<string>();
  keyFindings.forEach((f) => f.evidence.forEach((e) => covered.add(e.element_id)));
  const coveredIds = new Set(keyFindings.map((f) => f.id));
  const commitments = [
    ...report.commitments.freelancer.flatMap((g) => g.items.map((i) => ({ i, party: 'freelancer' as const }))),
    ...report.commitments.client.flatMap((g) => g.items.map((i) => ({ i, party: 'client' as const }))),
  ];

  return CATEGORY_SPECS.map((spec) => {
    const facts: Fact[] = [];
    const used = new Set<string>();
    // A clause that page 1 already explains in detail is not repeated here
    const coveredByPage1 = (f: Fact): boolean => {
      const ids = [...elementIds(f.evidence)];
      return ids.length > 0 && ids.every((id) => covered.has(id));
    };
    const add = (f: Fact | null): void => {
      if (!f) return;
      const ids = [...elementIds(f.evidence)];
      if (coveredByPage1(f)) return;
      if (ids.length > 0 && ids.every((id) => used.has(id))) return;
      if (facts.some((x) => x.text === f.text)) return;
      ids.forEach((id) => used.add(id));
      facts.push(f);
    };

    for (const def of spec.facts) {
      if ('deal' in def.source) {
        const item = report.deal.items.find((i) => i.id === (def.source as { deal: string }).deal);
        add(fact(`${spec.id}.${(def.source as { deal: string }).deal}`, def.label, item, def.kind, pool));
      } else {
        const match = (def.source as { commit: (c: Commitment, p: 'freelancer' | 'client') => boolean }).commit;
        for (const { i, party } of commitments.filter((c) => match(c.i, c.party)).slice(0, 4)) {
          const label = party === 'client' ? `Client: ${i.title}` : i.title;
          add(fact(`${spec.id}.${i.id}`, label.length > 60 ? def.label : label, i, def.kind, pool, focusFor(i.title)));
        }
      }
    }
    // The duration is a special case: "not stated" is itself useful information
    if (spec.id === 'term' && !facts.some((f) => f.label === 'Length')) {
      const duration = report.deal.items.find((i) => i.id === 'timeline.duration');
      const start = statedDate(report.deal.items.find((i) => i.id === 'timeline.start_date'));
      const extra: Fact[] = [];
      if (start) extra.push({ id: 'term.start', label: 'Effective from', text: start.text, evidence: start.evidence });
      if (duration?.status === 'not_found') extra.unshift({ id: 'term.none', label: 'Length', text: 'Not stated in the agreement', evidence: [] });
      facts.unshift(...extra.filter((f) => !coveredByPage1(f)));
    }

    const consequences = spec.scenarios
      .map((id) => report.scenarios.find((s) => s.id === id))
      .filter((s): s is Scenario => !!s && !s.related_finding_ids.some((id) => coveredIds.has(id)))
      .map(consequenceOf)
      .filter((c): c is { title: string; text: string } => c !== null)
      .slice(0, 2);

    return {
      id: spec.id,
      title: spec.title,
      blurb: spec.blurb,
      facts: facts.slice(0, 6),
      coveredOnPage1: keyFindings.filter((f) => spec.findingCategories.includes(f.category)).map((f) => f.title),
      consequences,
    };
  }).filter((c) => c.facts.length > 0 || c.coveredOnPage1.length > 0 || c.consequences.length > 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Page 3: next steps
// ---------------------------------------------------------------------------------------------------------------

export interface NegotiateItem { id: string; heading: string; action: string; evidence: ReportEvidence[] }
export interface QuestionItem { id: string; question: string; evidence: ReportEvidence[] }
export interface ChecklistItem { id: string; text: string }

export interface NextSteps {
  negotiate: NegotiateItem[];
  questions: QuestionItem[];
  checklist: ChecklistItem[];
  monitor: Fact[];
}

const MONITOR_KIND: Record<string, Kind> = {
  'monitor.payment_due': 'deadline',
  'monitor.milestones': 'milestones',
  'monitor.deadlines': 'generic',
  'monitor.end_date': 'duration',
  'monitor.renewal': 'renewal',
  'monitor.termination_notice': 'termination',
  'monitor.late_payment': 'late',
  'monitor.warranty': 'generic',
};
const MONITOR_ORDER = Object.keys(MONITOR_KIND);

export function buildNextSteps(report: DecisionReport, pool: string[] = evidencePool(report)): NextSteps {
  const findings = report.attention.findings;
  const byId = new Map(findings.map((f) => [f.id, f]));

  // What to negotiate: changes to terms that are in the agreement, most important first
  const risks = [...findings].filter((f) => f.type === 'risk').sort(byScore);
  const strong = risks.filter((f) => f.priority !== 'low');
  const chosen = (strong.length >= 2 ? strong : risks).filter((f, i, all) => all.findIndex((x) => x.cluster_id === f.cluster_id) === i).slice(0, 6);
  const negotiate = chosen.map((f) => ({ id: f.id, heading: f.title, action: firstSentences(f.recommended_action, 1, 240), evidence: f.evidence }));

  // Questions: things to clarify, add or resolve (not the changes already listed above)
  const rank = { high: 3, medium: 2, low: 1 } as const;
  const questions = report.rights_and_next_steps.questions
    .filter((q) => q.kind !== 'risk')
    .sort((a, b) => rank[b.priority] - rank[a.priority])
    .slice(0, 6)
    .map((q) => ({ id: q.id, question: q.question, evidence: q.contract_reference }));

  // Checklist: one tick per thing to settle, in plain words
  const checklist: ChecklistItem[] = [
    ...negotiate.slice(0, 5).map((n) => ({ id: `c.${n.id}`, text: `Agree a change to: ${n.heading}` })),
    ...report.rights_and_next_steps.questions
      .filter((q) => q.kind !== 'risk')
      .sort((a, b) => rank[b.priority] - rank[a.priority])
      .slice(0, 4)
      .map((q) => {
        const title = q.grounded_in.finding_id ? byId.get(q.grounded_in.finding_id)?.title : report.deal.items.find((i) => i.id === q.grounded_in.item_id)?.title;
        return { id: `c.${q.id}`, text: `Get an answer on: ${title ?? q.question}` };
      }),
  ];

  // Things to keep an eye on: only entries whose text passes the plausibility check for what they claim to be
  const monitor: Fact[] = [];
  const entries = [...report.rights_and_next_steps.checklist.during_engagement].sort((a, b) => MONITOR_ORDER.indexOf(a.id) - MONITOR_ORDER.indexOf(b.id));
  for (const m of entries) {
    const kind = MONITOR_KIND[m.id];
    if (!kind || monitor.length >= 4) continue;
    const colon = m.text.indexOf(': ');
    const label = colon > 0 ? m.text.slice(0, colon) : m.text;
    const pseudo: ExtractedItem = { id: m.id, title: label, value: colon > 0 ? m.text.slice(colon + 2) : null, status: 'explicit', explanation: '', evidence: m.evidence, category: 'monitor' };
    const f = fact(m.id, label, pseudo, kind, pool);
    if (!f) continue;
    monitor.push({ ...f, text: m.date ? `${f.text} (${m.date}${m.calculated ? ', calculated; please confirm' : ''})` : f.text });
  }
  return { negotiate, questions, checklist, monitor };
}

// ---------------------------------------------------------------------------------------------------------------
// Everything the three pages need
// ---------------------------------------------------------------------------------------------------------------

export interface Presentation {
  name: string;
  keyFindingsRaw: DecisionFinding[];
  keyFindings: KeyFinding[];
  keyTerms: Fact[];
  categories: CategoryView[];
  next: NextSteps;
}

export function buildPresentation(report: DecisionReport, fileName?: string): Presentation {
  const keyFindingsRaw = selectKeyFindings(report.attention.findings);
  const pool = evidencePool(report);
  return {
    name: agreementName(report, fileName),
    keyFindingsRaw,
    keyFindings: keyFindingsRaw.map(presentFinding),
    keyTerms: keyTerms(report, pool),
    categories: buildCategories(report, keyFindingsRaw, pool),
    next: buildNextSteps(report, pool),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Page navigation helpers (pure, so they can be tested)
// ---------------------------------------------------------------------------------------------------------------

export const PAGE_COUNT = 3;
export const PAGE_TITLES = ['Contract Overview', 'Understand Your Agreement', 'Before You Sign'] as const;

export const clampPage = (n: number): number => Math.max(0, Math.min(PAGE_COUNT - 1, n));

/** Which way a touch gesture asks to go: +1 next, -1 previous, 0 not a page swipe (a tap, a vertical scroll, a diagonal). */
export function swipeDirection(
  start: { x: number; y: number; t: number },
  end: { x: number; y: number; t: number },
  opts: { minDistance?: number; maxMs?: number } = {}
): -1 | 0 | 1 {
  const minDistance = opts.minDistance ?? 64;
  const maxMs = opts.maxMs ?? 700;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (end.t - start.t > maxMs) return 0;
  if (Math.abs(dx) < minDistance) return 0;
  // Must be clearly horizontal, so ordinary vertical scrolling never turns the page
  if (Math.abs(dx) <= Math.abs(dy) * 2) return 0;
  return dx < 0 ? 1 : -1;
}

/** Arrow keys turn the page, but never while the user is typing or operating a control that uses the arrows. */
export function pageKeyAction(key: string, target: { tagName?: string; isContentEditable?: boolean } | null, mods: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean } = {}): -1 | 0 | 1 {
  if (mods.alt || mods.ctrl || mods.meta || mods.shift) return 0;
  const tag = (target?.tagName ?? '').toUpperCase();
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || target?.isContentEditable) return 0;
  if (key === 'ArrowRight') return 1;
  if (key === 'ArrowLeft') return -1;
  return 0;
}
