import { Ctx, factPart } from './items';
import { stmt } from './evidence';
import { ClauseRef, DecisionFinding, ReportEvidence, Scenario, ScenarioAction, Statement } from './types';

/**
 * Section 4. A scenario is only included when the contract itself contains a provision that makes it relevant
 * (`trigger`). Triggers are specific: a worker-classification indicator such as required hours does not trigger
 * the "other clients" scenario, and a data incident scenario needs a data provision, not a payment clause.
 * Everything is built from verified facts and from findings already produced; nothing is generated.
 */

type FactRef = [key: string, label: string];

interface Def {
  id: string;
  scenario: string;
  situation: string;
  /** Facts that, if established, make this scenario relevant to THIS contract */
  triggers?: string[];
  /** Extra trigger that is not a single fact (returns the reason and evidence) */
  extraTrigger?: (ctx: Ctx, findings: DecisionFinding[]) => { reason: string; evidence: ReportEvidence[] } | null;
  triggerReason: string;
  /** What the contract says about the situation. `absent` ones are reported as "not stated" when the document was fully analyzed */
  position: Array<{ key: string; label: string; absent?: boolean }>;
  /** Facts that describe a contractual consequence */
  consequences?: FactRef[];
  /** Findings (by rule id) that concern this scenario */
  findings: RegExp;
  outsideTopic: string;
  /** Used only when no finding gives a grounded action; refers to the contract's own provisions */
  fallbackAction: string;
}

