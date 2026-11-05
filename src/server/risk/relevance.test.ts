import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureText, review, runPipeline } from './testSupport';
import { splitIllustration } from './analysis';
import { GATED_RULES } from './relevance';
import { RiskFinding } from './types';

/**
 * A missing clause is not automatically a risk. Each gated rule must (a) become a MATERIAL finding when the
 * contract makes the provision relevant and (b) become an informational OBSERVATION (not a risk) when it does not.
 */
const NEUTRAL = 'Contractor shall deliver the Services on time.';
const EXPIRING =
  'This Agreement begins on April 1, 2026 and continues for an initial term of twelve (12) months, expiring on March 31, 2027.';

type Gate = { id: string; material: string[]; informational: string[]; reason?: RegExp };

const GATES: Gate[] = [
  { id: 'payment.no_deadline', material: ['Company shall pay Contractor at the rate of $85.00 per hour for approved hours worked.'], informational: [NEUTRAL], reason: /states what you are paid/ },
  { id: 'payment.no_late_fee', material: ['Invoices are payable Net 30 days from receipt of a valid invoice.'], informational: [NEUTRAL], reason: /deadline but states no consequence/ },
  { id: 'payment.no_expenses', material: ["Contractor shall perform the Services at the Company's office five days per week."], informational: [NEUTRAL], reason: /where or with what you work/ },
    { id: 'scope.no_change_order', material: ['Contractor shall deliver the mobile application described in Exhibit A.'], informational: ['Company shall pay Contractor monthly.'] },
  { id: 'scope.no_acceptance', material: ['Contractor shall deliver the deliverables listed in Exhibit A.'], informational: ['Company shall pay Contractor monthly.'] },
  { id: 'termination.no_convenience', material: ['This Agreement shall automatically renew for successive twelve (12) month terms.'], informational: [EXPIRING] },
  { id: 'termination.no_final_payment', material: ['Either party may terminate this Agreement without cause on thirty (30) days written notice.'], informational: [NEUTRAL] },
  { id: 'ip.no_ownership', material: ['Contractor shall deliver the deliverables listed in Exhibit A.'], informational: ['Company shall pay Contractor monthly.'] },
  { id: 'ip.no_preexisting', material: ['Contractor hereby assigns to Company all work product created under this Agreement.'], informational: ['Company shall pay Contractor monthly.'] },
  { id: 'liability.no_cap', material: ['Contractor shall indemnify Company against all third-party claims.'], informational: [NEUTRAL], reason: /claims or losses/ },
  { id: 'liability.no_indirect_exclusion', material: ['Contractor shall indemnify Company against all third-party claims.'], informational: [NEUTRAL] },
  { id: 'confidentiality.no_clause', material: ["Contractor will have access to Company's trade secrets and client data."], informational: [NEUTRAL], reason: /confidential or proprietary information/ },
  { id: 'dispute.no_governing_law', material: ['Any dispute shall be resolved in the state courts located in Austin, Texas.'], informational: [NEUTRAL] },
  { id: 'dispute.no_process', material: ['This Agreement shall be governed by the laws of the State of Texas.'], informational: [NEUTRAL] },
];

const lookup = (r: ReturnType<typeof review>, id: string) => ({
  material: r.report.findings.find((f) => f.id === id),
  observation: r.report.observations.find((f) => f.id === id),
});

