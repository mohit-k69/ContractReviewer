import crypto from 'node:crypto';
import { getSecurityReport, getQuarantinedFileBuffer } from '../security/quarantineManager';
import { extractTxtContent } from './txtExtractor';
import { extractPdfContent } from './pdfExtractor';
import { extractDocxContent } from './docxExtractor';
import { DocumentExtractionResult, ExtractionStatus } from './types';

// In-memory cache for extracted documents by fileId
const extractionCache = new Map<string, DocumentExtractionResult>();

export interface ExtractionServiceResponse {
  success: boolean;
  authorized: boolean;
  result?: DocumentExtractionResult;
  error?: string;
}

export async function extractContractDocument(
  fileId: string,
  sessionId: string
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
    return {
      success: false,
      authorized: true,
      error: 'Document has not completed security inspection or has expired.',
    };
  }

  // 3. Confirm security status is CLEAN_NO_KNOWN_THREATS
  if (report.status !== 'CLEAN_NO_KNOWN_THREATS') {
    return {
      success: false,
      authorized: true,
      error: `Security verification failed: Document status is ${report.status}. Only clean documents can be processed.`,
    };
  }

  // 4. Confirm eligibleForContractProcessing is true
  if (!report.eligibleForContractProcessing) {
    return {
      success: false,
      authorized: true,
      error: 'Security verification failed: Document is not eligible for contract processing.',
    };
  }

  // 5. Retrieve physical file buffer
  const fileFetch = getQuarantinedFileBuffer(fileId, sessionId);
  if (!fileFetch.buffer) {
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
    return {
      success: false,
      authorized: true,
      error: 'Integrity violation: Calculated SHA-256 fingerprint does not match the verified security inspection record.',
    };
  }

  // Check cached extraction if identical
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
  let totalPages: number | undefined = 1;
  let extractedPages: number | undefined = 1;

  try {
    if (format === 'txt') {
      const res = extractTxtContent(buffer, fileId);
      blocks = res.blocks;
      warnings.push(...res.warnings);
      totalPages = res.totalPages;
      extractedPages = 1;
      extractionStatus = blocks.length > 0 ? 'COMPLETED' : 'FAILED';
    } else if (format === 'pdf') {
      const res = await extractPdfContent(buffer, fileId);
      blocks = res.blocks;
      warnings.push(...res.warnings);
      totalPages = res.totalPages;
      extractedPages = res.extractedPages;
      extractionStatus = res.status;
    } else if (format === 'docx') {
      const res = extractDocxContent(buffer, fileId);
      blocks = res.blocks;
      warnings.push(...res.warnings);
      totalPages = res.totalPages;
      extractedPages = 1;
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

export function getCachedExtraction(fileId: string): DocumentExtractionResult | undefined {
  return extractionCache.get(fileId);
}
