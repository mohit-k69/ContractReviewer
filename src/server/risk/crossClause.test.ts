import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeContractRisk } from './riskEngine';
import { buildClauseIndex } from './clauseIndex';
import {
  contradictions,
  find,
  fixtureText,
  hasPrefix,
  ids,
  review,
  Reviewed,
  runPipeline,
  stable,
} from './testSupport';
import { ContractUnderstandingResult, EvidenceReference, FactWithEvidence } from '../understanding/types';

/**
 * Cross-clause analysis. For every comparison there is:
 *   - a GENUINE contradiction (both sides cited with verified, verbatim quotes from different clauses),
 *   - a COMPATIBLE pair that looks similar but qualifies / complements (must NOT be reported), and
 *   - an ambiguous or incomplete example.
 */

const only = (r: Reviewed, id: string) => find(r, id);

function assertTwoSidedEvidence(r: Reviewed, id: string): void {
  const f = find(r, id);
  assert.ok(f, `${id} expected. Got: ${ids(r.report.findings).join(', ')}`);
  assert.equal(f!.kind, 'CONTRADICTORY_PROVISIONS');
  assert.ok(f!.evidence.length >= 2, `${id}: both sides must be cited`);
  const elements = new Set(f!.evidence.map((e) => e.element_id));
  assert.ok(elements.size >= 2, `${id}: the two sides must come from different clauses`);
  const quotes = new Set(f!.evidence.map((e) => e.exact_quote));
  assert.equal(quotes.size, f!.evidence.length, `${id}: no duplicated quote`);
  for (const e of f!.evidence) {
    assert.ok(r.text.includes(e.exact_quote), `${id}: quote must be verbatim in the contract: ${e.exact_quote}`);
    assert.ok(e.clause_label, `${id}: clause reference`);
  }
}

test.describe('Cross-clause 1 — payment deadline vs acceptance / approval', () => {
  test('a deadline counted from delivery that expires before the acceptance period ends is contradictory', () => {
    const r = review(
      'Invoices are payable within fifteen (15) days after delivery of the deliverables.',
      "Company has thirty (30) days to accept or reject each deliverable. Payment is conditioned on Company's acceptance of the deliverable."
    );
    assertTwoSidedEvidence(r, 'cross.payment_vs_acceptance');
    assert.equal(find(r, 'cross.payment_vs_acceptance')!.severity, 'High');
    assert.equal(find(r, 'cross.payment_vs_acceptance')!.category, 'Payment');
  });

  test('payment counted from the invoice with its own acceptance period is compatible', () => {
    const r = review(
      'Invoices are payable Net 30 days from receipt of a valid invoice.',
      "Company shall review each deliverable within ten (10) business days. Payment is conditioned on Company's acceptance of the deliverable."
    );
    assert.equal(only(r, 'cross.payment_vs_acceptance'), undefined);
  });

  test('a conditional payment with no acceptance deadline is AMBIGUOUS (not contradictory); a deemed acceptance removes it', () => {
    const open = review(
      'Invoices are payable within fifteen (15) days after delivery.',
      "Payment is conditioned on Company's acceptance of the deliverable."
    );
    const f = find(open, 'cross.payment_vs_acceptance')!;
    assert.equal(f.kind, 'AMBIGUOUS_TERM');
    assert.equal(f.severity, 'Medium');
    assert.ok(f.evidence.length >= 2);

    const deemed = review(
      'Invoices are payable within fifteen (15) days after delivery.',
      "Payment is conditioned on Company's acceptance of the deliverable. A deliverable not rejected in writing is deemed accepted."
    );
    assert.equal(find(deemed, 'cross.payment_vs_acceptance'), undefined);
  });

  test('payment that is not tied to acceptance is never compared with it', () => {
    const r = review('Invoices are payable within fifteen (15) days after delivery.', 'Company has thirty (30) days to review each deliverable.');
    assert.equal(find(r, 'cross.payment_vs_acceptance'), undefined);
  });
});