const DEFS: Def[] = [
  {
    id: 'scenario.late_payment',
    scenario: 'The client pays late',
    situation: 'An invoice is not paid by the date the contract sets, or the client delays payment.',
    triggers: ['payment_terms', 'rates', 'fee_structure', 'invoicing'],
    triggerReason: 'The contract contains payment terms.',
    position: [
      { key: 'payment_terms', label: 'When payment is due', absent: true },
      { key: 'invoicing', label: 'Invoicing' },
      { key: 'deal_pay_conditions', label: 'Conditions on payment' },
      { key: 'late_payment', label: 'Late payment', absent: true },
    ],
    consequences: [['late_payment', 'Consequence of late payment']],
    findings: /^(payment\.(long_terms|conditional|no_deadline|no_late_fee|no_invoicing)|cross\.(payment_deadline_conflict|fee_structure_vs_rate|ip_vs_payment|termination_vs_payment|payment_vs_acceptance)|ip\.transfer_before_payment)/,
    outsideTopic: 'late payment',
    fallbackAction: 'Follow the invoicing and payment steps the contract sets out, send each invoice in the way it requires, and keep a dated record of when each invoice was sent and what was agreed about payment.',
  },
  {
    id: 'scenario.client_ends_early',
    scenario: 'The client ends the contract early',
    situation: 'The client decides to stop the engagement before the work is finished.',
    triggers: ['term_convenience', 'term_cause'],
    triggerReason: 'The contract contains provisions on ending the engagement.',
    position: [
      { key: 'term_convenience', label: 'Ending without cause', absent: true },
      { key: 'term_cause', label: 'Ending for cause' },
      { key: 'post_term_payment', label: 'Payment when the contract ends', absent: true },
    ],
    consequences: [['post_term_payment', 'Payment when the contract ends']],
    findings: /^(termination\.|cross\.(termination_vs_payment|forfeit_on_termination|renewal_lockin_vs_termination))/,
    outsideTopic: 'ending the contract',
    fallbackAction: 'Before starting work, note the termination and notice provisions in the contract and confirm in writing what will be paid for work already done if the client ends the engagement.',
  },
  {
    id: 'scenario.you_want_to_end',
    scenario: 'You want to end the contract',
    situation: 'You decide to stop working for the client before the contract would otherwise end.',
    triggers: ['deal_contractor_term', 'term_convenience', 'term_cause'],
    triggerReason: 'The contract contains provisions on ending the engagement.',
    position: [
      { key: 'deal_contractor_term', label: 'Your right to end the contract', absent: true },
      { key: 'term_convenience', label: 'Ending without cause' },
      { key: 'term_cause', label: 'Ending for cause' },
    ],
    findings: /^(termination\.(one_sided|no_notice|no_convenience|short_notice|no_cure)|renewal\.no_notice_period|cross\.(renewal_lockin_vs_termination|notice_exceeds_renewal))/,
    outsideTopic: 'ending the contract',
    fallbackAction: 'Check which party the termination clause gives a right to end the contract and the notice it requires, and give any notice in the form the contract requires.',
  },
  {
    id: 'scenario.deliverable_rejected',
    scenario: 'The client rejects or is unhappy with your work',
    situation: 'The client says a deliverable is not acceptable or asks for changes.',
    triggers: ['acceptance', 'obl_client_review', 'obl_revisions'],
    extraTrigger: (ctx) => {
      const d = (ctx.u.scope_and_deliverables?.deliverables || []).filter((f) => ctx.a.isEstablished(f));
      return d.length ? { reason: 'The contract lists deliverables.', evidence: ctx.resolver.list(d.flatMap((f) => ctx.a.evidenceOf(f)), 2) } : null;
    },
    triggerReason: 'The contract contains provisions on acceptance, review or revisions.',
    position: [
      { key: 'acceptance', label: 'Acceptance of work', absent: true },
      { key: 'obl_client_review', label: 'Client review and feedback' },
      { key: 'obl_revisions', label: 'Revisions' },
      { key: 'deal_pay_conditions', label: 'Conditions on payment' },
    ],
    findings: /^(scope\.(no_acceptance|subjective_acceptance)|cross\.payment_vs_acceptance|payment\.conditional)/,
    outsideTopic: 'rejected work',
    fallbackAction: 'Deliver in the way the contract describes, keep written records of what was delivered and of the client’s response, and ask for any rejection to be explained in writing.',
  },
  {
    id: 'scenario.scope_changes',
    scenario: 'The client asks for more than was agreed',
    situation: 'The client asks for additional work, or for the work to change, during the engagement.',
    triggers: ['change_order'],
    extraTrigger: (ctx, findings) => {
      const open = findings.find((f) => f.id === 'scope.open_ended' && f.evidence.length > 0);
      if (open) return { reason: 'The scope is described in open-ended terms.', evidence: open.evidence.slice(0, 2) };
      const ev = ctx.a.searchEvidence(/additional (work|services)|change (order|request)|changes? to the (scope|services)/i, 2);
      return ev.length ? { reason: 'The contract refers to additional work or changes to the services.', evidence: ctx.resolver.list(ev, 2) } : null;
    },
    triggerReason: 'The contract contains a change process.',
    position: [
      { key: 'change_order', label: 'Changes to the scope', absent: true },
      { key: 'scope', label: 'Scope of the services' },
    ],
    findings: /^(scope\.(no_change_order|open_ended|no_scope)|cross\.scope_vs_change_order)/,
    outsideTopic: 'extra work',
    fallbackAction: 'Before doing work outside the written scope, ask for the change to be agreed in writing in the way the contract describes.',
  },
  {
    id: 'scenario.liability_claim',
    scenario: 'The client claims your work caused them a loss',
    situation: 'The client says your work or conduct caused a loss and asks you to pay for it.',
    triggers: ['liability_cap', 'indirect_damages', 'indemnity_contractor', 'warranties', 'war_performance', 'war_outcome', 'war_repair'],
    triggerReason: 'The contract contains provisions on liability, indemnity or warranties.',
    position: [
      { key: 'liability_cap', label: 'Limit on your liability', absent: true },
      { key: 'indirect_damages', label: 'Indirect damages' },
      { key: 'indemnity_contractor', label: 'Your indemnity' },
      { key: 'warranties', label: 'Warranties' },
      { key: 'war_repair', label: 'Repair or replace' },
    ],
    findings: /^(liability\.|warranty\.|cross\.(cap_|indemnity_|warranty_|insurance_))/,
    outsideTopic: 'liability for loss',
    fallbackAction: 'Read the liability, indemnity and warranty clauses together before signing and ask the client to confirm in writing how they interact.',
  },
  {
    id: 'scenario.data_incident',
    scenario: 'There is a data breach or security incident',
    situation: 'Data you handle for the client is lost, exposed or accessed without authorisation.',
    triggers: ['dp_personal', 'dp_breach', 'dp_security', 'dp_third_party', 'dp_agreement'],
    triggerReason: 'The contract contains provisions on data handling.',
    position: [
      { key: 'dp_breach', label: 'Breach notification', absent: true },
      { key: 'dp_security', label: 'Security obligations' },
      { key: 'dp_third_party', label: 'Third-party access' },
      { key: 'dp_return', label: 'Return or deletion of data' },
    ],
    consequences: [['ins_cyber', 'Cyber insurance requirement']],
    findings: /^(data\.|insurance\.cyber_without_data)/,
    outsideTopic: 'a data incident (including any legal duty to report it)',
    fallbackAction: 'Make sure you know what the contract requires you to do if data is compromised, who must be told, and how quickly, and keep a record of the security measures you use.',
  },
  {
    id: 'scenario.ip_reuse',
    scenario: 'You want to reuse your work or your own tools',
    situation: 'You want to use the work you created, or materials you owned before, for another client or project.',
    triggers: ['ip_ownership', 'ip_preexisting', 'ip_license'],
    triggerReason: 'The contract contains provisions on who owns or may use the work.',
    position: [
      { key: 'ip_ownership', label: 'Ownership of the work', absent: true },
      { key: 'ip_preexisting', label: 'Your pre-existing materials', absent: true },
      { key: 'ip_license', label: 'Licence' },
    ],
    findings: /^(ip\.|cross\.ip_vs_payment)/,
    outsideTopic: 'ownership of the work',
    fallbackAction: 'List the tools and materials you already own and ask for them to be identified in writing as excluded from what you transfer.',
  },
  {
    id: 'scenario.other_clients',
    scenario: 'You want to work for other clients',
    situation: 'You are offered work by another client, possibly in the same field.',
    triggers: ['non_compete', 'non_solicit', 'wc_exclusivity'],
    extraTrigger: (ctx) => {
      const ev = ctx.a.evidenceOf(ctx.a.facts['wc_business']).filter((e) => /other (clients|customers|engagements)|outside (work|activit)|similar services|compet/i.test(e.exact_quote));
      return ev.length && ctx.a.isEstablished(ctx.a.facts['wc_business'])
        ? { reason: 'The contract limits work outside this engagement.', evidence: ctx.resolver.list(ev, 2) }
        : null;
    },
    triggerReason: 'The contract restricts working for others.',
    position: [
      { key: 'non_compete', label: 'Non-compete' },
      { key: 'non_solicit', label: 'Non-solicitation' },
      { key: 'wc_exclusivity', label: 'Exclusivity' },
      { key: 'wc_business', label: 'Limits on your own business' },
    ],
    findings: /^restrictions\./,
    outsideTopic: 'working for other clients',
    fallbackAction: 'Before accepting other work, check each restriction the contract states and ask the client to confirm in writing whether the new work is allowed.',
  },
  {
    id: 'scenario.renewal',
    scenario: 'The contract renews or runs on',
    situation: 'The contract reaches the end of its term, or a renewal date approaches.',
    triggers: ['ren_auto', 'ren_duration', 'ren_unilateral', 'ren_pricing', 'ren_notice', 'renewal'],
    triggerReason: 'The contract contains renewal terms.',
    position: [
      { key: 'renewal', label: 'Renewal' },
      { key: 'ren_auto', label: 'Automatic renewal' },
      { key: 'ren_notice', label: 'Notice to stop renewal', absent: true },
      { key: 'ren_duration', label: 'Length of renewal' },
      { key: 'ren_pricing', label: 'Pricing on renewal' },
    ],
    findings: /^(renewal\.|cross\.(renewal_vs_expiry|notice_exceeds_renewal|renewal_lockin_vs_termination|term_vs_expiry_date))/,
    outsideTopic: 'renewal',
    fallbackAction: 'Note the renewal date and any notice the contract requires to stop renewal, and send that notice in the form the contract requires.',
  },
  {
    id: 'scenario.subcontracting',
    scenario: 'You need help from someone else',
    situation: 'You want to bring in a subcontractor or delegate part of the work.',
    triggers: ['sub_prohibition', 'sub_approval', 'sub_permission', 'sub_delegation', 'wc_no_delegation'],
    triggerReason: 'The contract contains provisions on subcontracting or delegation.',
    position: [
      { key: 'sub_prohibition', label: 'Ban on subcontracting' },
      { key: 'wc_no_delegation', label: 'Duty to perform personally' },
      { key: 'sub_approval', label: 'Approval needed' },
      { key: 'sub_permission', label: 'Permission to subcontract' },
      { key: 'sub_responsibility', label: 'Responsibility for subcontractors' },
      { key: 'sub_flowdown', label: 'Terms subcontractors must accept' },
    ],
    findings: /^(subcontracting\.|data\.no_subcontractor_data_terms)/,
    outsideTopic: 'subcontracting',
    fallbackAction: 'Before involving anyone else, check what the contract says about approval and responsibility, and get the client’s consent in writing where it requires consent.',
  },
  {
    id: 'scenario.dispute',
    scenario: 'You and the client disagree and it escalates',
    situation: 'A disagreement cannot be settled informally.',
    triggers: ['dispute_method', 'venue', 'legal_fees', 'governing_law'],
    triggerReason: 'The contract contains provisions on how disputes are handled.',
    position: [
      { key: 'governing_law', label: 'Governing law', absent: true },
      { key: 'dispute_method', label: 'How disputes are resolved', absent: true },
      { key: 'venue', label: 'Where disputes are heard' },
      { key: 'legal_fees', label: 'Legal fees' },
    ],
    findings: /^(dispute\.|cross\.governing_law_conflict)/,
    outsideTopic: 'resolving disputes',
    fallbackAction: 'Check the governing-law, forum and dispute-process clauses and consider what bringing a claim would involve in the place they name.',
  },
  {
    id: 'scenario.taxes',
    scenario: 'Tax is withheld or a tax question arises',
    situation: 'The client withholds tax from a payment, or the question arises who bears a tax.',
    triggers: ['tax_withholding', 'tax_indemnity', 'tax_indirect', 'tax_income', 'taxes'],
    triggerReason: 'The contract contains tax provisions.',
    position: [
      { key: 'tax_income', label: 'Your own taxes' },
      { key: 'tax_withholding', label: 'Tax withholding' },
      { key: 'tax_indirect', label: 'Indirect taxes such as VAT or GST' },
      { key: 'tax_basis', label: 'Whether amounts include tax' },
      { key: 'tax_indemnity', label: 'Tax indemnity' },
    ],
    findings: /^tax\./,
    outsideTopic: 'tax',
    fallbackAction: 'Ask whether the stated amounts include or exclude tax, and keep records the contract asks for about tax.',
  },
];

