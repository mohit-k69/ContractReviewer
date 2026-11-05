import { extractAmounts, extractDurations, extractPlaces } from '../understanding/conflictDetector';
import { Analysis, max, statedPeriod, toDays, toMonths } from './analysis';
import { FindingEvidence, RiskSeverity } from './types';

/**
 * Rules for the contractor-intelligence areas: worker classification, data protection, insurance,
 * subcontracting, tax, renewal and warranties.
 *
 * Principles shared by every rule here:
 *  - A RISK needs an established fact (status FOUND + at least one verified quote).
 *  - A MISSING_PROVISION is only reported when the whole document was analyzed AND the context makes the
 *    provision relevant (e.g. data terms only when the contract involves data). Absence alone is not a risk.
 *  - Nothing is concluded as law: findings say "terms to clarify", never "illegal" or "misclassified".
 */

const bump = (s: RiskSeverity): RiskSeverity => (s === 'Low' ? 'Medium' : 'High');

const ev = (a: Analysis, key: string, focus?: RegExp): FindingEvidence[] =>
  focus ? a.evidenceFocused(focus, a.facts[key]) : a.evidenceOf(a.facts[key]);

const monthsIn = (text: string): number | undefined => max(toMonths(extractDurations(text)));
const daysIn = (text: string): number | undefined => max(toDays(extractDurations(text)));
const hoursIn = (text: string): number | undefined => {
  const hours = [...extractDurations(text)].filter((v) => v.endsWith(' hours')).map((v) => parseFloat(v));
  return hours.length ? Math.min(...hours) : undefined;
};
const PERPETUAL = /perpetual|in perpetuity|indefinite|lifetime|forever|without (time )?limit/;

// ---------------------------------------------------------------------------
// 1. Worker classification: indicators are assessed TOGETHER
// ---------------------------------------------------------------------------

const INDICATORS: Array<{ key: string; label: string; control: boolean }> = [
  { key: 'wc_hours', label: 'prescribed working hours', control: true },
  { key: 'wc_location', label: 'a mandatory work location', control: false },
  { key: 'wc_supervision', label: 'direct supervision over how the work is done', control: true },
  { key: 'wc_exclusivity', label: 'exclusivity or a bar on working for other clients', control: false },
  { key: 'wc_no_delegation', label: 'a requirement to perform the work personally (no delegation or subcontracting)', control: false },
  { key: 'wc_equipment', label: 'mandatory use of client-provided equipment', control: false },
  { key: 'wc_business', label: 'restrictions on running an independent business', control: false },
  { key: 'wc_control', label: 'client control over when and how the services are performed', control: true },
];

// Places where stricter, "ABC-style" tests are widely applied for some purposes. This only raises the
// attention level; it is not a legal conclusion and says nothing about how any authority would rule.
const STRICTER_TEST_PLACES = new Set(['california', 'massachusetts', 'new jersey']);

export function workerClassificationRules(a: Analysis): void {
  const active = INDICATORS.filter((d) => a.has(d.key));
  if (active.length === 0) return;
  const controlCount = active.filter((d) => d.control).length;

  // Explicit, explainable rule (no numeric score): more distinct indicators and more control-type
  // indicators raise the attention level. One non-control indicator alone is not reported.
  let severity: RiskSeverity | null = null;
  if (active.length >= 4 || (active.length >= 3 && controlCount >= 2)) severity = 'High';
  else if (active.length >= 2) severity = 'Medium';
  else if (controlCount === 1) severity = 'Low';
  if (!severity) return;

  const places = extractPlaces(a.text(a.facts.governing_law, false));
  const stricter = [...places].filter((p) => STRICTER_TEST_PLACES.has(p));
  let jurisdictionNote: string;
  if (places.size === 0) {
    jurisdictionNote = 'No governing law was identified, so jurisdiction-specific classification tests could not be considered.';
  } else {
    jurisdictionNote = `The governing-law clause names ${[...places].join(', ')}. Classification tests differ by place and by purpose (tax, employment law, benefits), and a governing-law clause does not decide how an authority would classify the work.`;
    if (stricter.length > 0 && active.length >= 2) {
      severity = bump(severity);
      jurisdictionNote += ` ${stricter.map((p) => p[0].toUpperCase() + p.slice(1)).join(' and ')} is a place where stricter tests are commonly applied for some purposes, so this is raised for attention.`;
    }
  }

  const affirmationFact = a.u.key_provisions?.independent_contractor_affirmation;
  const affirmed = a.isEstablished(affirmationFact);
  const affirmation = affirmed ? a.evidenceOf(affirmationFact) : [];

  const evidence: FindingEvidence[] = [];
  for (const d of active) evidence.push(...ev(a, d.key).slice(0, 1));
  if (affirmed) evidence.push(...affirmation.slice(0, 1));

  const list = active.map((d) => d.label).join('; ');
  a.add({
    rule_id: 'classification.indicators',
    category: 'Worker Classification',
    kind: 'RISK',
    severity,
    title:
      active.length === 1
        ? 'A term resembles employer control'
        : `Several terms resemble employer control (${active.length} indicators)`,
    explanation:
      active.length === 1
        ? `The contract contains a term that resembles how an employer controls an employee: ${list}. On its own this does not settle your status.`
        : `The contract contains ${active.length} terms that resemble how an employer controls an employee: ${list}.${
            affirmed ? ' It also says you are an independent contractor, so the label and the day-to-day terms point in different directions.' : ''
          } No single term decides worker status, so these were assessed together. This is a possible worker-classification concern, not a conclusion.`,
    why: 'Whether you are treated as an independent contractor or an employee can affect your taxes, benefits, insurance and legal protections, and it turns on how the relationship works in practice as well as on the contract label.',
    suggestion:
      'Ask whether each control is necessary for the project. Consider asking for wording that you decide how and when the work is done, may use your own equipment, may work for other clients and may use helpers. If several of these apply to you in practice, consider checking how your local tax or labour authority would classify the arrangement.',
    evidence,
    patternBased: true,
    uncertainty: jurisdictionNote,
  });
}