test.describe('Cross-clause 2 — scope vs change orders', () => {
  const CHANGE = 'Any change to the scope requires a written change order signed by both parties before the work starts.';

  test('open-ended extra work with no reference to the change process contradicts a change-order requirement', () => {
    const r = review(CHANGE, 'Contractor shall perform such additional services as may be requested by Company from time to time at no extra charge.');
    assertTwoSidedEvidence(r, 'cross.scope_vs_change_order');
    assert.equal(find(r, 'cross.scope_vs_change_order')!.severity, 'Medium');
  });

  test('extra work that is expressly subject to the change order is compatible (it qualifies the scope)', () => {
    const r = review(CHANGE, 'Any additional services requested by Company shall be performed only under a written change order and at the rates in this Agreement.');
    assert.equal(find(r, 'cross.scope_vs_change_order'), undefined);
  });

  test('an open-ended scope with no change-order clause is the existing Phase 3 risk, not a contradiction', () => {
    const r = review('Contractor shall perform such additional services as may be requested by Company from time to time.');
    assert.equal(find(r, 'cross.scope_vs_change_order'), undefined);
    assert.equal(contradictions(r).length, 0);
  });
});

test.describe('Cross-clause 3 — termination rights vs payment for completed work', () => {
  test('"no payment on termination" next to "paid for all work performed" is contradictory', () => {
    const r = review(
      'If Company terminates this Agreement for breach, Contractor shall not be entitled to any payment for work performed.',
      'Upon any termination Company shall pay Contractor for all services performed through the termination date.'
    );
    assertTwoSidedEvidence(r, 'cross.termination_vs_payment');
    assert.equal(find(r, 'cross.termination_vs_payment')!.category, 'Termination');
  });

  test('a forfeiture clause that preserves payment for accepted work qualifies itself and is compatible', () => {
    const r = review(
      'If Company terminates this Agreement for breach, Contractor shall not be entitled to payment for unaccepted work, but shall be paid for all work performed and accepted.',
      'Upon any termination Company shall pay Contractor for all services performed through the termination date.'
    );
    assert.equal(find(r, 'cross.termination_vs_payment'), undefined);
    assert.equal(find(r, 'cross.forfeit_on_termination'), undefined);
  });

  test('a forfeiture with nothing promising payment is a High RISK (not a contradiction)', () => {
    const r = review('If Company terminates this Agreement for breach, Contractor shall not be entitled to any payment for work performed.');
    const f = find(r, 'cross.forfeit_on_termination')!;
    assert.equal(f.kind, 'RISK');
    assert.equal(f.severity, 'High');
    assert.equal(contradictions(r).length, 0);
  });
});

test.describe('Cross-clause 4 — IP transfer vs full-payment condition', () => {
  test('immediate assignment in one clause and title only on full payment in another is contradictory', () => {
    const r = review(
      'Contractor hereby assigns to Company all right, title and interest in the work product immediately upon creation.',
      "Title to the deliverables shall pass to Company only upon Company's receipt of full payment of all fees."
    );
    assertTwoSidedEvidence(r, 'cross.ip_vs_payment');
    // the older "transfers before you are paid" risk would contradict the second clause, so it is not asserted
    assert.equal(find(r, 'ip.transfer_before_payment'), undefined);
  });

  test('a single sentence that is immediate AND conditional on payment is consistent', () => {
    const r = review('Contractor hereby assigns all work product to Company effective immediately upon Contractor\'s receipt of full payment.');
    assert.equal(find(r, 'cross.ip_vs_payment'), undefined);
  });

  test('an immediate assignment with no payment condition anywhere stays the Phase 3 risk, not a contradiction', () => {
    const r = review('Contractor hereby assigns to Company all work product immediately upon creation.');
    assert.equal(find(r, 'cross.ip_vs_payment'), undefined);
    assert.ok(find(r, 'ip.transfer_before_payment'));
  });
});