const trim = (s: string, n = 300): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** One fact -> one statement whose basis follows the fact's verified status. null when there is nothing to say. */
function factStatement(ctx: Ctx, key: string, label: string, absent: boolean): Statement | null {
  const p = factPart(ctx, key);
  if (!p) return null;
  const evidence = ctx.resolver.list(p.evidence, 2);
  const text = (): string => `${label}: ${trim(p.summary.trim())}`;
  switch (p.status) {
    case 'explicit':
      return stmt.explicit(text(), evidence);
    case 'conflicting':
      return stmt.conflicting(text(), evidence);
    case 'unclear':
      return p.summary.trim() ? stmt.unclear(text(), evidence) : null;
    case 'not_found':
      return absent ? stmt.notStated(`${label}: the contract does not state this.`) : null;
    default:
      return null;
  }
}

const firstSentence = (t: string): string => (t.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? t).trim();

export function buildScenarios(ctx: Ctx, findings: DecisionFinding[]): Scenario[] {
  const { a } = ctx;
  const out: Array<{ s: Scenario; rank: number }> = [];

  for (const def of DEFS) {
    // ---- trigger: a provision of THIS contract that makes the scenario relevant
    let trigger: { reason: string; evidence: ReportEvidence[] } | null = null;
    const hit = (def.triggers || []).find((k) => a.isEstablished(a.facts[k]));
    if (hit) trigger = { reason: def.triggerReason, evidence: ctx.resolver.list(a.evidenceOf(a.facts[hit]), 2) };
    if (!trigger && def.extraTrigger) trigger = def.extraTrigger(ctx, findings);
    if (!trigger || trigger.evidence.length === 0) continue;

    // ---- what the contract says. The provision that triggered the scenario is always part of it.
    const positionDefs = [...def.position];
    if (hit && !positionDefs.some((p) => p.key === hit)) {
      positionDefs.unshift({ key: hit, label: a.factRefs.find((f) => f.key === hit)?.label ?? 'Relevant provision' });
    }
    const position = positionDefs
      .map((p) => factStatement(ctx, p.key, p.label, !!p.absent))
      .filter((s): s is Statement => s !== null);
    if (!hit) position.unshift(stmt.explicit(trigger.reason, trigger.evidence));
    const hasContent = position.some((s) => s.basis !== 'not_in_contract');
    if (!hasContent) continue;

    // ---- findings that concern this scenario
    const related = findings.filter((f) => def.findings.test(f.id));
    const relatedIds = related.map((f) => f.id);

    const contractual: Statement[] = [];
    for (const [key, label] of def.consequences || []) {
      const s = factStatement(ctx, key, label, false);
      if (s && s.basis === 'explicit') contractual.push(s);
    }
    for (const f of related.filter((x) => x.type === 'risk')) {
      contractual.push(stmt.explicit(`${f.title}: ${firstSentence(f.explanation)}`, f.evidence));
    }

    const uncertain: Statement[] = [];
    for (const f of related.filter((x) => x.type === 'ambiguous')) uncertain.push(stmt.unclear(`${f.title}: ${firstSentence(f.explanation)}`, f.evidence));
    for (const f of related.filter((x) => x.type === 'contradictory')) uncertain.push(stmt.conflicting(`${f.title}: ${firstSentence(f.explanation)}`, f.evidence));
    uncertain.push(stmt.outside(`Whether rules outside this contract affect ${def.outsideTopic} is not assessed in this report.`));

    const missing: Statement[] = related
      .filter((x) => x.type === 'missing' && x.relevance?.material)
      .map((f) => stmt.notStated(`${f.title}: ${firstSentence(f.explanation)}`));

    const uncertainties = [...new Set(related.map((f) => f.uncertainty).filter((u): u is string => !!u))].slice(0, 3);

    // ---- recommended action, grounded in the highest-priority related finding, or in the contract's own terms
    const lead = related[0];
    const action: ScenarioAction = lead
      ? { text: lead.recommended_action, grounded_in: [lead.id], ...(lead.illustrative_alternative ? { illustrative_alternative: lead.illustrative_alternative } : {}) }
      : { text: def.fallbackAction, grounded_in: [hit ? `fact:${hit}` : `fact:${def.id}`] };

    // ---- clauses
    const refs = new Map<string, ClauseRef>();
    for (const e of [...trigger.evidence, ...position.flatMap((s) => s.evidence), ...contractual.flatMap((s) => s.evidence), ...uncertain.flatMap((s) => s.evidence)]) {
      if (!refs.has(e.element_id)) refs.set(e.element_id, { element_id: e.element_id, reference: e.reference });
    }

    const rank = related.some((f) => f.priority === 'high') ? 3 : related.some((f) => f.priority === 'medium') ? 2 : related.length ? 1 : 0;
    out.push({
      rank,
      s: {
        id: def.id,
        scenario: def.scenario,
        situation: def.situation,
        trigger,
        applicable_clauses: [...refs.values()].slice(0, 8),
        contract_position: position,
        potential_outcome: { contractual, uncertain },
        missing_protections: missing,
        uncertainties,
        recommended_action: action,
        related_finding_ids: relatedIds,
      },
    });
  }

  // Most serious first; ties keep the catalogue order
  return out.map((o, i) => ({ ...o, i })).sort((x, y) => y.rank - x.rank || x.i - y.i).map((o) => o.s);
}
