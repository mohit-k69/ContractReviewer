import { ExtractedBlock } from './types';

// Patterns for detecting contract headings
const HEADING_REGEX = /^(SECTION\s+\d+|ARTICLE\s+\d+|CLAUSE\s+\d+|EXHIBIT\s+[A-Z]|SCHEDULE\s+[A-Z]|\d+(\.\d+)*\s+[A-Z][A-Za-z0-9\s,\-_:;()]+|[A-Z\s\-_:]{4,80})$/;
const LIST_ITEM_REGEX = /^(\s*[-*•]\s+|\s*\(\w+\)\s+|\s*\d+[\.\)]\s+)/;

export interface TxtExtractionOutput {
  blocks: ExtractedBlock[];
  warnings: string[];
  totalPages: number;
  status: 'COMPLETED' | 'FAILED';
  error?: string;
}

export function extractTxtContent(
  buffer: Buffer,
  fileId: string
): TxtExtractionOutput {
  const warnings: string[] = [];

  // Strictly validate UTF-8 encoding (fatal: true rejects invalid byte sequences)
  let text: string;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    text = decoder.decode(buffer);
  } catch (err: any) {
    const errorMsg = `Invalid UTF-8 encoding detected: ${err.message}. Text files must be valid UTF-8 encoded documents.`;
    warnings.push(errorMsg);
    return {
      blocks: [],
      warnings,
      totalPages: 1,
      status: 'FAILED',
      error: errorMsg,
    };
  }

  // Strip UTF-8 Byte Order Mark (BOM) if present
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  // Normalize Windows/Unix line endings
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  if (normalized.trim().length === 0) {
    warnings.push('Document contains no readable text content.');
    return { blocks: [], warnings, totalPages: 1, status: 'FAILED' };
  }

  // Split into raw paragraph chunks separated by one or more blank lines
  const rawParagraphs = normalized.split(/\n\s*\n/);
  const blocks: ExtractedBlock[] = [];
  let blockCounter = 1;

  for (const para of rawParagraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // Check if paragraph is a table (multiple lines containing pipe '|' or multiple tab characters)
    const lines = trimmed.split('\n');
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

      // Filter out markdown divider lines (like |---|---|)
      const cleanedRows = tableData.filter((row) =>
        !row.every((cell) => /^[:\s\-]+$/.test(cell))
      );

      if (cleanedRows.length > 0) {
        blocks.push({
          block_id: `TXT-B${blockCounter++}`,
          page_number: 1,
          structural_ref: `para-${blockCounter}`,
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
            block_id: `TXT-B${blockCounter++}`,
            page_number: 1,
            structural_ref: `list-${blockCounter}`,
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
        // Intro line (e.g. "Deliverables include:") followed by list items
        blocks.push({
          block_id: `TXT-B${blockCounter++}`,
          page_number: 1,
          structural_ref: `para-${blockCounter}`,
          type: 'paragraph',
          text: lines[0].trim(),
        });
        for (const line of lines.slice(1)) {
          const itemText = line.trim();
          if (!itemText) continue;
          blocks.push({
            block_id: `TXT-B${blockCounter++}`,
            page_number: 1,
            structural_ref: `list-${blockCounter}`,
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
        block_id: `TXT-B${blockCounter++}`,
        page_number: 1,
        structural_ref: `heading-${blockCounter}`,
        type: 'heading',
        text: firstLine,
        metadata: {
          heading_level: firstLine.startsWith('SECTION') || firstLine === firstLine.toUpperCase() ? 1 : 2,
        },
      });
    } else {
      blocks.push({
        block_id: `TXT-B${blockCounter++}`,
        page_number: 1,
        structural_ref: `para-${blockCounter}`,
        type: 'paragraph',
        text: trimmed,
      });
    }
  }

  return {
    blocks,
    warnings,
    totalPages: 1,
    status: blocks.length > 0 ? 'COMPLETED' : 'FAILED',
  };
}
