import { extractDates, extractDurations, extractPlaces } from '../understanding/conflictDetector';
import { Analysis, max } from './analysis';
import { largestAmount } from './intelligenceRules';
import { FindingEvidence } from './types';

/**
 * Cross-clause analysis: compares RELATED terms that live in different clauses.
 *
 * A contradiction is only reported when
 *   1. both sides concern the same term and the same situation,
 *   2. the values/conditions are genuinely incompatible (not just worded differently), and
 *   3. both sides have verified quotes from different text.
 * Provisions that qualify or complement each other (an exception, a milestone-specific term, an explicit
 * carve-out, an exhibit-specific rule) are compatible and produce no finding. When the relationship cannot be
 * established confidently the result is an AMBIGUOUS_TERM, never a CONTRADICTORY_PROVISIONS finding.
 */

// ---------------------------------------------------------------------------
// Shared patterns
// ---------------------------------------------------------------------------
export const IP_ON_PAYMENT =
  /(title|ownership|rights?|intellectual property|licen[sc]e)[^.]{0,100}(only\s+)?(upon|after|until|following|subject to|conditioned (up)?on|contingent (up)?on)[^.]{0,40}(full\s+|final\s+|complete\s+|receipt of\s+)?(payment|paid)/i;
const IP_CONTEXT = /(work product|deliverables?|intellectual property|rights?|title|ownership|inventions?|\bworks?\b)/i;
const IP_IMMEDIATE =
  /(hereby assigns?|assigns? to|shall (be|become) (the\s+)?(sole\s+)?(and exclusive\s+)?property of|vests?)[^.]{0,120}(immediately|upon creation|as (it is|they are) created|automatically|at creation)|(immediately|upon creation|automatically)[^.]{0,60}(assign|vest|owned by|property of)/i;

const COND_ON_ACCEPTANCE =
  /(payment|invoices?|fees?|compensation)[^.]{0,80}(conditioned (up)?on|contingent (up)?on|subject to|only (after|upon)|until)[^.]{0,50}(accept|approv|sign[- ]off)|(upon|after|following)[^.]{0,20}(accept|approv)[^.]{0,40}(payment|paid)|(no|not)\s+(payment|invoice)[^.]{0,60}(until|before|unless)[^.]{0,40}(accept|approv)/i;
const ANCHORED_ON_DELIVERY = /(after|of|from|following)\s+(the\s+)?(delivery|completion|receipt of (the\s+)?(work|deliverables|services))/i;
const DEEMED_ACCEPTANCE = /(deemed|considered)\s+(to be\s+)?(accepted|approved)|failure to (reject|respond|object)[^.]{0,40}(accept|approv)/i;

const CHANGE_REQUIRED = /(change order|written (change|amendment|agreement)|signed by both|mutually agreed in writing)/i;
const OPEN_ADDITIONAL =
  /(perform|provide|complete|deliver)[^.]{0,60}(additional|extra|other)\s+(services|work|tasks|deliverables)|additional (services|work)[^.]{0,60}(as|when)\s+(may be\s+)?(requested|required|directed)|(as|when)\s+(may be\s+)?(requested|directed)\s+by\s+(the\s+)?(client|company)[^.]{0,60}(from time to time|at no)|unlimited\s+(revisions|changes)/i;
const QUALIFIED_ADDITIONAL =
  /(subject to|pursuant to|in accordance with|under|through|per|only (under|with|upon))\s+(a\s+|the\s+|any\s+)?(written\s+)?(change order|change request|amendment)|(for|at)\s+(an?\s+)?(additional|agreed|extra)\s+(fee|compensation|charge|rate)|at\s+the\s+rates?|agreed\s+(in writing|by both|upon)|mutually agreed|signed by both/i;

const FORFEIT =
  /(shall not|not)\s+(be\s+)?(entitled|owed|paid|due)[^.]{0,40}(any\s+)?(payment|compensation|fees)|forfeit\w*|no\s+(further\s+)?(payment|compensation|fees)\s+(shall|will|is|are)\s+(be\s+)?(due|owed|payable)|withhold\s+(all|any)\s+(payment|fees|compensation)/i;
const FORFEIT_QUALIFIED = /(except|other than|but)[^.]{0,80}(paid|payment)[^.]{0,40}(for\s+)?(work|services)[^.]{0,30}(performed|accepted|completed|delivered)/i;
const PAYS_ON_TERMINATION =
  /(pay|paid|payment|compensat\w*)[^.]{0,80}(for|all)[^.]{0,50}(work|services|hours|deliverables)[^.]{0,50}(perform|complet|render|deliver|incurr|through the termination)/i;

const CAP_COVERS_ALL = /(in no event|under no circumstances|aggregate|total|cumulative|all claims|any and all claims)/i;
const CAP_EXCEPTIONS = /(except|exclud\w*|other than|shall not apply|does not apply|not apply|carve[- ]?out|notwithstanding)[^.]{0,120}(indemnif|confidential|gross negligence|willful|fraud|infring)/i;
const INDEMNITY_UNCAPPED =
  /(unlimited|without limit|uncapped|not (be )?(subject to|limited by|capped by)[^.]{0,40}(limit|cap|limitation)|notwithstanding[^.]{0,60}(limit|cap)|regardless of (any|the) (limit|cap)|in addition to)/i;
