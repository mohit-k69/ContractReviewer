import { ContractCategory, ContractParty, EvidenceStatus } from './types';

const VALID_EVIDENCE_STATUSES: Set<EvidenceStatus> = new Set([
  'FOUND',
  'NOT_FOUND',
  'AMBIGUOUS',
  'CONFLICTING',
  'NOT_APPLICABLE',
]);

const VALID_CONTRACT_CATEGORIES: Set<ContractCategory> = new Set([
  'Freelance / Independent Contractor Agreement',
  'Non-Disclosure Agreement',
  'Employment Agreement',
  'Master Services Agreement',
  'Statement of Work',
  'Software License',
  'Commercial Lease',
  'General Commercial Agreement',
  'Other',
]);

// Mirrors the ContractParty['role'] union in types.ts.
const VALID_PARTY_ROLES: Set<ContractParty['role']> = new Set([
  'Client',
  'Contractor',
  'Consultant',
  'Service Provider',
  'Disclosing Party',
  'Receiving Party',
  'Customer',
  'Other',
]);

export interface ValidationReport {
  isValid: boolean;
  errors: string[];
}

/**
 * Required FactWithEvidence fields, as dot-paths into the model output.
 * Mirrors the nested interfaces in types.ts. Server-generated metadata
 * (document_id, source_file_id, verified_sha256, stats, processing_status,
 * analysis_source, model_used, analyzed_at, coverage fields, warnings) is
 * deliberately NOT validated here: the server populates it and never trusts
 * the model for it.
 */
const REQUIRED_FACT_PATHS: string[] = [
  'classification.governing_jurisdiction',

  'dates_and_term.effective_date',
  'dates_and_term.execution_date',
  'dates_and_term.commencement_date',
  'dates_and_term.expiration_date',
  'dates_and_term.term_duration',
  'dates_and_term.renewal_terms',

  'scope_and_deliverables.scope_description',
  'scope_and_deliverables.change_order_mechanism',
  'scope_and_deliverables.acceptance_criteria',

  'payment_and_commercial.fee_structure',
  'payment_and_commercial.rates_and_amounts',
  'payment_and_commercial.invoicing_schedule',
  'payment_and_commercial.payment_terms_days',
  'payment_and_commercial.late_payment_terms',
  'payment_and_commercial.reimbursable_expenses',
  'payment_and_commercial.taxes_and_withholding',

  'key_provisions.intellectual_property.ownership',
  'key_provisions.intellectual_property.pre_existing_ip',
  'key_provisions.intellectual_property.license_granted',
  'key_provisions.confidentiality.definition',
  'key_provisions.confidentiality.duration',
  'key_provisions.confidentiality.carveouts',
  'key_provisions.non_compete',
  'key_provisions.non_solicitation',
  'key_provisions.warranties_and_disclaimers',
  'key_provisions.limitation_of_liability.liability_cap',
  'key_provisions.limitation_of_liability.exclusion_of_indirect_damages',
  'key_provisions.indemnification.contractor_indemnification',
  'key_provisions.indemnification.client_indemnification',
  'key_provisions.termination.termination_for_convenience',
  'key_provisions.termination.termination_for_cause',
  'key_provisions.termination.post_termination_payment',
  'key_provisions.dispute_resolution.method',
  'key_provisions.dispute_resolution.venue_and_forum',
  'key_provisions.dispute_resolution.prevailing_party_legal_fees',
  'key_provisions.independent_contractor_affirmation',
  'key_provisions.entire_agreement',
];

/** Required arrays whose every element is a FactWithEvidence. */
const REQUIRED_FACT_ARRAY_PATHS: string[] = [
  'scope_and_deliverables.deliverables',
  'obligations.client_obligations',
  'obligations.contractor_obligations',
];