test.describe('Cross-clause 5 — liability cap vs indemnification', () => {
  const CAP = "In no event shall Contractor's aggregate liability under this Agreement exceed the total fees paid to Contractor in the preceding twelve months.";

  test('a cap that covers everything vs an indemnity that says it is unlimited is contradictory (High)', () => {
    const r = review(CAP, "Contractor shall indemnify Company against all third-party claims, and Contractor's indemnification obligations are not subject to any limitation of liability.");
    assertTwoSidedEvidence(r, 'cross.cap_vs_indemnity');
    assert.equal(find(r, 'cross.cap_vs_indemnity')!.severity, 'High');
  });

  test('a cap that expressly carves out indemnity is consistent: a RISK about the carve-out, never a contradiction', () => {
    const r = review(
      'Except for Contractor\'s indemnification obligations for third-party intellectual property infringement claims, each party\'s aggregate liability shall not exceed the total fees paid under this Agreement.',
      'Contractor shall indemnify Company against third-party claims that the deliverables infringe intellectual property rights.'
    );
    assert.equal(find(r, 'cross.cap_vs_indemnity'), undefined);
    const f = find(r, 'cross.indemnity_outside_cap')!;
    assert.equal(f.kind, 'RISK');
    assert.equal(f.severity, 'Low', 'a narrow IP-only indemnity is common');
    assert.equal(contradictions(r).length, 0);
  });

  test('an unlimited indemnity beside a cap that does not say whether it applies is AMBIGUOUS', () => {
    const r = review(
      "Contractor's liability under this Agreement shall be limited to the fees paid for the affected Services.",
      "Contractor shall indemnify Company against all third-party claims without limit."
    );
    const f = find(r, 'cross.cap_indemnity_unclear')!;
    assert.equal(f.kind, 'AMBIGUOUS_TERM');
    assert.equal(contradictions(r).length, 0);
  });

  test('a cap and an indemnity that never mention each other: unclear, but only Low', () => {
    const r = review(
      "Contractor's liability under this Agreement shall be limited to the fees paid for the affected Services.",
      'Contractor shall indemnify Company against third-party claims arising from Contractor\'s negligence.'
    );
    assert.equal(find(r, 'cross.cap_indemnity_unclear')!.severity, 'Low');
  });
});

test.describe('Cross-clause 6 — insurance vs liability cap / indemnification', () => {
  test('required cover far above the liability cap is reported as a RISK', () => {
    const r = review(
      "Contractor's aggregate liability under this Agreement shall not exceed $50,000.",
      'Contractor shall maintain professional liability insurance with limits of not less than $2,000,000 per claim.'
    );
    const f = find(r, 'cross.insurance_exceeds_cap')!;
    assert.equal(f.kind, 'RISK');
    assert.equal(f.severity, 'Medium');
    assert.ok(f.evidence.length >= 2);
  });

  test('cover below the cap is consistent', () => {
    const r = review(
      "Contractor's aggregate liability under this Agreement shall not exceed $5,000,000.",
      'Contractor shall maintain professional liability insurance with limits of not less than $1,000,000 per claim.'
    );
    assert.equal(find(r, 'cross.insurance_exceeds_cap'), undefined);
  });

  test('"liability limited to insurance" next to an unlimited indemnity is contradictory', () => {
    const r = review(
      "Contractor's liability under this Agreement shall be limited to the proceeds of the insurance Contractor maintains.",
      'Contractor shall indemnify Company against all third-party claims without limit.'
    );
    assertTwoSidedEvidence(r, 'cross.insurance_vs_indemnity');
  });
});

test.describe('Cross-clause 7 — confidentiality duration vs survival', () => {
  test('three years in one clause and five in the survival clause is contradictory', () => {
    const r = review(
      "Contractor shall keep Company's confidential information secret for a period of three (3) years after termination.",
      'The confidentiality obligations of Contractor shall survive termination of this Agreement for a period of five (5) years.'
    );
    assertTwoSidedEvidence(r, 'cross.confidentiality_vs_survival');
  });

  test('a fixed period vs an indefinite survival is contradictory', () => {
    const r = review(
      "Contractor shall keep Company's confidential information secret for three (3) years after termination.",
      'The confidentiality obligations of Contractor shall survive termination indefinitely.'
    );
    assertTwoSidedEvidence(r, 'cross.confidentiality_vs_survival');
  });

  test('the same period stated twice, or a trade-secret carve-out, is compatible', () => {
    const same = review(
      "Contractor shall keep Company's confidential information secret for three (3) years after termination.",
      'The confidentiality obligations of Contractor shall survive termination for three (3) years.'
    );
    assert.equal(find(same, 'cross.confidentiality_vs_survival'), undefined);
    const tradeSecret = review(
      "Contractor shall keep Company's confidential information secret for three (3) years after termination.",
      'Trade secrets shall remain protected for as long as they remain trade secrets, indefinitely.'
    );
    assert.equal(find(tradeSecret, 'cross.confidentiality_vs_survival'), undefined);
  });

  test('a survival clause with no period cannot be compared', () => {
    const r = review("Contractor shall keep Company's confidential information secret for three (3) years after termination.", 'Sections 4 and 5 shall survive termination.');
    assert.equal(find(r, 'cross.confidentiality_vs_survival'), undefined);
  });
});

