import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  FileQuestion,
  GitCompareArrows,
  Info,
  ListChecks,
  Quote,
  ShieldAlert,
  ShieldCheck,
  Lightbulb,
} from 'lucide-react';
import {
  ChecklistItem,
  ContractRiskReport,
  FindingEvidence,
  FindingKind,
  IndicatorLevel,
  RiskFinding,
  RiskSeverity,
} from '../server/risk/types';

interface ContractReviewReportProps {
  report: ContractRiskReport;
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

const SEVERITY_STYLE: Record<RiskSeverity, { chip: string; bar: string; label: string }> = {
  High: { chip: 'bg-red-50 text-red-800 border-red-200', bar: 'border-l-red-500', label: 'High' },
  Medium: { chip: 'bg-amber-50 text-amber-900 border-amber-200', bar: 'border-l-amber-500', label: 'Medium' },
  Low: { chip: 'bg-sky-50 text-sky-800 border-sky-200', bar: 'border-l-sky-400', label: 'Low' },
};

const LEVEL_STYLE: Record<IndicatorLevel, string> = {
  High: 'bg-red-50 text-red-800 border-red-200',
  Medium: 'bg-amber-50 text-amber-900 border-amber-200',
  Low: 'bg-sky-50 text-sky-800 border-sky-200',
  None: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  'Not assessed': 'bg-gray-100 text-gray-600 border-gray-200',
};

const KIND_META: Record<FindingKind, { label: string; plural: string; chip: string; icon: React.ElementType }> = {
  RISK: {
    label: 'Contract risk',
    plural: 'Contract risks',
    chip: 'bg-red-50 text-red-800 border-red-200',
    icon: ShieldAlert,
  },
  MISSING_PROVISION: {
    label: 'Missing provision',
    plural: 'Missing provisions',
    chip: 'bg-violet-50 text-violet-800 border-violet-200',
    icon: CircleDashed,
  },
  AMBIGUOUS_TERM: {
    label: 'Ambiguous term',
    plural: 'Ambiguous terms',
    chip: 'bg-amber-50 text-amber-900 border-amber-200',
    icon: FileQuestion,
  },
  CONTRADICTORY_PROVISIONS: {
    label: 'Contradictory provisions',
    plural: 'Contradictory provisions',
    chip: 'bg-rose-50 text-rose-800 border-rose-200',
    icon: GitCompareArrows,
  },
};

const KIND_ORDER: FindingKind[] = ['RISK', 'CONTRADICTORY_PROVISIONS', 'MISSING_PROVISION', 'AMBIGUOUS_TERM'];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

function Chip({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-semibold ${className}`}>
      {children}
    </span>
  );
}

/** Shows the clause text with the verified quote highlighted. */
function ClauseExcerpt({ evidence }: { evidence: FindingEvidence }) {
  const text = evidence.clause_text && evidence.clause_text.includes(evidence.exact_quote)
    ? evidence.clause_text
    : evidence.exact_quote;
  const idx = text.indexOf(evidence.exact_quote);
  const before = idx > 0 ? text.slice(0, idx) : '';
  const after = idx >= 0 ? text.slice(idx + evidence.exact_quote.length) : '';
  return (
    <figure className="rounded-lg border border-gray-200 bg-gray-50/80 p-3 text-left">
      <figcaption className="flex items-start gap-1.5 text-[11px] font-semibold text-gray-700">
        <Quote className="w-3.5 h-3.5 mt-0.5 shrink-0 text-gray-400" aria-hidden="true" />
        <span>{evidence.clause_label || 'Contract text'}</span>
      </figcaption>
      <blockquote className="mt-1.5 text-xs leading-relaxed text-gray-800 whitespace-pre-wrap break-words">
        {before}
        <mark className="bg-yellow-100 text-gray-900 rounded px-0.5">{evidence.exact_quote}</mark>
        {after}
      </blockquote>
      <div className="mt-1.5 font-mono text-[10px] text-gray-400">
        {evidence.element_id} · {evidence.source_block_id}
      </div>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Finding card
// ---------------------------------------------------------------------------

function FindingCard({ finding, defaultOpen }: { finding: RiskFinding; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const sev = SEVERITY_STYLE[finding.severity];
  const kind = KIND_META[finding.kind];
  const KindIcon = kind.icon;

  return (
    <article
      id={`finding-${slug(finding.id)}`}
      className={`rounded-xl border border-gray-200 border-l-4 ${sev.bar} bg-white shadow-xs scroll-mt-4`}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full text-left p-3.5 flex items-start gap-3 cursor-pointer"
      >
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip className={sev.chip}>{sev.label} priority</Chip>
            <Chip className={kind.chip}>
              <KindIcon className="w-3 h-3" aria-hidden="true" />
              {kind.label}
            </Chip>
            <span className="text-[11px] text-gray-500">{finding.category}</span>
          </div>
          <h3 className="mt-1.5 text-sm font-semibold text-gray-900 leading-snug">{finding.title}</h3>
          {!open && <p className="mt-1 text-xs text-gray-600 line-clamp-2">{finding.explanation}</p>}
        </div>
        {open ? (
          <ChevronUp className="w-4 h-4 mt-1 text-gray-400 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronDown className="w-4 h-4 mt-1 text-gray-400 shrink-0" aria-hidden="true" />
        )}
      </button>

      {open && (
        <div className="px-3.5 pb-3.5 flex flex-col gap-3 text-left">
          <p className="text-xs text-gray-800 leading-relaxed">{finding.explanation}</p>

          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Why it matters to you</div>
            <p className="mt-0.5 text-xs text-gray-700 leading-relaxed">{finding.why_it_matters}</p>
          </div>

          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              {finding.kind === 'MISSING_PROVISION' ? 'Contract text' : 'What the contract says'}
            </div>
            {finding.evidence.length > 0 ? (
              <div className="mt-1 flex flex-col gap-2">
                {finding.evidence.map((e, i) => (
                  <ClauseExcerpt key={`${e.element_id}-${i}`} evidence={e} />
                ))}
              </div>
            ) : (
              <p className="mt-1 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-2.5 text-xs text-gray-600">
                {finding.evidence_note || 'No supporting contract text is available.'}
              </p>
            )}
          </div>

          <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-blue-800">
              <Lightbulb className="w-3.5 h-3.5" aria-hidden="true" />
              Ask or negotiate
            </div>
            <p className="mt-0.5 text-xs text-blue-950 leading-relaxed">{finding.suggestion}</p>
          </div>

          <div className="flex flex-col gap-1 text-[11px] text-gray-600">
            <div>
              <span className="font-semibold text-gray-700">Confidence: {finding.confidence.level}.</span>{' '}
              {finding.confidence.reasons.join(' ')}
            </div>
            {finding.uncertainty && (
              <div>
                <span className="font-semibold text-gray-700">Uncertainty:</span> {finding.uncertainty}
              </div>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Main report
// ---------------------------------------------------------------------------

export const ContractReviewReport: React.FC<ContractReviewReportProps> = ({ report }) => {
  const { overview, findings, analysis } = report;
  const [kindFilter, setKindFilter] = useState<FindingKind | 'ALL'>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  const visible = useMemo(
    () =>
      findings.filter(
        (f) => (kindFilter === 'ALL' || f.kind === kindFilter) && (!categoryFilter || f.category === categoryFilter)
      ),
    [findings, kindFilter, categoryFilter]
  );

  const doneCount = report.checklist.filter((c) => checked[c.id]).length;
  const priority = SEVERITY_STYLE[overview.review_priority];
  const parties = report.parties;

  const jumpTo = (findingId: string) => {
    setKindFilter('ALL');
    setCategoryFilter(null);
    setTimeout(() => {
      document.getElementById(`finding-${slug(findingId)}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);
  };

