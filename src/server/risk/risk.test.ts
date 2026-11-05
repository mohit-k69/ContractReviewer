import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  ContractUnderstandingResult,
  EvidenceReference,
  EvidenceStatus,
  FactWithEvidence,
} from '../understanding/types';
import { analyzeContractRisk } from './riskEngine';
import { ClauseIndex } from './clauseIndex';
import { INTELLIGENCE_GROUP_KEYS, INTELLIGENCE_SCHEMA } from '../understanding/intelligenceSchema';
import { RiskFinding } from './types';
import { generateRiskReport, getCachedRiskReport } from './riskService';
import { createApp, initServerRuntime } from '../app';
import { startClamAvDevDaemon } from '../security/clamavDevDaemon';
import {
  initQuarantineStorage,
  storeInQuarantine,
  saveSecurityReport,
} from '../security/quarantineManager';
import { FullSecurityReport } from '../security/types';
import { clearAllCachedUnderstandings } from '../understanding/understandingService';
import { clearAllCachedNormalizations } from '../normalization/normalizationService';
import { clearAllCachedExtractions } from '../extraction/extractionService';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const verified = (element_id: string, source_block_id: string, exact_quote: string): EvidenceReference => ({
  element_id,
  source_block_id,
  exact_quote,
  is_verified: true,
});

const missing = (): FactWithEvidence => ({ status: 'NOT_FOUND', summary: 'No provision found in agreement.', evidence: [] });
const found = (summary: string, ...evidence: EvidenceReference[]): FactWithEvidence => ({
  status: 'FOUND',
  summary,
  evidence,
});
const withStatus = (status: EvidenceStatus, summary: string, ...evidence: EvidenceReference[]): FactWithEvidence => ({
  status,
  summary,
  evidence,
});

/** Every contractor-intelligence fact examined and found absent. */
function intelligenceNotFound(): any {
  const out: any = {};
  for (const g of INTELLIGENCE_GROUP_KEYS) {
    out[g] = {};
    for (const f of Object.keys(INTELLIGENCE_SCHEMA[g])) out[g][f] = missing();
  }
  return out;
}

/** An understanding result where every fact is NOT_FOUND, analyzed completely by the AI model. */
function baseUnderstanding(over: Partial<ContractUnderstandingResult> = {}): ContractUnderstandingResult {
  return {
    document_id: 'doc-1',
    source_file_id: 'file-1',
    verified_sha256: 'sha-1',
    classification: {
      category: 'Freelance / Independent Contractor Agreement',
      confidence: 0.95,
      primary_purpose: 'Freelance services',
      governing_jurisdiction: missing(),
    },
    parties: [
      { name: 'Apex Inc.', legal_entity_type: 'Corporation', role: 'Client', defined_term: 'Company', evidence: [] },
      { name: 'Elena Vance', legal_entity_type: 'Individual', role: 'Contractor', defined_term: 'Contractor', evidence: [] },
    ],
    dates_and_term: {
      effective_date: missing(), execution_date: missing(), commencement_date: missing(),
      expiration_date: missing(), term_duration: missing(), renewal_terms: missing(),
    },
    scope_and_deliverables: {
      scope_description: missing(), deliverables: [], change_order_mechanism: missing(), acceptance_criteria: missing(),
    },
    payment_and_commercial: {
      fee_structure: missing(), rates_and_amounts: missing(), invoicing_schedule: missing(),
      payment_terms_days: missing(), late_payment_terms: missing(), reimbursable_expenses: missing(),
      taxes_and_withholding: missing(),
    },
    obligations: { client_obligations: [], contractor_obligations: [] },
    key_provisions: {
      intellectual_property: { ownership: missing(), pre_existing_ip: missing(), license_granted: missing() },
      confidentiality: { definition: missing(), duration: missing(), carveouts: missing() },
      non_compete: missing(),
      non_solicitation: missing(),
      warranties_and_disclaimers: missing(),
      limitation_of_liability: { liability_cap: missing(), exclusion_of_indirect_damages: missing() },
      indemnification: { contractor_indemnification: missing(), client_indemnification: missing() },
      termination: {
        termination_for_convenience: missing(), termination_for_cause: missing(), post_termination_payment: missing(),
      },
      dispute_resolution: { method: missing(), venue_and_forum: missing(), prevailing_party_legal_fees: missing() },
      independent_contractor_affirmation: missing(),
      entire_agreement: missing(),
    },
    ...intelligenceNotFound(),
    ambiguities_and_conflicts: [],
    omissions_and_missing_terms: [],
    stats: {
      total_facts: 10, verified_facts: 10, verification_percentage: 100,
      total_evidence_references: 0, verified_evidence_references: 0,
    },
    processing_status: 'COMPLETE',
    analysis_source: 'GEMINI',
    model_used: 'test-model',
    analyzed_at: '2025-01-01T00:00:00.000Z',
    processed_sections: ['s1'],
    total_sections_in_document: 1,
    coverage_percentage: 100,
    warnings: [],
    ...over,
  };
}