function isPlainObject(v: any): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Walks a dot-path; reports the first missing/non-object parent exactly once. */
function getAtPath(root: any, path: string, errors: string[], reported: Set<string>): any {
  const parts = path.split('.');
  let cur = root;
  let walked = '';
  for (let i = 0; i < parts.length; i++) {
    walked = walked ? `${walked}.${parts[i]}` : parts[i];
    const isLeaf = i === parts.length - 1;
    if (!isPlainObject(cur)) {
      return undefined; // parent already reported
    }
    const next = cur[parts[i]];
    if (next === undefined || next === null) {
      if (!isLeaf && !reported.has(walked)) {
        reported.add(walked);
        errors.push(`${walked}: Required object is missing.`);
      }
      return isLeaf ? next : undefined;
    }
    if (!isLeaf && !isPlainObject(next)) {
      if (!reported.has(walked)) {
        reported.add(walked);
        errors.push(`${walked}: Must be an object.`);
      }
      return undefined;
    }
    cur = next;
  }
  return cur;
}

function validateEvidenceReferenceStructure(ref: any, path: string, errors: string[]): void {
  if (!isPlainObject(ref)) {
    errors.push(`${path}: Evidence reference must be an object.`);
    return;
  }
  if (typeof ref.element_id !== 'string' || ref.element_id.trim().length === 0) {
    errors.push(`${path}.element_id: Must be a non-empty string.`);
  }
  if (typeof ref.source_block_id !== 'string' || ref.source_block_id.trim().length === 0) {
    errors.push(`${path}.source_block_id: Must be a non-empty string.`);
  }
  if (typeof ref.exact_quote !== 'string') {
    errors.push(`${path}.exact_quote: Must be a string.`);
  }
}

function validateEvidenceArray(evidence: any, path: string, errors: string[]): void {
  if (!Array.isArray(evidence)) {
    errors.push(`${path}: Must be an array.`);
    return;
  }
  evidence.forEach((ref, idx) => validateEvidenceReferenceStructure(ref, `${path}[${idx}]`, errors));
}

function validateFactStructure(fact: any, path: string, errors: string[]): void {
  if (!isPlainObject(fact)) {
    errors.push(`${path}: Required fact is missing or not an object.`);
    return;
  }
  if (!VALID_EVIDENCE_STATUSES.has(fact.status)) {
    // Do not echo model-supplied values back into error text.
    errors.push(
      `${path}.status: Must be one of ${Array.from(VALID_EVIDENCE_STATUSES).join(', ')}.`
    );
  }
  if (typeof fact.summary !== 'string') {
    errors.push(`${path}.summary: Must be a string.`);
  }
  validateEvidenceArray(fact.evidence, `${path}.evidence`, errors);
  if (fact.notes !== undefined && typeof fact.notes !== 'string') {
    errors.push(`${path}.notes: Must be a string when present.`);
  }
}

function validateParty(p: any, path: string, errors: string[]): void {
  if (!isPlainObject(p)) {
    errors.push(`${path}: Party must be an object.`);
    return;
  }
  if (typeof p.name !== 'string' || p.name.trim().length === 0) {
    errors.push(`${path}.name: Must be a non-empty string.`);
  }
  if (typeof p.legal_entity_type !== 'string' || p.legal_entity_type.trim().length === 0) {
    errors.push(`${path}.legal_entity_type: Must be a non-empty string.`);
  }
  if (!VALID_PARTY_ROLES.has(p.role)) {
    errors.push(`${path}.role: Must be one of ${Array.from(VALID_PARTY_ROLES).join(', ')}.`);
  }
  if (typeof p.defined_term !== 'string') {
    errors.push(`${path}.defined_term: Must be a string.`);
  }
  if (p.address_or_location !== undefined && typeof p.address_or_location !== 'string') {
    errors.push(`${path}.address_or_location: Must be a string when present.`);
  }
  validateEvidenceArray(p.evidence, `${path}.evidence`, errors);
}

/**
 * Validates the parsed Gemini response against the model-generated portion of
 * ContractUnderstandingResult. Rejects incomplete or malformed output so it
 * can never be accepted as COMPLETE; the caller falls back to the
 * deterministic engine instead.
 */
