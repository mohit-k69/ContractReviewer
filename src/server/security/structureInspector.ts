import AdmZip from 'adm-zip';
import { DocumentStructureResult } from './types';

export const MAX_DECOMPRESSED_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
export const MAX_DECOMPRESSION_RATIO = 15; // Max 15x compression
export const MAX_ZIP_ENTRY_COUNT = 500; // Standard docx has ~15-40 entries

export function inspectDocumentStructure(
  buffer: Buffer,
  format: 'pdf' | 'docx' | 'txt' | 'unknown'
): DocumentStructureResult {
  const details: string[] = [];
  let isZipBomb = false;
  let entryCount = 0;
  let decompressedSize = 0;
  let decompressionRatio = 1;
  const pathTraversalAttempts: string[] = [];
  let malformedStructure = false;

  if (format === 'txt') {
    return {
      passed: true,
      isZipBomb: false,
      entryCount: 1,
      decompressedSize: buffer.length,
      decompressionRatio: 1,
      pathTraversalAttempts: [],
      malformedStructure: false,
      details: ['Plain text document structure valid.'],
    };
  }

  if (format === 'pdf') {
    // PDF structure inspection
    const pdfStr = buffer.toString('latin1');
    const hasHeader = pdfStr.includes('%PDF-');
    const hasEof = pdfStr.includes('%%EOF');

    if (!hasHeader || !hasEof) {
      malformedStructure = true;
      details.push('Malformed PDF structure: missing valid header or %%EOF trailer marker.');
    }

    return {
      passed: !malformedStructure,
      isZipBomb: false,
      entryCount: 1,
      decompressedSize: buffer.length,
      decompressionRatio: 1,
      pathTraversalAttempts: [],
      malformedStructure,
      details: details.length ? details : ['PDF document structure valid.'],
    };
  }

  if (format === 'docx') {
    // DOCX ZIP package inspection
    try {
      const zip = new AdmZip(buffer);
      const entries = zip.getEntries();
      entryCount = entries.length;

      if (entryCount === 0) {
        malformedStructure = true;
        details.push('Malformed DOCX: ZIP archive contains no entries.');
        return {
          passed: false,
          isZipBomb: false,
          entryCount: 0,
          decompressedSize: 0,
          decompressionRatio: 0,
          pathTraversalAttempts: [],
          malformedStructure: true,
          details,
        };
      }

      if (entryCount > MAX_ZIP_ENTRY_COUNT) {
        isZipBomb = true;
        details.push(`Suspicious DOCX ZIP archive: contains ${entryCount} entries (limit is ${MAX_ZIP_ENTRY_COUNT}).`);
      }

      // Raw buffer check for path traversal in local headers or central directory
      const rawZipStr = buffer.toString('latin1');
      if (rawZipStr.includes('../') || rawZipStr.includes('..\\')) {
        pathTraversalAttempts.push('relative-traversal-sequence');
        details.push('Path traversal attempt detected in ZIP headers (../ or ..\\).');
      }

      let hasContentTypes = false;
      let hasWordFolder = false;

      for (const entry of entries) {
        const name = entry.entryName;

        // Path traversal checks
        if (
          name.includes('..') ||
          name.startsWith('/') ||
          name.startsWith('\\') ||
          name.includes('\0')
        ) {
          pathTraversalAttempts.push(name);
          details.push(`Path traversal attempt detected in entry: ${name}`);
        }

        const uncompressedSize = entry.header.size;
        decompressedSize += uncompressedSize;

        if (name === '[Content_Types].xml') hasContentTypes = true;
        if (name.startsWith('word/')) hasWordFolder = true;
      }

      // Check decompressed size limit (Zip Bomb protection)
      if (decompressedSize > MAX_DECOMPRESSED_SIZE_BYTES) {
        isZipBomb = true;
        details.push(
          `Decompressed size exceeds limit: ${(decompressedSize / (1024 * 1024)).toFixed(1)} MB (max is ${MAX_DECOMPRESSED_SIZE_BYTES / (1024 * 1024)} MB).`
        );
      }

      decompressionRatio = buffer.length > 0 ? decompressedSize / buffer.length : 1;
      if (decompressionRatio > MAX_DECOMPRESSION_RATIO && decompressedSize > 10 * 1024 * 1024) {
        isZipBomb = true;
        details.push(
          `Excessive compression ratio detected (${decompressionRatio.toFixed(1)}:1). Possible ZIP bomb attack.`
        );
      }

      if (!hasContentTypes || !hasWordFolder) {
        malformedStructure = true;
        details.push('Malformed DOCX package: missing required [Content_Types].xml or word/ structure.');
      }
    } catch (err: any) {
      malformedStructure = true;
      details.push(`Corrupted DOCX ZIP package: ${err?.message || 'decompression failure'}`);
    }

    const passed = !isZipBomb && pathTraversalAttempts.length === 0 && !malformedStructure;

    return {
      passed,
      isZipBomb,
      entryCount,
      decompressedSize,
      decompressionRatio,
      pathTraversalAttempts,
      malformedStructure,
      details: details.length ? details : ['DOCX package structure verified and within safety bounds.'],
    };
  }

  return {
    passed: false,
    isZipBomb: false,
    entryCount: 0,
    decompressedSize: 0,
    decompressionRatio: 0,
    pathTraversalAttempts: [],
    malformedStructure: true,
    details: ['Unknown format structure cannot be inspected.'],
  };
}
