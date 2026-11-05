import AdmZip from 'adm-zip';
import zlib from 'node:zlib';
import { DocumentStructureResult } from './types';

export const MAX_DECOMPRESSED_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB cumulative limit
export const MAX_SINGLE_ENTRY_DECOMPRESSED_BYTES = 15 * 1024 * 1024; // 15 MB per entry
export const MAX_DECOMPRESSION_RATIO = 15; // Max 15x compression ratio
export const MAX_ZIP_ENTRY_COUNT = 300; // Standard docx has ~15-40 entries

/** A ZIP entry name that could escape its folder: a ".." path segment, an absolute path, a drive letter or a NUL. */
export function isUnsafeEntryName(name: string): boolean {
  if (name.includes('\0')) return true;
  const normalised = name.replace(/\\/g, '/');
  if (normalised.startsWith('/') || /^[a-zA-Z]:/.test(normalised)) return true;
  return normalised.split('/').some((segment) => segment === '..');
}

/**
 * Names stored in the ZIP LOCAL file headers. Archive readers use the central directory, but a hostile archive can
 * put a different (traversing) name in the local header, so both are checked. Bounded to plausible header fields so
 * that bytes inside compressed data cannot produce false matches.
 */
function localHeaderNames(buffer: Buffer): string[] {
  const names: string[] = [];
  let at = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  while (at !== -1 && names.length < 10000) {
    if (at + 30 <= buffer.length) {
      const length = buffer.readUInt16LE(at + 26);
      if (length > 0 && length <= 1024 && at + 30 + length <= buffer.length) {
        names.push(buffer.toString('latin1', at + 30, at + 30 + length));
      }
    }
    at = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), at + 4);
  }
  return names;
}

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
    // Hardened PDF structure inspection
    const pdfStr = buffer.toString('latin1');
    const hasHeader = pdfStr.includes('%PDF-');
    const hasEof = pdfStr.includes('%%EOF');

    if (!hasHeader || !hasEof) {
      malformedStructure = true;
      details.push('Malformed PDF structure: missing valid header or %%EOF trailer marker.');
    }

    // Inspect for suspicious recursive object structures or excessive object counts
    const objMatches = pdfStr.match(/\d+\s+\d+\s+obj/g);
    const objCount = objMatches ? objMatches.length : 0;
    if (objCount > 5000) {
      malformedStructure = true;
      details.push(`Malformed or adversarial PDF: contains excessive object count (${objCount}).`);
    }

    // Check for xref table or modern XRef stream
    const hasXref = pdfStr.includes('xref') || pdfStr.includes('/XRef');
    if (!hasXref) {
      malformedStructure = true;
      details.push('Malformed PDF structure: missing xref cross-reference table or stream.');
    }

    return {
      passed: !malformedStructure,
      isZipBomb: false,
      entryCount: 1,
      decompressedSize: buffer.length,
      decompressionRatio: 1,
      pathTraversalAttempts: [],
      malformedStructure,
      details: details.length ? details : ['PDF document structure and xref table verified.'],
    };
  }

  if (format === 'docx') {
    // Hardened DOCX ZIP package inspection
    try {
      // 1. Path traversal in the local file headers (checked as whole path segments, never as a substring of
      //    compressed bytes: "../" legitimately appears in relationship targets such as ../customXml/item1.xml)
      for (const name of localHeaderNames(buffer)) {
        if (isUnsafeEntryName(name)) {
          pathTraversalAttempts.push(name);
          details.push(`Path traversal attempt detected in ZIP local header: ${name}`);
        }
      }

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

      let hasContentTypes = false;
      let hasWordFolder = false;

      // 2. Perform actual bounded decompression on each entry rather than trusting header metadata
      for (const entry of entries) {
        const name = entry.entryName;

        // Path traversal checks on the central-directory name
        if (isUnsafeEntryName(name)) {
          if (!pathTraversalAttempts.includes(name)) {
            pathTraversalAttempts.push(name);
            details.push(`Path traversal attempt detected in entry: ${name}`);
          }
        }

        // Check declared uncompressed size against single-entry limit
        if (entry.header.size > MAX_SINGLE_ENTRY_DECOMPRESSED_BYTES) {
          isZipBomb = true;
          details.push(`Entry ${name} declares uncompressed size (${(entry.header.size / (1024 * 1024)).toFixed(1)} MB) exceeding limit.`);
          break;
        }

        // Bounded actual decompression:
        // Do not call entry.getData() blindly. Extract with hard output buffer ceiling.
        try {
          const rawCompressed = entry.getCompressedData();
          if (entry.header.method === 8) {
            // Deflate compression
            const decompressedChunk = zlib.inflateRawSync(rawCompressed, {
              maxOutputLength: MAX_SINGLE_ENTRY_DECOMPRESSED_BYTES,
            });
            decompressedSize += decompressedChunk.length;
          } else if (entry.header.method === 0) {
            // Stored without compression
            decompressedSize += rawCompressed.length;
          } else {
            // Unknown compression method
            malformedStructure = true;
            details.push(`Unsupported compression method (${entry.header.method}) in entry ${name}.`);
            break;
          }
        } catch (zlibErr: any) {
          // If maxOutputLength was exceeded, it was an adversarial decompression bomb with spoofed header!
          isZipBomb = true;
          details.push(`Decompression limit exceeded on entry ${name} (potential decompression bomb).`);
          break;
        }

        // Check running total decompressed size
        if (decompressedSize > MAX_DECOMPRESSED_SIZE_BYTES) {
          isZipBomb = true;
          details.push(
            `Cumulative decompressed size exceeded limit: ${(decompressedSize / (1024 * 1024)).toFixed(1)} MB (max is ${MAX_DECOMPRESSED_SIZE_BYTES / (1024 * 1024)} MB).`
          );
          break;
        }

        if (name === '[Content_Types].xml') hasContentTypes = true;
        if (name.startsWith('word/')) hasWordFolder = true;
      }

      // Check compression ratio
      decompressionRatio = buffer.length > 0 ? decompressedSize / buffer.length : 1;
      if (decompressionRatio > MAX_DECOMPRESSION_RATIO && decompressedSize > 5 * 1024 * 1024) {
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
