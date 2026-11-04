export type EvidenceStatus =
  | 'FOUND'
  | 'NOT_FOUND'
  | 'AMBIGUOUS'
  | 'CONFLICTING'
  | 'NOT_APPLICABLE';

export type ContractCategory =
  | 'Freelance / Independent Contractor Agreement'
  | 'Non-Disclosure Agreement'
  | 'Employment Agreement'
  | 'Master Services Agreement'
  | 'Statement of Work'
  | 'Software License'
  | 'Commercial Lease'
  | 'General Commercial Agreement'
  | 'Other';

export interface EvidenceReference {
  element_id: string; // ID of normalized section, clause, paragraph, etc.
  source_block_id: string; // ID of original extraction block
  exact_quote: string; // Verbatim substring from the document text
  is_verified?: boolean; // Computed by server-side evidence validator
  verification_error?: string; // Reason if verification fails
}

export interface FactWithEvidence {
  status: EvidenceStatus;
  summary: string; // Objective description of what the contract says
  evidence: EvidenceReference[];
  notes?: string; // Optional context for ambiguous or conflicting provisions
}

export interface ContractClassification {
  category: ContractCategory;
  confidence: number; // 0.0 to 1.0
  primary_purpose: string;
  governing_jurisdiction: FactWithEvidence;
}

export interface ContractParty {
  name: string;
  legal_entity_type: string; // e.g. "Corporation", "LLC", "Individual", "Unspecified"
  role:
    | 'Client'
    | 'Contractor'
    | 'Consultant'
    | 'Service Provider'
    | 'Disclosing Party'
    | 'Receiving Party'
    | 'Customer'
    | 'Other';
  defined_term: string; // e.g. "Company", "Contractor", "Client"
  address_or_location?: string;
  evidence: EvidenceReference[];
}

export interface ContractDates {
  effective_date: FactWithEvidence;
  execution_date: FactWithEvidence;
  commencement_date: FactWithEvidence;
  expiration_date: FactWithEvidence;
  term_duration: FactWithEvidence;
  renewal_terms: FactWithEvidence;
}

export interface ScopeAndDeliverables {
  scope_description: FactWithEvidence;
  deliverables: FactWithEvidence[];
  change_order_mechanism: FactWithEvidence;
  acceptance_criteria: FactWithEvidence;
}

export interface PaymentAndCommercialTerms {
  fee_structure: FactWithEvidence; // e.g. "Hourly rate", "Fixed fee", "Milestone-based"
  rates_and_amounts: FactWithEvidence; // e.g. "$75.00 per hour", "$5,000 fixed price"
  invoicing_schedule: FactWithEvidence; // e.g. "Monthly on the 1st", "Upon milestone delivery"
  payment_terms_days: FactWithEvidence; // e.g. "Net 30 days"
  late_payment_terms: FactWithEvidence; // e.g. "1.5% interest per month" or NOT_FOUND
  reimbursable_expenses: FactWithEvidence; // e.g. "Pre-approved expenses only"
  taxes_and_withholding: FactWithEvidence; // e.g. "Contractor is responsible for all taxes"
}

export interface PartyObligations {
  client_obligations: FactWithEvidence[];
  contractor_obligations: FactWithEvidence[];
}

export interface KeyContractualProvisions {
  intellectual_property: {
    ownership: FactWithEvidence; // Work Made for Hire or assignment upon full payment
    pre_existing_ip: FactWithEvidence; // Retention of background IP / tools
    license_granted: FactWithEvidence;
  };
  confidentiality: {
    definition: FactWithEvidence;
    duration: FactWithEvidence; // e.g. "Survives for 3 years post-termination"
    carveouts: FactWithEvidence; // Exclusions: publicly known, independently developed
  };
  non_compete: FactWithEvidence;
  non_solicitation: FactWithEvidence;
  warranties_and_disclaimers: FactWithEvidence;
  limitation_of_liability: {
    liability_cap: FactWithEvidence; // e.g. "Total fees paid under agreement"
    exclusion_of_indirect_damages: FactWithEvidence; // Consequential, punitive, indirect damages
  };
  indemnification: {
    contractor_indemnification: FactWithEvidence;
    client_indemnification: FactWithEvidence;
  };
  termination: {
    termination_for_convenience: FactWithEvidence; // e.g. "Either party upon 30 days written notice"
    termination_for_cause: FactWithEvidence; // e.g. "Material breach with 10 days cure period"
    post_termination_payment: FactWithEvidence; // Payment for services performed prior to termination
  };
  dispute_resolution: {
    method: FactWithEvidence; // Arbitration, Litigation, Mediation
    venue_and_forum: FactWithEvidence;
    prevailing_party_legal_fees: FactWithEvidence;
  };
  independent_contractor_affirmation: FactWithEvidence;
  entire_agreement: FactWithEvidence;
}

export interface AmbiguityOrConflict {
  topic: string;
  description: string;
  evidence: EvidenceReference[];
}

export interface OmissionOrMissingTerm {
  provision_name: string;
  explanation: string;
}

export interface UnderstandingStats {
  total_facts: number;
  verified_facts: number;
  verification_percentage: number;
  total_evidence_references: number;
  verified_evidence_references: number;
}

export type AnalysisSource = 'GEMINI' | 'DETERMINISTIC_FALLBACK';

export interface ContractUnderstandingResult {
  document_id: string;
  source_file_id: string;
  verified_sha256: string;
  classification: ContractClassification;
  parties: ContractParty[];
  dates_and_term: ContractDates;
  scope_and_deliverables: ScopeAndDeliverables;
  payment_and_commercial: PaymentAndCommercialTerms;
  obligations: PartyObligations;
  key_provisions: KeyContractualProvisions;
  ambiguities_and_conflicts: AmbiguityOrConflict[];
  omissions_and_missing_terms: OmissionOrMissingTerm[];
  stats: UnderstandingStats;
  processing_status: 'COMPLETE' | 'PARTIAL' | 'FAILED';
  analysis_source: AnalysisSource;
  model_used: string;
  analyzed_at: string;
  processed_sections?: string[];
  total_sections_in_document?: number;
  coverage_percentage?: number;
  warnings: string[];
  error?: string;
}