/** Understanding where nothing is missing: a balanced, contractor-friendly agreement. */
function balancedUnderstanding(): ContractUnderstandingResult {
  const u = baseUnderstanding();
  const f = (s: string, id: string) => found(s, verified(id, `b-${id}`, s));
  u.classification.governing_jurisdiction = f('Governed by the laws of the State of California', 'gov');
  u.payment_and_commercial = {
    fee_structure: f('Hourly', 'fee'), rates_and_amounts: f('$85.00 per hour', 'rate'),
    invoicing_schedule: f('Invoice monthly', 'inv'), payment_terms_days: f('Payable Net 30 days', 'pay'),
    late_payment_terms: f('1.5% interest per month on overdue amounts', 'late'),
    reimbursable_expenses: f('Pre-approved expenses are reimbursed', 'exp'), taxes_and_withholding: f('Contractor pays own taxes', 'tax'),
  };
  u.scope_and_deliverables = {
    scope_description: f('Software engineering services described in Exhibit A', 'scope'), deliverables: [],
    change_order_mechanism: f('Changes require a signed change order', 'chg'),
    acceptance_criteria: f('Deliverables are accepted within 10 business days', 'acc'),
  };
  u.key_provisions = {
    intellectual_property: {
      ownership: f('Client owns deliverables upon full payment', 'own'),
      pre_existing_ip: f('Contractor retains pre-existing materials', 'pre'), license_granted: missing(),
    },
    confidentiality: {
      definition: f('Mutual confidentiality of non-public information', 'cd'),
      duration: f('Survives for three (3) years after termination', 'cdur'),
      carveouts: f('Excludes publicly known information', 'cc'),
    },
    non_compete: missing(), non_solicitation: missing(), warranties_and_disclaimers: missing(),
    limitation_of_liability: {
      liability_cap: f('Liability shall not exceed the fees paid', 'cap'),
      exclusion_of_indirect_damages: f('Neither party is liable for indirect damages', 'ind'),
    },
    indemnification: { contractor_indemnification: missing(), client_indemnification: missing() },
    termination: {
      termination_for_convenience: f('Either party may terminate without cause on thirty (30) days written notice', 'tc'),
      termination_for_cause: f('Either party may terminate for material breach not cured within ten (10) days', 'tcause'),
      post_termination_payment: f('Contractor is paid for all work performed through termination', 'ptp'),
    },
    dispute_resolution: {
      method: f('Disputes are resolved in the state courts', 'dm'),
      venue_and_forum: f('San Francisco County, California', 'ven'), prevailing_party_legal_fees: missing(),
    },
    independent_contractor_affirmation: f('Contractor is an independent contractor', 'ica'),
    entire_agreement: f('This is the entire agreement', 'ea'),
  };
  return u;
}

const ids = (findings: RiskFinding[]) => findings.map((f) => f.id);
const byId = (findings: RiskFinding[], id: string) => findings.find((f) => f.id === id);

// ---------------------------------------------------------------------------
// Risk classification
// ---------------------------------------------------------------------------

