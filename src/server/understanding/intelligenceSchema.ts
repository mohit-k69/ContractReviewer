import { ContractUnderstandingResult, FactWithEvidence } from './types';

/**
 * Single source of truth for the contractor-intelligence fact groups.
 * The response validator, evidence validator, Gemini prompt, chunk merger and tests all derive from this,
 * so a field can never be validated but not merged (or merged but not verified).
 *
 * `topic` is the name used for cross-chunk conflict comparison (see conflictDetector TOPIC_VALUE_KIND).
 */
export interface IntelligenceField {
  topic: string;
  /** What FOUND means for this field (shown to the model) */
  description: string;
}

export const INTELLIGENCE_SCHEMA = {
  worker_classification: {
    prescribed_hours: { topic: 'Prescribed Working Hours', description: 'Contractor must work fixed/prescribed hours or a minimum weekly/daily availability set by the client' },
    mandatory_location: { topic: 'Mandatory Work Location', description: 'Contractor must work at the client\'s office/premises or a client-specified location' },
    direct_supervision: { topic: 'Direct Supervision', description: 'Client supervises, directs or controls the contractor\'s day-to-day work or working methods' },
    exclusivity: { topic: 'Exclusivity', description: 'Contractor may serve only this client / is barred from working for other clients (NOT "exclusive property" of IP)' },
    no_delegation: { topic: 'Personal Performance', description: 'Contractor must perform personally and may not delegate or use subcontractors/assistants' },
    client_equipment: { topic: 'Client Equipment', description: 'Contractor must use client-provided equipment, devices or systems' },
    independent_business_restrictions: { topic: 'Independent Business Restrictions', description: 'Limits on advertising, running an independent business, branding, or holding out as an independent contractor' },
    control_over_timing_and_manner: { topic: 'Control Over Timing and Manner', description: 'Client dictates how, when or in what order services are performed (procedures, timesheets, attendance)' },
  },
  data_protection: {
    handles_personal_data: { topic: 'Handles Personal Data', description: 'The contract indicates the contractor accesses, processes or handles personal, customer or sensitive data' },
    permitted_purposes: { topic: 'Permitted Data Purposes', description: 'The purposes for which data may be used (e.g. only to perform the services)' },
    security_obligations: { topic: 'Data Security Obligations', description: 'Data confidentiality or security measures the contractor must implement' },
    breach_notification: { topic: 'Breach Notification', description: 'Duty to notify the client of data breaches or security incidents (include any deadline)' },
    return_or_deletion: { topic: 'Data Return or Deletion', description: 'Return or deletion of data/materials after termination or on request' },
    third_party_access: { topic: 'Third-Party Data Access', description: 'Terms on subcontractor, sub-processor or other third-party access to data' },
    cross_border_transfer: { topic: 'Cross-Border Data Transfer', description: 'International data transfer, data location or residency terms' },
    processing_agreement: { topic: 'Data Processing Agreement', description: 'A data processing agreement/addendum or controller/processor allocation' },
  },
  insurance: {
    professional_indemnity: { topic: 'Professional Indemnity Insurance', description: 'Professional indemnity / professional liability / E&O insurance the contractor must maintain' },
    general_liability: { topic: 'General Liability Insurance', description: 'Commercial or public general liability insurance the contractor must maintain' },
    cyber: { topic: 'Cyber Insurance', description: 'Cyber liability insurance the contractor must maintain' },
    minimum_coverage: { topic: 'Minimum Insurance Coverage', description: 'Minimum coverage limits (amounts). Use AMBIGUOUS if insurance is required but limits are vague ("adequate")' },
    additional_insured: { topic: 'Additional Insured', description: 'Requirement to name the client as additional insured or waive subrogation' },
    evidence_of_insurance: { topic: 'Evidence of Insurance', description: 'Requirement to provide certificates/proof of insurance' },
    post_termination_maintenance: { topic: 'Post-Termination Insurance', description: 'Requirement to keep insurance (or tail cover) after termination' },
  },
  subcontracting: {
    prohibition: { topic: 'Subcontracting Prohibition', description: 'ABSOLUTE ban on subcontracting/delegation with no consent route' },
    approval_requirement: { topic: 'Subcontracting Approval', description: 'Subcontracting/delegation allowed only with the client\'s consent or notice' },
    permission: { topic: 'Subcontracting Permission', description: 'Contractor is expressly permitted to subcontract or delegate (with or without conditions)' },
    delegation_restriction: { topic: 'Delegation Restriction', description: 'Personal-service requirement or conditions on delegating work or replacing personnel' },
    responsibility_for_subcontractors: { topic: 'Subcontractor Responsibility', description: 'Contractor remains responsible for subcontractor performance' },
    liability_for_subcontractors: { topic: 'Subcontractor Liability', description: 'Contractor is liable for or indemnifies against subcontractor acts' },
    flow_down_obligations: { topic: 'Subcontractor Flow-Down', description: 'Subcontractors must be bound by confidentiality, data or IP terms' },
  },
  tax_details: {
    contractor_income_tax: { topic: 'Contractor Income Tax', description: 'Contractor is responsible for its own income/self-employment taxes' },
    client_withholding: { topic: 'Client Tax Withholding', description: 'Client may withhold or deduct taxes from payments' },
    indirect_taxes: { topic: 'Indirect Taxes', description: 'VAT / GST / sales tax treatment' },
    tax_indemnification: { topic: 'Tax Indemnification', description: 'Indemnity relating to taxes, penalties or withholding' },
    amounts_tax_basis: { topic: 'Amounts Tax Basis', description: 'Whether agreed fees include or exclude taxes' },
  },
  renewal_details: {
    auto_renewal: { topic: 'Automatic Renewal', description: 'The contract renews or extends automatically (a statement that it does NOT renew is NOT_FOUND)' },
    renewal_duration: { topic: 'Renewal Duration', description: 'Length of each renewal or extension term' },
    non_renewal_notice: { topic: 'Non-Renewal Notice', description: 'Notice required to prevent renewal' },
    unilateral_renewal: { topic: 'Unilateral Renewal', description: 'One party (e.g. the client) may renew or extend at its sole option' },
    renewal_pricing: { topic: 'Renewal Pricing', description: 'Pricing/rate changes or freezes on renewal' },
  },
  warranty_details: {
    performance_guarantee: { topic: 'Performance Guarantee', description: 'Broad performance/quality guarantees (error-free, fit for purpose, meets all requirements)' },
    outcome_guarantee: { topic: 'Outcome Guarantee', description: 'Guarantees of business or financial outcomes (revenue, ROI, rankings, launch dates, approvals)' },
    warranty_duration: { topic: 'Warranty Duration', description: 'How long warranties or defect liability last. Use AMBIGUOUS for vague durations ("reasonable period")' },
    repair_replace: { topic: 'Repair or Replace', description: 'Obligations to repair, replace or re-perform (note any "at no charge", "unlimited" or "until satisfied")' },
    post_termination_warranty: { topic: 'Post-Termination Warranty', description: 'Warranty or defect obligations that continue after termination' },
  },
  deal_terms: {
    contract_title: { topic: 'Contract Title', description: 'The agreement\'s own title as written (for example the heading), not a summary' },
    currency: { topic: 'Currency', description: 'The currency of the fees. Use AMBIGUOUS when only a bare "$" is used without naming the currency' },
    milestones: { topic: 'Milestones', description: 'Milestones or staged deliveries, and any payment tied to them' },
    invoice_requirements: { topic: 'Invoice Requirements', description: 'What an invoice must contain or how and where it must be submitted' },
    payment_conditions: { topic: 'Payment Conditions', description: 'Conditions that must be met before payment is due (for example approved hours, approval of work)' },
    contractor_termination_right: { topic: 'Contractor Termination Right', description: 'A right of the contractor (or of either party) to terminate, with any notice or conditions. A statement that only the client may terminate is NOT_FOUND' },
  },
  obligation_details: {
    delivery_deadlines: { topic: 'Delivery Deadlines', description: 'Dates or deadlines by which the contractor must deliver or complete work' },
    revisions: { topic: 'Revisions', description: 'How many revisions are included, any limit, or how extra revisions are handled. Use AMBIGUOUS for vague wording ("reasonable revisions")' },
    client_resources: { topic: 'Client Resources', description: 'The client must provide information, access, materials, approvals or cooperation' },
    client_review_feedback: { topic: 'Client Review and Feedback', description: 'The client must review, respond, approve or give feedback (note any time limit)' },
  },
} as const satisfies Record<string, Record<string, IntelligenceField>>;

