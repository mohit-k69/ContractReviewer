import { isProcessable } from '../security/eligibility';
import crypto from 'node:crypto';
import {
  getSecurityReport,
  getQuarantinedFileBuffer,
  onDocumentRemoved,
} from '../security/quarantineManager';
import { extractTxtContent } from './txtExtractor';
import { extractPdfContent } from './pdfExtractor';
import { extractDocxWithTimeout } from './docxExtractor';
import { DocumentExtractionResult, ExtractionStatus } from './types';

// In-memory cache for extracted documents by fileId
const extractionCache = new Map<string, DocumentExtractionResult>();

// Invalidate cached extraction whenever a document is removed or expires
onDocumentRemoved((fileId: string) => {
  extractionCache.delete(fileId);
});

export function invalidateCachedExtraction(fileId: string): void {
  extractionCache.delete(fileId);
}

export function clearAllCachedExtractions(): void {
  extractionCache.clear();
}

export interface ExtractionServiceResponse {
  success: boolean;
  authorized: boolean;
  result?: DocumentExtractionResult;
  error?: string;
}

export interface CachedExtractionResponse {
  result?: DocumentExtractionResult;
  authorized: boolean;
  exists: boolean;
  error?: string;
}

export async function extractContractDocument(
  fileId: string,
  sessionId: string,
  options?: { timeoutMs?: number }
): Promise<ExtractionServiceResponse> {
  const startTime = Date.now();

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
    extractionCache.delete(fileId);
    return {
      success: false,
      authorized: true,
      error: 'Document has not completed security inspection, has been deleted, or has expired.',
    };
  }

  // 3. Confirm the document passed the security inspection (isProcessable)
  if (!isProcessable(report)) {
    extractionCache.delete(fileId);
    return {
      success: false,
      authorized: true,
      error: `Security verification failed: Document status is ${report.status}. Only documents that passed the security inspection can be processed.`,
    };
  }

  // 4. Confirm eligibleForContractProcessing is true
  if (!report.eligibleForContractProcessing) {
    extractionCache.delete(fileId);
    return {
      success: false,
      authorized: true,
      error: 'Security verification failed: Document is not eligible for contract processing.',
    };
  }

  // 5. Retrieve physical file buffer
  const fileFetch = getQuarantinedFileBuffer(fileId, sessionId);
  if (!fileFetch.buffer) {
    extractionCache.delete(fileId);
    return {
      success: false,
      authorized: true,
      error: fileFetch.error || 'Quarantined document file payload could not be retrieved.',
    };
  }

  const buffer = fileFetch.buffer;

  // 6. Recalculate document SHA-256 fingerprint and verify integrity
  const calculatedSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (calculatedSha256 !== report.metadata.sha256) {
    extractionCache.delete(fileId);
    return {
      success: false,
      authorized: true,
      error: 'Integrity violation: Calculated SHA-256 fingerprint does not match the verified security inspection record.',
    };
  }

  // Check cached extraction if identical and still valid
  const cached = extractionCache.get(fileId);
  if (cached && cached.verified_sha256 === calculatedSha256) {
    return {
      success: true,
      authorized: true,
      result: cached,
    };
  }

  // 7. Determine document format
  const format =
    report.authenticity.detectedFormat === 'unknown'
      ? (report.metadata.detectedExtension.replace('.', '') as 'pdf' | 'docx' | 'txt')
      : report.authenticity.detectedFormat;

  let extractionStatus: ExtractionStatus = 'COMPLETED';
  let blocks: DocumentExtractionResult['blocks'] = [];
  const warnings: string[] = [];
  let totalPages: number | undefined;
  let extractedPages: number | undefined;

  const timeoutMs = options?.timeoutMs;

  try {
    if (format === 'txt') {
      const res = extractTxtContent(buffer, fileId);
      blocks = res.blocks;
      warnings.push(...res.warnings);
      totalPages = res.totalPages;
      extractedPages = 1;
      extractionStatus = res.status || (blocks.length > 0 ? 'COMPLETED' : 'FAILED');

      if (res.status === 'FAILED' && res.error) {
        const failedResult: DocumentExtractionResult = {
          document_id: crypto.randomUUID(),
          source_file_id: fileId,
          source_format: 'txt',
          verified_sha256: calculatedSha256,
          extraction_status: 'FAILED',
          total_pages: 1,
          extracted_pages: 0,
          total_blocks: 0,
          blocks: [],
          warnings: [...warnings],
          extraction_duration_ms: Date.now() - startTime,
          extracted_at: new Date().toISOString(),
          error: res.error,
        };
        extractionCache.set(fileId, failedResult);
        return {
          success: false,
          authorized: true,
          result: failedResult,
          error: res.error,
        };
      }
    } else if (format === 'pdf') {
      const res = await extractPdfContent(buffer, fileId, timeoutMs);
      blocks = res.blocks;
      warnings.push(...res.warnings);
      totalPages = res.totalPages;
      extractedPages = res.extractedPages;
      extractionStatus = res.status;
    } else if (format === 'docx') {
      const res = await extractDocxWithTimeout(buffer, fileId, timeoutMs);
      blocks = res.blocks;
      warnings.push(...res.warnings);
      // Pagination is unavailable in DOCX without a rendering layout engine
      totalPages = undefined;
      extractedPages = undefined;
      extractionStatus = blocks.length > 0 ? 'COMPLETED' : 'FAILED';
    } else {
      return {
        success: false,
        authorized: true,
        error: `Unsupported document format for extraction: ${format}`,
      };
    }
  } catch (err: any) {
    const duration = Date.now() - startTime;
    const failedResult: DocumentExtractionResult = {
      document_id: crypto.randomUUID(),
      source_file_id: fileId,
      source_format: format as 'pdf' | 'docx' | 'txt',
      verified_sha256: calculatedSha256,
      extraction_status: 'FAILED',
      total_pages: totalPages,
      extracted_pages: 0,
      total_blocks: 0,
      blocks: [],
      warnings: [...warnings, `Extraction failed: ${err.message}`],
      extraction_duration_ms: duration,
      extracted_at: new Date().toISOString(),
      error: err.message,
    };

    extractionCache.set(fileId, failedResult);
    return {
      success: false,
      authorized: true,
      result: failedResult,
      error: `Extraction failed: ${err.message}`,
    };
  }

  const duration = Date.now() - startTime;

  const result: DocumentExtractionResult = {
    document_id: crypto.randomUUID(),
    source_file_id: fileId,
    source_format: format as 'pdf' | 'docx' | 'txt',
    verified_sha256: calculatedSha256,
    extraction_status: extractionStatus,
    total_pages: totalPages,
    extracted_pages: extractedPages,
    total_blocks: blocks.length,
    blocks,
    warnings,
    extraction_duration_ms: duration,
    extracted_at: new Date().toISOString(),
  };

  extractionCache.set(fileId, result);

  return {
    success: true,
    authorized: true,
    result,
  };
}