// ---------------------------------------------------------------------------
// 2. Data protection & security (missing provisions only when relevant)
// ---------------------------------------------------------------------------

const DATA_CONTEXT =
  /(personal (data|information)|customer (data|records)|user data|\bpii\b|health (data|information|records)|payment card|cardholder|\bgdpr\b|\bccpa\b|\bhipaa\b|access to[^.]{0,40}(production|customer|client)\s+(systems|data|database))/i;
const SENSITIVE_DATA = /(health|medical|payment card|cardholder|financial account|biometric|children|special categor)/i;

export function dataProtectionRules(a: Analysis): void {
  const c = 'Data Protection & Security' as const;
  const handles = a.has('dp_personal');
  // Relevant only when the contract says (or its text shows) that the contractor deals with data
  const relevant = handles || a.searchHas(DATA_CONTEXT);
  const sensitive = a.searchHas(SENSITIVE_DATA);

  if (relevant && a.fullCoverage) {
    if (a.isMissing(a.facts.dp_breach)) {
      a.add({
        rule_id: 'data.no_breach_notification',
        category: c, kind: 'MISSING_PROVISION', severity: sensitive ? 'High' : 'Medium',
        title: 'No data breach notification terms',
        explanation: 'The contract involves personal or customer data but does not say whether, when or how a data breach must be reported.',
        why: 'Without a defined process you may not know what is expected if something goes wrong, and a late or missing notice could later be argued to be a breach.',
        suggestion: 'Ask for a clear notification process: who to notify, what counts as an incident, and a realistic deadline (for example 72 hours from discovery).',
        searched: 'data breach notification',
      });
    }
    if (a.isMissing(a.facts.dp_security)) {
      a.add({
        rule_id: 'data.no_security_standard',
        category: c, kind: 'MISSING_PROVISION', severity: sensitive ? 'Medium' : 'Low',
        title: 'No data security standard stated',
        explanation: 'The contract involves data but does not say what security measures you must apply.',
        why: 'An unstated standard makes it hard to know whether you are compliant and invites later disputes about what was “reasonable”.',
        suggestion: 'Ask which security measures are required (for example encryption and access controls) so you can confirm you can meet them.',
        searched: 'data security obligations',
      });
    }
    if (a.isMissing(a.facts.dp_return)) {
      a.add({
        rule_id: 'data.no_return_deletion',
        category: c, kind: 'MISSING_PROVISION', severity: 'Medium',
        title: 'No return or deletion of data after the engagement',
        explanation: 'The contract involves data but does not say what happens to it when the engagement ends.',
        why: 'Without a rule you may keep client data longer than you should, or be asked to delete it in a way you cannot verify.',
        suggestion: 'Ask for a clear return-or-delete obligation with a reasonable time limit and what proof you must give.',
        searched: 'return or deletion of data',
      });
    }
    if (a.isMissing(a.facts.dp_purposes)) {
      a.add({
        rule_id: 'data.no_purpose_limit',
        category: c, kind: 'MISSING_PROVISION', severity: 'Medium',
        title: 'No limit on what the data may be used for',
        explanation: 'The contract involves data but does not say what purposes you may use it for.',
        why: 'Without a stated purpose it is unclear which uses are allowed, which matters if the data is personal.',
        suggestion: 'Ask for a statement that the data is used only to perform the services, so you know where the boundaries are.',
        searched: 'permitted purposes for data',
      });
    }
    if (a.isMissing(a.facts.dp_agreement) && (handles || a.searchHas(/\bgdpr\b|\bccpa\b|controller|processor/i))) {
      a.add({
        rule_id: 'data.no_processing_agreement',
        category: c, kind: 'MISSING_PROVISION', severity: handles ? 'Medium' : 'Low',
        title: 'No data processing agreement or role allocation',
        explanation: 'The contract involves personal data but does not include or refer to a data processing agreement, or say who is the controller and who is the processor.',
        why: 'Some data-protection laws expect a written agreement when one party handles personal data for another. Whether one is required depends on where the people and parties are.',
        suggestion: 'Ask whether a data processing agreement is needed and, if so, to have it attached before you start handling data.',
        searched: 'a data processing agreement',
      });
    }
    const subsAllowed = a.has('sub_permission') || a.has('sub_approval');
    // A flow-down clause that binds subcontractors to data/confidentiality terms already addresses their data access
    if (subsAllowed && !a.has('sub_flowdown') && a.isMissing(a.facts.dp_third_party)) {
      a.add({
        rule_id: 'data.no_subcontractor_data_terms',
        category: c, kind: 'MISSING_PROVISION', severity: 'Medium',
        title: 'Subcontractor access to data is not addressed',
        explanation: 'Subcontracting is allowed, but the contract does not say whether subcontractors may access the data or on what terms.',
        why: 'You may stay responsible for what your helpers do with client data, so unclear rules put the risk on you.',
        suggestion: 'Ask whether subcontractors may access the data, and if so what they must agree to first.',
        searched: 'subcontractor access to data',
      });
    }
  }

  // Terms that ARE stated
  if (a.has('dp_breach')) {
    const hours = hoursIn(a.text(a.facts.dp_breach, false)) ?? hoursIn(a.text(a.facts.dp_breach));
    if (hours !== undefined && hours <= 24) {
      a.add({
        rule_id: 'data.short_breach_deadline',
        category: c, kind: 'RISK', severity: 'Medium',
        title: `Very short breach notification deadline (${hours} hours)`,
        explanation: `You must report a data breach within ${hours} hours.`,
        why: 'A deadline this short can be hard to meet for an individual, especially if you only learn of the problem later.',
        suggestion: 'Ask for the clock to start from when you become aware of the breach, and for a more workable window such as 72 hours.',
        evidence: ev(a, 'dp_breach', /hours?/i),
      });
    }
  }
  if (a.has('dp_security') && /(guarantee|ensure|warrant)[^.]{0,40}(no|absolute|security|breach)|highest (standard|level)|state[- ]of[- ]the[- ]art|zero (risk|incidents)|strict liability|absolutely/.test(a.text(a.facts.dp_security))) {
    a.add({
      rule_id: 'data.open_ended_security_standard',
      category: c, kind: 'RISK', severity: 'Medium',
      title: 'Security standard is open-ended or absolute',
      explanation: 'The security obligation is framed as a guarantee or the highest possible standard instead of a defined set of measures.',
      why: 'No system is perfectly secure, so an absolute standard can make you responsible for any incident, however it happened.',
      suggestion: 'Ask to replace it with a defined list of measures or a recognised standard that you can realistically meet.',
      evidence: ev(a, 'dp_security', /guarantee|ensure|warrant|highest|state[- ]of[- ]the[- ]art|absolute/i),
      patternBased: true,
    });
  }
  const breachLiability = a.searchEvidence(
    /(data|security)\s+breach[^.]{0,100}(indemnif|liab|reimburse|costs)[^.]{0,100}(unlimited|without limit|not (be )?subject to|in addition to|notwithstanding)/i,
    1
  );
  if (breachLiability.length > 0) {
    a.add({
      rule_id: 'data.uncapped_breach_liability',
      category: c, kind: 'RISK', severity: 'High',
      title: 'Data breach liability sits outside any cap',
      explanation: 'A data or security breach is described as giving rise to liability or indemnity that is unlimited or not subject to the liability cap.',
      why: 'A single incident could cost far more than the project is worth, and personal-data incidents can be expensive.',
      suggestion: 'Ask for breach liability to be subject to a cap (for example a multiple of fees) and consider whether insurance is available to cover it.',
      evidence: breachLiability,
      patternBased: true,
    });
  }
  if (a.has('dp_cross_border')) {
    const restrictive = /(shall not|may not|must not|prohibit|not (be )?(permitted|allowed))[^.]{0,80}(transfer|export|store|process|host)|data (residency|localization|localisation)|(shall|must)\s+(remain|be stored|be hosted)\s+(in|within)/.test(a.text(a.facts.dp_cross_border));
    a.add({
      rule_id: 'data.cross_border_terms',
      category: c, kind: 'RISK', severity: restrictive ? 'Medium' : 'Low',
      title: restrictive ? 'Restrictions on where data may be stored or processed' : 'Cross-border data transfer terms apply',
      explanation: restrictive
        ? 'The contract limits where data may be stored or processed, which can affect the tools and hosting you may use.'
        : 'The contract contains terms about transferring data across borders.',
      why: 'International transfers are regulated in many places, and cloud tools or collaborators abroad may be covered without you realising.',
      suggestion: 'Ask which locations and tools are acceptable, and whether any transfer mechanism (for example standard contractual clauses) is expected from you.',
      evidence: ev(a, 'dp_cross_border'),
      patternBased: true,
    });
  }
}