const BROAD_INDEMNITY = /(any and all|all (claims|losses|liabilities|damages))/i;
const LIMITED_TO_INSURANCE = /(liability|obligations?)[^.]{0,80}(limited to|shall not exceed|capped at)[^.]{0,40}(insurance|proceeds|policy limits?|coverage)/i;

const LOCK_IN =
  /(may not|cannot|shall not|no right to|not entitled to)\s+terminate[^.]{0,80}(during|before the end of|prior to the expiration of)\s+(the\s+)?(then[- ]current\s+|any\s+)?(renewal|initial|current|then-current|committed)\s+(term|period)|(committed|locked|bound)\s+(for|to)\s+the\s+(full|entire)\s+(renewal\s+)?(term|period)|no (early )?termination (for convenience )?during/i;
const NO_RENEWAL = /(shall|will|does)\s+not\s+(automatically\s+)?(renew|be renewed)|no (automatic )?renewal|expire[sd]?[^.]{0,60}(without|no) (renewal|extension)/i;

const TERM_LENGTH =
  /(this agreement|the agreement)[^.]{0,80}(continues?|remains?|shall (continue|remain|run)|term)[^.]{0,60}(for|of)\s+(a\s+|an\s+initial\s+)?(term|period)?\s*(of\s+)?(\w+\s*)?(\(\d+\)\s*)?(months?|years?)|initial term of\s+(\w+\s*)?(\(\d+\)\s*)?(months?|years?)/i;
const NOT_AGREEMENT_TERM = /(confidential|warrant|renew|notice|surviv|after (the )?termination|following termination|insurance|data)/i;
const EXPIRY = /(expir\w*|ends?|ending)\s+(automatically\s+)?(on|at|by)\s+/i;

const RATE_AMOUNT = /\$\s?\d[\d,.]*\s*(\/|per)\s*(hour|hr|day|month|week)/i;
const RATE_QUALIFIER =
  /(overtime|rush|expedit|weekend|holiday|travel|additional|senior|junior|principal|\brole\b|\bif\b|except|surcharge|premium|discount|after[- ]hours|late|interest|penalt|expense|reimburse|per diem|mileage|in the event|change order|(exhibit|schedule|appendix|annex)\s+[a-z0-9])/i;
const PAYMENT_DAYS =
  /(net\s*\d+|within\s+\w+\s*(\(\d+\)\s*)?(business\s+)?days?\s+(of|after|from)\s+(the\s+)?(receipt|invoice|date of (the\s+)?invoice|delivery)|payable\s+(within|in)\s+\w+[^.]{0,20}days)/i;
const PAYMENT_QUALIFIER = /(late|overdue|milestone|deposit|retainer|expense|reimburs|final|terminat|dispute|interest|cure|refund|credit|notice of breach)/i;
const SCOPED_TO_EXHIBIT = /(exhibit|schedule|appendix|annex)\s+[a-z0-9]/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Longest period in days. Business days are converted at about 7 calendar days per 5 business days. */
const daysOf = (text: string): number | undefined => {
  const v = [...extractDurations(text)].flatMap((x) => {
    const [n, ...unit] = x.split(' ');
    const u = unit.join(' ');
    return u === 'days' ? [parseFloat(n)] : u === 'business days' ? [Math.round(parseFloat(n) * 1.4)] : [];
  });
  return v.length ? Math.max(...v) : undefined;
};
/** Calendar-month values from "N months" / "N years" only (days are notice periods, not durations of obligations). */
const monthsYears = (text: string): number[] =>
  [...extractDurations(text)].flatMap((v) => {
    const [n, unit] = v.split(' ');
    return unit === 'months' ? [parseFloat(n)] : unit === 'years' ? [parseFloat(n) * 12] : [];
  });

/**
 * A term's evidence and text: from the extracted fact when it is established, otherwise straight from the
 * document text. Cross-clause rules must not depend on whether the extraction stage happened to capture a clause.
 */
function factOrText(
  a: Analysis,
  key: string,
  pattern: RegExp,
  filter?: (sentence: string) => boolean
): { ev: FindingEvidence[]; text: string } | null {
  const f = a.facts[key];
  if (a.isEstablished(f)) return { ev: a.evidenceOf(f).slice(0, 1), text: `${a.text(f, false)} ${a.text(f)}` };
  const hits = a.searchEvidence(pattern, 1, filter);
  return hits.length ? { ev: hits, text: hits[0].exact_quote } : null;
}

