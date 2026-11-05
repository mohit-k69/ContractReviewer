import React, { useState } from 'react';
import type {
  Commitment,
  DealItem,
  DecisionFinding,
  DecisionReport,
  ExtractedItem,
  ReportEvidence,
  Scenario,
  Statement,
} from '../server/decision/types';

/**
 * The Contract Decision Report, explained to a freelancer in plain English.
 *
 * Presentation only: everything shown comes from the backend DecisionReport. Nothing is regenerated, and no term, right
 * or risk is invented here. There is deliberately no overall score.
 */

// ---------------------------------------------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------------------------------------------

/** The exact wording of the agreement, with where it is. Collapsed by default so the report stays easy to scan. */
export const Clause: React.FC<{ evidence: ReportEvidence[]; label?: string }> = ({ evidence, label }) => {
  if (!evidence || evidence.length === 0) return null;
  const where = evidence[0].clause_label || evidence[0].reference;
  return (
    <details className="group mt-1.5 text-sm">
      <summary className="cursor-pointer select-none text-xs text-blue-700 hover:text-blue-800 list-none flex items-center gap-1">
        <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-90">›</span>
        <span>{label ?? 'See the exact wording'}{where ? ` · ${where}` : ''}</span>
      </summary>
      <div className="mt-2 flex flex-col gap-2.5">
        {evidence.map((e, i) => (
          <figure key={`${e.element_id}-${i}`} className="m-0">
            <blockquote className="border-l-2 border-gray-300 pl-3 text-[13px] leading-relaxed text-gray-800 italic">“{e.exact_quote}”</blockquote>
            <figcaption className="mt-1 pl-3 text-xs text-gray-500">{e.reference}</figcaption>
          </figure>
        ))}
      </div>
    </details>
  );
};

const STATUS_NOTE: Partial<Record<ExtractedItem['status'], string>> = {
  unclear: 'Not clearly stated in the agreement.',
  conflicting: 'Different parts of the agreement disagree on this.',
  not_found: 'Not stated in the agreement.',
  not_applicable: 'Does not apply to this agreement.',
};

const Fact: React.FC<{ label: string; item?: ExtractedItem; value?: string | null; showMissing?: boolean }> = ({ label, item, value, showMissing = true }) => {
  if (!item) return null;
  const missing = item.status === 'not_found' || item.status === 'not_applicable';
  if (missing && !showMissing) return null;
  const text = value !== undefined ? value : item.value;
  return (
    <div className="py-2.5 border-b border-gray-100 last:border-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-[15px] leading-relaxed text-gray-900">
        {missing ? (
          <span className="text-gray-500">{STATUS_NOTE[item.status]}</span>
        ) : (
          <>
            {text}
            {item.status !== 'explicit' && STATUS_NOTE[item.status] && (
              <span className={`block text-sm mt-0.5 ${item.status === 'conflicting' ? 'text-red-700' : 'text-amber-700'}`}>{STATUS_NOTE[item.status]}</span>
            )}
            <Clause evidence={item.evidence} />
          </>
        )}
      </dd>
    </div>
  );
};

const SubHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h3 className="text-base font-semibold text-gray-900 mt-7 mb-1.5 first:mt-0">{children}</h3>
);

const Muted: React.FC<{ children: React.ReactNode }> = ({ children }) => <p className="text-sm text-gray-500 leading-relaxed">{children}</p>;

const Section: React.FC<{ id: string; number: number; title: string; intro?: string; children: React.ReactNode }> = ({ id, number, title, intro, children }) => (
  <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6 pt-10 first:pt-0">
    <div className="flex items-baseline gap-3 border-b border-gray-200 pb-2.5 mb-4">
      <span aria-hidden="true" className="text-sm font-semibold text-blue-700 tabular-nums">{number}</span>
      <h2 id={`${id}-title`} className="text-xl sm:text-2xl font-semibold tracking-tight text-gray-900">{title}</h2>
    </div>
    {intro && <p className="text-[15px] text-gray-600 leading-relaxed mb-5">{intro}</p>}
    {children}
  </section>
);