// ---------------------------------------------------------------------------
// 3. Insurance (never assumes every contractor needs every cover)
// ---------------------------------------------------------------------------

const INSURANCE_TYPES: Array<{ key: string; label: string }> = [
  { key: 'ins_pi', label: 'professional indemnity' },
  { key: 'ins_gl', label: 'general liability' },
  { key: 'ins_cyber', label: 'cyber' },
];

export function largestAmount(text: string): number | undefined {
  const amounts = [...extractAmounts(text)]
    .filter((v) => v.endsWith(' amount'))
    .map((v) => parseFloat(v));
  return amounts.length ? Math.max(...amounts) : undefined;
}

export function insuranceRules(a: Analysis): void {
  const c = 'Insurance' as const;
  const required = INSURANCE_TYPES.filter((t) => a.has(t.key));
  if (required.length === 0) return; // nothing required: nothing to assess

  const coverage = a.has('ins_min') ? largestAmount(a.text(a.facts.ins_min)) : undefined;

  // Engagement size is only known when the contract states a fixed fee
  const feeSentences = a
    .searchEvidence(/(fixed|flat|lump[- ]sum|project)\s+(fee|price)[^.]{0,40}(\$|usd\s?|eur\s?|£|€)\s?\d/i, 3)
    .map((e) => e.exact_quote)
    .join(' ');
  const fixedFees = [...extractAmounts(`${a.text(a.facts.rates, false)} ${a.text(a.facts.fee_structure, false)} ${feeSentences}`)]
    .filter((v) => v.endsWith(' fixed'))
    .map((v) => parseFloat(v));
  const engagement = fixedFees.length ? Math.max(...fixedFees) : undefined;

  let disproportion: { severity: RiskSeverity; reason: string } | null = null;
  if (coverage !== undefined && engagement !== undefined && engagement > 0 && coverage >= engagement * 25) {
    disproportion = {
      severity: coverage >= engagement * 100 ? 'High' : 'Medium',
      reason: `The required limits ($${coverage.toLocaleString('en-US')}) are about ${Math.round(coverage / engagement)} times the fixed fee ($${engagement.toLocaleString('en-US')}).`,
    };
  } else if (coverage !== undefined && engagement === undefined && (coverage >= 5_000_000 || (coverage >= 2_000_000 && required.length >= 3))) {
    disproportion = {
      severity: 'Medium',
      reason: `The required limits are high ($${coverage.toLocaleString('en-US')}${required.length >= 3 ? ' for each of three types of cover' : ''}) and the contract does not state an engagement value to compare them against.`,
    };
  }
  if (disproportion) {
    a.add({
      rule_id: 'insurance.disproportionate',
      category: c, kind: 'RISK', severity: disproportion.severity,
      title: 'Insurance requirements may be out of proportion to the engagement',
      explanation: `${disproportion.reason} Premiums for cover at these levels can be significant for an individual or small business.`,
      why: 'You would pay for the insurance yourself, so oversized requirements can erase much of your margin or make the engagement uneconomic.',
      suggestion: 'Ask whether lower limits would do, or whether the client will contribute to the cost or accept the cover you already hold.',
      evidence: [...ev(a, 'ins_min'), ...required.flatMap((t) => ev(a, t.key).slice(0, 1))],
      patternBased: true,
      uncertainty: 'Whether the limits are excessive depends on the size of the engagement, which may not be fully stated in the contract.',
    });
  }
  if (a.has('ins_cyber') && !a.has('dp_personal') && !a.searchHas(DATA_CONTEXT)) {
    a.add({
      rule_id: 'insurance.cyber_without_data',
      category: c, kind: 'RISK', severity: 'Low',
      title: 'Cyber insurance required although no data handling is described',
      explanation: 'The contract requires cyber insurance, but nothing in it indicates you handle personal or sensitive data.',
      why: 'Cyber cover is an extra cost, and it is worth confirming it is really needed for this work.',
      suggestion: 'Ask what risk the cyber cover is meant to address and whether it is needed for this engagement.',
      evidence: ev(a, 'ins_cyber'),
      patternBased: true,
    });
  }
  if (a.has('ins_post')) {
    const months = monthsIn(a.text(a.facts.ins_post, false)) ?? monthsIn(a.text(a.facts.ins_post));
    const long = months === undefined || PERPETUAL.test(a.text(a.facts.ins_post)) || months >= 36;
    a.add({
      rule_id: 'insurance.post_termination',
      category: c, kind: 'RISK', severity: long ? 'Medium' : 'Low',
      title: 'Insurance must continue after the contract ends',
      explanation: months === undefined
        ? 'You must keep insurance in place after termination, and no end date is stated.'
        : `You must keep insurance in place for ${statedPeriod(a.text(a.facts.ins_post, false)) ?? statedPeriod(a.text(a.facts.ins_post)) ?? 'a stated period'} after termination.`,
      why: 'Premiums continue after the income stops, so a long or open-ended tail is a real cost.',
      suggestion: 'Ask for a defined end date (for example 12 months after termination) or to allow a one-off extended reporting period.',
      evidence: ev(a, 'ins_post'),
      patternBased: true,
    });
  }
  if (a.has('ins_additional')) {
    a.add({
      rule_id: 'insurance.additional_insured',
      category: c, kind: 'RISK', severity: 'Low',
      title: 'Client must be named as an additional insured',
      explanation: 'You must name the client as an additional insured (or waive your insurer’s rights against it).',
      why: 'Not every policy allows this, and it can add cost or need an endorsement from your insurer.',
      suggestion: 'Check with your insurer that you can provide this, and ask whether it is needed for this engagement.',
      evidence: ev(a, 'ins_additional'),
      patternBased: true,
    });
  }
  if (a.isMissing(a.facts.ins_min)) {
    a.add({
      rule_id: 'insurance.no_limits',
      category: c, kind: 'MISSING_PROVISION', severity: 'Medium',
      title: 'Insurance is required but no minimum limits are stated',
      explanation: `The contract requires ${required.map((t) => t.label).join(', ')} insurance but does not state any minimum coverage limits.`,
      why: 'Without stated limits you cannot price the cover, and the client could later ask for more than you expected.',
      suggestion: 'Ask for the required limits for each type of cover to be written into the contract.',
      searched: 'minimum insurance limits',
    });
  }

  // One informational summary so every requirement is visible together
  const parts = [
    `${required.map((t) => t.label).join(', ')} insurance`,
    coverage !== undefined ? `minimum limits of $${coverage.toLocaleString('en-US')}` : null,
    a.has('ins_additional') ? 'additional-insured status' : null,
    a.has('ins_evidence') ? 'certificates of insurance' : null,
    a.has('ins_post') ? 'cover after termination' : null,
  ].filter(Boolean);
  a.add({
    rule_id: 'insurance.requirements',
    category: c, kind: 'RISK', severity: 'Low',
    title: 'Insurance obligations to check',
    explanation: `The contract requires you to carry or provide: ${parts.join('; ')}.`,
    why: 'These are costs and paperwork you carry, and your existing policies may not already meet them.',
    suggestion: 'Check each requirement against the cover you hold and get a quote for anything missing before you agree.',
    evidence: [...required.flatMap((t) => ev(a, t.key).slice(0, 1)), ...ev(a, 'ins_evidence').slice(0, 1)],
    patternBased: true,
  });
}

