import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeContractRisk } from './riskEngine';
import { buildClauseIndex } from './clauseIndex';
import { FindingKind, RiskCategory, RiskSeverity } from './types';
import { contractFrom, find, ids, review, Reviewed, runPipeline } from './testSupport';

/**
 * Per-rule tests. Every rule has:
 *   - a contract that SHOULD trigger it (with the expected kind and severity),
 *   - contracts that should NOT trigger it,
 *   - an ambiguous / incomplete example.
 * The text goes through the real deterministic pipeline (extraction -> normalization -> understanding ->
 * evidence verification -> risk). Gemini is never called.
 */

const NEUTRAL = 'Contractor shall deliver the Services on time.';
const D = "Contractor will have access to personal data of Company's customers.";
const PI = 'Contractor shall maintain professional liability insurance throughout the term.';
const GL = 'Contractor shall maintain commercial general liability insurance.';
const CYBER = 'Contractor shall maintain cyber liability insurance.';
const SUBS = 'Contractor may subcontract portions of the Services.';
const AUTO = (months: number, notice: number) =>
  `This Agreement shall automatically renew for successive renewal terms of ${months} months each unless either party gives written notice of non-renewal at least ${notice} days before the end of the then-current term.`;

type Edge = { name: string; clauses: string[]; present: boolean; kind?: FindingKind; severity?: RiskSeverity };
type RuleCase = {
  id: string;
  category: RiskCategory;
  kind: FindingKind;
  severity: RiskSeverity;
  trigger: string[];
  /** Contracts in which the rule must NOT fire */
  no: string[][];
  edges?: Edge[];
};

