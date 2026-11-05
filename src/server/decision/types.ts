/**
 * Contract Decision Report: the user-facing, machine-readable report built from the verified contract
 * understanding and the risk analysis. It is generated deterministically (no additional AI call) and inside
 * the single-request analysis pipeline, so it never depends on state surviving between requests.
 *
 * Evidence policy (enforced by decision/evidence.ts):
 *   - a statement about what the contract says is only `explicit` / `conflicting` when it carries at least one
 *     quote that passed the same word-for-word verification as the rest of the pipeline;
 *   - anything whose evidence cannot be verified is downgraded to `unclear` and flagged `evidence_unverified`;
 *   - an absence (`not_found` / `not_in_contract`) never carries evidence;
 *   - rights that may exist under law outside the contract are never asserted: they are labelled
 *     `outside_contract` and described as "not assessed".
 */

/** Status of an extracted item. Maps 1:1 from the understanding stage (FOUND, AMBIGUOUS, ...). */
export type ReportStatus = 'explicit' | 'unclear' | 'conflicting' | 'not_found' | 'not_applicable';

/** What a statement rests on. */
export type StatementBasis =
  | 'explicit' // the contract says it (verified quote attached)
  | 'unclear' // the contract addresses it vaguely or the quote could not be verified
  | 'conflicting' // clauses disagree (both sides quoted)
  | 'not_in_contract' // searched for and not found (no evidence by definition)
  | 'outside_contract'; // depends on law or facts outside the contract; NOT assessed here

export type Priority = 'high' | 'medium' | 'low';

/** A verified quote with a human-readable location. */
export interface ReportEvidence {
  element_id: string;
  source_block_id: string;
  /** Verbatim substring of the uploaded contract */
  exact_quote: string;
  /** e.g. "Section 5 › 5.1 Termination for Convenience" */
  clause_label?: string;
  /** Display reference. PDF: "p. 3 · Section 5 › 5.1 …". DOCX/TXT: the structural reference only (no invented pages). */
  reference: string;
  /** Real page number. Present ONLY for PDF documents. */
  page?: number;
  /** Structural reference from extraction (e.g. "para-16"), when available */
  structural_ref?: string;
}

/** Reusable structure for an extracted fact (Sections 1 and 2). */
export interface ExtractedItem {
  id: string;
  title: string;
  /** What the contract states, in plain words; null when nothing is stated */
  value: string | null;
  status: ReportStatus;
  explanation: string;
  evidence: ReportEvidence[];
  category: string;
  /** Present when verification of the supporting quotes failed or was missing for an otherwise present fact */
  evidence_unverified?: boolean;
  /** Values parsed from the verified quote (never invented) */
  structured?: {
    days?: number;
    business_days?: number;
    months?: number;
    amounts?: string[];
    currencies?: string[];
    date?: string; // ISO date stated in the contract
    calculated_date?: string; // ISO date calculated from stated dates/periods (labelled as calculated)
    deliverables?: string[];
    holder?: 'freelancer' | 'client' | 'either_party';
  };
  /** Risk findings that concern this item (including contradictions) */
  related_finding_ids?: string[];
}

// ---------------------------------------------------------------------------
// Section 1
// ---------------------------------------------------------------------------
export type DealGroup = 'contract' | 'parties' | 'engagement' | 'timeline' | 'money' | 'invoicing' | 'termination_renewal';

export interface DealItem extends ExtractedItem {
  group: DealGroup;
  /** For party items */
  party_role?: 'client' | 'freelancer' | 'other';
}

export interface DealSection {
  items: DealItem[];
}

// ---------------------------------------------------------------------------
// Section 2
// ---------------------------------------------------------------------------
export interface Commitment extends ExtractedItem {
  party: 'freelancer' | 'client';
  /** duty = must do; restriction = must not / limited; allowance = permitted */
  nature: 'duty' | 'restriction' | 'allowance';
}

export interface CommitmentGroup {
  category: string;
  title: string;
  items: Commitment[];
}

export interface CommitmentsSection {
  freelancer: CommitmentGroup[];
  client: CommitmentGroup[];
  /** Expected categories for which the contract states nothing (not an assumption that something is owed) */
  not_stated: Array<{ party: 'freelancer' | 'client'; category: string; title: string }>;
}

// ---------------------------------------------------------------------------
// Section 3
// ---------------------------------------------------------------------------
export type FindingType = 'risk' | 'ambiguous' | 'contradictory' | 'missing';
export type ImpactArea = 'money' | 'rights' | 'responsibilities' | 'other_clients' | 'liability';

export interface RelatedClause {
  element_id: string;
  reference: string;
  relationship: 'conflicts_with' | 'also_cited_by_related_finding';
  finding_id?: string;
}

export interface Statement {
  text: string;
  basis: StatementBasis;
  evidence: ReportEvidence[];
  /** True when the value was calculated from stated dates/periods rather than quoted */
  calculated?: boolean;
  evidence_unverified?: boolean;
}

