import React from 'react';
import type { CategoryView, Presentation } from '../../utils/reviewPresentation';
import { Clause } from './Clause';

const Category: React.FC<{ c: CategoryView }> = ({ c }) => {
  const wording = c.facts.flatMap((f) => f.evidence);
  // the same clause can support several facts; show each wording once
  const unique = wording.filter((e, i) => wording.findIndex((x) => x.element_id === e.element_id && x.exact_quote === e.exact_quote) === i);
  return (
    <section aria-labelledby={`cat-${c.id}`} className="py-6 first:pt-2">
      <h3 id={`cat-${c.id}`} className="text-[18px] font-semibold text-gray-900">{c.title}</h3>
      <p className="mt-1 text-sm text-gray-500">{c.blurb}</p>

      {c.facts.length > 0 && (
        <dl className="mt-3 flex flex-col gap-2.5">
          {c.facts.map((f) => (
            <div key={f.id} className="text-[15px] leading-relaxed">
              <dt className="inline font-medium text-gray-900">{f.label}: </dt>
              <dd className="inline text-gray-700">
                <span className={f.text.startsWith('Not stated') ? 'text-gray-500' : ''}>{f.text}</span>
                {f.note === 'unclear' && <span className="text-amber-700"> (not clearly stated)</span>}
                {f.note === 'conflicting' && <span className="text-red-700"> (the agreement contradicts itself)</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {c.consequences.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5 text-[15px] leading-relaxed text-gray-700">
          {c.consequences.map((x) => (
            <li key={x.title}><span className="font-medium text-gray-900">If this happens — {x.title.charAt(0).toLowerCase() + x.title.slice(1)}: </span>{x.text}</li>
          ))}
        </ul>
      )}

      {c.coveredOnPage1.length > 0 && (
        <p className="mt-3 text-sm text-gray-500">Main concern explained on page 1: {c.coveredOnPage1.join('; ')}.</p>
      )}

      {unique.length > 0 && <Clause evidence={unique} label="See contract wording" />}
    </section>
  );
};

/** Page 2: only the contract terms that matter, by topic, with the exact wording one click away. */
export const AgreementPage: React.FC<{ p: Presentation; headingRef: React.Ref<HTMLHeadingElement> }> = ({ p, headingRef }) => (
  <div>
    <p className="text-sm text-gray-500">{p.name}</p>
    <h1 ref={headingRef} tabIndex={-1} className="mt-1 text-[28px] sm:text-4xl font-semibold tracking-tight text-gray-900 leading-tight outline-none">
      Understand Your Agreement
    </h1>
    {p.categories.length === 0 ? (
      <p className="mt-6 text-[15px] text-gray-600">No further contract terms were identified.</p>
    ) : (
      <div className="mt-6 divide-y divide-gray-200">{p.categories.map((c) => <Category key={c.id} c={c} />)}</div>
    )}
  </div>
);
