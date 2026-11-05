import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { normalizeExtraction } from './normalizationEngine';
import {
  normalizeContractDocument,
  getCachedNormalization,
  clearAllCachedNormalizations,
  invalidateCachedNormalization,
} from './normalizationService';
import { DocumentExtractionResult, ExtractedBlock } from '../extraction/types';
import {
  storeInQuarantine,
  saveSecurityReport,
  deleteQuarantinedFile,
  purgeDocumentRecord,
} from '../security/quarantineManager';
import { extractContractDocument } from '../extraction/extractionService';
import { FullSecurityReport } from '../security/types';

describe('Phase 2B Document Normalization Engine — Unit Tests', () => {
  // Test 1: TXT Normalization with numbered sections, clauses, preamble, and exact financial figures
  it('should normalize TXT contract with preamble, numbered sections, clauses, and exact figures', () => {
    const blocks: ExtractedBlock[] = [
      {
        block_id: 'b1',
        type: 'paragraph',
        text: 'INDEPENDENT CONTRACTOR AGREEMENT\nThis Agreement is entered into on January 15, 2026 by and between Company Inc. and Contractor LLC.',
      },
      {
        block_id: 'b2',
        type: 'heading',
        metadata: { heading_level: 1 },
        text: '1. SCOPE OF SERVICES',
      },
      {
        block_id: 'b3',
        type: 'paragraph',
        text: 'Contractor agrees to provide software development and architecture consulting services.',
      },
      {
        block_id: 'b4',
        type: 'heading',
        metadata: { heading_level: 2 },
        text: '1.1 Deliverables and Milestones',
      },
      {
        block_id: 'b5',
        type: 'paragraph',
        text: 'Deliverables shall be provided in accordance with Schedule A attached hereto.',
      },
      {
        block_id: 'b6',
        type: 'paragraph',
        text: '(a) Phase 1 delivery is scheduled for March 1, 2026.',
      },
      {
        block_id: 'b7',
        type: 'paragraph',
        text: '(b) Phase 2 delivery is scheduled for June 30, 2026.',
      },
      {
        block_id: 'b8',
        type: 'heading',
        metadata: { heading_level: 1 },
        text: '2. COMPENSATION AND PAYMENT TERMS',
      },
      {
        block_id: 'b9',
        type: 'paragraph',
        text: 'Company agrees to pay Contractor a fixed fee of $15,750.00 USD plus applicable taxes of 8.25%. Invoices are due Net 30 days from receipt. Late fees of 1.5% per month will apply.',
      },
    ];

    const extraction: DocumentExtractionResult = {
      document_id: 'doc-txt-1',
      source_file_id: 'file-txt-1',
      source_format: 'txt',
      verified_sha256: 'a1b2c3d4e5f6',
      extraction_status: 'COMPLETED',
      total_blocks: blocks.length,
      blocks,
      warnings: [],
      extraction_duration_ms: 12,
      extracted_at: new Date().toISOString(),
    };

    const normalized = normalizeExtraction(extraction);

    assert.equal(normalized.normalization_status, 'COMPLETED');
    assert.equal(normalized.source_format, 'txt');
    assert.equal(normalized.verified_sha256, 'a1b2c3d4e5f6');

    // Preamble should be preserved in unclassified_blocks
    assert.equal(normalized.unclassified_blocks.length, 1);
    assert.equal(normalized.unclassified_blocks[0].text, blocks[0].text);
    assert.equal(normalized.unclassified_blocks[0].id, 'p-file-txt-1-b1');

    // Sections
    assert.equal(normalized.sections.length, 2);
    assert.equal(normalized.sections[0].title, 'SCOPE OF SERVICES');
    assert.equal(normalized.sections[0].section_number, '1.');
    assert.equal(normalized.sections[1].title, 'COMPENSATION AND PAYMENT TERMS');
    assert.equal(normalized.sections[1].section_number, '2.');

    // Exact financial figures preserved without alteration
    const compensationText = normalized.sections[1].children[0].text;
    assert.ok(compensationText.includes('$15,750.00 USD'));
    assert.ok(compensationText.includes('8.25%'));
    assert.ok(compensationText.includes('Net 30'));
    assert.ok(compensationText.includes('1.5% per month'));

    // Subsections and clauses inside Section 1
    const sec1Children = normalized.sections[0].children;
    assert.ok(sec1Children.some((c) => c.type === 'subsection' && c.title === 'Deliverables and Milestones'));
  });

  // Test 2: DOCX Normalization with tables, lists, and metadata heading levels
  it('should normalize DOCX contract with tables, lists, and preserve cell relations', () => {
    const tableData = [
      ['Milestone', 'Completion Date', 'Fee Amount ($)'],
      ['Phase 1 Prototype', '2026-04-15', '$5,000.00'],
      ['Phase 2 Beta Release', '2026-07-01', '$7,500.00'],
      ['Final Acceptance', '2026-09-30', '$10,000.00'],
    ];

    const blocks: ExtractedBlock[] = [
      {
        block_id: 'd1',
        type: 'heading',
        metadata: { heading_level: 1 },
        text: 'SECTION 1. STATEMENT OF WORK',
      },
      {
        block_id: 'd2',
        type: 'paragraph',
        text: 'The parties agree to the following payment schedule and milestone deliveries:',
      },
      {
        block_id: 'd3',
        type: 'table',
        table_data: tableData,
        metadata: { row_count: 4, col_count: 3 },
        text: 'Milestone | Completion Date | Fee Amount ($)\nPhase 1 Prototype | 2026-04-15 | $5,000.00',
      },
      {
        block_id: 'd4',
        type: 'heading',
        metadata: { heading_level: 1 },
        text: 'SECTION 2. CONTRACTOR RESPONSIBILITIES',
      },
      {
        block_id: 'd5',
        type: 'list',
        text: '1. Maintain confidentiality of proprietary data.\n2. Supply own equipment and tools.\n3. Comply with security policies.',
      },
    ];

    const extraction: DocumentExtractionResult = {
      document_id: 'doc-docx-1',
      source_file_id: 'file-docx-1',
      source_format: 'docx',
      verified_sha256: 'd0c1d0c2d0c3',
      extraction_status: 'COMPLETED',
      total_blocks: blocks.length,
      blocks,
      warnings: [],
      extraction_duration_ms: 25,
      extracted_at: new Date().toISOString(),
    };

    const normalized = normalizeExtraction(extraction);

    assert.equal(normalized.normalization_status, 'COMPLETED');
    assert.equal(normalized.sections.length, 2);
    assert.equal(normalized.total_tables, 1);
    assert.equal(normalized.total_lists, 1);

    // Verify Table normalization
    const sec1 = normalized.sections[0];
    const tableNode = sec1.children.find((c) => c.type === 'table') as any;
    assert.ok(tableNode);
    assert.equal(tableNode.row_count, 4);
    assert.equal(tableNode.col_count, 3);
    assert.deepEqual(tableNode.table_data, tableData);

    // Verify List normalization and individual item parsing
    const sec2 = normalized.sections[1];
    const listNode = sec2.children.find((c) => c.type === 'list') as any;
    assert.ok(listNode);
    assert.equal(listNode.items.length, 3);
    assert.ok(listNode.items[0].text.includes('Maintain confidentiality'));
    assert.equal(listNode.items[0].index, 1);
  });

  // Test 3: PDF Normalization with unnumbered headings, missing/inconsistent numbering
  it('should normalize PDF with unnumbered headings and inconsistent numbering', () => {
    const blocks: ExtractedBlock[] = [
      {
        block_id: 'p1',
        type: 'heading',
        page_number: 1,
        text: '1. APPOINTMENT',
      },
      {
        block_id: 'p2',
        type: 'paragraph',
        page_number: 1,
        text: 'Client hereby appoints Consultant to provide advisory services.',
      },
      {
        block_id: 'p3',
        type: 'heading', // Unnumbered heading in between numbered sections
        page_number: 1,
        text: 'COMPENSATION AND EXPENSES',
      },
      {
        block_id: 'p4',
        type: 'paragraph',
        page_number: 2,
        text: 'Client shall reimburse Consultant for pre-approved travel expenses up to €1,200.00.',
      },
      {
        block_id: 'p5',
        type: 'heading',
        page_number: 2,
        text: '3. TERM AND TERMINATION', // Inconsistent numbering jump (1 -> unnumbered -> 3)
      },
      {
        block_id: 'p6',
        type: 'paragraph',
        page_number: 2,
        text: 'This agreement shall commence on April 1, 2026 and continue for twelve (12) months.',
      },
    ];

    const extraction: DocumentExtractionResult = {
      document_id: 'doc-pdf-1',
      source_file_id: 'file-pdf-1',
      source_format: 'pdf',
      verified_sha256: 'pdfsha256test',
      extraction_status: 'COMPLETED',
      total_blocks: blocks.length,
      blocks,
      warnings: [],
      extraction_duration_ms: 30,
      extracted_at: new Date().toISOString(),
    };

    const normalized = normalizeExtraction(extraction);

    assert.equal(normalized.sections.length, 3);
    assert.equal(normalized.sections[0].title, 'APPOINTMENT');
    assert.equal(normalized.sections[0].section_number, '1.');

    assert.equal(normalized.sections[1].title, 'COMPENSATION AND EXPENSES');
    assert.equal(normalized.sections[1].section_number, undefined);

    assert.equal(normalized.sections[2].title, 'TERM AND TERMINATION');
    assert.equal(normalized.sections[2].section_number, '3.');

    // Page numbers preserved
    assert.equal(normalized.sections[0].page_number, 1);
    assert.equal(normalized.sections[2].children[0].page_number, 2);
  });

  // Test 4: Document with NO headings (all unclassified / preamble)
  it('should retain all content as unclassified blocks when document has no headings', () => {
    const blocks: ExtractedBlock[] = [
      {
        block_id: 'u1',
        type: 'paragraph',
        text: 'This Letter of Intent summarizes the terms of mutual interest between Company and Contractor.',
      },
      {
        block_id: 'u2',
        type: 'paragraph',
        text: 'Neither party shall be bound until a definitive agreement is executed.',
      },
    ];

    const extraction: DocumentExtractionResult = {
      document_id: 'doc-no-head',
      source_file_id: 'file-no-head',
      source_format: 'txt',
      verified_sha256: 'nohead12345',
      extraction_status: 'COMPLETED',
      total_blocks: blocks.length,
      blocks,
      warnings: [],
      extraction_duration_ms: 5,
      extracted_at: new Date().toISOString(),
    };

    const normalized = normalizeExtraction(extraction);

    assert.equal(normalized.sections.length, 0);
    assert.equal(normalized.unclassified_blocks.length, 2);
    assert.equal(normalized.total_elements, 2);
    assert.equal(normalized.unclassified_blocks[0].text, blocks[0].text);
    assert.equal(normalized.unclassified_blocks[1].text, blocks[1].text);
  });

  // Test 5: Exact Content Preservation (no character altered)
  it('should preserve exact contractual text, punctuation, and currency characters', () => {
    const complexWording =
      'Contractor agrees to indemnify, defend, and hold harmless "Company, Inc." & its affiliates from any liability, including reasonable attorneys\' fees, up to $250,000.00 (€230,000.00 / £195,000.00), pursuant to Section 12.3(a)(i).';

    const blocks: ExtractedBlock[] = [
      {
        block_id: 'w1',
        type: 'heading',
        text: 'SECTION 12. INDEMNIFICATION',
      },
      {
        block_id: 'w2',
        type: 'paragraph',
        text: complexWording,
      },
    ];

    const extraction: DocumentExtractionResult = {
      document_id: 'doc-exact',
      source_file_id: 'file-exact',
      source_format: 'docx',
      verified_sha256: 'sha-exact-123',
      extraction_status: 'COMPLETED',
      total_blocks: blocks.length,
      blocks,
      warnings: [],
      extraction_duration_ms: 10,
      extracted_at: new Date().toISOString(),
    };

    const normalized = normalizeExtraction(extraction);

    const paragraph = normalized.sections[0].children[0];
    assert.equal(paragraph.text, complexWording);
  });

  // Test 6: Stable IDs (Repeated normalization yields identical IDs)
  it('should produce identical, stable IDs across repeated normalization runs', () => {
    const blocks: ExtractedBlock[] = [
      { block_id: 'b1', type: 'paragraph', text: 'Preamble text.' },
      { block_id: 'b2', type: 'heading', text: '1. SERVICES' },
      { block_id: 'b3', type: 'paragraph', text: 'Paragraph one.' },
      { block_id: 'b4', type: 'heading', text: '1.1 Milestones' },
      { block_id: 'b5', type: 'paragraph', text: 'Milestone details.' },
    ];

    const extraction: DocumentExtractionResult = {
      document_id: 'doc-stable-id',
      source_file_id: 'file-stable-id',
      source_format: 'txt',
      verified_sha256: 'stableidsha',
      extraction_status: 'COMPLETED',
      total_blocks: blocks.length,
      blocks,
      warnings: [],
      extraction_duration_ms: 8,
      extracted_at: new Date().toISOString(),
    };

    const run1 = normalizeExtraction(extraction);
    const run2 = normalizeExtraction(extraction);

    assert.equal(run1.document_id, run2.document_id);
    assert.equal(run1.unclassified_blocks[0].id, run2.unclassified_blocks[0].id);
    assert.equal(run1.sections[0].id, run2.sections[0].id);
    assert.equal(run1.sections[0].children[0].id, run2.sections[0].children[0].id);
    assert.equal(run1.sections[0].children[1].id, run2.sections[0].children[1].id);
  });

  // Test 7: Regression Test: Sibling clauses (a) and (b)
  it('should correctly structure sibling clauses (a) and (b) under the same parent without nesting or text duplication', () => {
    const blocks: ExtractedBlock[] = [
      {
        block_id: 's1',
        type: 'heading',
        metadata: { heading_level: 1 },
        text: 'SECTION 5. TERM AND TERMINATION',
      },
      {
        block_id: 'p1',
        type: 'paragraph',
        text: 'The term of this Agreement shall be governed by the following provisions:',
      },
      {
        block_id: 'c1',
        type: 'paragraph',
        text: '(a) Initial Term. The Initial Term shall commence on the Effective Date and continue for two (2) years.',
      },
      {
        block_id: 'c2',
        type: 'paragraph',
        text: '(b) Renewal Term. This Agreement shall automatically renew for successive one (1) year periods.',
      },
    ];

    const extraction: DocumentExtractionResult = {
      document_id: 'doc-sibling-test',
      source_file_id: 'file-sibling-test',
      source_format: 'txt',
      verified_sha256: 'sibling-sha-123',
      extraction_status: 'COMPLETED',
      total_blocks: blocks.length,
      blocks,
      warnings: [],
      extraction_duration_ms: 10,
      extracted_at: new Date().toISOString(),
    };

    const normalized = normalizeExtraction(extraction);

    assert.equal(normalized.sections.length, 1);
    const sec = normalized.sections[0];
    assert.equal(sec.children.length, 3); // intro paragraph, clause (a), clause (b)

    const introPara = sec.children[0];
    const clauseA = sec.children[1] as any;
    const clauseB = sec.children[2] as any;

    assert.equal(introPara.type, 'paragraph');
    assert.equal(introPara.text, blocks[1].text);

    // Clause (a) checks
    assert.equal(clauseA.type, 'clause');
    assert.equal(clauseA.clause_number, '(a)');
    assert.equal(clauseA.parent_id, sec.id);
    assert.equal(clauseA.text, blocks[2].text);
    assert.deepEqual(clauseA.source_block_ids, ['c1']);
    assert.equal(clauseA.content.length, 0); // No duplicated child paragraph!

    // Clause (b) checks
    assert.equal(clauseB.type, 'clause');
    assert.equal(clauseB.clause_number, '(b)');
    assert.equal(clauseB.parent_id, sec.id); // Must share parent with (a), NOT nested inside (a)!
    assert.equal(clauseB.text, blocks[3].text);
    assert.deepEqual(clauseB.source_block_ids, ['c2']);
    assert.equal(clauseB.content.length, 0); // No duplicated child paragraph!

    // Verify each source block is represented once and only once
    const allIds = normalized.source_block_ids;
    assert.equal(allIds.length, 4);
    assert.deepEqual(allIds, ['s1', 'p1', 'c1', 'c2']);
  });

  // Test 8: Regression Test: Nested clauses (a) -> (i), (ii) -> (b)
  it('should correctly structure nested clauses (a) -> (i), (ii) -> (b) with exact hierarchy and text preservation', () => {
    const blocks: ExtractedBlock[] = [
      {
        block_id: 'sec-block',
        type: 'heading',
        metadata: { heading_level: 1 },
        text: '3. CONDITIONS PRECEDENT',
      },
      {
        block_id: 'cl-a',
        type: 'paragraph',
        text: '(a) Closing Conditions. The obligations of Buyer are subject to the following conditions:',
      },
      {
        block_id: 'subcl-i',
        type: 'paragraph',
        text: '(i) Delivery of executed assignment agreements by Seller.',
      },
      {
        block_id: 'subcl-ii',
        type: 'paragraph',
        text: '(ii) Receipt of regulatory clearance under Hart-Scott-Rodino Act.',
      },
      {
        block_id: 'cl-b',
        type: 'paragraph',
        text: '(b) Termination Rights. Either party may terminate if conditions are not satisfied by December 31, 2026.',
      },
    ];

    const extraction: DocumentExtractionResult = {
      document_id: 'doc-nested-test',
      source_file_id: 'file-nested-test',
      source_format: 'docx',
      verified_sha256: 'nested-sha-456',
      extraction_status: 'COMPLETED',
      total_blocks: blocks.length,
      blocks,
      warnings: [],
      extraction_duration_ms: 15,
      extracted_at: new Date().toISOString(),
    };

    const normalized = normalizeExtraction(extraction);

    assert.equal(normalized.sections.length, 1);
    const sec = normalized.sections[0];

    // Section should directly contain clause (a) and clause (b)
    assert.equal(sec.children.length, 2);
    const clauseA = sec.children[0] as any;
    const clauseB = sec.children[1] as any;

    // Clause (a) checks
    assert.equal(clauseA.type, 'clause');
    assert.equal(clauseA.clause_number, '(a)');
    assert.equal(clauseA.parent_id, sec.id);
    assert.equal(clauseA.text, blocks[1].text);
    assert.deepEqual(clauseA.source_block_ids, ['cl-a']);

    // Clause (a) should contain subclauses (i) and (ii) in its content
    assert.equal(clauseA.content.length, 2);
    const subclauseI = clauseA.content[0] as any;
    const subclauseII = clauseA.content[1] as any;

    // Subclause (i) checks
    assert.equal(subclauseI.type, 'subclause');
    assert.equal(subclauseI.clause_number, '(i)');
    assert.equal(subclauseI.parent_id, clauseA.id);
    assert.equal(subclauseI.text, blocks[2].text);
    assert.deepEqual(subclauseI.source_block_ids, ['subcl-i']);
    assert.equal(subclauseI.content.length, 0);

    // Subclause (ii) checks: sibling to (i), sharing parent_id = clauseA.id
    assert.equal(subclauseII.type, 'subclause');
    assert.equal(subclauseII.clause_number, '(ii)');
    assert.equal(subclauseII.parent_id, clauseA.id);
    assert.equal(subclauseII.text, blocks[3].text);
    assert.deepEqual(subclauseII.source_block_ids, ['subcl-ii']);
    assert.equal(subclauseII.content.length, 0);

    // Clause (b) checks: sibling to (a) directly under Section, NOT inside (a) or (ii)
    assert.equal(clauseB.type, 'clause');
    assert.equal(clauseB.clause_number, '(b)');
    assert.equal(clauseB.parent_id, sec.id);
    assert.equal(clauseB.text, blocks[4].text);
    assert.deepEqual(clauseB.source_block_ids, ['cl-b']);
    assert.equal(clauseB.content.length, 0);

    // Total elements & source blocks: 1 section + 2 clauses + 2 subclauses = 5 elements
    assert.equal(normalized.total_elements, 5);
    assert.equal(normalized.total_clauses, 4); // 2 clauses + 2 subclauses
    assert.deepEqual(normalized.source_block_ids, ['sec-block', 'cl-a', 'subcl-i', 'subcl-ii', 'cl-b']);
  });
});

