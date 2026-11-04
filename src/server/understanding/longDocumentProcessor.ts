import {
  NormalizedDocument,
  NormalizedSection,
} from '../normalization/types';
import { DocumentExtractionResult } from '../extraction/types';
import { compareFoundFacts } from './conflictDetector';
import { INTELLIGENCE_GROUP_KEYS, INTELLIGENCE_SCHEMA, IntelligenceField } from './intelligenceSchema';
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

export type PreambleBlock = NormalizedDocument['unclassified_blocks'][number];

export interface DocumentChunk {
  chunkIndex: number;
  totalChunks: number;
  /**
   * IDs of the sections ANALYZED in this chunk. This is the only source of
   * truth for coverage accounting; shared context is never included here.
   */
  sectionIds: string[];
  /**
   * The content this chunk is responsible for analyzing. `sections` is the
   * chunk's own slice; `unclassified_blocks` holds the preamble only when the
   * preamble is itself analyzed here (chunk 0 / single-chunk documents).
   */
  docSubset: NormalizedDocument;
  /**
   * Read-only preamble / unclassified blocks supplied to chunks that do NOT
   * analyze them (chunk 1..n) so party names, defined terms and effective
   * dates stay available. These are the original block objects (original
   * element IDs and source block IDs preserved) and are NOT sections under
   * analysis. Empty when the preamble is already part of `docSubset`.
   */
  sharedContext: PreambleBlock[];
}

function textLength(node: { text?: string } | undefined): number {
  return node?.text?.length || 0;
}

function sectionCharCount(sec: NormalizedSection): number {
  let len = textLength(sec);
  if (sec.children) {
    len += sec.children.reduce((acc: number, c: any) => acc + textLength(c), 0);
  }
  return len;
}

/**
 * Splits a normalized document into bounded structural chunks
 * preserving original element IDs, block IDs, and section hierarchy.
 *
 * The preamble / unclassified blocks may hold party names, effective dates and
 * defined terms. They are analyzed once (in chunk 0) and supplied to every
 * later chunk as read-only `sharedContext`, so they are never lost and never
 * counted as a section or analyzed twice.
 */
