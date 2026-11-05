import { DocumentExtractionResult, ExtractedBlock } from '../extraction/types';
import { NormalizedDocument } from '../normalization/types';
import {
  buildExtractionBlockMap,
  buildNormalizedElementMap,
  validateEvidenceReference,
} from '../understanding/evidenceValidator';
import { ClauseIndex } from '../risk/clauseIndex';
import { FindingEvidence } from '../risk/types';
import { ReportEvidence, Statement } from './types';

/**
 * Turns the pipeline's evidence into report evidence (with a display reference) and is the final gate that
 * re-verifies every quote with the SAME validator the understanding stage uses. No second mechanism.
 */
export class Resolver {
  private readonly blocks: Map<string, ExtractedBlock>;
  private readonly isPdf: boolean;

  constructor(
    normalized: NormalizedDocument,
    extraction: DocumentExtractionResult,
    private readonly clauses: ClauseIndex
  ) {
    this.blocks = buildExtractionBlockMap(extraction);
    this.isPdf = normalized.source_format === 'pdf';
  }

  evidence(e: FindingEvidence): ReportEvidence {
    const block = this.blocks.get(e.source_block_id);
    const label = e.clause_label ?? this.clauses.get(e.element_id)?.label;
    // Real page numbers only for PDF. TXT always reports page 1 and DOCX has none, so they get structural references.
    const page = this.isPdf && typeof block?.page_number === 'number' ? block.page_number : undefined;
    const structural = block?.structural_ref;
    const where = label ?? structural ?? e.element_id;
    return {
      element_id: e.element_id,
      source_block_id: e.source_block_id,
      exact_quote: e.exact_quote,
      ...(label ? { clause_label: label } : {}),
      reference: page !== undefined ? `p. ${page} · ${where}` : where,
      ...(page !== undefined ? { page } : {}),
      ...(structural ? { structural_ref: structural } : {}),
    };
  }

  list(es: FindingEvidence[] | undefined, limit = 4): ReportEvidence[] {
    const seen = new Set<string>();
    const out: ReportEvidence[] = [];
    for (const e of es || []) {
      const key = `${e.element_id}::${e.source_block_id}::${e.exact_quote}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(this.evidence(e));
      if (out.length >= limit) break;
    }
    return out;
  }
}

export function makeVerifier(normalized: NormalizedDocument, extraction: DocumentExtractionResult) {
  const elements = buildNormalizedElementMap(normalized);
  const blocks = buildExtractionBlockMap(extraction);
  return (e: { element_id: string; source_block_id: string; exact_quote: string }): boolean =>
    validateEvidenceReference(
      { element_id: e.element_id, source_block_id: e.source_block_id, exact_quote: e.exact_quote },
      elements,
      blocks
    ).is_verified;
}

const EVIDENCE_KEYS = new Set(['evidence', 'trigger_evidence', 'contract_reference']);

/**
 * Final evidence gate. Walks the whole report and:
 *  - removes any quote that fails verification (and records a warning);
 *  - downgrades anything that claims `explicit` / `conflicting` but is left without verified evidence to `unclear`,
 *    flagged `evidence_unverified`, so it is never presented as a confirmed contractual fact.
 * Mutates and returns the report.
 */
export function gateEvidence<T>(report: T, verify: (e: ReportEvidence) => boolean): { report: T; warnings: string[] } {
  const warnings: string[] = [];

  const visit = (node: any, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => visit(child, `${path}[${i}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;

    for (const key of Object.keys(node)) {
      const value = node[key];
      if (EVIDENCE_KEYS.has(key) && Array.isArray(value)) {
        const kept = value.filter((e: ReportEvidence) => {
          const ok = verify(e);
          if (!ok) warnings.push(`Evidence removed at ${path}.${key}: quote could not be verified word-for-word.`);
          return ok;
        });
        node[key] = kept;
      }
    }

    // Items (status) and statements (basis) that rest on evidence
    const evidence: ReportEvidence[] | undefined = Array.isArray(node.evidence) ? node.evidence : undefined;
    if (evidence && evidence.length === 0) {
      if (node.status === 'explicit' || node.status === 'conflicting') {
        warnings.push(`${path}: "${node.status}" downgraded to "unclear" (no verified evidence).`);
        node.status = 'unclear';
        node.evidence_unverified = true;
      }
      if (node.basis === 'explicit' || node.basis === 'conflicting') {
        warnings.push(`${path}: "${node.basis}" statement downgraded to "unclear" (no verified evidence).`);
        node.basis = 'unclear';
        node.evidence_unverified = true;
      }
    }
    for (const key of Object.keys(node)) visit(node[key], `${path}.${key}`);
  };
  visit(report, '$');
  return { report, warnings };
}

// ---------------------------------------------------------------------------
// Statement factories: the only way report text about the contract is created
// ---------------------------------------------------------------------------
export const stmt = {
  explicit: (text: string, evidence: ReportEvidence[]): Statement => ({ text, basis: 'explicit', evidence }),
  unclear: (text: string, evidence: ReportEvidence[]): Statement => ({ text, basis: 'unclear', evidence }),
  conflicting: (text: string, evidence: ReportEvidence[]): Statement => ({ text, basis: 'conflicting', evidence }),
  /** The contract does not say it. No evidence, by definition. */
  notStated: (text: string): Statement => ({ text, basis: 'not_in_contract', evidence: [] }),
  /** Depends on law/facts outside the contract. Never asserts a right. */
  outside: (text: string): Statement => ({ text, basis: 'outside_contract', evidence: [] }),
  calculated: (text: string, evidence: ReportEvidence[]): Statement => ({ text, basis: 'unclear', evidence, calculated: true }),
};

export const OUTSIDE_CONTRACT_NOTE =
  'Rights and remedies that the law may give you outside this contract are not assessed in this report. Whether any apply depends on where you and the client are based and on facts this report cannot see.';
