import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { ExtractedBlock } from './types';

const HEADING_REGEX = /^(SECTION\s+\d+|ARTICLE\s+\d+|CLAUSE\s+\d+|EXHIBIT\s+[A-Z]|SCHEDULE\s+[A-Z]|\d+(\.\d+)*\s+[A-Z][A-Za-z0-9\s,\-_:;()]+|[A-Z\s\-_:]{4,80})$/;
const LIST_ITEM_REGEX = /^(\s*[-*•]\s+|\s*\(\w+\)\s+|\s*\d+[\.\)]\s+)/;

const MAX_ENTRY_SIZE_BYTES = 15 * 1024 * 1024; // 15MB

interface AnyXmlNode {
  [key: string]: any;
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

export function extractDocxContent(
  buffer: Buffer,
  fileId: string
): { blocks: ExtractedBlock[]; warnings: string[]; totalPages: number } {
  const warnings: string[] = [];
  const blocks: ExtractedBlock[] = [];

  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err: any) {
    throw new Error(`Failed to read DOCX zip archive: ${err.message}`);
  }

  const documentEntry = zip.getEntry('word/document.xml');
  if (!documentEntry) {
    throw new Error('Invalid DOCX format: missing word/document.xml');
  }

  if (documentEntry.header.size > MAX_ENTRY_SIZE_BYTES) {
    throw new Error(`DOCX document.xml exceeds maximum safe size (${documentEntry.header.size} bytes)`);
  }

  const documentXml = zip.readAsText(documentEntry, 'utf8');

  const parser = new XMLParser({
    preserveOrder: true,
    trimValues: false,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });

  const parsedRoot = parser.parse(documentXml);

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
    return { blocks: [], warnings, totalPages: 1 };
  }

  let blockCounter = 1;
  let sectionIndex = 1;

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
        blocks.push({
          block_id: `DOCX-B${blockCounter++}`,
          page_number: 1,
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
          page_number: 1,
          structural_ref: `list-${blockCounter}`,
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
        page_number: 1,
        structural_ref: `para-${blockCounter}`,
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
          page_number: 1,
          structural_ref: `sec-${sectionIndex}.tbl-${blockCounter}`,
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

  return {
    blocks,
    warnings,
    totalPages: 1,
  };
}