const RULES: RuleCase[] = [
  // ---------------- data protection ----------------
  { id: 'data.no_breach_notification', category: 'Data Protection & Security', kind: 'MISSING_PROVISION', severity: 'Medium', trigger: [D],
    no: [[NEUTRAL], [D, 'Contractor shall notify Company of any data breach within 72 hours of discovery.']],
    edges: [{ name: 'sensitive data raises it to High', clauses: [D, 'The data includes patient health records.'], present: true, severity: 'High' }] },
  { id: 'data.no_security_standard', category: 'Data Protection & Security', kind: 'MISSING_PROVISION', severity: 'Low', trigger: [D],
    no: [[NEUTRAL], [D, 'Contractor shall implement appropriate security measures, including encryption of data.']] },
  { id: 'data.no_return_deletion', category: 'Data Protection & Security', kind: 'MISSING_PROVISION', severity: 'Medium', trigger: [D],
    no: [[NEUTRAL], [D, 'Upon termination Contractor shall return or delete all personal data.']] },
  { id: 'data.no_purpose_limit', category: 'Data Protection & Security', kind: 'MISSING_PROVISION', severity: 'Medium', trigger: [D],
    no: [[NEUTRAL], [D, 'Contractor shall use the data solely for the purpose of performing the Services.']] },
  { id: 'data.no_processing_agreement', category: 'Data Protection & Security', kind: 'MISSING_PROVISION', severity: 'Medium', trigger: [D],
    no: [[NEUTRAL], [D, 'The parties shall sign a data processing agreement under which Contractor acts as processor.']] },
  { id: 'data.no_subcontractor_data_terms', category: 'Data Protection & Security', kind: 'MISSING_PROVISION', severity: 'Medium', trigger: [D, SUBS],
    no: [[D], [D, SUBS, 'Each subcontractor shall be bound by written confidentiality and data protection obligations no less protective than this Agreement.']] },
  { id: 'data.short_breach_deadline', category: 'Data Protection & Security', kind: 'RISK', severity: 'Medium', trigger: [D, 'Contractor shall notify Company of any data breach within 24 hours of discovery.'],
    no: [[D, 'Contractor shall notify Company of any data breach within 72 hours of discovery.']],
    edges: [{ name: 'a deadline with no number ("promptly") is not flagged', clauses: [D, 'Contractor shall promptly notify Company of any data breach.'], present: false }] },
  { id: 'data.open_ended_security_standard', category: 'Data Protection & Security', kind: 'RISK', severity: 'Medium', trigger: [D, 'Contractor shall ensure that no security breach occurs and shall apply the highest standard of security to all data.'],
    no: [[D, 'Contractor shall implement appropriate security measures, including encryption of data.']] },
  { id: 'data.uncapped_breach_liability', category: 'Data Protection & Security', kind: 'RISK', severity: 'High', trigger: [D, 'Contractor shall indemnify Company for all costs of any data breach, and this liability is not subject to any limitation.'],
    no: [[D, 'Contractor shall indemnify Company for third-party claims that the deliverables infringe intellectual property rights.']] },
  { id: 'data.cross_border_terms', category: 'Data Protection & Security', kind: 'RISK', severity: 'Medium', trigger: [D, 'Contractor shall not transfer personal data outside the European Economic Area.'],
    no: [[D]],
    edges: [{ name: 'a permissive transfer clause is only Low', clauses: [D, 'Personal data may be transferred internationally under standard contractual clauses.'], present: true, severity: 'Low' }] },

  // ---------------- insurance ----------------
  { id: 'insurance.requirements', category: 'Insurance', kind: 'RISK', severity: 'Low', trigger: [PI], no: [[NEUTRAL]] },
  { id: 'insurance.disproportionate', category: 'Insurance', kind: 'RISK', severity: 'Medium',
    trigger: [PI, GL, CYBER, 'Each policy shall have limits of not less than $2,000,000 per claim.'],
    no: [[PI, 'The policy shall have limits of not less than $1,000,000 per claim.'], [NEUTRAL]],
    edges: [
      { name: 'very high limits against a stated fixed fee are High', clauses: [PI, 'The fixed fee of $10,000 covers all Services.', 'The policy shall have limits of not less than $2,000,000 per claim.'], present: true },
      { name: 'unspecified limits are not "disproportionate"', clauses: [PI, 'Contractor shall maintain adequate insurance coverage as required by Company.'], present: false },
    ] },
  { id: 'insurance.cyber_without_data', category: 'Insurance', kind: 'RISK', severity: 'Low', trigger: [CYBER], no: [[CYBER, D], [PI]] },
  { id: 'insurance.post_termination', category: 'Insurance', kind: 'RISK', severity: 'Medium', trigger: [PI, 'Contractor shall maintain such insurance for five years after termination.'],
    no: [[PI]],
    edges: [{ name: 'six months of tail cover is only Low', clauses: [PI, 'Contractor shall maintain such insurance for six months after termination.'], present: true, severity: 'Low' }] },
  { id: 'insurance.additional_insured', category: 'Insurance', kind: 'RISK', severity: 'Low', trigger: [PI, 'Contractor shall name Company as an additional insured.'], no: [[PI]] },
  { id: 'insurance.no_limits', category: 'Insurance', kind: 'MISSING_PROVISION', severity: 'Medium', trigger: [PI],
    no: [[PI, 'The policy shall have limits of not less than $1,000,000 per claim.'], [NEUTRAL]],
    edges: [{ name: 'no insurance required at all: nothing is missing', clauses: [NEUTRAL], present: false }] },

  // ---------------- subcontracting ----------------
  { id: 'subcontracting.absolute_ban', category: 'Subcontracting & Delegation', kind: 'RISK', severity: 'Medium', trigger: ['Contractor shall not subcontract any part of the Services.'],
    no: [["Contractor may subcontract portions of the Services with Company's prior written consent."]] },
  { id: 'subcontracting.excessive_approval', category: 'Subcontracting & Delegation', kind: 'RISK', severity: 'Medium',
    trigger: ["Contractor shall not subcontract any part of the Services without Company's prior written consent, which Company may withhold in its sole discretion."],
    no: [["Contractor shall not subcontract any part of the Services without Company's prior written consent, which shall not be unreasonably withheld."]],
    edges: [{ name: 'a plain approval requirement is a normal safeguard', clauses: ["Contractor shall not subcontract any part of the Services without Company's prior written consent."], present: false }] },
  { id: 'subcontracting.no_responsibility', category: 'Subcontracting & Delegation', kind: 'MISSING_PROVISION', severity: 'Low', trigger: [SUBS],
    no: [[SUBS, 'Contractor remains responsible for the acts and omissions of its subcontractors.'], [NEUTRAL]] },
  { id: 'subcontracting.no_flowdown', category: 'Subcontracting & Delegation', kind: 'MISSING_PROVISION', severity: 'Medium',
    trigger: [SUBS, "Contractor shall keep Company's confidential information secret for three (3) years."],
    no: [[SUBS, "Contractor shall keep Company's confidential information secret for three (3) years.", 'Each subcontractor shall be bound by written confidentiality obligations no less protective than this Agreement.'], [SUBS]],
    edges: [{ name: 'subcontracting forbidden: no flow-down is expected', clauses: ['Contractor shall not subcontract any part of the Services.', "Contractor shall keep Company's confidential information secret for three (3) years."], present: false }] },
  { id: 'subcontracting.broad_liability', category: 'Subcontracting & Delegation', kind: 'RISK', severity: 'Medium', trigger: [SUBS, 'Contractor shall be liable for any and all claims arising from its subcontractors without limit.'],
    no: [[SUBS, 'Contractor remains responsible for the acts and omissions of its subcontractors.']] },
  { id: 'subcontracting.personal_service_vs_delegation', category: 'Subcontracting & Delegation', kind: 'CONTRADICTORY_PROVISIONS', severity: 'Medium',
    trigger: ['Contractor shall perform the Services personally and shall not subcontract any part of them.', 'Contractor may engage subcontractors and assistants to perform the Services.'],
    no: [['Contractor shall perform the Services personally.', "Contractor may engage subcontractors with Company's prior written consent."]],
    edges: [{ name: 'a conditional key-personnel clause next to a permission is not a contradiction', clauses: ["Key personnel may be replaced only with Company's consent.", 'Contractor may engage subcontractors.'], present: false }] },

  // ---------------- tax ----------------
  { id: 'tax.indemnification', category: 'Tax', kind: 'RISK', severity: 'High', trigger: ['Contractor shall indemnify Company against any and all taxes, penalties and interest assessed against Company in connection with payments.'],
    no: [[NEUTRAL]],
    edges: [{ name: 'an indemnity limited to your own taxes is Medium', clauses: ["Contractor shall indemnify Company for Contractor's own income taxes."], present: true, severity: 'Medium' }] },
  { id: 'tax.withholding_without_safeguards', category: 'Tax', kind: 'RISK', severity: 'Medium', trigger: ['Company may withhold taxes from payments to Contractor.'],
    no: [['Company may withhold taxes required by law and shall provide Contractor a certificate for each deduction.'], [NEUTRAL]] },
  { id: 'tax.amounts_inclusive', category: 'Tax', kind: 'RISK', severity: 'Medium', trigger: ['All fees are inclusive of all applicable taxes.'],
    no: [['All fees are exclusive of applicable VAT.'], [NEUTRAL]] },
  { id: 'tax.basis_unclear', category: 'Tax', kind: 'MISSING_PROVISION', severity: 'Medium', trigger: ['VAT may apply to certain invoices.'],
    no: [['VAT may apply to certain invoices. All fees are exclusive of VAT.'], [NEUTRAL]] },
  { id: 'tax.no_allocation', category: 'Tax', kind: 'MISSING_PROVISION', severity: 'Low', trigger: ['Company shall pay Contractor at the rate of $85.00 per hour for approved hours worked.'],
    no: [['Company shall pay Contractor at the rate of $85.00 per hour for approved hours worked.', "Contractor is solely responsible for Contractor's own income taxes."], [NEUTRAL]],
    edges: [{ name: 'no fees stated: there is nothing to allocate tax on', clauses: [NEUTRAL], present: false }] },
  { id: 'tax.inclusive_vs_exclusive', category: 'Tax', kind: 'CONTRADICTORY_PROVISIONS', severity: 'Medium', trigger: ['All fees are inclusive of all applicable taxes.', 'VAT shall be added to all invoices.'],
    no: [['All fees are exclusive of applicable taxes.', 'VAT shall be added to all invoices.'], ['All fees are inclusive of all applicable taxes.']] },

  // ---------------- renewal ----------------
  { id: 'renewal.automatic', category: 'Renewal', kind: 'RISK', severity: 'High', trigger: [AUTO(24, 90)],
    no: [['This Agreement shall not renew automatically.'], [NEUTRAL]],
    edges: [
      { name: '45 days notice is Medium', clauses: [AUTO(12, 45)], present: true, severity: 'Medium' },
      { name: '30 days notice and a 12-month renewal is Low', clauses: [AUTO(12, 30)], present: true, severity: 'Low' },
    ] },
  { id: 'renewal.unilateral', category: 'Renewal', kind: 'RISK', severity: 'High', trigger: ['Company may extend this Agreement at its sole option for any additional period.'],
    no: [['Either party may extend this Agreement by mutual written agreement.']],
    edges: [{ name: 'a bounded option with a notice period is Medium', clauses: ['Company may extend this Agreement at its sole option for twelve (12) months.', 'Either party may prevent renewal by giving notice of non-renewal 30 days before the term ends.'], present: true, severity: 'Medium' }] },
  { id: 'renewal.pricing', category: 'Renewal', kind: 'RISK', severity: 'Medium', trigger: [AUTO(12, 30), 'During any renewal term the rates shall remain the same.'],
    no: [['Rates are stated in Exhibit A.']],
    edges: [
      { name: 'frozen rates without any renewal mechanism are Low', clauses: ['During any renewal term the rates shall remain the same.'], present: true, severity: 'Low' },
      { name: 'a client right to reduce rates on renewal is High', clauses: ['During any renewal term the Company may reduce the rates.'], present: true, severity: 'High' },
    ] },
  { id: 'renewal.no_notice_period', category: 'Renewal', kind: 'MISSING_PROVISION', severity: 'Medium', trigger: ['This Agreement shall automatically renew for successive twelve (12) month terms.'],
    no: [[AUTO(12, 30)], [NEUTRAL]],
    edges: [{ name: 'no automatic renewal: no notice period is needed', clauses: [NEUTRAL], present: false }] },
  { id: 'renewal.no_duration', category: 'Renewal', kind: 'MISSING_PROVISION', severity: 'Medium', trigger: ['This Agreement shall automatically renew unless a party gives notice of non-renewal at least thirty (30) days before the end of the term.'],
    no: [[AUTO(12, 30)], [NEUTRAL]] },

  // ---------------- warranties ----------------
  { id: 'warranty.outcome_guarantee', category: 'Warranties', kind: 'RISK', severity: 'High', trigger: ["Contractor guarantees that the website will increase Company's sales by twenty percent."],
    no: [['Contractor shall deliver the website by June 1.']] },
  { id: 'warranty.long_duration', category: 'Warranties', kind: 'RISK', severity: 'High', trigger: ['The warranties in this Section are perpetual.'],
    no: [['Contractor warrants the deliverables for ninety (90) days after acceptance.'], [NEUTRAL]],
    edges: [
      { name: 'eighteen months is Medium', clauses: ['Contractor warrants the deliverables for eighteen (18) months after acceptance.'], present: true, severity: 'Medium' },
      { name: 'a vague "reasonable period" is not a long duration', clauses: ['Contractor warrants the deliverables for a reasonable period.'], present: false },
    ] },
  { id: 'warranty.unlimited_repair', category: 'Warranties', kind: 'RISK', severity: 'High', trigger: ['Contractor shall repair any defective deliverable at no additional charge until Company is satisfied.'],
    no: [['Contractor shall correct reported defects within thirty (30) days.']],
    edges: [{ name: 'with a stated warranty period the open-ended remedy is Medium', clauses: ['Contractor warrants the deliverables for ninety (90) days after acceptance.', 'Contractor shall repair any defective deliverable at no additional charge.'], present: true, severity: 'Medium' }] },
  { id: 'warranty.after_termination', category: 'Warranties', kind: 'RISK', severity: 'Medium', trigger: ['The warranties shall survive termination of this Agreement.'],
    no: [[NEUTRAL]],
    edges: [{ name: 'a 90-day warranty that survives termination is Low', clauses: ['Contractor warrants the deliverables for ninety (90) days after acceptance.', 'The warranties shall survive termination of this Agreement.'], present: true, severity: 'Low' }] },
  { id: 'warranty.no_duration', category: 'Warranties', kind: 'MISSING_PROVISION', severity: 'Medium', trigger: ['Contractor warrants that the deliverables will be error-free.'],
    no: [['Contractor warrants that the deliverables will be error-free for ninety (90) days after acceptance.'], [NEUTRAL]],
    edges: [{ name: 'no warranty given: no duration is missing', clauses: [NEUTRAL], present: false }] },
];

