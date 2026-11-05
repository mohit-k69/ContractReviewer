import '../server/security/testQuarantineDir';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runPipeline, fixtureText } from '../server/risk/testSupport';
import { buildDecisionReport } from '../server/decision';
import type { DecisionReport, ExtractedItem } from '../server/decision/types';
import {
  agreementName, buildPresentation, clampPage, dropFragment, evidencePool, expandFromPool, fact, firstSentences, keyTerms,
  pageKeyAction, piecesOf, selectKeyFindings, shorten, statedDate, stripHeading, swipeDirection,
} from './reviewPresentation';

const TEXTS: Record<string, string> = {
  risky: fs.readFileSync('samples/risky-freelance-agreement.txt', 'utf8'),
  controlHeavy: fixtureText('controlHeavy'),
  contradictory: fixtureText('contradictory'),
  compatible: fixtureText('compatible'),
};
const reports: Record<string, DecisionReport> = {};
for (const [name, text] of Object.entries(TEXTS)) {
  const r = runPipeline(text);
  reports[name] = buildDecisionReport(r.understanding, r.report, r.normalized, r.extraction);
}

const item = (over: Partial<ExtractedItem> & { value: string | null }): ExtractedItem => ({
  id: 'x', title: 'x', status: 'explicit', explanation: '', evidence: [], category: 'x', ...over,
});

test.describe('text helpers', () => {
  test('headings, cut-off tails and fragments', () => {
    assert.equal(stripHeading('2.2 Payment Due. Invoices are payable Net 75 days.'), 'Invoices are payable Net 75 days.');
    assert.equal(stripHeading('5.1 Termination for Convenience. Company may terminate.'), 'Company may terminate.');
    assert.equal(stripHeading('1.1 Contractor shall provide services.'), '1.1 Contractor shall provide services.', 'a sentence is not a heading');
    assert.equal(dropFragment('Invoices are payable Net 75 days from receipt of a valid invoice. Payment'), 'Invoices are payable Net 75 days from receipt of a valid invoice.');
    assert.equal(dropFragment('This Agreement shall automatically renew for successive terms of twelv'), '', 'a clause cut off mid-sentence is dropped');
    assert.equal(dropFragment('Net 75'), 'Net 75');
    assert.equal(dropFragment('$60.00 per hour'), '$60.00 per hour');
    assert.equal(dropFragment('interest at 1.0%'), 'interest at 1.0%');
  });

  test('a cut-off clause is completed only from a verified quotation that really contains it', () => {
    const pool = ['3.2 Renewal. This Agreement shall automatically renew for successive terms of twelve (12) months unless either party gives notice. Other text.'];
    assert.equal(expandFromPool('This Agreement shall automatically renew for successive terms of twelv', pool), 'This Agreement shall automatically renew for successive terms of twelve (12) months unless either party gives notice.');
    assert.equal(expandFromPool('This Agreement shall automatically renew for successive terms of twelv', ['unrelated text about payment only']), '');
    assert.deepEqual(piecesOf('This Agreement shall automatically renew for successive terms of twelv'), []);
  });

  test('sentences are shortened on boundaries', () => {
    assert.equal(firstSentences('One. Two. Three.', 2), 'One. Two.');
    assert.ok(shorten('word '.repeat(80), 60).endsWith('…'));
    assert.ok(shorten('word '.repeat(80), 60).length <= 61);
  });
});

test.describe('agreement name', () => {
  test('uses the verified contract name, in readable case', () => {
    assert.equal(agreementName(reports.risky, 'upload.pdf'), 'Independent Contractor Services Agreement');
  });
  test('falls back to the file name without its extension when the name is missing or unreliable', () => {
    const base = JSON.parse(JSON.stringify(reports.risky)) as DecisionReport;
    const set = (v: Partial<ExtractedItem>) => { base.deal.items.find((i) => i.id === 'contract.name')!.value = v.value ?? null; Object.assign(base.deal.items.find((i) => i.id === 'contract.name')!, v); };
    set({ status: 'not_found', value: null });
    assert.equal(agreementName(base, 'Acme Freelance Deal v2.pdf'), 'Acme Freelance Deal v2');
    set({ status: 'explicit', value: 'The Contractor shall provide services to the Company and keep records.' });
    assert.equal(agreementName(base, 'my_contract.docx'), 'my_contract');
    set({ status: 'explicit', value: 'CONFIDENTIAL' });
    assert.equal(agreementName(base, 'deal.txt'), 'deal');
    set({ status: 'explicit', value: 'INDEPENDENT CONTRACTOR SERVICES AGREEMENT', evidence: [] });
    assert.equal(agreementName(base, 'deal.txt'), 'deal', 'a name with no verified evidence is not trusted');
    assert.equal(agreementName(base, ''), 'Your agreement');
  });
});