function createMockReport(
  fileId: string,
  metadata: any,
  status: any = 'CLEAN_NO_KNOWN_THREATS',
  eligible: boolean = true
): FullSecurityReport {
  return {
    fileId,
    metadata,
    status,
    statusMessage: status === 'CLEAN_NO_KNOWN_THREATS' ? 'Clean' : 'Threat detected',
    eligibleForContractProcessing: eligible,
    scanDurationMs: 15,
    completedAt: new Date().toISOString(),
    authenticity: {
      passed: eligible,
      detectedFormat: 'txt',
      mimeMatch: true,
      doubleExtensionDetected: false,
      passwordProtected: false,
      corrupted: false,
      details: [],
    },
    structure: {
      passed: eligible,
      isZipBomb: false,
      entryCount: 1,
      decompressedSize: metadata.fileSize || 100,
      decompressionRatio: 1,
      pathTraversalAttempts: [],
      malformedStructure: false,
      details: [],
    },
    activeContent: {
      passed: eligible,
      hasJavaScript: false,
      hasAutomaticActions: false,
      hasLaunchActions: false,
      hasEmbeddedFiles: false,
      hasMacros: false,
      hasOleObjects: false,
      hasSuspiciousExternalRelationships: false,
      hasInvalidEncoding: false,
      details: [],
    },
    malware: {
      passed: eligible,
      engine: 'MockEngine',
      threatsFound: eligible ? [] : ['Test.Threat'],
      scannerAvailable: true,
      genuine: true, // a genuine ClamAV scan: the only way to be CLEAN_NO_KNOWN_THREATS
      details: [],
    },
    promptInjection: {
      passed: true,
      flaggedPatterns: [],
      riskLevel: 'NONE',
      details: [],
    },
  };
}