test.describe('Contractor intelligence — rules (trigger / no-trigger / ambiguous or incomplete)', () => {
  for (const rule of RULES) {
    test(`${rule.id}: triggers with the right kind, severity, category and evidence`, () => {
      const r = review(...rule.trigger);
      const f = find(r, rule.id);
      assert.ok(f, `${rule.id} must fire. Got: ${ids(r.report.findings).join(', ')}`);
      assert.equal(f!.kind, rule.kind);
      assert.equal(f!.severity, rule.severity, `${rule.id} severity`);
      assert.equal(f!.category, rule.category);
      assertFindingShape(r, f!);
    });

    test(`${rule.id}: does not trigger on contracts that do not warrant it`, () => {
      for (const clauses of rule.no) {
        const r = review(...clauses);
        assert.equal(find(r, rule.id), undefined, `${rule.id} must not fire for: ${clauses.join(' | ')}. Got: ${ids(r.report.findings).join(', ')}`);
      }
    });

    for (const edge of rule.edges ?? []) {
      test(`${rule.id}: ${edge.name}`, () => {
        const r = review(...edge.clauses);
        const f = find(r, rule.id);
        if (edge.present) {
          assert.ok(f, `${rule.id} expected. Got: ${ids(r.report.findings).join(', ')}`);
          if (edge.severity) assert.equal(f!.severity, edge.severity);
          if (edge.kind) assert.equal(f!.kind, edge.kind);
        } else {
          assert.equal(f, undefined, `${rule.id} must not fire. Got: ${ids(r.report.findings).join(', ')}`);
        }
      });
    }
  }

  test('Missing-provision rules are not asserted when the analysis was incomplete', () => {
    const missingRules = RULES.filter((r) => r.kind === 'MISSING_PROVISION');
    assert.ok(missingRules.length >= 14);
    for (const rule of missingRules) {
      const r = review(...rule.trigger);
      assert.ok(find(r, rule.id), `${rule.id} baseline`);
      const partial = analyzeContractRisk(
        { ...r.understanding, processing_status: 'PARTIAL', coverage_percentage: 50 },
        buildClauseIndex(r.normalized, r.extraction)
      );
      assert.equal(partial.findings.find((f) => f.id === rule.id), undefined, `${rule.id} must not be asserted on partial coverage`);
      assert.equal(partial.findings.filter((f) => f.kind === 'MISSING_PROVISION').length, 0);
      assert.equal(partial.analysis.missing_provisions_assessed, false);
      assert.ok(partial.overview.category_indicators.filter((c) => c.level === 'Not assessed').length >= 1);
    }
  });

  test('Every missing-provision finding carries no evidence and every risk carries verified evidence', () => {
    for (const rule of RULES) {
      const r = review(...rule.trigger);
      const f = find(r, rule.id)!;
      if (rule.kind === 'MISSING_PROVISION') {
        assert.deepEqual(f.evidence, [], rule.id);
        assert.match(f.evidence_note!, /No clause was found/);
      } else {
        assert.ok(f.evidence.length >= 1, `${rule.id} needs evidence`);
      }
    }
  });
});