export const SECTIONS = [
  { id: 'deal', title: 'Understand Your Deal' },
  { id: 'commitments', title: 'Your Commitments' },
  { id: 'attention', title: 'What Deserves Your Attention?' },
  { id: 'scenarios', title: 'What If Something Happens?' },
  { id: 'rights', title: 'Your Rights and Next Steps' },
] as const;

// ---------------------------------------------------------------------------------------------------------------
// 1. Understand Your Deal
// ---------------------------------------------------------------------------------------------------------------

const DealSection: React.FC<{ report: DecisionReport }> = ({ report }) => {
  const items = report.deal.items;
  const get = (id: string): DealItem | undefined => items.find((i) => i.id === id);
  const parties = items.filter((i) => i.id.startsWith('party.') && i.status !== 'not_found');
  const deliverables = get('engagement.description')?.structured?.deliverables ?? [];

  return (
    <Section id="deal" number={1} title="Understand Your Deal" intro="What this agreement is, who it is between, what you are expected to deliver, how long it runs and how you will be paid.">
      <SubHeading>Parties involved</SubHeading>
      <dl>
        {parties.length === 0 ? (
          <Muted>The agreement does not clearly name the parties.</Muted>
        ) : (
          parties.map((p) => <Fact key={p.id} label={p.party_role === 'client' ? 'Client' : p.party_role === 'freelancer' ? 'You (freelancer / contractor)' : p.title} item={p} />)
        )}
      </dl>

      <SubHeading>Type of agreement</SubHeading>
      <dl>
        <Fact label="Type" item={get('contract.type')} />
        <Fact label="Title" item={get('contract.name')} showMissing={false} />
        <Fact label="Governing law" item={get('legal.governing_law')} />
      </dl>

      <SubHeading>Services and deliverables</SubHeading>
      <dl>
        <Fact label="What you are asked to do" item={get('engagement.description')} />
      </dl>
      {deliverables.length > 0 && (
        <ul className="list-disc pl-5 mt-2 text-[15px] text-gray-900 leading-relaxed">
          {deliverables.map((d, i) => <li key={i}>{d}</li>)}
        </ul>
      )}

      <SubHeading>Contract duration</SubHeading>
      <dl>
        <Fact label="Start date" item={get('timeline.start_date')} />
        <Fact label="Length of the agreement" item={get('timeline.duration')} />
        <Fact label="End date" item={get('timeline.end_date')} />
        <Fact label="Renewal" item={get('renewal.terms')} />
        <Fact label="Ending the agreement early" item={get('termination.notice')} showMissing={false} />
        <Fact label="Your right to end it" item={get('termination.contractor_right')} showMissing={false} />
      </dl>

      <SubHeading>Fees and payment terms</SubHeading>
      <dl>
        <Fact label="Your pay" item={get('money.compensation')} />
        <Fact label="How you are paid" item={get('money.payment_structure')} showMissing={false} />
        <Fact label="Currency" item={get('money.currency')} showMissing={false} />
        <Fact label="When payment is due" item={get('invoicing.payment_deadline')} />
        <Fact label="Invoicing" item={get('invoicing.invoice_requirements')} showMissing={false} />
        <Fact label="Milestones" item={get('invoicing.milestones')} showMissing={false} />
        <Fact label="Conditions for being paid" item={get('invoicing.payment_conditions')} showMissing={false} />
        <Fact label="Late payment" item={get('invoicing.late_payment')} />
        <Fact label="Expenses" item={get('money.expenses')} showMissing={false} />
        <Fact label="Taxes" item={get('money.tax')} showMissing={false} />
        <Fact label="Payment when the agreement ends" item={get('termination.payment_on_termination')} showMissing={false} />
      </dl>
    </Section>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// 2. Your Commitments
// ---------------------------------------------------------------------------------------------------------------

const CommitmentList: React.FC<{ items: Commitment[]; empty: string; prefix?: (c: Commitment) => string | null }> = ({ items, empty, prefix }) =>
  items.length === 0 ? (
    <Muted>{empty}</Muted>
  ) : (
    <ul className="divide-y divide-gray-100">
      {items.map((c) => (
        <li key={c.id} className="py-2.5">
          <p className="text-[15px] leading-relaxed text-gray-900">
            <span className="font-medium">{prefix?.(c) ? `${prefix(c)} ` : ''}{c.title}</span>
            {c.value && <span className="text-gray-700"> — {c.value}</span>}
          </p>
          {c.status === 'conflicting' && <p className="text-sm text-red-700">Different parts of the agreement disagree on this.</p>}
          {c.status === 'unclear' && <p className="text-sm text-amber-700">Not clearly stated in the agreement.</p>}
          <Clause evidence={c.evidence} />
        </li>
      ))}
    </ul>
  );

const CommitmentsSection: React.FC<{ report: DecisionReport }> = ({ report }) => {
  const mine = report.commitments.freelancer.flatMap((g) => g.items);
  const theirs = report.commitments.client.flatMap((g) => g.items);
  const notStated = report.commitments.not_stated;
  return (
    <Section id="commitments" number={2} title="Your Commitments" intro="What each side has agreed to do, must not do, and is allowed to do, as the agreement states it. Anything the agreement does not say is not assumed.">
      <SubHeading>What you must do</SubHeading>
      <CommitmentList items={mine.filter((c) => c.nature === 'duty')} empty="The agreement does not clearly list duties for you." />

      <SubHeading>What you cannot do</SubHeading>
      <CommitmentList items={mine.filter((c) => c.nature === 'restriction')} empty="The agreement does not place specific restrictions on you." />

      <SubHeading>What the client must do</SubHeading>
      <CommitmentList items={theirs.filter((c) => c.nature !== 'allowance')} empty="The agreement does not clearly list duties for the client." />
      {notStated.filter((n) => n.party === 'client').length > 0 && (
        <p className="mt-2 text-sm text-gray-500">
          Not stated in the agreement: {notStated.filter((n) => n.party === 'client').map((n) => n.title.toLowerCase()).join('; ')}.
        </p>
      )}

      <SubHeading>What each party is allowed to do</SubHeading>
      <CommitmentList
        items={[...mine.filter((c) => c.nature === 'allowance'), ...theirs.filter((c) => c.nature === 'allowance')]}
        empty="The agreement does not spell out specific permissions."
        prefix={(c) => (c.party === 'freelancer' ? 'You may:' : 'The client may:')}
      />
      {notStated.filter((n) => n.party === 'freelancer').length > 0 && (
        <p className="mt-2 text-sm text-gray-500">
          For you, the agreement does not state: {notStated.filter((n) => n.party === 'freelancer').map((n) => n.title.toLowerCase()).join('; ')}.
        </p>
      )}
    </Section>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// 3. What Deserves Your Attention?
// ---------------------------------------------------------------------------------------------------------------

const FindingCard: React.FC<{ f: DecisionFinding }> = ({ f }) => {
  const important = f.priority === 'high';
  const missing = f.type === 'missing';
  return (
    <details className={`group rounded-lg border bg-white ${important ? 'border-red-200 border-l-4 border-l-red-500' : 'border-gray-200'}`}>
      <summary className="cursor-pointer select-none list-none px-4 py-3 flex items-start gap-2">
        <span aria-hidden="true" className="mt-0.5 text-gray-400 transition-transform group-open:rotate-90">›</span>
        <span className="flex-1">
          <span className="block text-[15px] font-medium text-gray-900 leading-snug">{f.title}</span>
          {important && <span className="block text-xs font-semibold text-red-700 mt-0.5">Important</span>}
          <span className="block text-sm text-gray-500 mt-0.5 leading-snug">
            {missing ? 'The agreement does not address this.' : f.contract_position.text}
          </span>
        </span>
      </summary>
      <div className="px-4 pb-4 pl-9 flex flex-col gap-3.5 text-[15px] leading-relaxed text-gray-800">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">What the agreement says</h4>
          <p>
            {missing ? 'The agreement does not address this.' : f.contract_position.text}
            {missing && f.relevance?.reason ? ` ${f.relevance.reason}` : ''}
          </p>
          {!missing && f.contract_position.basis === 'unclear' && <p className="text-sm text-amber-700">This part of the agreement is unclear.</p>}
        </div>
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Why it matters to you</h4>
          <p>{f.impact}</p>
        </div>
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">The clause</h4>
          {f.evidence.length > 0 ? (
            <div className="flex flex-col gap-2.5 mt-1">
              {f.evidence.map((e, i) => (
                <figure key={`${e.element_id}-${i}`} className="m-0">
                  <blockquote className="border-l-2 border-gray-300 pl-3 text-[13px] leading-relaxed text-gray-800 italic">“{e.exact_quote}”</blockquote>
                  <figcaption className="mt-1 pl-3 text-xs text-gray-500">{e.reference}</figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <p className="text-gray-500">{missing ? 'There is no clause on this, which is the issue.' : 'No exact wording could be confirmed.'}</p>
          )}
        </div>
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">What to clarify or negotiate</h4>
          <p>{f.recommended_action}</p>
          {f.illustrative_alternative && (
            <p className="text-sm text-gray-600 mt-1">
              <span className="font-medium">Example to discuss</span> (a suggestion, not a standard or a term of your agreement): {f.illustrative_alternative}
            </p>
          )}
        </div>
        {f.confidence.level === 'Low' && f.uncertainty && <p className="text-sm text-gray-500">We are less certain about this one. {f.uncertainty}</p>}
      </div>
    </details>
  );
};

const AttentionSection: React.FC<{ report: DecisionReport }> = ({ report }) => {
  const findings = report.attention.findings;
  const of = (type: DecisionFinding['type']) => findings.filter((f) => f.type === type);
  const important = findings.filter((f) => f.priority === 'high').length;
  const groups: Array<[string, DecisionFinding['type'], string]> = [
    ['Important contract risks', 'risk', 'No specific risks were found in the wording of the agreement.'],
    ['Missing protections', 'missing', 'No missing protections that matter for this agreement were found.'],
    ['Ambiguous terms', 'ambiguous', 'No unclear terms were found.'],
    ['Contradictory clauses', 'contradictory', 'No clauses that contradict each other were found.'],
  ];
  return (
    <Section
      id="attention"
      number={3}
      title="What Deserves Your Attention?"
      intro={
        findings.length === 0
          ? 'Nothing in this agreement stood out as needing a closer look.'
          : `${findings.length} ${findings.length === 1 ? 'point' : 'points'} worth a closer look before you sign${important ? `, ${important} marked Important` : ''}. Each one shows what the agreement says, why it matters, the exact clause, and what to raise.`
      }
    >
      {groups.map(([title, type, empty]) => (
        <div key={type}>
          <SubHeading>{title}</SubHeading>
          {of(type).length === 0 ? (
            <Muted>{empty}</Muted>
          ) : (
            <div className="flex flex-col gap-2.5">{of(type).map((f) => <FindingCard key={f.id} f={f} />)}</div>
          )}
        </div>
      ))}
    </Section>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// 4. What If Something Happens?
// ---------------------------------------------------------------------------------------------------------------

const SCENARIO_ORDER = [
  'scenario.late_payment',
  'scenario.scope_changes',
  'scenario.deliverable_rejected',
  'scenario.client_ends_early',
  'scenario.you_want_to_end',
  'scenario.dispute',
  'scenario.liability_claim',
];

const StatementLine: React.FC<{ s: Statement }> = ({ s }) => (
  <li className="leading-relaxed">
    <span className={s.basis === 'not_in_contract' ? 'text-gray-500' : s.basis === 'conflicting' ? 'text-red-800' : 'text-gray-900'}>{s.text}</span>
    {s.basis === 'unclear' && <span className="text-amber-700"> (unclear)</span>}
    {s.basis === 'conflicting' && <span className="text-red-700"> (the agreement contradicts itself)</span>}
    <Clause evidence={s.evidence} />
  </li>
);

const ScenarioCard: React.FC<{ s: Scenario }> = ({ s }) => {
  const uncertain = s.potential_outcome.uncertain.filter((u) => u.basis !== 'outside_contract');
  return (
    <details className="group rounded-lg border border-gray-200 bg-white">
      <summary className="cursor-pointer select-none list-none px-4 py-3 flex items-start gap-2">
        <span aria-hidden="true" className="mt-0.5 text-gray-400 transition-transform group-open:rotate-90">›</span>
        <span>
          <span className="block text-[15px] font-medium text-gray-900">{s.scenario}</span>
          <span className="block text-sm text-gray-500">{s.situation}</span>
        </span>
      </summary>
      <div className="px-4 pb-4 pl-9 flex flex-col gap-3.5 text-[15px] text-gray-800">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Why this applies to your agreement</h4>
          <p>{s.trigger.reason}</p>
          <Clause evidence={s.trigger.evidence} />
        </div>
        {s.contract_position.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">What the agreement says</h4>
            <ul className="list-disc pl-5 mt-0.5 flex flex-col gap-1.5">{s.contract_position.map((p, i) => <StatementLine key={i} s={p} />)}</ul>
          </div>
        )}
        {(s.potential_outcome.contractual.length > 0 || uncertain.length > 0) && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">What this could mean for you</h4>
            <ul className="list-disc pl-5 mt-0.5 flex flex-col gap-1.5">
              {s.potential_outcome.contractual.map((p, i) => <StatementLine key={`c${i}`} s={p} />)}
              {uncertain.map((p, i) => <StatementLine key={`u${i}`} s={p} />)}
            </ul>
          </div>
        )}
        {s.missing_protections.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">What the agreement leaves out</h4>
            <ul className="list-disc pl-5 mt-0.5 flex flex-col gap-1.5">{s.missing_protections.map((p, i) => <StatementLine key={i} s={p} />)}</ul>
          </div>
        )}
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">What you can do</h4>
          <p>{s.recommended_action.text}</p>
          {s.recommended_action.illustrative_alternative && (
            <p className="text-sm text-gray-600 mt-1"><span className="font-medium">Example to discuss</span> (a suggestion, not a standard): {s.recommended_action.illustrative_alternative}</p>
          )}
        </div>
      </div>
    </details>
  );
};

const ScenariosSection: React.FC<{ report: DecisionReport }> = ({ report }) => {
  const rank = (id: string) => (SCENARIO_ORDER.includes(id) ? SCENARIO_ORDER.indexOf(id) : SCENARIO_ORDER.length);
  const scenarios = [...report.scenarios].sort((a, b) => rank(a.id) - rank(b.id));
  return (
    <Section id="scenarios" number={4} title="What If Something Happens?" intro="Practical situations, shown only where your agreement actually has something to say about them.">
      {scenarios.length === 0 ? (
        <Muted>The agreement does not contain provisions that point to specific situations to plan for.</Muted>
      ) : (
        <div className="flex flex-col gap-2.5">{scenarios.map((s) => <ScenarioCard key={s.id} s={s} />)}</div>
      )}
      <p className="mt-4 text-sm text-gray-500">Rights you may have under the law, outside this agreement, are not covered here.</p>
    </Section>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// 5. Your Rights and Next Steps
// ---------------------------------------------------------------------------------------------------------------

const HOLDER: Record<string, string> = {
  freelancer: 'Your right',
  client_owes_you: 'The client owes you this',
  either_party: 'Either party',
};

const RightsSection: React.FC<{ report: DecisionReport }> = ({ report }) => {
  const { rights, questions, checklist, outside_contract_note } = report.rights_and_next_steps;
  const [done, setDone] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Section id="rights" number={5} title="Your Rights and Next Steps" intro="What the agreement gives you, what to ask before you sign, and what to keep an eye on afterwards.">
      <SubHeading>Rights stated in the agreement</SubHeading>
      {rights.length === 0 ? (
        <Muted>No specific rights for you were identified in the agreement.</Muted>
      ) : (
        <ul className="divide-y divide-gray-100">
          {rights.map((r) => (
            <li key={r.id} className="py-3">
              <p className="text-[15px] font-medium text-gray-900">{r.title}</p>
              <p className="text-xs text-gray-500">{HOLDER[r.holder] ?? r.holder}</p>
              <p className="mt-1 text-[15px] text-gray-800 leading-relaxed">{r.statement}</p>
              {r.notice_period && <p className="mt-1 text-sm text-gray-700"><span className="font-medium">Notice:</span> {r.notice_period.text}</p>}
              {r.conditions.length > 0 && (
                <p className="mt-1 text-sm text-gray-700"><span className="font-medium">Conditions:</span> {r.conditions.map((c) => `“${c}”`).join('; ')}</p>
              )}
              {r.limitations.length > 0 && (
                <p className="mt-1 text-sm text-gray-700"><span className="font-medium">Limits:</span> {r.limitations.map((c) => `“${c}”`).join('; ')}</p>
              )}
              <Clause evidence={r.evidence} />
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-sm text-gray-500">{outside_contract_note}</p>

      <SubHeading>Questions to ask before signing</SubHeading>
      {questions.length === 0 ? (
        <Muted>No open questions came up.</Muted>
      ) : (
        <ol className="list-decimal pl-5 flex flex-col gap-3 text-[15px] text-gray-900 leading-relaxed marker:text-gray-400">
          {questions.map((q) => (
            <li key={q.id}>
              <span className="font-medium">{q.question}</span>
              {q.suggested_change && <span className="block text-sm text-gray-600">What to ask for: {q.suggested_change}</span>}
              <Clause evidence={q.contract_reference} />
            </li>
          ))}
        </ol>
      )}

      <SubHeading>Pre-signing checklist</SubHeading>
      {checklist.before_signing.length === 0 ? (
        <Muted>Nothing specific to check before signing.</Muted>
      ) : (
        <ul className="flex flex-col gap-2">
          {checklist.before_signing.map((c) => (
            <li key={c.id}>
              <label className="flex items-start gap-2.5 text-[15px] leading-relaxed text-gray-900 cursor-pointer">
                <input type="checkbox" checked={done.has(c.id)} onChange={() => toggle(c.id)} className="mt-1.5 h-4 w-4 shrink-0 rounded border-gray-300 text-blue-600" />
                <span className={done.has(c.id) ? 'text-gray-400 line-through' : ''}>{c.text}</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <SubHeading>Things to monitor during the engagement</SubHeading>
      {checklist.during_engagement.length === 0 ? (
        <Muted>Nothing specific to monitor was identified.</Muted>
      ) : (
        <ul className="divide-y divide-gray-100">
          {checklist.during_engagement.map((m) => (
            <li key={m.id} className="py-2.5">
              <p className="text-[15px] text-gray-900 leading-relaxed">{m.text}</p>
              <p className="text-xs text-gray-500">
                Applies to: {m.applies_to}
                {m.date ? ` · ${m.date}${m.calculated ? ' (calculated from the dates in the agreement; please confirm)' : ''}` : ''}
              </p>
              <Clause evidence={m.evidence} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------------------------

export const DecisionReportView: React.FC<{ report: DecisionReport }> = ({ report }) => {
  const type = report.deal.items.find((i) => i.id === 'contract.type');
  return (
    <article className="w-full max-w-3xl text-gray-900" aria-label="Contract review">
      <header className="mb-8">
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Your contract, explained</h1>
        <p className="mt-1.5 text-[15px] text-gray-600">
          {type?.value ? `${type.value}. ` : ''}A plain-English review of what this agreement says and what to raise before you sign.
        </p>
        <nav aria-label="Report sections" className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {SECTIONS.map((s, i) => (
            <a key={s.id} href={`#${s.id}`} className="text-blue-700 hover:text-blue-800 hover:underline underline-offset-2">
              <span className="text-gray-400 tabular-nums mr-1">{i + 1}</span>{s.title}
            </a>
          ))}
        </nav>
      </header>

      <div className="flex flex-col">
        <DealSection report={report} />
        <CommitmentsSection report={report} />
        <AttentionSection report={report} />
        <ScenariosSection report={report} />
        <RightsSection report={report} />
      </div>

      <footer className="mt-12 pt-5 border-t border-gray-200 text-sm text-gray-500 leading-relaxed">
        <p>{report.disclaimer}</p>
        {report.limitations.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-blue-700 hover:text-blue-800">What this review can’t tell you</summary>
            <ul className="mt-2 list-disc pl-5 flex flex-col gap-1">{report.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
          </details>
        )}
      </footer>
    </article>
  );
};
