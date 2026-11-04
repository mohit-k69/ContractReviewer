import { DocumentExtractionResult, ExtractedBlock } from '../extraction/types';
import {
  NormalizedDocument,
  NormalizedSection,
  NormalizedClause,
  NormalizedParagraph,
  NormalizedList,
  NormalizedListItem,
  NormalizedTable,
  NormalizationStatus,
} from './types';

// Regex patterns for contract structural heading and numbering recognition
const LEVEL_1_SECTION_PREFIX = /^(SECTION|ARTICLE|PART|CLAUSE)\s+([0-9IVXLCDM]+|[A-Z])[\.:\s\-—]+(.*)$/i;
const LEVEL_1_NUMBERED_DOT = /^([0-9]+)\.0?\s+(.*)$/;
const LEVEL_1_NUMBERED_SPACE = /^([0-9]+)\s+([A-Z0-9\s,–—\-\(\)\/\&]{2,})$/;

const LEVEL_2_SUBSECTION_PREFIX = /^(Section|Clause)\s+([0-9]+\.[0-9]+)[\.:\s\-—]+(.*)$/i;
const LEVEL_2_NUMBERED_DOT = /^([0-9]+\.[0-9]+)\.?\s+(.*)$/;

const LEVEL_3_CLAUSE_PREFIX = /^([0-9]+\.[0-9]+\.[0-9]+)\.?\s+(.*)$/;
const CLAUSE_PAREN_PREFIX = /^\(([a-zA-Z0-9]+)\)\s*(.*)$/s;
const INLINE_CLAUSE_PATTERN = /^([0-9]+\.[0-9]+(?:\.[0-9]+)?)\s+([A-Z][a-zA-Z0-9\s\/\-]{2,40}[\.\:\-—])\s*(.*)$/s;
const ROMAN_NUMERAL_REGEX = /^(i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|xiii|xiv|xv|xvi|xvii|xviii|xix|xx)$/i;
const NUMERIC_CLAUSE_REGEX = /^\d+$/;

interface HeadingAnalysis {
  isHeading: boolean;
  level: 1 | 2 | 3;
  number?: string;
  title: string;
}

/**
 * Analyzes whether an extracted block constitutes a section, subsection, or clause heading,
 * inspecting both metadata heading levels and textual contract numbering conventions.
 */
function analyzeHeading(block: ExtractedBlock, hasOpenSection: boolean): HeadingAnalysis {
  const trimmed = block.text.trim();

  // 1. Level 1 Section matches
  const matchSec1 = trimmed.match(LEVEL_1_SECTION_PREFIX);
  if (matchSec1) {
    return {
      isHeading: true,
      level: 1,
      number: `${matchSec1[1]} ${matchSec1[2]}`,
      title: matchSec1[3].trim() || trimmed,
    };
  }

  // Level 2 Subsection numbered dot (e.g. 1.1 Scope)
  const matchSubSec2 = trimmed.match(LEVEL_2_NUMBERED_DOT);
  if (matchSubSec2) {
    return {
      isHeading: true,
      level: 2,
      number: matchSubSec2[1],
      title: matchSubSec2[2].trim(),
    };
  }

  const matchSubSecPrefix = trimmed.match(LEVEL_2_SUBSECTION_PREFIX);
  if (matchSubSecPrefix) {
    return {
      isHeading: true,
      level: 2,
      number: `${matchSubSecPrefix[1]} ${matchSubSecPrefix[2]}`,
      title: matchSubSecPrefix[3].trim() || trimmed,
    };
  }

  // Level 3 Clause numbered dot (e.g. 1.1.1 Detail)
  const matchClause3 = trimmed.match(LEVEL_3_CLAUSE_PREFIX);
  if (matchClause3) {
    return {
      isHeading: true,
      level: 3,
      number: matchClause3[1],
      title: matchClause3[2].trim(),
    };
  }

  // Level 1 Numbered dot (e.g. 1. SCOPE OF SERVICES)
  const matchSecDot = trimmed.match(LEVEL_1_NUMBERED_DOT);
  if (matchSecDot) {
    return {
      isHeading: true,
      level: 1,
      number: `${matchSecDot[1]}.`,
      title: matchSecDot[2].trim(),
    };
  }

  const matchSecSpace = trimmed.match(LEVEL_1_NUMBERED_SPACE);
  if (matchSecSpace) {
    return {
      isHeading: true,
      level: 1,
      number: matchSecSpace[1],
      title: matchSecSpace[2].trim(),
    };
  }

  // Explicit heading block from Phase 2A extraction
  if (block.type === 'heading') {
    const declaredLevel = block.metadata?.heading_level;
    if (declaredLevel === 1) {
      return { isHeading: true, level: 1, title: trimmed };
    }
    if (declaredLevel === 2) {
      return { isHeading: true, level: hasOpenSection ? 2 : 1, title: trimmed };
    }
    if (declaredLevel && declaredLevel >= 3) {
      return { isHeading: true, level: 3, title: trimmed };
    }

    // Unnumbered heading without explicit level
    if (!hasOpenSection) {
      return { isHeading: true, level: 1, title: trimmed };
    }
    // If all caps and short, treat as Level 1 major section, else Level 2
    if (trimmed.length < 50 && trimmed === trimmed.toUpperCase()) {
      return { isHeading: true, level: 1, title: trimmed };
    }
    return { isHeading: true, level: 2, title: trimmed };
  }

  return { isHeading: false, level: 1, title: trimmed };
}

