import AdmZip from 'adm-zip';
import zlib from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import { Worker } from 'node:worker_threads';
import { ExtractedBlock } from './types';

export const MAX_DOCX_ENTRY_COUNT = 300;
export const MAX_SINGLE_ENTRY_DECOMPRESSED_BYTES = 15 * 1024 * 1024; // 15 MB per entry
export const MAX_TOTAL_DECOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB total archive
export const MAX_COMPRESSION_RATIO = 100;

const HEADING_REGEX = /^(SECTION\s+\d+|ARTICLE\s+\d+|CLAUSE\s+\d+|EXHIBIT\s+[A-Z]|SCHEDULE\s+[A-Z]|\d+(\.\d+)*\s+[A-Z][A-Za-z0-9\s,\-_:;()]+|[A-Z\s\-_:]{4,80})$/;
const LIST_ITEM_REGEX = /^(\s*[-*•]\s+|\s*\(\w+\)\s+|\s*\d+[\.\)]\s+)/;

interface AnyXmlNode {
  [key: string]: any;
}

export interface DocxExtractionOutput {
  blocks: ExtractedBlock[];
  warnings: string[];
  totalPages?: number;
  extractedPages?: number;
}

function extractTextFromParagraphNode(node: AnyXmlNode): { text: string; isBold: boolean } {
  let fullText = '';
  let isBold = false;

  function traverse(item: any) {
    if (!item) return;

    if (Array.isArray(item)) {
      for (const child of item) {
        traverse(child);
      }
      return;
    }

    if (typeof item === 'object') {
      for (const key of Object.keys(item)) {
        if (key === 'w:t') {
          const tChildren = item[key];
          if (Array.isArray(tChildren)) {
            for (const tChild of tChildren) {
              if (tChild && typeof tChild['#text'] === 'string') {
                fullText += tChild['#text'];
              }
            }
          } else if (typeof tChildren === 'string') {
            fullText += tChildren;
          }
        } else if (key === 'w:b') {
          isBold = true;
        } else if (key !== ':@') {
          traverse(item[key]);
        }
      }
    }
  }

  traverse(node);
  return { text: fullText, isBold };
}

function extractParagraphProperties(node: AnyXmlNode): {
  styleVal?: string;
  isList: boolean;
  listLevel?: number;
} {
  let styleVal: string | undefined;
  let isList = false;
  let listLevel: number | undefined;

  function traverse(item: any) {
    if (!item) return;
    if (Array.isArray(item)) {
      for (const child of item) traverse(child);
      return;
    }
    if (typeof item === 'object') {
      for (const key of Object.keys(item)) {
        if (key === 'w:pStyle') {
          const attrs = item[':@'];
          if (attrs && attrs['@_w:val']) {
            styleVal = attrs['@_w:val'];
          }
        } else if (key === 'w:numPr') {
          isList = true;
          const numPrChildren = item[key];
          if (Array.isArray(numPrChildren)) {
            for (const child of numPrChildren) {
              if (child && child['w:ilvl'] && child[':@'] && child[':@']['@_w:val']) {
                listLevel = parseInt(child[':@']['@_w:val'], 10) + 1;
              }
            }
          }
        } else if (key !== 'w:r' && key !== ':@') {
          traverse(item[key]);
        }
      }
    }
  }

  traverse(node);
  return { styleVal, isList, listLevel };
}

function extractTableData(tblNode: AnyXmlNode): string[][] {
  const rows: string[][] = [];
  const children = tblNode['w:tbl'];

  if (!Array.isArray(children)) return rows;

  for (const child of children) {
    if (child && child['w:tr']) {
      const trChildren = child['w:tr'];
      if (!Array.isArray(trChildren)) continue;

      const rowCells: string[] = [];
      for (const trChild of trChildren) {
        if (trChild && trChild['w:tc']) {
          const tcChildren = trChild['w:tc'];
          if (Array.isArray(tcChildren)) {
            let cellText = '';
            for (const tcItem of tcChildren) {
              if (tcItem && tcItem['w:p']) {
                const { text } = extractTextFromParagraphNode(tcItem);
                if (text) {
                  cellText += (cellText ? ' ' : '') + text.trim();
                }
              }
            }
            rowCells.push(cellText);
          }
        }
      }

      if (rowCells.length > 0) {
        rows.push(rowCells);
      }
    }
  }

  return rows;
}

/**
 * Pure extraction logic with strict resource limits and sanity checks.
 */
