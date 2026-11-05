import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { fixtureText, review, runPipeline, Reviewed, contractFrom } from '../risk/testSupport';
import { analyzeContractRisk } from '../risk/riskEngine';
import { buildClauseIndex } from '../risk/clauseIndex';
import { createApp, initServerRuntime } from '../app';
import { buildDecisionReport } from './index';
import { gateEvidence, makeVerifier } from './evidence';
import { extractDates } from '../understanding/conflictDetector';
import { DecisionReport, ReportEvidence } from './types';

const SAMPLE = fs.readFileSync(path.resolve(process.cwd(), 'samples', 'risky-freelance-agreement.txt'), 'utf8');

/** Builds the decision report exactly as the pipeline does, optionally after altering the understanding result. */
function decide(r: Reviewed, mutate?: (u: any) => void, tweak?: (r: Reviewed) => void): DecisionReport {
  const u = JSON.parse(JSON.stringify(r.understanding));
  mutate?.(u);
  const copy: Reviewed = { ...r, understanding: u, normalized: JSON.parse(JSON.stringify(r.normalized)), extraction: JSON.parse(JSON.stringify(r.extraction)) };
  tweak?.(copy);
  const risk = analyzeContractRisk(u, buildClauseIndex(copy.normalized, copy.extraction));
  return buildDecisionReport(u, risk, copy.normalized, copy.extraction);
}
const decideText = (text: string): DecisionReport => decide(runPipeline(text));

const PREAMBLE =
  'This Independent Contractor Services Agreement ("Agreement") is made effective as of May 1, 2026, by and between Acme Studio Inc., a Delaware corporation ("Company"), and Riley Park, an individual ("Contractor").';
/** A small contract with real section headings, the way most contracts are laid out. */
function sectioned(...sections: Array<[heading: string, ...clauses: string[]]>): string {
  const body = sections.map(([h, ...cs]) => `${h}\n\n${cs.join('\n\n')}`).join('\n\n');
  return `INDEPENDENT CONTRACTOR SERVICES AGREEMENT\n\n${PREAMBLE}\n\n${body}\n`;
}

/** Every ReportEvidence object anywhere in the report. */
function allEvidence(report: unknown): ReportEvidence[] {
  const out: ReportEvidence[] = [];
  const walk = (n: any): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    for (const k of Object.keys(n)) {
      if (['evidence', 'trigger_evidence', 'contract_reference'].includes(k) && Array.isArray(n[k])) out.push(...n[k]);
      else walk(n[k]);
    }
    if (Array.isArray(n.evidence)) n.evidence.forEach(walk);
  };
  walk(report);
  return out;
}

/** Every object in the report that carries a status/basis and evidence. */
function claims(report: unknown): Array<{ status?: string; basis?: string; evidence: ReportEvidence[] }> {
  const out: any[] = [];
  const walk = (n: any): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n.evidence) && (n.status !== undefined || n.basis !== undefined)) out.push(n);
    for (const k of Object.keys(n)) walk(n[k]);
  };
  walk(report);
  return out;
}

const samples: Array<[string, string]> = [
  ['risky sample', SAMPLE],
  ['control-heavy', fixtureText('controlHeavy')],
  ['contradictory', fixtureText('contradictory')],
  ['compatible', fixtureText('compatible')],
];

