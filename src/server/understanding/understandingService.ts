import { isProcessable } from '../security/eligibility';
import crypto from 'node:crypto';
import {
  getSecurityReport,
  getQuarantinedFileBuffer,
  onDocumentRemoved,
} from '../security/quarantineManager';
import {
  getCachedNormalization,
  normalizeContractDocument,
} from '../normalization/normalizationService';
import {
  getCachedExtraction,
  extractContractDocument,
} from '../extraction/extractionService';
import { understandContractWithGemini } from './geminiClient';
import { ContractUnderstandingResult } from './types';

// In-memory cache for contract understanding results keyed by fileId
const understandingCache = new Map<string, ContractUnderstandingResult>();

// Invalidate cached understanding whenever a document is removed or expires
onDocumentRemoved((fileId: string) => {
  understandingCache.delete(fileId);
});

export function invalidateCachedUnderstanding(fileId: string): void {
  understandingCache.delete(fileId);
}

export function clearAllCachedUnderstandings(): void {
  understandingCache.clear();
}

export interface UnderstandingServiceResponse {
  success: boolean;
  authorized: boolean;
  result?: ContractUnderstandingResult;
  error?: string;
}

export interface CachedUnderstandingResponse {
  result?: ContractUnderstandingResult;
  authorized: boolean;
  exists: boolean;
  error?: string;
}

/**
 * Runs Contract Understanding on a normalized contract document.
 * Enforces authenticated session ownership, security inspection status,
 * physical payload presence, and SHA-256 cryptographic integrity.
 */
export async function understandContractDocument(
  fileId: string,
  sessionId: string
): Promise<UnderstandingServiceResponse> {
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
    understandingCache.delete(fileId);
    return {
      success: false,
      authorized: true,
      error: 'Document has not completed security inspection, has been deleted, or has expired.',
    };
  }

  // 3. Confirm the document passed the security inspection (isProcessable)
  if (!isProcessable(report)) {
    understandingCache.delete(fileId);
    return {
      success: false,
      authorized: true,
      error: `Security verification failed: Document status is ${report.status}. Only documents that passed the security inspection can be processed.`,
    };
  }

  // 4. Confirm eligibleForContractProcessing is true
  if (!report.eligibleForContractProcessing) {
    understandingCache.delete(fileId);
    return {
      success: false,
      authorized: true,
      error: 'Security verification failed: Document is not eligible for contract processing.',
    };
  }

  // 5. Retrieve physical file buffer to verify current fingerprint
  const fileFetch = getQuarantinedFileBuffer(fileId, sessionId);
  if (!fileFetch.buffer) {
    understandingCache.delete(fileId);
    return {
      success: false,
      authorized: true,
      error: fileFetch.error || 'Quarantined document payload could not be retrieved.',
    };
  }

  const calculatedSha256 = crypto.createHash('sha256').update(fileFetch.buffer).digest('hex');
  if (calculatedSha256 !== report.metadata.sha256) {
    understandingCache.delete(fileId);
    return {
      success: false,
      authorized: true,
      error: 'Integrity violation: Calculated SHA-256 fingerprint does not match the verified security inspection record.',
    };
  }

  // 6. Check cached understanding
  const cached = understandingCache.get(fileId);
  if (cached && cached.verified_sha256 === calculatedSha256) {
    return {
      success: true,
      authorized: true,
      result: cached,
    };
  }

  // 7. Retrieve Phase 2B normalization (from cache or normalize if not yet done)
  let normalizedDoc = getCachedNormalization(fileId, sessionId).result;
  if (!normalizedDoc) {
    const normResponse = await normalizeContractDocument(fileId, sessionId);
    if (!normResponse.success || !normResponse.result) {
      return {
        success: false,
        authorized: true,
        error: normResponse.error || 'Underlying document normalization failed or is unavailable.',
      };
    }
    normalizedDoc = normResponse.result;
  }

  if (normalizedDoc.verified_sha256 !== calculatedSha256) {
    understandingCache.delete(fileId);
    return {
      success: false,
      authorized: true,
      error: 'Normalization fingerprint mismatch: Document was normalized on a different payload version.',
    };
  }

  // 8. Retrieve Phase 2A extraction
  let extractionResult = getCachedExtraction(fileId, sessionId).result;
  if (!extractionResult) {
    const extResponse = await extractContractDocument(fileId, sessionId);
    if (!extResponse.success || !extResponse.result) {
      return {
        success: false,
        authorized: true,
        error: extResponse.error || 'Underlying document extraction failed or is unavailable.',
      };
    }
    extractionResult = extResponse.result;
  }

  // 9. Run Gemini Contract Understanding Engine
  try {
    const understandingResult = await understandContractWithGemini(
      normalizedDoc,
      extractionResult
    );

    // Cache verified understanding result
    understandingCache.set(fileId, understandingResult);

    return {
      success: true,
      authorized: true,
      result: understandingResult,
    };
  } catch (err: any) {
    return {
      success: false,
      authorized: true,
      error: err.message || 'Error executing Contract Understanding engine.',
    };
  }
}

/**
 * Retrieves cached contract understanding result with full security & SHA-256 integrity validation.
 */
export function getCachedUnderstanding(
  fileId: string,
  sessionId: string
): CachedUnderstandingResponse {
  // 1 & 2. Verify session ownership and security report existence
  const { report, authorized } = getSecurityReport(fileId, sessionId);
  if (!authorized) {
    return {
      authorized: false,
      exists: false,
      error: 'Access denied: Session ownership mismatch.',
    };
  }

  if (!report) {
    understandingCache.delete(fileId);
    return {
      authorized: true,
      exists: false,
      error: 'Document record not found or expired.',
    };
  }

  // 3. Confirm the document passed the security inspection (isProcessable)
  if (!isProcessable(report)) {
    understandingCache.delete(fileId);
    return {
      authorized: true,
      exists: false,
      error: `Security verification failed: Document status is ${report.status}. Only documents that passed the security inspection can be processed.`,
    };
  }

  // 4. Confirm eligibleForContractProcessing is true
  if (!report.eligibleForContractProcessing) {
    understandingCache.delete(fileId);
    return {
      authorized: true,
      exists: false,
      error: 'Security verification failed: Document is not eligible for contract processing.',
    };
  }

  // 5. Verify physical quarantined file exists on disk
  const fileFetch = getQuarantinedFileBuffer(fileId, sessionId);
  if (!fileFetch.buffer) {
    understandingCache.delete(fileId);
    return {
      authorized: true,
      exists: false,
      error: fileFetch.error || 'Quarantined document payload could not be retrieved from disk.',
    };
  }

  // 6. Recalculate SHA-256 fingerprint from physical quarantined file
  const calculatedSha256 = crypto.createHash('sha256').update(fileFetch.buffer).digest('hex');
  if (calculatedSha256 !== report.metadata.sha256) {
    understandingCache.delete(fileId);
    return {
      authorized: true,
      exists: false,
      error: 'Integrity violation: Calculated SHA-256 fingerprint does not match the verified security inspection record.',
    };
  }

  const cached = understandingCache.get(fileId);
  if (!cached) {
    return {
      authorized: true,
      exists: false,
      error: 'No cached understanding record found for this document.',
    };
  }

  // 7. Verify cached understanding belongs to the current verified SHA-256 fingerprint
  if (cached.verified_sha256 !== calculatedSha256) {
    understandingCache.delete(fileId);
    return {
      authorized: true,
      exists: false,
      error: 'Integrity violation: Cached understanding fingerprint does not match the verified quarantined document.',
    };
  }

  return {
    authorized: true,
    exists: true,
    result: cached,
  };
}
