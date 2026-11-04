import {
  NormalizedDocument,
  NormalizedSection,
} from '../normalization/types';
import { DocumentExtractionResult } from '../extraction/types';
import {
  AmbiguityOrConflict,
  ContractClassification,
  ContractDates,
  ContractParty,
  ContractUnderstandingResult,
  EvidenceReference,
  EvidenceStatus,
  FactWithEvidence,
  KeyContractualProvisions,
  OmissionOrMissingTerm,
  PartyObligations,
  PaymentAndCommercialTerms,
  ScopeAndDeliverables,
} from './types';

// Default chunk character boundary
export const CHUNK_CHAR_LIMIT = 3500;

export interface DocumentChunk {
  chunkIndex: number;
  totalChunks: number;
  sectionIds: string[];
  docSubset: NormalizedDocument;
}

/**
 * Splits a normalized document into bounded structural chunks
 * preserving original element IDs, block IDs, and section hierarchy.
 */
export function chunkNormalizedDocument(
  doc: NormalizedDocument,
  maxChunkChars = CHUNK_CHAR_LIMIT
): DocumentChunk[] {
  const sections = doc.sections || [];
  const unclassified = doc.unclassified_blocks || [];

  // If document is small enough to fit within one chunk, return single chunk
  const totalDocChars =
    unclassified.reduce((acc, b) => acc + (b.text?.length || 0), 0) +
    sections.reduce((acc, s) => {
      let len = s.text?.length || 0;
      if (s.children) {
        len += s.children.reduce((cAcc: number, c: any) => cAcc + (c.text?.length || 0), 0);
      }
      return acc + len;
    }, 0);

  if (totalDocChars <= maxChunkChars && sections.length <= 4) {
    return [
      {
        chunkIndex: 0,
        totalChunks: 1,
        sectionIds: sections.map((s) => s.id),
        docSubset: doc,
      },
    ];
  }

  const chunks: DocumentChunk[] = [];
  let currentSections: NormalizedSection[] = [];
  let currentSectionIds: string[] = [];
  let currentCharCount = 0;

  // First chunk always includes unclassified blocks (preamble)
  const firstChunkUnclassified = [...unclassified];
  currentCharCount += firstChunkUnclassified.reduce((acc, b) => acc + (b.text?.length || 0), 0);

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    let secChars = sec.text?.length || 0;
    if (sec.children) {
      secChars += sec.children.reduce((acc: number, c: any) => acc + (c.text?.length || 0), 0);
    }

    // If adding this section exceeds threshold and current chunk has at least one section, push chunk
    if (currentCharCount + secChars > maxChunkChars && currentSections.length > 0) {
      chunks.push({
        chunkIndex: chunks.length,
        totalChunks: 0, // Will be set after loop
        sectionIds: [...currentSectionIds],
        docSubset: {
          ...doc,
          sections: [...currentSections],
          unclassified_blocks: chunks.length === 0 ? firstChunkUnclassified : [],
        },
      });

      currentSections = [];
      currentSectionIds = [];
      currentCharCount = 0;
    }

    currentSections.push(sec);
    currentSectionIds.push(sec.id);
    currentCharCount += secChars;
  }

  // Push remainder chunk
  if (currentSections.length > 0 || chunks.length === 0) {
    chunks.push({
      chunkIndex: chunks.length,
      totalChunks: 0,
      sectionIds: [...currentSectionIds],
      docSubset: {
        ...doc,
        sections: [...currentSections],
        unclassified_blocks: chunks.length === 0 ? firstChunkUnclassified : [],
      },
    });
  }

  // Update totalChunks across all chunks
  const total = chunks.length;
  chunks.forEach((c) => {
    c.totalChunks = total;
  });

  return chunks;
}

/**
 * Deduplicates evidence references based on element_id, source_block_id, and exact_quote.
 */