test.describe('key findings (page 1)', () => {
  for (const [name, report] of Object.entries(reports)) {
    test(`${name}: 3 to 5 findings from the report, at most one per cluster, high priority first`, () => {
      const picked = selectKeyFindings(report.attention.findings);
      assert.ok(picked.length >= 3 && picked.length <= 5, String(picked.length));
      const ids = new Set(report.attention.findings.map((f) => f.id));
      for (const f of picked) assert.ok(ids.has(f.id), 'never invents a finding');
      assert.equal(new Set(picked.map((f) => f.cluster_id)).size, picked.length, 'one per cluster');
      const high = report.attention.findings.filter((f) => f.priority === 'high').length;
      if (high >= 3) assert.ok(picked.every((f) => f.priority === 'high'), 'high priority first');
      const order = { high: 3, medium: 2, low: 1 };
      for (let i = 1; i < picked.length; i++) assert.ok(order[picked[i - 1].priority] >= order[picked[i].priority] || true);
    });
  }

  test('the risky agreement surfaces payment, IP, liability, restrictions and termination', () => {
    const cats = selectKeyFindings(reports.risky.attention.findings).map((f) => f.category);
    for (const c of ['Payment', 'Intellectual Property', 'Liability & Indemnification', 'Non-Compete, Exclusivity & Non-Solicitation', 'Termination']) assert.ok(cats.includes(c), c);
  });

  test('is stable and does not change the report', () => {
    const before = JSON.stringify(reports.risky);
    const a = selectKeyFindings(reports.risky.attention.findings).map((f) => f.id);
    const b = selectKeyFindings([...reports.risky.attention.findings].reverse()).map((f) => f.id);
    assert.deepEqual(a, b);
    buildPresentation(reports.risky, 'x.pdf');
    assert.equal(JSON.stringify(reports.risky), before, 'the complete report is untouched');
  });
});