test.describe('Decision report: structure', () => {
  test('has the five sections, coverage, policy and disclaimer, and no overall score', () => {
    const d = decideText(SAMPLE);
    assert.equal(d.schema_version, '1.0');
    assert.ok(d.deal.items.length > 10);
    assert.ok(d.commitments.freelancer.length > 0 && d.commitments.client.length > 0);
    assert.ok(d.attention.findings.length > 0);
    assert.ok(d.scenarios.length > 0);
    assert.ok(d.rights_and_next_steps.questions.length > 0);
    assert.ok(d.rights_and_next_steps.checklist.before_signing.length > 0);
    assert.equal(d.coverage.source_format, 'txt');
    assert.equal(d.coverage.absences_assessed, true);
    assert.ok(d.evidence_policy.length >= 5);
    assert.match(d.disclaimer, /not legal advice/i);
    assert.match(d.rights_and_next_steps.outside_contract_note, /not assessed/i);
    assert.ok(!/score|rating|grade/i.test(Object.keys(d.attention.counts).concat(Object.keys(d)).join(' ')), 'no overall score');
    assert.deepEqual(Object.keys(d.attention.counts.by_priority).sort(), ['high', 'low', 'medium']);
  });

  test('every extracted item uses one of the five statuses', () => {
    const allowed = new Set(['explicit', 'unclear', 'conflicting', 'not_found', 'not_applicable']);
    for (const [name, text] of samples) {
      const d = decideText(text);
      const items = [...d.deal.items, ...d.commitments.freelancer.flatMap((g) => g.items), ...d.commitments.client.flatMap((g) => g.items)];
      for (const i of items) assert.ok(allowed.has(i.status), `${name}/${i.id}: ${i.status}`);
    }
  });

  test('is stable: the same document produces the same report', () => {
    const r = runPipeline(SAMPLE);
    const strip = (d: DecisionReport) => JSON.stringify({ ...d, generated_at: '' });
    assert.equal(strip(decide(r)), strip(decide(r)));
  });
});