const CAP_SENTENCE = /(liabilit\w*)[^.]{0,120}(shall not exceed|not exceed|limited to|capped (at|to)|in no event)|in no event[^.]{0,100}liabilit/i;
const NOT_LLC = (q: string) => !/limited liability company/i.test(q);
const CONTRACTOR_INDEMNITY = /(indemnif\w*|hold harmless)/i;
const OF_CONTRACTOR = (q: string) => /contractor[^.]{0,80}(indemnif|hold harmless)|(indemnif|hold harmless)[^.]{0,100}contractor|indemnification obligations/i.test(q) && !/company (shall|will) (indemnif|hold)/i.test(q);
const INSURANCE_LIMIT = /(insurance|coverage)[^.]{0,200}(\$|usd\s?|eur\s?|£|€)\s?\d/i;
const TERMINATE_ON_NOTICE = /(either|both)\s+part(y|ies)[^.]{0,60}terminate[^.]{0,80}(without cause|notice|convenience)|terminate[^.]{0,60}without cause/i;
const AUTO_RENEW = /(automatic(ally)?|auto[- ]?)\s*(renew|extend)|(shall|will)\s+(automatically\s+)?renew\b/i;
const REMEDY_SENTENCE = /(repair|correct|fix|replace|re-?perform)[^.]{0,120}(notwithstanding|regardless of|not (be )?subject to|without limit|unlimited)/i;

const ev = (a: Analysis, key: string, focus?: RegExp): FindingEvidence[] =>
  focus ? a.evidenceFocused(focus, a.facts[key]) : a.evidenceOf(a.facts[key]);

// ---------------------------------------------------------------------------
// 1. Payment deadline vs acceptance / approval
// ---------------------------------------------------------------------------
const ACCEPTANCE_PERIOD =
  /(accept|approv|review|inspect)\w*[^.]{0,100}(\d+|\w+)\s*(\(\d+\)\s*)?(business\s+)?days?|(\d+|\w+)\s*(\(\d+\)\s*)?(business\s+)?days?[^.]{0,60}(to\s+)?(accept|approve|review|reject)/i;

function paymentVsAcceptance(a: Analysis): void {
  // Payment must actually be tied to acceptance, otherwise the two periods are independent
  const cond = a.searchEvidence(COND_ON_ACCEPTANCE, 1);
  if (cond.length === 0) return;

  // Candidate payment deadlines: every qualifying sentence in the text, plus the extracted fact when established
  const candidates: Array<{ ev: FindingEvidence[]; text: string }> = a
    .searchEvidence(PAYMENT_DAYS, 8, (q) => !PAYMENT_QUALIFIER.test(q))
    .map((e) => ({ ev: [e], text: e.exact_quote }));
  if (a.isEstablished(a.facts.payment_terms)) {
    candidates.push({
      ev: ev(a, 'payment_terms', /days?|payable|due/i).slice(0, 1),
      text: `${a.text(a.facts.payment_terms, false)} ${a.text(a.facts.payment_terms)}`,
    });
  }
  const usable = candidates.filter((c) => c.ev.length > 0 && daysOf(c.text) !== undefined);
  if (usable.length === 0) return;

  const period = a.searchEvidence(ACCEPTANCE_PERIOD, 1, (q) => !/invoice|payable/i.test(q));
  const accDays = period.length ? daysOf(period[0].exact_quote) : undefined;
  const deemed = a.searchHas(DEEMED_ACCEPTANCE);
  const accEv = period.length
    ? [...period, ...cond.filter((c) => c.element_id !== period[0].element_id || c.exact_quote !== period[0].exact_quote)]
    : cond;

  // A deadline counted from DELIVERY that is shorter than the acceptance period it depends on cannot be met
  const clash = accDays === undefined ? undefined : usable.find((c) => ANCHORED_ON_DELIVERY.test(c.text) && accDays > daysOf(c.text)!);
  if (clash) {
    const payDays = daysOf(clash.text)!;
    a.addContradiction({
      rule_id: 'cross.payment_vs_acceptance',
      category: 'Payment',
      title: 'Payment falls due before the acceptance period ends',
      explanation: `Payment is due about ${payDays} days after delivery, but it is conditioned on acceptance and the client has about ${accDays} days to accept, so the payment deadline can pass before acceptance is even decided.`,
      sideA: clash.ev,
      sideB: accEv.slice(0, 2),
      patternBased: false,
    });
    return;
  }
  if (accDays === undefined && !deemed) {
    const first = usable[0];
    a.add({
      rule_id: 'cross.payment_vs_acceptance',
      category: 'Payment',
      kind: 'AMBIGUOUS_TERM',
      severity: 'Medium',
      title: 'Payment deadline depends on an approval with no time limit',
      explanation: `The contract sets a payment deadline of about ${daysOf(first.text)} days, but payment is conditioned on the client’s acceptance and no time limit or deemed acceptance applies, so it is unclear when payment actually falls due.`,
      why: 'The client could delay approval and, with it, your payment indefinitely.',
      suggestion: 'Ask for a fixed review period (for example 10 business days) after which the work is treated as accepted, and for the payment clock to run from that date.',
      evidence: [...first.ev, ...cond.slice(0, 1)],
      patternBased: true,
    });
  }
  // payment counted from the invoice AND acceptance has its own period: the two complement each other
}

// ---------------------------------------------------------------------------
// 2. Scope vs change orders
// ---------------------------------------------------------------------------
function scopeVsChangeOrder(a: Analysis): void {
  const co = factOrText(a, 'change_order', CHANGE_REQUIRED, (q) => /scope|change|amend/i.test(q) && CHANGE_REQUIRED.test(q));
  if (!co || !CHANGE_REQUIRED.test(co.text)) return;
  const open = a.searchEvidence(OPEN_ADDITIONAL, 1, (q) => !QUALIFIED_ADDITIONAL.test(q));
  if (open.length === 0) return;
  a.addContradiction({
    rule_id: 'cross.scope_vs_change_order',
    category: 'Scope of Work',
    title: 'Extra work is both subject to a change order and owed without one',
    explanation: 'One clause says changes to the scope need a signed change order, while another requires you to perform additional services on request, with no reference to the change process or to extra pay.',
    sideA: co.ev,
    sideB: open,
    severity: 'Medium',
  });
}