test.describe('Phase 3 — risk classification', () => {
  test('1. Payment: long periods and conditional payment are classified by severity', () => {
    const mk = (summary: string) => {
      const u = balancedUnderstanding();
      u.payment_and_commercial.payment_terms_days = found(summary, verified('pay', 'b-pay', summary));
      return analyzeContractRisk(u).findings;
    };
    assert.equal(byId(mk('Invoices are payable Net 75 days'), 'payment.long_terms')?.severity, 'High');
    assert.equal(byId(mk('Invoices are payable Net 50 days'), 'payment.long_terms')?.severity, 'Medium');
    assert.equal(byId(mk('Invoices are payable Net 30 days'), 'payment.long_terms'), undefined);
    const cond = byId(mk('Payable Net 30, but only when the client has itself been paid by its own client (pay-when-paid)'), 'payment.conditional');
    assert.equal(cond?.severity, 'High');
    assert.equal(cond?.kind, 'RISK');
  });

  test('2. Termination: one-sided/immediate is High, mutual notice is clean, very short notice is Medium', () => {
    const mk = (summary: string) => {
      const u = balancedUnderstanding();
      u.key_provisions.termination.termination_for_convenience = found(summary, verified('tc', 'b-tc', summary));
      return analyzeContractRisk(u).findings;
    };
    const oneSided = byId(mk('Company may terminate this Agreement at any time without notice.'), 'termination.one_sided');
    assert.equal(oneSided?.severity, 'High');
    const clientOnlyNotice = byId(mk('Company may terminate this Agreement on thirty (30) days notice.'), 'termination.one_sided');
    assert.equal(clientOnlyNotice?.severity, 'Medium');
    const mutual = mk('Either party may terminate without cause on thirty (30) days written notice.');
    assert.ok(!ids(mutual).some((i) => i.startsWith('termination.')));
    assert.equal(byId(mk('Either party may terminate on 3 days written notice.'), 'termination.short_notice')?.severity, 'Medium');
  });

  test('3. IP: broad assignment is High; transfer before payment is Medium; transfer on payment is clean', () => {
    const mk = (summary: string) => {
      const u = balancedUnderstanding();
      u.key_provisions.intellectual_property.ownership = found(summary, verified('own', 'b-own', summary));
      return analyzeContractRisk(u).findings;
    };
    const broad = mk('Contractor hereby assigns all work product, whether or not related to the Services and including pre-existing tools, immediately upon creation.');
    assert.equal(byId(broad, 'ip.broad_assignment')?.severity, 'High');
    assert.equal(byId(broad, 'ip.transfer_before_payment')?.severity, 'Medium');
    const early = mk('Contractor hereby assigns all deliverables to Client as they are created.');
    assert.equal(byId(early, 'ip.transfer_before_payment')?.severity, 'Medium');
    assert.equal(byId(early, 'ip.broad_assignment'), undefined);
    const clean = mk('All deliverables become the property of Client upon full payment of the fees.');
    assert.ok(!ids(clean).some((i) => i.startsWith('ip.')));
  });

  test('4. Liability: unlimited liability and broad indemnity are High; a cap equal to fees is clean', () => {
    const u = balancedUnderstanding();
    u.key_provisions.limitation_of_liability.liability_cap = found(
      'Contractor liability is unlimited.',
      verified('cap', 'b-cap', 'Contractor liability is unlimited.')
    );
    u.key_provisions.indemnification.contractor_indemnification = found(
      'Contractor shall indemnify Company against any and all claims, losses and legal fees arising out of the Services.',
      verified('ind', 'b-ind', 'Contractor shall indemnify Company against any and all claims, losses and legal fees arising out of the Services.')
    );
    const findings = analyzeContractRisk(u).findings;
    assert.equal(byId(findings, 'liability.unlimited')?.severity, 'High');
    assert.equal(byId(findings, 'liability.contractor_indemnity')?.severity, 'High');
    assert.equal(byId(findings, 'liability.no_client_indemnity')?.kind, 'MISSING_PROVISION');

    const clean = analyzeContractRisk(balancedUnderstanding()).findings;
    assert.ok(!ids(clean).some((i) => i.startsWith('liability.')));
  });

  test('5. Non-compete / exclusivity: long or wide restrictions are High, short local ones Medium, absence is not a finding', () => {
    const mk = (summary: string) => {
      const u = balancedUnderstanding();
      u.key_provisions.non_compete = found(summary, verified('nc', 'b-nc', summary));
      return analyzeContractRisk(u).findings;
    };
    assert.equal(
      byId(mk('For twenty-four (24) months after termination Contractor shall not provide services to any competing business.'), 'restrictions.non_compete')?.severity,
      'High'
    );
    assert.equal(
      byId(mk('During the term Contractor shall not work for the named competitor Globex for six (6) months.'), 'restrictions.non_compete')?.severity,
      'Medium'
    );
    assert.ok(!ids(analyzeContractRisk(balancedUnderstanding()).findings).some((i) => i.startsWith('restrictions.')));

    const u = balancedUnderstanding();
    u.scope_and_deliverables.scope_description = found(
      'Contractor shall provide services exclusively to Company during the term.',
      verified('scope', 'b-scope', 'Contractor shall provide services exclusively to Company during the term.')
    );
    assert.equal(byId(analyzeContractRisk(u).findings, 'restrictions.exclusivity')?.severity, 'High');

    // "exclusive property" in an IP clause is NOT exclusivity
    const ip = balancedUnderstanding();
    ip.scope_and_deliverables.scope_description = found(
      'Deliverables shall be the sole and exclusive property of Client.',
      verified('scope', 'b-scope', 'Deliverables shall be the sole and exclusive property of Client.')
    );
    assert.equal(byId(analyzeContractRisk(ip).findings, 'restrictions.exclusivity'), undefined);
  });

  test('6. Dispute resolution: arbitration is Low; a venue away from the contractor is Medium', () => {
    const u = balancedUnderstanding();
    u.key_provisions.dispute_resolution.method = found(
      'Disputes shall be resolved by binding arbitration.',
      verified('dm', 'b-dm', 'Disputes shall be resolved by binding arbitration.')
    );
    u.key_provisions.dispute_resolution.venue_and_forum = found(
      'Venue is New York, New York.',
      verified('ven', 'b-ven', 'Venue is New York, New York.')
    );
    u.parties[1].address_or_location = 'Austin, Texas';
    const findings = analyzeContractRisk(u).findings;
    assert.equal(byId(findings, 'dispute.arbitration')?.severity, 'Low');
    assert.equal(byId(findings, 'dispute.distant_venue')?.severity, 'Medium');
  });

  test('7. A balanced agreement produces no High findings and a Low review priority', () => {
    const report = analyzeContractRisk(balancedUnderstanding());
    assert.equal(report.findings.filter((f) => f.severity === 'High').length, 0, ids(report.findings).join(','));
    assert.equal(report.overview.review_priority, 'Low');
  });
});

// ---------------------------------------------------------------------------
// Evidence verification
// ---------------------------------------------------------------------------

