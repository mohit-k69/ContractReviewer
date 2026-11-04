import {
  BaseNormalizedElement,
  NormalizedClause,
  NormalizedDocument,
  NormalizedList,
  NormalizedSection,
} from '../normalization/types';
import { DocumentExtractionResult, ExtractedBlock } from '../extraction/types';
import {
  ContractUnderstandingResult,
  EvidenceReference,
  FactWithEvidence,
} from './types';

function normalizeWhitespace(text: string): string {
  if (!text) return '';
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Builds a flat lookup map of all normalized elements keyed by their deterministic element ID.
 */
export function buildNormalizedElementMap(
  doc: NormalizedDocument
): Map<string, BaseNormalizedElement> {
  const map = new Map<string, BaseNormalizedElement>();

  function registerNode(node: any) {
    if (!node || !node.id) return;
    map.set(node.id, node);

    // Recursively register children if section or subsection
    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        registerNode(child);
      }
    }

    // Recursively register content if clause or subclause
    if (node.content && Array.isArray(node.content)) {
      for (const child of node.content) {
        registerNode(child);
      }
    }

    // Recursively register list items if list
    if (node.items && Array.isArray(node.items)) {
      for (const item of node.items) {
        registerNode(item);
      }
    }
  }

  // Register all sections
  if (doc.sections && Array.isArray(doc.sections)) {
    for (const section of doc.sections) {
      registerNode(section);
    }
  }

  // Register unclassified blocks
  if (doc.unclassified_blocks && Array.isArray(doc.unclassified_blocks)) {
    for (const block of doc.unclassified_blocks) {
      registerNode(block);
    }
  }

  return map;
}

/**
 * Builds a flat lookup map of all extracted blocks keyed by their block ID.
 */
export function buildExtractionBlockMap(
  extraction: DocumentExtractionResult
): Map<string, ExtractedBlock> {
  const map = new Map<string, ExtractedBlock>();
  if (extraction && Array.isArray(extraction.blocks)) {
    for (const block of extraction.blocks) {
      if (block.block_id) {
        map.set(block.block_id, block);
      }
    }
  }
  return map;
}

/**
 * Validates a single evidence reference against both the normalized document and the extraction blocks.
 * Checks:
 * 1. Element ID exists in normalized hierarchy.
 * 2. Source block ID exists in extraction blocks.
 * 3. Exact quote is a verbatim substring of the source block's text (with robust whitespace tolerance).
 */
export function validateEvidenceReference(
  ref: EvidenceReference,
  elementMap: Map<string, BaseNormalizedElement>,
  blockMap: Map<string, ExtractedBlock>
): { is_verified: boolean; error?: string } {
  if (!ref) {
    return { is_verified: false, error: 'Empty evidence reference.' };
  }

  // 1. Verify Element ID
  if (!ref.element_id || !elementMap.has(ref.element_id)) {
    return {
      is_verified: false,
      error: `Referenced element ID "${ref.element_id || 'undefined'}" does not exist in normalized document hierarchy.`,
    };
  }

  const element = elementMap.get(ref.element_id)!;

  // 2. Verify Source Block ID
  if (!ref.source_block_id || !blockMap.has(ref.source_block_id)) {
    return {
      is_verified: false,
      error: `Referenced source block ID "${ref.source_block_id || 'undefined'}" does not exist in extraction blocks.`,
    };
  }

  const block = blockMap.get(ref.source_block_id)!;

  // 3. Verify Exact Quote
  const quote = ref.exact_quote ? ref.exact_quote.trim() : '';
  if (!quote) {
    return {
      is_verified: false,
      error: 'Evidence reference has an empty quote string.',
    };
  }

  // Verbatim raw substring check on block text
  if (block.text && block.text.includes(quote)) {
    return { is_verified: true };
  }

  // Whitespace-normalized substring check on block text
  const normQuote = normalizeWhitespace(quote);
  const normBlockText = normalizeWhitespace(block.text || '');
  if (normBlockText.includes(normQuote)) {
    return { is_verified: true };
  }

  // Substring check on the normalized element's combined text
  const normElementText = normalizeWhitespace(element.text || '');
  if (normElementText.includes(normQuote)) {
    return { is_verified: true };
  }

  // If quote contains punctuation like smart quotes or hyphens, check normalized ascii
  const cleanQuote = normQuote.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  const cleanBlockText = normBlockText.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  if (cleanBlockText.includes(cleanQuote)) {
    return { is_verified: true };
  }

  return {
    is_verified: false,
    error: `Quote text "${quote.slice(0, 60)}${quote.length > 60 ? '...' : ''}" does not appear as a verbatim substring in source block "${ref.source_block_id}".`,
  };
}

