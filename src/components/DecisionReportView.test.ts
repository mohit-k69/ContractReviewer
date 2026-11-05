import '../server/security/testQuarantineDir'; // must stay first: own quarantine directory for this test process
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DecisionReportView, SECTIONS } from './DecisionReportView';
import { runUploadWorkflow } from '../server/uploadWorkflow';
import { QUARANTINE_DIR } from '../server/security/quarantineManager';
import { interpretUploadResponse } from '../utils/uploadOutcome';
import type { DecisionReport } from '../server/decision/types';

const SAMPLE = fs.readFileSync(path.resolve(process.cwd(), 'samples', 'risky-freelance-agreement.txt'), 'utf8');
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const leftovers = () => (fs.existsSync(QUARANTINE_DIR) ? fs.readdirSync(QUARANTINE_DIR).filter((f) => /\.(quarantine|meta\.json)$/.test(f)) : []);

/** The full flow, exactly as the browser triggers it: one upload request whose response is what the UI receives. */
async function reviewed(text: string, name = 'sample_freelance_agreement.txt'): Promise<{ report: DecisionReport; response: any }> {
  delete process.env.GEMINI_API_KEY;
  const result = await runUploadWorkflow({ buffer: Buffer.from(text), originalName: name, mimeType: 'text/plain', sessionId: 'sess-ui', analyze: true });
  const outcome = interpretUploadResponse(result.status, result.body);
  assert.equal(outcome.ok, true, JSON.stringify(result.body).slice(0, 300));
  return { report: (outcome as any).report, response: result.body };
}