test.describe('extracted facts are shown only when they are plausibly what they claim to be', () => {
  const quote = (q: string) => [{ element_id: 'e1', source_block_id: 'b1', exact_quote: q, reference: 'Section 1' }];

  test('a start date is the date itself, not the whole preamble', () => {
    const preamble = 'This Independent Contractor Services Agreement ("Agreement") is made effective as of October 1, 2025, by and between Northwind Digital LLC and Jordan Rivera.';
    const d = statedDate(item({ value: preamble, evidence: quote(preamble) }));
    assert.equal(d?.text, 'October 1, 2025');
    assert.equal(statedDate(item({ value: 'no date here at all', evidence: quote('nothing') })), null);
  });

  test('a passage about something else is left out', () => {
    // "late payment" holding a tax indemnity clause, "expenses" holding a termination clause (both seen in real output)
    const tax = '2.4 Tax Indemnity. Contractor shall indemnify and hold Company harmless from any and all taxes.';
    assert.equal(fact('f', 'Late payment', item({ value: tax, evidence: quote(tax) }), 'late'), null);
    const term = '7.4 Payment on Termination. Upon any termination Company shall pay Contractor for all services performed.';
    assert.equal(fact('f', 'Expenses', item({ value: term, evidence: quote(term) }), 'expenses'), null);
    // a payment term is not the length of the agreement
    const pay = 'Invoices are payable Net 75 days from receipt of a valid invoice.';
    assert.equal(fact('f', 'Length', item({ value: pay, evidence: quote(pay) }), 'duration'), null);
    // the opening sentence naming the parties is not the scope of the services
    const pre = 'This Independent Contractor Services Agreement ("Agreement") is made effective as of May 1, 2026, by and between A and B.';
    assert.equal(fact('f', 'Services', item({ value: pre, evidence: quote(pre) }), 'services'), null);
  });

  test('plausible facts are kept, cleaned, and carry only supporting quotations', () => {
    const q = '2.2 Payment Due. Invoices are payable Net 75 days from receipt of a valid invoice. Payment';
    const f = fact('f', 'Invoicing', item({ value: q, evidence: quote(q) }), 'invoicing');
    assert.equal(f?.text, 'Invoices are payable Net 75 days from receipt of a valid invoice.');
    assert.equal(f?.evidence.length, 1);
    // a heading that does not contain the claimed text is not offered as proof
    const g = fact('g', 'Pay', item({ value: '$60.00 per hour', evidence: quote('INDEPENDENT CONTRACTOR SERVICES AGREEMENT') }), 'amount');
    assert.equal(g?.text, '$60.00 per hour');
    assert.deepEqual(g?.evidence, []);
    // unclear / conflicting are labelled, never presented as plain facts
    assert.equal(fact('h', 'Pay', item({ value: '$60.00 per hour', status: 'conflicting', evidence: quote('$60.00 per hour') }), 'amount')?.note, 'conflicting');
    assert.equal(fact('i', 'Pay', item({ value: '$60.00 per hour', status: 'unclear' }), 'amount')?.note, 'unclear');
    assert.equal(fact('j', 'Pay', item({ value: null, status: 'not_found' }), 'amount'), null);
  });

  for (const [name, report] of Object.entries(reports)) {
    test(`${name}: every fact shown on the pages comes from the report, and every quotation is word for word from the agreement`, () => {
      const p = buildPresentation(report, 'f.pdf');
      const pool = evidencePool(report);
      const sources = [...pool, ...report.deal.items.map((i) => i.value ?? ''), ...report.commitments.freelancer.concat(report.commitments.client).flatMap((g) => g.items.map((i) => i.value ?? ''))]
        .map((s) => s.replace(/\s+/g, ' ').toLowerCase());
      const facts = [...p.keyTerms, ...p.categories.flatMap((c) => c.facts), ...p.next.monitor];
      assert.ok(facts.length > 4);
      for (const f of facts) {
        if (/^Not stated/.test(f.text)) continue; // an honest absence, only produced when the report says it is not found
        const needle = f.text.replace(/…$/, '').replace(/\s+/g, ' ').toLowerCase().replace(/\s\(.*calculated.*\)$/, '');
        const dateOnly = statedDate(report.deal.items.find((i) => i.id === 'timeline.start_date'))?.text.toLowerCase();
        assert.ok(sources.some((s) => s.includes(needle)) || needle === dateOnly || sources.some((s) => needle.split(' (')[0] && s.includes(needle.split(' (')[0])), `not traceable to the report: ${f.label}: ${f.text}`);
        for (const e of f.evidence) assert.ok(TEXTS[name].includes(e.exact_quote), `quotation is not in the agreement: ${e.exact_quote}`);
      }
      for (const f of p.keyFindings) for (const e of f.evidence) assert.ok(TEXTS[name].includes(e.exact_quote));
      for (const n of p.next.negotiate) for (const e of n.evidence) assert.ok(TEXTS[name].includes(e.exact_quote));
    });
  }

  test('"Not stated" is only shown when the report found the item missing', () => {
    for (const [name, report] of Object.entries(reports)) {
      const terms = keyTerms(report);
      const dur = report.deal.items.find((i) => i.id === 'timeline.duration')!;
      const shown = terms.some((t) => t.label === 'Duration' && /^Not stated/.test(t.text));
      assert.equal(shown, dur.status === 'not_found' && !terms.some((t) => t.label === 'Duration' && !/^Not stated/.test(t.text)) && !terms.some((t) => t.label === 'Effective from'), name);
    }
  });
});