/**
 * Validates all evidence references across an entire ContractUnderstandingResult.
 * Computes exact verification statistics and appends warnings for any unverifiable references.
 */
export function validateUnderstandingResult(
  result: ContractUnderstandingResult,
  normalized: NormalizedDocument,
  extraction: DocumentExtractionResult
): ContractUnderstandingResult {
  const elementMap = buildNormalizedElementMap(normalized);
  const blockMap = buildExtractionBlockMap(extraction);

  let totalEvidenceRefs = 0;
  let verifiedEvidenceRefs = 0;
  let totalFacts = 0;
  let verifiedFacts = 0;

  const warnings: string[] = [...(result.warnings || [])];

  function validateFact(fact: FactWithEvidence | undefined, path: string): void {
    if (!fact) return;
    totalFacts++;

    if (fact.status === 'NOT_FOUND' || fact.status === 'NOT_APPLICABLE') {
      // Missing or non-applicable facts have no quotes to verify
      verifiedFacts++;
      return;
    }

    if (!fact.evidence || fact.evidence.length === 0) {
      if (fact.status === 'FOUND') {
        warnings.push(`Fact "${path}" is marked FOUND but provides no evidence references.`);
      }
      return;
    }

    let factAllVerified = true;

    for (const ref of fact.evidence) {
      totalEvidenceRefs++;
      const val = validateEvidenceReference(ref, elementMap, blockMap);
      ref.is_verified = val.is_verified;
      ref.verification_error = val.error;

      if (val.is_verified) {
        verifiedEvidenceRefs++;
      } else {
        factAllVerified = false;
        warnings.push(`Evidence verification failed for ${path}: ${val.error}`);
      }
    }

    if (factAllVerified) {
      verifiedFacts++;
    }
  }

  // 1. Classification jurisdiction
  validateFact(result.classification?.governing_jurisdiction, 'classification.governing_jurisdiction');

  // 2. Parties
  if (Array.isArray(result.parties)) {
    for (let i = 0; i < result.parties.length; i++) {
      const p = result.parties[i];
      if (p.evidence && Array.isArray(p.evidence)) {
        for (const ref of p.evidence) {
          totalEvidenceRefs++;
          const val = validateEvidenceReference(ref, elementMap, blockMap);
          ref.is_verified = val.is_verified;
          ref.verification_error = val.error;
          if (val.is_verified) {
            verifiedEvidenceRefs++;
          } else {
            warnings.push(`Evidence verification failed for party "${p.name}": ${val.error}`);
          }
        }
      }
    }
  }

  // 3. Dates & Term
  if (result.dates_and_term) {
    validateFact(result.dates_and_term.effective_date, 'dates.effective_date');
    validateFact(result.dates_and_term.execution_date, 'dates.execution_date');
    validateFact(result.dates_and_term.commencement_date, 'dates.commencement_date');
    validateFact(result.dates_and_term.expiration_date, 'dates.expiration_date');
    validateFact(result.dates_and_term.term_duration, 'dates.term_duration');
    validateFact(result.dates_and_term.renewal_terms, 'dates.renewal_terms');
  }

  // 4. Scope & Deliverables
  if (result.scope_and_deliverables) {
    validateFact(result.scope_and_deliverables.scope_description, 'scope.scope_description');
    validateFact(result.scope_and_deliverables.change_order_mechanism, 'scope.change_order_mechanism');
    validateFact(result.scope_and_deliverables.acceptance_criteria, 'scope.acceptance_criteria');
    if (Array.isArray(result.scope_and_deliverables.deliverables)) {
      result.scope_and_deliverables.deliverables.forEach((d, idx) => {
        validateFact(d, `scope.deliverables[${idx}]`);
      });
    }
  }

  // 5. Payment & Commercial Terms
  if (result.payment_and_commercial) {
    validateFact(result.payment_and_commercial.fee_structure, 'payment.fee_structure');
    validateFact(result.payment_and_commercial.rates_and_amounts, 'payment.rates_and_amounts');
    validateFact(result.payment_and_commercial.invoicing_schedule, 'payment.invoicing_schedule');
    validateFact(result.payment_and_commercial.payment_terms_days, 'payment.payment_terms_days');
    validateFact(result.payment_and_commercial.late_payment_terms, 'payment.late_payment_terms');
    validateFact(result.payment_and_commercial.reimbursable_expenses, 'payment.reimbursable_expenses');
    validateFact(result.payment_and_commercial.taxes_and_withholding, 'payment.taxes_and_withholding');
  }

  // 6. Obligations
  if (result.obligations) {
    if (Array.isArray(result.obligations.client_obligations)) {
      result.obligations.client_obligations.forEach((o, idx) => {
        validateFact(o, `obligations.client_obligations[${idx}]`);
      });
    }
    if (Array.isArray(result.obligations.contractor_obligations)) {
      result.obligations.contractor_obligations.forEach((o, idx) => {
        validateFact(o, `obligations.contractor_obligations[${idx}]`);
      });
    }
  }

  // 7. Key Provisions
  if (result.key_provisions) {
    const kp = result.key_provisions;
    if (kp.intellectual_property) {
      validateFact(kp.intellectual_property.ownership, 'ip.ownership');
      validateFact(kp.intellectual_property.pre_existing_ip, 'ip.pre_existing_ip');
      validateFact(kp.intellectual_property.license_granted, 'ip.license_granted');
    }
    if (kp.confidentiality) {
      validateFact(kp.confidentiality.definition, 'confidentiality.definition');
      validateFact(kp.confidentiality.duration, 'confidentiality.duration');
      validateFact(kp.confidentiality.carveouts, 'confidentiality.carveouts');
    }
    validateFact(kp.non_compete, 'non_compete');
    validateFact(kp.non_solicitation, 'non_solicitation');
    validateFact(kp.warranties_and_disclaimers, 'warranties_and_disclaimers');
    if (kp.limitation_of_liability) {
      validateFact(kp.limitation_of_liability.liability_cap, 'liability.liability_cap');
      validateFact(kp.limitation_of_liability.exclusion_of_indirect_damages, 'liability.exclusion_of_indirect_damages');
    }
    if (kp.indemnification) {
      validateFact(kp.indemnification.contractor_indemnification, 'indemnification.contractor');
      validateFact(kp.indemnification.client_indemnification, 'indemnification.client');
    }
    if (kp.termination) {
      validateFact(kp.termination.termination_for_convenience, 'termination.convenience');
      validateFact(kp.termination.termination_for_cause, 'termination.cause');
      validateFact(kp.termination.post_termination_payment, 'termination.post_payment');
    }
    if (kp.dispute_resolution) {
      validateFact(kp.dispute_resolution.method, 'dispute.method');
      validateFact(kp.dispute_resolution.venue_and_forum, 'dispute.venue');
      validateFact(kp.dispute_resolution.prevailing_party_legal_fees, 'dispute.legal_fees');
    }
    validateFact(kp.independent_contractor_affirmation, 'independent_contractor_affirmation');
    validateFact(kp.entire_agreement, 'entire_agreement');
  }

  // 8. Ambiguities & Conflicts evidence
  if (Array.isArray(result.ambiguities_and_conflicts)) {
    for (const item of result.ambiguities_and_conflicts) {
      if (Array.isArray(item.evidence)) {
        for (const ref of item.evidence) {
          totalEvidenceRefs++;
          const val = validateEvidenceReference(ref, elementMap, blockMap);
          ref.is_verified = val.is_verified;
          ref.verification_error = val.error;
          if (val.is_verified) {
            verifiedEvidenceRefs++;
          } else {
            warnings.push(`Evidence verification failed for ambiguity "${item.topic}": ${val.error}`);
          }
        }
      }
    }
  }

  const verificationPercentage =
    totalEvidenceRefs === 0
      ? 100
      : Math.round((verifiedEvidenceRefs / totalEvidenceRefs) * 100);

  result.stats = {
    total_facts: totalFacts,
    verified_facts: verifiedFacts,
    total_evidence_references: totalEvidenceRefs,
    verified_evidence_references: verifiedEvidenceRefs,
    verification_percentage: verificationPercentage,
  };

  result.warnings = warnings;

  return result;
}