test.describe('Phase 3 — evidence verification', () => {
  test('8. Unverified evidence is never shown and never creates a risk finding', () => {
    const u = balancedUnderstanding();
    const bad: EvidenceReference = { element_id: 'pay', source_block_id: 'b-pay', exact_quote: 'Net 90 days', is_verified: false };
    const unset: EvidenceReference = { element_id: 'pay', source_block_id: 'b-pay', exact_quote: 'Net 90 days' };
    u.payment_and_commercial.payment_terms_days = found('Payable Net 90 days', bad, unset);
    const report = analyzeContractRisk(u);
    assert.equal(byId(report.findings, 'payment.long_terms'), undefined, 'cannot assert a risk from unverified text');
    for (const f of report.findings) {
      for (const e of f.evidence) assert.notEqual(e.exact_quote, 'Net 90 days');
    }
  });

  test('9. Evidence carries the original element id, block id, verbatim quote and clause reference', () => {
    const u = balancedUnderstanding();
    const quote = 'Invoices are payable Net 75 days from receipt';
    u.payment_and_commercial.payment_terms_days = found(quote, verified('sec-2-clause-2', 'block-7', quote));
    const clauses: ClauseIndex = new Map([
      [
        'sec-2-clause-2',
        {
          label: 'Section 2. Compensation › 2.2 Payment Due',
          text: `2.2 Payment Due. ${quote} of a valid invoice.`,
          full_text: `2.2 Payment Due. ${quote} of a valid invoice.`,
          descendant_ids: [],
          blocks: [{ id: 'block-7', text: `2.2 Payment Due. ${quote} of a valid invoice.` }],
        },
      ],
    ]);
    const finding = byId(analyzeContractRisk(u, clauses).findings, 'payment.long_terms')!;
    assert.equal(finding.evidence.length, 1);
    const e = finding.evidence[0];
    assert.equal(e.element_id, 'sec-2-clause-2');
    assert.equal(e.source_block_id, 'block-7');
    assert.equal(e.clause_label, 'Section 2. Compensation › 2.2 Payment Due');
    assert.ok(e.clause_text!.includes(e.exact_quote), 'quote must be verbatim within the clause text');
  });

  test('10. Missing provisions never carry evidence and say so explicitly', () => {
    const report = analyzeContractRisk(baseUnderstanding());
    // Material findings and informational observations are both absences: neither may carry evidence
    const missingFindings = [...report.findings, ...report.observations].filter((f) => f.kind === 'MISSING_PROVISION');
    assert.ok(missingFindings.length >= 8);
    assert.ok(report.findings.filter((f) => f.kind === 'MISSING_PROVISION').length >= 2, 'core terms (fee, scope) are still material');
    for (const f of missingFindings) {
      assert.deepEqual(f.evidence, [], `${f.id} must have no evidence`);
      assert.match(f.evidence_note!, /No clause was found/);
      assert.ok(f.uncertainty && f.uncertainty.length > 0);
    }
  });

  test('11. Every finding states confidence and a practical suggestion', () => {
    const report = analyzeContractRisk(baseUnderstanding());
    for (const f of report.findings) {
      assert.ok(['High', 'Medium', 'Low'].includes(f.severity));
      assert.ok(['High', 'Medium', 'Low'].includes(f.confidence.level));
      assert.ok(f.confidence.reasons.length > 0);
      assert.ok(f.title && f.explanation && f.why_it_matters && f.suggestion, f.id);
    }
    // The built-in rule engine lowers confidence
    const fallback = analyzeContractRisk(baseUnderstanding({ analysis_source: 'DETERMINISTIC_FALLBACK' }));
    assert.ok(fallback.findings.every((f) => f.confidence.level !== 'High'));
  });
});

// ---------------------------------------------------------------------------
// Missing provisions
// ---------------------------------------------------------------------------

test.describe('Phase 3 — missing provisions', () => {
  test('12. With full coverage, absent protections are reported as MISSING with sensible severities', () => {
    const report = analyzeContractRisk(baseUnderstanding());
    assert.equal(byId(report.findings, 'payment.no_fee')?.severity, 'High');
    assert.equal(byId(report.findings, 'scope.no_scope')?.severity, 'High');
    // In a contract with no liability exposure or dispute context, these absences are observations, not risks
    for (const id of ['liability.no_cap', 'dispute.no_governing_law']) {
      assert.equal(byId(report.findings, id), undefined, `${id} is not a material finding without context`);
      const obs = byId(report.observations, id)!;
      assert.equal(obs.kind, 'MISSING_PROVISION');
      assert.equal(obs.severity, 'Low');
      assert.equal(obs.relevance!.material, false);
    }
    // ...and they become material findings once the contract makes them relevant
    const withContext = baseUnderstanding();
    withContext.key_provisions.indemnification.contractor_indemnification = found(
      'Contractor shall indemnify Company against all claims.',
      verified('ind', 'b-ind', 'Contractor shall indemnify Company against all claims.')
    );
    const relevant = analyzeContractRisk(withContext);
    assert.equal(byId(relevant.findings, 'liability.no_cap')?.kind, 'MISSING_PROVISION');
    assert.equal(byId(relevant.findings, 'liability.no_cap')?.relevance?.material, true);
    assert.equal(byId(relevant.findings, 'dispute.no_governing_law')?.severity, 'Medium');
    assert.equal(report.analysis.missing_provisions_assessed, true);
    // Things whose absence favours the contractor are NOT flagged
    assert.equal(byId(report.findings, 'restrictions.non_compete'), undefined);
    assert.equal(byId(report.findings, 'liability.contractor_indemnity'), undefined);
  });

  test('13. With partial coverage, missing provisions are not asserted and areas are "Not assessed"', () => {
    const report = analyzeContractRisk(
      baseUnderstanding({ processing_status: 'PARTIAL', coverage_percentage: 40 })
    );
    assert.equal(report.findings.filter((f) => f.kind === 'MISSING_PROVISION').length, 0);
    assert.equal(report.analysis.missing_provisions_assessed, false);
    assert.ok(report.overview.category_indicators.every((c) => c.level === 'Not assessed'));
    assert.ok(report.limitations.some((l) => /40%/.test(l)));
    assert.ok(report.overview.rationale.some((r) => /Only part of the document/.test(r)));
  });

  test('14. A "missing" claim is cross-checked against the real document text', () => {
    const u = baseUnderstanding();
    // Extraction said NOT_FOUND for the late-fee, indemnity cap etc, but the document has wording for ownership.
    const text = '3.1 Ownership. Contractor hereby assigns to Company all work product created under this Agreement.';
    const clauses: ClauseIndex = new Map([
      ['sec-3-clause-1', { label: 'Section 3 › 3.1 Ownership', text, full_text: text, descendant_ids: [], blocks: [{ id: 'block-9', text }] }],
    ]);
    const report = analyzeContractRisk(u, clauses);
    assert.equal(byId(report.findings, 'ip.no_ownership'), undefined, 'must not claim ownership is missing');
    const unconfirmed = byId(report.findings, 'ip.no_ownership.unconfirmed')!;
    assert.equal(unconfirmed.kind, 'AMBIGUOUS_TERM');
    assert.equal(unconfirmed.evidence.length, 1);
    assert.equal(unconfirmed.evidence[0].source_block_id, 'block-9');
    assert.ok(text.includes(unconfirmed.evidence[0].exact_quote), 'cited quote is verbatim');
    // Without such wording the same topic really is missing
    // Without such wording the same topic really is absent; it is material once the contract has deliverables
    const bare = analyzeContractRisk(u);
    assert.equal(byId(bare.observations, 'ip.no_ownership')?.kind, 'MISSING_PROVISION');
    const withWork = baseUnderstanding();
    withWork.scope_and_deliverables.deliverables = [found('Design files.', verified('d1', 'b-d1', 'Design files.'))];
    assert.equal(byId(analyzeContractRisk(withWork).findings, 'ip.no_ownership')?.kind, 'MISSING_PROVISION');
  });

  test('15. A missing High protection is not confused with "limited liability company"', () => {
    const text = 'This Agreement is between Northwind Digital LLC, a Delaware limited liability company, and Jordan.';
    const clauses: ClauseIndex = new Map([
      ['pre', { label: 'Preamble', text, full_text: text, descendant_ids: [], blocks: [{ id: 'block-2', text }] }],
    ]);
    const u = baseUnderstanding();
    u.key_provisions.indemnification.contractor_indemnification = found(
      'Contractor shall indemnify Company against all claims.',
      verified('ind', 'b-ind', 'Contractor shall indemnify Company against all claims.')
    );
    const report = analyzeContractRisk(u, clauses);
    assert.equal(byId(report.findings, 'liability.no_cap')?.kind, 'MISSING_PROVISION');
  });
});

