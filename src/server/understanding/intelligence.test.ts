import test from 'node:test';
import assert from 'node:assert/strict';
import { review, runPipeline, fixtureText } from '../risk/testSupport';
import { validateGeminiUnderstandingResponse } from './responseValidator';
import { setGeminiGeneratorMock, understandContractWithGemini } from './geminiClient';
import { mergeChunkResults, mergeFactWithEvidence } from './longDocumentProcessor';
import { validateUnderstandingResult } from './evidenceValidator';
import { analyzeContractDeterministically } from './deterministicAnalyzer';
import { buildUnderstandingPrompt, UNDERSTANDING_SYSTEM_PROMPT } from './promptBuilder';
import { compareFoundFacts, extractAmounts, extractDurations, extractTaxBasis } from './conflictDetector';
import {
  INTELLIGENCE_GROUP_KEYS,
  INTELLIGENCE_SCHEMA,
  intelligenceFactPaths,
} from './intelligenceSchema';
import { AmbiguityOrConflict, ContractUnderstandingResult, EvidenceStatus, FactWithEvidence } from './types';

const NEUTRAL = 'Contractor shall deliver the Services on time.';

type Case = {
  path: string; // group.field
  positive: string;
  negative: string;
  /** Vague wording for fields where AMBIGUOUS is meaningful */
  ambiguous?: string;
};

