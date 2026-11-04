import React, { useState } from 'react';
import {
  FileText,
  CheckCircle2,
  AlertTriangle,
  Building2,
  User,
  Calendar,
  DollarSign,
  Briefcase,
  Shield,
  FileQuestion,
  HelpCircle,
  ExternalLink,
  ChevronRight,
  Info,
  Scale,
  Sparkles,
} from 'lucide-react';
import {
  ContractUnderstandingResult,
  EvidenceReference,
  FactWithEvidence,
} from '../server/understanding/types';

interface ContractUnderstandingViewerProps {
  result: ContractUnderstandingResult;
  onViewSourceElement?: (elementId: string) => void;
}

export const ContractUnderstandingViewer: React.FC<ContractUnderstandingViewerProps> = ({
  result,
  onViewSourceElement,
}) => {
  const [activeTab, setActiveTab] = useState<
    'overview' | 'parties' | 'commercial' | 'scope' | 'provisions' | 'omissions'
  >('overview');

  const [inspectedEvidence, setInspectedEvidence] = useState<{
    factTitle: string;
    evidence: EvidenceReference;
  } | null>(null);

  const stats = result.stats || {
    total_facts: 0,
    verified_facts: 0,
    verification_percentage: 100,
    total_evidence_references: 0,
    verified_evidence_references: 0,
  };

  const isVerifiedHigh = stats.verification_percentage >= 90;

  return (
    <div className="flex flex-col gap-3 w-full text-left">
      {/* Partial Coverage Warning Banner */}
      {result.processing_status === 'PARTIAL' && (
        <div className="p-3 rounded-xl border border-amber-300 bg-amber-50 flex items-start gap-2.5 text-xs text-amber-900 shadow-xs">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="flex flex-col gap-0.5">
            <span className="font-semibold">Partial Document Coverage ({result.coverage_percentage || 0}%)</span>
            <span>
              Only {result.processed_sections?.length || 0} of {result.total_sections_in_document || 0} sections were analyzed.
              Unprocessed sections may contain crucial terms or exceptions. Omissions cannot be confirmed without complete coverage.
            </span>
          </div>
        </div>
      )}

      {/* Deterministic Fallback Notice Banner */}
      {result.analysis_source === 'DETERMINISTIC_FALLBACK' && (
        <div className="p-3 rounded-xl border border-blue-200 bg-blue-50/70 flex items-start gap-2.5 text-xs text-blue-900 shadow-xs">
          <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
          <div className="flex flex-col gap-0.5">
            <span className="font-semibold">Deterministic Baseline Engine (Fallback Mode)</span>
            <span>
              Analysis was performed using the deterministic rule engine because Gemini processing was unavailable or encountered a schema mismatch.
              Factual extraction and evidence references remain strictly verified against source blocks.
            </span>
          </div>
        </div>
      )}

      {/* Header card with classification and stats */}
      <div className="p-4 rounded-xl border border-gray-200 bg-white shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-gray-100">
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span
                className={`text-[11px] font-semibold tracking-wide uppercase px-2 py-0.5 rounded ${
                  result.processing_status === 'PARTIAL'
                    ? 'text-amber-800 bg-amber-100'
                    : result.analysis_source === 'DETERMINISTIC_FALLBACK'
                    ? 'text-blue-800 bg-blue-100'
                    : 'text-indigo-700 bg-indigo-50'
                }`}
              >
                {result.processing_status === 'PARTIAL'
                  ? 'Partial Analysis'
                  : result.analysis_source === 'DETERMINISTIC_FALLBACK'
                  ? 'Deterministic Baseline'
                  : 'AI-Analyzed • Complete'}
              </span>
              <span className="text-[11px] text-gray-500 font-mono">
                {result.model_used}
              </span>
            </div>
            <h2 className="text-base font-semibold text-gray-900 mt-1">
              {result.classification?.category || 'Contract Understanding'}
            </h2>
          </div>

          {/* Verification Badge */}
          <div className="flex items-center gap-2">
            <div
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border ${
                isVerifiedHigh
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : 'bg-amber-50 text-amber-700 border-amber-200'
              }`}
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>{stats.verification_percentage}% Verbatim Evidence Match</span>
            </div>
          </div>
        </div>

        {/* Primary Purpose */}
        {result.classification?.primary_purpose && (
          <p className="text-xs text-gray-600 mt-2.5 leading-relaxed">
            {result.classification.primary_purpose}
          </p>
        )}

        {/* Navigation Tabs */}
        <div className="flex flex-wrap gap-1 mt-3 pt-3 border-t border-gray-100">
          {[
            { id: 'overview', label: 'Overview & Dates', icon: Calendar },
            { id: 'parties', label: 'Parties', icon: Building2 },
            { id: 'commercial', label: 'Commercial & Rates', icon: DollarSign },
            { id: 'scope', label: 'Scope & Deliverables', icon: Briefcase },
            { id: 'provisions', label: 'Key Provisions', icon: Scale },
            {
              id: 'omissions',
              label: `Omissions (${result.omissions_and_missing_terms?.length || 0})`,
              icon: FileQuestion,
            },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                  isActive
                    ? 'bg-gray-900 text-white shadow-xs'
                    : 'bg-gray-50 text-gray-700 hover:bg-gray-100'
                }`}
              >
                <Icon className="w-3 h-3" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab Content Panes */}
      <div className="flex flex-col gap-2.5">
        {/* TAB 1: OVERVIEW & DATES */}
        {activeTab === 'overview' && (
          <div className="flex flex-col gap-2.5">
            <FactCard
              title="Governing Jurisdiction & Law"
              fact={result.classification?.governing_jurisdiction}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Governing Jurisdiction', evidence: ref })
              }
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              <FactCard
                title="Effective Date"
                fact={result.dates_and_term?.effective_date}
                onInspectEvidence={(ref) =>
                  setInspectedEvidence({ factTitle: 'Effective Date', evidence: ref })
                }
              />
              <FactCard
                title="Term Duration / Expiration"
                fact={result.dates_and_term?.term_duration}
                onInspectEvidence={(ref) =>
                  setInspectedEvidence({ factTitle: 'Term Duration', evidence: ref })
                }
              />
              <FactCard
                title="Renewal Terms"
                fact={result.dates_and_term?.renewal_terms}
                onInspectEvidence={(ref) =>
                  setInspectedEvidence({ factTitle: 'Renewal Terms', evidence: ref })
                }
              />
              <FactCard
                title="Execution Date"
                fact={result.dates_and_term?.execution_date}
                onInspectEvidence={(ref) =>
                  setInspectedEvidence({ factTitle: 'Execution Date', evidence: ref })
                }
              />
            </div>
          </div>
        )}

        {/* TAB 2: PARTIES */}
        {activeTab === 'parties' && (
          <div className="flex flex-col gap-2.5">
            {result.parties && result.parties.length > 0 ? (
              result.parties.map((party, idx) => (
                <div
                  key={idx}
                  className="p-3.5 rounded-xl border border-gray-200 bg-white flex flex-col gap-2 shadow-xs"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 rounded-md bg-gray-100 text-gray-700">
                        {party.role === 'Client' ? (
                          <Building2 className="w-4 h-4" />
                        ) : (
                          <User className="w-4 h-4" />
                        )}
                      </div>
                      <div>
                        <div className="text-xs font-semibold text-gray-900">
                          {party.name}
                        </div>
                        <div className="text-[11px] text-gray-500">
                          Role: <span className="font-medium text-gray-700">{party.role}</span> • Defined as{' '}
                          <span className="font-mono text-indigo-600">"{party.defined_term}"</span>
                        </div>
                      </div>
                    </div>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-gray-100 text-gray-600">
                      {party.legal_entity_type || 'Entity'}
                    </span>
                  </div>

                  {party.address_or_location && (
                    <div className="text-[11px] text-gray-600">
                      <span className="text-gray-400">Address/Location: </span>
                      {party.address_or_location}
                    </div>
                  )}

                  {party.evidence && party.evidence.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-2 border-t border-gray-100">
                      {party.evidence.map((ref, rIdx) => (
                        <EvidenceBadge
                          key={rIdx}
                          reference={ref}
                          onClick={() =>
                            setInspectedEvidence({
                              factTitle: `Party: ${party.name}`,
                              evidence: ref,
                            })
                          }
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className="p-4 text-center text-xs text-gray-500 bg-gray-50 rounded-xl">
                No contracting parties identified.
              </div>
            )}
          </div>
        )}

        {/* TAB 3: COMMERCIAL & RATES */}
        {activeTab === 'commercial' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            <FactCard
              title="Fee Structure & Pricing"
              fact={result.payment_and_commercial?.fee_structure}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Fee Structure', evidence: ref })
              }
            />
            <FactCard
              title="Rates & Amounts"
              fact={result.payment_and_commercial?.rates_and_amounts}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Rates & Amounts', evidence: ref })
              }
            />
            <FactCard
              title="Invoicing Cadence"
              fact={result.payment_and_commercial?.invoicing_schedule}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Invoicing Cadence', evidence: ref })
              }
            />
            <FactCard
              title="Payment Terms (Net Days)"
              fact={result.payment_and_commercial?.payment_terms_days}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Payment Terms', evidence: ref })
              }
            />
            <FactCard
              title="Late Payment Penalty & Interest"
              fact={result.payment_and_commercial?.late_payment_terms}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Late Payment Terms', evidence: ref })
              }
            />
            <FactCard
              title="Reimbursable Expenses"
              fact={result.payment_and_commercial?.reimbursable_expenses}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Reimbursable Expenses', evidence: ref })
              }
            />
            <FactCard
              title="Taxes & Withholding"
              fact={result.payment_and_commercial?.taxes_and_withholding}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Taxes & Withholding', evidence: ref })
              }
            />
          </div>
        )}

        {/* TAB 4: SCOPE & DELIVERABLES */}
        {activeTab === 'scope' && (
          <div className="flex flex-col gap-2.5">
            <FactCard
              title="Scope of Services Description"
              fact={result.scope_and_deliverables?.scope_description}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Scope Description', evidence: ref })
              }
            />

            <FactCard
              title="Change Order Mechanism"
              fact={result.scope_and_deliverables?.change_order_mechanism}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Change Orders', evidence: ref })
              }
            />

            <FactCard
              title="Acceptance Criteria & Inspection Period"
              fact={result.scope_and_deliverables?.acceptance_criteria}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Acceptance Criteria', evidence: ref })
              }
            />

            {result.scope_and_deliverables?.deliverables &&
              result.scope_and_deliverables.deliverables.length > 0 && (
                <div className="p-3.5 rounded-xl border border-gray-200 bg-white flex flex-col gap-2 shadow-xs">
                  <div className="text-xs font-semibold text-gray-900">
                    Specified Deliverables & Milestones (
                    {result.scope_and_deliverables.deliverables.length})
                  </div>
                  <div className="flex flex-col gap-2 mt-1">
                    {result.scope_and_deliverables.deliverables.map((del, dIdx) => (
                      <div
                        key={dIdx}
                        className="p-2.5 rounded-lg bg-gray-50 border border-gray-100 flex flex-col gap-1.5"
                      >
                        <div className="text-xs text-gray-800">{del.summary}</div>
                        {del.evidence && del.evidence.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {del.evidence.map((ref, rIdx) => (
                              <EvidenceBadge
                                key={rIdx}
                                reference={ref}
                                onClick={() =>
                                  setInspectedEvidence({
                                    factTitle: `Deliverable ${dIdx + 1}`,
                                    evidence: ref,
                                  })
                                }
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
          </div>
        )}

        {/* TAB 5: KEY PROVISIONS */}
        {activeTab === 'provisions' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            <FactCard
              title="IP Ownership / Work Made for Hire"
              fact={result.key_provisions?.intellectual_property?.ownership}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'IP Ownership', evidence: ref })
              }
            />
            <FactCard
              title="Pre-Existing IP / Background Rights"
              fact={result.key_provisions?.intellectual_property?.pre_existing_ip}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Pre-Existing IP', evidence: ref })
              }
            />
            <FactCard
              title="Confidentiality Definition"
              fact={result.key_provisions?.confidentiality?.definition}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Confidentiality Definition', evidence: ref })
              }
            />
            <FactCard
              title="Confidentiality Survival Period"
              fact={result.key_provisions?.confidentiality?.duration}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Confidentiality Duration', evidence: ref })
              }
            />
            <FactCard
              title="Non-Compete Restrictions"
              fact={result.key_provisions?.non_compete}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Non-Compete', evidence: ref })
              }
            />
            <FactCard
              title="Non-Solicitation"
              fact={result.key_provisions?.non_solicitation}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Non-Solicitation', evidence: ref })
              }
            />
            <FactCard
              title="Termination for Convenience"
              fact={result.key_provisions?.termination?.termination_for_convenience}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Termination for Convenience', evidence: ref })
              }
            />
            <FactCard
              title="Termination for Cause & Cure"
              fact={result.key_provisions?.termination?.termination_for_cause}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Termination for Cause', evidence: ref })
              }
            />
            <FactCard
              title="Post-Termination Compensation"
              fact={result.key_provisions?.termination?.post_termination_payment}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Post-Termination Compensation', evidence: ref })
              }
            />
            <FactCard
              title="Liability Cap"
              fact={result.key_provisions?.limitation_of_liability?.liability_cap}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Liability Cap', evidence: ref })
              }
            />
            <FactCard
              title="Exclusion of Consequential Damages"
              fact={result.key_provisions?.limitation_of_liability?.exclusion_of_indirect_damages}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Indirect Damages Exclusion', evidence: ref })
              }
            />
            <FactCard
              title="Contractor Indemnification"
              fact={result.key_provisions?.indemnification?.contractor_indemnification}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Contractor Indemnification', evidence: ref })
              }
            />
            <FactCard
              title="Dispute Resolution Method"
              fact={result.key_provisions?.dispute_resolution?.method}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Dispute Resolution', evidence: ref })
              }
            />
            <FactCard
              title="Independent Contractor Affirmation"
              fact={result.key_provisions?.independent_contractor_affirmation}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({
                  factTitle: 'Independent Contractor Affirmation',
                  evidence: ref,
                })
              }
            />
            <FactCard
              title="Entire Agreement / Integration Clause"
              fact={result.key_provisions?.entire_agreement}
              onInspectEvidence={(ref) =>
                setInspectedEvidence({ factTitle: 'Entire Agreement', evidence: ref })
              }
            />
          </div>
        )}

        {/* TAB 6: OMISSIONS & MISSING TERMS */}
        {activeTab === 'omissions' && (
          <div className="flex flex-col gap-2.5">
            {result.omissions_and_missing_terms &&
            result.omissions_and_missing_terms.length > 0 ? (
              result.omissions_and_missing_terms.map((om, idx) => (
                <div
                  key={idx}
                  className="p-3.5 rounded-xl border border-amber-200 bg-amber-50/40 flex flex-col gap-1.5 shadow-xs"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                      Not Found in Document
                    </span>
                    <span className="text-xs font-semibold text-gray-900">
                      {om.provision_name}
                    </span>
                  </div>
                  <p className="text-xs text-gray-700 leading-relaxed">{om.explanation}</p>
                </div>
              ))
            ) : (
              <div className="p-4 text-center text-xs text-gray-500 bg-gray-50 rounded-xl">
                No notable omitted terms identified.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Verbatim Evidence Inspection Modal / Bottom Sheet */}
      {inspectedEvidence && (
        <div
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setInspectedEvidence(null)}
        >
          <div
            className="w-full max-w-lg bg-white rounded-2xl shadow-xl border border-gray-200 p-5 flex flex-col gap-3.5 text-left animate-in fade-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2 border-b border-gray-100 pb-3">
              <div>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">
                  Verbatim Source Evidence
                </span>
                <h3 className="text-sm font-semibold text-gray-900 mt-1">
                  {inspectedEvidence.factTitle}
                </h3>
              </div>
              <button
                onClick={() => setInspectedEvidence(null)}
                className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 cursor-pointer text-xs"
              >
                ✕
              </button>
            </div>

            {/* Verification State */}
            <div
              className={`p-2.5 rounded-lg flex items-center gap-2 text-xs font-medium border ${
                inspectedEvidence.evidence.is_verified === true
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                  : 'bg-rose-50 text-rose-800 border-rose-200'
              }`}
            >
              {inspectedEvidence.evidence.is_verified === true ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>Verified Substring in Original Extracted Document</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>
                    Unverified Quote:{' '}
                    {inspectedEvidence.evidence.verification_error ||
                      'Could not confirm substring in referenced block'}
                  </span>
                </>
              )}
            </div>

            {/* Verbatim Quote */}
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-gray-500">Exact Quote:</span>
              <div className="p-3 rounded-lg bg-gray-50 border border-gray-200 text-xs text-gray-900 font-serif leading-relaxed italic border-l-4 border-l-indigo-500">
                "{inspectedEvidence.evidence.exact_quote}"
              </div>
            </div>

            {/* Structural Provenance */}
            <div className="grid grid-cols-2 gap-2 text-[11px] bg-gray-50 p-2.5 rounded-lg border border-gray-200 font-mono text-gray-600">
              <div>
                <span className="text-gray-400">Element ID: </span>
                <span className="font-semibold text-indigo-700">
                  {inspectedEvidence.evidence.element_id}
                </span>
              </div>
              <div>
                <span className="text-gray-400">Source Block: </span>
                <span className="font-semibold text-purple-700">
                  {inspectedEvidence.evidence.source_block_id}
                </span>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setInspectedEvidence(null)}
                className="px-4 py-1.5 rounded-lg bg-gray-900 text-white text-xs font-medium hover:bg-gray-800 cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface FactCardProps {
  title: string;
  fact?: FactWithEvidence;
  onInspectEvidence: (ref: EvidenceReference) => void;
}

const FactCard: React.FC<FactCardProps> = ({ title, fact, onInspectEvidence }) => {
  if (!fact) {
    return (
      <div className="p-3.5 rounded-xl border border-gray-200 bg-white flex flex-col gap-1 shadow-xs opacity-70">
        <div className="text-xs font-semibold text-gray-700">{title}</div>
        <div className="text-xs text-gray-400 italic">Not evaluated</div>
      </div>
    );
  }

  const isFound = fact.status === 'FOUND';
  const isNotFound = fact.status === 'NOT_FOUND';
  const isAmbiguous = fact.status === 'AMBIGUOUS' || fact.status === 'CONFLICTING';

  return (
    <div
      className={`p-3.5 rounded-xl border bg-white flex flex-col justify-between gap-2 shadow-xs transition-all ${
        isNotFound
          ? 'border-gray-200 bg-gray-50/40'
          : isAmbiguous
          ? 'border-amber-200 bg-amber-50/20'
          : 'border-gray-200'
      }`}
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-gray-900">{title}</span>
          <span
            className={`text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded ${
              isFound
                ? 'bg-emerald-50 text-emerald-700'
                : isNotFound
                ? 'bg-gray-100 text-gray-500'
                : 'bg-amber-100 text-amber-800'
            }`}
          >
            {fact.status}
          </span>
        </div>
        <p
          className={`text-xs leading-relaxed ${
            isNotFound ? 'text-gray-400 italic' : 'text-gray-700'
          }`}
        >
          {fact.summary}
        </p>
      </div>

      {fact.evidence && fact.evidence.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-2 border-t border-gray-100">
          {fact.evidence.map((ref, idx) => (
            <EvidenceBadge key={idx} reference={ref} onClick={() => onInspectEvidence(ref)} />
          ))}
        </div>
      )}
    </div>
  );
};

interface EvidenceBadgeProps {
  reference: EvidenceReference;
  onClick: () => void;
}

const EvidenceBadge: React.FC<EvidenceBadgeProps> = ({ reference, onClick }) => {
  const isVerified = reference.is_verified === true;
  return (
    <button
      onClick={onClick}
      title={`Element: ${reference.element_id} | Block: ${reference.source_block_id}${
        !isVerified ? ` (Unverified: ${reference.verification_error || 'Quote verification failed'})` : ' (Verified)'
      }`}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono border transition-all cursor-pointer ${
        isVerified
          ? 'bg-emerald-50/60 text-emerald-700 border-emerald-200 hover:bg-emerald-100/70'
          : 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100'
      }`}
    >
      {isVerified ? (
        <CheckCircle2 className="w-2.5 h-2.5 shrink-0 text-emerald-600" />
      ) : (
        <AlertTriangle className="w-2.5 h-2.5 shrink-0 text-rose-600" />
      )}
      <span>{reference.element_id || 'Ref'}</span>
      <ExternalLink className="w-2.5 h-2.5 opacity-60" />
    </button>
  );
};