  return (
    <div className="flex flex-col gap-4 w-full text-left" data-testid="review-report">
      {/* 1. Contract overview + overall indicator */}
      <section aria-labelledby="overview-heading" className="rounded-xl border border-gray-200 bg-white p-4 shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Contract review report</div>
            <h2 id="overview-heading" className="text-base font-semibold text-gray-900 mt-0.5">
              {report.contract_type}
            </h2>
            {parties.length > 0 && (
              <p className="mt-1 text-xs text-gray-600">
                {parties.map((p, i) => (
                  <span key={`${p.name}-${i}`}>
                    {i > 0 && ' · '}
                    <span className="font-medium text-gray-800">{p.name}</span> ({p.role})
                  </span>
                ))}
              </p>
            )}
          </div>

          <div className={`rounded-xl border px-3.5 py-2 text-center ${priority.chip}`} aria-label="Overall review priority">
            <div className="text-[10px] font-semibold uppercase tracking-wide opacity-80">Review priority</div>
            <div className="text-lg font-bold leading-tight">{overview.review_priority}</div>
          </div>
        </div>

        <ul className="mt-3 flex flex-col gap-1 text-xs text-gray-700 list-disc pl-4">
          {overview.rationale.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-gray-500">{overview.rule}</p>

        <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
          <Chip className="bg-gray-50 text-gray-700 border-gray-200">
            {analysis.analysis_source === 'GEMINI' ? `AI analysis (${analysis.model_used})` : 'Built-in rule engine'}
          </Chip>
          <Chip className="bg-gray-50 text-gray-700 border-gray-200">{analysis.coverage_percentage}% of document analyzed</Chip>
          <Chip
            className={
              analysis.evidence_verification_percentage >= 90
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                : 'bg-amber-50 text-amber-900 border-amber-200'
            }
          >
            <ShieldCheck className="w-3 h-3" aria-hidden="true" />
            {analysis.evidence_verification_percentage}% evidence verified word-for-word
          </Chip>
        </div>

        {!analysis.missing_provisions_assessed && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900" role="alert">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" aria-hidden="true" />
            <span>
              Only part of the document was analyzed, so missing provisions were not assessed and the priority above is a
              minimum.
            </span>
          </div>
        )}
      </section>

      {/* 2. Overall risk indicators */}
      <section aria-labelledby="indicators-heading">
        <h2 id="indicators-heading" className="text-sm font-semibold text-gray-900 mb-2">Risk indicators by area</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2">
          {overview.category_indicators.map((c) => {
            const active = categoryFilter === c.category;
            return (
              <button
                key={c.category}
                type="button"
                onClick={() => setCategoryFilter(active ? null : c.category)}
                aria-pressed={active}
                className={`text-left rounded-xl border p-2.5 bg-white transition-colors cursor-pointer hover:border-blue-300 ${
                  active ? 'border-blue-400 ring-1 ring-blue-200' : 'border-gray-200'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs font-semibold text-gray-900 leading-snug">{c.category}</span>
                  <Chip className={LEVEL_STYLE[c.level]}>{c.level}</Chip>
                </div>
                <p className="mt-1 text-[11px] text-gray-500">{c.summary}</p>
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-600">
          {KIND_ORDER.map((k) => (
            <span key={k}>
              <span className="font-semibold text-gray-800">{overview.counts_by_kind[k]}</span> {KIND_META[k].plural.toLowerCase()}
            </span>
          ))}
        </div>
      </section>

      {/* 3 & 4. Prioritised findings with exact supporting clauses */}
      <section aria-labelledby="findings-heading">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <h2 id="findings-heading" className="text-sm font-semibold text-gray-900">
            Prioritised findings ({visible.length}
            {visible.length !== findings.length ? ` of ${findings.length}` : ''})
          </h2>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Filter findings by type">
            {(['ALL', ...KIND_ORDER] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKindFilter(k)}
                aria-pressed={kindFilter === k}
                className={`px-2.5 h-7 rounded-full border text-[11px] font-medium cursor-pointer transition-colors ${
                  kindFilter === k
                    ? 'border-blue-400 bg-blue-50 text-blue-700'
                    : 'border-gray-200 bg-white text-gray-600 hover:text-gray-900'
                }`}
              >
                {k === 'ALL' ? 'All' : KIND_META[k].plural}
              </button>
            ))}
            {categoryFilter && (
              <button
                type="button"
                onClick={() => setCategoryFilter(null)}
                className="px-2.5 h-7 rounded-full border border-gray-300 bg-gray-50 text-[11px] text-gray-700 cursor-pointer"
              >
                {categoryFilter} ✕
              </button>
            )}
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="rounded-xl border border-gray-200 bg-white p-4 text-xs text-gray-600 flex items-start gap-2">
            <Info className="w-4 h-4 text-gray-400 shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              {findings.length === 0
                ? 'No review rule was triggered by the terms found in this document. That does not mean the contract is risk-free.'
                : 'No findings match the current filter.'}
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {visible.map((f, i) => (
              <FindingCard key={f.id} finding={f} defaultOpen={f.severity === 'High' && i < 3} />
            ))}
          </div>
        )}
      </section>

      {/* 5. Key contract terms */}
      <section aria-labelledby="terms-heading" className="rounded-xl border border-gray-200 bg-white p-4 shadow-xs">
        <h2 id="terms-heading" className="text-sm font-semibold text-gray-900 mb-2">Key contract terms</h2>
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2.5">
          {report.key_terms.map((t) => (
            <div key={t.label} className="border-b border-gray-100 pb-2">
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{t.label}</dt>
              <dd className={`mt-0.5 text-xs leading-relaxed ${t.status === 'NOT_FOUND' ? 'text-gray-400 italic' : 'text-gray-800'}`}>
                {t.value}
                {(t.status === 'AMBIGUOUS' || t.status === 'CONFLICTING') && (
                  <span className="ml-1.5 text-[10px] font-semibold text-amber-700">
                    ({t.status === 'CONFLICTING' ? 'conflicting' : 'unclear'})
                  </span>
                )}
              </dd>
              {t.evidence[0]?.clause_label && (
                <div className="text-[10px] text-gray-400 mt-0.5">{t.evidence[0].clause_label}</div>
              )}
            </div>
          ))}
        </dl>
      </section>

      {/* 6. Missing, ambiguous and conflicting provisions at a glance */}
      <section aria-labelledby="gaps-heading" className="rounded-xl border border-gray-200 bg-white p-4 shadow-xs">
        <h2 id="gaps-heading" className="text-sm font-semibold text-gray-900">Missing, ambiguous and conflicting provisions</h2>
        <p className="text-[11px] text-gray-500 mt-0.5 mb-3">
          These are different things: missing provisions have no contract text to cite, ambiguous terms are vague, and
          contradictory provisions disagree with each other.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {(['MISSING_PROVISION', 'AMBIGUOUS_TERM', 'CONTRADICTORY_PROVISIONS'] as FindingKind[]).map((k) => {
            const items = findings.filter((f) => f.kind === k);
            const meta = KIND_META[k];
            const Icon = meta.icon;
            return (
              <div key={k} className="rounded-lg border border-gray-200 p-2.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-800">
                  <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                  {meta.plural} ({items.length})
                </div>
                {items.length === 0 ? (
                  <p className="mt-1.5 text-[11px] text-gray-500">None identified.</p>
                ) : (
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {items.map((f) => (
                      <li key={f.id}>
                        <button
                          type="button"
                          onClick={() => jumpTo(f.id)}
                          className="text-left text-[11px] text-blue-700 hover:underline cursor-pointer"
                        >
                          {f.title}
                        </button>
                        <span className="text-[10px] text-gray-400"> · {f.severity}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* 7. Before-you-sign checklist */}
      <section aria-labelledby="checklist-heading" className="rounded-xl border border-gray-200 bg-white p-4 shadow-xs">
        <div className="flex items-center justify-between gap-2 mb-2">
          <h2 id="checklist-heading" className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
            <ListChecks className="w-4 h-4 text-blue-600" aria-hidden="true" />
            Before you sign
          </h2>
          <span className="text-[11px] text-gray-500">
            {doneCount} of {report.checklist.length} done
          </span>
        </div>
        <ul className="flex flex-col gap-1.5">
          {report.checklist.map((c: ChecklistItem) => (
            <li key={c.id} className="flex items-start gap-2.5">
              <input
                id={`check-${c.id}`}
                type="checkbox"
                checked={Boolean(checked[c.id])}
                onChange={(e) => setChecked({ ...checked, [c.id]: e.target.checked })}
                className="mt-0.5 w-4 h-4 accent-blue-600 cursor-pointer"
              />
              <label htmlFor={`check-${c.id}`} className="flex-1 text-xs text-gray-800 leading-relaxed cursor-pointer">
                <Chip className={`${SEVERITY_STYLE[c.priority].chip} mr-1.5`}>{c.priority}</Chip>
                <span className={checked[c.id] ? 'line-through text-gray-400' : ''}>{c.text}</span>
                {c.finding_id && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      jumpTo(c.finding_id!);
                    }}
                    className="ml-1.5 text-[11px] text-blue-700 hover:underline cursor-pointer"
                  >
                    View finding
                  </button>
                )}
              </label>
            </li>
          ))}
        </ul>
      </section>

      {/* Limitations & disclaimer */}
      <section aria-labelledby="limits-heading" className="rounded-xl border border-gray-200 bg-gray-50 p-4">
        <h2 id="limits-heading" className="text-xs font-semibold text-gray-800 flex items-center gap-1.5">
          <Info className="w-3.5 h-3.5" aria-hidden="true" />
          Limitations
        </h2>
        <ul className="mt-1.5 list-disc pl-4 flex flex-col gap-1 text-[11px] text-gray-600">
          {report.limitations.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] font-medium text-gray-700">{report.disclaimer}</p>
      </section>
    </div>
  );
};