const CASES: Case[] = [
  // --- worker classification
  { path: 'worker_classification.prescribed_hours', positive: 'Contractor shall work from 9:00 a.m. to 5:00 p.m. on business days.', negative: 'Company shall pay Contractor $90 per hour for approved hours worked.' },
  { path: 'worker_classification.mandatory_location', positive: "Contractor shall perform the Services at the Company's office.", negative: 'Contractor may perform the Services from any location Contractor chooses.' },
  { path: 'worker_classification.direct_supervision', positive: "Contractor shall work under the direct supervision of the Company's engineering manager.", negative: 'Contractor shall determine the methods used to perform the Services.' },
  { path: 'worker_classification.exclusivity', positive: 'Contractor shall provide services exclusively to Company during the term.', negative: 'The deliverables shall be the exclusive property of Company upon full payment.' },
  { path: 'worker_classification.no_delegation', positive: 'Contractor shall personally perform the Services and may not delegate them.', negative: 'Contractor may use assistants to perform the Services.' },
  { path: 'worker_classification.client_equipment', positive: 'Contractor must use the laptop and software provided by the Company.', negative: "Contractor shall use Contractor's own equipment." },
  { path: 'worker_classification.independent_business_restrictions', positive: "Contractor shall not advertise or market Contractor's own consulting business during the term.", negative: "Contractor may advertise Contractor's services to others." },
  { path: 'worker_classification.control_over_timing_and_manner', positive: 'Company shall determine the timing and manner in which the Services are performed.', negative: 'Contractor shall decide when and how to perform the Services.' },
  // --- data protection
  { path: 'data_protection.handles_personal_data', positive: "Contractor will have access to personal data of Company's customers.", negative: 'Contractor will design the user interface for the mobile application.' },
  { path: 'data_protection.permitted_purposes', positive: 'Contractor shall use the data solely for the purpose of performing the Services.', negative: NEUTRAL },
  { path: 'data_protection.security_obligations', positive: 'Contractor shall implement appropriate security measures, including encryption of data.', negative: NEUTRAL },
  { path: 'data_protection.breach_notification', positive: 'Contractor shall notify Company of any data breach within 72 hours of discovery.', negative: "Contractor shall keep Company's information confidential." },
  { path: 'data_protection.return_or_deletion', positive: 'Upon termination Contractor shall return or delete all personal data.', negative: 'Contractor shall keep personal data confidential.' },
  { path: 'data_protection.third_party_access', positive: 'Contractor shall not disclose personal data to any third party or subcontractor without consent.', negative: 'Contractor shall keep personal data confidential.' },
  { path: 'data_protection.cross_border_transfer', positive: 'Contractor shall not transfer personal data outside the European Economic Area.', negative: 'Contractor shall keep personal data confidential.' },
  { path: 'data_protection.processing_agreement', positive: 'The parties shall sign a data processing agreement under which Contractor acts as processor.', negative: 'The parties shall sign a statement of work.' },
  // --- insurance
  { path: 'insurance.professional_indemnity', positive: 'Contractor shall maintain professional liability insurance throughout the term.', negative: 'Contractor shall maintain accurate records of hours worked.' },
  { path: 'insurance.general_liability', positive: 'Contractor shall maintain commercial general liability insurance.', negative: 'Contractor shall maintain accurate records.' },
  { path: 'insurance.cyber', positive: 'Contractor shall maintain cyber liability insurance.', negative: 'Contractor shall maintain accurate records.' },
  { path: 'insurance.minimum_coverage', positive: 'Contractor shall maintain insurance with limits of not less than $2,000,000 per claim.', negative: 'Contractor shall maintain accurate records.', ambiguous: 'Contractor shall maintain adequate insurance coverage as required by Company.' },
  { path: 'insurance.additional_insured', positive: 'Contractor shall name Company as an additional insured.', negative: 'Contractor shall name a project lead.' },
  { path: 'insurance.evidence_of_insurance', positive: 'Contractor shall provide certificates of insurance upon request.', negative: 'Contractor shall provide status reports weekly.' },
  { path: 'insurance.post_termination_maintenance', positive: 'Contractor shall maintain such insurance for three years after termination.', negative: 'Contractor shall maintain insurance during the term.' },
  // --- subcontracting
  { path: 'subcontracting.prohibition', positive: 'Contractor shall not subcontract any part of the Services.', negative: "Contractor may subcontract with Company's prior written consent." },
  { path: 'subcontracting.approval_requirement', positive: "Contractor shall not subcontract any part of the Services without Company's prior written consent.", negative: NEUTRAL },
  { path: 'subcontracting.permission', positive: 'Contractor may engage subcontractors to perform parts of the Services.', negative: NEUTRAL },
  { path: 'subcontracting.delegation_restriction', positive: 'Contractor shall personally perform the Services.', negative: NEUTRAL },
  { path: 'subcontracting.responsibility_for_subcontractors', positive: 'Contractor remains responsible for the acts and omissions of its subcontractors.', negative: NEUTRAL },
  { path: 'subcontracting.liability_for_subcontractors', positive: "Contractor shall be liable for any claims arising from its subcontractors' work.", negative: NEUTRAL },
  { path: 'subcontracting.flow_down_obligations', positive: 'Each subcontractor shall be bound by written confidentiality obligations no less protective than this Agreement.', negative: NEUTRAL },
  // --- tax
  { path: 'tax_details.contractor_income_tax', positive: "Contractor is solely responsible for Contractor's income taxes and self-employment taxes.", negative: 'Company shall pay Contractor monthly.' },
  { path: 'tax_details.client_withholding', positive: 'Company may withhold from payments any taxes required by law.', negative: 'Company shall pay Contractor monthly.' },
  { path: 'tax_details.indirect_taxes', positive: 'VAT will be added to invoices where applicable.', negative: 'Company shall pay Contractor monthly.' },
  { path: 'tax_details.tax_indemnification', positive: 'Contractor shall indemnify Company against any taxes and penalties assessed in connection with payments.', negative: 'Company shall pay Contractor monthly.' },
  { path: 'tax_details.amounts_tax_basis', positive: 'All fees are exclusive of applicable taxes.', negative: 'Company shall pay Contractor monthly.' },
  // --- renewal
  { path: 'renewal_details.auto_renewal', positive: 'This Agreement shall automatically renew for successive twelve (12) month terms.', negative: 'This Agreement shall not renew automatically and expires at the end of the term.' },
  { path: 'renewal_details.renewal_duration', positive: 'This Agreement renews for successive terms of twelve (12) months each.', negative: 'The initial term is twelve (12) months.' },
  { path: 'renewal_details.non_renewal_notice', positive: 'Either party may prevent renewal by giving notice of non-renewal at least 30 days before the term ends.', negative: NEUTRAL },
  { path: 'renewal_details.unilateral_renewal', positive: 'Company may extend this Agreement at its sole option.', negative: 'Either party may extend this Agreement by mutual written agreement.' },
  { path: 'renewal_details.renewal_pricing', positive: 'During any renewal term the rates shall remain the same.', negative: 'Rates are stated in Exhibit A.' },
  // --- warranty
  { path: 'warranty_details.performance_guarantee', positive: 'Contractor warrants that the deliverables will be error-free.', negative: 'Contractor shall deliver the Services professionally.' },
  { path: 'warranty_details.outcome_guarantee', positive: "Contractor guarantees that the website will increase Company's sales by twenty percent.", negative: 'Contractor shall deliver the website by June 1.' },
  { path: 'warranty_details.warranty_duration', positive: 'Contractor warrants the deliverables for ninety (90) days after acceptance.', negative: NEUTRAL, ambiguous: 'Contractor warrants the deliverables for a reasonable period.' },
  { path: 'warranty_details.repair_replace', positive: 'Contractor shall repair any defective deliverable at no additional charge.', negative: NEUTRAL },
  { path: 'warranty_details.post_termination_warranty', positive: 'The warranties shall survive termination of this Agreement.', negative: NEUTRAL },
];