function assertFindingShape(r: Reviewed, f: ReturnType<typeof find> & object): void {
  assert.ok(f.title && f.explanation && f.why_it_matters && f.suggestion, `${f.id} text fields`);
  assert.ok(['High', 'Medium', 'Low'].includes(f.confidence.level));
  assert.ok(f.confidence.reasons.length > 0);
  for (const e of f.evidence) {
    assert.ok(r.text.includes(e.exact_quote), `${f.id}: quote must be verbatim in the contract: ${e.exact_quote}`);
    assert.ok(e.clause_label && e.clause_label.length > 0, `${f.id}: clause reference`);
  }
}

// ---------------------------------------------------------------------------
// Worker classification: indicators are assessed TOGETHER
// ---------------------------------------------------------------------------
const HOURS = 'Contractor shall work from 9:00 a.m. to 5:00 p.m., Monday through Friday.';
const LOCATION = "Contractor shall perform the Services at the Company's office five days per week.";
const SUPERVISION = "Contractor shall work under the direct supervision of the Company's Director of Engineering.";
const EXCLUSIVE = 'Contractor shall provide services exclusively to Company during the term.';
const EQUIPMENT = 'Contractor must use the laptop and software provided by the Company.';
const NO_DELEGATION = 'Contractor shall personally perform the Services and may not delegate them.';

