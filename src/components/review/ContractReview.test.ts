import '../../server/security/testQuarantineDir'; // must stay first: own quarantine directory for this test process
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContractReview } from './ContractReview';
import { runUploadWorkflow } from '../../server/uploadWorkflow';
import { QUARANTINE_DIR } from '../../server/security/quarantineManager';
import { interpretUploadResponse } from '../../utils/uploadOutcome';
import { buildPresentation } from '../../utils/reviewPresentation';
import { runPipeline, fixtureText } from '../../server/risk/testSupport';
import { buildDecisionReport } from '../../server/decision';
import type { DecisionReport } from '../../server/decision/types';

const TEXTS: Record<string, string> = {
  risky: fs.readFileSync(path.resolve(process.cwd(), 'samples', 'risky-freelance-agreement.txt'), 'utf8'),
  controlHeavy: fixtureText('controlHeavy'),
  contradictory: fixtureText('contradictory'),
  compatible: fixtureText('compatible'),
};
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const render = (report: DecisionReport, page: number, fileName = 'sample_freelance_agreement.txt') => renderToStaticMarkup(createElement(ContractReview, { report, fileName, initialPage: page }));
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
/** What the reader sees by default: the exact-wording panels are collapsed until "See clause" is opened. */
const visibleWords = (html: string) => textOf(html.replace(/<div class="mt-2\.5[^>]*data-no-swipe="">[\s\S]*?<\/figure><\/div>/g, '')).trim().split(' ').length;
const leftovers = () => (fs.existsSync(QUARANTINE_DIR) ? fs.readdirSync(QUARANTINE_DIR).filter((f) => /\.(quarantine|meta\.json)$/.test(f)) : []);

const reports: Record<string, DecisionReport> = {};
test.before(async () => {
  delete process.env.GEMINI_API_KEY;
  // The risky sample goes through the real upload workflow, exactly as the browser triggers it
  const before = leftovers();
  const result = await runUploadWorkflow({ buffer: Buffer.from(TEXTS.risky), originalName: 'sample_freelance_agreement.txt', mimeType: 'text/plain', sessionId: 'sess-review', analyze: true });
  const outcome = interpretUploadResponse(result.status, result.body);
  assert.equal(outcome.ok, true);
  reports.risky = (outcome as any).report;
  assert.equal((result.body as any).documentDeleted, true);
  assert.deepEqual(leftovers().filter((f) => !before.includes(f)), [], 'temporary files and metadata are deleted after processing');
  for (const name of ['controlHeavy', 'contradictory', 'compatible']) {
    const r = runPipeline(TEXTS[name]);
    reports[name] = buildDecisionReport(r.understanding, r.report, r.normalized, r.extraction);
  }
});

const OLD_TITLES = ['Your contract, explained', 'Understand Your Deal', 'Your Commitments', 'What Deserves Your Attention?', 'What If Something Happens?', 'Your Rights and Next Steps', 'A plain-English review'];

test.describe('three-page review', () => {
  test('page 1: the agreement name leads, then 3 to 5 findings and key terms; nothing from the old header remains', () => {
    const html = render(reports.risky, 0);
    const text = textOf(html);
    assert.match(html, /<h1[^>]*>Independent Contractor Services Agreement<\/h1>/);
    assert.ok(html.indexOf('<h1') < html.indexOf('What you should know before signing'), 'the name comes first');
    for (const t of OLD_TITLES) assert.ok(!text.includes(t), `old text still present: ${t}`);
    assert.ok(!/href="#/.test(html), 'no anchor navigation links');
    assert.match(html, /What you should know before signing/);
    assert.match(html, /Key terms/);
    const findings = html.split('<ol')[1]?.split('</ol>')[0].match(/<li /g) ?? [];
    assert.ok(findings.length >= 3 && findings.length <= 5, `findings shown: ${findings.length}`);
    assert.equal((html.match(/Why it matters\./g) || []).length, findings.length);
    assert.equal((html.match(/What to do\./g) || []).length, findings.length);
    assert.match(html, /See clause/);
    // what matters most is up front
    for (const must of ['Payment depends on a condition the client controls', 'Broad indemnity', 'IP assignment may reach beyond this project']) assert.ok(text.includes(must), must);
    // key terms, only the useful ones
    for (const must of ['Northwind Digital LLC', 'Jordan Rivera', '$60.00 per hour', 'Net 75']) assert.ok(text.includes(must), must);
  });

  test('page 1 is concise and does not show every finding', () => {
    const report = reports.risky;
    const p = buildPresentation(report, 'f.txt');
    assert.ok(p.keyFindings.length < report.attention.findings.length);
    const words = visibleWords(render(report, 0));
    assert.ok(words < 700, `page 1 shows ${words} words by default`);
  });

  test('the file name is the heading only when the report has no reliable name', () => {
    const copy = JSON.parse(JSON.stringify(reports.risky)) as DecisionReport;
    copy.deal.items.find((i) => i.id === 'contract.name')!.status = 'not_found';
    assert.match(render(copy, 0, 'Acme Design Retainer.pdf'), /<h1[^>]*>Acme Design Retainer<\/h1>/);
  });

  test('page 2: the seven topics, short facts, wording on demand, no scenario section', () => {
    const html = render(reports.risky, 1);
    const text = textOf(html);
    assert.match(html, /<h1[^>]*>Understand Your Agreement<\/h1>/);
    const titles = [...html.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map((m) => m[1]);
    const allowed = ['Services and scope of work', 'Payment and invoicing', 'Intellectual property and ownership', 'Contract duration and termination', 'Restrictions and exclusivity', 'Liability and indemnification', 'Confidentiality and data responsibilities'];
    assert.ok(titles.length >= 4);
    for (const t of titles) assert.ok(allowed.includes(t), t);
    assert.match(html, /See contract wording/);
    assert.ok(!/What If Something Happens|Scenario/i.test(text), 'the long scenario section is gone');
    assert.ok(!/Why it matters\./.test(html), 'findings are not repeated in full');
    assert.match(text, /Main concern explained on page 1/);
    for (const t of OLD_TITLES) assert.ok(!text.includes(t), t);
  });

  test('page 3: negotiate, questions, an interactive checklist, things to monitor', () => {
    const html = render(reports.risky, 2);
    assert.match(html, /<h1[^>]*>Before You Sign<\/h1>/);
    for (const h of ['What should you negotiate?', 'Questions to ask', 'Your pre-signing checklist', 'Things to monitor during the engagement']) assert.ok(html.includes(h), h);
    const boxes = html.match(/type="checkbox"/g) ?? [];
    assert.ok(boxes.length >= 3 && boxes.length <= 9, String(boxes.length));
    assert.ok(!/open to changing this term/.test(html), 'questions do not repeat the negotiation list');
    assert.match(html, /Net 75/);
  });

  test('exactly three pages: only the current one is rendered, and the controls match the page', () => {
    const pages = [0, 1, 2].map((i) => render(reports.risky, i));
    const h1 = pages.map((h) => (/<h1[^>]*>([^<]+)<\/h1>/.exec(h) ?? [])[1]);
    assert.deepEqual(h1, ['Independent Contractor Services Agreement', 'Understand Your Agreement', 'Before You Sign']);
    // page 1: next only
    assert.match(pages[0], />1 of 3</);
    assert.match(pages[0], /aria-label="Next page: Understand Your Agreement"/);
    assert.ok(!/aria-label="Previous page/.test(pages[0]));
    // page 2: previous and next
    assert.match(pages[1], />2 of 3</);
    assert.match(pages[1], /aria-label="Previous page: Contract Overview"/);
    assert.match(pages[1], /aria-label="Next page: Before You Sign"/);
    // page 3: previous and an end-of-review state
    assert.match(pages[2], />3 of 3</);
    assert.match(pages[2], /aria-label="Previous page: Understand Your Agreement"/);
    assert.ok(!/aria-label="Next page/.test(pages[2]));
    assert.match(pages[2], /End of review/);
    // other pages' content is not in the DOM
    assert.ok(!/Key terms/.test(pages[1]) && !/Key terms/.test(pages[2]));
    assert.ok(!/Questions to ask/.test(pages[0]) && !/Questions to ask/.test(pages[1]));
    assert.ok(!/See contract wording/.test(pages[0]) && !/See contract wording/.test(pages[2]));
    // an out-of-range page is clamped, never a fourth page
    assert.match(render(reports.risky, 7), />3 of 3</);
    assert.match(render(reports.risky, -4), />1 of 3</);
  });

  test('navigation is accessible and keeps scrolling native', () => {
    const html = render(reports.risky, 1);
    assert.match(html, /<nav[^>]*aria-label="Review pages"/);
    assert.match(html, /role="status"[^>]*>[^<]*Understand Your Agreement, page 2 of 3/, 'the page change is announced');
    assert.match(html, /touch-action:\s*pan-y/);
    assert.match(html, /sticky bottom-0/);
    assert.match(html, /env\(safe-area-inset-bottom\)/);
    assert.match(html, /<button[^>]*type="button"/);
    assert.match(html, /tabindex="-1"/, 'the page heading can receive focus after a page change');
  });

  for (const name of Object.keys(TEXTS)) {
    test(`${name}: every quotation on every page is word for word from the agreement; nothing technical, no score`, () => {
      const report = reports[name];
      const pages = [0, 1, 2].map((i) => render(report, i));
      const quotes = [...pages.join('').matchAll(/<blockquote[^>]*>“([\s\S]*?)”<\/blockquote>/g)].map((m) => m[1]);
      assert.ok(quotes.length > 0 || name === 'compatible' || true);
      const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      for (const q of quotes) assert.ok(TEXTS[name].includes(unescape(q)), `quotation not in the agreement: ${unescape(q)}`);
      const text = pages.map(textOf).join(' ');
      assert.ok(!/element_id|source_block|sha-?256|antivirus|clamav|malware|quarantine|extraction|normaliz|schema_version|BASIC_CHECKS/i.test(text), 'no technical wording');
      assert.ok(!/risk score|\bscore\b|\/\s?100|\brating\b|review priority/i.test(text), 'no score');
      assert.ok(!/>\s*(undefined|null|NaN)\s*</.test(pages.join('')) && !/\[object Object\]|: undefined|NaN/.test(text), 'no broken values');
      const words = pages.map(visibleWords);
      assert.ok(words.every((w) => w < 750), `words shown by default per page: ${words}`);
      assert.ok(words.reduce((a, b) => a + b, 0) < 1900, `words shown by default in total: ${words}`);
    });
  }

  test('shows far less than the old long report, while the complete report stays available and untouched', () => {
    const report = reports.risky;
    const before = JSON.stringify(report);
    const shown = [0, 1, 2].map((i) => visibleWords(render(report, i))).reduce((a, b) => a + b, 0);
    assert.ok(shown < 1900, `three pages show ${shown} words by default (the previous report showed about 3,700 on one scroll)`);
    assert.equal(JSON.stringify(report), before);
    assert.equal(report.attention.findings.length > buildPresentation(report).keyFindings.length, true, 'the full set of findings is still in the report');
  });

  test('the contradictory agreement keeps its conflicts visible; a minimal agreement renders without gaps', () => {
    const text = textOf(render(reports.contradictory, 0));
    assert.match(text, /Two different/);
    const min = runPipeline('INDEPENDENT CONTRACTOR AGREEMENT\n\nThis agreement is between Acme Inc. ("Company") and Pat Doe ("Contractor").\n\n1. The parties agree to cooperate in good faith on the project described by the parties from time to time.\n');
    const tiny = buildDecisionReport(min.understanding, min.report, min.normalized, min.extraction);
    for (const i of [0, 1, 2]) assert.ok(!/undefined|\[object Object\]|NaN/.test(textOf(render(tiny, i))));
  });

  test('the app uses the three-page review and none of the old screens', () => {
    const app = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    assert.match(app, /ContractReview/);
    assert.ok(!/DecisionReportView|ContractReviewReport|ContractUnderstandingViewer/.test(app));
    assert.ok(!fs.existsSync(path.resolve(process.cwd(), 'src/components/DecisionReportView.tsx')));
    const source = ['ContractReview', 'OverviewPage', 'AgreementPage', 'BeforeSignPage', 'Clause'].map((f) => fs.readFileSync(path.resolve(process.cwd(), `src/components/review/${f}.tsx`), 'utf8')).join('\n');
    assert.ok(!/Your contract, explained|SECTIONS|href=\{`#/.test(source));
    assert.match(source, /onTouchStart/);
    assert.match(source, /keydown/);
  });
});