test.describe('Cross-clause 8 — renewal vs termination, and term dates', () => {
  test('a term length that does not reach the stated expiration date is contradictory', () => {
    const r = review(
      'This Agreement begins on June 1, 2026 and continues for a term of twelve (12) months.',
      'This Agreement shall expire on December 31, 2027.'
    );
    assertTwoSidedEvidence(r, 'cross.term_vs_expiry_date');
    assert.match(find(r, 'cross.term_vs_expiry_date')!.explanation, /2027-05-\d\d|2027-06-01/);
  });

  test('"12 months from April 1" ending on March 31 is consistent (calendar slack)', () => {
    const r = review('This Agreement begins on April 1, 2026 and continues for an initial term of twelve (12) months, expiring on March 31, 2027.');
    assert.equal(find(r, 'cross.term_vs_expiry_date'), undefined);
  });

  test('an expiration date with no stated term or start cannot be compared', () => {
    const r = review('This Agreement shall expire on December 31, 2027.');
    assert.equal(find(r, 'cross.term_vs_expiry_date'), undefined);
  });

  test('automatic renewal next to "shall not renew" is contradictory; "shall not renew" alone is not', () => {
    const both = review(
      'This Agreement shall automatically renew for successive terms of twelve (12) months each unless either party gives notice of non-renewal.',
      'This Agreement shall expire on December 31, 2027 and shall not renew.'
    );
    assertTwoSidedEvidence(both, 'cross.renewal_vs_expiry');
    const alone = review('This Agreement shall expire on December 31, 2027 and shall not renew.');
    assert.equal(find(alone, 'cross.renewal_vs_expiry'), undefined);
  });

  test('a right to terminate on notice vs "may not terminate during the renewal term" is contradictory', () => {
    const r = review(
      'Either party may terminate this Agreement without cause on thirty (30) days written notice.',
      'Contractor may not terminate this Agreement during the then-current renewal term.'
    );
    assertTwoSidedEvidence(r, 'cross.renewal_lockin_vs_termination');
  });

  test('termination notice longer than the renewal period is a RISK, not a contradiction', () => {
    const r = review(
      'Either party may terminate this Agreement without cause on ninety (90) days written notice.',
      'This Agreement shall automatically renew for successive renewal terms of two (2) months each unless notice of non-renewal is given.'
    );
    const f = find(r, 'cross.notice_exceeds_renewal')!;
    assert.equal(f.kind, 'RISK');
    assert.equal(f.severity, 'Medium');
    const fine = review(
      'Either party may terminate this Agreement without cause on thirty (30) days written notice.',
      'This Agreement shall automatically renew for successive renewal terms of twelve (12) months each unless notice of non-renewal is given.'
    );
    assert.equal(find(fine, 'cross.notice_exceeds_renewal'), undefined);
  });
});