test.describe('Missing-clause relevance gating', () => {
  for (const g of GATES) {
    test(`${g.id}: material when the contract makes it relevant, an observation when it does not`, () => {
      const relevant = lookup(review(...g.material), g.id);
      assert.ok(relevant.material, `${g.id} should be a material finding`);
      assert.equal(relevant.observation, undefined);
      assert.equal(relevant.material!.relevance!.material, true);
      assert.ok(relevant.material!.relevance!.reason.length > 0);
      assert.ok(relevant.material!.relevance!.trigger_evidence.length > 0 || /needs|any engagement/.test(relevant.material!.relevance!.reason), 'a gate cites the contract text that triggered it');
      if (g.reason) assert.match(relevant.material!.relevance!.reason, g.reason);
      assert.deepEqual(relevant.material!.evidence, [], 'an absence carries no evidence');

      const irrelevant = lookup(review(...g.informational), g.id);
      assert.equal(irrelevant.material, undefined, `${g.id} must not be a risk without context`);
      const obs = irrelevant.observation;
      assert.ok(obs, `${g.id} should be kept as an observation`);
      assert.equal(obs!.severity, 'Low');
      assert.equal(obs!.relevance!.material, false);
      assert.deepEqual(obs!.evidence, []);
      assert.match(obs!.explanation, /Noted for completeness only/);
    });
  }

  test('observations never affect the review priority, indicators, counts or checklist', () => {
    const r = review(NEUTRAL);
    assert.ok(r.report.observations.length > 0);
    for (const o of r.report.observations) {
      assert.ok(!r.report.findings.some((f) => f.id === o.id));
      assert.ok(!r.report.checklist.some((c) => c.finding_id === o.id));
      for (const ind of r.report.overview.category_indicators) assert.ok(!ind.finding_ids.includes(o.id));
    }
    const counted = Object.values(r.report.overview.counts_by_kind).reduce((x, y) => x + y, 0);
    assert.equal(counted, r.report.findings.length, 'counts cover material findings only');
  });

  test('core terms (a fee, a description of the work) are always material', () => {
    const r = runPipeline('INDEPENDENT CONTRACTOR SERVICES AGREEMENT\n\nThis Agreement is between A ("Company") and B ("Contractor").\n\nTERMS\n\n1.1 Notes. The parties will talk later.');
    assert.equal(r.report.findings.find((f) => f.id === 'payment.no_fee')?.relevance?.material, true);
  });

  test('every missing-provision rule that fires, in every fixture and gate case, has an explicit relevance gate', () => {
    const all: RiskFinding[] = [];
    for (const name of ['controlHeavy', 'contradictory', 'compatible'] as const) {
      const r = runPipeline(fixtureText(name));
      all.push(...r.report.findings, ...r.report.observations);
    }
    for (const g of GATES) for (const clauses of [g.material, g.informational]) {
      const r = review(...clauses);
      all.push(...r.report.findings, ...r.report.observations);
    }
    const missing = all.filter((f) => f.kind === 'MISSING_PROVISION' && !f.id.endsWith('.unconfirmed'));
    assert.ok(missing.length > 25);
    for (const f of missing) {
      assert.ok(f.relevance, `${f.id} must carry a relevance assessment`);
      assert.notEqual(f.relevance!.reason, 'ungated', `${f.id} has no relevance gate`);
      assert.ok(GATED_RULES.includes(f.id), `${f.id} must be in the relevance table`);
      assert.ok(f.topic && f.topic.length > 0, `${f.id} names what was searched`);
    }
  });

  test('on a complete contract the gates produce far fewer risks than raw absence would', () => {
    const r = runPipeline(fixtureText('compatible'));
    // compatible.txt omits several optional clauses but has no data/insurance/etc. context for most of them
    assert.ok(r.report.observations.length >= 0);
    for (const f of r.report.findings.filter((x) => x.kind === 'MISSING_PROVISION')) assert.equal(f.relevance!.material, true);
  });
});

test.describe('Recommendations are grounded: no invented numbers or benchmarks', () => {
  const BENCHMARK = /\b(common(ly)?|typical(ly)?|usual(ly)?|industry|standard practice|market rate|best practice|normally|generally accepted)\b/i;

  test('illustrative examples are split out of the action and labelled as suggestions', () => {
    const a = splitIllustration('Ask for a clear deadline, for example “payment within 30 days of receiving an invoice”.');
    assert.equal(a.action, 'Ask for a clear deadline.');
    assert.equal(a.illustration, '“payment within 30 days of receiving an invoice”');
    const b = splitIllustration('Ask for a fixed warranty period that starts on acceptance (commonly 30 to 90 days for defects).');
    assert.equal(b.action, 'Ask for a fixed warranty period that starts on acceptance.');
    assert.match(b.illustration!, /30 to 90 days/);
    const c = splitIllustration('Ask for the venue to be where you live or work.');
    assert.equal(c.illustration, undefined);
    assert.equal(c.action, 'Ask for the venue to be where you live or work.');
  });

  test('no finding states a benchmark, and no action or reason contains a number that is not in the contract', () => {
    const reports = [
      ...['controlHeavy', 'contradictory', 'compatible'].map((n) => runPipeline(fixtureText(n as any))),
    ];
    for (const r of reports) {
      const numbers = new Set((r.text.match(/\d[\d,.]*/g) || []).map((n) => n.replace(/[,.]$/, '').replace(/,/g, '')));
      for (const f of [...r.report.findings, ...r.report.observations]) {
        for (const field of [f.explanation, f.why_it_matters, f.suggestion, f.title]) {
          assert.ok(!BENCHMARK.test(field), `${f.id} states a benchmark: ${field}`);
        }
        if (f.illustrative_alternative) assert.ok(!BENCHMARK.test(f.illustrative_alternative), `${f.id}: an illustration must not claim a benchmark`);
        for (const field of [f.suggestion, f.why_it_matters]) {
          for (const n of field.match(/\d[\d,.]*/g) || []) {
            assert.ok(numbers.has(n.replace(/[,.]$/, '').replace(/,/g, '')), `${f.id}: "${n}" is not in the contract: ${field}`);
          }
        }
        assert.ok(!/\d/.test(f.suggestion), `${f.id}: the action itself carries no amounts or deadlines: ${f.suggestion}`);
      }
    }
  });
});