// ---------------------------------------------------------------------------
// 4. Subcontracting & delegation
// ---------------------------------------------------------------------------

const REASONABLE_APPROVAL = /not (be )?unreasonably (withheld|delayed|conditioned)|deemed (approved|consented)|within\s+\w+\s*(\(\d+\)\s*)?(business )?days/;
const EXCESSIVE_APPROVAL = /(sole|absolute)\s+discretion|for any reason|each (task|instance|subcontractor)|every (task|instance)|may withhold (its )?(consent|approval)/;
const QUALIFIED_PERMISSION = /(subject to|except|unless|provided that|with\s+(the\s+)?(client'?s\s+|company'?s\s+)?(prior\s+)?(written\s+)?(consent|approval))/;

export function subcontractingRules(a: Analysis): void {
  const c = 'Subcontracting & Delegation' as const;

  if (a.has('sub_prohibition')) {
    a.add({
      rule_id: 'subcontracting.absolute_ban',
      category: c, kind: 'RISK', severity: 'Medium',
      title: 'Subcontracting and delegation are banned outright',
      explanation: 'The contract prohibits subcontracting or delegating any of the work and gives no way to ask for permission.',
      why: 'You cannot bring in help for peaks, holidays or specialist tasks, and a ban on delegation can also be one of the factors considered when worker status is assessed.',
      suggestion: 'Ask for a route to approval, for example “with the client’s prior written consent, not to be unreasonably withheld”.',
      evidence: ev(a, 'sub_prohibition'),
      patternBased: true,
    });
  }
  if (a.has('sub_approval')) {
    const text = a.text(a.facts.sub_approval);
    if (EXCESSIVE_APPROVAL.test(text) && !REASONABLE_APPROVAL.test(text)) {
      a.add({
        rule_id: 'subcontracting.excessive_approval',
        category: c, kind: 'RISK', severity: 'Medium',
        title: 'Approval to subcontract is at the client’s discretion',
        explanation: 'Subcontracting needs the client’s approval, and the approval is at its sole discretion or needed for every task.',
        why: 'A discretionary approval can work as a ban in practice and gives you no way to plan around it.',
        suggestion: 'Ask for approval not to be unreasonably withheld, and to be treated as given if the client does not respond within a set period.',
        evidence: ev(a, 'sub_approval'),
        patternBased: true,
      });
    }
    // A reasonable approval requirement (consent not unreasonably withheld, deemed approval, set response time)
    // is deliberately NOT reported: it is a normal safeguard.
  }

  const allowed = a.has('sub_permission') || a.has('sub_approval');
  if (allowed && a.fullCoverage) {
    if (a.isMissing(a.facts.sub_responsibility)) {
      a.add({
        rule_id: 'subcontracting.no_responsibility',
        category: c, kind: 'MISSING_PROVISION', severity: 'Low',
        title: 'Responsibility for subcontractors is not stated',
        explanation: 'Subcontracting is allowed, but the contract does not say who answers for a subcontractor’s work.',
        why: 'You may be treated as responsible for the people you bring in, so it helps to know the extent in advance.',
        suggestion: 'Ask for the contract to say that you remain responsible for subcontractor performance, and to confirm the limits on that responsibility.',
        searched: 'responsibility for subcontractors',
      });
    }
    if (a.isMissing(a.facts.sub_flowdown) && (a.has('conf_definition') || a.has('dp_personal'))) {
      a.add({
        rule_id: 'subcontracting.no_flowdown',
        category: c, kind: 'MISSING_PROVISION', severity: 'Medium',
        title: 'Subcontractors are not required to follow the confidentiality or data terms',
        explanation: 'Subcontracting is allowed and the contract has confidentiality or data obligations, but it does not say that subcontractors must be bound by them.',
        why: 'You stay responsible for what a subcontractor discloses, so you need your helpers bound by the same terms.',
        suggestion: 'Ask for wording that subcontractors must sign written terms at least as protective as yours, and keep copies.',
        searched: 'subcontractor confidentiality and data obligations',
      });
    }
  }
  if (a.has('sub_liability') && /(unlimited|any and all|without limit|jointly and severally)/.test(a.text(a.facts.sub_liability))) {
    a.add({
      rule_id: 'subcontracting.broad_liability',
      category: c, kind: 'RISK', severity: 'Medium',
      title: 'Broad liability for subcontractors’ actions',
      explanation: 'You are liable for subcontractors’ actions without limit or in broad terms.',
      why: 'You may be liable for what a helper does even when you could not have prevented it.',
      suggestion: 'Ask for this liability to sit within the overall liability cap and to cover only subcontractors you chose.',
      evidence: ev(a, 'sub_liability'),
      patternBased: true,
    });
  }

  // Personal-service requirement vs an unqualified permission to delegate: a genuine contradiction.
  // A permission that is itself conditional (consent, "subject to") qualifies the ban rather than contradicting it.
  // Only an ABSOLUTE personal-service requirement or ban conflicts with an unconditional permission;
  // "key personnel may be replaced with consent" is itself conditional and does not.
  const ABSOLUTE_PERSONAL = /(personally|in person|personal services|(shall|may|must) not (delegate|subcontract|sub-contract|assign|outsource)|no (subcontractors|delegation))/;
  const personal = a.has('sub_prohibition')
    ? ev(a, 'sub_prohibition')
    : a.has('wc_no_delegation') && ABSOLUTE_PERSONAL.test(a.text(a.facts.wc_no_delegation, false))
    ? ev(a, 'wc_no_delegation')
    : [];
  if (personal.length > 0 && a.has('sub_permission') && !QUALIFIED_PERMISSION.test(a.text(a.facts.sub_permission, false))) {
    a.addContradiction({
      rule_id: 'subcontracting.personal_service_vs_delegation',
      category: c,
      title: 'The contract both requires personal performance and allows subcontracting',
      explanation: 'One clause requires you to perform the work personally (or bans subcontracting), while another says you may engage subcontractors or assistants, with no condition tying the two together.',
      sideA: personal.slice(0, 1),
      sideB: ev(a, 'sub_permission', /may|permitted|free|entitled|engage|retain|hire/i).slice(0, 1),
      severity: 'Medium',
    });
  }
}