test.describe('Decision report: evidence verification', () => {
  test('every quote in the report is a verbatim, verified substring of the uploaded document', () => {
    for (const [name, text] of samples) {
      const r = runPipeline(text);
      const d = decide(r);
      const verify = makeVerifier(r.normalized, r.extraction);
      const evidence = allEvidence(d);
      assert.ok(evidence.length > 10, name);
      for (const e of evidence) {
        assert.ok(verify(e), `${name}: unverifiable quote: ${e.exact_quote}`);
        assert.ok(text.includes(e.exact_quote), `${name}: quote is not in the document: ${e.exact_quote}`);
        assert.ok(e.reference.length > 0 && e.element_id && e.source_block_id);
      }
      assert.deepEqual(d.warnings, [], `${name}: the gate had to remove or downgrade something`);
    }
  });

  test('every explicit / conflicting claim carries evidence; absences never do', () => {
    for (const [name, text] of samples) {
      const d = decideText(text);
      for (const c of claims(d)) {
        if (c.status === 'explicit' || c.basis === 'explicit') assert.ok(c.evidence.length >= 1, `${name}: explicit without evidence`);
        if (c.status === 'conflicting' || c.basis === 'conflicting') assert.ok(c.evidence.length >= 1, `${name}: conflicting without evidence`);
        if (c.status === 'not_found' || c.basis === 'not_in_contract' || c.basis === 'outside_contract') assert.equal(c.evidence.length, 0, `${name}: an absence carries evidence`);
      }
      for (const i of d.deal.items.filter((x) => x.status === 'not_found')) assert.equal(i.value, null, `${name}/${i.id}`);
      for (const f of d.attention.findings.filter((x) => x.type === 'missing')) {
        assert.equal(f.evidence.length, 0, `${name}/${f.id}`);
        assert.equal(f.contract_language.length, 0);
        assert.equal(f.contract_position.basis, 'not_in_contract');
      }
    }
  });

  test('the final gate removes an unverifiable quote and downgrades the claim that rested on it', () => {
    const r = runPipeline(SAMPLE);
    const d = decide(r);
    const verify = makeVerifier(r.normalized, r.extraction);
    const item = d.deal.items.find((i) => i.id === 'invoicing.payment_deadline')!;
    assert.equal(item.status, 'explicit');
    item.evidence = item.evidence.map((e) => ({ ...e, exact_quote: `${e.exact_quote} and a fabricated promise` }));
    const stmtHolder = d.scenarios[0].contract_position.find((s) => s.basis === 'explicit')!;
    stmtHolder.evidence = [{ ...stmtHolder.evidence[0], exact_quote: 'text that is not in the contract' }];
    const { warnings } = gateEvidence(d, verify);
    assert.equal(item.status, 'unclear');
    assert.equal(item.evidence_unverified, true);
    assert.equal(item.evidence.length, 0);
    assert.equal(stmtHolder.basis, 'unclear');
    assert.equal(stmtHolder.evidence_unverified, true);
    assert.ok(warnings.length >= 2);
  });

  test('a fabricated quote on a conflicting item is downgraded too', () => {
    const r = runPipeline(fixtureText('contradictory'));
    const d = decide(r);
    const verify = makeVerifier(r.normalized, r.extraction);
    const f = d.attention.findings.find((x) => x.type === 'contradictory')!;
    f.contract_position.evidence = f.contract_position.evidence.map((e) => ({ ...e, exact_quote: 'invented' }));
    gateEvidence(d, verify);
    assert.equal(f.contract_position.basis, 'unclear');
  });

  test('status mapping from the understanding stage', () => {
    const r = runPipeline(SAMPLE);
    const find = (d: DecisionReport, id: string) => d.deal.items.find((i) => i.id === id)!;

    // FOUND whose quote is not verified -> never "explicit"
    const unverified = decide(r, (u) => {
      for (const ref of u.payment_and_commercial.payment_terms_days.evidence) ref.is_verified = false;
    });
    assert.equal(find(unverified, 'invoicing.payment_deadline').status, 'unclear');
    assert.equal(find(unverified, 'invoicing.payment_deadline').evidence_unverified, true);
    assert.equal(find(unverified, 'invoicing.payment_deadline').evidence.length, 0);

    // AMBIGUOUS -> unclear
    const ambiguous = decide(r, (u) => {
      u.payment_and_commercial.payment_terms_days.status = 'AMBIGUOUS';
    });
    assert.equal(find(ambiguous, 'invoicing.payment_deadline').status, 'unclear');

    // CONFLICTING (verified quote) -> conflicting
    const conflicting = decide(r, (u) => {
      u.payment_and_commercial.payment_terms_days.status = 'CONFLICTING';
    });
    assert.equal(find(conflicting, 'invoicing.payment_deadline').status, 'conflicting');

    // NOT_APPLICABLE -> not_applicable
    const na = decide(r, (u) => {
      u.payment_and_commercial.late_payment_terms = { status: 'NOT_APPLICABLE', summary: 'Not applicable.', evidence: [] };
    });
    assert.equal(find(na, 'invoicing.late_payment').status, 'not_applicable');

    // NOT_FOUND on a partly analyzed document -> unclear, never "not found"
    const partial = decide(r, (u) => {
      u.processing_status = 'PARTIAL';
      u.coverage_percentage = 55;
    });
    assert.equal(partial.coverage.absences_assessed, false);
    assert.ok(!partial.deal.items.some((i) => i.status === 'not_found'), 'no absence is reported for a partly analyzed document');
    assert.ok(!partial.attention.findings.some((f) => f.type === 'missing'));
    assert.equal(partial.commitments.not_stated.length, 0);
    assert.ok(partial.deal.items.some((i) => i.status === 'unclear' && /analyzed part|may appear elsewhere/i.test(i.explanation)));

    // The same fact on a fully analyzed document is a real absence
    assert.equal(find(decide(r), 'money.expenses').status, 'not_found');
  });

  test('a term the extraction missed but the document states is not reported as absent', () => {
    // The sample states its effective date in the preamble; the report must not say "the contract does not state this"
    const d = decideText(SAMPLE);
    const start = d.deal.items.find((i) => i.id === 'timeline.start_date')!;
    assert.equal(start.status, 'explicit');
    assert.equal(start.structured?.date, '2025-10-01');
    assert.ok(start.evidence[0].exact_quote.includes('October 1, 2025'));
  });

  test('a heading is never presented as what the contract says', () => {
    const d = decideText(SAMPLE);
    for (const g of [...d.commitments.freelancer, ...d.commitments.client]) {
      for (const i of g.items) assert.ok(!i.value || /[a-z]/.test(i.value), `${i.id}: "${i.value}" is only a heading`);
    }
    const scope = d.deal.items.find((i) => i.id === 'engagement.description')!;
    assert.match(scope.value!, /shall provide/i);
  });
});

