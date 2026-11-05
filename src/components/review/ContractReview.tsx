import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import type { DecisionReport } from '../../server/decision/types';
import { buildPresentation, clampPage, PAGE_COUNT, PAGE_TITLES, pageKeyAction, swipeDirection } from '../../utils/reviewPresentation';
import { OverviewPage } from './OverviewPage';
import { AgreementPage } from './AgreementPage';
import { BeforeSignPage } from './BeforeSignPage';

interface Props {
  report: DecisionReport;
  /** Used as the heading only if the report holds no reliable contract name */
  fileName?: string;
  initialPage?: number;
}

/**
 * The three-page review. Only one page is shown at a time; the complete Decision Report stays in `report` and is
 * never changed. Pages turn with the arrow buttons, the left and right arrow keys, or a horizontal swipe. Vertical
 * scrolling inside a page is never affected: swipes must be clearly horizontal, and the page declares `touch-action: pan-y`.
 */
export const ContractReview: React.FC<Props> = ({ report, fileName, initialPage = 0 }) => {
  const presentation = useMemo(() => buildPresentation(report, fileName), [report, fileName]);
  const [page, setPage] = useState(clampPage(initialPage));
  const headingRef = useRef<HTMLHeadingElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const touch = useRef<{ x: number; y: number; t: number } | null>(null);
  const first = useRef(true);

  const go = (delta: -1 | 1): void => setPage((p) => clampPage(p + delta));

  // After a page change: start at the top of the new page and move focus to its heading (keyboard and screen readers)
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const top = articleRef.current ? articleRef.current.getBoundingClientRect().top + window.scrollY - 16 : 0;
    window.scrollTo({ top: Math.max(0, top) });
    headingRef.current?.focus({ preventScroll: true });
  }, [page]);

  // Left and right arrow keys, except while typing or using a form control
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return;
      const dir = pageKeyAction(e.key, e.target as HTMLElement | null, { alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey });
      if (dir !== 0) go(dir);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onTouchStart = (e: React.TouchEvent): void => {
    const t = e.touches[0];
    const inQuote = (e.target as HTMLElement).closest('[data-no-swipe]');
    touch.current = e.touches.length === 1 && t && !inQuote ? { x: t.clientX, y: t.clientY, t: Date.now() } : null;
  };
  const onTouchEnd = (e: React.TouchEvent): void => {
    const start = touch.current;
    touch.current = null;
    const t = e.changedTouches[0];
    if (!start || !t) return;
    const dir = swipeDirection(start, { x: t.clientX, y: t.clientY, t: Date.now() });
    if (dir !== 0) go(dir);
  };

  const label = `${PAGE_TITLES[page]}, page ${page + 1} of ${PAGE_COUNT}`;

  return (
    <article ref={articleRef} className="flex w-full max-w-3xl flex-col text-gray-900" aria-label="Contract review">
      <p className="sr-only" role="status" aria-live="polite">{label}</p>

      {/* Only the current page is rendered. touch-action: pan-y keeps vertical scrolling native. */}
      <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} onTouchCancel={() => (touch.current = null)} style={{ touchAction: 'pan-y' }} className="min-h-[60vh] pb-10">
        {page === 0 && <OverviewPage p={presentation} headingRef={headingRef} />}
        {page === 1 && <AgreementPage p={presentation} headingRef={headingRef} />}
        {page === 2 && <BeforeSignPage p={presentation} headingRef={headingRef} />}
      </div>

      <nav
        aria-label="Review pages"
        className="sticky bottom-0 z-10 -mx-6 border-t border-gray-200 bg-white/95 px-6 pt-3 backdrop-blur supports-[backdrop-filter]:bg-white/80 sm:mx-0 sm:px-0"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        <div className="flex items-center justify-end gap-4">
          <span className="text-sm tabular-nums text-gray-500" data-testid="page-indicator">{page + 1} of {PAGE_COUNT}</span>
          {page > 0 && (
            <button
              type="button"
              onClick={() => go(-1)}
              aria-label={`Previous page: ${PAGE_TITLES[page - 1]}`}
              className="inline-flex h-12 w-12 cursor-pointer items-center justify-center rounded-full border border-gray-300 bg-white text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              <ArrowLeft className="h-5 w-5" aria-hidden="true" />
            </button>
          )}
          {page < PAGE_COUNT - 1 ? (
            <button
              type="button"
              onClick={() => go(1)}
              aria-label={`Next page: ${PAGE_TITLES[page + 1]}`}
              className="inline-flex h-12 min-w-[7rem] cursor-pointer items-center justify-center gap-2 rounded-full bg-blue-600 px-6 text-[15px] font-medium text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              <span>Next</span>
              <ArrowRight className="h-5 w-5" aria-hidden="true" />
            </button>
          ) : (
            <span className="inline-flex h-12 items-center gap-2 px-2 text-[15px] font-medium text-gray-600" data-testid="end-of-review">
              <Check className="h-5 w-5 text-emerald-600" aria-hidden="true" />
              End of review
            </span>
          )}
        </div>
      </nav>
    </article>
  );
};