// ---------------------------------------------------------------------------
// 5. Tax & commercial (no assumption about any country's rules)
// ---------------------------------------------------------------------------

const INCLUSIVE = /(inclusive of|including)\s+(all\s+)?(applicable\s+)?(taxes|vat|gst|sales tax)|taxes?\s+(are|is|shall be)\s+included|all[- ]inclusive/i;
const EXCLUSIVE = /(exclusive of|exclud(e|es|ing)|plus|net of)\s+(all\s+)?(applicable\s+)?(taxes|vat|gst|sales tax)|taxes?\s+(are|is|shall be)\s+(excluded|additional|extra)|(vat|gst|sales tax)\s+(will|shall)\s+be\s+(added|charged|invoiced|paid)/i;

export function taxRules(a: Analysis): void {
  const c = 'Tax' as const;
  const NOT_TAX_ADVICE = 'This is not tax advice, and no assumption is made about the tax rules of any country.';

  if (a.has('tax_indemnity')) {
    const broad = /(any and all|all)\s+(taxes|liabilit)|penalt|interest|assessed against (the )?(client|company)|client'?s\s+(own\s+)?tax/.test(a.text(a.facts.tax_indemnity));
    a.add({
      rule_id: 'tax.indemnification',
      category: c, kind: 'RISK', severity: broad ? 'High' : 'Medium',
      title: broad ? 'Broad tax indemnity in the client’s favour' : 'You must indemnify the client for taxes',
      explanation: broad
        ? 'You agree to cover the client for taxes, penalties or interest that are assessed against it, which may go beyond your own tax.'
        : 'You agree to indemnify the client for tax-related losses.',
      why: 'The client’s tax position is not under your control, so an open indemnity can expose you to amounts you cannot predict. ' + NOT_TAX_ADVICE,
      suggestion: 'Ask to limit it to taxes that are genuinely your own responsibility, to exclude the client’s own taxes, and to cap it.',
      evidence: ev(a, 'tax_indemnity'),
      patternBased: true,
    });
  }
  if (a.has('tax_withholding')) {
    const text = a.text(a.facts.tax_withholding);
    const hasSafeguard = /(certificate|receipt|evidence|proof|credit|gross[- ]?up|treaty|statement)/.test(text);
    const discretionary = /(it determines|in its (sole )?(discretion|opinion)|as it (sees|deems) fit)/.test(text);
    if (!hasSafeguard || discretionary) {
      a.add({
        rule_id: 'tax.withholding_without_safeguards',
        category: c, kind: 'RISK', severity: 'Medium',
        title: 'Client may withhold tax from your payments',
        explanation: `The client may deduct tax from your payments${discretionary ? ' on its own determination' : ''}, and the contract does not mention giving you proof of what was withheld.`,
        why: 'Without proof you may find it hard to claim credit for the tax elsewhere, and an open-ended right to withhold reduces what you actually receive. ' + NOT_TAX_ADVICE,
        suggestion: 'Ask that withholding applies only where required by law, that you receive a certificate or statement for each deduction, and that the client notify you in advance.',
        evidence: ev(a, 'tax_withholding'),
        patternBased: true,
      });
    }
  }

  const inclusive = a.has('tax_basis') && INCLUSIVE.test(a.text(a.facts.tax_basis, false)) && !EXCLUSIVE.test(a.text(a.facts.tax_basis, false));
  if (inclusive) {
    a.add({
      rule_id: 'tax.amounts_inclusive',
      category: c, kind: 'RISK', severity: 'Medium',
      title: 'Agreed amounts include taxes',
      explanation: 'Your fees are stated as including applicable taxes, so any VAT, GST or sales tax would come out of what you receive.',
      why: 'If sales taxes apply to your invoices, you would absorb them instead of charging them on top. ' + NOT_TAX_ADVICE,
      suggestion: 'Ask whether the fees should be exclusive of VAT/GST/sales tax, or confirm whether any such tax applies to this engagement.',
      evidence: ev(a, 'tax_basis'),
      patternBased: true,
    });
  }

  if (a.fullCoverage) {
    if (a.has('tax_indirect') && a.isMissing(a.facts.tax_basis)) {
      a.add({
        rule_id: 'tax.basis_unclear',
        category: c, kind: 'MISSING_PROVISION', severity: 'Medium',
        title: 'Unclear whether fees include VAT, GST or sales tax',
        explanation: 'The contract mentions VAT, GST or sales tax but does not say whether your agreed fees include or exclude it.',
        why: 'The difference can reduce what you are paid by a significant percentage. ' + NOT_TAX_ADVICE,
        suggestion: 'Ask for a sentence stating whether fees are inclusive or exclusive of such taxes.',
        searched: 'whether fees include or exclude taxes',
      });
    }
    const nothing =
      a.isMissing(a.facts.tax_income) && a.isMissing(a.facts.tax_withholding) && a.isMissing(a.facts.tax_indirect) &&
      a.isMissing(a.facts.tax_indemnity) && a.isMissing(a.facts.tax_basis) && a.isMissing(a.facts.taxes);
    const feesStated = a.has('rates') || a.has('fee_structure');
    if (nothing && feesStated) {
      const places = (a.u.parties || []).map((p) => extractPlaces(p.address_or_location || ''));
      const crossBorder = places.length >= 2 && places.every((p) => p.size > 0) && ![...places[0]].some((p) => places[1].has(p));
      a.add({
        rule_id: 'tax.no_allocation',
        category: c, kind: 'MISSING_PROVISION', severity: crossBorder ? 'Medium' : 'Low',
        title: 'Tax responsibility is not allocated',
        explanation: `The contract states fees but says nothing about who is responsible for taxes${crossBorder ? ', and the parties appear to be in different places' : ''}.`,
        why: 'Unclear allocation can lead to disputes about withholding or sales taxes after the work is done. ' + NOT_TAX_ADVICE,
        suggestion: 'Ask for a short clause saying that each party is responsible for its own taxes and whether fees include or exclude any sales taxes.',
        searched: 'allocation of tax responsibility',
      });
    }
  }

  // Two statements about whether amounts include tax that disagree
  const inc = a.searchEvidence(INCLUSIVE, 1);
  const exc = a.searchEvidence(EXCLUSIVE, 1, (q) => !INCLUSIVE.test(q));
  if (inc.length > 0 && exc.length > 0) {
    a.addContradiction({
      rule_id: 'tax.inclusive_vs_exclusive',
      category: c,
      title: 'The contract says fees both include and exclude taxes',
      explanation: 'One clause says the fees include taxes, while another says taxes are added on top.',
      sideA: inc,
      sideB: exc,
    });
  }
}