export function chunkNormalizedDocument(
  doc: NormalizedDocument,
  maxChunkChars = CHUNK_CHAR_LIMIT
): DocumentChunk[] {
  const sections = doc.sections || [];
  const unclassified = doc.unclassified_blocks || [];
  const preambleChars = unclassified.reduce((acc, b) => acc + textLength(b), 0);

  const totalDocChars =
    preambleChars + sections.reduce((acc, s) => acc + sectionCharCount(s), 0);

  // If document is small enough to fit within one chunk, return single chunk
  if (totalDocChars <= maxChunkChars && sections.length <= 4) {
    return [
      {
        chunkIndex: 0,
        totalChunks: 1,
        sectionIds: sections.map((s) => s.id),
        docSubset: doc,
        sharedContext: [],
      },
    ];
  }

  // Every chunk carries the preamble (as primary content in chunk 0, as shared
  // context afterwards), so reserve its size in each chunk's budget. A floor of
  // half the limit guarantees progress even with a very large preamble.
  const sectionBudget = Math.max(maxChunkChars - preambleChars, Math.floor(maxChunkChars / 2));

  const chunks: DocumentChunk[] = [];
  let currentSections: NormalizedSection[] = [];
  let currentCharCount = 0;

  const flush = () => {
    const isFirst = chunks.length === 0;
    chunks.push({
      chunkIndex: chunks.length,
      totalChunks: 0, // Set after loop
      sectionIds: currentSections.map((s) => s.id),
      docSubset: {
        ...doc,
        sections: [...currentSections],
        // Preamble is analyzed exactly once, in the first chunk.
        unclassified_blocks: isFirst ? [...unclassified] : [],
      },
      sharedContext: isFirst ? [] : [...unclassified],
    });
    currentSections = [];
    currentCharCount = 0;
  };

  for (const sec of sections) {
    const secChars = sectionCharCount(sec);
    if (currentCharCount + secChars > sectionBudget && currentSections.length > 0) {
      flush();
    }
    currentSections.push(sec);
    currentCharCount += secChars;
  }

  if (currentSections.length > 0 || chunks.length === 0) {
    flush();
  }

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

const PARTIAL_COVERAGE_PLACEHOLDER: FactWithEvidence = {
  status: 'AMBIGUOUS',
  summary: 'Provision not identified in analyzed chunks (document coverage was partial).',
  evidence: [],
};

/** Statuses that carry an actual finding the merge must never lose. */
const FINDING_RANK: Partial<Record<EvidenceStatus, number>> = {
  CONFLICTING: 3,
  AMBIGUOUS: 2,
  FOUND: 1,
};

function isEmptyPlaceholder(f: FactWithEvidence): boolean {
  return f.status === 'AMBIGUOUS' && (f.evidence || []).length === 0;
}

/**
 * Merges two FactWithEvidence instances deterministically.
 *
 * Two FOUND facts are NOT conflicting merely because they are worded
 * differently: they are compared by `compareFoundFacts` (same topic, same
 * situation, comparable value). Compatible facts keep all their evidence;
 * genuine incompatibilities become CONFLICTING; undecidable ones AMBIGUOUS.
 * Existing CONFLICTING / AMBIGUOUS findings are never overwritten by a later
 * FOUND / NOT_FOUND chunk result.
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

  const only = existingFact || newFact;
  if (!existingFact || !newFact) {
    if (only!.status === 'NOT_FOUND' && !fullCoverage) {
      return { ...PARTIAL_COVERAGE_PLACEHOLDER, evidence: [] };
    }
    return only!;
  }

  // Both NOT_FOUND
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

  // A real finding beats NOT_FOUND / NOT_APPLICABLE / empty partial-coverage placeholders.
  const rankOf = (f: FactWithEvidence) =>
    isEmptyPlaceholder(f) ? 0 : FINDING_RANK[f.status] || 0;
  const rankExisting = rankOf(existingFact);
  const rankNew = rankOf(newFact);
  if (rankExisting === 0 || rankNew === 0) {
    if (rankExisting === 0 && rankNew === 0) return existingFact;
    return rankExisting === 0 ? newFact : existingFact;
  }

  const combinedEvidence = deduplicateEvidence([
    ...(existingFact.evidence || []),
    ...(newFact.evidence || []),
  ]);

  // Two FOUND facts: decide compatible / conflicting / undecidable.
  if (existingFact.status === 'FOUND' && newFact.status === 'FOUND') {
    const s1 = existingFact.summary.trim().toLowerCase();
    const s2 = newFact.summary.trim().toLowerCase();

    if (s1 === s2 || s1.includes(s2) || s2.includes(s1)) {
      return {
        status: 'FOUND',
        summary: existingFact.summary.length >= newFact.summary.length ? existingFact.summary : newFact.summary,
        evidence: combinedEvidence,
      };
    }

    const relation = compareFoundFacts(topicName, existingFact, newFact);

    if (relation.kind === 'CONFLICT') {
      const description = `Conflicting terms for ${topicName} across document sections (${relation.detail}): "${existingFact.summary}" vs "${newFact.summary}".`;
      conflictsOut.push({ topic: topicName, description, evidence: combinedEvidence });
      return {
        status: 'CONFLICTING',
        summary: description,
        evidence: combinedEvidence,
        notes: `Incompatible provisions: [${existingFact.summary}] and [${newFact.summary}]`,
      };
    }

    if (relation.kind === 'UNCERTAIN') {
      const description = `Unable to confirm whether provisions for ${topicName} are compatible (${relation.detail}): "${existingFact.summary}" and "${newFact.summary}".`;
      conflictsOut.push({ topic: topicName, description, evidence: combinedEvidence });
      return {
        status: 'AMBIGUOUS',
        summary: description,
        evidence: combinedEvidence,
        notes: `Review provisions: [${existingFact.summary}] and [${newFact.summary}]`,
      };
    }

    // Compatible: keep both statements and all evidence.
    return {
      status: 'FOUND',
      summary: `${existingFact.summary.trim()}; ${newFact.summary.trim()}`,
      evidence: combinedEvidence,
    };
  }

  // At least one side is already AMBIGUOUS / CONFLICTING: keep the stronger
  // finding (it is sticky) and attach the other side's evidence.
  const winner = rankExisting >= rankNew ? existingFact : newFact;
  return { ...winner, evidence: combinedEvidence };
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

  // 1. Classification (select result with highest confidence; governing
  //    jurisdiction is merged across all chunks so conflicts are detected)
  let bestClassification: ContractClassification = chunkResults[0].classification;
  for (const cr of chunkResults) {
    if (cr.classification && cr.classification.confidence > (bestClassification?.confidence || 0)) {
      bestClassification = cr.classification;
    }
  }
  const classification: ContractClassification = {
    ...bestClassification,
    governing_jurisdiction: mergeAcrossChunks(
      (r) => r.classification?.governing_jurisdiction,
      'Governing Jurisdiction'
    ),
  };

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

  // 7b. Contractor-intelligence groups: merged field by field with the same conflict handling
  const intelligence: Record<string, Record<string, FactWithEvidence>> = {};
  for (const group of INTELLIGENCE_GROUP_KEYS) {
    intelligence[group] = {};
    for (const [field, meta] of Object.entries(INTELLIGENCE_SCHEMA[group])) {
      intelligence[group][field] = mergeAcrossChunks(
        (r) => (r as any)[group]?.[field],
        (meta as IntelligenceField).topic
      );
    }
  }

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
    classification,
    parties: Array.from(partyMap.values()),
    dates_and_term,
    scope_and_deliverables,
    payment_and_commercial,
    obligations,
    key_provisions,
    ...(intelligence as any),
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