export function validateGeminiUnderstandingResponse(json: any): ValidationReport {
  const errors: string[] = [];

  if (!isPlainObject(json)) {
    return { isValid: false, errors: ['Response is not a valid JSON object.'] };
  }

  const reportedParents = new Set<string>();

  // 1. Classification
  const c = json.classification;
  if (!isPlainObject(c)) {
    errors.push('classification: Missing classification object.');
  } else {
    if (!VALID_CONTRACT_CATEGORIES.has(c.category)) {
      errors.push('classification.category: Not an allowed contract category.');
    }
    if (typeof c.confidence !== 'number' || !Number.isFinite(c.confidence) || c.confidence < 0 || c.confidence > 1) {
      errors.push('classification.confidence: Must be a number between 0 and 1.');
    }
    if (typeof c.primary_purpose !== 'string' || c.primary_purpose.trim().length === 0) {
      errors.push('classification.primary_purpose: Must be a non-empty string.');
    }
  }

  // 2. Parties
  if (!Array.isArray(json.parties)) {
    errors.push('parties: Must be an array.');
  } else {
    json.parties.forEach((p: any, idx: number) => validateParty(p, `parties[${idx}]`, errors));
  }

  // 3. Every required single fact (classification, dates, scope, commercial, key provisions)
  for (const path of REQUIRED_FACT_PATHS) {
    const fact = getAtPath(json, path, errors, reportedParents);
    // A missing/invalid parent object is reported once by getAtPath; don't pile on per-leaf errors.
    if (isParentReported(path, reportedParents)) continue;
    validateFactStructure(fact, path, errors);
  }

  // 4. Arrays of facts: deliverables and obligations
  for (const path of REQUIRED_FACT_ARRAY_PATHS) {
    const arr = getAtPath(json, path, errors, reportedParents);
    if (isParentReported(path, reportedParents)) continue;
    if (!Array.isArray(arr)) {
      errors.push(`${path}: Must be an array.`);
    } else {
      arr.forEach((f: any, idx: number) => validateFactStructure(f, `${path}[${idx}]`, errors));
    }
  }

  // 5. Ambiguities and conflicts
  if (!Array.isArray(json.ambiguities_and_conflicts)) {
    errors.push('ambiguities_and_conflicts: Must be an array.');
  } else {
    json.ambiguities_and_conflicts.forEach((a: any, idx: number) => {
      const path = `ambiguities_and_conflicts[${idx}]`;
      if (!isPlainObject(a)) {
        errors.push(`${path}: Must be an object.`);
        return;
      }
      if (typeof a.topic !== 'string' || a.topic.trim().length === 0) {
        errors.push(`${path}.topic: Must be a non-empty string.`);
      }
      if (typeof a.description !== 'string') {
        errors.push(`${path}.description: Must be a string.`);
      }
      validateEvidenceArray(a.evidence, `${path}.evidence`, errors);
    });
  }

  // 6. Omissions and missing terms
  if (!Array.isArray(json.omissions_and_missing_terms)) {
    errors.push('omissions_and_missing_terms: Must be an array.');
  } else {
    json.omissions_and_missing_terms.forEach((o: any, idx: number) => {
      const path = `omissions_and_missing_terms[${idx}]`;
      if (!isPlainObject(o)) {
        errors.push(`${path}: Must be an object.`);
        return;
      }
      if (typeof o.provision_name !== 'string' || o.provision_name.trim().length === 0) {
        errors.push(`${path}.provision_name: Must be a non-empty string.`);
      }
      if (typeof o.explanation !== 'string') {
        errors.push(`${path}.explanation: Must be a string.`);
      }
    });
  }

  return { isValid: errors.length === 0, errors };
}

function isParentReported(path: string, reported: Set<string>): boolean {
  const parts = path.split('.');
  for (let i = 1; i < parts.length; i++) {
    if (reported.has(parts.slice(0, i).join('.'))) return true;
  }
  return false;
}
