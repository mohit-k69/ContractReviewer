import { getCachedNormalization } from '../normalization/normalizationService';
import { getCachedExtraction } from '../extraction/extractionService';
import { understandContractDocument, getCachedUnderstanding } from '../understanding/understandingService';
import { ContractUnderstandingResult } from '../understanding/types';
import { buildClauseIndex } from './clauseIndex';
import { analyzeContractRisk } from './riskEngine';
import { ContractRiskReport } from './types';

export interface RiskReportResponse {
  success: boolean;
  authorized: boolean;
  report?: ContractRiskReport;
  /** The verified Phase 2C understanding the report was built from (already cached; never recomputed) */
  understanding?: ContractUnderstandingResult;
  error?: string;
}

function buildReport(
  understanding: ContractUnderstandingResult,
  fileId: string,
  sessionId: string
): ContractRiskReport {
  // Phase 2A/2B results are already cached by the understanding step; they are only used for clause
  // labels and to cross-check "missing provision" claims against the actual document text.
  const normalized = getCachedNormalization(fileId, sessionId).result;
  const extraction = getCachedExtraction(fileId, sessionId).result;
  return analyzeContractRisk(understanding, buildClauseIndex(normalized, extraction));
}

/**
 * Generates the Phase 3 review report.
 * Delegates ALL authorization, security-status, SHA-256 integrity, extraction, normalization and
 * understanding work to the existing services; it never re-runs them when a result is cached.
 */
export async function generateRiskReport(fileId: string, sessionId: string): Promise<RiskReportResponse> {
  const understanding = await understandContractDocument(fileId, sessionId);
  if (!understanding.authorized) {
    return { success: false, authorized: false, error: understanding.error || 'Access denied: Session ownership mismatch.' };
  }
  if (!understanding.success || !understanding.result) {
    return { success: false, authorized: true, error: understanding.error || 'Contract understanding failed.' };
  }
  return {
    success: true,
    authorized: true,
    report: buildReport(understanding.result, fileId, sessionId),
    understanding: understanding.result,
  };
}

/** Builds the report from an already-cached understanding result only (never triggers analysis). */
export function getCachedRiskReport(
  fileId: string,
  sessionId: string
): RiskReportResponse & { exists: boolean } {
  const cached = getCachedUnderstanding(fileId, sessionId);
  if (!cached.authorized) {
    return { success: false, authorized: false, exists: false, error: cached.error || 'Access denied: Session ownership mismatch.' };
  }
  if (!cached.exists || !cached.result) {
    return { success: false, authorized: true, exists: false, error: cached.error || 'No contract understanding found for this document.' };
  }
  return { success: true, authorized: true, exists: true, report: buildReport(cached.result, fileId, sessionId) };
}