function factAt(u: ContractUnderstandingResult, path: string): FactWithEvidence {
  const [group, field] = path.split('.');
  return (u as any)[group][field];
}

test.describe('Contractor intelligence — extraction (deterministic engine; Gemini is mocked elsewhere)', () => {
  test('1. Every new fact has a case: the table covers the whole schema', () => {
    assert.deepEqual(CASES.map((c) => c.path).sort(), intelligenceFactPaths().sort());
    assert.equal(CASES.length, 45);
  });

  for (const c of CASES) {
    test(`2. ${c.path}: states it -> FOUND with a verbatim verified quote; unrelated text -> NOT_FOUND with no evidence`, () => {
      const pos = review(c.positive);
      const fact = factAt(pos.understanding, c.path);
      assert.equal(fact.status, 'FOUND', `${c.path}: ${JSON.stringify(fact)}`);
      assert.ok(fact.summary.length > 0);
      assert.ok(fact.evidence.length >= 1, 'a FOUND fact needs evidence');
      for (const e of fact.evidence) {
        assert.equal(e.is_verified, true, `${c.path} evidence must verify: ${e.verification_error}`);
        assert.ok(pos.text.includes(e.exact_quote), `quote must be verbatim: ${e.exact_quote}`);
      }

      const neg = review(c.negative);
      const absent = factAt(neg.understanding, c.path);
      assert.equal(absent.status, 'NOT_FOUND', `${c.path} must not trigger on: ${c.negative} -> ${JSON.stringify(absent)}`);
      assert.deepEqual(absent.evidence, [], 'a NOT_FOUND fact never carries evidence');
      assert.ok(absent.summary.length > 0);
    });
    if (c.ambiguous) {
      test(`3. ${c.path}: vague wording -> AMBIGUOUS (never silently FOUND or NOT_FOUND)`, () => {
        const r = review(c.ambiguous!);
        const fact = factAt(r.understanding, c.path);
        assert.equal(fact.status, 'AMBIGUOUS', JSON.stringify(fact));
        assert.ok(fact.evidence.length >= 1);
        assert.ok(fact.notes && fact.notes.length > 0);
      });
    }
  }

  test('4. A negated renewal ("shall not renew") is not an automatic renewal, and "exclusive property" is not exclusivity', () => {
    const r = review('This Agreement shall not automatically renew.', 'The work product shall be the sole and exclusive property of Company.');
    assert.equal(r.understanding.renewal_details.auto_renewal.status, 'NOT_FOUND');
    assert.equal(r.understanding.worker_classification.exclusivity.status, 'NOT_FOUND');
  });

  test('5. Subcontracting consent routes are approvals, not absolute bans; data-disclosure consent is not a subcontracting approval', () => {
    const consent = review("Contractor shall not subcontract any part of the Services without Company's prior written consent.");
    assert.equal(consent.understanding.subcontracting.approval_requirement.status, 'FOUND');
    assert.equal(consent.understanding.subcontracting.prohibition.status, 'NOT_FOUND');
    const data = review('Contractor shall not disclose personal data to any subcontractor without Company\'s prior written consent.');
    assert.equal(data.understanding.subcontracting.approval_requirement.status, 'NOT_FOUND');
    assert.equal(data.understanding.data_protection.third_party_access.status, 'FOUND');
  });

  test('6. Realistic multi-clause fixtures: every new field is examined, statuses are consistent and all evidence verifies', () => {
    for (const name of ['controlHeavy', 'contradictory', 'compatible'] as const) {
      const r = runPipeline(fixtureText(name));
      assert.equal(r.understanding.stats.verification_percentage, 100, name);
      assert.ok(!r.understanding.warnings.some((w) => /verification failed/i.test(w)), name);
      for (const path of intelligenceFactPaths()) {
        const f = factAt(r.understanding, path);
        assert.ok(['FOUND', 'NOT_FOUND', 'AMBIGUOUS', 'CONFLICTING', 'NOT_APPLICABLE'].includes(f.status), `${name} ${path}`);
        assert.ok(typeof f.summary === 'string' && f.summary.length > 0, `${name} ${path} summary`);
        if (f.status === 'NOT_FOUND') assert.deepEqual(f.evidence, [], `${name} ${path}`);
        if (f.status === 'FOUND') {
          assert.ok(f.evidence.length >= 1, `${name} ${path}`);
          for (const e of f.evidence) assert.ok(r.text.includes(e.exact_quote), `${name} ${path} quote`);
        }
      }
    }
    const control = runPipeline(fixtureText('controlHeavy')).understanding;
    assert.equal(control.worker_classification.prescribed_hours.status, 'FOUND');
    assert.equal(control.data_protection.breach_notification.status, 'NOT_FOUND');
    assert.equal(control.renewal_details.auto_renewal.status, 'FOUND');
    const compat = runPipeline(fixtureText('compatible')).understanding;
    assert.equal(compat.worker_classification.prescribed_hours.status, 'NOT_FOUND');
    assert.equal(compat.data_protection.breach_notification.status, 'FOUND');
    assert.equal(compat.subcontracting.approval_requirement.status, 'FOUND');
  });

  test('7. Extraction is stable across repeated runs', () => {
    const strip = (u: ContractUnderstandingResult) => {
      const { analyzed_at, ...rest } = u;
      return rest;
    };
    const a = runPipeline(fixtureText('controlHeavy')).understanding;
    const b = runPipeline(fixtureText('controlHeavy')).understanding;
    const c = runPipeline(fixtureText('controlHeavy')).understanding;
    assert.deepEqual(strip(a), strip(b));
    assert.deepEqual(strip(b), strip(c));
  });
});