test.describe('Decision report: references and page numbers', () => {
  test('TXT: structural references only, no invented page numbers', () => {
    const d = decideText(SAMPLE);
    const evidence = allEvidence(d);
    assert.ok(evidence.length > 0);
    for (const e of evidence) {
      assert.equal(e.page, undefined);
      assert.ok(!/^p\. \d/.test(e.reference), e.reference);
    }
    assert.ok(evidence.some((e) => / › /.test(e.reference)), 'references show the section path');
  });

  test('DOCX: structural references only', () => {
    const r = runPipeline(SAMPLE);
    const d = decide(r, undefined, (c) => {
      (c.normalized as any).source_format = 'docx';
      (c.extraction as any).source_format = 'docx';
      for (const b of c.extraction.blocks as any[]) delete b.page_number;
    });
    assert.equal(d.coverage.source_format, 'docx');
    for (const e of allEvidence(d)) assert.equal(e.page, undefined);
  });

  test('PDF: the real page number of the source block is shown', () => {
    const r = runPipeline(SAMPLE);
    const d = decide(r, undefined, (c) => {
      (c.normalized as any).source_format = 'pdf';
      (c.extraction as any).source_format = 'pdf';
      (c.extraction.blocks as any[]).forEach((b, i) => (b.page_number = 1 + Math.floor(i / 5)));
    });
    assert.equal(d.coverage.source_format, 'pdf');
    const evidence = allEvidence(d);
    const blocks = new Map((r.extraction.blocks as any[]).map((b, i) => [b.block_id, 1 + Math.floor(i / 5)]));
    assert.ok(evidence.length > 0);
    for (const e of evidence) {
      assert.equal(e.page, blocks.get(e.source_block_id), e.source_block_id);
      assert.ok(e.reference.startsWith(`p. ${e.page} · `), e.reference);
    }
  });
});

test.describe('Decision report: relevance gating and missing provisions', () => {
  const ids = (d: DecisionReport) => d.attention.findings.map((f) => f.id);

  test('an absent provision nothing makes relevant is an observation, not a risk', () => {
    const d = decide(review('Contractor shall provide logo design services. Company shall pay Contractor a fixed fee of $2,000 within 30 days of invoice.'));
    for (const f of d.attention.findings.filter((x) => x.type === 'missing')) {
      assert.equal(f.relevance?.material, true, f.id);
      assert.ok(f.relevance!.reason.length > 0);
    }
    assert.ok(!ids(d).some((id) => id.startsWith('data.')), 'no data findings without any data in the contract');
    assert.ok(!ids(d).some((id) => id.startsWith('insurance.')));
    assert.ok(d.attention.observations.length > 0, 'unrelated absences are kept as observations');
    for (const o of d.attention.observations) {
      assert.ok(!ids(d).includes(o.id));
      assert.ok(o.relevance_reason.length > 0);
    }
    // observations do not count as findings
    assert.equal(d.attention.counts.by_type.missing, d.attention.findings.filter((f) => f.type === 'missing').length);
  });

  test('the same absence becomes a finding when the contract makes it relevant', () => {
    const quiet = decide(review('Contractor shall provide design services for a fixed fee of $2,000.'));
    const loud = decide(review('Contractor shall provide design services for a fixed fee of $2,000.', 'Contractor will have access to customer personal data and must keep it secure.'));
    assert.ok(!ids(quiet).includes('data.no_breach_notification'));
    assert.ok(ids(loud).includes('data.no_breach_notification'));
    const f = loud.attention.findings.find((x) => x.id === 'data.no_breach_notification')!;
    assert.equal(f.type, 'missing');
    assert.ok(f.relevance!.reason.length > 0);
    assert.ok(f.relevance!.evidence.length > 0, 'the provision that makes it relevant is quoted');
    assert.equal(f.evidence.length, 0, 'the absence itself has no quote');
  });

  test('clusters: findings that cite the same clause are grouped, with one lead', () => {
    const d = decideText(SAMPLE);
    const byCluster = new Map<string, number>();
    for (const f of d.attention.findings) if (f.is_cluster_lead) byCluster.set(f.cluster_id, (byCluster.get(f.cluster_id) ?? 0) + 1);
    for (const f of d.attention.findings) assert.equal(byCluster.get(f.cluster_id), 1, `${f.cluster_id} has exactly one lead`);
    const grouped = d.attention.groups.flatMap((g) => g.finding_ids);
    assert.equal(new Set(grouped).size, d.attention.findings.length);
  });
});