test.describe('Worker classification — indicators assessed together', () => {
  const severityFor = (...clauses: string[]) => find(review(...clauses), 'classification.indicators')?.severity ?? null;

  test('no indicators, or one non-control indicator alone: nothing is reported', () => {
    assert.equal(severityFor(NEUTRAL), null);
    assert.equal(severityFor(EQUIPMENT), null, 'client equipment alone is common and not conclusive');
    assert.equal(severityFor(EXCLUSIVE), null);
    assert.equal(severityFor('Contractor controls the manner and means of the Services, sets Contractor\'s own hours and may work for other clients.'), null);
  });

  test('a single control indicator is Low; two or three are Medium; many are High', () => {
    assert.equal(severityFor(HOURS), 'Low');
    assert.equal(severityFor(EXCLUSIVE, EQUIPMENT), 'Medium');
    assert.equal(severityFor(HOURS, EQUIPMENT), 'Medium');
    assert.equal(severityFor(HOURS, SUPERVISION, EQUIPMENT), 'High', 'three indicators including two control indicators');
    assert.equal(severityFor(HOURS, LOCATION, SUPERVISION, EXCLUSIVE), 'High');
    assert.equal(severityFor(EXCLUSIVE, EQUIPMENT, NO_DELEGATION, LOCATION), 'High', 'four distinct indicators');
  });

  test('the explanation lists the indicators, is framed as a concern (not a conclusion) and cites each clause', () => {
    const r = review(HOURS, LOCATION, SUPERVISION, EXCLUSIVE);
    const f = find(r, 'classification.indicators')!;
    assert.match(f.explanation, /4 terms that resemble how an employer controls an employee/);
    assert.match(f.explanation, /No single term decides worker status/);
    assert.match(f.explanation, /possible worker-classification concern, not a conclusion/);
    assert.ok(f.evidence.length >= 4);
    assert.ok(!/is (an )?employee|misclassified|illegal/i.test(f.explanation), 'never a legal conclusion');
    assert.equal(f.category, 'Worker Classification');
    assert.equal(f.kind, 'RISK');
  });

  test('an independent-contractor label that conflicts with the terms is noted', () => {
    const r = review(HOURS, SUPERVISION, 'Contractor is an independent contractor and not an employee of Company.');
    const f = find(r, 'classification.indicators')!;
    assert.match(f.explanation, /says you are an independent contractor/);
    assert.ok(f.evidence.some((e) => /independent contractor/.test(e.exact_quote)));
  });

  test('governing jurisdiction is considered when available and its absence is stated as uncertainty', () => {
    const none = find(review(EXCLUSIVE, EQUIPMENT), 'classification.indicators')!;
    assert.equal(none.severity, 'Medium');
    assert.match(none.uncertainty!, /No governing law was identified/);

    const ca = find(review(EXCLUSIVE, EQUIPMENT, 'This Agreement shall be governed by the laws of the State of California.'), 'classification.indicators')!;
    assert.equal(ca.severity, 'High', 'raised one level where stricter tests are commonly applied');
    assert.match(ca.uncertainty!, /california/i);
    assert.match(ca.uncertainty!, /does not decide how an authority would classify/);

    const tx = find(review(EXCLUSIVE, EQUIPMENT, 'This Agreement shall be governed by the laws of the State of Texas.'), 'classification.indicators')!;
    assert.equal(tx.severity, 'Medium', 'no uplift elsewhere');
    assert.match(tx.uncertainty!, /texas/i);

    // One indicator is never raised by jurisdiction alone
    const single = find(review(HOURS, 'This Agreement shall be governed by the laws of the State of California.'), 'classification.indicators')!;
    assert.equal(single.severity, 'Low');
  });
});