describe('Phase 2B Normalization Service & Lifecycle Tests', () => {
  const sessionId = 'session-norm-user-1';
  const otherSessionId = 'session-norm-user-attacker';
  const validContractText = 'AGREEMENT\n1. SCOPE\nContractor performs services.\n2. PAYMENT\nRate is $100/hr.';
  const validBuffer = Buffer.from(validContractText, 'utf8');

  it('should execute end-to-end normalization after extraction on clean document', async () => {
    clearAllCachedNormalizations();

    const { fileId, metadata } = storeInQuarantine(validBuffer, 'agreement.txt', 'text/plain', sessionId);
    const report = createMockReport(fileId, metadata, 'CLEAN_NO_KNOWN_THREATS', true);
    saveSecurityReport(report);

    // Run extraction first
    const extractRes = await extractContractDocument(fileId, sessionId);
    assert.equal(extractRes.success, true);
    assert.ok(extractRes.result);

    // Run normalization
    const normRes = await normalizeContractDocument(fileId, sessionId);
    assert.equal(normRes.success, true);
    assert.equal(normRes.authorized, true);
    assert.ok(normRes.result);
    assert.equal(normRes.result.normalization_status, 'COMPLETED');
    assert.equal(normRes.result.source_file_id, fileId);

    // Subsequent retrieval from cache
    const cacheLookup = getCachedNormalization(fileId, sessionId);
    assert.equal(cacheLookup.authorized, true);
    assert.equal(cacheLookup.exists, true);
    assert.equal(cacheLookup.result?.source_file_id, fileId);
  });

  it('should reject normalization and cache lookup across different sessions', async () => {
    const { fileId, metadata } = storeInQuarantine(validBuffer, 'private.txt', 'text/plain', sessionId);
    const report = createMockReport(fileId, metadata, 'CLEAN_NO_KNOWN_THREATS', true);
    saveSecurityReport(report);

    await extractContractDocument(fileId, sessionId);
    await normalizeContractDocument(fileId, sessionId);

    // Attacker session attempts normalization
    const crossNormalize = await normalizeContractDocument(fileId, otherSessionId);
    assert.equal(crossNormalize.authorized, false);
    assert.equal(crossNormalize.success, false);

    // Attacker session attempts cache retrieval
    const crossGet = getCachedNormalization(fileId, otherSessionId);
    assert.equal(crossGet.authorized, false);
    assert.equal(crossGet.exists, false);
  });

  it('should reject normalization if document has threat or is not eligible', async () => {
    const { fileId, metadata } = storeInQuarantine(validBuffer, 'threat.txt', 'text/plain', sessionId);
    const report = createMockReport(fileId, metadata, 'THREAT_DETECTED', false);
    saveSecurityReport(report);

    const normRes = await normalizeContractDocument(fileId, sessionId);
    assert.equal(normRes.success, false);
    assert.equal(normRes.authorized, true);
    assert.ok(normRes.error?.includes('Security verification failed'));
  });

  it('should invalidate cached normalization when source document is deleted or purged', async () => {
    const { fileId, metadata } = storeInQuarantine(validBuffer, 'delete-me.txt', 'text/plain', sessionId);
    const report = createMockReport(fileId, metadata, 'CLEAN_NO_KNOWN_THREATS', true);
    saveSecurityReport(report);

    await extractContractDocument(fileId, sessionId);
    const normRes = await normalizeContractDocument(fileId, sessionId);
    assert.equal(normRes.success, true);

    // Delete quarantined file
    deleteQuarantinedFile(fileId, sessionId);

    // Cache should now be empty / not found
    const cacheLookup = getCachedNormalization(fileId, sessionId);
    assert.equal(cacheLookup.exists, false);
  });

  it('should reject normalization if document payload has been modified or tampered with', async () => {
    const { fileId, metadata, filePath } = storeInQuarantine(validBuffer, 'tamper-test.txt', 'text/plain', sessionId);
    const report = createMockReport(fileId, metadata, 'CLEAN_NO_KNOWN_THREATS', true);
    saveSecurityReport(report);

    // Tamper with the physical file on disk (corrupting SHA-256 fingerprint)
    const fs = await import('node:fs');
    fs.writeFileSync(filePath, Buffer.from('TAMPERED MALICIOUS CONTENT'));

    const normRes = await normalizeContractDocument(fileId, sessionId);
    assert.equal(normRes.success, false);
    assert.equal(normRes.authorized, true);
    assert.ok(normRes.error?.includes('Integrity violation'));
  });

  it('should reject normalization if document has expired past retention period', async () => {
    const { fileId, metadata } = storeInQuarantine(validBuffer, 'expired.txt', 'text/plain', sessionId);
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const expiredMetadata = { ...metadata, uploadedAt: threeHoursAgo };

    const report = createMockReport(fileId, expiredMetadata, 'CLEAN_NO_KNOWN_THREATS', true);
    report.completedAt = threeHoursAgo;
    saveSecurityReport(report);

    // Purge document record simulating quarantine expiration reconciliation
    purgeDocumentRecord(fileId);

    const normRes = await normalizeContractDocument(fileId, sessionId);
    assert.equal(normRes.success, false);
    assert.ok(normRes.error?.includes('deleted, or has expired'));
  });

  it('should invalidate cached normalization if document security status changes to threat detected', async () => {
    const { fileId, metadata } = storeInQuarantine(validBuffer, 'status-change.txt', 'text/plain', sessionId);
    const report = createMockReport(fileId, metadata, 'CLEAN_NO_KNOWN_THREATS', true);
    saveSecurityReport(report);

    await extractContractDocument(fileId, sessionId);
    const normRes = await normalizeContractDocument(fileId, sessionId);
    assert.equal(normRes.success, true);

    // Verify it is in cache
    const initialLookup = getCachedNormalization(fileId, sessionId);
    assert.equal(initialLookup.exists, true);

    // Update security report to simulate threat detection post-normalization
    const threatReport = createMockReport(fileId, metadata, 'THREAT_DETECTED', false);
    saveSecurityReport(threatReport);

    // Cache lookup should now fail and invalidate cache
    const failedLookup = getCachedNormalization(fileId, sessionId);
    assert.equal(failedLookup.exists, false);
    assert.ok(failedLookup.error?.includes('Security verification failed'));

    // Cache should be purged
    const secondLookup = getCachedNormalization(fileId, sessionId);
    assert.equal(secondLookup.exists, false);
  });

  it('should invalidate cached normalization if document becomes ineligible', async () => {
    const { fileId, metadata } = storeInQuarantine(validBuffer, 'ineligible.txt', 'text/plain', sessionId);
    const report = createMockReport(fileId, metadata, 'CLEAN_NO_KNOWN_THREATS', true);
    saveSecurityReport(report);

    await extractContractDocument(fileId, sessionId);
    const normRes = await normalizeContractDocument(fileId, sessionId);
    assert.equal(normRes.success, true);

    // Update security report to ineligible
    const ineligibleReport = createMockReport(fileId, metadata, 'CLEAN_NO_KNOWN_THREATS', false);
    saveSecurityReport(ineligibleReport);

    // Cache lookup should fail and invalidate cache
    const lookup = getCachedNormalization(fileId, sessionId);
    assert.equal(lookup.exists, false);
    assert.ok(lookup.error?.includes('not eligible for contract processing'));
  });

  it('should invalidate cached normalization if physical quarantined file is missing from disk', async () => {
    const { fileId, metadata, filePath } = storeInQuarantine(validBuffer, 'missing-file.txt', 'text/plain', sessionId);
    const report = createMockReport(fileId, metadata, 'CLEAN_NO_KNOWN_THREATS', true);
    saveSecurityReport(report);

    await extractContractDocument(fileId, sessionId);
    const normRes = await normalizeContractDocument(fileId, sessionId);
    assert.equal(normRes.success, true);

    // Remove the physical file from disk without purging the registry record
    const fs = await import('node:fs');
    fs.unlinkSync(filePath);

    // Cache lookup should fail on physical file retrieval and invalidate cache
    const lookup = getCachedNormalization(fileId, sessionId);
    assert.equal(lookup.exists, false);
    assert.ok(
      lookup.error?.includes('does not exist on disk') ||
        lookup.error?.includes('Quarantined document payload could not be retrieved') ||
        lookup.error?.includes('missing')
    );
  });

  it('should invalidate cached normalization if physical file is tampered with after normalization', async () => {
    const { fileId, metadata, filePath } = storeInQuarantine(validBuffer, 'tamper-cache.txt', 'text/plain', sessionId);
    const report = createMockReport(fileId, metadata, 'CLEAN_NO_KNOWN_THREATS', true);
    saveSecurityReport(report);

    await extractContractDocument(fileId, sessionId);
    const normRes = await normalizeContractDocument(fileId, sessionId);
    assert.equal(normRes.success, true);

    // Tamper with physical file
    const fs = await import('node:fs');
    fs.writeFileSync(filePath, Buffer.from('POST_NORMALIZATION_TAMPERED_DATA'));

    // Cache lookup should detect fingerprint mismatch, reject, and invalidate cache
    const lookup = getCachedNormalization(fileId, sessionId);
    assert.equal(lookup.exists, false);
    assert.ok(lookup.error?.includes('Integrity violation'));
  });
});
