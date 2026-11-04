export type ExtractionStatus = 'COMPLETED' | 'PARTIAL' | 'OCR_REQUIRED' | 'FAILED';

export type BlockType = 'heading' | 'paragraph' | 'list' | 'table';

export interface ExtractedBlock {
  block_id: string;
  page_number?: number;
  structural_ref?: string;
  type: BlockType;
  text: string;
  table_data?: string[][];
  metadata?: {
    heading_level?: number;
    list_level?: number;
    row_count?: number;
    col_count?: number;
    is_bold?: boolean;
  };
}

export interface DocumentExtractionResult {
  document_id: string;
  source_file_id: string;
  source_format: 'pdf' | 'docx' | 'txt';
  verified_sha256: string;
  extraction_status: ExtractionStatus;
  total_pages?: number;
  extracted_pages?: number;
  total_blocks: number;
  blocks: ExtractedBlock[];
  warnings: string[];
  extraction_duration_ms: number;
  extracted_at: string;
  error?: string;
}