/**
 * Parses individual items within a list block while maintaining exact text and order.
 */
function parseListItems(
  block: ExtractedBlock,
  fileId: string,
  parentId?: string
): NormalizedListItem[] {
  const lines = block.text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) {
    const markerMatch = block.text.match(/^(\([a-zA-Z0-9]+\)|[-*•]|\d+[\.\)])\s*/);
    return [
      {
        id: `li-${fileId}-${block.block_id}-1`,
        type: 'list_item',
        parent_id: parentId,
        source_block_ids: [block.block_id],
        structural_position: 1,
        page_number: block.page_number,
        structural_ref: block.structural_ref,
        text: block.text,
        index: 1,
        marker: markerMatch ? markerMatch[1] : undefined,
      },
    ];
  }

  return lines.map((line, idx) => {
    const markerMatch = line.match(/^(\([a-zA-Z0-9]+\)|[-*•]|\d+[\.\)])\s*/);
    return {
      id: `li-${fileId}-${block.block_id}-${idx + 1}`,
      type: 'list_item',
      parent_id: parentId,
      source_block_ids: [block.block_id],
      structural_position: idx + 1,
      page_number: block.page_number,
      structural_ref: block.structural_ref,
      text: line,
      index: idx + 1,
      marker: markerMatch ? markerMatch[1] : undefined,
    };
  });
}

/**
 * Normalizes an extraction result into a hierarchical contract document.
 * Adheres strictly to the invariant: zero rewriting, full content preservation, deterministic IDs.
 */
