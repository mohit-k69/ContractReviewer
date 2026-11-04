import { BlockType } from '../extraction/types';

export type NormalizationStatus = 'COMPLETED' | 'PARTIAL' | 'FAILED';

export type StructuralNodeType =
  | 'section'
  | 'subsection'
  | 'clause'
  | 'subclause'
  | 'paragraph'
  | 'list'
  | 'list_item'
  | 'table';

export interface BaseNormalizedElement {
  id: string; // Unique, deterministic, stable ID within the document version
  type: StructuralNodeType;
  parent_id?: string;
  source_block_ids: string[];
  structural_position: number; // 1-indexed sequential position in document
  page_number?: number;
  structural_ref?: string;
  text: string; // Exact text as extracted (never paraphrased or altered)
}

export interface NormalizedParagraph extends BaseNormalizedElement {
  type: 'paragraph';
}

export interface NormalizedListItem extends BaseNormalizedElement {
  type: 'list_item';
  index: number;
  marker?: string;
}

export interface NormalizedList extends BaseNormalizedElement {
  type: 'list';
  items: NormalizedListItem[];
}

export interface NormalizedTable extends BaseNormalizedElement {
  type: 'table';
  table_data: string[][]; // Exact rows and cells
  row_count: number;
  col_count: number;
}

export interface NormalizedClause extends BaseNormalizedElement {
  type: 'clause' | 'subclause';
  title?: string;
  clause_number?: string;
  content: Array<NormalizedParagraph | NormalizedList | NormalizedTable | NormalizedClause>;
}

export interface NormalizedSection extends BaseNormalizedElement {
  type: 'section' | 'subsection';
  title: string;
  section_number?: string;
  level: number; // 1 for Section, 2 for Subsection
  children: Array<NormalizedClause | NormalizedParagraph | NormalizedList | NormalizedTable | NormalizedSection>;
}

export interface NormalizedDocument {
  document_id: string;
  source_file_id: string;
  source_format: 'pdf' | 'docx' | 'txt';
  verified_sha256: string;
  normalization_status: NormalizationStatus;

  // Ordered document hierarchy
  sections: NormalizedSection[];

  // Unclassified document-level elements (e.g. content before first heading or unassigned blocks)
  unclassified_blocks: Array<NormalizedParagraph | NormalizedList | NormalizedTable>;

  // Structural counts
  total_sections: number;
  total_subsections: number;
  total_clauses: number;
  total_paragraphs: number;
  total_tables: number;
  total_lists: number;
  total_elements: number;

  // Verification & traceability
  source_block_ids: string[];
  warnings: string[];
  normalization_duration_ms: number;
  normalized_at: string;
  error?: string;
}