// ---------------------------------------------------------------------------
// Contradictions and ambiguities (from Phase 2C)
// ---------------------------------------------------------------------------

test.describe('Phase 3 — contradictory and ambiguous provisions', () => {
  test('16. Phase 2C conflicts become CONTRADICTORY findings that keep their summary and both evidence references', () => {
    const u = balancedUnderstanding();
    const e1 = verified('sec-2-clause-2', 'block-7', 'payable within 15 days');
    const e2 = verified('sec-9-clause-1', 'block-30', 'payable within 30 days');
    const description = 'Conflicting terms for Payment Terms across document sections (incompatible values: 15 days vs 30 days).';
    u.payment_and_commercial.payment_terms_days = withStatus('CONFLICTING', description, e1, e2);
    u.ambiguities_and_conflicts = [{ topic: 'Payment Terms', description, evidence: [e1, e2] }];
    const report = analyzeContractRisk(u);
    const conflict = byId(report.findings, 'conflict.payment_terms')!;
    assert.equal(conflict.kind, 'CONTRADICTORY_PROVISIONS');
    assert.equal(conflict.severity, 'High');
    assert.equal(conflict.category, 'Payment');
    assert.match(conflict.explanation, /15 days vs 30 days/);
    assert.deepEqual(conflict.evidence.map((e) => e.exact_quote), ['payable within 15 days', 'payable within 30 days']);
    // The duplicate Phase 2C record (same evidence) is not reported a second time
    assert.equal(report.findings.filter((f) => f.kind === 'CONTRADICTORY_PROVISIONS').length, 1);
    assert.equal(report.overview.counts_by_kind.CONTRADICTORY_PROVISIONS, 1);
  });

  test('17. Ambiguous facts and unrelated Phase 2C records become AMBIGUOUS_TERM findings; empty placeholders are ignored', () => {
    const u = balancedUnderstanding();
    u.payment_and_commercial.rates_and_amounts = withStatus(
      'AMBIGUOUS', 'Fee to be mutually agreed later.', verified('rate', 'b-rate', 'fee to be mutually agreed later')
    );
    u.key_provisions.warranties_and_disclaimers = withStatus('AMBIGUOUS', 'Provision not identified in analyzed chunks (document coverage was partial).');
    u.ambiguities_and_conflicts = [
      {
        topic: 'Confidentiality survival',
        description: 'Survival period is described as "reasonable".',
        evidence: [verified('cd', 'b-cd', 'reasonable period')],
      },
    ];
    const report = analyzeContractRisk(u);
    const rate = byId(report.findings, 'ambiguity.rates')!;
    assert.equal(rate.kind, 'AMBIGUOUS_TERM');
    assert.equal(rate.severity, 'Medium');
    assert.equal(byId(report.findings, 'ambiguity.warranties'), undefined);
    const phase2c = byId(report.findings, 'phase2c.0')!;
    assert.equal(phase2c.kind, 'AMBIGUOUS_TERM');
    assert.equal(phase2c.category, 'Confidentiality');
    assert.equal(phase2c.severity, 'Low');
    assert.equal(phase2c.evidence.length, 1);
  });

  test('18. The four finding kinds stay distinct in one report', () => {
    const u = baseUnderstanding();
    u.payment_and_commercial.payment_terms_days = found('Net 90 days', verified('pay', 'b-pay', 'Net 90 days')); // RISK
    u.payment_and_commercial.rates_and_amounts = withStatus('AMBIGUOUS', 'Rate unclear', verified('rate', 'b-rate', 'rate unclear')); // AMBIGUOUS
    u.dates_and_term.effective_date = withStatus('CONFLICTING', 'Two start dates', verified('d1', 'b-d1', 'Oct 1'), verified('d2', 'b-d2', 'Nov 1')); // CONTRADICTORY (dates)
    u.classification.governing_jurisdiction = withStatus('CONFLICTING', 'California vs New York', verified('g1', 'b-g1', 'California'), verified('g2', 'b-g2', 'New York')); // CONTRADICTORY
    const report = analyzeContractRisk(u);
    const kinds = new Set(report.findings.map((f) => f.kind));
    for (const k of ['RISK', 'MISSING_PROVISION', 'AMBIGUOUS_TERM', 'CONTRADICTORY_PROVISIONS']) {
      assert.ok(kinds.has(k as any), `missing kind ${k}`);
    }
    // Phase 2C conflicts on dates and on governing law are both preserved
    assert.equal(byId(report.findings, 'conflict.effective_date')?.kind, 'CONTRADICTORY_PROVISIONS');
    assert.equal(byId(report.findings, 'conflict.governing_law')?.kind, 'CONTRADICTORY_PROVISIONS');
    assert.equal(byId(report.findings, 'conflict.effective_date')?.evidence.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Overview, checklist, safety
// ---------------------------------------------------------------------------

test.describe('Phase 3 — overview and report', () => {
  test('19. Review priority follows the explicit rule and there is no numeric score', () => {
    const high = analyzeContractRisk(baseUnderstanding());
    assert.equal(high.overview.review_priority, 'High');

    const medium = balancedUnderstanding();
    medium.payment_and_commercial.payment_terms_days = found('Net 50 days', verified('pay', 'b-pay', 'Net 50 days'));
    const r = analyzeContractRisk(medium);
    assert.equal(r.overview.review_priority, 'Medium');
    // The original eight areas are all still reported, alongside the contractor-intelligence areas
    const areas = r.overview.category_indicators.map((c) => c.category);
    for (const original of [
      'Payment', 'Scope of Work', 'Termination', 'Intellectual Property', 'Liability & Indemnification',
      'Confidentiality', 'Non-Compete, Exclusivity & Non-Solicitation', 'Dispute Resolution & Governing Law',
    ]) {
      assert.ok(areas.includes(original as any), `missing area ${original}`);
    }
    for (const added of [
      'Worker Classification', 'Data Protection & Security', 'Insurance', 'Subcontracting & Delegation',
      'Tax', 'Renewal', 'Warranties',
    ]) {
      assert.ok(areas.includes(added as any), `missing area ${added}`);
    }
    assert.equal(areas.length, 15);
    assert.equal(r.overview.category_indicators.find((c) => c.category === 'Payment')?.level, 'Medium');
    assert.match(r.overview.rule, /highest severity/);
    assert.ok(r.overview.rationale.length >= 1);

    const json = JSON.stringify(high);
    assert.ok(!/"(risk_)?score"/i.test(json), 'no numeric score fields');
    assert.match(high.disclaimer, /not legal advice/i);
    assert.match(high.disclaimer, /enforceab/i);
  });

  test('20. Findings are prioritised and the checklist lists High and Medium actions first', () => {
    const report = analyzeContractRisk(baseUnderstanding());
    const rank = { High: 3, Medium: 2, Low: 1 } as const;
    for (let i = 1; i < report.findings.length; i++) {
      assert.ok(rank[report.findings[i - 1].severity] >= rank[report.findings[i].severity]);
    }
    assert.equal(report.checklist[0].priority, 'High');
    assert.ok(report.checklist.some((c) => c.id === 'check.legal_review'));
    assert.ok(!report.checklist.some((c) => c.finding_id && byId(report.findings, c.finding_id)?.severity === 'Low'));
    assert.ok(report.checklist.some((c) => /Elena Vance/.test(c.text)), 'party confirmation item');
  });

  test('21. The analysis is deterministic and does not mutate its input', () => {
    const u = baseUnderstanding();
    u.payment_and_commercial.payment_terms_days = found('Net 90 days', verified('pay', 'b-pay', 'Net 90 days'));
    const before = JSON.stringify(u);
    const a = analyzeContractRisk(u);
    const b = analyzeContractRisk(u);
    assert.equal(JSON.stringify(u), before);
    assert.deepEqual(a.findings, b.findings);
    assert.deepEqual(a.overview, b.overview);
  });

  test('22. Non-freelance contracts and unverified facts are called out as limitations', () => {
    const u = baseUnderstanding();
    u.classification.category = 'Non-Disclosure Agreement';
    u.stats = { total_facts: 10, verified_facts: 7, verification_percentage: 70, total_evidence_references: 5, verified_evidence_references: 3 };
    const report = analyzeContractRisk(u);
    assert.ok(report.limitations.some((l) => /Freelance/.test(l) && /Non-Disclosure/.test(l)));
    assert.ok(report.limitations.some((l) => /3 extracted items could not be verified/.test(l)));
  });

  test('23. Key terms are reported with status and verified evidence only', () => {
    const u = balancedUnderstanding();
    u.dates_and_term.effective_date = found('October 1, 2025', verified('pre', 'b-1', 'October 1, 2025'));
    const report = analyzeContractRisk(u);
    const eff = report.key_terms.find((t) => t.label === 'Effective date')!;
    assert.equal(eff.status, 'FOUND');
    assert.equal(eff.evidence.length, 1);
    const termination = report.key_terms.find((t) => t.label === 'Term')!;
    assert.equal(termination.value, 'Not found in the contract');
    assert.deepEqual(termination.evidence, []);
  });
});

// ---------------------------------------------------------------------------
// Integration through the real pipeline and the real HTTP routes
// ---------------------------------------------------------------------------

const SAMPLE_PATH = path.resolve(process.cwd(), 'samples', 'risky-freelance-agreement.txt');

function cleanReport(fileId: string, metadata: any, size: number): FullSecurityReport {
  return {
    fileId,
    status: 'CLEAN_NO_KNOWN_THREATS',
    statusMessage: 'Clean',
    eligibleForContractProcessing: true,
    metadata,
    authenticity: { passed: true, detectedFormat: 'txt', mimeMatch: true, doubleExtensionDetected: false, passwordProtected: false, corrupted: false, details: [] },
    structure: { passed: true, isZipBomb: false, entryCount: 1, decompressedSize: size, decompressionRatio: 1, pathTraversalAttempts: [], malformedStructure: false, details: [] },
    activeContent: { passed: true, hasJavaScript: false, hasAutomaticActions: false, hasLaunchActions: false, hasEmbeddedFiles: false, hasMacros: false, hasOleObjects: false, hasSuspiciousExternalRelationships: false, hasInvalidEncoding: false, details: [] },
    malware: { passed: true, engine: 'MockEngine', threatsFound: [], scannerAvailable: true, details: [] },
    promptInjection: { passed: true, flaggedPatterns: [], riskLevel: 'NONE', details: [] },
    scanDurationMs: 1,
    completedAt: new Date().toISOString(),
  };
}

test.describe('Phase 3 — end-to-end through the existing pipeline', () => {
  test('24. A freelance agreement flows through extraction, normalization and understanding into a traceable risk report', async () => {
    initQuarantineStorage();
    clearAllCachedUnderstandings();
    clearAllCachedNormalizations();
    clearAllCachedExtractions();
    delete process.env.GEMINI_API_KEY; // deterministic fallback path, no network

    const buffer = fs.readFileSync(SAMPLE_PATH);
    const sourceText = buffer.toString('utf8');
    const session = 'risk-e2e-session';
    const { fileId, metadata } = storeInQuarantine(buffer, 'risky.txt', 'text/plain', session);
    saveSecurityReport(cleanReport(fileId, metadata, buffer.length));

    // No cached understanding yet: GET-style lookup must not trigger analysis
    assert.equal(getCachedRiskReport(fileId, session).exists, false);

    const response = await generateRiskReport(fileId, session);
    assert.equal(response.success, true, response.error);
    const report = response.report!;

    assert.equal(report.contract_type, 'Freelance / Independent Contractor Agreement');
    assert.equal(report.overview.review_priority, 'High');
    assert.equal(report.analysis.processing_status, 'COMPLETE');
    assert.equal(report.analysis.missing_provisions_assessed, true);
    assert.ok(report.parties.some((p) => /Northwind/.test(p.name)));

    const expected = [
      'payment.long_terms', 'payment.conditional', 'termination.one_sided', 'ip.broad_assignment',
      'liability.contractor_indemnity', 'restrictions.exclusivity', 'restrictions.non_compete',
      'confidentiality.perpetual', 'liability.no_cap',
    ];
    for (const id of expected) assert.ok(byId(report.findings, id), `expected finding ${id}; got ${ids(report.findings).join(', ')}`);

    // Ownership exists in the contract: it must NOT be reported as missing.
    assert.equal(byId(report.findings, 'ip.no_ownership'), undefined);

    // Every cited quote is a verbatim substring of the uploaded document, with clause references.
    let cited = 0;
    for (const f of report.findings) {
      if (f.kind === 'MISSING_PROVISION') assert.equal(f.evidence.length, 0);
      for (const e of f.evidence) {
        cited++;
        assert.ok(sourceText.includes(e.exact_quote), `quote not verbatim in source: ${e.exact_quote}`);
        assert.ok(e.clause_label && e.clause_label.length > 0);
        assert.match(e.element_id, /^(sec|subsec|clause|par)/);
      }
    }
    assert.ok(cited >= 8);

    // The highlighted quote is the wording that triggered the finding, and labels are short, readable references.
    const conditional = byId(report.findings, 'payment.conditional')!;
    assert.match(conditional.evidence[0].exact_quote, /conditioned on/i);
    const longTerms = byId(report.findings, 'payment.long_terms')!;
    assert.match(longTerms.evidence[0].exact_quote, /Net 75/);
    const nonCompete = byId(report.findings, 'restrictions.non_compete')!;
    assert.match(nonCompete.evidence[0].exact_quote, /twenty-four \(24\) months/);
    assert.match(nonCompete.evidence[0].clause_label!, /RESTRICTIVE COVENANTS › 6\.1 Non-Competition$/);
    for (const f of report.findings) for (const e of f.evidence) assert.ok(e.clause_label!.length <= 150, e.clause_label);
    assert.ok(report.checklist.length >= 8);

    // Cached retrieval now works and is session-protected
    const cached = getCachedRiskReport(fileId, session);
    assert.equal(cached.exists, true);
    assert.ok(cached.report);
    const other = await generateRiskReport(fileId, 'a-different-session');
    assert.equal(other.authorized, false);
    assert.match(other.error!, /Session ownership mismatch/);
    assert.equal(getCachedRiskReport(fileId, 'a-different-session').authorized, false);
  });
});

test.describe('Phase 3 — HTTP API (same Express app used by the server and by Vercel)', () => {
  test('25. Health, authentication, upload, risk report, caching and ownership over real HTTP', async () => {
    delete process.env.GEMINI_API_KEY;
    process.env.ALLOW_DEMO_SCANNER = '1'; // the demo scanner must be enabled explicitly, and is for tests only
    const daemon = await startClamAvDevDaemon();
    process.env.CLAMAV_HOST = daemon.host;
    process.env.CLAMAV_PORT = String(daemon.port);
    await initServerRuntime();

    const server = createServer(createApp());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      assert.equal(health.ok, true);
      assert.ok(health.routes.some((r: string) => r.includes('risk-report')));

      // Unauthenticated access is rejected on every protected route (not 404)
      for (const [method, p] of [
        ['POST', '/api/contracts/x/risk-report'], ['GET', '/api/contracts/x/risk-report'],
        ['POST', '/api/contracts/x/understand'], ['GET', '/api/contracts/x/security-status'],
      ] as const) {
        const r = await fetch(`${base}${p}`, { method });
        assert.equal(r.status, 401, `${method} ${p}`);
      }

      const cookieOf = async () => {
        const r = await fetch(`${base}/api/auth/session`);
        assert.equal(r.status, 200);
        return r.headers.getSetCookie()[0].split(';')[0];
      };
      const cookieA = await cookieOf();
      const cookieB = await cookieOf();

      // "Pasted" contract text is uploaded as a .txt file through the same pipeline
      const pasted = fs.readFileSync(SAMPLE_PATH, 'utf8');
      const form = new FormData();
      form.append('file', new Blob([pasted], { type: 'text/plain' }), 'pasted-contract.txt');
      const up = await fetch(`${base}/api/contracts/upload`, { method: 'POST', headers: { cookie: cookieA }, body: form });
      assert.equal(up.status, 200);
      const security = await up.json();
      assert.equal(security.status, 'CLEAN_NO_KNOWN_THREATS', JSON.stringify(security).slice(0, 300));
      assert.equal(security.eligibleForContractProcessing, true);
      const fileId = security.fileId;

      // No report before analysis
      assert.equal((await fetch(`${base}/api/contracts/${fileId}/risk-report`, { headers: { cookie: cookieA } })).status, 404);

      const post = await fetch(`${base}/api/contracts/${fileId}/risk-report`, { method: 'POST', headers: { cookie: cookieA } });
      assert.equal(post.status, 200);
      const report = await post.json();
      assert.equal(report.overview.review_priority, 'High');
      assert.ok(report.findings.length >= 10);
      assert.ok(report.key_terms.length > 0);

      const get = await fetch(`${base}/api/contracts/${fileId}/risk-report`, { headers: { cookie: cookieA } });
      assert.equal(get.status, 200);
      assert.equal((await get.json()).document_id, report.document_id);

      // Another session cannot read or generate the report
      assert.equal((await fetch(`${base}/api/contracts/${fileId}/risk-report`, { headers: { cookie: cookieB } })).status, 403);
      assert.equal((await fetch(`${base}/api/contracts/${fileId}/risk-report`, { method: 'POST', headers: { cookie: cookieB } })).status, 403);

      // The existing endpoints keep working on the same file
      assert.equal((await fetch(`${base}/api/contracts/${fileId}/understand`, { headers: { cookie: cookieA } })).status, 200);
      assert.equal((await fetch(`${base}/api/contracts/${fileId}/normalize`, { headers: { cookie: cookieA } })).status, 200);
      assert.equal((await fetch(`${base}/api/contracts/${fileId}/extract`, { headers: { cookie: cookieA } })).status, 200);
      assert.equal((await fetch(`${base}/api/contracts/${fileId}/security-status`, { headers: { cookie: cookieA } })).status, 200);
      assert.equal((await fetch(`${base}/api/contracts/${fileId}`, { method: 'DELETE', headers: { cookie: cookieA } })).status, 200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await daemon.close();
    }
  });

  test('26. Single-request analysis (?analyze=1) returns every stage and still blocks malware', async () => {
    delete process.env.GEMINI_API_KEY;
    process.env.ALLOW_DEMO_SCANNER = '1'; // the demo scanner must be enabled explicitly, and is for tests only
    const daemon = await startClamAvDevDaemon();
    process.env.CLAMAV_HOST = daemon.host;
    process.env.CLAMAV_PORT = String(daemon.port);
    await initServerRuntime();

    const server = createServer(createApp());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const session = async () => (await fetch(`${base}/api/auth/session`)).headers.getSetCookie()[0].split(';')[0];

    try {
      const cookie = await session();
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(SAMPLE_PATH, 'utf8')], { type: 'text/plain' }), 'pasted-contract.txt');
      const res = await fetch(`${base}/api/contracts/upload?analyze=1`, { method: 'POST', headers: { cookie }, body: form });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'CLEAN_NO_KNOWN_THREATS');
      assert.ok(body.analysis.extractionResult, 'extraction stage');
      assert.ok(body.analysis.normalizedDocument.total_sections >= 8, 'normalization stage');
      assert.ok(body.analysis.understandingResult.stats.verification_percentage === 100, 'understanding + evidence verification');
      assert.equal(body.analysis.riskReport.overview.review_priority, 'High', 'risk report');
      assert.equal(body.analysis.error, undefined);

      // The results persist in-process for the step-by-step endpoints too, owned by the same session only
      const other = await session();
      assert.equal((await fetch(`${base}/api/contracts/${body.fileId}/risk-report`, { headers: { cookie } })).status, 200);
      assert.equal((await fetch(`${base}/api/contracts/${body.fileId}/risk-report`, { headers: { cookie: other } })).status, 403);

      // Without ?analyze=1 the upload behaves exactly as before (security report only)
      const plain = new FormData();
      plain.append('file', new Blob(['Short note.'], { type: 'text/plain' }), 'note.txt');
      const plainRes = await (await fetch(`${base}/api/contracts/upload`, { method: 'POST', headers: { cookie }, body: plain })).json();
      assert.equal(plainRes.analysis, undefined);

      // Malware is detected as a THREAT and never reaches analysis
      const evil = new FormData();
      evil.append(
        'file',
        new Blob(['X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'], { type: 'text/plain' }),
        'evil.txt'
      );
      const evilRes = await (await fetch(`${base}/api/contracts/upload?analyze=1`, { method: 'POST', headers: { cookie }, body: evil })).json();
      assert.equal(evilRes.status, 'THREAT_DETECTED');
      assert.equal(evilRes.eligibleForContractProcessing, false);
      assert.equal(evilRes.analysis, undefined);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await daemon.close();
    }
  });
});

