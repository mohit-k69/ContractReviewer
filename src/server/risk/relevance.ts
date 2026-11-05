import type { Analysis } from './analysis';
import { extractPlaces } from '../understanding/conflictDetector';
import { FindingEvidence } from './types';

/**
 * Relevance gates for MISSING-provision findings.
 *
 * A missing clause is not automatically a risk. Each rule below says what in the contract makes its absence
 * matter. When nothing does, the result is an informational observation instead of a risk. The triggers are
 * facts stated in the contract (or wording found in its text), and the verified quote that triggered the gate is
 * returned so the report can cite it. No benchmark of what "other contracts usually contain" is used.
 */
export interface RelevanceResult {
  material: boolean;
  reason: string;
  evidence: FindingEvidence[];
}

type Gate = (a: Analysis) => RelevanceResult;

const yes = (reason: string, evidence: FindingEvidence[] = []): RelevanceResult => ({ material: true, reason, evidence });
const no = (reason: string): RelevanceResult => ({ material: false, reason, evidence: [] });

/** First fact (by key) that is established, with its evidence */
function firstFact(a: Analysis, keys: string[]): { key: string; evidence: FindingEvidence[] } | null {
  for (const key of keys) {
    if (a.has(key)) return { key, evidence: a.evidenceOf(a.facts[key]).slice(0, 1) };
  }
  return null;
}

function textTrigger(a: Analysis, pattern: RegExp): FindingEvidence[] {
  return a.searchEvidence(pattern, 1);
}

/** An established fact when there is one, otherwise matching wording in the contract text itself. */
function factOrText(a: Analysis, keys: string[], pattern: RegExp): FindingEvidence[] {
  return firstFact(a, keys)?.evidence ?? textTrigger(a, pattern);
}

const PAYS_WORDS = /(shall pay|will pay|payable|compensat\w+|\bfee\b)[^.]{0,80}(\$\s?\d|per hour|per day|per month|\brate\b)/i;
const DEADLINE_WORDS = /(\bnet\s*\d+|payable (within|in)|due within|within \w+\s*(\(\d+\)\s*)?(business\s+)?days? (of|after|from))/i;
const DISPUTE_WORDS = /(dispute|claim)s?[^.]{0,80}(courts?|arbitrat\w*|mediat\w*|jurisdiction|venue)/i;
const GOVERNING_WORDS = /(governed by|governing law|laws of (the )?(state|commonwealth|republic|england|india))/i;
const WORK_DUTY_WORDS = /\b(shall|will|agrees to)\s+(provide|deliver|perform|develop|design|build|create|implement|write)\b/i;

const PAYMENT_KEYS = ['fee_structure', 'rates', 'payment_terms', 'deal_pay_conditions'];
const DELIVERABLE_WORDS = /\b(deliverables?|work product|milestones?)\b/i;
const EXPOSURE_KEYS = ['indemnity_contractor', 'war_performance', 'war_outcome', 'war_repair', 'ins_pi', 'ins_gl', 'ins_cyber', 'dp_personal', 'sub_liability'];
const CONFIDENTIAL_WORDS = /(confidential|proprietary|trade secret|non-?public|client (data|information)|access to (the )?(client'?s|company'?s))/i;
const COST_WORDS = /\b(travel|expenses?|out-of-pocket|software licen[sc]es?|third[- ]party (costs|fees|services|tools)|equipment|materials)\b/i;

function hasDeliverables(a: Analysis): FindingEvidence[] {
  const listed = (a.u.scope_and_deliverables?.deliverables || []).find((d) => a.isEstablished(d));
  if (listed) return a.evidenceOf(listed).slice(0, 1);
  return textTrigger(a, DELIVERABLE_WORDS);
}

function exposure(a: Analysis): FindingEvidence[] {
  const f = firstFact(a, EXPOSURE_KEYS);
  if (f) return f.evidence;
  return textTrigger(a, /\b(damages|losses)\b/i);
}

function partiesInDifferentPlaces(a: Analysis): boolean {
  const places = (a.u.parties || []).map((p) => extractPlaces(p.address_or_location || ''));
  return places.length >= 2 && places.every((p) => p.size > 0) && ![...places[0]].some((p) => places[1].has(p));
}