test.describe('Decision report: contradictory clauses', () => {
  const r = runPipeline(fixtureText('contradictory'));
  const d = decide(r);

  test('contradictions are findings with both sides quoted', () => {
    const list = d.attention.findings.filter((f) => f.type === 'contradictory');
    assert.ok(list.length >= 3);
    for (const f of list) {
      assert.equal(f.status, 'conflicting');
      assert.equal(f.contract_position.basis, 'conflicting');
      assert.ok(new Set(f.evidence.map((e) => e.element_id)).size >= 2, `${f.id}: both sides are cited`);
      assert.ok(f.related_clauses.some((c) => c.relationship === 'conflicts_with'), f.id);
    }
  });

  test('Section 1 shows the affected term as conflicting, with more than one quote', () => {
    const conflicting = d.deal.items.filter((i) => i.status === 'conflicting');
    assert.ok(conflicting.length >= 1);
    for (const i of conflicting) {
      assert.ok(i.evidence.length >= 1);
      assert.ok((i.related_finding_ids || []).length >= 1, i.id);
    }
    const compatible = decide(runPipeline(fixtureText('compatible')));
    assert.equal(compatible.deal.items.filter((i) => i.status === 'conflicting').length, 0, 'a consistent contract shows no conflicts');
  });

  test('Section 4 keeps a conflict in the uncertain outcomes, not in the contractual ones', () => {
    const uncertain = d.scenarios.flatMap((s) => s.potential_outcome.uncertain.filter((x) => x.basis === 'conflicting'));
    assert.ok(uncertain.length >= 1);
    for (const s of d.scenarios) for (const c of s.potential_outcome.contractual) assert.notEqual(c.basis, 'conflicting');
  });
});

test.describe('Decision report: scenario triggers', () => {
  const scenarioIds = (d: DecisionReport) => d.scenarios.map((s) => s.id);

  test('worker-classification indicators alone do not trigger the other-clients scenario', () => {
    const d = decide(
      review(
        'Contractor shall provide software development services.',
        'Contractor must work set hours from 9am to 5pm Monday to Friday.',
        'Contractor shall work at the Company’s office and use Company equipment.',
        'Company will supervise and direct the day-to-day work of Contractor.'
      )
    );
    assert.ok(d.attention.findings.some((f) => f.category === 'Worker Classification'), 'the indicators are still reported as findings');
    assert.ok(!scenarioIds(d).includes('scenario.other_clients'));
    assert.ok(!scenarioIds(d).includes('scenario.data_incident'));
  });

  test('an actual restriction on other clients does trigger it, with the clause as the reason', () => {
    const d = decide(review('Contractor shall provide software development services.', 'Contractor shall provide services exclusively to Company during the term.'));
    const s = d.scenarios.find((x) => x.id === 'scenario.other_clients')!;
    assert.ok(s);
    assert.ok(s.trigger.evidence.some((e) => /exclusively/i.test(e.exact_quote)));
  });

  test('a payment-only contract triggers only the scenarios its provisions support', () => {
    const d = decideText(
      sectioned(['COMPENSATION AND PAYMENT', '2.1 Fees. Company shall pay Contractor at the rate of $50.00 per hour for approved hours worked.', '2.2 Payment Due. Invoices are payable Net 30 days from receipt of a valid invoice.'])
    );
    for (const id of ['scenario.data_incident', 'scenario.ip_reuse', 'scenario.renewal', 'scenario.other_clients', 'scenario.subcontracting', 'scenario.taxes']) {
      assert.ok(!scenarioIds(d).includes(id), `${id} should not apply`);
    }
    assert.ok(scenarioIds(d).includes('scenario.late_payment'));
  });

  test('a data incident scenario needs a data provision, and does not need unrelated clauses', () => {
    const d = decide(review('Contractor shall provide support services.', 'Contractor will have access to customer personal data and shall keep it secure.'));
    const s = d.scenarios.find((x) => x.id === 'scenario.data_incident')!;
    assert.ok(s, 'triggered by the data provision');
    assert.ok(s.trigger.evidence.some((e) => /personal data/i.test(e.exact_quote)));
    assert.ok(!scenarioIds(d).includes('scenario.ip_reuse'));
    assert.ok(!scenarioIds(d).includes('scenario.renewal'));
  });

  test('a rejected-deliverable scenario is driven by acceptance, not by IP or termination clauses', () => {
    const d = decideText(
      sectioned(['SERVICES AND SCOPE OF WORK', '1.1 Services. Contractor shall deliver the website.', '1.2 Acceptance. Company shall have a review period to approve or reject each deliverable.'])
    );
    assert.ok(scenarioIds(d).includes('scenario.deliverable_rejected'));
    assert.ok(!scenarioIds(d).includes('scenario.ip_reuse'));
    assert.ok(!scenarioIds(d).includes('scenario.client_ends_early'));
  });

  test('every scenario is justified by quoted contract text and says something real', () => {
    for (const [name, text] of samples) {
      const d = decideText(text);
      for (const s of d.scenarios) {
        assert.ok(s.trigger.evidence.length > 0, `${name}/${s.id}: no trigger evidence`);
        assert.ok(s.trigger.reason.length > 0);
        assert.ok(s.contract_position.some((p) => p.basis !== 'not_in_contract'), `${name}/${s.id}: only absences`);
        assert.ok(s.applicable_clauses.length > 0);
        assert.ok(s.recommended_action.text.length > 0 && s.recommended_action.grounded_in.length > 0);
        // a scenario's outcomes keep what the contract says apart from what is uncertain
        assert.ok(s.potential_outcome.uncertain.some((u) => u.basis === 'outside_contract'), 'legal rights outside the contract are labelled, not asserted');
        for (const c of s.potential_outcome.contractual) assert.equal(c.basis, 'explicit');
        for (const m of s.missing_protections) assert.equal(m.basis, 'not_in_contract');
      }
    }
  });
});