export function extractDocxContent(
  buffer: Buffer,
  fileId: string
): DocxExtractionOutput {
  const warnings: string[] = [];
  const blocks: ExtractedBlock[] = [];

  // 1. Raw buffer integrity and signature validation
  if (!buffer || buffer.length < 22) {
    throw new Error('Malformed DOCX: File is truncated or smaller than valid ZIP header.');
  }

  const rawZipStr = buffer.toString('latin1');
  if (!rawZipStr.startsWith('PK\x03\x04') && !rawZipStr.includes('PK\x05\x06')) {
    throw new Error('Malformed DOCX: Missing valid ZIP archive signature.');
  }

  // Raw path traversal sequence check
  if (rawZipStr.includes('../') || rawZipStr.includes('..\\')) {
    throw new Error('Malformed DOCX: Path traversal sequence detected in ZIP archive.');
  }

  // 2. Open archive with AdmZip
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err: any) {
    throw new Error(`Failed to read DOCX zip archive: ${err.message}`);
  }

  const entries = zip.getEntries();
  if (entries.length === 0) {
    throw new Error('Malformed DOCX: ZIP archive contains no entries.');
  }

  // Enforce entry-count limit
  if (entries.length > MAX_DOCX_ENTRY_COUNT) {
    throw new Error(`Suspicious DOCX: Entry count (${entries.length}) exceeds maximum limit of ${MAX_DOCX_ENTRY_COUNT}.`);
  }

  let cumulativeDeclaredSize = 0;
  let documentEntry: AdmZip.IZipEntry | null = null;

  // 3. Inspect entry headers before decompressing
  for (const entry of entries) {
    const name = entry.entryName;

    // Reject path traversal attempts in entry names
    if (
      name.includes('..') ||
      name.startsWith('/') ||
      name.startsWith('\\') ||
      name.includes('\0')
    ) {
      throw new Error(`Path traversal attempt detected in DOCX entry: ${name}`);
    }

    const declaredSize = entry.header.size;
    const compressedSize = entry.header.compressedSize;

    // Reject inconsistent or negative sizes
    if (declaredSize < 0 || compressedSize < 0) {
      throw new Error(`Malformed DOCX: Inconsistent negative entry sizes for ${name}`);
    }

    if (compressedSize > buffer.length) {
      throw new Error(`Malformed DOCX: Inconsistent compressed size (${compressedSize} bytes) exceeding archive length for ${name}`);
    }

    // Check single-entry limit against declared size
    if (declaredSize > MAX_SINGLE_ENTRY_DECOMPRESSED_BYTES) {
      throw new Error(
        `DOCX entry ${name} declares uncompressed size (${(declaredSize / (1024 * 1024)).toFixed(1)} MB) exceeding limit of 15 MB.`
      );
    }

    cumulativeDeclaredSize += declaredSize;
    if (cumulativeDeclaredSize > MAX_TOTAL_DECOMPRESSED_BYTES) {
      throw new Error(
        `DOCX archive cumulative size (${(cumulativeDeclaredSize / (1024 * 1024)).toFixed(1)} MB) exceeds maximum safe limit of 50 MB.`
      );
    }

    // Compression ratio check for zip bombs
    if (declaredSize > 1024 * 1024 && compressedSize > 0) {
      const ratio = declaredSize / compressedSize;
      if (ratio > MAX_COMPRESSION_RATIO) {
        throw new Error(
          `Suspicious DOCX decompression ratio (${ratio.toFixed(1)}x) detected for entry ${name}.`
        );
      }
    }

    if (name === 'word/document.xml') {
      documentEntry = entry;
    }
  }

  if (!documentEntry) {
    throw new Error('Invalid DOCX format: missing word/document.xml');
  }

  // 4. Safe bounded decompression of word/document.xml
  let documentXml: string;
  try {
    const rawCompressed = documentEntry.getCompressedData();
    if (documentEntry.header.method === 8) {
      // Deflate: bounded inflateRawSync with hard output length limit
      const decompressedBuffer = zlib.inflateRawSync(rawCompressed, {
        maxOutputLength: MAX_SINGLE_ENTRY_DECOMPRESSED_BYTES,
      });
      documentXml = decompressedBuffer.toString('utf8');
    } else if (documentEntry.header.method === 0) {
      // Stored uncompressed
      if (rawCompressed.length > MAX_SINGLE_ENTRY_DECOMPRESSED_BYTES) {
        throw new Error('DOCX document.xml exceeds maximum single-entry size limit.');
      }
      documentXml = rawCompressed.toString('utf8');
    } else {
      throw new Error(`Unsupported compression method (${documentEntry.header.method}) in DOCX archive.`);
    }
  } catch (err: any) {
    if (err.name === 'RangeError' || /maxOutputLength|larger than/i.test(err.message)) {
      throw new Error(
        `Decompression bomb detected: word/document.xml decompressed stream exceeds single-entry limit of 15 MB.`
      );
    }
    throw new Error(`Failed to decompress word/document.xml safely: ${err.message}`);
  }

  // 5. Parse XML with fast-xml-parser preserving order and exact values
  const parser = new XMLParser({
    preserveOrder: true,
    trimValues: false,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });

  let parsedRoot: any;
  try {
    parsedRoot = parser.parse(documentXml);
  } catch (err: any) {
    throw new Error(`Malformed DOCX XML in word/document.xml: ${err.message}`);
  }

  // Find w:body in parsed AST
  let bodyElements: any[] = [];

  function findBody(nodes: any[]) {
    for (const node of nodes) {
      if (node && node['w:document']) {
        const docChildren = node['w:document'];
        if (Array.isArray(docChildren)) {
          for (const docChild of docChildren) {
            if (docChild && docChild['w:body'] && Array.isArray(docChild['w:body'])) {
              bodyElements = docChild['w:body'];
              return;
            }
          }
        }
      }
    }
  }

  if (Array.isArray(parsedRoot)) {
    findBody(parsedRoot);
  }

  if (bodyElements.length === 0) {
    warnings.push('No w:body found in word/document.xml');
    return { blocks: [], warnings, totalPages: undefined, extractedPages: undefined };
  }

  let blockCounter = 1;
  let sectionIndex = 1;
  let paraIndex = 1;
  let listIndex = 1;
  let tableIndex = 1;

  for (const element of bodyElements) {
    if (!element || typeof element !== 'object') continue;

    if (element['w:p']) {
      const { text, isBold } = extractTextFromParagraphNode(element);
      const trimmedText = text.trim();
      if (!trimmedText) continue;

      const { styleVal, isList, listLevel } = extractParagraphProperties(element);

      // Determine heading
      const isHeadingStyle =
        styleVal &&
        /^(Heading[1-6]|Title|Subtitle|Head[1-6])$/i.test(styleVal);

      let headingLevel: number | undefined;
      if (isHeadingStyle && styleVal) {
        const match = styleVal.match(/\d+/);
        headingLevel = match ? parseInt(match[0], 10) : 1;
      } else if (
        trimmedText.length <= 100 &&
        (HEADING_REGEX.test(trimmedText) || (isBold && trimmedText.length <= 80 && trimmedText === trimmedText.toUpperCase()))
      ) {
        headingLevel = trimmedText.startsWith('SECTION') || trimmedText === trimmedText.toUpperCase() ? 1 : 2;
      }

      if (headingLevel !== undefined) {
        // Do not fabricate page numbers for DOCX; use structural references
        blocks.push({
          block_id: `DOCX-B${blockCounter++}`,
          page_number: undefined,
          structural_ref: `sec-${sectionIndex++}`,
          type: 'heading',
          text: trimmedText,
          metadata: {
            heading_level: headingLevel,
            is_bold: true,
          },
        });
        continue;
      }

      // Check list
      if (isList || LIST_ITEM_REGEX.test(trimmedText)) {
        blocks.push({
          block_id: `DOCX-B${blockCounter++}`,
          page_number: undefined,
          structural_ref: `list-${listIndex++}`,
          type: 'list',
          text: trimmedText,
          metadata: {
            list_level: listLevel || 1,
            is_bold: isBold,
          },
        });
        continue;
      }

      // Regular paragraph
      blocks.push({
        block_id: `DOCX-B${blockCounter++}`,
        page_number: undefined,
        structural_ref: `para-${paraIndex++}`,
        type: 'paragraph',
        text: trimmedText,
        metadata: {
          is_bold: isBold,
        },
      });
    } else if (element['w:tbl']) {
      const tableData = extractTableData(element);
      if (tableData.length > 0) {
        // Construct readable text representation of the table
        const textRepresentation = tableData
          .map((row) => row.join(' | '))
          .join('\n');

        blocks.push({
          block_id: `DOCX-B${blockCounter++}`,
          page_number: undefined,
          structural_ref: `tbl-${tableIndex++}`,
          type: 'table',
          text: textRepresentation,
          table_data: tableData,
          metadata: {
            row_count: tableData.length,
            col_count: tableData[0]?.length || 0,
          },
        });
      }
    }
  }

  if (blocks.length === 0) {
    warnings.push('Document contains no extractable body paragraphs or tables.');
  }

  // Pagination is unavailable in DOCX structure without a layout engine; omit totalPages
  return {
    blocks,
    warnings,
    totalPages: undefined,
    extractedPages: undefined,
  };
}