const GATES: Record<string, Gate> = {
  // ---- payment
  'payment.no_fee': () => yes('Every engagement of paid services needs an agreed fee, and this contract states none.'),
  'payment.no_rate': (a) => {
    const f = firstFact(a, ['fee_structure']);
    return f ? yes('A fee structure is stated but no specific amount.', f.evidence) : no('No fee structure is stated either.');
  },
  'payment.no_deadline': (a) => {
    const ev = factOrText(a, ['rates', 'fee_structure', 'deal_pay_conditions'], PAYS_WORDS);
    return ev.length ? yes('The contract states what you are paid, so when it is paid matters.', ev) : no('The contract does not state any fee that a deadline would apply to.');
  },
  'payment.no_late_fee': (a) => {
    const ev = factOrText(a, ['payment_terms'], DEADLINE_WORDS);
    return ev.length ? yes('The contract sets a payment deadline but states no consequence if it is missed.', ev) : no('The contract states no payment deadline for a late-payment consequence to attach to.');
  },
  'payment.no_expenses': (a) => {
    const ev = textTrigger(a, COST_WORDS);
    const f = firstFact(a, ['wc_location', 'wc_equipment']);
    if (f) return yes('The contract directs where or with what you work, which can involve costs.', f.evidence);
    return ev.length ? yes('The contract mentions costs that expense terms would cover.', ev) : no('Nothing in the contract mentions costs, travel or materials.');
  },
  'payment.no_invoicing': (a) => {
    const ev = textTrigger(a, /\binvoic\w*/i);
    return ev.length ? yes('The contract refers to invoices but does not say when you invoice.', ev) : no('The contract does not refer to invoices.');
  },
  // ---- scope
  'scope.no_scope': () => yes('A description of the work is needed for any engagement.'),
  'scope.no_change_order': (a) => {
    // The scope fact alone is not trusted (an extractor may take a heading for it): require described work
    const f = firstFact(a, ['obl_revisions']);
    if (f) return yes('The contract provides for revisions, so a change process matters.', f.evidence);
    const d = hasDeliverables(a);
    if (d.length) return yes('The contract refers to deliverables that could change.', d);
    const duty = textTrigger(a, WORK_DUTY_WORDS);
    return duty.length ? yes('The contract has you perform work that could change.', duty) : no('The contract describes no work that a change process would apply to.');
  },
  'scope.no_acceptance': (a) => {
    const d = hasDeliverables(a);
    const f = firstFact(a, ['deal_pay_conditions', 'deal_milestones']);
    if (f) return yes('Payment or milestones depend on the work, so how it is accepted matters.', f.evidence);
    return d.length ? yes('The contract refers to deliverables whose acceptance is not defined.', d) : no('The contract refers to no deliverables or milestones that need acceptance.');
  },
  // ---- termination
  'termination.no_convenience': (a) => {
    const f = firstFact(a, ['ren_auto', 'ren_unilateral']);
    if (f) return yes('The contract renews or can be extended, so being able to leave matters.', f.evidence);
    const endStated = a.searchHas(/(expir\w*|ends?|ending)\s+(on|at|by)\s|\bterm of\s+(\w+\s*)?(\(\d+\)\s*)?(months?|years?)|for an? (initial )?(term|period) of/i);
    const noEnd = a.isMissing(a.facts.term_duration) && a.isMissing(a.facts.expiration_date) && !endStated;
    return noEnd ? yes('The contract states no end date, so exit rights decide how it can end.') : no('The contract has a stated end and no renewal, so a general exit right is less likely to matter.');
  },
  'termination.no_final_payment': (a) => {
    const ev = factOrText(a, ['term_convenience', 'term_cause', 'deal_contractor_term'], /\b(may|can|shall have the right to)\s+terminate\b/i);
    return ev.length ? yes('The contract provides for termination but not for payment of work already done.', ev) : no('The contract has no termination terms that a payment-on-termination rule would attach to.');
  },
  // ---- IP
  'ip.no_ownership': (a) => {
    const d = hasDeliverables(a);
    const ev = d.length ? d : textTrigger(a, /\b(developed|created|designs?|software|code|content)\b/i);
    return ev.length ? yes('The contract has you create work, so who owns it matters.', ev) : no('The contract describes no work product whose ownership is in question.');
  },
  'ip.no_preexisting': (a) => {
    const f = firstFact(a, ['ip_ownership']);
    const d = hasDeliverables(a);
    if (f) return yes('The contract assigns ownership of work, so the treatment of your existing materials matters.', f.evidence);
    return d.length ? yes('The contract has you create deliverables that may incorporate your existing materials.', d) : no('Neither an ownership clause nor deliverables are present.');
  },
  // ---- liability
  'liability.no_cap': (a) => {
    const ev = exposure(a);
    return ev.length ? yes('The contract exposes you to claims or losses, so a limit on liability matters.', ev) : no('Nothing in the contract creates a liability exposure that a cap would limit.');
  },
  'liability.no_indirect_exclusion': (a) => {
    const ev = exposure(a);
    return ev.length ? yes('The contract exposes you to claims or losses, so excluding indirect losses matters.', ev) : no('Nothing in the contract creates a liability exposure.');
  },
  'liability.no_client_indemnity': (a) => {
    const f = firstFact(a, ['indemnity_contractor']);
    return f ? yes('You give the client an indemnity but receive none.', f.evidence) : no('You give no indemnity.');
  },
  // ---- confidentiality
  'confidentiality.no_clause': (a) => {
    const ev = textTrigger(a, CONFIDENTIAL_WORDS);
    return ev.length ? yes('The contract refers to confidential or proprietary information that has no confidentiality terms.', ev) : no('The contract refers to no confidential or proprietary information.');
  },
  'confidentiality.no_exclusions': (a) => {
    const f = firstFact(a, ['conf_definition']);
    return f ? yes('A confidentiality duty exists without any stated limits on what it covers.', f.evidence) : no('There is no confidentiality duty to limit.');
  },
  // ---- disputes
  'dispute.no_governing_law': (a) => {
    const dispute = factOrText(a, ['venue', 'dispute_method'], DISPUTE_WORDS);
    if (dispute.length) return yes('The contract has dispute terms but does not say which law applies.', dispute);
    if (partiesInDifferentPlaces(a)) return yes('The parties appear to be in different places, so which law applies is a real question.');
    const ev = exposure(a);
    return ev.length ? yes('The contract creates liability exposure, so which law governs it matters.', ev) : no('Nothing in the contract makes the choice of law relevant.');
  },
  'dispute.no_process': (a) => {
    const law = factOrText(a, ['governing_law'], GOVERNING_WORDS);
    if (law.length) return yes('A governing law is stated but not how disputes are resolved.', law);
    const ev = exposure(a);
    return ev.length ? yes('The contract creates liability exposure, so how disputes are resolved matters.', ev) : no('Nothing in the contract makes a dispute process relevant.');
  },
  // ---- gated by their own context (kept explicit so none is "ungated")
  'data.no_breach_notification': (a) => yes('The contract involves personal or customer data.', firstFact(a, ['dp_personal'])?.evidence ?? textTrigger(a, /personal (data|information)|customer data/i)),
  'data.no_security_standard': (a) => yes('The contract involves personal or customer data.', firstFact(a, ['dp_personal'])?.evidence ?? []),
  'data.no_return_deletion': (a) => yes('The contract involves personal or customer data.', firstFact(a, ['dp_personal'])?.evidence ?? []),
  'data.no_purpose_limit': (a) => yes('The contract involves personal or customer data.', firstFact(a, ['dp_personal'])?.evidence ?? []),
  'data.no_processing_agreement': (a) => yes('The contract involves personal data.', firstFact(a, ['dp_personal'])?.evidence ?? []),
  'data.no_subcontractor_data_terms': (a) => yes('Subcontracting is allowed and the contract involves data.', firstFact(a, ['sub_permission', 'sub_approval'])?.evidence ?? []),
  'insurance.no_limits': (a) => yes('The contract requires insurance.', firstFact(a, ['ins_pi', 'ins_gl', 'ins_cyber'])?.evidence ?? []),
  'subcontracting.no_responsibility': (a) => yes('Subcontracting is allowed.', firstFact(a, ['sub_permission', 'sub_approval'])?.evidence ?? []),
  'subcontracting.no_flowdown': (a) => yes('Subcontracting is allowed and the contract has confidentiality or data duties.', firstFact(a, ['sub_permission', 'sub_approval'])?.evidence ?? []),
  'tax.basis_unclear': (a) => yes('The contract mentions VAT, GST or sales tax.', firstFact(a, ['tax_indirect'])?.evidence ?? []),
  'tax.no_allocation': (a) => yes('The contract states fees but says nothing about tax.', firstFact(a, ['rates', 'fee_structure'])?.evidence ?? []),
  'renewal.no_notice_period': (a) => yes('The contract renews automatically.', firstFact(a, ['ren_auto'])?.evidence ?? []),
  'renewal.no_duration': (a) => yes('The contract renews automatically.', firstFact(a, ['ren_auto'])?.evidence ?? []),
  'warranty.no_duration': (a) => yes('The contract gives a guarantee or repair obligation.', firstFact(a, ['war_performance', 'war_repair'])?.evidence ?? []),
};

/** Rule ids that have an explicit relevance gate (a test asserts no missing-provision rule is ungated). */
export const GATED_RULES = Object.keys(GATES);

export function relevanceFor(ruleId: string, a: Analysis): RelevanceResult & { gated: boolean } {
  const gate = GATES[ruleId];
  if (!gate) return { material: true, reason: 'ungated', evidence: [], gated: false };
  return { ...gate(a), gated: true };
}