// ---------------------------------------------------------------------------
// 3. Termination rights vs payment for completed work
// ---------------------------------------------------------------------------
function terminationVsPayment(a: Analysis): void {
  const forfeit = a.searchEvidence(FORFEIT, 1, (q) => /terminat|breach/i.test(q) && !FORFEIT_QUALIFIED.test(q));
  if (forfeit.length === 0) return;
  const pays = a.searchEvidence(PAYS_ON_TERMINATION, 2, (q) => /terminat/i.test(q) && !FORFEIT.test(q));
  if (pays.length > 0) {
    a.addContradiction({
      rule_id: 'cross.termination_vs_payment',
      category: 'Termination',
      title: 'Payment for completed work is both promised and denied on termination',
      explanation: 'One clause says you receive no payment on termination (for example after a breach), while another says you are paid for all services performed up to termination, so it is unclear whether completed work is paid for.',
      sideA: forfeit,
      sideB: pays,
    });
  } else if (!a.findings.some((f) => f.rule_id === 'termination.forfeit_payment')) {
    a.add({
      rule_id: 'cross.forfeit_on_termination',
      category: 'Termination',
      kind: 'RISK',
      severity: 'High',
      title: 'Payment can be lost if the contract ends',
      explanation: 'The contract says you are not entitled to payment on termination, and nothing promises payment for work already done.',
      why: 'Work you have already performed could go unpaid if the client ends the contract or alleges a breach.',
      suggestion: 'Ask for payment of all fees for work performed and expenses incurred up to the termination date, including work in progress.',
      evidence: forfeit,
      patternBased: true,
    });
  }
}

// ---------------------------------------------------------------------------
// 4. IP transfer vs full-payment condition
// ---------------------------------------------------------------------------
function ipVsPayment(a: Analysis): void {
  // A sentence that states BOTH (immediate transfer, but "upon full payment") is internally consistent
  const immediate = a.searchEvidence(IP_IMMEDIATE, 1, (q) => IP_CONTEXT.test(q) && !IP_ON_PAYMENT.test(q));
  const onPayment = a.searchEvidence(IP_ON_PAYMENT, 1, (q) => IP_CONTEXT.test(q));
  if (immediate.length === 0 || onPayment.length === 0) return;
  a.addContradiction({
    rule_id: 'cross.ip_vs_payment',
    category: 'Intellectual Property',
    title: 'Ownership passes immediately in one clause and only on full payment in another',
    explanation: 'One clause assigns the work to the client immediately (for example on creation), while another says title passes only when you have been paid in full. It is unclear who owns the work if payment is late or disputed.',
    sideA: immediate,
    sideB: onPayment,
  });
}

// ---------------------------------------------------------------------------
// 5. Liability cap vs indemnification
// ---------------------------------------------------------------------------
function capVsIndemnity(a: Analysis): void {
  const cap = factOrText(a, 'liability_cap', CAP_SENTENCE, NOT_LLC);
  const ind = factOrText(a, 'indemnity_contractor', CONTRACTOR_INDEMNITY, OF_CONTRACTOR);
  if (!cap || !ind) return;
  const capText = cap.text;
  const indText = ind.text;
  const covers = CAP_COVERS_ALL.test(capText);
  const carvedOut = CAP_EXCEPTIONS.test(capText) && /indemnif/.test(capText.match(CAP_EXCEPTIONS)?.[0] ?? '');
  const uncapped = INDEMNITY_UNCAPPED.test(indText);
  const capEv = cap.ev;
  const indEv = ind.ev;

  if (uncapped && covers && !carvedOut) {
    a.addContradiction({
      rule_id: 'cross.cap_vs_indemnity',
      category: 'Liability & Indemnification',
      title: 'The liability cap says it covers everything, but the indemnity says it is unlimited',
      explanation: 'The liability cap applies to all liability under the agreement, while the indemnification clause says your indemnity is not subject to any limit. It is unclear which wins.',
      sideA: capEv,
      sideB: indEv,
      severity: 'High',
    });
    return;
  }
  if (carvedOut) {
    // The cap expressly excludes indemnification: the clauses are consistent, but the cap gives no protection for it.
    const broad = BROAD_INDEMNITY.test(indText);
    const narrow = /(infring|intellectual property)/.test(indText) && !broad;
    a.add({
      rule_id: 'cross.indemnity_outside_cap',
      category: 'Liability & Indemnification',
      kind: 'RISK',
      severity: broad ? 'High' : narrow ? 'Low' : 'Medium',
      title: 'Your indemnity sits outside the liability cap',
      explanation: `The liability cap expressly excludes your indemnification obligations, so those obligations are not limited by it${narrow ? ' (the indemnity is limited to intellectual-property claims)' : ''}.`,
      why: 'The cap would not protect you for indemnified claims, which can exceed your fees.',
      suggestion: narrow
        ? 'This is a common arrangement for IP claims. Check that the indemnity is limited to claims caused by your own work.'
        : 'Ask for the indemnity to be limited to specific, narrow claims and for a higher separate cap rather than none.',
      evidence: [...capEv, ...indEv],
      patternBased: true,
    });
    return;
  }
  if (uncapped && !covers) {
    a.add({
      rule_id: 'cross.cap_indemnity_unclear',
      category: 'Liability & Indemnification',
      kind: 'AMBIGUOUS_TERM',
      severity: 'Medium',
      title: 'It is unclear whether the liability cap applies to your indemnity',
      explanation: 'The indemnity says it is not limited, while the liability cap does not say whether it applies to indemnified claims.',
      why: 'If the cap does not apply, your exposure is unlimited for those claims.',
      suggestion: 'Ask the contract to say expressly whether the cap applies to indemnification.',
      evidence: [...capEv, ...indEv],
      patternBased: true,
    });
    return;
  }
  if (!uncapped && !covers && !carvedOut) {
    a.add({
      rule_id: 'cross.cap_indemnity_unclear',
      category: 'Liability & Indemnification',
      kind: 'AMBIGUOUS_TERM',
      severity: 'Low',
      title: 'It is unclear whether the liability cap applies to your indemnity',
      explanation: 'The contract has both a liability cap and an indemnity, and neither says how it interacts with the other.',
      why: 'A court may read the indemnity as outside the cap, which would remove your protection for those claims.',
      suggestion: 'Ask for a sentence saying that indemnification is (or is not) subject to the cap.',
      evidence: [...capEv, ...indEv],
      patternBased: true,
    });
  }
}