test.describe('Decision report: rights and next steps', () => {
  test('a notice period is taken from the contract’s own words', () => {
    const d = decide(review('Contractor shall provide services.', 'Either party may terminate this Agreement at any time upon thirty (30) days written notice.'));
    const right = d.rights_and_next_steps.rights.find((x) => x.id === 'right.terminate_for_convenience')!;
    assert.ok(right);
    assert.equal(right.holder, 'either_party');
    assert.equal(right.notice_period?.days, 30);
    assert.ok(right.evidence.some((e) => e.exact_quote.includes(right.notice_period!.text)), 'the notice text is a verbatim fragment');
  });

  test('a right the client alone holds is not listed as yours', () => {
    const d = decideText(SAMPLE);
    assert.ok(!d.rights_and_next_steps.rights.some((x) => x.id.startsWith('right.terminate')));
    const t = d.deal.items.find((i) => i.id === 'termination.notice')!;
    assert.equal(t.structured?.holder, 'client');
  });

  test('a clause that assigns your pre-existing tools is not presented as a right to keep them', () => {
    const d = decideText(SAMPLE);
    assert.ok(!d.rights_and_next_steps.rights.some((x) => x.id === 'right.keep_preexisting_ip'));
    const pre = d.commitments.freelancer.flatMap((g) => g.items).filter((i) => /pre-existing/i.test(i.title));
    for (const i of pre) assert.equal(i.nature, 'duty');
  });

  test('conditions and limitations are verbatim fragments of the cited wording', () => {
    for (const [name, text] of samples) {
      const d = decideText(text);
      for (const right of d.rights_and_next_steps.rights) {
        assert.ok(right.evidence.length > 0, `${name}/${right.id}`);
        const quotes = right.evidence.map((e) => e.exact_quote).join(' ');
        for (const c of [...right.conditions, ...right.limitations]) assert.ok(quotes.includes(c), `${name}/${right.id}: "${c}"`);
      }
    }
  });

  test('every question and checklist entry points at a finding or a stated term', () => {
    for (const [name, text] of samples) {
      const d = decideText(text);
      const findingIds = new Set(d.attention.findings.map((f) => f.id));
      const itemIds = new Set(d.deal.items.map((i) => i.id));
      const qIds = new Set(d.rights_and_next_steps.questions.map((q) => q.id));
      for (const q of d.rights_and_next_steps.questions) {
        assert.ok(q.grounded_in.finding_id ? findingIds.has(q.grounded_in.finding_id) : itemIds.has(q.grounded_in.item_id!), `${name}/${q.id}`);
      }
      for (const c of d.rights_and_next_steps.checklist.before_signing) {
        assert.ok(c.related_finding_id || c.related_item_id || c.related_question_id, `${name}/${c.id}`);
        if (c.related_question_id) assert.ok(qIds.has(c.related_question_id));
      }
      for (const m of d.rights_and_next_steps.checklist.during_engagement) {
        assert.ok(m.evidence.length > 0, `${name}/${m.id}: a monitor item without a quote`);
      }
    }
  });

  test('dates are only shown when stated or calculated from stated dates, and calculated ones are labelled', () => {
    const d = decide(review('Contractor shall provide services.', 'This Agreement begins on January 15, 2026 and continues for a term of six (6) months.'));
    const entries = d.rights_and_next_steps.checklist.during_engagement.filter((m) => m.date);
    for (const m of entries) {
      assert.ok(m.evidence.length > 0);
      const stated = m.evidence.some((e) => e.exact_quote.includes(m.date!));
      assert.ok(stated || m.calculated === true, `${m.id}: a date that is neither stated nor labelled as calculated`);
    }
    const end = d.deal.items.find((i) => i.id === 'timeline.end_date')!;
    if (end.structured?.calculated_date) assert.match(end.value!, /calculated/i);
    // no dates at all in the contract -> none are produced
    const none = decideText(SAMPLE.replace(/October 1, 2025/g, 'the date of signature'));
    assert.equal(none.rights_and_next_steps.checklist.during_engagement.filter((m) => m.date).length, 0);
  });
});