/**
 * Retrieve cached extraction result with mandatory session ownership and document registry verification.
 * A deleted, expired, or unregistered document must never return cached content.
 */
export function getCachedExtraction(
  fileId: string,
  sessionId: string
): CachedExtractionResponse {
  // 1. Verify document registry existence and session ownership
  const { report, authorized } = getSecurityReport(fileId, sessionId);
  if (!authorized) {
    return {
      authorized: false,
      exists: true,
      error: 'Access denied: Session ownership mismatch.',
    };
  }

  if (!report) {
    // Document does not exist in registry (deleted, expired, or never registered)
    extractionCache.delete(fileId);
    return {
      authorized: true,
      exists: false,
      error: 'Document record not found or has expired.',
    };
  }

  // 2. Document must be clean and eligible
  if (!isProcessable(report)) {
    extractionCache.delete(fileId);
    return {
      authorized: true,
      exists: false,
      error: `Document is not eligible for contract extraction (status: ${report.status}).`,
    };
  }

  const cached = extractionCache.get(fileId);
  if (!cached) {
    return {
      authorized: true,
      exists: true,
      error: 'No extraction record found for this document.',
    };
  }

  // 3. Verify SHA-256 integrity match
  if (cached.verified_sha256 !== report.metadata.sha256) {
    extractionCache.delete(fileId);
    return {
      authorized: true,
      exists: false,
      error: 'Integrity mismatch: Document has been modified since extraction.',
    };
  }

  return {
    authorized: true,
    exists: true,
    result: cached,
  };
}
