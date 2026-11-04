import {
  ContractCategory,
  ContractClassification,
  ContractParty,
  ContractUnderstandingResult,
  EvidenceReference,
  EvidenceStatus,
  FactWithEvidence,
} from './types';

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

export interface ValidationReport {
  isValid: boolean;
  errors: string[];
}

function validateEvidenceReferenceStructure(
  ref: any,
  path: string,
  errors: string[]
): void {
  if (!ref || typeof ref !== 'object') {
    errors.push(`${path}: Evidence reference must be an object.`);
    return;
  }
  if (typeof ref.element_id !== 'string' || ref.element_id.trim().length === 0) {
    errors.push(`${path}: element_id must be a non-empty string.`);
  }
  if (typeof ref.source_block_id !== 'string' || ref.source_block_id.trim().length === 0) {
    errors.push(`${path}: source_block_id must be a non-empty string.`);
  }
  if (typeof ref.exact_quote !== 'string') {
    errors.push(`${path}: exact_quote must be a string.`);
  }
}

function validateFactStructure(
  fact: any,
  path: string,
  errors: string[]
): void {
  if (!fact || typeof fact !== 'object') {
    errors.push(`${path}: Required fact object is missing or not an object.`);
    return;
  }

  if (!VALID_EVIDENCE_STATUSES.has(fact.status)) {
    errors.push(
      `${path}.status: Invalid evidence status "${fact.status}". Allowed values: ${Array.from(
        VALID_EVIDENCE_STATUSES
      ).join(', ')}.`
    );
  }

  if (typeof fact.summary !== 'string') {
    errors.push(`${path}.summary: summary must be a string.`);
  }

  if (!Array.isArray(fact.evidence)) {
    errors.push(`${path}.evidence: evidence must be an array.`);
  } else {
    fact.evidence.forEach((ref: any, idx: number) => {
      validateEvidenceReferenceStructure(ref, `${path}.evidence[${idx}]`, errors);
    });
  }
}

/**
 * Validates the parsed Gemini response against the full ContractUnderstandingResult schema.
 * Rejects incomplete or malformed outputs so they cannot be silently marked COMPLETE.
 */
