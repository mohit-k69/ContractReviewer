import React from 'react';
import type { Presentation } from '../../utils/reviewPresentation';
import { Clause } from './Clause';

/** Page 1: the agreement name, what to know before signing (3 to 5 findings), and the key terms. */
export const OverviewPage: React.FC<{ p: Presentation; headingRef: React.Ref<HTMLHeadingElement> }> = ({ p, headingRef }) => (
  <div>
    <h1 ref={headingRef} tabIndex={-1} className="text-[28px] sm:text-4xl font-semibold tracking-tight text-gray-900 leading-tight outline-none">
      {p.name}
    </h1>

    <section aria-labelledby="know-before-signing" className="mt-9">
      <h2 id="know-before-signing" className="text-lg font-semibold text-gray-900">What you should know before signing</h2>
      {p.keyFindings.length === 0 ? (
        <p className="mt-3 text-[15px] text-gray-600">Nothing in this agreement stood out as a concern.</p>
      ) : (
        <ol className="mt-2 divide-y divide-gray-200">
          {p.keyFindings.map((f, i) => (
            <li key={f.id} className="flex gap-4 py-6 first:pt-4">
              <span aria-hidden="true" className="w-5 shrink-0 pt-0.5 text-sm font-medium tabular-nums text-gray-400">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <h3 className="text-[18px] font-semibold leading-snug text-gray-900">{f.heading}</h3>
                <p className="mt-1.5 text-[15px] leading-relaxed text-gray-700">{f.says}</p>
                <p className="mt-3 text-[15px] leading-relaxed text-gray-900">
                  <span className="font-semibold">Why it matters. </span>
                  <span className="text-gray-700">{f.why}</span>
                </p>
                <p className="mt-2 text-[15px] leading-relaxed text-gray-900">
                  <span className="font-semibold text-blue-800">What to do. </span>
                  <span className="text-gray-700">{f.action}</span>
                </p>
                <Clause evidence={f.evidence} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>

    {p.keyTerms.length > 0 && (
      <section aria-labelledby="key-terms" className="mt-10 border-t border-gray-200 pt-7">
        <h2 id="key-terms" className="text-lg font-semibold text-gray-900">Key terms</h2>
        <dl className="mt-4 grid grid-cols-1 gap-x-10 gap-y-5 sm:grid-cols-2">
          {p.keyTerms.map((t) => (
            <div key={`${t.id}-${t.label}`} className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">{t.label}</dt>
              <dd className="mt-1 text-[15px] leading-relaxed text-gray-900">
                <span className={t.text.startsWith('Not stated') ? 'text-gray-500' : ''}>{t.text}</span>
                {t.note === 'unclear' && <span className="block text-sm text-amber-700">Not clearly stated.</span>}
                {t.note === 'conflicting' && <span className="block text-sm text-red-700">The agreement contradicts itself here.</span>}
                <Clause evidence={t.evidence} />
              </dd>
            </div>
          ))}
        </dl>
      </section>
    )}
  </div>
);