/**
 * Worker-isolated execution wrapper with genuine timeout cancellation.
 * When timeoutMs expires, worker.terminate() terminates the thread, genuinely stopping CPU consumption.
 */
export async function extractDocxWithTimeout(
  buffer: Buffer,
  fileId: string,
  timeoutMs: number = 20000
): Promise<DocxExtractionOutput> {
  return new Promise((resolve, reject) => {
    // Isolated worker code
    const workerScript = `
      const { parentPort, workerData } = require('node:worker_threads');
      const AdmZip = require('adm-zip');
      const zlib = require('node:zlib');
      const { XMLParser } = require('fast-xml-parser');

      const MAX_DOCX_ENTRY_COUNT = 300;
      const MAX_SINGLE_ENTRY_DECOMPRESSED_BYTES = 15 * 1024 * 1024;
      const MAX_TOTAL_DECOMPRESSED_BYTES = 50 * 1024 * 1024;
      const MAX_COMPRESSION_RATIO = 100;
      const HEADING_REGEX = /^(SECTION\\s+\\d+|ARTICLE\\s+\\d+|CLAUSE\\s+\\d+|EXHIBIT\\s+[A-Z]|SCHEDULE\\s+[A-Z]|\\d+(\\.\\d+)*\\s+[A-Z][A-Za-z0-9\\s,\\-_:;()]+|[A-Z\\s\\-_:]{4,80})$/;
      const LIST_ITEM_REGEX = /^(\\s*[-*•]\\s+|\\s*\\(\\w+\\)\\s+|\\s*\\d+[\\.\\)]\\s+)/;

      function extractTextFromParagraphNode(node) {
        let fullText = '';
        let isBold = false;
        function traverse(item) {
          if (!item) return;
          if (Array.isArray(item)) {
            for (const child of item) traverse(child);
            return;
          }
          if (typeof item === 'object') {
            for (const key of Object.keys(item)) {
              if (key === 'w:t') {
                const tChildren = item[key];
                if (Array.isArray(tChildren)) {
                  for (const tChild of tChildren) {
                    if (tChild && typeof tChild['#text'] === 'string') fullText += tChild['#text'];
                  }
                } else if (typeof tChildren === 'string') {
                  fullText += tChildren;
                }
              } else if (key === 'w:b') {
                isBold = true;
              } else if (key !== ':@') {
                traverse(item[key]);
              }
            }
          }
        }
        traverse(node);
        return { text: fullText, isBold };
      }

      function extractParagraphProperties(node) {
        let styleVal;
        let isList = false;
        let listLevel;
        function traverse(item) {
          if (!item) return;
          if (Array.isArray(item)) {
            for (const child of item) traverse(child);
            return;
          }
          if (typeof item === 'object') {
            for (const key of Object.keys(item)) {
              if (key === 'w:pStyle') {
                const attrs = item[':@'];
                if (attrs && attrs['@_w:val']) styleVal = attrs['@_w:val'];
              } else if (key === 'w:numPr') {
                isList = true;
                const numPrChildren = item[key];
                if (Array.isArray(numPrChildren)) {
                  for (const child of numPrChildren) {
                    if (child && child['w:ilvl'] && child[':@'] && child[':@']['@_w:val']) {
                      listLevel = parseInt(child[':@']['@_w:val'], 10) + 1;
                    }
                  }
                }
              } else if (key !== 'w:r' && key !== ':@') {
                traverse(item[key]);
              }
            }
          }
        }
        traverse(node);
        return { styleVal, isList, listLevel };
      }

      function extractTableData(tblNode) {
        const rows = [];
        const children = tblNode['w:tbl'];
        if (!Array.isArray(children)) return rows;
        for (const child of children) {
          if (child && child['w:tr']) {
            const trChildren = child['w:tr'];
            if (!Array.isArray(trChildren)) continue;
            const rowCells = [];
            for (const trChild of trChildren) {
              if (trChild && trChild['w:tc']) {
                const tcChildren = trChild['w:tc'];
                if (Array.isArray(tcChildren)) {
                  let cellText = '';
                  for (const tcItem of tcChildren) {
                    if (tcItem && tcItem['w:p']) {
                      const { text } = extractTextFromParagraphNode(tcItem);
                      if (text) cellText += (cellText ? ' ' : '') + text.trim();
                    }
                  }
                  rowCells.push(cellText);
                }
              }
            }
            if (rowCells.length > 0) rows.push(rowCells);
          }
        }
        return rows;
      }

      try {
        const buffer = Buffer.from(workerData.buffer);
        const fileId = workerData.fileId;
        const warnings = [];
        const blocks = [];

        if (!buffer || buffer.length < 22) throw new Error('Malformed DOCX: File is truncated or smaller than valid ZIP header.');
        const rawZipStr = buffer.toString('latin1');
        if (!rawZipStr.startsWith('PK\\x03\\x04') && !rawZipStr.includes('PK\\x05\\x06')) throw new Error('Malformed DOCX: Missing valid ZIP archive signature.');
        if (rawZipStr.includes('../') || rawZipStr.includes('..\\\\')) throw new Error('Malformed DOCX: Path traversal sequence detected in ZIP archive.');

        const zip = new AdmZip(buffer);
        const entries = zip.getEntries();
        if (entries.length === 0) throw new Error('Malformed DOCX: ZIP archive contains no entries.');
        if (entries.length > MAX_DOCX_ENTRY_COUNT) throw new Error('Suspicious DOCX: Entry count (' + entries.length + ') exceeds maximum limit of ' + MAX_DOCX_ENTRY_COUNT + '.');

        let cumulativeDeclaredSize = 0;
        let documentEntry = null;

        for (const entry of entries) {
          const name = entry.entryName;
          if (name.includes('..') || name.startsWith('/') || name.startsWith('\\\\') || name.includes('\\0')) {
            throw new Error('Path traversal attempt detected in DOCX entry: ' + name);
          }
          const declaredSize = entry.header.size;
          const compressedSize = entry.header.compressedSize;
          if (declaredSize < 0 || compressedSize < 0) throw new Error('Malformed DOCX: Inconsistent negative entry sizes for ' + name);
          if (compressedSize > buffer.length) throw new Error('Malformed DOCX: Inconsistent compressed size exceeding archive length for ' + name);
          if (declaredSize > MAX_SINGLE_ENTRY_DECOMPRESSED_BYTES) throw new Error('DOCX entry ' + name + ' declares uncompressed size exceeding limit of 15 MB.');
          cumulativeDeclaredSize += declaredSize;
          if (cumulativeDeclaredSize > MAX_TOTAL_DECOMPRESSED_BYTES) throw new Error('DOCX archive cumulative size exceeds maximum safe limit of 50 MB.');
          if (declaredSize > 1024 * 1024 && compressedSize > 0) {
            const ratio = declaredSize / compressedSize;
            if (ratio > MAX_COMPRESSION_RATIO) throw new Error('Suspicious DOCX decompression ratio (' + ratio.toFixed(1) + 'x) detected for entry ' + name + '.');
          }
          if (name === 'word/document.xml') documentEntry = entry;
        }

        if (!documentEntry) throw new Error('Invalid DOCX format: missing word/document.xml');

        let documentXml;
        try {
          const rawCompressed = documentEntry.getCompressedData();
          if (documentEntry.header.method === 8) {
            const decompressedBuffer = zlib.inflateRawSync(rawCompressed, { maxOutputLength: MAX_SINGLE_ENTRY_DECOMPRESSED_BYTES });
            documentXml = decompressedBuffer.toString('utf8');
          } else if (documentEntry.header.method === 0) {
            if (rawCompressed.length > MAX_SINGLE_ENTRY_DECOMPRESSED_BYTES) throw new Error('DOCX document.xml exceeds maximum single-entry size limit.');
            documentXml = rawCompressed.toString('utf8');
          } else {
            throw new Error('Unsupported compression method in DOCX archive.');
          }
        } catch (err) {
          if (err.name === 'RangeError' || /maxOutputLength|larger than/i.test(err.message)) {
            throw new Error('Decompression bomb detected: word/document.xml decompressed stream exceeds single-entry limit of 15 MB.');
          }
          throw err;
        }

        const parser = new XMLParser({ preserveOrder: true, trimValues: false, ignoreAttributes: false, attributeNamePrefix: '@_' });
        const parsedRoot = parser.parse(documentXml);
        let bodyElements = [];
        for (const node of parsedRoot) {
          if (node && node['w:document'] && Array.isArray(node['w:document'])) {
            for (const docChild of node['w:document']) {
              if (docChild && docChild['w:body'] && Array.isArray(docChild['w:body'])) {
                bodyElements = docChild['w:body'];
                break;
              }
            }
          }
        }

        let blockCounter = 1;
        let sectionIndex = 1;
        let paraIndex = 1;
        let listIndex = 1;
        let tableIndex = 1;

        for (const element of bodyElements) {
          if (!element || typeof element !== 'object') continue;
          if (element['w:p']) {
            const { text, isBold } = extractTextFromParagraphNode(element);
            const trimmedText = text.trim();
            if (!trimmedText) continue;
            const { styleVal, isList, listLevel } = extractParagraphProperties(element);
            const isHeadingStyle = styleVal && /^(Heading[1-6]|Title|Subtitle|Head[1-6])$/i.test(styleVal);
            let headingLevel;
            if (isHeadingStyle && styleVal) {
              const match = styleVal.match(/\\d+/);
              headingLevel = match ? parseInt(match[0], 10) : 1;
            } else if (trimmedText.length <= 100 && (HEADING_REGEX.test(trimmedText) || (isBold && trimmedText.length <= 80 && trimmedText === trimmedText.toUpperCase()))) {
              headingLevel = trimmedText.startsWith('SECTION') || trimmedText === trimmedText.toUpperCase() ? 1 : 2;
            }
            if (headingLevel !== undefined) {
              blocks.push({
                block_id: 'DOCX-B' + (blockCounter++),
                page_number: undefined,
                structural_ref: 'sec-' + (sectionIndex++),
                type: 'heading',
                text: trimmedText,
                metadata: { heading_level: headingLevel, is_bold: true },
              });
              continue;
            }
            if (isList || LIST_ITEM_REGEX.test(trimmedText)) {
              blocks.push({
                block_id: 'DOCX-B' + (blockCounter++),
                page_number: undefined,
                structural_ref: 'list-' + (listIndex++),
                type: 'list',
                text: trimmedText,
                metadata: { list_level: listLevel || 1, is_bold: isBold },
              });
              continue;
            }
            blocks.push({
              block_id: 'DOCX-B' + (blockCounter++),
              page_number: undefined,
              structural_ref: 'para-' + (paraIndex++),
              type: 'paragraph',
              text: trimmedText,
              metadata: { is_bold: isBold },
            });
          } else if (element['w:tbl']) {
            const tableData = extractTableData(element);
            if (tableData.length > 0) {
              const textRepresentation = tableData.map((row) => row.join(' | ')).join('\\n');
              blocks.push({
                block_id: 'DOCX-B' + (blockCounter++),
                page_number: undefined,
                structural_ref: 'tbl-' + (tableIndex++),
                type: 'table',
                text: textRepresentation,
                table_data: tableData,
                metadata: { row_count: tableData.length, col_count: tableData[0]?.length || 0 },
              });
            }
          }
        }

        parentPort.postMessage({ success: true, result: { blocks, warnings, totalPages: undefined, extractedPages: undefined } });
      } catch (err) {
        parentPort.postMessage({ success: false, error: err.message });
      }
    `;

    let settled = false;
    let worker: Worker | null = null;
    let timer: NodeJS.Timeout | null = null;

    try {
      worker = new Worker(workerScript, {
        eval: true,
        workerData: { buffer, fileId },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      });
    } catch (err: any) {
      // Fallback to synchronous extraction if worker creation fails in environment
      try {
        return resolve(extractDocxContent(buffer, fileId));
      } catch (e) {
        return reject(e);
      }
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer);
    };

    timer = setTimeout(async () => {
      if (!settled) {
        settled = true;
        cleanup();
        if (worker) {
          try {
            await worker.terminate();
          } catch {
            // Ignore termination error
          }
        }
        reject(new Error(`DOCX extraction timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    worker.on('message', (msg) => {
      if (!settled) {
        settled = true;
        cleanup();
        if (msg.success) {
          resolve(msg.result);
        } else {
          reject(new Error(msg.error));
        }
      }
    });

    worker.on('error', (err) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      }
    });

    worker.on('exit', (code) => {
      if (!settled) {
        settled = true;
        cleanup();
        if (code !== 0) {
          reject(new Error(`DOCX worker terminated abnormally with code ${code}`));
        }
      }
    });
  });
}