export interface DecisionFinding {
  id: string;
  title: string;
  priority: Priority;
  category: string;
  type: FindingType;
  status: ReportStatus;
  group_id: string;
  /** Findings that overlap (share a clause) are clustered; the lead is the one to read first */
  cluster_id: string;
  is_cluster_lead: boolean;
  /** What the contract says (or, for an absence, that it does not say it) */
  contract_position: Statement;
  /** Exact supporting wording */
  contract_language: string[];
  evidence: ReportEvidence[];
  explanation: string;
  /** Potential impact on the freelancer */
  impact: string;
  recommended_action: string;
  /** An example alternative, clearly a suggestion: not a benchmark, a requirement or a stated term */
  illustrative_alternative?: string;
  related_clauses: RelatedClause[];
  related_finding_ids: string[];
  impact_areas: ImpactArea[];
  confidence: { level: 'High' | 'Medium' | 'Low'; reasons: string[] };
  uncertainty?: string;
  /** Missing provisions only: why the absence is material for this contract */
  relevance?: { material: true; reason: string; evidence: ReportEvidence[] };
}

export interface FindingGroup {
  group_id: string;
  title: string;
  finding_ids: string[];
  clusters: Array<{ cluster_id: string; lead_id: string; finding_ids: string[] }>;
}

/** An absent provision that nothing in the contract makes relevant. Not a risk. */
export interface Observation {
  id: string;
  title: string;
  category: string;
  explanation: string;
  topic: string;
  relevance_reason: string;
}

export interface AttentionSection {
  groups: FindingGroup[];
  findings: DecisionFinding[];
  observations: Observation[];
  /** Counts of material findings. There is deliberately no overall score. */
  counts: {
    by_priority: Record<Priority, number>;
    by_type: Record<FindingType, number>;
  };
}

// ---------------------------------------------------------------------------
// Section 4
// ---------------------------------------------------------------------------
export interface ClauseRef {
  element_id: string;
  reference: string;
}

export interface ScenarioAction {
  text: string;
  /** Finding ids (or `fact:<key>` for a stated contract term) this action rests on */
  grounded_in: string[];
  illustrative_alternative?: string;
}

export interface Scenario {
  id: string;
  /** Short name, e.g. "The client pays late" */
  scenario: string;
  situation: string;
  /** Why this scenario applies to THIS contract (the provisions that triggered it) */
  trigger: { reason: string; evidence: ReportEvidence[] };
  applicable_clauses: ClauseRef[];
  /** What the contract says */
  contract_position: Statement[];
  /** Practical implications: contractual consequences are kept apart from uncertain outcomes */
  potential_outcome: { contractual: Statement[]; uncertain: Statement[] };
  /** Missing protections and ambiguities, relevant to this scenario only */
  missing_protections: Statement[];
  uncertainties: string[];
  recommended_action: ScenarioAction;
  related_finding_ids: string[];
}

// ---------------------------------------------------------------------------
// Section 5
// ---------------------------------------------------------------------------
export interface Right {
  id: string;
  title: string;
  /** Plain statement of what the contract gives you, built from the quoted wording */
  statement: string;
  holder: 'freelancer' | 'either_party' | 'client_owes_you';
  status: ReportStatus;
  /** Verbatim fragments of the clause that qualify the right (e.g. "upon full payment") */
  conditions: string[];
  /** Verbatim fragments that limit the right (e.g. "only", "shall not exceed") */
  limitations: string[];
  notice_period?: { text: string; days?: number; months?: number };
  evidence: ReportEvidence[];
}

export interface Question {
  id: string;
  question: string;
  /** A concrete change to ask for, grounded in the contract (no invented amounts or deadlines) */
  suggested_change?: string;
  illustrative_alternative?: string;
  priority: Priority;
  kind: FindingType | 'unclear_term';
  grounded_in: { finding_id?: string; item_id?: string };
  contract_reference: ReportEvidence[];
}

export interface ChecklistEntry {
  id: string;
  text: string;
  priority: Priority;
  related_finding_id?: string;
  related_question_id?: string;
  related_item_id?: string;
  evidence: ReportEvidence[];
}

export interface MonitorEntry {
  id: string;
  text: string;
  /** What it relates to, e.g. "every invoice" */
  applies_to: string;
  /** Set only when stated in the contract or calculated from stated dates/periods */
  date?: string;
  calculated?: boolean;
  evidence: ReportEvidence[];
}

export interface RightsAndNextSteps {
  rights: Right[];
  /** Always present: legal rights that exist outside the contract are not assessed here */
  outside_contract_note: string;
  questions: Question[];
  checklist: { before_signing: ChecklistEntry[]; during_engagement: MonitorEntry[] };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
export interface DecisionReport {
  schema_version: '1.0';
  document_id: string;
  source_file_id: string;
  verified_sha256: string;
  generated_at: string;
  coverage: {
    analysis_source: 'GEMINI' | 'DETERMINISTIC_FALLBACK';
    processing_status: 'COMPLETE' | 'PARTIAL' | 'FAILED';
    coverage_percentage: number;
    evidence_verification_percentage: number;
    /** Absences are only reported as `not_found` / missing provisions when this is true */
    absences_assessed: boolean;
    source_format: 'pdf' | 'docx' | 'txt';
  };
  /** Section 1: Understand your deal */
  deal: DealSection;
  /** Section 2: Your commitments */
  commitments: CommitmentsSection;
  /** Section 3: What deserves your attention */
  attention: AttentionSection;
  /** Section 4: What if something happens */
  scenarios: Scenario[];
  /** Section 5: Your rights and next steps */
  rights_and_next_steps: RightsAndNextSteps;
  limitations: string[];
  disclaimer: string;
  evidence_policy: string[];
  /** Items downgraded or removed because their evidence could not be verified */
  warnings: string[];
}