export type IntelligenceGroupKey = keyof typeof INTELLIGENCE_SCHEMA;
export const INTELLIGENCE_GROUP_KEYS = Object.keys(INTELLIGENCE_SCHEMA) as IntelligenceGroupKey[];

export const INTELLIGENCE_GROUP_LABELS: Record<IntelligenceGroupKey, string> = {
  worker_classification: 'worker classification',
  data_protection: 'data protection',
  insurance: 'insurance',
  subcontracting: 'subcontracting',
  tax_details: 'tax',
  renewal_details: 'renewal',
  warranty_details: 'warranty',
  deal_terms: 'deal terms',
  obligation_details: 'obligation details',
};

/** Dot-paths (e.g. "insurance.cyber") of every intelligence fact. */
export function intelligenceFactPaths(): string[] {
  return INTELLIGENCE_GROUP_KEYS.flatMap((g) => Object.keys(INTELLIGENCE_SCHEMA[g]).map((f) => `${g}.${f}`));
}

/** Iterates every intelligence fact present on a result (a missing group yields nothing; callers must not default it). */
export function forEachIntelligenceFact(
  result: Partial<ContractUnderstandingResult>,
  visit: (fact: FactWithEvidence | undefined, group: IntelligenceGroupKey, field: string, topic: string) => void
): void {
  for (const g of INTELLIGENCE_GROUP_KEYS) {
    const group = (result as any)[g];
    for (const [field, meta] of Object.entries(INTELLIGENCE_SCHEMA[g])) {
      visit(group && typeof group === 'object' ? group[field] : undefined, g, field, (meta as IntelligenceField).topic);
    }
  }
}