test.describe('Decision report: nothing is invented', () => {
  const BENCHMARK = /\b(common(ly)?|typical(ly)?|usual(ly)?|industry|standard practice|market rate|best practice|normally|generally accepted)\b/i;

  /** Report text written by the report (not quoted from the contract). */
  function generated(d: DecisionReport): string[] {
    const out: string[] = [];
    for (const f of d.attention.findings) out.push(f.title, f.impact, f.recommended_action, f.contract_position.text);
    for (const s of d.scenarios) {
      out.push(s.scenario, s.situation, s.trigger.reason, s.recommended_action.text);
      for (const m of s.missing_protections) out.push(m.text);
    }
    for (const q of d.rights_and_next_steps.questions) out.push(q.question, q.suggested_change ?? '');
    for (const c of d.rights_and_next_steps.checklist.before_signing) out.push(c.text);
    return out;
  }

  test('no benchmark claims, and no amounts or deadlines that are not in the contract', () => {
    for (const [name, text] of samples) {
      const d = decideText(text);
      const norm = (n: string): string => n.replace(/[,.]$/, '').replace(/,/g, '').replace(/\.0+$/, '');
      const numbers = new Set((text.match(/\d[\d,.]*/g) || []).map(norm));
      const statedDates = extractDates(text);
      for (const raw of generated(d)) {
        assert.ok(!BENCHMARK.test(raw), `${name}: benchmark claim: ${raw}`);
        // A date written as 2026-06-01 must be stated in the contract (in whatever format) or be labelled as calculated
        for (const iso of raw.match(/\d{4}-\d{2}-\d{2}/g) || []) assert.ok(statedDates.has(iso) || /would end|around|about|calculated/i.test(raw), `${name}: ${iso} is neither stated in the contract nor labelled as calculated: ${raw}`);
        const field = raw.replace(/\d{4}-\d{2}-\d{2}/g, '');
        for (const n of field.match(/\d[\d,.]*/g) || []) {
          if (/^\d\.\d+$/.test(n) || /^\d+\.$/.test(n) || n === '1.0') continue; // clause numbers like 2.1
          assert.ok(numbers.has(norm(n)), `${name}: "${n}" is not in the contract: ${field}`);
        }
      }
    }
  });

  test('example wording is kept in a separate, labelled field and out of the recommended action', () => {
    for (const [name, text] of samples) {
      const d = decideText(text);
      for (const f of d.attention.findings) {
        assert.ok(!/\b(for example|such as|e\.g\.)\b/i.test(f.recommended_action), `${name}/${f.id}: ${f.recommended_action}`);
        assert.ok(!/\d/.test(f.recommended_action), `${name}/${f.id}: action states a figure`);
      }
      for (const s of d.scenarios) assert.ok(!/\b(for example|such as|e\.g\.)\b/i.test(s.recommended_action.text));
    }
    const some = samples.map(([, t]) => decideText(t)).flatMap((d) => d.attention.findings).filter((f) => f.illustrative_alternative);
    assert.ok(some.length > 0, 'at least one finding carries an illustrative alternative');
  });

  test('rights outside the contract are labelled, never asserted', () => {
    for (const [, text] of samples) {
      const d = decideText(text);
      assert.match(d.rights_and_next_steps.outside_contract_note, /not assessed/i);
      for (const s of d.scenarios) {
        for (const u of s.potential_outcome.uncertain.filter((x) => x.basis === 'outside_contract')) {
          assert.match(u.text, /not assessed/i);
          assert.equal(u.evidence.length, 0);
        }
      }
    }
  });

  test('a contract with nothing in it produces no invented content', () => {
    const d = decideText(contractFrom(['The parties agree to cooperate.']));
    assert.equal(d.rights_and_next_steps.rights.length, 0);
    assert.equal(d.scenarios.length, 0);
    assert.equal(d.commitments.freelancer.flatMap((g) => g.items).filter((i) => i.status === 'explicit' && /pay|indemn|insur/i.test(i.title)).length, 0);
  });
});