test.describe('Cross-clause 9 — dates, amounts, rates and payment conditions across sections', () => {
  test('two different rates for the same unit, with no qualifier, are contradictory', () => {
    const r = review(
      'Company shall pay Contractor at the rate of $85.00 per hour for approved hours.',
      "Contractor's rate for all work under this Agreement is $95.00 per hour."
    );
    assertTwoSidedEvidence(r, 'cross.rate_conflict');
  });

  test('overtime, role-specific, exhibit-scoped or identical rates are compatible', () => {
    for (const second of [
      'Approved overtime hours are paid at $135.00 per hour.',
      'Work by senior engineers is billed at $120.00 per hour.',
      'Work under Exhibit B is billed at $120.00 per hour.',
      'The rate for all work is $85.00 per hour.',
    ]) {
      const r = review('Company shall pay Contractor at the rate of $85.00 per hour for approved hours.', second);
      assert.equal(find(r, 'cross.rate_conflict'), undefined, second);
    }
  });

  test('two payment deadlines for the same invoices are contradictory; late, milestone and deposit terms are not', () => {
    const r = review('Invoices are payable within fifteen (15) days of receipt.', 'Invoices are payable Net 30 days from receipt of a valid invoice.');
    assertTwoSidedEvidence(r, 'cross.payment_deadline_conflict');
    for (const second of [
      'Milestone invoices are payable within fifteen (15) days of receipt.',
      'Overdue invoices accrue interest if unpaid more than ten (10) days after the due date.',
      'The deposit invoice is payable within five (5) days of receipt.',
    ]) {
      const ok = review('Invoices are payable Net 30 days from receipt of a valid invoice.', second);
      assert.equal(find(ok, 'cross.payment_deadline_conflict'), undefined, second);
    }
  });

  test('two different effective dates are contradictory; a differing signing date is not', () => {
    const r = review('This Agreement is effective as of June 1, 2026.', 'This Agreement is effective as of September 15, 2026.');
    assert.ok(find(r, 'cross.effective_date_conflict'));
    // (the test frame's preamble already says "effective as of May 1, 2026")
    const ok = review('This Agreement is effective as of May 1, 2026.', 'This Agreement was signed by the parties on April 20, 2026.');
    assert.equal(find(ok, 'cross.effective_date_conflict'), undefined);
  });

  test('two different governing laws are contradictory; an exhibit-scoped law, or a venue, is not', () => {
    const r = review('This Agreement shall be governed by the laws of the State of California.', 'Any dispute shall be governed by the laws of the State of New York.');
    assertTwoSidedEvidence(r, 'cross.governing_law_conflict');
    const exhibit = review('This Agreement shall be governed by the laws of the State of California.', 'For purposes of Exhibit B, this Agreement shall be governed by the laws of the State of New York.');
    assert.equal(find(exhibit, 'cross.governing_law_conflict'), undefined);
    const venue = review('This Agreement shall be governed by the laws of the State of California.', 'Any dispute shall be resolved in the state courts located in New York, New York.');
    assert.equal(find(venue, 'cross.governing_law_conflict'), undefined);
  });
});

test.describe('Cross-clause 10 — warranties vs disclaimers and liability caps', () => {
  test('a blanket "as is / disclaims all warranties" beside an express guarantee is contradictory', () => {
    const r = review(
      'The deliverables are provided AS IS and Contractor disclaims all warranties.',
      'Contractor warrants that the deliverables will be error-free and fit for purpose.'
    );
    assertTwoSidedEvidence(r, 'cross.warranty_vs_disclaimer');
  });

  test('disclaiming OTHER warranties next to an express one simply qualifies it', () => {
    const r = review(
      'Contractor warrants that the deliverables will be error-free for ninety (90) days after acceptance.',
      'Contractor disclaims all other warranties, express or implied.'
    );
    assert.equal(find(r, 'cross.warranty_vs_disclaimer'), undefined);
  });

  test('warranty remedies that override the liability cap are a RISK; a cap that says it covers warranty claims makes it a contradiction', () => {
    const risk = review(
      'Liability of either party shall not exceed the fees paid in the preceding twelve months.',
      'Contractor shall repair any defective deliverable at no charge, notwithstanding any limit of liability.'
    );
    const f = find(risk, 'warranty.outside_cap') ?? find(risk, 'cross.warranty_vs_cap');
    assert.ok(f, `expected a warranty/cap finding. Got ${ids(risk.report.findings).join(', ')}`);
    assert.equal(f!.kind, 'RISK');

    const clash = review(
      'In no event shall Contractor\'s aggregate liability, including for all warranty claims, exceed the total fees paid.',
      'Contractor shall repair any defective deliverable at no charge, notwithstanding any limit of liability.'
    );
    assertTwoSidedEvidence(clash, 'cross.warranty_vs_cap');
  });
});