// ---------------------------------------------------------------------------
// Schema validation of Gemini output
// ---------------------------------------------------------------------------

/** Model-generated portion only (no server metadata), from a real extraction. */
function modelPayload(): any {
  const u = runPipeline(fixtureText('compatible')).understanding;
  const copy = JSON.parse(JSON.stringify(u));
  for (const k of ['document_id', 'source_file_id', 'verified_sha256', 'stats', 'processing_status', 'analysis_source', 'model_used', 'analyzed_at', 'processed_sections', 'total_sections_in_document', 'coverage_percentage', 'warnings']) {
    delete copy[k];
  }
  return copy;
}

test.describe('Contractor intelligence — Gemini response schema', () => {
  test('8. A complete model response (with the new groups) is valid; server metadata is not required', () => {
    assert.deepEqual(validateGeminiUnderstandingResponse(modelPayload()).errors, []);
  });

  test('9. Every one of the 45 new fields is REQUIRED: removing any is rejected and named in the error', () => {
    for (const path of intelligenceFactPaths()) {
      const p = modelPayload();
      const [g, f] = path.split('.');
      delete p[g][f];
      const report = validateGeminiUnderstandingResponse(p);
      assert.equal(report.isValid, false, `${path} must be required`);
      assert.ok(report.errors.some((e) => e.startsWith(path)), `${path}: ${report.errors.join(' | ')}`);
    }
  });

  test('10. A missing group is reported once at the group, not defaulted to an empty object', () => {
    for (const g of INTELLIGENCE_GROUP_KEYS) {
      const p = modelPayload();
      delete p[g];
      const r = validateGeminiUnderstandingResponse(p);
      assert.equal(r.isValid, false);
      assert.deepEqual(r.errors, [`${g}: Required object is missing.`]);
    }
  });

  test('11. Invalid status, wrong types and malformed evidence on the new facts are rejected without echoing model values', () => {
    const bad = (mutate: (p: any) => void, expectPath: string) => {
      const p = modelPayload();
      mutate(p);
      const r = validateGeminiUnderstandingResponse(p);
      assert.equal(r.isValid, false, expectPath);
      assert.ok(r.errors.some((e) => e.startsWith(expectPath)), `${expectPath}: ${r.errors.join(' | ')}`);
      return r;
    };
    const secret = 'AIzaSyD-FAKE-SECRET-VALUE-12345';
    const r1 = bad((p) => { p.insurance.cyber.status = secret; }, 'insurance.cyber.status');
    assert.ok(!r1.errors.join(' ').includes(secret), 'model-supplied values must not be echoed');
    bad((p) => { p.tax_details.amounts_tax_basis.summary = 42; }, 'tax_details.amounts_tax_basis.summary');
    bad((p) => { p.renewal_details.auto_renewal.evidence = 'x'; }, 'renewal_details.auto_renewal.evidence');
    bad((p) => { p.warranty_details.warranty_duration.evidence = [{ element_id: 'e', source_block_id: 'b' }]; }, 'warranty_details.warranty_duration.evidence[0].exact_quote');
    bad((p) => { p.worker_classification = []; }, 'worker_classification');
    bad((p) => { p.subcontracting.permission = null; }, 'subcontracting.permission');
  });

  test('12. Valid model output is accepted as GEMINI; output missing a new group falls back to the deterministic engine', async () => {
    const r = runPipeline(fixtureText('compatible'));
    setGeminiGeneratorMock(async () => JSON.stringify(modelPayload()));
    try {
      const ok = await understandContractWithGemini(r.normalized, r.extraction);
      assert.equal(ok.analysis_source, 'GEMINI');
      assert.equal(ok.document_id, r.normalized.document_id, 'server-generated metadata is set by the server');
      assert.equal(ok.stats.verification_percentage, 100);
      assert.equal(ok.insurance.professional_indemnity.status, 'FOUND');
    } finally {
      setGeminiGeneratorMock(null);
    }

    const incomplete = modelPayload();
    delete incomplete.insurance;
    setGeminiGeneratorMock(async () => JSON.stringify(incomplete));
    try {
      const fb = await understandContractWithGemini(r.normalized, r.extraction);
      assert.equal(fb.analysis_source, 'DETERMINISTIC_FALLBACK');
      assert.ok(fb.warnings.some((w) => /fallback/i.test(w)));
      for (const path of intelligenceFactPaths()) assert.ok(factAt(fb, path), `fallback must still populate ${path}`);
    } finally {
      setGeminiGeneratorMock(null);
    }
  });

  test('13. The deterministic fallback output always satisfies the response schema', () => {
    for (const name of ['controlHeavy', 'contradictory', 'compatible'] as const) {
      assert.deepEqual(validateGeminiUnderstandingResponse(runPipeline(fixtureText(name)).understanding).errors, [], name);
    }
  });
});

