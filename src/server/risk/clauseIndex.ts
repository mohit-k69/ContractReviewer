import { NormalizedDocument } from '../normalization/types';
import { DocumentExtractionResult } from '../extraction/types';

export interface ClauseInfo {
  /** e.g. "Section 5. Termination › 5.1 Termination for Convenience" */
  label: string;
  /** Full text of the element (for lists/tables, the joined item/cell text) */
  text: string;
  /** Own text plus the text of every descendant (a section's full content) */
  full_text: string;
  /** Ids of all descendant elements, in document order */
  descendant_ids: string[];
  /** The element's own source blocks (id + exact text); empty when extraction blocks were not supplied */
  blocks: Array<{ id: string; text: string }>;
}

export type ClauseIndex = Map<string, ClauseInfo>;

function nodeText(node: any): string {
  if (node.type === 'list' && Array.isArray(node.items)) {
    return node.items.map((i: any) => i.text).join(' ');
  }
  if (node.type === 'table' && Array.isArray(node.table_data)) {
    return node.table_data.map((r: string[]) => r.join(' | ')).join('\n');
  }
  return typeof node.text === 'string' ? node.text : '';
}

/** Normalizer "titles" can be a whole paragraph; keep just the heading-like first sentence. */
function shortTitle(raw: string): string {
  let head = raw.trim().split(/[.:]\s/)[0].replace(/[.:]$/, '').trim();
  if (head.length > 70) head = `${head.slice(0, 67).trimEnd()}…`;
  return head;
}

function ownLabel(node: any): string {
  const title = typeof node.title === 'string' ? shortTitle(node.title) : '';
  if (node.type === 'section' || node.type === 'subsection') {
    const num = node.section_number ? `${node.section_number}` : '';
    if (title && num && !title.toLowerCase().startsWith(num.toLowerCase())) return `${num} ${title}`.trim();
    return title || (num ? `Section ${num}` : 'Section');
  }
  if (node.type === 'clause' || node.type === 'subclause') {
    const num = node.clause_number ? `${node.clause_number}` : '';
    return [num, title].filter(Boolean).join(' ') || 'Clause';
  }
  return '';
}

/**
 * Builds a lookup from normalized element id -> human-readable clause reference and full text.
 * Purely derived from the (already cached) Phase 2B normalization: no re-extraction or re-parsing.
 */
export function buildClauseIndex(
  doc: NormalizedDocument | undefined,
  extraction?: DocumentExtractionResult
): ClauseIndex {
  const index: ClauseIndex = new Map();
  if (!doc) return index;

  const blockText = new Map<string, string>();
  for (const b of extraction?.blocks || []) blockText.set(b.block_id, b.text);

  function walk(node: any, trail: string[]): { full: string; ids: string[] } | null {
    if (!node || typeof node !== 'object' || !node.id) return null;
    const own = ownLabel(node);
    const nextTrail = own ? [...trail, own] : trail;
    const label = nextTrail.length > 0 ? nextTrail.join(' › ') : 'Document';
    const blocks = (Array.isArray(node.source_block_ids) ? node.source_block_ids : [])
      .filter((id: string) => blockText.has(id))
      .map((id: string) => ({ id, text: blockText.get(id)! }));
    const text = nodeText(node);
    const info: ClauseInfo = { label, text, full_text: text, descendant_ids: [], blocks };
    index.set(node.id, info); // inserted before children so iteration stays in document order

    for (const key of ['children', 'content', 'items'] as const) {
      if (Array.isArray(node[key])) {
        for (const child of node[key]) {
          const sub = walk(child, nextTrail);
          if (sub) {
            info.full_text += `\n${sub.full}`;
            info.descendant_ids.push(child.id, ...sub.ids);
          }
        }
      }
    }
    return { full: info.full_text, ids: info.descendant_ids };
  }

  for (const block of doc.unclassified_blocks || []) walk(block, ['Preamble']);
  for (const section of doc.sections || []) walk(section, []);
  return index;
}