// ---------------------------------------------------------------------------
// 6. Insurance vs liability cap / indemnification
// ---------------------------------------------------------------------------
function insuranceVsLiability(a: Analysis): void {
  const cap = factOrText(a, 'liability_cap', CAP_SENTENCE, NOT_LLC);
  const minCov = factOrText(a, 'ins_min', INSURANCE_LIMIT);
  if (cap && minCov) {
    const capAmount = largestAmount(cap.text);
    const coverage = largestAmount(minCov.text);
    if (capAmount !== undefined && coverage !== undefined && coverage > capAmount) {
      a.add({
        rule_id: 'cross.insurance_exceeds_cap',
        category: 'Insurance',
        kind: 'RISK',
        severity: 'Medium',
        title: 'Required insurance limits exceed your liability cap',
        explanation: `You must carry insurance of at least $${coverage.toLocaleString('en-US')}, but your liability under the agreement is capped at $${capAmount.toLocaleString('en-US')}.`,
        why: 'You would pay for cover that is larger than the exposure the contract itself allows, which suggests the requirements were not matched to each other.',
        suggestion: 'Ask for the insurance limits to be aligned with the liability cap, or for the cap to be raised if the higher cover is genuinely intended.',
        evidence: [...cap.ev, ...minCov.ev],
        patternBased: false,
      });
    }
  }
  const ind = factOrText(a, 'indemnity_contractor', CONTRACTOR_INDEMNITY, OF_CONTRACTOR);
  if (ind && INDEMNITY_UNCAPPED.test(ind.text)) {
    const limited = a.searchEvidence(LIMITED_TO_INSURANCE, 1);
    if (limited.length > 0) {
      a.addContradiction({
        rule_id: 'cross.insurance_vs_indemnity',
        category: 'Insurance',
        title: 'Liability is limited to insurance in one clause and unlimited in another',
        explanation: 'One clause limits your liability to the insurance you carry, while the indemnification clause says your indemnity is not limited.',
        sideA: limited,
        sideB: ind.ev,
        severity: 'Medium',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Confidentiality duration vs survival
// ---------------------------------------------------------------------------
function confidentialityVsSurvival(a: Analysis): void {
  const sentences = a.searchEvidence(
    /(confidential\w*|secrecy|non-?disclosure)[^.]{0,200}(years?|months?)|(years?|months?)[^.]{0,120}confidential|surviv\w*[^.]{0,160}(perpetual|indefinite|in perpetuity)|confidential[^.]{0,160}(perpetual|indefinite|in perpetuity)/i,
    12,
    // Trade secrets and personal data are legitimately protected for different periods
    (q) => !/trade secret|personal data/i.test(q) && !/\bnotice\b|within\s+\w+\s*(\(\d+\)\s*)?(days|hours)/i.test(q)
  );
  type Item = { ev: FindingEvidence; months: number[]; perpetual: boolean };
  const items: Item[] = sentences
    .map((e) => ({
      ev: e,
      months: monthsYears(e.exact_quote),
      perpetual: /perpetual|indefinite|in perpetuity/i.test(e.exact_quote),
    }))
    .filter((i) => i.months.length > 0 || i.perpetual);

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const x = items[i];
      const y = items[j];
      if (x.ev.element_id === y.ev.element_id) continue;
      const differ =
        x.perpetual !== y.perpetual ||
        (x.months.length > 0 && y.months.length > 0 && !x.months.some((m) => y.months.includes(m)));
      if (differ) {
        a.addContradiction({
          rule_id: 'cross.confidentiality_vs_survival',
          category: 'Confidentiality',
          title: 'Confidentiality lasts for different periods in different clauses',
          explanation: 'One clause sets the confidentiality period, while a survival clause gives a different period (or no end), so it is unclear how long you are bound.',
          sideA: [x.ev],
          sideB: [y.ev],
          patternBased: false,
        });
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 8. Renewal vs termination, and term dates
// ---------------------------------------------------------------------------
const addMonthsUtc = (iso: string, months: number): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1 + months, d);
};
const dateMs = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const DAY = 86_400_000;

function datesAfter(sentence: string, marker: RegExp): string[] {
  const m = marker.exec(sentence);
  if (!m) return [];
  return [...extractDates(sentence.slice(m.index + m[0].length))].sort();
}

function renewalVsTermination(a: Analysis): void {
  // (a) A clause that locks you in for the whole term vs a right to terminate on notice
  const conv = factOrText(a, 'term_convenience', TERMINATE_ON_NOTICE);
  if (conv && /(either|both) part|contractor (may|can)/i.test(conv.text)) {
    const lock = a.searchEvidence(LOCK_IN, 1);
    if (lock.length > 0) {
      a.addContradiction({
        rule_id: 'cross.renewal_lockin_vs_termination',
        category: 'Termination',
        title: 'You may terminate on notice, but are also locked in for the full term',
        explanation: 'One clause lets either party end the contract on notice, while another says you cannot terminate during the (renewal) term.',
        sideA: conv.ev,
        sideB: lock,
      });
    }
  }

  // (b) Automatic renewal vs an express statement that the contract does not renew
  const autoRenew = a.has('ren_auto') ? ev(a, 'ren_auto', /renew|extend/i).slice(0, 1) : a.searchEvidence(AUTO_RENEW, 1, (q) => !NO_RENEWAL.test(q));
  if (autoRenew.length > 0) {
    const noRenew = a.searchEvidence(NO_RENEWAL, 1);
    if (noRenew.length > 0) {
      a.addContradiction({
        rule_id: 'cross.renewal_vs_expiry',
        category: 'Renewal',
        title: 'The contract both renews automatically and says it will not renew',
        explanation: 'One clause says the contract renews automatically, while another says it expires without renewal.',
        sideA: autoRenew,
        sideB: noRenew,
      });
    }
  }

  // (c) Stated term length + start date vs stated expiration date
  const lengthSentences = a.searchEvidence(TERM_LENGTH, 1, (q) => monthsYears(q).length > 0 && !NOT_AGREEMENT_TERM.test(q));
  const expirySentences = a.searchEvidence(EXPIRY, 1, (q) => extractDates(q).size > 0);
  if (lengthSentences.length > 0 && expirySentences.length > 0) {
    const lenText = lengthSentences[0].exact_quote;
    const months = monthsYears(lenText)[0];
    let startIso = datesAfter(lenText, /(begin\w*|commenc\w*|start\w*|effective)\s*(on|as of|date)?\s*/i)[0];
    if (!startIso && a.has('effective_date')) startIso = [...extractDates(a.text(a.facts.effective_date, false))].sort()[0];
    const expiryText = expirySentences[0].exact_quote;
    const endIso = datesAfter(expiryText, EXPIRY)[0];
    if (startIso && endIso && months !== undefined) {
      const expectedEnd = addMonthsUtc(startIso, months);
      const actualEnd = dateMs(endIso);
      const diffDays = Math.abs(actualEnd - expectedEnd) / DAY;
      // A few days of slack covers "12 months from April 1" ending on March 31
      if (diffDays > 3 || actualEnd < dateMs(startIso)) {
        a.addContradiction({
          rule_id: 'cross.term_vs_expiry_date',
          category: 'Termination',
          title: 'The stated term length and the expiration date do not match',
          explanation: `A term of ${months} months from ${startIso} would end around ${new Date(expectedEnd).toISOString().slice(0, 10)}, but the contract states that it expires on ${endIso}.`,
          sideA: lengthSentences,
          sideB: expirySentences,
          patternBased: false,
        });
      }
    }
  }

  // (d) Termination notice longer than the renewal period it would apply to (a real exit problem, not a contradiction)
  const renewalSentence = a.has('ren_duration')
    ? { ev: ev(a, 'ren_duration').slice(0, 1), text: a.text(a.facts.ren_duration, false) }
    : (() => {
        const hit = a.searchEvidence(/renew\w*[^.]{0,120}(terms?|periods?)\s+of\s+(\w+\s*)?(\(\d+\)\s*)?(months?|years?)/i, 1);
        return hit.length ? { ev: hit, text: hit[0].exact_quote } : null;
      })();
  if (conv && renewalSentence) {
    const notice = daysOf(conv.text);
    const renewMonths = max(monthsYears(renewalSentence.text));
    if (notice !== undefined && renewMonths !== undefined && notice > renewMonths * 30) {
      a.add({
        rule_id: 'cross.notice_exceeds_renewal',
        category: 'Renewal',
        kind: 'RISK',
        severity: 'Medium',
        title: 'Termination notice is longer than the renewal period',
        explanation: `Ending the contract needs about ${notice} days’ notice, but each renewal lasts only about ${Math.round(renewMonths)} months, so notice given during a renewal may only take effect after it has ended.`,
        why: 'You may be unable to leave within a renewal term, effectively locking you in for the next one.',
        suggestion: 'Ask for a notice period that is shorter than the renewal term (for example 30 days).',
        evidence: [...conv.ev, ...renewalSentence.ev],
        patternBased: false,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 9. Financial amounts, dates, rates and payment conditions across sections
// ---------------------------------------------------------------------------
function financialConsistency(a: Analysis): void {
  // (a) a fixed fee vs an hourly rate with no cap or estimate to reconcile them
  const fee = a.facts.fee_structure;
  const rates = a.facts.rates;
  if (a.isEstablished(fee) && a.isEstablished(rates)) {
    const feeText = a.text(fee, false);
    const rateText = a.text(rates, false);
    const fixed = /(fixed|flat|lump[- ]sum|project)\s+(fee|price|rate|amount)/i.test(feeText);
    const hourly = /(per hour|hourly|\/hr|per day|day rate|time[- ]and[- ]materials)/i.test(rateText);
    const reconciled = /(not[- ]to[- ]exceed|cap(ped)?|up to|maximum|estimate[d]?|budget|retainer)/i.test(`${feeText} ${rateText}`);
    if (fixed && hourly && !reconciled) {
      a.addContradiction({
        rule_id: 'cross.fee_structure_vs_rate',
        category: 'Payment',
        title: 'The fee structure is described as fixed in one place and hourly in another',
        explanation: 'One clause describes a fixed fee, while another sets an hourly or daily rate, and nothing (such as a cap or estimate) reconciles them.',
        sideA: ev(a, 'fee_structure').slice(0, 1),
        sideB: ev(a, 'rates').slice(0, 1),
      });
    }
  }

  // (b) different rates for the same unit, outside any qualified situation (overtime, role, exhibit...)
  const rateSentences = a.searchEvidence(RATE_AMOUNT, 12, (q) => !RATE_QUALIFIER.test(q));
  const byUnit = new Map<string, Array<{ value: number; ev: FindingEvidence }>>();
  for (const e of rateSentences) {
    const m = /\$\s?(\d[\d,.]*)\s*(?:\/|per)\s*(hour|hr|day|month|week)/i.exec(e.exact_quote);
    if (!m) continue;
    const unit = m[2].toLowerCase() === 'hr' ? 'hour' : m[2].toLowerCase();
    const list = byUnit.get(unit) ?? [];
    list.push({ value: parseFloat(m[1].replace(/,/g, '')), ev: e });
    byUnit.set(unit, list);
  }
  for (const [unit, list] of byUnit) {
    const first = list[0];
    const other = list.find((x) => x.value !== first.value && x.ev.element_id !== first.ev.element_id);
    if (other) {
      a.addContradiction({
        rule_id: 'cross.rate_conflict',
        category: 'Payment',
        title: `Two different per-${unit} rates are stated`,
        explanation: `One clause sets a rate of $${first.value} per ${unit}, while another sets $${other.value} per ${unit}, and neither is tied to a different role, situation or exhibit.`,
        sideA: [first.ev],
        sideB: [other.ev],
        patternBased: false,
      });
      break;
    }
  }

  // (c) different payment deadlines for the same invoices
  // Review/acceptance periods are counted from delivery too, but they are not payment deadlines
  const deadlines = a.searchEvidence(PAYMENT_DAYS, 12, (q) => !PAYMENT_QUALIFIER.test(q) && !SCOPED_TO_EXHIBIT.test(q) && !/(review|inspect|accept|reject|approv)/i.test(q));
  const withDays = deadlines
    .map((e) => ({ ev: e, days: daysOf(e.exact_quote) }))
    .filter((x): x is { ev: FindingEvidence; days: number } => x.days !== undefined);
  if (withDays.length >= 2) {
    const first = withDays[0];
    const other = withDays.find((x) => x.days !== first.days && x.ev.element_id !== first.ev.element_id);
    if (other) {
      a.addContradiction({
        rule_id: 'cross.payment_deadline_conflict',
        category: 'Payment',
        title: `Two different payment deadlines are stated (${first.days} and ${other.days} days)`,
        explanation: `One clause makes invoices payable within ${first.days} days, while another says ${other.days} days, and neither is limited to late, milestone or other special invoices.`,
        sideA: [first.ev],
        sideB: [other.ev],
        patternBased: false,
      });
    }
  }

  // (d) two different effective dates (a signing date is a different thing and is excluded)
  const effective = a
    .findInDocument(/effective\s+(as of|date|on)/i, 6, (q) => !/(sign|execut)/i.test(q) && extractDates(q).size > 0)
    .map((e) => ({ ev: e, dates: [...extractDates(e.exact_quote)] }));
  if (effective.length >= 2) {
    const first = effective[0];
    const other = effective.find((x) => !x.dates.some((d) => first.dates.includes(d)) && x.ev.element_id !== first.ev.element_id);
    if (other) {
      a.addContradiction({
        rule_id: 'cross.effective_date_conflict',
        category: 'Termination',
        title: 'Two different effective dates are stated',
        explanation: `One clause makes the agreement effective on ${first.dates[0]}, while another says ${other.dates[0]}.`,
        sideA: [first.ev],
        sideB: [other.ev],
        patternBased: false,
      });
    }
  }

  // (e) two different governing laws (a law scoped to an exhibit is a qualification, not a conflict)
  const laws = a
    .findInDocument(/governed\s+by|governing\s+law|construed\s+in\s+accordance\s+with/i, 8, (q) => extractPlaces(q).size > 0 && !SCOPED_TO_EXHIBIT.test(q))
    .map((e) => ({ ev: e, places: [...extractPlaces(e.exact_quote)] }));
  if (laws.length >= 2) {
    const first = laws[0];
    const other = laws.find((x) => !x.places.some((p) => first.places.includes(p)) && x.ev.element_id !== first.ev.element_id);
    if (other) {
      a.addContradiction({
        rule_id: 'cross.governing_law_conflict',
        category: 'Dispute Resolution & Governing Law',
        title: 'Two different governing laws are stated',
        explanation: `One clause says the agreement is governed by the law of ${first.places.join(', ')}, while another says ${other.places.join(', ')}.`,
        sideA: [first.ev],
        sideB: [other.ev],
        patternBased: false,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 10. Warranties vs disclaimers, liability caps and indemnification
// ---------------------------------------------------------------------------
function warrantyConsistency(a: Analysis): void {
  // A blanket disclaimer next to an express guarantee. A disclaimer of "other" or non-express warranties
  // simply qualifies the express ones and is compatible.
  if (a.has('war_performance')) {
    const disclaimer = a.searchEvidence(
      /(as[- ]is|disclaims?\s+all\s+(other\s+)?warrant\w+|no\s+warrant(y|ies)|without\s+(any\s+)?warrant(y|ies))/i,
      1,
      (q) => !/(other than|except|expressly|set (forth|out)|provided in|other warranties|any other|implied)/i.test(q)
    );
    if (disclaimer.length > 0) {
      a.addContradiction({
        rule_id: 'cross.warranty_vs_disclaimer',
        category: 'Warranties',
        title: 'All warranties are disclaimed, yet an express guarantee is given',
        explanation: 'One clause says the work is provided as is and all warranties are disclaimed, while another has you warrant or guarantee its quality. It is unclear which applies.',
        sideA: disclaimer,
        sideB: ev(a, 'war_performance', /warrant|guarantee/i).slice(0, 1),
        severity: 'Medium',
      });
    }
  }

  // Warranty/repair remedies vs the liability cap
  const cap = factOrText(a, 'liability_cap', CAP_SENTENCE, NOT_LLC);
  if (cap) {
    const remedy = a.has('war_repair')
      ? { ev: ev(a, 'war_repair', /notwithstanding|regardless|limit|cap|unlimited|repair|correct/i).slice(0, 1), text: a.text(a.facts.war_repair) }
      : a.has('war_performance')
      ? { ev: ev(a, 'war_performance', /warrant|guarantee/i).slice(0, 1), text: a.text(a.facts.war_performance) }
      : (() => {
          const hit = a.searchEvidence(REMEDY_SENTENCE, 1);
          return hit.length ? { ev: hit, text: hit[0].exact_quote } : null;
        })();
    if (remedy && remedy.ev.length > 0) {
      const override = /(notwithstanding|regardless of|not (be )?subject to|without limit|unlimited)[^.]{0,60}(limit|cap)|(limit|cap)[^.]{0,60}(shall not apply|does not apply)/i.test(remedy.text);
      if (override) {
        if (/(warrant\w*|all claims|any and all claims)/i.test(cap.text) && CAP_COVERS_ALL.test(cap.text)) {
          a.addContradiction({
            rule_id: 'cross.warranty_vs_cap',
            category: 'Warranties',
            title: 'Warranty remedies are both limited by the liability cap and exempt from it',
            explanation: 'The liability cap says it covers warranty claims, while the warranty clause says its remedies apply regardless of any limit.',
            sideA: cap.ev,
            sideB: remedy.ev,
            severity: 'Medium',
          });
        } else {
          a.add({
            rule_id: 'warranty.outside_cap',
            category: 'Warranties',
            kind: 'RISK',
            severity: 'Medium',
            title: 'Warranty remedies sit outside the liability cap',
            explanation: 'The warranty clause applies its remedies regardless of any limit on liability, so the cap gives no protection for warranty claims.',
            why: 'Warranty claims can be large and the cap that would normally limit your exposure would not apply.',
            suggestion: 'Ask for warranty remedies to be limited to repair or refund of the fees for the affected work and to fall within the overall cap.',
            evidence: [...cap.ev, ...remedy.ev],
            patternBased: true,
          });
        }
      }
    }
  }
}

export function crossClauseRules(a: Analysis): void {
  paymentVsAcceptance(a);
  scopeVsChangeOrder(a);
  terminationVsPayment(a);
  ipVsPayment(a);
  capVsIndemnity(a);
  insuranceVsLiability(a);
  confidentialityVsSurvival(a);
  renewalVsTermination(a);
  financialConsistency(a);
  warrantyConsistency(a);
}