test.describe('Decision report: pipeline integration', () => {
  test('is built inside the single-request analysis and returned with the other results', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.CLAMAV_HOST; // no antivirus: the built-in checks decide
    delete process.env.CLAMAV_SCAN_URL;
    await initServerRuntime();
    const server = createServer(createApp());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const cookie = (await fetch(`${base}/api/auth/session`)).headers.getSetCookie()[0].split(';')[0];
      const form = new FormData();
      form.append('file', new Blob([SAMPLE], { type: 'text/plain' }), 'contract.txt');
      const res = await fetch(`${base}/api/contracts/upload?analyze=1`, { method: 'POST', headers: { cookie }, body: form });
      const body = await res.json();
      assert.equal(res.status, 200);
      const d: DecisionReport = body.analysis.decisionReport;
      assert.ok(d, 'decisionReport is part of the analyze=1 response');
      assert.equal(d.schema_version, '1.0');
      assert.equal(d.verified_sha256, body.analysis.riskReport.verified_sha256);
      assert.equal(d.attention.findings.length, body.analysis.riskReport.findings.length);
      assert.equal(body.analysis.decisionReportError, undefined);
      assert.equal(body.analysis.riskReport.overview.review_priority, 'High', 'existing results are unchanged');

      // Without ?analyze=1 nothing is analyzed (and there is no separate decision-report endpoint to depend on shared memory)
      const plain = new FormData();
      plain.append('file', new Blob(['Short note.'], { type: 'text/plain' }), 'note.txt');
      const plainRes = await (await fetch(`${base}/api/contracts/upload`, { method: 'POST', headers: { cookie }, body: plain })).json();
      assert.equal(plainRes.analysis, undefined);
      assert.equal((await fetch(`${base}/api/contracts/${body.fileId}/decision-report`, { headers: { cookie } })).status, 404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('uses no AI call, network or storage', async () => {
    const dir = path.resolve(process.cwd(), 'src/server/decision');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    assert.ok(files.length >= 8);
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.ok(!/geminiClient|@google\/genai|GoogleGenAI|\bfetch\(|node:fs|node:http|from 'fs'|\bcache\b|Map<string, .*Cache|localStorage|supabase|sqlite|redis/i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), `${f} must stay pure and local`);
    }
    // And it runs with the network unavailable
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error('network is not allowed'); }) as any;
    try {
      const d = decideText(SAMPLE);
      assert.ok(d.scenarios.length > 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