export function validateGeminiUnderstandingResponse(
  json: any
): ValidationReport {
  const errors: string[] = [];

  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return {
      isValid: false,
      errors: ['Response is not a valid JSON object.'],
    };
  }

  // 1. Classification
  if (!json.classification || typeof json.classification !== 'object') {
    errors.push('classification: Missing classification object.');
  } else {
    if (!VALID_CONTRACT_CATEGORIES.has(json.classification.category)) {
      errors.push(
        `classification.category: "${json.classification.category}" is not an allowed contract category.`
      );
    }
    if (
      typeof json.classification.confidence !== 'number' ||
      Number.isNaN(json.classification.confidence) ||
      json.classification.confidence < 0 ||
      json.classification.confidence > 1
    ) {
      errors.push('classification.confidence: confidence must be a number between 0 and 1.');
    }
    if (typeof json.classification.primary_purpose !== 'string') {
      errors.push('classification.primary_purpose: primary_purpose must be a string.');
    }
    validateFactStructure(
      json.classification.governing_jurisdiction,
      'classification.governing_jurisdiction',
      errors
    );
  }

  // 2. Parties
  if (!Array.isArray(json.parties)) {
    errors.push('parties: parties must be an array.');
  } else {
    json.parties.forEach((p: any, idx: number) => {
      const pPath = `parties[${idx}]`;
      if (!p || typeof p !== 'object') {
        errors.push(`${pPath}: Party must be an object.`);
      } else {
        if (typeof p.name !== 'string' || p.name.trim().length === 0) {
          errors.push(`${pPath}.name: Party name must be a non-empty string.`);
        }
        if (typeof p.role !== 'string') {
          errors.push(`${pPath}.role: Party role must be a string.`);
        }
        if (typeof p.defined_term !== 'string') {
          errors.push(`${pPath}.defined_term: Party defined_term must be a string.`);
        }
        if (!Array.isArray(p.evidence)) {
          errors.push(`${pPath}.evidence: Party evidence must be an array.`);
        } else {
          p.evidence.forEach((ref: any, rIdx: number) => {
            validateEvidenceReferenceStructure(ref, `${pPath}.evidence[${rIdx}]`, errors);
          });
        }
      }
    });
  }

  // 3. Dates & Term
  if (!json.dates_and_term || typeof json.dates_and_term !== 'object') {
    errors.push('dates_and_term: Missing dates_and_term object.');
  } else {
    validateFactStructure(json.dates_and_term.effective_date, 'dates_and_term.effective_date', errors);
    validateFactStructure(json.dates_and_term.expiration_date, 'dates_and_term.expiration_date', errors);
    validateFactStructure(json.dates_and_term.term_duration, 'dates_and_term.term_duration', errors);
    validateFactStructure(json.dates_and_term.renewal_terms, 'dates_and_term.renewal_terms', errors);
  }

  // 4. Scope & Deliverables
  if (!json.scope_and_deliverables || typeof json.scope_and_deliverables !== 'object') {
    errors.push('scope_and_deliverables: Missing scope_and_deliverables object.');
  } else {
    validateFactStructure(
      json.scope_and_deliverables.scope_description,
      'scope_and_deliverables.scope_description',
      errors
    );
    validateFactStructure(
      json.scope_and_deliverables.change_order_mechanism,
      'scope_and_deliverables.change_order_mechanism',
      errors
    );
    validateFactStructure(
      json.scope_and_deliverables.acceptance_criteria,
      'scope_and_deliverables.acceptance_criteria',
      errors
    );
    if (!Array.isArray(json.scope_and_deliverables.deliverables)) {
      errors.push('scope_and_deliverables.deliverables: deliverables must be an array.');
    } else {
      json.scope_and_deliverables.deliverables.forEach((d: any, idx: number) => {
        validateFactStructure(d, `scope_and_deliverables.deliverables[${idx}]`, errors);
      });
    }
  }

  // 5. Payment & Commercial Terms
  if (!json.payment_and_commercial || typeof json.payment_and_commercial !== 'object') {
    errors.push('payment_and_commercial: Missing payment_and_commercial object.');
  } else {
    validateFactStructure(
      json.payment_and_commercial.fee_structure,
      'payment_and_commercial.fee_structure',
      errors
    );
    validateFactStructure(
      json.payment_and_commercial.rates_and_amounts,
      'payment_and_commercial.rates_and_amounts',
      errors
    );
    validateFactStructure(
      json.payment_and_commercial.invoicing_schedule,
      'payment_and_commercial.invoicing_schedule',
      errors
    );
    validateFactStructure(
      json.payment_and_commercial.payment_terms_days,
      'payment_and_commercial.payment_terms_days',
      errors
    );
    validateFactStructure(
      json.payment_and_commercial.late_payment_terms,
      'payment_and_commercial.late_payment_terms',
      errors
    );
    validateFactStructure(
      json.payment_and_commercial.reimbursable_expenses,
      'payment_and_commercial.reimbursable_expenses',
      errors
    );
    validateFactStructure(
      json.payment_and_commercial.taxes_and_withholding,
      'payment_and_commercial.taxes_and_withholding',
      errors
    );
  }

  // 6. Obligations
  if (!json.obligations || typeof json.obligations !== 'object') {
    errors.push('obligations: Missing obligations object.');
  } else {
    if (!Array.isArray(json.obligations.client_obligations)) {
      errors.push('obligations.client_obligations: client_obligations must be an array.');
    }
    if (!Array.isArray(json.obligations.contractor_obligations)) {
      errors.push('obligations.contractor_obligations: contractor_obligations must be an array.');
    }
  }

  // 7. Key Provisions
  if (!json.key_provisions || typeof json.key_provisions !== 'object') {
    errors.push('key_provisions: Missing key_provisions object.');
  } else {
    const kp = json.key_provisions;
    // IP
    if (!kp.intellectual_property || typeof kp.intellectual_property !== 'object') {
      errors.push('key_provisions.intellectual_property: Missing intellectual_property object.');
    } else {
      validateFactStructure(kp.intellectual_property.ownership, 'key_provisions.ip.ownership', errors);
      validateFactStructure(kp.intellectual_property.pre_existing_ip, 'key_provisions.ip.pre_existing_ip', errors);
    }

    // Confidentiality
    if (!kp.confidentiality || typeof kp.confidentiality !== 'object') {
      errors.push('key_provisions.confidentiality: Missing confidentiality object.');
    } else {
      validateFactStructure(kp.confidentiality.definition, 'key_provisions.confidentiality.definition', errors);
      validateFactStructure(kp.confidentiality.duration, 'key_provisions.confidentiality.duration', errors);
    }

    validateFactStructure(kp.non_compete, 'key_provisions.non_compete', errors);
    validateFactStructure(kp.non_solicitation, 'key_provisions.non_solicitation', errors);

    // Termination
    if (!kp.termination || typeof kp.termination !== 'object') {
      errors.push('key_provisions.termination: Missing termination object.');
    } else {
      validateFactStructure(
        kp.termination.termination_for_convenience,
        'key_provisions.termination.termination_for_convenience',
        errors
      );
      validateFactStructure(
        kp.termination.termination_for_cause,
        'key_provisions.termination.termination_for_cause',
        errors
      );
    }

    validateFactStructure(
      kp.independent_contractor_affirmation,
      'key_provisions.independent_contractor_affirmation',
      errors
    );
    validateFactStructure(kp.entire_agreement, 'key_provisions.entire_agreement', errors);
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}
