import React, { useState } from 'react';
import type { Presentation } from '../../utils/reviewPresentation';
import { Clause } from './Clause';

const H2: React.FC<{ children: React.ReactNode }> = ({ children }) => <h2 className="text-lg font-semibold text-gray-900">{children}</h2>;

/** Page 3: what to do next: negotiate, ask, tick off, keep an eye on. */
export const BeforeSignPage: React.FC<{ p: Presentation; headingRef: React.Ref<HTMLHeadingElement> }> = ({ p, headingRef }) => {
  const { negotiate, questions, checklist, monitor } = p.next;
  const [done, setDone] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      <p className="text-sm text-gray-500">{p.name}</p>
      <h1 ref={headingRef} tabIndex={-1} className="mt-1 text-[28px] sm:text-4xl font-semibold tracking-tight text-gray-900 leading-tight outline-none">
        Before You Sign
      </h1>

      <section aria-labelledby="negotiate" className="mt-8">
        <H2><span id="negotiate">What should you negotiate?</span></H2>
        {negotiate.length === 0 ? (
          <p className="mt-3 text-[15px] text-gray-600">No changes stood out as worth asking for.</p>
        ) : (
          <ol className="mt-3 flex flex-col gap-4">
            {negotiate.map((n, i) => (
              <li key={n.id} className="flex gap-4">
                <span aria-hidden="true" className="w-5 shrink-0 pt-0.5 text-sm font-medium tabular-nums text-gray-400">{i + 1}</span>
                <div className="min-w-0 flex-1 text-[15px] leading-relaxed">
                  <p className="font-semibold text-gray-900">{n.heading}</p>
                  <p className="text-gray-700">{n.action}</p>
                  <Clause evidence={n.evidence} />
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {questions.length > 0 && (
        <section aria-labelledby="questions" className="mt-10 border-t border-gray-200 pt-7">
          <H2><span id="questions">Questions to ask</span></H2>
          <ul className="mt-3 flex flex-col gap-3.5 text-[15px] leading-relaxed text-gray-900">
            {questions.map((q) => (
              <li key={q.id}>
                {q.question}
                <Clause evidence={q.evidence} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {checklist.length > 0 && (
        <section aria-labelledby="checklist" className="mt-10 border-t border-gray-200 pt-7">
          <H2><span id="checklist">Your pre-signing checklist</span></H2>
          <ul className="mt-3 flex flex-col gap-1">
            {checklist.map((c) => (
              <li key={c.id}>
                <label className="flex cursor-pointer items-start gap-3 rounded-md py-2 text-[15px] leading-relaxed text-gray-900">
                  <input
                    type="checkbox"
                    checked={done.has(c.id)}
                    onChange={() => toggle(c.id)}
                    className="mt-1 h-[18px] w-[18px] shrink-0 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className={done.has(c.id) ? 'text-gray-400 line-through' : ''}>{c.text}</span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}

      {monitor.length > 0 && (
        <section aria-labelledby="monitor" className="mt-10 border-t border-gray-200 pt-7">
          <H2><span id="monitor">Things to monitor during the engagement</span></H2>
          <ul className="mt-3 flex flex-col gap-3 text-[15px] leading-relaxed">
            {monitor.map((m) => (
              <li key={m.id}>
                <span className="font-medium text-gray-900">{m.label}: </span>
                <span className="text-gray-700">{m.text}</span>
                <Clause evidence={m.evidence} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};