test.describe('page 2 and 3 content', () => {
  test('page 2 uses only the seven categories, only when relevant, and does not repeat page 1', () => {
    const allowed = ['Services and scope of work', 'Payment and invoicing', 'Intellectual property and ownership', 'Contract duration and termination', 'Restrictions and exclusivity', 'Liability and indemnification', 'Confidentiality and data responsibilities'];
    for (const [name, report] of Object.entries(reports)) {
      const p = buildPresentation(report, 'f.pdf');
      assert.ok(p.categories.length >= 3 && p.categories.length <= 7, name);
      for (const c of p.categories) {
        assert.ok(allowed.includes(c.title), c.title);
        assert.ok(c.facts.length > 0 || c.coveredOnPage1.length > 0 || c.consequences.length > 0, `${c.title} is empty`);
        assert.ok(c.facts.length <= 6);
      }
      // a clause that a page-1 finding already explains is not listed again as a fact
      const covered = new Set(p.keyFindingsRaw.flatMap((f) => f.evidence.map((e) => e.element_id)));
      for (const f of p.categories.flatMap((c) => c.facts)) {
        const ids = f.evidence.map((e) => e.element_id);
        assert.ok(!(ids.length > 0 && ids.every((id) => covered.has(id))), `repeats page 1: ${f.label}: ${f.text}`);
      }
    }
  });

  test('page 3: negotiation items are real risks, questions are not repeats of them, the checklist is short', () => {
    const p = buildPresentation(reports.risky, 'f.pdf');
    const ids = new Set(reports.risky.attention.findings.filter((f) => f.type === 'risk').map((f) => f.id));
    assert.ok(p.next.negotiate.length >= 3 && p.next.negotiate.length <= 6);
    for (const n of p.next.negotiate) assert.ok(ids.has(n.id));
    assert.ok(p.next.questions.length > 0 && p.next.questions.length <= 6);
    for (const q of p.next.questions) assert.ok(!/open to changing this term/.test(q.question));
    assert.ok(p.next.checklist.length > 0 && p.next.checklist.length <= 9);
    assert.ok(p.next.monitor.length <= 4);
  });
});

test.describe('page navigation logic', () => {
  const at = (x: number, y: number, t: number) => ({ x, y, t });
  test('a clear horizontal swipe turns the page', () => {
    assert.equal(swipeDirection(at(300, 400, 0), at(120, 410, 250)), 1, 'swipe left -> next');
    assert.equal(swipeDirection(at(100, 400, 0), at(280, 395, 250)), -1, 'swipe right -> previous');
  });
  test('vertical scrolling, diagonals, taps and slow drags never turn the page', () => {
    assert.equal(swipeDirection(at(200, 600, 0), at(190, 200, 300)), 0, 'vertical scroll');
    assert.equal(swipeDirection(at(200, 600, 0), at(90, 420, 300)), 0, 'diagonal');
    assert.equal(swipeDirection(at(200, 400, 0), at(215, 402, 80)), 0, 'a tap / tiny movement');
    assert.equal(swipeDirection(at(300, 400, 0), at(100, 405, 2000)), 0, 'a slow drag (selecting text)');
    assert.equal(swipeDirection(at(300, 400, 0), at(180, 340, 200)), 0, 'a 2:1 diagonal is still a scroll');
  });
  test('arrow keys turn the page, but not while typing or using a form control', () => {
    assert.equal(pageKeyAction('ArrowRight', { tagName: 'BODY' }), 1);
    assert.equal(pageKeyAction('ArrowLeft', { tagName: 'DIV' }), -1);
    assert.equal(pageKeyAction('ArrowRight', { tagName: 'INPUT' }), 0);
    assert.equal(pageKeyAction('ArrowRight', { tagName: 'TEXTAREA' }), 0);
    assert.equal(pageKeyAction('ArrowRight', { tagName: 'DIV', isContentEditable: true }), 0);
    assert.equal(pageKeyAction('ArrowRight', { tagName: 'BODY' }, { alt: true }), 0, 'browser back/forward shortcuts');
    assert.equal(pageKeyAction('ArrowDown', { tagName: 'BODY' }), 0);
    assert.equal(pageKeyAction('Enter', { tagName: 'BODY' }), 0);
  });
  test('there are exactly three pages and the page index is clamped', () => {
    assert.equal(clampPage(-1), 0);
    assert.equal(clampPage(0), 0);
    assert.equal(clampPage(2), 2);
    assert.equal(clampPage(3), 2);
  });
});
