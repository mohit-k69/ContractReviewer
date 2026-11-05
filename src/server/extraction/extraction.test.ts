import test, { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import AdmZip from 'adm-zip';
import { extractTxtContent } from './txtExtractor';
import { extractPdfContent } from './pdfExtractor';
import { extractDocxContent, extractDocxWithTimeout } from './docxExtractor';
import {
  extractContractDocument,
  getCachedExtraction,
  clearAllCachedExtractions,
  invalidateCachedExtraction,
} from './extractionService';
import {
  storeInQuarantine,
  saveSecurityReport,
  deleteQuarantinedFile,
  purgeDocumentRecord,
} from '../security/quarantineManager';
import { FullSecurityReport } from '../security/types';

// Helper to create a valid minimal PDF buffer with digital text or scanned image
function createTestPdf(content: string, options: { multiPage?: boolean; hasImage?: boolean } = {}): Buffer {
  if (options.hasImage && !content.trim()) {
    // Scanned PDF fixture with image XObject and no digital text
    return Buffer.from(
      '%PDF-1.4\n' +
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</XObject<</Im1 4 0 R>>>>>>endobj\n' +
      '4 0 obj<</Type/XObject/Subtype/Image/Width 100/Height 100/ColorSpace/DeviceRGB/BitsPerComponent 8/Length 10>>stream\n' +
      '0123456789\n' +
      'endstream\n' +
      'endobj\n' +
      'xref\n' +
      '0 5\n' +
      '0000000000 65535 f \n' +
      '0000000009 00000 n \n' +
      '0000000058 00000 n \n' +
      '0000000115 00000 n \n' +
      '0000000224 00000 n \n' +
      'trailer<</Size 5/Root 1 0 R>>\n' +
      'startxref\n' +
      '380\n' +
      '%%EOF'
    );
  }

  // Standard readable digital PDF
  const streamData = `BT /F1 12 Tf 50 750 Td (${content.replace(/[()]/g, '')}) Tj ET`;
  return Buffer.from(
    '%PDF-1.4\n' +
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
    `4 0 obj<</Length ${streamData.length}>>stream\n${streamData}\nendstream\nendobj\n` +
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
    'xref\n' +
    '0 6\n' +
    '0000000000 65535 f \n' +
    '0000000009 00000 n \n' +
    '0000000058 00000 n \n' +
    '0000000115 00000 n \n' +
    '0000000244 00000 n \n' +
    '0000000350 00000 n \n' +
    'trailer<</Size 6/Root 1 0 R>>\n' +
    'startxref\n' +
    '430\n' +
    '%%EOF'
  );
}

// Helper to create a mixed 2-page PDF: Page 1 digital text, Page 2 scanned image
function createMixedTestPdf(page1Text: string): Buffer {
  const stream1 = `BT /F1 12 Tf 50 750 Td (${page1Text.replace(/[()]/g, '')}) Tj ET`;
  return Buffer.from(
    '%PDF-1.4\n' +
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R 6 0 R]/Count 2>>endobj\n' +
    // Page 1: Digital text
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
    `4 0 obj<</Length ${stream1.length}>>stream\n${stream1}\nendstream\nendobj\n` +
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
    // Page 2: Scanned image XObject, no digital text
    '6 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</XObject<</Im1 7 0 R>>>>>>endobj\n' +
    '7 0 obj<</Type/XObject/Subtype/Image/Width 10/Height 10/ColorSpace/DeviceRGB/BitsPerComponent 8/Length 6>>stream\n012345\nendstream\nendobj\n' +
    'xref\n' +
    '0 8\n' +
    '0000000000 65535 f \n' +
    '0000000009 00000 n \n' +
    '0000000058 00000 n \n' +
    '0000000122 00000 n \n' +
    '0000000251 00000 n \n' +
    '0000000370 00000 n \n' +
    '0000000450 00000 n \n' +
    '0000000557 00000 n \n' +
    'trailer<</Size 8/Root 1 0 R>>\n' +
    'startxref\n' +
    '695\n' +
    '%%EOF'
  );
}