// ---------------------------------------------------------------------------
// 6a. Renewal
// ---------------------------------------------------------------------------

export function renewalRules(a: Analysis): void {
  const c = 'Renewal' as const;
  const auto = a.has('ren_auto');
  const noticeText = a.has('ren_notice') ? a.text(a.facts.ren_notice, false) : '';
  const noticeDays = noticeText ? daysIn(noticeText) ?? daysIn(a.text(a.facts.ren_notice)) : undefined;
  const durationMonths = a.has('ren_duration') ? monthsIn(a.text(a.facts.ren_duration, false)) ?? monthsIn(a.text(a.facts.ren_duration)) : undefined;
  const renewalPeriod = a.has('ren_duration') ? statedPeriod(a.text(a.facts.ren_duration, false)) ?? statedPeriod(a.text(a.facts.ren_duration)) ?? 'the stated period' : '';
  const frozen = a.has('ren_pricing') && /(same|unchanged|existing|current|fixed|frozen|no (increase|change)|shall not (increase|change))/.test(a.text(a.facts.ren_pricing, false));
  const unilateral = a.has('ren_unilateral');

  if (auto) {
    // Explicit rule: the notice window sets the base level; long renewals, one-sided options and
    // frozen pricing each raise it one step (capped at High).
    let severity: RiskSeverity = noticeDays === undefined ? 'Medium' : noticeDays > 60 ? 'High' : noticeDays > 30 ? 'Medium' : 'Low';
    const factors: string[] = [];
    if (durationMonths !== undefined && durationMonths >= 24 && severity !== 'High') { severity = bump(severity); factors.push(`each renewal runs for ${renewalPeriod}`); }
    if (frozen && severity !== 'High') { severity = bump(severity); factors.push('your rates stay frozen during renewals'); }
    a.add({
      rule_id: 'renewal.automatic',
      category: c, kind: 'RISK', severity,
      title: 'The contract renews automatically',
      explanation: `The contract renews automatically${durationMonths !== undefined ? ` for periods of ${renewalPeriod}` : ''}${noticeDays !== undefined ? `, and you must give about ${noticeDays} days’ notice to stop it` : ''}.${factors.length ? ' It is raised in priority because ' + factors.join(' and ') + '.' : ''}`,
      why: 'If you miss the notice window you can be tied in for another full term, possibly at the same rates.',
      suggestion: 'Note the notice deadline in your calendar, and ask for a shorter notice window (for example 30 days) and for renewal only by mutual agreement.',
      evidence: [...ev(a, 'ren_auto').slice(0, 1), ...ev(a, 'ren_notice').slice(0, 1), ...ev(a, 'ren_duration').slice(0, 1)],
      patternBased: false,
    });
  }
  if (unilateral) {
    const open = /(any (additional|further)|indefinite|unlimited|without (any )?limit)/.test(a.text(a.facts.ren_unilateral)) || noticeDays === undefined;
    a.add({
      rule_id: 'renewal.unilateral',
      category: c, kind: 'RISK', severity: open ? 'High' : 'Medium',
      title: 'The client can extend the contract at its sole option',
      explanation: 'The client may renew or extend the contract on its own decision, without your agreement.',
      why: 'You could be held to the contract and its rates for longer than you planned, while the client keeps the choice.',
      suggestion: 'Ask for any extension to need your agreement, or at least a fixed maximum length and a notice period.',
      evidence: ev(a, 'ren_unilateral'),
      patternBased: true,
    });
  }
  if (a.has('ren_pricing')) {
    const text = a.text(a.facts.ren_pricing);
    const reduceByClient = /(client|company|customer)[^.]{0,40}(may|can|reserves)[^.]{0,40}(reduce|decrease|adjust|revise)/.test(text);
    if (reduceByClient || frozen) {
      a.add({
        rule_id: 'renewal.pricing',
        category: c, kind: 'RISK', severity: reduceByClient ? 'High' : auto || unilateral ? 'Medium' : 'Low',
        title: reduceByClient ? 'Client may reduce rates on renewal' : 'Rates are frozen during renewals',
        explanation: reduceByClient
          ? 'The client may change (reduce) your rates when the contract renews.'
          : 'Your rates stay the same during renewal terms, with no provision for increases.',
        why: 'Costs and rates can change over time, so frozen or client-controlled pricing can erode your income across renewals.',
        suggestion: 'Ask for an annual increase (for example a fixed percentage or an inflation index) and for rate changes to need mutual agreement.',
        evidence: ev(a, 'ren_pricing'),
        patternBased: true,
      });
    }
  }
  if (a.fullCoverage && auto) {
    if (a.isMissing(a.facts.ren_notice)) {
      a.add({
        rule_id: 'renewal.no_notice_period',
        category: c, kind: 'MISSING_PROVISION', severity: 'Medium',
        title: 'Automatic renewal with no stated way to stop it',
        explanation: 'The contract renews automatically but does not say how much notice stops the renewal.',
        why: 'Without a clear window you cannot be sure you have left in time, and the client may say you did not.',
        suggestion: 'Ask for a defined non-renewal notice period (for example 30 days before the term ends) for either party.',
        searched: 'a non-renewal notice period',
      });
    }
    if (a.isMissing(a.facts.ren_duration)) {
      a.add({
        rule_id: 'renewal.no_duration',
        category: c, kind: 'MISSING_PROVISION', severity: 'Medium',
        title: 'Automatic renewal with no stated renewal length',
        explanation: 'The contract renews automatically but does not say for how long.',
        why: 'An unspecified renewal could be read as open-ended or reset to the original term.',
        suggestion: 'Ask for each renewal term to have a stated length.',
        searched: 'the length of renewal terms',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 6b. Warranties
// ---------------------------------------------------------------------------

export function warrantyRules(a: Analysis): void {
  const c = 'Warranties' as const;
  const durationText = a.has('war_duration') ? a.text(a.facts.war_duration) : '';
  const durationMonthsValue = durationText ? monthsIn(a.text(a.facts.war_duration, false)) ?? monthsIn(durationText) : undefined;
  const warrantyPeriod = durationText ? statedPeriod(a.text(a.facts.war_duration, false)) ?? statedPeriod(durationText) ?? 'the stated period' : '';
  const perpetual = !!durationText && PERPETUAL.test(durationText);
  const veryLong = perpetual || (durationMonthsValue !== undefined && durationMonthsValue >= 36);

  if (a.has('war_outcome')) {
    a.add({
      rule_id: 'warranty.outcome_guarantee',
      category: c, kind: 'RISK', severity: 'High',
      title: 'You guarantee a business or financial outcome',
      explanation: 'The contract has you guarantee a result such as revenue, growth, rankings, savings or an approval.',
      why: 'These outcomes depend on the market and on what the client does with your work, not only on your performance, so you could be liable for results you cannot control.',
      suggestion: 'Ask to replace outcome guarantees with commitments about your own work (delivering to the agreed specification and standard), or make any targets non-binding goals.',
      evidence: ev(a, 'war_outcome'),
      patternBased: true,
    });
  }
  if (a.has('war_performance')) {
    // The older liability-category rule reports broad warranties from the disclaimer fact; avoid duplicating it
    const duplicate = a.findings.some(
      (f) => f.rule_id === 'liability.broad_warranty' && f.evidence.some((e) => ev(a, 'war_performance').some((w) => w.element_id === e.element_id))
    );
    if (!duplicate) {
      a.add({
        rule_id: 'warranty.performance_guarantee',
        category: c, kind: 'RISK', severity: a.has('war_outcome') || veryLong ? 'High' : 'Medium',
        title: 'Broad performance guarantee',
        explanation: 'The contract has you guarantee that the work will be error-free, fit for purpose or meet every requirement.',
        why: 'Complex work is rarely free of every defect, so such a guarantee can make you responsible for problems that are not your fault or that appear later.',
        suggestion: 'Ask to limit the warranty to performing the services professionally and delivering to the agreed specification, with a defined fix-it remedy.',
        evidence: ev(a, 'war_performance'),
        patternBased: true,
      });
    }
  }
  if (a.has('war_duration') && veryLong) {
    a.add({
      rule_id: 'warranty.long_duration',
      category: c, kind: 'RISK', severity: 'High',
      title: perpetual ? 'Warranty never expires' : `Very long warranty period (${warrantyPeriod})`,
      explanation: perpetual ? 'The warranty is perpetual or has no end.' : `The warranty lasts ${warrantyPeriod}.`,
      why: 'You stay exposed to claims long after you have been paid and moved on, and your ability to price that risk is limited.',
      suggestion: 'Ask for a fixed warranty period that starts on acceptance.',
      evidence: ev(a, 'war_duration'),
      patternBased: true,
    });
  } else if (a.has('war_duration') && durationMonthsValue !== undefined && durationMonthsValue > 12) {
    a.add({
      rule_id: 'warranty.long_duration',
      category: c, kind: 'RISK', severity: 'Medium',
      title: `Long warranty period (${warrantyPeriod})`,
      explanation: `The warranty lasts ${warrantyPeriod}.`,
      why: 'A longer warranty period extends your exposure after the work is paid for.',
      suggestion: 'Ask whether a shorter period (for example 90 days from acceptance) is acceptable.',
      evidence: ev(a, 'war_duration'),
    });
  }
  if (a.has('war_repair')) {
    const text = a.text(a.facts.war_repair);
    const unlimited = /(unlimited|any number)|until[^.]{0,30}(satisfied|approved|accepted)|no (additional )?(charge|cost)|at no (additional )?(charge|cost|expense)|free of charge|without (additional )?(charge|cost|compensation)/.test(text);
    if (unlimited) {
      a.add({
        rule_id: 'warranty.unlimited_repair',
        category: c, kind: 'RISK', severity: perpetual || a.isMissing(a.facts.war_duration) ? 'High' : 'Medium',
        title: 'Open-ended obligation to repair or redo work',
        explanation: 'You must repair or redo work at no charge, with no limit on the number of attempts or until the client is satisfied.',
        why: 'The more open the remedy, the more unpaid work you may have to do, and “until satisfied” gives the client control over when it ends.',
        suggestion: 'Ask to limit the remedy to correcting defects reported within the warranty period, and to a set number of correction rounds.',
        evidence: ev(a, 'war_repair'),
        patternBased: true,
      });
    }
  }
  if (a.has('war_post')) {
    a.add({
      rule_id: 'warranty.after_termination',
      category: c, kind: 'RISK', severity: perpetual || durationMonthsValue === undefined || durationMonthsValue >= 24 ? 'Medium' : 'Low',
      title: 'Warranty obligations continue after the contract ends',
      explanation: 'Your warranty or defect obligations survive termination.',
      why: 'You may have to keep supporting the work after the engagement and the income have ended.',
      suggestion: 'Ask for a defined end date and for the obligation to apply only to work that was paid for.',
      evidence: ev(a, 'war_post'),
      patternBased: true,
    });
  }
  const guaranteesGiven = a.has('war_performance') || a.has('war_repair');
  if (a.fullCoverage && guaranteesGiven && a.isMissing(a.facts.war_duration)) {
    a.add({
      rule_id: 'warranty.no_duration',
      category: c, kind: 'MISSING_PROVISION', severity: 'Medium',
      title: 'Warranty or repair obligation with no end date',
      explanation: 'The contract has you give a guarantee or repair obligation but does not say how long it lasts.',
      why: 'Without an end date the obligation could be read as lasting indefinitely.',
      suggestion: 'Ask for a warranty period that starts on acceptance and ends after a defined time (for example 90 days).',
      searched: 'a warranty period',
    });
  }
}