test.describe('the Decision Report screen', () => {
  test('full flow: upload -> analysis -> five-section report, with the file deleted afterwards', async () => {
    const before = leftovers();
    const { report, response } = await reviewed(SAMPLE);
    assert.equal(response.documentDeleted, true);
    assert.deepEqual(leftovers().filter((f) => !before.includes(f)), [], 'no temporary files or metadata remain');

    const html = renderToStaticMarkup(createElement(DecisionReportView, { report }));

    // exactly the five section names, in order, as headings
    const h2 = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => m[1]);
    assert.deepEqual(h2, ['Understand Your Deal', 'Your Commitments', 'What Deserves Your Attention?', 'What If Something Happens?', 'Your Rights and Next Steps']);
    assert.deepEqual(SECTIONS.map((s) => s.title), h2);
    const at = h2.map((t) => html.indexOf(`>${t}</h2>`));
    assert.deepEqual([...at].sort((a, b) => a - b), at);

    // the sub-headings requested for each section
    for (const sub of [
      'Parties involved', 'Type of agreement', 'Services and deliverables', 'Contract duration', 'Fees and payment terms',
      'What you must do', 'What you cannot do', 'What the client must do', 'What each party is allowed to do',
      'Important contract risks', 'Missing protections', 'Ambiguous terms', 'Contradictory clauses',
      'Rights stated in the agreement', 'Questions to ask before signing', 'Pre-signing checklist', 'Things to monitor during the engagement',
    ]) assert.match(html, new RegExp(`<h3[^>]*>${sub}</h3>`), sub);
  });

  test('every quotation shown is word-for-word text from the uploaded agreement, with its section reference', async () => {
    const { report } = await reviewed(SAMPLE);
    const html = renderToStaticMarkup(createElement(DecisionReportView, { report }));
    const quotes = [
      ...report.deal.items.flatMap((i) => i.evidence),
      ...report.attention.findings.flatMap((f) => f.evidence),
      ...report.rights_and_next_steps.rights.flatMap((r) => r.evidence),
    ];
    assert.ok(quotes.length > 15);
    for (const q of quotes) {
      assert.ok(SAMPLE.includes(q.exact_quote), `not in the agreement: ${q.exact_quote}`);
      assert.ok(html.includes(escapeHtml(q.exact_quote)), `not shown: ${q.exact_quote}`);
      assert.ok(html.includes(escapeHtml(q.reference)), `reference not shown: ${q.reference}`);
    }
    assert.match(html, /COMPENSATION AND PAYMENT › 2\.2 Payment Due/);
  });

  test('findings explain what the agreement says, why it matters, the clause, and what to raise; important ones stand out', async () => {
    const { report } = await reviewed(SAMPLE);
    const html = renderToStaticMarkup(createElement(DecisionReportView, { report }));
    for (const label of ['What the agreement says', 'Why it matters to you', 'The clause', 'What to clarify or negotiate']) assert.ok(html.includes(label), label);
    const high = report.attention.findings.filter((f) => f.priority === 'high');
    assert.ok(high.length > 0);
    assert.equal((html.match(/>Important</g) || []).length, high.length);
    for (const f of report.attention.findings) {
      assert.ok(html.includes(escapeHtml(f.title)), f.title);
      assert.ok(html.includes(escapeHtml(f.impact)), `why it matters: ${f.title}`);
      assert.ok(html.includes(escapeHtml(f.recommended_action)), `what to raise: ${f.title}`);
    }
    // important findings are marked, and every finding starts collapsed so the first view stays easy to scan
    assert.equal((html.match(/border-l-red-500/g) || []).length, high.length);
    assert.ok(!/<details open/.test(html), 'nothing is expanded by default');
  });

  test('only scenarios from the report are shown, and the requested situations appear when the agreement supports them', async () => {
    const { report } = await reviewed(SAMPLE);
    const html = renderToStaticMarkup(createElement(DecisionReportView, { report }));
    for (const s of report.scenarios) assert.ok(html.includes(escapeHtml(s.scenario)), s.scenario);
    const shown = [...html.matchAll(/<span class="block text-\[15px\] font-medium text-gray-900">([^<]+)<\/span><span class="block text-sm text-gray-500">/g)].map((m) => m[1]);
    assert.equal(shown.length, report.scenarios.length, 'no scenario is invented');
    assert.ok(report.scenarios.some((s) => s.id === 'scenario.late_payment'));
    assert.ok(report.scenarios.some((s) => s.id === 'scenario.client_ends_early'));
    // the requested situations come first, in a sensible order
    assert.ok(shown.indexOf('The client pays late') < shown.indexOf('The client ends the contract early'));
  });

  test('nothing technical, no invented numbers and no score is shown', async () => {
    const { report } = await reviewed(SAMPLE);
    const html = renderToStaticMarkup(createElement(DecisionReportView, { report }));
    const text = html.replace(/<[^>]+>/g, ' ');
    assert.ok(!/element_id|source_block|subsec-fixture|sha-?256|antivirus|clamav|malware|security (check|inspection|scan)|quarantine|extraction|normaliz|BASIC_CHECKS|schema_version|verified_sha/i.test(text), 'no technical wording');
    // a missing value rendered as text would stand alone in an element or after a label; the word "undefined" can
    // legitimately appear inside the agreement's own findings (for example "if acceptance is undefined")
    assert.ok(!/>\s*(undefined|null|NaN)\s*</.test(html) && !/\[object Object\]|: undefined|NaN/.test(text), 'no broken values');
    assert.ok(!/risk score|score|\/\s?100|\brating\b|risk level|review priority/i.test(text), 'no numerical risk score');
    assert.match(text, /not legal advice/i);
  });

  test('the checklist is interactive and the report works for a minimal agreement without crashing', async () => {
    const { report } = await reviewed('INDEPENDENT CONTRACTOR AGREEMENT\n\nThis agreement is between Acme Inc. ("Company") and Pat Doe ("Contractor").\n\n1. The parties agree to cooperate in good faith on the project described by the parties from time to time.\n'.repeat(3), 'tiny.txt');
    const html = renderToStaticMarkup(createElement(DecisionReportView, { report }));
    assert.equal([...html.matchAll(/<h2[^>]*>/g)].length, 5);
    assert.ok(!/undefined|\[object Object\]|NaN/.test(html.replace(/<[^>]+>/g, ' ')));
    const full = renderToStaticMarkup(createElement(DecisionReportView, { report: (await reviewed(SAMPLE)).report }));
    assert.match(full, /type="checkbox"/);
  });

  test('the old technical screens are gone from the app', () => {
    const app = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    const upload = fs.readFileSync(path.resolve(process.cwd(), 'src/components/ContractFileUpload.tsx'), 'utf8');
    assert.match(app, /DecisionReportView/);
    assert.ok(!/ContractReviewReport|ContractUnderstandingViewer|riskReport|understandingResult|Extracted contract facts/.test(app));
    assert.ok(!/Inspection details|View audit|Extraction|Structure Inspector|SHA-256|Malware Scanner|antivirus|Clean \(|extractionResult|normalizedDocument/i.test(upload));
    assert.ok(!fs.existsSync(path.resolve(process.cwd(), 'src/components/ContractReviewReport.tsx')));
    assert.ok(!fs.existsSync(path.resolve(process.cwd(), 'src/components/ContractUnderstandingViewer.tsx')));
    assert.match(upload, /Reviewing your contract/);
    assert.match(upload, /decisionReport/);
  });
});