// ---------------------------------------------------------------------------
// Data protection relevance: missing data terms only when data is in play
// ---------------------------------------------------------------------------
test.describe('Data protection — relevance', () => {
  test('a contract with no data context produces no data-protection findings', () => {
    const r = review(NEUTRAL, 'Company shall pay Contractor at the rate of $85.00 per hour for approved hours worked.');
    assert.equal(r.report.findings.filter((f) => f.category === 'Data Protection & Security').length, 0);
  });

  test('a full data-protection clause set produces no missing-data findings', () => {
    const r = review(
      D,
      'Contractor shall use the data solely for the purpose of performing the Services.',
      'Contractor shall implement appropriate security measures, including encryption of data.',
      'Contractor shall notify Company of any data breach within 72 hours of discovery.',
      'Upon termination Contractor shall return or delete all personal data.',
      'The parties shall sign a data processing agreement under which Contractor acts as processor.'
    );
    assert.equal(r.report.findings.filter((f) => f.kind === 'MISSING_PROVISION' && f.category === 'Data Protection & Security').length, 0, ids(r.report.findings).join(','));
  });

  test('wording that only hints at data (no stated handling) still counts as context, but missing claims are cross-checked against the text', () => {
    const r = review(D, 'Contractor shall not disclose any security incident publicly.');
    // "security incident" appears in the text, so the engine must not claim breach notification is entirely absent
    assert.equal(find(r, 'data.no_breach_notification'), undefined);
    assert.ok(find(r, 'data.no_breach_notification.unconfirmed'), 'downgraded to an unconfirmed term that cites the real clause');
  });
});