// ---------------------------------------------------------------------------
// Evidence verification of the new facts
// ---------------------------------------------------------------------------
test.describe('Contractor intelligence — evidence verification', () => {
  test('14. A fabricated quote on a new fact is flagged, lowers verification, and is never treated as verified', async () => {
    const r = runPipeline(fixtureText('compatible'));
    const forged = modelPayload();
    forged.insurance.cyber = {
      status: 'FOUND',
      summary: 'Contractor must carry cyber insurance.',
      evidence: [{ element_id: 'sec-1', source_block_id: 'TXT-B1', exact_quote: 'Contractor shall carry cyber insurance of $9,000,000.' }],
    };
    setGeminiGeneratorMock(async () => JSON.stringify(forged));
    try {
      const result = await understandContractWithGemini(r.normalized, r.extraction);
      assert.equal(result.analysis_source, 'GEMINI', 'schema-valid output is accepted, then its evidence is checked');
      assert.equal(result.insurance.cyber.evidence[0].is_verified, false);
      assert.ok(result.stats.verification_percentage < 100);
      assert.ok(result.warnings.some((w) => w.includes('insurance.cyber')));
    } finally {
      setGeminiGeneratorMock(null);
    }
  });

  test('15. A FOUND new fact with no evidence is not counted as verified; NOT_FOUND with no evidence is', () => {
    const r = runPipeline(fixtureText('compatible'));
    const u = JSON.parse(JSON.stringify(r.understanding)) as ContractUnderstandingResult;
    u.tax_details.contractor_income_tax = { status: 'FOUND', summary: 'Contractor pays own taxes.', evidence: [] };
    const validated = validateUnderstandingResult(u, r.normalized, r.extraction);
    assert.ok(validated.stats.verified_facts < validated.stats.total_facts);
    assert.ok(validated.warnings.some((w) => w.includes('tax_details.contractor_income_tax') && /no evidence/.test(w)));
  });

  test('16. New facts are counted in the verification statistics', () => {
    const r = runPipeline(fixtureText('compatible'));
    const baseline = analyzeContractDeterministically(r.normalized);
    const withoutIntel: any = JSON.parse(JSON.stringify(baseline));
    for (const g of INTELLIGENCE_GROUP_KEYS) delete withoutIntel[g];
    const stats = validateUnderstandingResult(JSON.parse(JSON.stringify(baseline)), r.normalized, r.extraction).stats;
    assert.ok(stats.total_facts >= 45, `45 new facts must be counted, got ${stats.total_facts}`);
  });
});