function deduplicateEvidence(refs: EvidenceReference[]): EvidenceReference[] {
  const seen = new Set<string>();
  const out: EvidenceReference[] = [];
  for (const r of refs) {
    const key = `${r.element_id}::${r.source_block_id}::${r.exact_quote}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

/**
 * Merges two FactWithEvidence instances deterministically.
 * Detects conflicts between differing FOUND statements across chunks.
 * Enforces rule: Cannot be NOT_FOUND unless fully covered.
 */
export function mergeFactWithEvidence(
  existingFact: FactWithEvidence | undefined,
  newFact: FactWithEvidence | undefined,
  topicName: string,
  fullCoverage: boolean,
  conflictsOut: AmbiguityOrConflict[]
): FactWithEvidence {
  if (!existingFact && !newFact) {
    return {
      status: fullCoverage ? 'NOT_FOUND' : 'AMBIGUOUS',
      summary: fullCoverage
        ? 'No provision found in agreement.'
        : 'Analysis incomplete: Document was partially covered.',
      evidence: [],
    };
  }

  if (!existingFact) {
    if (newFact!.status === 'NOT_FOUND' && !fullCoverage) {
      return {
        status: 'AMBIGUOUS',
        summary: 'Provision not identified in analyzed chunks (document coverage was partial).',
        evidence: [],
      };
    }
    return newFact!;
  }

  if (!newFact) {
    if (existingFact.status === 'NOT_FOUND' && !fullCoverage) {
      return {
        status: 'AMBIGUOUS',
        summary: 'Provision not identified in analyzed chunks (document coverage was partial).',
        evidence: [],
      };
    }
    return existingFact;
  }

  // If one is FOUND and the other is NOT_FOUND, FOUND wins!
  if (existingFact.status === 'FOUND' && newFact.status === 'NOT_FOUND') {
    return existingFact;
  }
  if (newFact.status === 'FOUND' && existingFact.status === 'NOT_FOUND') {
    return newFact;
  }

  // If both are NOT_FOUND
  if (existingFact.status === 'NOT_FOUND' && newFact.status === 'NOT_FOUND') {
    if (!fullCoverage) {
      return {
        status: 'AMBIGUOUS',
        summary: 'Provision not found in analyzed sections (document was partially covered).',
        evidence: [],
      };
    }
    return existingFact;
  }

  // If both are FOUND, check for contradiction or merge evidence
  if (existingFact.status === 'FOUND' && newFact.status === 'FOUND') {
    const combinedEvidence = deduplicateEvidence([
      ...(existingFact.evidence || []),
      ...(newFact.evidence || []),
    ]);

    const s1 = existingFact.summary.trim().toLowerCase();
    const s2 = newFact.summary.trim().toLowerCase();

    // Check if summaries contradict each other
    if (s1 !== s2 && !s1.includes(s2) && !s2.includes(s1)) {
      const conflictDescription = `Conflicting terms detected across document sections: "${existingFact.summary}" vs "${newFact.summary}".`;
      conflictsOut.push({
        topic: topicName,
        description: conflictDescription,
        evidence: combinedEvidence,
      });

      return {
        status: 'CONFLICTING',
        summary: conflictDescription,
        evidence: combinedEvidence,
        notes: `Cross-section contradiction between: [${existingFact.summary}] and [${newFact.summary}]`,
      };
    }

    return {
      status: 'FOUND',
      summary: existingFact.summary.length >= newFact.summary.length ? existingFact.summary : newFact.summary,
      evidence: combinedEvidence,
    };
  }

  // Default fallback merge
  return existingFact.status === 'FOUND' ? existingFact : newFact;
}

/**
 * Deterministically merges understanding results from multiple chunks.
 */
export function mergeChunkResults(
  chunkResults: ContractUnderstandingResult[],
  totalDocumentSections: number,
  allDocumentSectionIds: string[]
): ContractUnderstandingResult {
  if (chunkResults.length === 0) {
    throw new Error('No chunk results to merge.');
  }

  if (chunkResults.length === 1) {
    const single = chunkResults[0];
    const coveredSecs = single.processed_sections || allDocumentSectionIds;
    const isFull = coveredSecs.length >= totalDocumentSections;
    single.processed_sections = coveredSecs;
    single.total_sections_in_document = totalDocumentSections;
    single.coverage_percentage = totalDocumentSections === 0 ? 100 : Math.round((coveredSecs.length / totalDocumentSections) * 100);
    if (!isFull) {
      single.processing_status = 'PARTIAL';
      single.warnings.push(
        `Partial document coverage: ${coveredSecs.length} of ${totalDocumentSections} sections analyzed.`
      );
    }
    return single;
  }

  // Aggregate covered section IDs across all chunks
  const processedSectionsSet = new Set<string>();
  const warnings: string[] = [];
  const crossChunkConflicts: AmbiguityOrConflict[] = [];

  for (const cr of chunkResults) {
    if (cr.processed_sections) {
      for (const id of cr.processed_sections) {
        processedSectionsSet.add(id);
      }
    }
    if (cr.warnings) {
      warnings.push(...cr.warnings);
    }
  }

  const processedSections = Array.from(processedSectionsSet);
  const isFullCoverage =
    totalDocumentSections === 0 || processedSections.length >= totalDocumentSections;
  const coveragePercentage =
    totalDocumentSections === 0
      ? 100
      : Math.round((processedSections.length / totalDocumentSections) * 100);

  // 1. Classification (select result with highest confidence)
  let bestClassification: ContractClassification = chunkResults[0].classification;
  for (const cr of chunkResults) {
    if (cr.classification && cr.classification.confidence > (bestClassification?.confidence || 0)) {
      bestClassification = cr.classification;
    }
  }

  // 2. Parties (merge and deduplicate)
  const partyMap = new Map<string, ContractParty>();
  for (const cr of chunkResults) {
    if (Array.isArray(cr.parties)) {
      for (const p of cr.parties) {
        const key = (p.name || p.defined_term || '').trim().toLowerCase();
        if (!partyMap.has(key)) {
          partyMap.set(key, { ...p, evidence: [...(p.evidence || [])] });
        } else {
          const existing = partyMap.get(key)!;
          existing.evidence = deduplicateEvidence([...existing.evidence, ...(p.evidence || [])]);
        }
      }
    }
  }

  // Helper to merge facts across all chunks
  function mergeAcrossChunks(
    extractFact: (r: ContractUnderstandingResult) => FactWithEvidence | undefined,
    topic: string
  ): FactWithEvidence {
    let acc: FactWithEvidence | undefined;
    for (const cr of chunkResults) {
      const f = extractFact(cr);
      acc = mergeFactWithEvidence(acc, f, topic, isFullCoverage, crossChunkConflicts);
    }
    return acc!;
  }

  // 3. Dates & Term
  const dates_and_term: ContractDates = {
    effective_date: mergeAcrossChunks((r) => r.dates_and_term?.effective_date, 'Effective Date'),
    execution_date: mergeAcrossChunks((r) => r.dates_and_term?.execution_date, 'Execution Date'),
    commencement_date: mergeAcrossChunks((r) => r.dates_and_term?.commencement_date, 'Commencement Date'),
    expiration_date: mergeAcrossChunks((r) => r.dates_and_term?.expiration_date, 'Expiration Date'),
    term_duration: mergeAcrossChunks((r) => r.dates_and_term?.term_duration, 'Term Duration'),
    renewal_terms: mergeAcrossChunks((r) => r.dates_and_term?.renewal_terms, 'Renewal Terms'),
  };

  // 4. Scope & Deliverables
  const deliverablesList: FactWithEvidence[] = [];
  const seenDelivSummaries = new Set<string>();
  for (const cr of chunkResults) {
    if (cr.scope_and_deliverables?.deliverables) {
      for (const d of cr.scope_and_deliverables.deliverables) {
        const key = d.summary.trim().toLowerCase();
        if (!seenDelivSummaries.has(key)) {
          seenDelivSummaries.add(key);
          deliverablesList.push(d);
        }
      }
    }
  }

  const scope_and_deliverables: ScopeAndDeliverables = {
    scope_description: mergeAcrossChunks(
      (r) => r.scope_and_deliverables?.scope_description,
      'Scope Description'
    ),
    deliverables: deliverablesList,
    change_order_mechanism: mergeAcrossChunks(
      (r) => r.scope_and_deliverables?.change_order_mechanism,
      'Change Order Mechanism'
    ),
    acceptance_criteria: mergeAcrossChunks(
      (r) => r.scope_and_deliverables?.acceptance_criteria,
      'Acceptance Criteria'
    ),
  };

  // 5. Payment & Commercial Terms
  const payment_and_commercial: PaymentAndCommercialTerms = {
    fee_structure: mergeAcrossChunks((r) => r.payment_and_commercial?.fee_structure, 'Fee Structure'),
    rates_and_amounts: mergeAcrossChunks((r) => r.payment_and_commercial?.rates_and_amounts, 'Rates & Amounts'),
    invoicing_schedule: mergeAcrossChunks((r) => r.payment_and_commercial?.invoicing_schedule, 'Invoicing Schedule'),
    payment_terms_days: mergeAcrossChunks((r) => r.payment_and_commercial?.payment_terms_days, 'Payment Terms'),
    late_payment_terms: mergeAcrossChunks((r) => r.payment_and_commercial?.late_payment_terms, 'Late Payment Penalties'),
    reimbursable_expenses: mergeAcrossChunks((r) => r.payment_and_commercial?.reimbursable_expenses, 'Reimbursable Expenses'),
    taxes_and_withholding: mergeAcrossChunks((r) => r.payment_and_commercial?.taxes_and_withholding, 'Taxes & Withholding'),
  };

  // 6. Obligations
  const clientObs: FactWithEvidence[] = [];
  const contractorObs: FactWithEvidence[] = [];
  const seenClientObs = new Set<string>();
  const seenContractorObs = new Set<string>();

  for (const cr of chunkResults) {
    if (cr.obligations?.client_obligations) {
      for (const o of cr.obligations.client_obligations) {
        const key = o.summary.trim().toLowerCase();
        if (!seenClientObs.has(key)) {
          seenClientObs.add(key);
          clientObs.push(o);
        }
      }
    }
    if (cr.obligations?.contractor_obligations) {
      for (const o of cr.obligations.contractor_obligations) {
        const key = o.summary.trim().toLowerCase();
        if (!seenContractorObs.has(key)) {
          seenContractorObs.add(key);
          contractorObs.push(o);
        }
      }
    }
  }

  const obligations: PartyObligations = {
    client_obligations: clientObs,
    contractor_obligations: contractorObs,
  };

  // 7. Key Provisions
  const key_provisions: KeyContractualProvisions = {
    intellectual_property: {
      ownership: mergeAcrossChunks((r) => r.key_provisions?.intellectual_property?.ownership, 'IP Ownership'),
      pre_existing_ip: mergeAcrossChunks((r) => r.key_provisions?.intellectual_property?.pre_existing_ip, 'Pre-Existing IP'),
      license_granted: mergeAcrossChunks((r) => r.key_provisions?.intellectual_property?.license_granted, 'IP License'),
    },
    confidentiality: {
      definition: mergeAcrossChunks((r) => r.key_provisions?.confidentiality?.definition, 'Confidentiality Definition'),
      duration: mergeAcrossChunks((r) => r.key_provisions?.confidentiality?.duration, 'Confidentiality Duration'),
      carveouts: mergeAcrossChunks((r) => r.key_provisions?.confidentiality?.carveouts, 'Confidentiality Carveouts'),
    },
    non_compete: mergeAcrossChunks((r) => r.key_provisions?.non_compete, 'Non-Compete'),
    non_solicitation: mergeAcrossChunks((r) => r.key_provisions?.non_solicitation, 'Non-Solicitation'),
    warranties_and_disclaimers: mergeAcrossChunks((r) => r.key_provisions?.warranties_and_disclaimers, 'Warranties'),
    limitation_of_liability: {
      liability_cap: mergeAcrossChunks((r) => r.key_provisions?.limitation_of_liability?.liability_cap, 'Liability Cap'),
      exclusion_of_indirect_damages: mergeAcrossChunks(
        (r) => r.key_provisions?.limitation_of_liability?.exclusion_of_indirect_damages,
        'Indirect Damages Exclusion'
      ),
    },
    indemnification: {
      contractor_indemnification: mergeAcrossChunks(
        (r) => r.key_provisions?.indemnification?.contractor_indemnification,
        'Contractor Indemnification'
      ),
      client_indemnification: mergeAcrossChunks(
        (r) => r.key_provisions?.indemnification?.client_indemnification,
        'Client Indemnification'
      ),
    },
    termination: {
      termination_for_convenience: mergeAcrossChunks(
        (r) => r.key_provisions?.termination?.termination_for_convenience,
        'Termination for Convenience'
      ),
      termination_for_cause: mergeAcrossChunks(
        (r) => r.key_provisions?.termination?.termination_for_cause,
        'Termination for Cause'
      ),
      post_termination_payment: mergeAcrossChunks(
        (r) => r.key_provisions?.termination?.post_termination_payment,
        'Post-Termination Compensation'
      ),
    },
    dispute_resolution: {
      method: mergeAcrossChunks((r) => r.key_provisions?.dispute_resolution?.method, 'Dispute Resolution Method'),
      venue_and_forum: mergeAcrossChunks((r) => r.key_provisions?.dispute_resolution?.venue_and_forum, 'Venue & Forum'),
      prevailing_party_legal_fees: mergeAcrossChunks(
        (r) => r.key_provisions?.dispute_resolution?.prevailing_party_legal_fees,
        'Legal Fees'
      ),
    },
    independent_contractor_affirmation: mergeAcrossChunks(
      (r) => r.key_provisions?.independent_contractor_affirmation,
      'Independent Contractor Affirmation'
    ),
    entire_agreement: mergeAcrossChunks((r) => r.key_provisions?.entire_agreement, 'Entire Agreement'),
  };

  // 8. Ambiguities & Conflicts
  const allAmbiguities: AmbiguityOrConflict[] = [...crossChunkConflicts];
  for (const cr of chunkResults) {
    if (Array.isArray(cr.ambiguities_and_conflicts)) {
      allAmbiguities.push(...cr.ambiguities_and_conflicts);
    }
  }

  // 9. Omissions: ONLY record omissions if document was 100% covered!
  const omissions: OmissionOrMissingTerm[] = [];
  if (isFullCoverage) {
    if (payment_and_commercial.late_payment_terms?.status === 'NOT_FOUND') {
      omissions.push({
        provision_name: 'Late Payment Penalties / Interest',
        explanation: 'No interest or penalty fee is specified for overdue client invoices across all sections.',
      });
    }
    if (key_provisions.non_compete?.status === 'NOT_FOUND') {
      omissions.push({
        provision_name: 'Non-Compete Restriction',
        explanation: 'The contract does not contain a restrictive covenant or non-compete clause.',
      });
    }
    if (scope_and_deliverables.acceptance_criteria?.status === 'NOT_FOUND') {
      omissions.push({
        provision_name: 'Deliverable Acceptance Procedure',
        explanation: 'No formal inspection timeline or acceptance/rejection criteria is defined.',
      });
    }
  } else {
    warnings.push(
      `Document was only partially processed (${coveragePercentage}% coverage). Omissions cannot be confirmed without complete document coverage.`
    );
  }

  const baseResult = chunkResults[0];

  return {
    document_id: baseResult.document_id,
    source_file_id: baseResult.source_file_id,
    verified_sha256: baseResult.verified_sha256,
    classification: bestClassification,
    parties: Array.from(partyMap.values()),
    dates_and_term,
    scope_and_deliverables,
    payment_and_commercial,
    obligations,
    key_provisions,
    ambiguities_and_conflicts: allAmbiguities,
    omissions_and_missing_terms: omissions,
    stats: {
      total_facts: 0,
      verified_facts: 0,
      verification_percentage: 100,
      total_evidence_references: 0,
      verified_evidence_references: 0,
    },
    processing_status: isFullCoverage ? 'COMPLETE' : 'PARTIAL',
    analysis_source: baseResult.analysis_source || 'GEMINI',
    model_used: baseResult.model_used,
    analyzed_at: new Date().toISOString(),
    processed_sections: processedSections,
    total_sections_in_document: totalDocumentSections,
    coverage_percentage: coveragePercentage,
    warnings: Array.from(new Set(warnings)),
  };
}