export function normalizeExtraction(extraction: DocumentExtractionResult): NormalizedDocument {
  const startTime = Date.now();
  const fileId = extraction.source_file_id || extraction.document_id;
  const warnings: string[] = [...(extraction.warnings || [])];

  const sections: NormalizedSection[] = [];
  const unclassifiedBlocks: Array<NormalizedParagraph | NormalizedList | NormalizedTable> = [];
  const allSourceBlockIds: string[] = [];

  let currentSection: NormalizedSection | null = null;
  let currentSubsection: NormalizedSection | null = null;
  let currentClause: NormalizedClause | null = null;
  let currentSubclause: NormalizedClause | null = null;

  let totalSections = 0;
  let totalSubsections = 0;
  let totalClauses = 0;
  let totalParagraphs = 0;
  let totalTables = 0;
  let totalLists = 0;
  let totalElements = 0;

  for (let i = 0; i < extraction.blocks.length; i++) {
    const block = extraction.blocks[i];
    const structuralPosition = i + 1;
    allSourceBlockIds.push(block.block_id);

    // 1. Check for Headings (Level 1, Level 2, Level 3)
    const headingAnalysis = analyzeHeading(block, currentSection !== null);

    if (headingAnalysis.isHeading) {
      if (headingAnalysis.level === 1) {
        totalSections++;
        totalElements++;
        const sectionId = `sec-${fileId}-${totalSections}`;
        const newSection: NormalizedSection = {
          id: sectionId,
          type: 'section',
          level: 1,
          title: headingAnalysis.title,
          section_number: headingAnalysis.number,
          source_block_ids: [block.block_id],
          structural_position: structuralPosition,
          page_number: block.page_number,
          structural_ref: block.structural_ref,
          text: block.text,
          children: [],
        };
        sections.push(newSection);
        currentSection = newSection;
        currentSubsection = null;
        currentClause = null;
        currentSubclause = null;
        continue;
      }

      if (headingAnalysis.level === 2) {
        totalSubsections++;
        totalElements++;
        // If no section is open yet, start a section first
        if (!currentSection) {
          totalSections++;
          currentSection = {
            id: `sec-${fileId}-${totalSections}`,
            type: 'section',
            level: 1,
            title: headingAnalysis.title,
            section_number: headingAnalysis.number,
            source_block_ids: [block.block_id],
            structural_position: structuralPosition,
            page_number: block.page_number,
            structural_ref: block.structural_ref,
            text: block.text,
            children: [],
          };
          sections.push(currentSection);
          currentSubsection = null;
          currentClause = null;
          currentSubclause = null;
          continue;
        }

        const subsecId = `subsec-${fileId}-${currentSection.id}-${currentSection.children.length + 1}`;
        const newSubsection: NormalizedSection = {
          id: subsecId,
          type: 'subsection',
          parent_id: currentSection.id,
          level: 2,
          title: headingAnalysis.title,
          section_number: headingAnalysis.number,
          source_block_ids: [block.block_id],
          structural_position: structuralPosition,
          page_number: block.page_number,
          structural_ref: block.structural_ref,
          text: block.text,
          children: [],
        };
        currentSection.children.push(newSubsection);
        currentSubsection = newSubsection;
        currentClause = null;
        currentSubclause = null;
        continue;
      }

      if (headingAnalysis.level === 3) {
        totalClauses++;
        totalElements++;
        const parentId = currentSubsection?.id || currentSection?.id;
        const clauseId = `cl-${fileId}-${block.block_id}`;
        const newClause: NormalizedClause = {
          id: clauseId,
          type: 'clause',
          parent_id: parentId,
          title: headingAnalysis.title,
          clause_number: headingAnalysis.number,
          source_block_ids: [block.block_id],
          structural_position: structuralPosition,
          page_number: block.page_number,
          structural_ref: block.structural_ref,
          text: block.text,
          content: [],
        };

        if (currentSubsection) {
          currentSubsection.children.push(newClause);
        } else if (currentSection) {
          currentSection.children.push(newClause);
        } else {
          totalSections++;
          currentSection = {
            id: `sec-${fileId}-${totalSections}`,
            type: 'section',
            level: 1,
            title: 'General Provisions',
            source_block_ids: [],
            structural_position: structuralPosition,
            text: 'General Provisions',
            children: [newClause],
          };
          newClause.parent_id = currentSection.id;
          sections.push(currentSection);
        }
        currentClause = newClause;
        currentSubclause = null;
        continue;
      }
    }

    // 2. Check for Table Blocks
    if (block.type === 'table') {
      totalTables++;
      totalElements++;
      const parentId = currentSubclause?.id || currentClause?.id || currentSubsection?.id || currentSection?.id;
      const normalizedTable: NormalizedTable = {
        id: `tbl-${fileId}-${block.block_id}`,
        type: 'table',
        parent_id: parentId,
        source_block_ids: [block.block_id],
        structural_position: structuralPosition,
        page_number: block.page_number,
        structural_ref: block.structural_ref,
        text: block.text,
        table_data: block.table_data || [],
        row_count: block.metadata?.row_count ?? (block.table_data?.length || 0),
        col_count: block.metadata?.col_count ?? (block.table_data?.[0]?.length || 0),
      };

      if (currentSubclause) {
        currentSubclause.content.push(normalizedTable);
      } else if (currentClause) {
        currentClause.content.push(normalizedTable);
      } else if (currentSubsection) {
        currentSubsection.children.push(normalizedTable);
      } else if (currentSection) {
        currentSection.children.push(normalizedTable);
      } else {
        unclassifiedBlocks.push(normalizedTable);
      }
      continue;
    }

    // 3. Check for List Blocks
    if (block.type === 'list') {
      totalLists++;
      totalElements++;
      const parentId = currentSubclause?.id || currentClause?.id || currentSubsection?.id || currentSection?.id;
      const listId = `list-${fileId}-${block.block_id}`;
      const items = parseListItems(block, fileId, listId);
      const normalizedList: NormalizedList = {
        id: listId,
        type: 'list',
        parent_id: parentId,
        source_block_ids: [block.block_id],
        structural_position: structuralPosition,
        page_number: block.page_number,
        structural_ref: block.structural_ref,
        text: block.text,
        items,
      };

      if (currentSubclause) {
        currentSubclause.content.push(normalizedList);
      } else if (currentClause) {
        currentClause.content.push(normalizedList);
      } else if (currentSubsection) {
        currentSubsection.children.push(normalizedList);
      } else if (currentSection) {
        currentSection.children.push(normalizedList);
      } else {
        unclassifiedBlocks.push(normalizedList);
      }
      continue;
    }

    // 4. Check for Paragraphs (with potential inline clause identification e.g. "(a) Term", "(i) Subclause", or "1.1 Deliverables.")
    const parenClauseMatch = block.text.match(CLAUSE_PAREN_PREFIX);
    const inlineClauseMatch = block.text.match(INLINE_CLAUSE_PATTERN);

    if (parenClauseMatch || inlineClauseMatch) {
      // Auto-open section if none open yet
      if (!currentSection) {
        totalSections++;
        currentSection = {
          id: `sec-${fileId}-${totalSections}`,
          type: 'section',
          level: 1,
          title: 'General Provisions',
          source_block_ids: [],
          structural_position: structuralPosition,
          text: 'General Provisions',
          children: [],
        };
        sections.push(currentSection);
      }

      if (parenClauseMatch) {
        const clauseMarker = parenClauseMatch[1];
        const isRoman = ROMAN_NUMERAL_REGEX.test(clauseMarker);
        const isNumeric = NUMERIC_CLAUSE_REGEX.test(clauseMarker);
        const isAlpha = /^[a-zA-Z]$/.test(clauseMarker) && !isRoman;

        if (isRoman && currentClause) {
          // Roman numeral inside an active clause -> nested subclause e.g. (i), (ii)
          // Sibling Roman numerals share parent_id = currentClause.id
          totalClauses++;
          totalElements++;
          const subclauseId = `cl-${fileId}-${block.block_id}`;
          const newSubclause: NormalizedClause = {
            id: subclauseId,
            type: 'subclause',
            parent_id: currentClause.id,
            clause_number: `(${clauseMarker})`,
            source_block_ids: [block.block_id],
            structural_position: structuralPosition,
            page_number: block.page_number,
            structural_ref: block.structural_ref,
            text: block.text,
            content: [],
          };
          currentClause.content.push(newSubclause);
          currentSubclause = newSubclause;
          continue;
        }

        if (isAlpha) {
          // Alpha letter clause e.g. (a), (b)
          // Sibling alpha clauses share parent_id = currentSubsection?.id || currentSection.id
          // Sibling (b) resets any active subclauses and attaches to the section/subsection directly
          totalClauses++;
          totalElements++;
          const clauseId = `cl-${fileId}-${block.block_id}`;
          const parentId = currentSubsection?.id || currentSection.id;
          const newClause: NormalizedClause = {
            id: clauseId,
            type: 'clause',
            parent_id: parentId,
            clause_number: `(${clauseMarker})`,
            source_block_ids: [block.block_id],
            structural_position: structuralPosition,
            page_number: block.page_number,
            structural_ref: block.structural_ref,
            text: block.text,
            content: [],
          };

          if (currentSubsection) {
            currentSubsection.children.push(newClause);
          } else {
            currentSection.children.push(newClause);
          }
          currentClause = newClause;
          currentSubclause = null;
          continue;
        }

        if (isNumeric && currentClause && currentClause.clause_number && /^\([a-zA-Z]\)$/.test(currentClause.clause_number)) {
          // Numeric parenthetical under an alpha clause e.g. (a) -> (1), (2)
          totalClauses++;
          totalElements++;
          const subclauseId = `cl-${fileId}-${block.block_id}`;
          const newSubclause: NormalizedClause = {
            id: subclauseId,
            type: 'subclause',
            parent_id: currentClause.id,
            clause_number: `(${clauseMarker})`,
            source_block_ids: [block.block_id],
            structural_position: structuralPosition,
            page_number: block.page_number,
            structural_ref: block.structural_ref,
            text: block.text,
            content: [],
          };
          currentClause.content.push(newSubclause);
          currentSubclause = newSubclause;
          continue;
        }

        // Generic parenthetical clause under section/subsection
        totalClauses++;
        totalElements++;
        const clauseId = `cl-${fileId}-${block.block_id}`;
        const parentId = currentSubsection?.id || currentSection.id;
        const newClause: NormalizedClause = {
          id: clauseId,
          type: 'clause',
          parent_id: parentId,
          clause_number: `(${clauseMarker})`,
          source_block_ids: [block.block_id],
          structural_position: structuralPosition,
          page_number: block.page_number,
          structural_ref: block.structural_ref,
          text: block.text,
          content: [],
        };
        if (currentSubsection) {
          currentSubsection.children.push(newClause);
        } else {
          currentSection.children.push(newClause);
        }
        currentClause = newClause;
        currentSubclause = null;
        continue;
      }

      if (inlineClauseMatch) {
        totalClauses++;
        totalElements++;
        const clauseNum = inlineClauseMatch[1];
        const clauseTitle = inlineClauseMatch[2].replace(/[\.\:\-—]\s*$/, '').trim();
        const clauseId = `cl-${fileId}-${block.block_id}`;
        const parentId = currentSubsection?.id || currentSection.id;

        const newClause: NormalizedClause = {
          id: clauseId,
          type: 'clause',
          parent_id: parentId,
          clause_number: clauseNum,
          title: clauseTitle,
          source_block_ids: [block.block_id],
          structural_position: structuralPosition,
          page_number: block.page_number,
          structural_ref: block.structural_ref,
          text: block.text,
          content: [],
        };

        if (currentSubsection) {
          currentSubsection.children.push(newClause);
        } else {
          currentSection.children.push(newClause);
        }
        currentClause = newClause;
        currentSubclause = null;
        continue;
      }
    }

    // Standard Paragraph
    totalParagraphs++;
    totalElements++;
    const parentId = currentSubclause?.id || currentClause?.id || currentSubsection?.id || currentSection?.id;
    const normalizedParagraph: NormalizedParagraph = {
      id: `p-${fileId}-${block.block_id}`,
      type: 'paragraph',
      parent_id: parentId,
      source_block_ids: [block.block_id],
      structural_position: structuralPosition,
      page_number: block.page_number,
      structural_ref: block.structural_ref,
      text: block.text,
    };

    if (currentSubclause) {
      currentSubclause.content.push(normalizedParagraph);
    } else if (currentClause) {
      currentClause.content.push(normalizedParagraph);
    } else if (currentSubsection) {
      currentSubsection.children.push(normalizedParagraph);
    } else if (currentSection) {
      currentSection.children.push(normalizedParagraph);
    } else {
      unclassifiedBlocks.push(normalizedParagraph);
    }
  }

  // Normalization Status determination
  let status: NormalizationStatus = 'COMPLETED';
  if (extraction.extraction_status === 'PARTIAL' || extraction.extraction_status === 'OCR_REQUIRED') {
    status = 'PARTIAL';
    warnings.push(
      `Normalization completed on partial extraction input (Source extraction status: ${extraction.extraction_status}).`
    );
  } else if (extraction.extraction_status === 'FAILED') {
    status = 'FAILED';
  }

  if (unclassifiedBlocks.length > 0 && sections.length > 0) {
    warnings.push(
      `Retained ${unclassifiedBlocks.length} preamble / unclassified document-level block(s) prior to first section.`
    );
  } else if (sections.length === 0 && unclassifiedBlocks.length > 0) {
    warnings.push(
      `Document contains no explicit section headings; all ${unclassifiedBlocks.length} block(s) preserved at document level.`
    );
  }

  return {
    document_id: `doc-norm-${fileId}`,
    source_file_id: fileId,
    source_format: extraction.source_format,
    verified_sha256: extraction.verified_sha256,
    normalization_status: status,
    sections,
    unclassified_blocks: unclassifiedBlocks,
    total_sections: totalSections,
    total_subsections: totalSubsections,
    total_clauses: totalClauses,
    total_paragraphs: totalParagraphs,
    total_tables: totalTables,
    total_lists: totalLists,
    total_elements: totalElements,
    source_block_ids: allSourceBlockIds,
    warnings,
    normalization_duration_ms: Date.now() - startTime,
    normalized_at: new Date().toISOString(),
  };
}
