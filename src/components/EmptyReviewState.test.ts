import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyReviewState } from './EmptyReviewState';

test.describe('empty state on the right', () => {
  test('is a decorative illustration with a short, friendly message and no technical wording', () => {
    const html = renderToStaticMarkup(createElement(EmptyReviewState, {}));
    assert.match(html, /<svg[^>]*aria-hidden="true"/, 'the picture is decorative');
    assert.match(html, /Your review will appear here/);
    assert.match(html, /Add your contract on the left/);
    assert.ok(!/undefined|antivirus|security|scan|upload (error|failed)/i.test(html.replace(/<[^>]+>/g, ' ')));
    assert.ok(!/animate-pulse/.test(html), 'calm while idle');
  });

  test('changes to a calm "reading" state while a file is being reviewed', () => {
    const html = renderToStaticMarkup(createElement(EmptyReviewState, { busy: true }));
    assert.match(html, /Reading your agreement/);
    assert.match(html, /animate-pulse/);
    assert.match(html, /role="status"/);
  });

  test('is shown only until there is a review, and the report replaces it', () => {
    const app = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    assert.match(app, /\{!decisionReport && \(\s*<section[^>]*hidden[^>]*lg:flex/);
    assert.match(app, /\{decisionReport && \(\s*<section[^>]*aria-label="Contract review report"/);
  });

  test('the idle motion is switched off for people who prefer reduced motion', () => {
    const css = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
    assert.match(css, /prefers-reduced-motion: reduce[\s\S]*animation: none/);
  });
});