// ---------------------------------------------------------------------------
// Realistic multi-clause fixtures
// ---------------------------------------------------------------------------
test.describe('Realistic fixtures', () => {
  const contradictory = runPipeline(fixtureText('contradictory'));
  const compatible = runPipeline(fixtureText('compatible'));
  const control = runPipeline(fixtureText('controlHeavy'));

  test('the deliberately contradictory agreement: every planted contradiction is found with exact quotes on both sides', () => {
    const expected = [
      'cross.payment_vs_acceptance', 'cross.payment_deadline_conflict', 'cross.rate_conflict', 'cross.effective_date_conflict',
      'cross.term_vs_expiry_date', 'cross.termination_vs_payment', 'cross.ip_vs_payment', 'cross.cap_vs_indemnity',
      'cross.governing_law_conflict', 'cross.renewal_vs_expiry', 'cross.scope_vs_change_order',
      'cross.confidentiality_vs_survival', 'subcontracting.personal_service_vs_delegation', 'cross.warranty_vs_disclaimer',
    ];
    for (const id of expected) assertTwoSidedEvidence(contradictory, id);
    assert.equal(contradictions(contradictory).length, expected.length, `no extra contradictions: ${ids(contradictions(contradictory)).join(', ')}`);
    assert.equal(contradictory.report.overview.review_priority, 'High');
    assert.ok(contradictory.report.overview.rationale.some((x) => /contradictory provisions must be resolved/.test(x)));
    assert.ok(contradictory.report.checklist.some((c) => c.finding_id === 'cross.cap_vs_indemnity'));
  });

  test('the compatible agreement has related clauses but NO contradictions and nothing High', () => {
    assert.equal(contradictions(compatible).length, 0, ids(contradictions(compatible)).join(', '));
    assert.equal(compatible.report.findings.filter((f) => f.severity === 'High').length, 0, ids(compatible.report.findings).join(', '));
    // The qualifying clauses are recognised as compatible, not flagged
    for (const id of ['cross.payment_deadline_conflict', 'cross.rate_conflict', 'cross.term_vs_expiry_date', 'cross.confidentiality_vs_survival', 'cross.cap_vs_indemnity', 'cross.scope_vs_change_order']) {
      assert.equal(find(compatible, id), undefined, id);
    }
    // The cap with an explicit indemnity carve-out is reported honestly as a risk about the carve-out
    assert.equal(find(compatible, 'cross.indemnity_outside_cap')!.kind, 'RISK');
    // Subcontracting with consent + responsibility + flow-down: no missing-subcontractor findings
    assert.equal(hasPrefix(compatible, 'subcontracting.no_'), false);
    // A complete data clause set: nothing missing
    assert.equal(compatible.report.findings.filter((f) => f.category === 'Data Protection & Security').length, 0);
  });

  test('the control-heavy agreement is assessed across every intelligence area', () => {
    const must = [
      'classification.indicators', 'data.no_breach_notification', 'data.no_processing_agreement', 'data.no_return_deletion',
      'insurance.disproportionate', 'insurance.post_termination', 'insurance.additional_insured', 'subcontracting.absolute_ban',
      'tax.indemnification', 'tax.withholding_without_safeguards', 'renewal.automatic', 'renewal.unilateral', 'renewal.pricing',
      'warranty.outcome_guarantee', 'warranty.long_duration', 'warranty.unlimited_repair', 'warranty.after_termination',
    ];
    for (const id of must) assert.ok(find(control, id), `${id}. Got: ${ids(control.report.findings).join(', ')}`);
    const cls = find(control, 'classification.indicators')!;
    assert.equal(cls.severity, 'High');
    assert.match(cls.explanation, /7 terms/);
    assert.equal(find(control, 'renewal.automatic')!.severity, 'High');
    assert.equal(find(control, 'tax.indemnification')!.severity, 'High');
    assert.equal(contradictions(control).length, 0, 'consistent clauses are not contradictions');
  });

  test('no unsupported missing-provision claims: a missing finding is never made when the text addresses the topic', () => {
    // Each pair: finding id -> wording that, if present, means the provision is NOT missing
    const addressed: Array<[string, RegExp]> = [
      ['data.no_breach_notification', /(data|security|privacy)\s+(breach|incident)/i],
      ['data.no_return_deletion', /(return|destroy|delete|erase)[^.]{0,80}(data|information)/i],
      ['data.no_processing_agreement', /data processing|processor|controller/i],
      ['insurance.no_limits', /insurance[^.]{0,200}\$\s?\d/i],
      ['renewal.no_notice_period', /non-?renew[^.]{0,80}(notice|days)/i],
      ['renewal.no_duration', /renew[^.]{0,100}(year|month)s?/i],
      ['warranty.no_duration', /warrant\w*[^.]{0,100}(days?|months?|years?)/i],
      ['tax.basis_unclear', /(inclusive|exclusive)[^.]{0,40}(tax|vat|gst)/i],
      ['subcontracting.no_responsibility', /responsible[^.]{0,60}subcontractor/i],
      ['subcontracting.no_flowdown', /subcontractor[^.]{0,120}(bound|confidential)/i],
    ];
    for (const r of [contradictory, compatible, control]) {
      for (const [id, pattern] of addressed) {
        if (find(r, id)) assert.ok(!pattern.test(r.text), `${id} was claimed missing although the text says: ${r.text.match(pattern)?.[0]}`);
      }
      for (const f of r.report.findings.filter((x) => x.kind === 'MISSING_PROVISION')) {
        assert.deepEqual(f.evidence, [], `${f.id} must not carry evidence`);
      }
    }
  });

  test('incomplete coverage: no missing-provision findings, areas marked "Not assessed", contradictions still reported', () => {
    for (const r of [contradictory, compatible, control]) {
      const partial = analyzeContractRisk(
        { ...r.understanding, processing_status: 'PARTIAL', coverage_percentage: 60 },
        buildClauseIndex(r.normalized, r.extraction)
      );
      assert.equal(partial.findings.filter((f) => f.kind === 'MISSING_PROVISION').length, 0);
      assert.equal(partial.findings.filter((f) => f.id.endsWith('.unconfirmed')).length, 0, 'no missing-claim conversions without full coverage');
      assert.equal(partial.analysis.missing_provisions_assessed, false);
      assert.ok(partial.limitations.some((l) => /60%/.test(l)));
    }
    const partial = analyzeContractRisk(
      { ...contradictory.understanding, processing_status: 'PARTIAL', coverage_percentage: 60 },
      buildClauseIndex(contradictory.normalized, contradictory.extraction)
    );
    assert.ok(partial.findings.filter((f) => f.kind === 'CONTRADICTORY_PROVISIONS').length >= 10, 'real contradictions do not depend on full coverage');
  });

  test('results are stable across repeated runs and independent of object identity', () => {
    for (const name of ['controlHeavy', 'contradictory', 'compatible'] as const) {
      const a = runPipeline(fixtureText(name));
      const b = runPipeline(fixtureText(name));
      assert.deepEqual(stable(a.report), stable(b.report), name);
      // re-analysing the same understanding twice also gives identical output and does not mutate the input
      const before = JSON.stringify(a.understanding);
      const again = analyzeContractRisk(a.understanding, buildClauseIndex(a.normalized, a.extraction));
      const again2 = analyzeContractRisk(a.understanding, buildClauseIndex(a.normalized, a.extraction));
      assert.deepEqual(stable(again), stable(again2), name);
      assert.equal(JSON.stringify(a.understanding), before, `${name}: input must not be mutated`);
    }
  });

  test('every finding in every fixture is well-formed: severity, evidence verbatim, confidence, uncertainty, no numeric score', () => {
    for (const r of [contradictory, compatible, control]) {
      const rank = { High: 3, Medium: 2, Low: 1 } as const;
      for (let i = 1; i < r.report.findings.length; i++) {
        assert.ok(rank[r.report.findings[i - 1].severity] >= rank[r.report.findings[i].severity], 'prioritised order');
      }
      for (const f of r.report.findings) {
        assert.ok(['High', 'Medium', 'Low'].includes(f.severity));
        assert.ok(f.title && f.explanation && f.why_it_matters && f.suggestion, f.id);
        assert.ok(f.confidence.reasons.length > 0, f.id);
        assert.ok(f.uncertainty === undefined || f.uncertainty.length > 0);
        for (const e of f.evidence) assert.ok(r.text.includes(e.exact_quote), `${f.id}: ${e.exact_quote}`);
      }
      assert.ok(!/"(risk_)?score"/i.test(JSON.stringify(r.report)));
      assert.equal(new Set(r.report.findings.map((f) => f.id)).size, r.report.findings.length, 'unique ids');
    }
  });

  test('Phase 2C conflicts are preserved and not restated by the cross-clause rules', () => {
    const r = review('This Agreement shall be governed by the laws of the State of California.', 'Any dispute shall be governed by the laws of the State of New York.');
    // Simulate the understanding stage having already flagged this conflict from its own (long-text) evidence
    const u: ContractUnderstandingResult = JSON.parse(JSON.stringify(r.understanding));
    const laws = r.report.findings.find((f) => f.id === 'cross.governing_law_conflict')!;
    const refs: EvidenceReference[] = laws.evidence.map((e) => ({
      element_id: e.element_id, source_block_id: e.source_block_id, exact_quote: e.exact_quote, is_verified: true,
    }));
    const conflicting: FactWithEvidence = { status: 'CONFLICTING', summary: 'California vs New York governing law', evidence: refs };
    u.classification.governing_jurisdiction = conflicting;
    u.ambiguities_and_conflicts = [{ topic: 'Governing Jurisdiction', description: 'Conflicting terms for Governing Jurisdiction.', evidence: refs }];
    const report = analyzeContractRisk(u, buildClauseIndex(r.normalized, r.extraction));
    const conflicts = report.findings.filter((f) => f.kind === 'CONTRADICTORY_PROVISIONS' && f.category === 'Dispute Resolution & Governing Law');
    assert.equal(conflicts.length, 1, 'reported once');
    assert.equal(conflicts[0].id, 'conflict.governing_law', 'the Phase 2C record (with its summary) is the one preserved');
    assert.match(conflicts[0].explanation, /California vs New York/);
  });
});