// Helper to create a test DOCX buffer
function createTestDocx(xmlBody: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>'
    )
  );
  zip.addFile(
    '_rels/.rels',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>'
    )
  );
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${xmlBody}</w:body>` +
      '</w:document>'
    )
  );
  return zip.toBuffer();
}

function createMockSecurityReport(
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
    authenticity: {
      passed: true,
      detectedFormat: 'txt',
      mimeMatch: true,
      doubleExtensionDetected: false,
      passwordProtected: false,
      corrupted: false,
      details: [],
    },
    structure: {
      passed: true,
      isZipBomb: false,
      entryCount: 1,
      decompressedSize: metadata.fileSize || 100,
      decompressionRatio: 1,
      pathTraversalAttempts: [],
      malformedStructure: false,
      details: [],
    },
    activeContent: {
      passed: true,
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
      passed: status === 'CLEAN_NO_KNOWN_THREATS',
      engine: 'ClamAV-Daemon',
      threatsFound: status === 'CLEAN_NO_KNOWN_THREATS' ? [] : ['Win.Test.EICAR'],
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
    completedAt: new Date().toISOString(),
    scanDurationMs: 15,
  };
}

describe('Phase 2A Document Extraction Engine — Security & Correctness', () => {
  describe('TXT Extraction & UTF-8 Detection', () => {
    it('should strip UTF-8 BOM and extract contract sections, paragraphs, and lists', () => {
      const txtContent =
        '\uFEFFSECTION 1. SCOPE OF SERVICES\r\n\r\n' +
        'The Contractor shall deliver high-fidelity web application modules.\r\n\r\n' +
        'Deliverables include:\r\n' +
        '- Complete frontend UI\r\n' +
        '- Server-side extraction engine\r\n' +
        '- Automated unit tests\r\n\r\n' +
        'SECTION 2. COMPENSATION\r\n\r\n' +
        'Total fixed fee is $7,500.00 payable upon milestone completion.';

      const buffer = Buffer.from(txtContent, 'utf8');
      const result = extractTxtContent(buffer, 'test-txt-1');

      assert.equal(result.status, 'COMPLETED');
      assert.equal(result.warnings.length, 0);
      assert.ok(result.blocks.length >= 5);

      const section1 = result.blocks.find((b) => b.text === 'SECTION 1. SCOPE OF SERVICES');
      assert.ok(section1);
      assert.equal(section1.type, 'heading');
      assert.equal(section1.metadata?.heading_level, 1);

      const listBlocks = result.blocks.filter((b) => b.type === 'list');
      assert.equal(listBlocks.length, 3);
      assert.equal(listBlocks[0].text, '- Complete frontend UI');

      const compBlock = result.blocks.find((b) => b.text.includes('$7,500.00'));
      assert.ok(compBlock);
      assert.equal(compBlock.type, 'paragraph');
    });

    it('should detect invalid UTF-8 in TXT files and report it explicitly', () => {
      // Create invalid UTF-8 byte sequence (e.g. invalid continuation bytes 0x80, 0xC0)
      const invalidUtf8Buffer = Buffer.from([0x53, 0x45, 0x43, 0x54, 0x49, 0x4F, 0x4E, 0x20, 0x31, 0xFF, 0xFE, 0xC0, 0x80]);
      const result = extractTxtContent(invalidUtf8Buffer, 'invalid-utf8-txt');

      assert.equal(result.status, 'FAILED');
      assert.equal(result.blocks.length, 0);
      assert.ok(result.warnings.some((w) => /Invalid UTF-8 encoding detected/i.test(w)));
      assert.match(result.error || '', /Invalid UTF-8 encoding detected/i);
    });

    it('should parse pipe-delimited and tab-delimited tables in plain text', () => {
      const tableTxt =
        'FEE SCHEDULE\n\n' +
        '| Milestone | Description | Fee |\n' +
        '|---|---|---|\n' +
        '| Phase 1 | UI & Security | $3,000 |\n' +
        '| Phase 2 | Extraction Engine | $4,500 |\n';

      const buffer = Buffer.from(tableTxt, 'utf8');
      const result = extractTxtContent(buffer, 'test-tbl-1');

      const tblBlock = result.blocks.find((b) => b.type === 'table');
      assert.ok(tblBlock);
      assert.ok(tblBlock.table_data);
      assert.equal(tblBlock.table_data.length, 3);
      assert.deepEqual(tblBlock.table_data[0], ['Milestone', 'Description', 'Fee']);
      assert.deepEqual(tblBlock.table_data[1], ['Phase 1', 'UI & Security', '$3,000']);
      assert.deepEqual(tblBlock.table_data[2], ['Phase 2', 'Extraction Engine', '$4,500']);
    });

    it('should gracefully handle empty plain text documents', () => {
      const buffer = Buffer.from('   \n\n  \t  \n', 'utf8');
      const result = extractTxtContent(buffer, 'empty-txt');
      assert.equal(result.status, 'FAILED');
      assert.equal(result.blocks.length, 0);
      assert.ok(result.warnings.length > 0);
      assert.match(result.warnings[0], /no readable text/i);
    });
  });

  describe('PDF Extraction & Timeout Isolation', () => {
    it('should extract digital text blocks and preserve reading flow', async () => {
      const pdfBuffer = createTestPdf('SECTION 1. INDEPENDENT CONTRACTOR AGREEMENT');
      const result = await extractPdfContent(pdfBuffer, 'pdf-digital-1');

      assert.equal(result.status, 'COMPLETED');
      assert.equal(result.totalPages, 1);
      assert.equal(result.extractedPages, 1);
      assert.ok(result.blocks.length > 0);
      assert.ok(result.blocks[0].text.includes('SECTION 1'));
    });

    it('should detect scanned image-only PDFs and report OCR_REQUIRED status', async () => {
      const scannedPdf = createTestPdf('', { hasImage: true });
      const result = await extractPdfContent(scannedPdf, 'pdf-scanned-1');

      assert.equal(result.status, 'OCR_REQUIRED');
      assert.equal(result.extractedPages, 0);
      assert.ok(result.warnings.some((w) => /scanned|OCR/i.test(w)));
      assert.ok(result.scannedPages.includes(1));
    });

    it('should detect mixed digital-text and scanned-image PDFs and report PARTIAL status', async () => {
      const mixedPdf = createMixedTestPdf('SECTION 1. MASTER SERVICES AGREEMENT');
      const result = await extractPdfContent(mixedPdf, 'pdf-mixed-1');

      assert.equal(result.status, 'PARTIAL');
      assert.equal(result.totalPages, 2);
      assert.equal(result.extractedPages, 1);
      assert.ok(result.scannedPages.includes(2));
      assert.ok(result.warnings.some((w) => /partially extracted|Page 2/i.test(w)));
      assert.ok(result.blocks.some((b) => b.text.includes('SECTION 1')));
    });

    it('should genuinely terminate execution on PDF parser timeout using isolated worker', async () => {
      const pdfBuffer = createTestPdf('SECTION 1. TIMEOUT TEST CLAUSE');
      // Set an impossibly small timeout of 1ms to trigger the genuine worker termination
      await assert.rejects(
        async () => {
          await extractPdfContent(pdfBuffer, 'pdf-timeout-test', 1);
        },
        /timed out/i
      );
    });
  });

  describe('DOCX Resource Limits, Decompression Bombs & Provenance', () => {
    it('should extract document hierarchy, preserving structural references, tables, and exact financial figures without fabricating page numbers', () => {
      const docxBody =
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>CONSULTING AGREEMENT</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Effective as of November 1, 2026, Contractor will provide specialized development services.</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Backend extraction pipeline implementation</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Security verification gate</w:t></w:r></w:p>' +
        '<w:tbl>' +
        '  <w:tr>' +
        '    <w:tc><w:p><w:r><w:t>Deliverable</w:t></w:r></w:p></w:tc>' +
        '    <w:tc><w:p><w:r><w:t>Due Date</w:t></w:r></w:p></w:tc>' +
        '    <w:tc><w:p><w:r><w:t>Rate</w:t></w:r></w:p></w:tc>' +
        '  </w:tr>' +
        '  <w:tr>' +
        '    <w:tc><w:p><w:r><w:t>Milestone 1</w:t></w:r></w:p></w:tc>' +
        '    <w:tc><w:p><w:r><w:t>Nov 15, 2026</w:t></w:r></w:p></w:tc>' +
        '    <w:tc><w:p><w:r><w:t>$150.00/hr</w:t></w:r></w:p></w:tc>' +
        '  </w:tr>' +
        '</w:tbl>';

      const docxBuffer = createTestDocx(docxBody);
      const result = extractDocxContent(docxBuffer, 'test-docx-1');

      assert.equal(result.warnings.length, 0);
      assert.ok(result.blocks.length >= 4);

      // Verify provenance: page_number must be undefined for DOCX; rely on structural_ref
      assert.equal(result.totalPages, undefined);
      assert.equal(result.extractedPages, undefined);
      for (const block of result.blocks) {
        assert.equal(block.page_number, undefined, 'DOCX blocks must not fabricate page numbers');
        assert.ok(block.structural_ref, 'DOCX blocks must provide structural references');
      }

      // Verify heading
      const heading = result.blocks.find((b) => b.text === 'CONSULTING AGREEMENT');
      assert.ok(heading);
      assert.equal(heading.type, 'heading');
      assert.equal(heading.metadata?.heading_level, 1);
      assert.equal(heading.structural_ref, 'sec-1');

      // Verify lists
      const lists = result.blocks.filter((b) => b.type === 'list');
      assert.equal(lists.length, 2);
      assert.equal(lists[0].text, 'Backend extraction pipeline implementation');
      assert.equal(lists[0].structural_ref, 'list-1');

      // Verify table and preserved financial symbols
      const table = result.blocks.find((b) => b.type === 'table');
      assert.ok(table);
      assert.ok(table.table_data);
      assert.equal(table.table_data.length, 2);
      assert.deepEqual(table.table_data[0], ['Deliverable', 'Due Date', 'Rate']);
      assert.deepEqual(table.table_data[1], ['Milestone 1', 'Nov 15, 2026', '$150.00/hr']);
    });

    it('should reject DOCX with excessive archive entries (> 300 entries)', () => {
      const zip = new AdmZip();
      for (let i = 0; i < 305; i++) {
        zip.addFile(`entry_${i}.txt`, Buffer.from('data'));
      }
      const buffer = zip.toBuffer();

      assert.throws(
        () => extractDocxContent(buffer, 'excessive-entries-docx'),
        /Entry count \(305\) exceeds maximum limit of 300/i
      );
    });

    it('should reject DOCX with oversized single entry (> 15 MB declared size)', () => {
      const zip = new AdmZip();
      zip.addFile(
        'word/document.xml',
        Buffer.from('<w:document><w:body></w:body></w:document>')
      );
      const fakeLargeHeader = zip.getEntries()[0];
      // Inject oversized header size (16 MB)
      fakeLargeHeader.header.size = 16 * 1024 * 1024;
      const buffer = zip.toBuffer();

      // Modify the ZIP local header in binary to reflect 16MB declared size
      // Or construct ZIP with entry declaring 16MB
      const zip2 = new AdmZip();
      zip2.addFile(
        '[Content_Types].xml',
        Buffer.from('<Types/>')
      );
      zip2.addFile(
        'word/document.xml',
        Buffer.from('<w:document><w:body></w:body></w:document>')
      );
      // Manually tamper the entry header size in the entry object
      const docEntry = zip2.getEntry('word/document.xml');
      if (docEntry) {
        docEntry.header.size = 16 * 1024 * 1024;
      }
      const tamperedBuffer = zip2.toBuffer();

      assert.throws(
        () => extractDocxContent(tamperedBuffer, 'oversized-docx'),
        /exceeding limit of 15 MB/i
      );
    });

    it('should reject DOCX with decompression bomb expanding beyond safe output length', () => {
      // Craft a zip bomb: tiny compressed payload that expands to >15MB of zeros
      const zip = new AdmZip();
      zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
      zip.addFile('_rels/.rels', Buffer.from('<Relationships/>'));
      
      // Highly compressible buffer of 16MB zeros
      const largeZeros = Buffer.alloc(16 * 1024 * 1024, 0x20); // 16MB spaces
      const compressedZeros = zlib.deflateRawSync(largeZeros);
      
      // Inject manually
      const bombZip = new AdmZip();
      bombZip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
      bombZip.addFile('word/document.xml', largeZeros);
      const bombBuffer = bombZip.toBuffer();

      // Should be rejected either by header inspection or by bounded inflate
      assert.throws(
        () => extractDocxContent(bombBuffer, 'bomb-docx'),
        /exceeding limit of 15 MB|Decompression bomb detected/i
      );
    });

    it('should genuinely terminate execution on DOCX parser timeout in isolated worker', async () => {
      const docxBuffer = createTestDocx('<w:p><w:r><w:t>Valid Paragraph</w:t></w:r></w:p>');
      // 1ms timeout triggers worker termination
      await assert.rejects(
        async () => {
          await extractDocxWithTimeout(docxBuffer, 'docx-timeout-test', 1);
        },
        /timed out/i
      );
    });

    it('should throw clear error on corrupted DOCX missing document.xml', () => {
      const corruptZip = new AdmZip();
      corruptZip.addFile('other.xml', Buffer.from('<root/>'));
      const buffer = corruptZip.toBuffer();

      assert.throws(
        () => extractDocxContent(buffer, 'corrupt-docx'),
        /missing word\/document\.xml/
      );
    });
  });

  describe('Cached Extraction Authorization & Lifecycle Cleanup', () => {
    it('should require existing document registry record and verified session ownership', async () => {
      const sessionId1 = 'sess-' + crypto.randomUUID();
      const sessionId2 = 'sess-' + crypto.randomUUID();

      const doc = Buffer.from('SECTION 1. DEFINITIONS\n\nContractor means John Doe.');
      const quarantined = storeInQuarantine(doc, 'auth_contract.txt', 'text/plain', sessionId1);
      saveSecurityReport(createMockSecurityReport(quarantined.fileId, quarantined.metadata, 'CLEAN_NO_KNOWN_THREATS', true));

      // Extract under sessionId1
      const extractRes = await extractContractDocument(quarantined.fileId, sessionId1);
      assert.equal(extractRes.success, true);
      assert.ok(extractRes.result);

      // 1. Session 1 can retrieve cached extraction
      const cacheOwn = getCachedExtraction(quarantined.fileId, sessionId1);
      assert.equal(cacheOwn.authorized, true);
      assert.equal(cacheOwn.exists, true);
      assert.equal(cacheOwn.result?.document_id, extractRes.result.document_id);

      // 2. Cross-session access: Session 2 MUST be rejected with authorized: false
      const cacheCross = getCachedExtraction(quarantined.fileId, sessionId2);
      assert.equal(cacheCross.authorized, false);
      assert.match(cacheCross.error || '', /session ownership mismatch/i);
    });

    it('should not return cached content for missing or unregistered documents', () => {
      const randomFileId = crypto.randomUUID();
      const sessionId = 'sess-' + crypto.randomUUID();

      const lookup = getCachedExtraction(randomFileId, sessionId);
      assert.equal(lookup.authorized, true);
      assert.equal(lookup.exists, false);
      assert.equal(lookup.result, undefined);
      assert.match(lookup.error || '', /not found|expired/i);
    });

    it('should immediately clear cached extraction when document is deleted', async () => {
      const sessionId = 'sess-' + crypto.randomUUID();
      const doc = Buffer.from('SECTION 1. DELETION TEST\n\nTemporary contract clause.');
      const quarantined = storeInQuarantine(doc, 'to_delete.txt', 'text/plain', sessionId);
      saveSecurityReport(createMockSecurityReport(quarantined.fileId, quarantined.metadata, 'CLEAN_NO_KNOWN_THREATS', true));

      // Perform extraction
      const extractRes = await extractContractDocument(quarantined.fileId, sessionId);
      assert.equal(extractRes.success, true);

      // Confirm cached
      assert.ok(getCachedExtraction(quarantined.fileId, sessionId).result);

      // Delete document from quarantine
      const delResult = deleteQuarantinedFile(quarantined.fileId, sessionId);
      assert.equal(delResult.success, true);

      // Cached extraction MUST be invalidated and return exists: false
      const postDeleteLookup = getCachedExtraction(quarantined.fileId, sessionId);
      assert.equal(postDeleteLookup.exists, false);
      assert.equal(postDeleteLookup.result, undefined);

      // Re-extraction must fail
      const reExtract = await extractContractDocument(quarantined.fileId, sessionId);
      assert.equal(reExtract.success, false);
      assert.match(reExtract.error || '', /not completed security inspection|deleted|expired/i);
    });

    it('should clear cached extraction when document expires or is purged from registry', async () => {
      const sessionId = 'sess-' + crypto.randomUUID();
      const doc = Buffer.from('SECTION 1. EXPIRATION TEST\n\nExpiring contract clause.');
      const quarantined = storeInQuarantine(doc, 'to_expire.txt', 'text/plain', sessionId);
      saveSecurityReport(createMockSecurityReport(quarantined.fileId, quarantined.metadata, 'CLEAN_NO_KNOWN_THREATS', true));

      // Perform extraction
      const extractRes = await extractContractDocument(quarantined.fileId, sessionId);
      assert.equal(extractRes.success, true);
      assert.ok(getCachedExtraction(quarantined.fileId, sessionId).result);

      // Simulate expiration purge
      purgeDocumentRecord(quarantined.fileId);

      // Cache MUST be cleared
      const postExpireLookup = getCachedExtraction(quarantined.fileId, sessionId);
      assert.equal(postExpireLookup.exists, false);
      assert.equal(postExpireLookup.result, undefined);
    });

    it('should invalidate cache if document SHA-256 fingerprint changes (tamper detection)', async () => {
      const sessionId = 'sess-' + crypto.randomUUID();
      const doc = Buffer.from('SECTION 1. TAMPER TEST\n\nOriginal contract text.');
      const quarantined = storeInQuarantine(doc, 'tamper_test.txt', 'text/plain', sessionId);
      const report = createMockSecurityReport(quarantined.fileId, quarantined.metadata, 'CLEAN_NO_KNOWN_THREATS', true);
      saveSecurityReport(report);

      // Extract
      const extractRes = await extractContractDocument(quarantined.fileId, sessionId);
      assert.equal(extractRes.success, true);

      // Tamper metadata hash in registry
      saveSecurityReport({
        ...report,
        metadata: {
          ...report.metadata,
          sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        },
      });

      // Query cache: must detect mismatch, clear cache, and reject
      const lookup = getCachedExtraction(quarantined.fileId, sessionId);
      assert.equal(lookup.exists, false);
      assert.equal(lookup.result, undefined);
      assert.match(lookup.error || '', /integrity mismatch|modified/i);
    });
  });

  after(() => {
    clearAllCachedExtractions();
    setTimeout(() => process.exit(0), 100).unref();
  });
});
