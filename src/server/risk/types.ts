import { EvidenceStatus } from '../understanding/types';

export type RiskSeverity = 'High' | 'Medium' | 'Low';

export type RiskCategory =
  | 'Payment'
  | 'Scope of Work'
  | 'Termination'
  | 'Intellectual Property'
  | 'Liability & Indemnification'
  | 'Confidentiality'
  | 'Non-Compete, Exclusivity & Non-Solicitation'
  | 'Dispute Resolution & Governing Law';

export const RISK_CATEGORIES: RiskCategory[] = [
  'Payment',
  'Scope of Work',
  'Termination',
  'Intellectual Property',
  'Liability & Indemnification',
  'Confidentiality',
  'Non-Compete, Exclusivity & Non-Solicitation',
  'Dispute Resolution & Governing Law',
];

/**
 * What kind of finding this is. The four kinds are always kept distinct:
 *  - RISK                    : a provision IS in the contract and is unfavourable / unusual for the contractor
 *  - MISSING_PROVISION       : a protective provision was searched for and NOT found (never has evidence)
 *  - AMBIGUOUS_TERM          : a provision exists but is vague or incomplete
 *  - CONTRADICTORY_PROVISIONS: two provisions are incompatible (carried over from Phase 2C)
 */
export type FindingKind =
  | 'RISK'
  | 'MISSING_PROVISION'
  | 'AMBIGUOUS_TERM'
  | 'CONTRADICTORY_PROVISIONS';

export type ConfidenceLevel = 'High' | 'Medium' | 'Low';

/** A verified quote from the contract. Only references that passed Phase 2C verification are ever included. */
export interface FindingEvidence {
  element_id: string;
  source_block_id: string;
  exact_quote: string;
  /** Human-readable clause reference, e.g. "Section 5. Termination › 5.1 Termination for Convenience" */
  clause_label?: string;
  /** Full text of the supporting clause (the quote is a verbatim substring of this) */
  clause_text?: string;
}

export interface FindingConfidence {
  level: ConfidenceLevel;
  /** Plain-language reasons the level was chosen */
  reasons: string[];
}

export interface RiskFinding {
  /** Stable, deterministic id: `<rule_id>` (one finding per rule per document) */
  id: string;
  rule_id: string;
  category: RiskCategory;
  kind: FindingKind;
  severity: RiskSeverity;
  title: string;
  /** Plain-language explanation of what the contract says (or fails to say) */
  explanation: string;
  /** Why it matters to the contractor */
  why_it_matters: string;
  /** Verified supporting clauses. ALWAYS empty for MISSING_PROVISION. */
  evidence: FindingEvidence[];
  /** Explains the (lack of) evidence, e.g. what was searched for a missing provision */
  evidence_note?: string;
  /** Practical question to ask or negotiation suggestion */
  suggestion: string;
  confidence: FindingConfidence;
  /** What we are not sure about, if anything */
  uncertainty?: string;
}

export interface KeyTerm {
  label: string;
  value: string;
  status: EvidenceStatus;
  evidence: FindingEvidence[];
}

export type IndicatorLevel = 'High' | 'Medium' | 'Low' | 'None' | 'Not assessed';

export interface CategoryIndicator {
  category: RiskCategory;
  level: IndicatorLevel;
  summary: string;
  finding_ids: string[];
}

export interface ChecklistItem {
  id: string;
  priority: RiskSeverity;
  text: string;
  finding_id?: string;
  category?: RiskCategory;
}

export interface RiskOverview {
  /** Highest severity among all findings. Derived by the explicit rule in `rule`, not a numeric score. */
  review_priority: RiskSeverity;
  rule: string;
  rationale: string[];
  counts_by_severity: Record<RiskSeverity, number>;
  counts_by_kind: Record<FindingKind, number>;
  category_indicators: CategoryIndicator[];
}

export interface AnalysisContext {
  analysis_source: 'GEMINI' | 'DETERMINISTIC_FALLBACK';
  model_used: string;
  processing_status: 'COMPLETE' | 'PARTIAL' | 'FAILED';
  coverage_percentage: number;
  evidence_verification_percentage: number;
  /** Missing-provision findings are only produced when the whole document was analyzed */
  missing_provisions_assessed: boolean;
}

export interface ContractRiskReport {
  document_id: string;
  source_file_id: string;
  verified_sha256: string;
  contract_type: string;
  generated_at: string;
  parties: Array<{ name: string; role: string; defined_term: string }>;
  overview: RiskOverview;
  /** Sorted by severity (High first), then kind, then category */
  findings: RiskFinding[];
  key_terms: KeyTerm[];
  checklist: ChecklistItem[];
  analysis: AnalysisContext;
  limitations: string[];
  disclaimer: string;
}
