import React from 'react';
import type { ReportEvidence } from '../../server/decision/types';

/**
 * "See clause": the exact wording of the agreement and where it is, collapsed by default so the page stays short.
 * Quotations are shown exactly as the report holds them (word for word).
 */
export const Clause: React.FC<{ evidence: ReportEvidence[]; label?: string }> = ({ evidence, label = 'See clause' }) => {
  if (!evidence || evidence.length === 0) return null;
  const where = evidence[0].clause_label || evidence[0].reference;
  return (
    <details className="group mt-2">
      <summary className="inline-flex cursor-pointer select-none list-none items-center gap-1.5 text-sm text-blue-700 hover:text-blue-800 [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="inline-block text-xs transition-transform group-open:rotate-90">▸</span>
        <span>{label}{where ? <span className="text-gray-400"> · {where}</span> : null}</span>
      </summary>
      <div className="mt-2.5 flex flex-col gap-3" data-no-swipe="">
        {evidence.map((e, i) => (
          <figure key={`${e.element_id}-${i}`} className="m-0">
            <blockquote className="border-l-2 border-gray-300 pl-3.5 text-[14px] leading-relaxed text-gray-800 italic">“{e.exact_quote}”</blockquote>
            <figcaption className="mt-1 pl-3.5 text-xs text-gray-500">{e.reference}</figcaption>
          </figure>
        ))}
      </div>
    </details>
  );
};
