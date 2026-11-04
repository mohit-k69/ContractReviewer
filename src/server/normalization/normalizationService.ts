import crypto from 'node:crypto';
import {
  getSecurityReport,
  getQuarantinedFileBuffer,
  onDocumentRemoved,
} from '../security/quarantineManager';
import {
  extractContractDocument,
  getCachedExtraction,
} from '../extraction/extractionService';
import { normalizeExtraction } from './normalizationEngine';
import { NormalizedDocument } from './types';

// In-memory cache for normalized documents by fileId
const normalizationCache = new Map<string, NormalizedDocument>();

// Invalidate cached normalization whenever a document is removed or expires
onDocumentRemoved((fileId: string) => {
  normalizationCache.delete(fileId);
});

export function invalidateCachedNormalization(fileId: string): void {
  normalizationCache.delete(fileId);
}

export function clearAllCachedNormalizations(): void {
  normalizationCache.clear();
}

export interface NormalizationServiceResponse {
  success: boolean;
  authorized: boolean;
  result?: NormalizedDocument;
  error?: string;
}

export interface CachedNormalizationResponse {
  result?: NormalizedDocument;
  authorized: boolean;
  exists: boolean;
  error?: string;
}

/**
 * Normalizes a contract document following Phase 2A extraction.
 * Verifies authenticated session, document ownership, security status, and SHA-256 fingerprint.
 */
export async function normalizeContractDocument(
  fileId: string,
  sessionId: string
): Promise<NormalizationServiceResponse> {
  // 1 & 2. Verify session ownership and security report existence
  const { report, authorized } = getSecurityReport(fileId, sessionId);
  if (!authorized) {
    return {
      success: false,
      authorized: false,
      error: 'Access denied: Session ownership mismatch.',
    };
  }

  if (!report) {
    normalizationCache.delete(fileId);
    return {
      success: false,
      authorized: true,
      error: 'Document has not completed security inspection, has been deleted, or has expired.',
    };
  }

  // 3. Confirm security status is CLEAN_NO_KNOWN_THREATS
  if (report.status !== 'CLEAN_NO_KNOWN_THREATS') {
    normalizationCache.delete(fileId);
    return {
      success: false,
      authorized: true,
      error: `Security verification failed: Document status is ${report.status}. Only clean documents can be normalized.`,
    };
  }

  // 4. Confirm eligibleForContractProcessing is true
  if (!report.eligibleForContractProcessing) {
    normalizationCache.delete(fileId);
    return {
      success: false,
      authorized: true,
      error: 'Security verification failed: Document is not eligible for contract processing.',
    };
  }

  // 5. Retrieve physical file buffer to verify current fingerprint
  const fileFetch = getQuarantinedFileBuffer(fileId, sessionId);
  if (!fileFetch.buffer) {
    normalizationCache.delete(fileId);
    return {
      success: false,
      authorized: true,
      error: fileFetch.error || 'Quarantined document payload could not be retrieved.',
    };
  }

  const calculatedSha256 = crypto.createHash('sha256').update(fileFetch.buffer).digest('hex');
  if (calculatedSha256 !== report.metadata.sha256) {
    normalizationCache.delete(fileId);
    return {
      success: false,
      authorized: true,
      error: 'Integrity violation: Calculated SHA-256 fingerprint does not match the verified security inspection record.',
    };
  }

  // 6. Check cached normalization
  const cached = normalizationCache.get(fileId);
  if (cached && cached.verified_sha256 === calculatedSha256) {
    return {
      success: true,
      authorized: true,
      result: cached,
    };
  }

  // 7. Retrieve Phase 2A extraction (from cache or run extraction if needed)
  let extractionResult = getCachedExtraction(fileId, sessionId).result;
  if (!extractionResult) {
    const extractionResponse = await extractContractDocument(fileId, sessionId);
    if (!extractionResponse.success || !extractionResponse.result) {
      return {
        success: false,
        authorized: true,
        error: extractionResponse.error || 'Underlying document extraction failed or is unavailable.',
      };
    }
    extractionResult = extractionResponse.result;
  }

  // Verify extraction fingerprint matches verified document
  if (extractionResult.verified_sha256 !== calculatedSha256) {
    normalizationCache.delete(fileId);
    return {
      success: false,
      authorized: true,
      error: 'Extraction fingerprint mismatch: Extraction was performed on a different version of this document.',
    };
  }

  if (extractionResult.extraction_status === 'FAILED') {
    return {
      success: false,
      authorized: true,
      error: 'Cannot normalize document: Extraction status is FAILED.',
    };
  }

  // 8. Run Normalization Engine
  const normalizedDoc = normalizeExtraction(extractionResult);

  // 9. Cache normalized document
  normalizationCache.set(fileId, normalizedDoc);

  return {
    success: true,
    authorized: true,
    result: normalizedDoc,
  };
}

/**
 * Retrieves cached normalized document for the authenticated session.
 * Verifies document remains registered, session ownership, clean status, eligibility,
 * and recalculates SHA-256 fingerprint from the physical quarantined file.
 */
export function getCachedNormalization(
  fileId: string,
  sessionId: string
): CachedNormalizationResponse {
  // 1. Verify session ownership and security report existence
  const { report, authorized } = getSecurityReport(fileId, sessionId);
  if (!authorized) {
    return {
      authorized: false,
      exists: false,
      error: 'Access denied: Session ownership mismatch.',
    };
  }

  if (!report) {
    normalizationCache.delete(fileId);
    return {
      authorized: true,
      exists: false,
      error: 'Document has not completed security inspection, has been deleted, or has expired.',
    };
  }

  // 2. Confirm security status is CLEAN_NO_KNOWN_THREATS
  if (report.status !== 'CLEAN_NO_KNOWN_THREATS') {
    normalizationCache.delete(fileId);
    return {
      authorized: true,
      exists: false,
      error: `Security verification failed: Document status is ${report.status}. Only clean documents are eligible.`,
    };
  }

  // 3. Confirm eligibleForContractProcessing is true
  if (!report.eligibleForContractProcessing) {
    normalizationCache.delete(fileId);
    return {
      authorized: true,
      exists: false,
      error: 'Security verification failed: Document is not eligible for contract processing.',
    };
  }

  // 4. Retrieve physical quarantined file to recalculate SHA-256 fingerprint
  const fileFetch = getQuarantinedFileBuffer(fileId, sessionId);
  if (!fileFetch.buffer) {
    normalizationCache.delete(fileId);
    return {
      authorized: true,
      exists: false,
      error: fileFetch.error || 'Quarantined document payload could not be retrieved or is missing.',
    };
  }

  const calculatedSha256 = crypto.createHash('sha256').update(fileFetch.buffer).digest('hex');

  // 5. Compare physical file SHA-256 with security report
  if (calculatedSha256 !== report.metadata.sha256) {
    normalizationCache.delete(fileId);
    return {
      authorized: true,
      exists: false,
      error: 'Integrity violation: Physical file SHA-256 does not match verified security report.',
    };
  }

  // 6. Check cached normalization
  const normalized = normalizationCache.get(fileId);
  if (!normalized) {
    return {
      authorized: true,
      exists: false,
      error: 'No normalized document found for specified file ID.',
    };
  }

  // 7. Verify cached normalization fingerprint matches physical file and report
  if (normalized.verified_sha256 !== calculatedSha256) {
    normalizationCache.delete(fileId);
    return {
      authorized: true,
      exists: false,
      error: 'Integrity violation: Fingerprint mismatch on cached normalization record.',
    };
  }

  return {
    authorized: true,
    exists: true,
    result: normalized,
  };
}
