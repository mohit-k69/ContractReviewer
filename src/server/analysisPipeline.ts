import { extractContractDocument } from './extraction/extractionService';
import { normalizeContractDocument } from './normalization/normalizationService';
import { generateRiskReport } from './risk/riskService';
import { DocumentExtractionResult } from './extraction/types';
import { NormalizedDocument } from './normalization/types';
import { ContractUnderstandingResult } from './understanding/types';
import { ContractRiskReport } from './risk/types';
import { buildDecisionReport, DecisionReport } from './decision';

export interface UploadAnalysis {
  extractionResult?: DocumentExtractionResult;
  normalizedDocument?: NormalizedDocument;
  understandingResult?: ContractUnderstandingResult;
  riskReport?: ContractRiskReport;
  /** Contract Decision Report, built deterministically from the results above inside this same request */
  decisionReport?: DecisionReport;
  /** Set when only the decision report failed; every other result is still returned */
  decisionReportError?: string;
  /** Set when a stage failed; earlier stages' results are still returned */
  error?: string;
}

/**
 * Runs the existing extraction -> normalization -> understanding -> review-report stages back to back.
 *
 * It only orchestrates the existing services (each re-checks session ownership, security status and
 * SHA-256 integrity). Running them in one request keeps the whole workflow inside a single process, so it
 * also works on serverless platforms where separate requests may be served by different instances.
 */
export async function analyzeUploadedContract(fileId: string, sessionId: string): Promise<UploadAnalysis> {
  const out: UploadAnalysis = {};

  const ext = await extractContractDocument(fileId, sessionId);
  if (!ext.success || !ext.result) {
    out.error = ext.error || 'Extraction failed.';
    return out;
  }
  out.extractionResult = ext.result;

  const norm = await normalizeContractDocument(fileId, sessionId);
  if (!norm.success || !norm.result) {
    out.error = norm.error || 'Normalization failed.';
    return out;
  }
  out.normalizedDocument = norm.result;

  const risk = await generateRiskReport(fileId, sessionId);
  if (!risk.success || !risk.report) {
    out.error = risk.error || 'Contract analysis failed.';
    return out;
  }
  out.understandingResult = risk.understanding;
  out.riskReport = risk.report;

  // Built from data already produced in this request: no extra AI call, no stored state. A failure here must
  // never hide the earlier results, so it is reported as a warning on the response instead of failing it.
  try {
    if (risk.understanding) {
      out.decisionReport = buildDecisionReport(risk.understanding, risk.report, norm.result, ext.result);
    }
  } catch (err) {
    out.decisionReportError = 'The decision report could not be generated for this document.';
    console.error('Decision report generation failed:', err instanceof Error ? err.message : err);
  }
  return out;
}
