import { Worker } from 'node:worker_threads';
import { PDFParse } from 'pdf-parse';
import { ExtractedBlock, ExtractionStatus } from './types';

const HEADING_REGEX = /^(SECTION\s+\d+|ARTICLE\s+\d+|CLAUSE\s+\d+|EXHIBIT\s+[A-Z]|SCHEDULE\s+[A-Z]|\d+(\.\d+)*\s+[A-Z][A-Za-z0-9\s,\-_:;()]+|[A-Z\s\-_:]{4,80})$/;
const LIST_ITEM_REGEX = /^(\s*[-*•]\s+|\s*\(\w+\)\s+|\s*\d+[\.\)]\s+)/;

export interface PdfExtractionOutput {
  status: ExtractionStatus;
  blocks: ExtractedBlock[];
  warnings: string[];
  totalPages: number;
  extractedPages: number;
  scannedPages: number[];
}

export function parsePdfTextIntoBlocks(
  textResult: { pages: Array<{ text: string; num?: number }>; total?: number },
  buffer: Buffer
): PdfExtractionOutput {
  const warnings: string[] = [];
  const scannedPages: number[] = [];
  const blocks: ExtractedBlock[] = [];

  const rawString = buffer.toString('latin1');
  const hasImageObjects =
    rawString.includes('/Subtype /Image') ||
    rawString.includes('/Subtype/Image') ||
    rawString.includes('/XObject') ||
    rawString.includes('/Image');

  const totalPages = textResult.total || textResult.pages?.length || 1;
  let blockCounter = 1;
  let extractedPagesCount = 0;

  for (let i = 0; i < textResult.pages.length; i++) {
    const page = textResult.pages[i];
    const pageNum = page.num || i + 1;
    const pageText = (page.text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

    // Count non-whitespace characters
    const nonWhitespaceCount = pageText.replace(/\s+/g, '').length;

    if (nonWhitespaceCount < 10) {
      if (hasImageObjects) {
        scannedPages.push(pageNum);
        warnings.push(
          `Page ${pageNum} contains insufficient digital text (${nonWhitespaceCount} chars) and appears to be a scanned image.`
        );
      } else {
        warnings.push(`Page ${pageNum} appears blank or contains minimal text.`);
      }
      continue;
    }

    extractedPagesCount++;

    // Process readable page text into structured blocks
    const rawParagraphs = pageText.split(/\n\s*\n/);
    let pageBlockIndex = 1;

    for (const para of rawParagraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;

      const lines = trimmed.split('\n');

      // Check if paragraph is a table (pipe or tab delimited)
      const isPipeTable = lines.length >= 2 && lines.every((l) => l.includes('|'));
      const isTabTable = lines.length >= 2 && lines.every((l) => l.includes('\t'));

      if (isPipeTable || isTabTable) {
        const sep = isPipeTable ? '|' : '\t';
        const tableData = lines.map((l) =>
          l
            .split(sep)
            .map((c) => c.trim())
            .filter((c, idx, arr) => !(isPipeTable && (idx === 0 || idx === arr.length - 1) && c === ''))
        );

        const cleanedRows = tableData.filter((row) =>
          !row.every((cell) => /^[:\s\-]+$/.test(cell))
        );

        if (cleanedRows.length > 0) {
          blocks.push({
            block_id: `PDF-P${pageNum}-B${blockCounter++}`,
            page_number: pageNum,
            structural_ref: `p${pageNum}-tbl-${pageBlockIndex++}`,
            type: 'table',
            text: trimmed,
            table_data: cleanedRows,
            metadata: {
              row_count: cleanedRows.length,
              col_count: cleanedRows[0]?.length || 0,
            },
          });
          continue;
        }
      }

      // Check for lists
      const hasListItems = lines.some((l) => LIST_ITEM_REGEX.test(l.trim()));
      if (hasListItems) {
        if (lines.every((l) => LIST_ITEM_REGEX.test(l.trim()))) {
          for (const line of lines) {
            const itemText = line.trim();
            if (!itemText) continue;
            blocks.push({
              block_id: `PDF-P${pageNum}-B${blockCounter++}`,
              page_number: pageNum,
              structural_ref: `p${pageNum}-list-${pageBlockIndex++}`,
              type: 'list',
              text: itemText,
              metadata: {
                list_level: 1,
              },
            });
          }
          continue;
        } else if (
          lines.length > 1 &&
          !LIST_ITEM_REGEX.test(lines[0].trim()) &&
          lines.slice(1).every((l) => LIST_ITEM_REGEX.test(l.trim()))
        ) {
          blocks.push({
            block_id: `PDF-P${pageNum}-B${blockCounter++}`,
            page_number: pageNum,
            structural_ref: `p${pageNum}-para-${pageBlockIndex++}`,
            type: 'paragraph',
            text: lines[0].trim(),
          });
          for (const line of lines.slice(1)) {
            const itemText = line.trim();
            if (!itemText) continue;
            blocks.push({
              block_id: `PDF-P${pageNum}-B${blockCounter++}`,
              page_number: pageNum,
              structural_ref: `p${pageNum}-list-${pageBlockIndex++}`,
              type: 'list',
              text: itemText,
              metadata: {
                list_level: 1,
              },
            });
          }
          continue;
        }
      }

      // Check for heading
      const firstLine = lines[0].trim();
      const isSingleLine = lines.length === 1;
      const isHeading =
        (isSingleLine && firstLine.length <= 100 && HEADING_REGEX.test(firstLine)) ||
        (isSingleLine && firstLine.length <= 80 && firstLine === firstLine.toUpperCase() && /[A-Z]/.test(firstLine));

      if (isHeading) {
        blocks.push({
          block_id: `PDF-P${pageNum}-B${blockCounter++}`,
          page_number: pageNum,
          structural_ref: `p${pageNum}-heading-${pageBlockIndex++}`,
          type: 'heading',
          text: firstLine,
          metadata: {
            heading_level: firstLine.startsWith('SECTION') || firstLine === firstLine.toUpperCase() ? 1 : 2,
          },
        });
      } else {
        blocks.push({
          block_id: `PDF-P${pageNum}-B${blockCounter++}`,
          page_number: pageNum,
          structural_ref: `p${pageNum}-para-${pageBlockIndex++}`,
          type: 'paragraph',
          text: trimmed,
        });
      }
    }
  }

  // Determine overall status
  let status: ExtractionStatus = 'COMPLETED';

  if (scannedPages.length > 0) {
    if (extractedPagesCount === 0) {
      status = 'OCR_REQUIRED';
      warnings.unshift(
        'This document is a scanned or image-only PDF. Optical Character Recognition (OCR) is required to extract text.'
      );
    } else {
      status = 'PARTIAL';
      warnings.unshift(
        `Document partially extracted. ${scannedPages.length} of ${totalPages} page(s) appear to be scanned images requiring OCR.`
      );
    }
  } else if (blocks.length === 0) {
    status = 'FAILED';
    warnings.push('No readable text content could be extracted from this PDF.');
  }

  return {
    status,
    blocks,
    warnings,
    totalPages,
    extractedPages: extractedPagesCount,
    scannedPages,
  };
}

/**
 * Direct PDF text extraction.
 */
export async function extractPdfDirect(
  buffer: Buffer,
  fileId: string
): Promise<PdfExtractionOutput> {
  const parser = new PDFParse({ data: buffer });
  try {
    const textResult = await parser.getText();
    return parsePdfTextIntoBlocks(textResult, buffer);
  } finally {
    try {
      await parser.destroy();
    } catch {
      // Ignore destroy errors
    }
  }
}

/**
 * Worker-isolated PDF extraction with genuine thread-level timeout termination.
 * If the parser times out, worker.terminate() terminates the worker immediately,
 * preventing runaway CPU or memory consumption.
 */
export async function extractPdfContent(
  buffer: Buffer,
  fileId: string,
  timeoutMs: number = 25000
): Promise<PdfExtractionOutput> {
  return new Promise((resolve, reject) => {
    const workerScript = `
      const { parentPort, workerData } = require('node:worker_threads');
      const { PDFParse } = require('pdf-parse');

      (async () => {
        let parser = null;
        try {
          const buffer = Buffer.from(workerData.buffer);
          parser = new PDFParse({ data: buffer });
          const textResult = await parser.getText();
          await parser.destroy();
          parser = null;
          parentPort.postMessage({ success: true, textResult });
        } catch (err) {
          if (parser) {
            try { await parser.destroy(); } catch (_) {}
          }
          parentPort.postMessage({ success: false, error: err.message });
        }
      })();
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
      // Fallback to direct extraction if worker thread creation is restricted
      return extractPdfDirect(buffer, fileId).then(resolve).catch(reject);
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
            // Ignore termination errors
          }
        }
        reject(new Error(`PDF extraction timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    worker.on('message', (msg) => {
      if (!settled) {
        settled = true;
        cleanup();
        if (msg.success) {
          try {
            const output = parsePdfTextIntoBlocks(msg.textResult, buffer);
            resolve(output);
          } catch (err: any) {
            reject(err);
          }
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
          reject(new Error(`PDF worker terminated abnormally with code ${code}`));
        }
      }
    });
  });
}
