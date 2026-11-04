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

/**
 * Recursively collects all source block IDs associated with a normalized element
 * and its children/descendants.
 */
export function getAllAssociatedBlockIds(element: BaseNormalizedElement): Set<string> {
  const ids = new Set<string>();

  function collect(node: any) {
    if (!node) return;
    if (Array.isArray(node.source_block_ids)) {
      for (const id of node.source_block_ids) {
        if (id) ids.add(id);
      }
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        collect(child);
      }
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        collect(child);
      }
    }
    if (Array.isArray(node.items)) {
      for (const item of node.items) {
        collect(item);
      }
    }
  }

  collect(element);
  return ids;
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
 * Strict rules:
 * 1. Element ID must exist in normalized hierarchy.
 * 2. Source block ID must exist in extraction blocks.
 * 3. Source block ID MUST be associated with the referenced element (via source_block_ids or descendant tree).
 * 4. Exact quote MUST be an exact verbatim substring of the original extracted block text.
 *    Does NOT accept whitespace-normalized, punctuation-normalized, or element-only matches.
 */
export function validateEvidenceReference(
  ref: EvidenceReference,
  elementMap: Map<string, BaseNormalizedElement>,
  blockMap: Map<string, ExtractedBlock>
): { is_verified: boolean; error?: string } {
  if (!ref) {
    return { is_verified: false, error: 'Empty evidence reference.' };
  }

  // 1. Verify Element ID exists
  if (!ref.element_id || typeof ref.element_id !== 'string') {
    return {
      is_verified: false,
      error: 'Missing or invalid element_id.',
    };
  }

  if (!elementMap.has(ref.element_id)) {
    return {
      is_verified: false,
      error: `Referenced element ID "${ref.element_id}" does not exist in normalized document hierarchy.`,
    };
  }

  const element = elementMap.get(ref.element_id)!;

  // 2. Verify Source Block ID exists
  if (!ref.source_block_id || typeof ref.source_block_id !== 'string') {
    return {
      is_verified: false,
      error: 'Missing or invalid source_block_id.',
    };
  }

  if (!blockMap.has(ref.source_block_id)) {
    return {
      is_verified: false,
      error: `Referenced source block ID "${ref.source_block_id}" does not exist in extraction blocks.`,
    };
  }

  const block = blockMap.get(ref.source_block_id)!;

  // 3. Verify that the source block is actually associated with the referenced normalized element
  const associatedBlocks = getAllAssociatedBlockIds(element);
  if (!associatedBlocks.has(ref.source_block_id)) {
    return {
      is_verified: false,
      error: `Source block "${ref.source_block_id}" is not associated with normalized element "${ref.element_id}".`,
    };
  }

  // 4. Verify Exact Quote (must be exact raw substring of referenced block text)
  if (typeof ref.exact_quote !== 'string' || ref.exact_quote.length === 0) {
    return {
      is_verified: false,
      error: 'Evidence reference has an empty quote string.',
    };
  }

  // Strict exact substring requirement - do NOT accept whitespace or punctuation normalized matches
  if (!block.text || !block.text.includes(ref.exact_quote)) {
    return {
      is_verified: false,
      error: `Quote text "${ref.exact_quote.slice(0, 60)}${ref.exact_quote.length > 60 ? '...' : ''}" does not appear as a verbatim substring of source block "${ref.source_block_id}".`,
    };
  }

  return { is_verified: true };
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

    // NOT_FOUND and NOT_APPLICABLE are verified if they have no evidence references
    if (fact.status === 'NOT_FOUND' || fact.status === 'NOT_APPLICABLE') {
      if (!fact.evidence || fact.evidence.length === 0) {
        verifiedFacts++;
      } else {
        // If it claims NOT_FOUND but provides evidence, validate that evidence
        let allVerified = true;
        for (const ref of fact.evidence) {
          totalEvidenceRefs++;
          const val = validateEvidenceReference(ref, elementMap, blockMap);
          ref.is_verified = val.is_verified;
          ref.verification_error = val.error;
          if (val.is_verified) {
            verifiedEvidenceRefs++;
          } else {
            allVerified = false;
            warnings.push(`Evidence verification failed for ${path}: ${val.error}`);
          }
        }
        if (allVerified) {
          verifiedFacts++;
        }
      }
      return;
    }

    // A fact with status FOUND or AMBIGUOUS/CONFLICTING with NO evidence is NEVER verified!
    if (!fact.evidence || fact.evidence.length === 0) {
      warnings.push(`Fact "${path}" is marked ${fact.status} but provides no evidence references.`);
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

  // 2. Parties (counted in total facts and verification statistics)
  if (Array.isArray(result.parties)) {
    for (let i = 0; i < result.parties.length; i++) {
      const p = result.parties[i];
      totalFacts++;

      if (!p.evidence || p.evidence.length === 0) {
        warnings.push(`Party "${p.name || 'unnamed'}" provides no evidence references.`);
      } else {
        let partyAllVerified = true;
        for (const ref of p.evidence) {
          totalEvidenceRefs++;
          const val = validateEvidenceReference(ref, elementMap, blockMap);
          ref.is_verified = val.is_verified;
          ref.verification_error = val.error;
          if (val.is_verified) {
            verifiedEvidenceRefs++;
          } else {
            partyAllVerified = false;
            warnings.push(`Evidence verification failed for party "${p.name}": ${val.error}`);
          }
        }
        if (partyAllVerified) {
          verifiedFacts++;
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

  // 8. Ambiguities & Conflicts evidence (counted in total facts and verification statistics)
  if (Array.isArray(result.ambiguities_and_conflicts)) {
    for (const item of result.ambiguities_and_conflicts) {
      totalFacts++;
      if (!item.evidence || item.evidence.length === 0) {
        warnings.push(`Ambiguity "${item.topic}" provides no evidence references.`);
      } else {
        let itemAllVerified = true;
        for (const ref of item.evidence) {
          totalEvidenceRefs++;
          const val = validateEvidenceReference(ref, elementMap, blockMap);
          ref.is_verified = val.is_verified;
          ref.verification_error = val.error;
          if (val.is_verified) {
            verifiedEvidenceRefs++;
          } else {
            itemAllVerified = false;
            warnings.push(`Evidence verification failed for ambiguity "${item.topic}": ${val.error}`);
          }
        }
        if (itemAllVerified) {
          verifiedFacts++;
        }
      }
    }
  }

  const factPercentage =
    totalFacts === 0 ? 100 : Math.round((verifiedFacts / totalFacts) * 100);
  const evidencePercentage =
    totalEvidenceRefs === 0
      ? 100
      : Math.round((verifiedEvidenceRefs / totalEvidenceRefs) * 100);

  const verificationPercentage = Math.min(factPercentage, evidencePercentage);

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