// ---------------------------------------------------------------------------
// Chunk merging and conflict comparison for the new topics
// ---------------------------------------------------------------------------
const f = (summary: string, quote = summary): FactWithEvidence => ({
  status: 'FOUND',
  summary,
  evidence: [{ element_id: `el-${quote.length}`, source_block_id: `b-${quote.length}`, exact_quote: quote, is_verified: true }],
});

test.describe('Contractor intelligence — merging and conflict detection', () => {
  test('17. Values are compared only for comparable topics: hours, amounts and tax basis', () => {
    assert.deepEqual([...extractDurations('notify within 24 hours and Net 30 days')].sort(), ['24 hours', '30 days']);
    assert.deepEqual([...extractAmounts('$85.00 per hour; cap $2 million; fixed fee of $10,000')].sort(), ['10000 fixed', '2000000 amount', '85 per hour']);
    assert.deepEqual([...extractTaxBasis('fees are inclusive of all taxes; VAT shall be added')].sort(), ['exclusive', 'inclusive']);

    const kind = (topic: string, a: string, b: string) => compareFoundFacts(topic, f(a), f(b)).kind;
    assert.equal(kind('Breach Notification', 'notify within 24 hours', 'notify within 72 hours'), 'CONFLICT');
    assert.equal(kind('Breach Notification', 'notify within 72 hours', 'report within seventy-two (72) hours'), 'COMPATIBLE');
    assert.equal(kind('Warranty Duration', 'warranty for 90 days', 'warranty for 36 months'), 'UNCERTAIN', 'different units cannot be compared');
    assert.equal(kind('Warranty Duration', 'warranty for 12 months', 'warranty for 24 months'), 'CONFLICT');
    assert.equal(kind('Renewal Duration', 'renews for 12 months', 'renews for one year'), 'UNCERTAIN', 'months vs years is not equated');
    assert.equal(kind('Rates & Amounts', '$85 per hour', '$95 per hour'), 'CONFLICT');
    assert.equal(kind('Rates & Amounts', '$85 per hour', '$130 per hour for overtime'), 'COMPATIBLE', 'an overtime rate is a different situation');
    assert.equal(kind('Rates & Amounts', '$85 per hour', '$85.00 per hour'), 'COMPATIBLE');
    assert.equal(kind('Minimum Insurance Coverage', 'professional liability $1,000,000', 'cyber coverage $2,000,000'), 'COMPATIBLE', 'different cover types');
    assert.equal(kind('Minimum Insurance Coverage', 'professional liability $1,000,000', 'professional liability $2,000,000'), 'CONFLICT');
    assert.equal(kind('Amounts Tax Basis', 'fees are inclusive of all taxes', 'fees are exclusive of VAT'), 'CONFLICT');
    assert.equal(kind('Amounts Tax Basis', 'fees exclude VAT', 'VAT shall be added to fees'), 'COMPATIBLE');
    // Topics without a comparable value never conflict merely because they are worded differently
    assert.equal(kind('Exclusivity', 'no work for other clients', 'must devote full time'), 'COMPATIBLE');
  });

  test('18. Chunk results merge the new groups: found beats not-found, conflicts keep both evidence references', () => {
    const base = runPipeline(fixtureText('compatible')).understanding;
    const a = JSON.parse(JSON.stringify(base)) as ContractUnderstandingResult;
    const b = JSON.parse(JSON.stringify(base)) as ContractUnderstandingResult;
    a.processed_sections = ['s1', 's2'];
    b.processed_sections = ['s3', 's4'];

    a.data_protection.breach_notification = f('Notify within 24 hours of any data breach.');
    b.data_protection.breach_notification = f('Notify within 72 hours of any data breach.', 'Notify within 72 hours of any data breach!');
    a.insurance.cyber = { status: 'NOT_FOUND', summary: 'none', evidence: [] };
    b.insurance.cyber = f('Contractor shall maintain cyber liability insurance.');
    a.tax_details.amounts_tax_basis = f('Fees are inclusive of all taxes.');
    b.tax_details.amounts_tax_basis = f('Fees are exclusive of VAT.', 'Fees are exclusive of VAT');

    const merged = mergeChunkResults([a, b], 4, ['s1', 's2', 's3', 's4']);
    assert.equal(merged.data_protection.breach_notification.status, 'CONFLICTING');
    assert.equal(merged.data_protection.breach_notification.evidence.length, 2);
    assert.equal(merged.insurance.cyber.status, 'FOUND');
    assert.equal(merged.tax_details.amounts_tax_basis.status, 'CONFLICTING');
    assert.ok(merged.ambiguities_and_conflicts.some((c: AmbiguityOrConflict) => c.topic === 'Breach Notification' && c.evidence.length === 2));
    assert.ok(merged.ambiguities_and_conflicts.some((c: AmbiguityOrConflict) => c.topic === 'Amounts Tax Basis'));
    for (const path of intelligenceFactPaths()) assert.ok(factAt(merged, path), `${path} survives merging`);
  });

  test('19. Merging never silently defaults: unexamined partial coverage is AMBIGUOUS, complete coverage is NOT_FOUND', () => {
    const none = (s: EvidenceStatus): FactWithEvidence => ({ status: s, summary: 'x', evidence: [] });
    const conflicts: AmbiguityOrConflict[] = [];
    assert.equal(mergeFactWithEvidence(undefined, none('NOT_FOUND'), 'Cyber Insurance', false, conflicts).status, 'AMBIGUOUS');
    assert.equal(mergeFactWithEvidence(undefined, none('NOT_FOUND'), 'Cyber Insurance', true, conflicts).status, 'NOT_FOUND');
    assert.equal(mergeFactWithEvidence(undefined, undefined, 'Cyber Insurance', true, conflicts).status, 'NOT_FOUND');
    assert.equal(mergeFactWithEvidence(undefined, undefined, 'Cyber Insurance', false, conflicts).status, 'AMBIGUOUS');
  });
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------
test.describe('Contractor intelligence — Gemini prompt', () => {
  test('20. The prompt requests every new group and field and tells the model not to default or conclude', () => {
    const prompt = buildUnderstandingPrompt('doc text');
    for (const g of INTELLIGENCE_GROUP_KEYS) {
      assert.ok(prompt.includes(`"${g}": {`), `prompt must request ${g}`);
      for (const field of Object.keys(INTELLIGENCE_SCHEMA[g])) assert.ok(prompt.includes(`"${field}":`), `prompt must request ${g}.${field}`);
    }
    assert.match(UNDERSTANDING_SYSTEM_PROMPT, /Every field is REQUIRED; never omit one/);
    assert.match(UNDERSTANDING_SYSTEM_PROMPT, /Do not guess and do not default a field/);
    assert.match(UNDERSTANDING_SYSTEM_PROMPT, /Do NOT conclude that a worker is legally misclassified/);
    assert.match(UNDERSTANDING_SYSTEM_PROMPT, /"Exclusive property" of IP is NOT exclusivity/);
    // The factual-only boundary of the understanding stage is preserved
    assert.match(UNDERSTANDING_SYSTEM_PROMPT, /DO NOT perform contract risk scoring/);
  });
});