test.describe('Report completeness for the new areas', () => {
  test('new facts appear as key terms only when the contract states something', () => {
    const control = runPipeline(fixtureText('controlHeavy'));
    const labels = control.report.key_terms.map((t) => t.label);
    for (const l of ['Automatic renewal', 'Renewal length', 'Notice to stop renewal', 'Handles personal data', 'Professional indemnity insurance', 'Cyber insurance', 'Subcontracting banned', 'Contractor pays own income tax', 'Warranty period']) {
      assert.ok(labels.includes(l), `${l} should be listed. Got: ${labels.join(', ')}`);
    }
    // Absent terms are not listed as blank rows
    assert.ok(!labels.includes('Data breach notification'));
    assert.ok(!labels.includes('Subcontracting permitted'));
    for (const t of control.report.key_terms) {
      if (t.status === 'FOUND') for (const e of t.evidence) assert.ok(control.text.includes(e.exact_quote), t.label);
    }
    const bare = review('Contractor shall deliver the Services on time.');
    assert.ok(!bare.report.key_terms.some((t) => t.label === 'Automatic renewal'));
  });

  test('a result that predates the new groups says so instead of implying nothing was found', () => {
    const r = review('Contractor shall deliver the Services on time.');
    const legacy: any = JSON.parse(JSON.stringify(r.understanding));
    delete legacy.insurance;
    delete legacy.worker_classification;
    const report = analyzeContractRisk(legacy, buildClauseIndex(r.normalized, r.extraction));
    assert.ok(report.limitations.some((l) => /were not analyzed in this result/.test(l) && /not evidence that those terms are absent/.test(l)));
    assert.equal(report.findings.filter((f) => f.category === 'Insurance').length, 0, 'an unexamined area never produces a "missing" claim');
    // A complete result carries no such limitation
    assert.ok(!r.report.limitations.some((l) => /were not analyzed in this result/.test(l)));
  });

  test('the checklist and category indicators cover the new areas', () => {
    const control = runPipeline(fixtureText('controlHeavy'));
    const areas = control.report.overview.category_indicators;
    for (const name of ['Worker Classification', 'Insurance', 'Tax', 'Renewal', 'Warranties', 'Subcontracting & Delegation', 'Data Protection & Security']) {
      const ind = areas.find((c) => c.category === name)!;
      assert.ok(ind, name);
      assert.ok(['High', 'Medium', 'Low'].includes(ind.level), `${name} has findings: ${ind.level}`);
      assert.ok(ind.finding_ids.length > 0);
    }
    assert.ok(control.report.checklist.some((c) => c.category === 'Worker Classification' && c.priority === 'High'));
    assert.ok(control.report.checklist.some((c) => c.category === 'Renewal'));
  });
});

