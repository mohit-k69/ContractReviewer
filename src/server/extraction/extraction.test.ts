import test, { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { extractTxtContent } from './txtExtractor';
import { extractPdfContent } from './pdfExtractor';
import { extractDocxContent } from './docxExtractor';
import { extractContractDocument } from './extractionService';
import {
  storeInQuarantine,
  saveSecurityReport,
  getSecurityReport,
} from '../security/quarantineManager';
import { FullSecurityReport } from '../security/types';

// Helper to create a valid minimal PDF buffer with digital text
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

describe('Phase 2A Document Extraction Engine', () => {
  describe('TXT Extraction', () => {
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
      assert.equal(tblBlock.table_data.length, 3); // Header + 2 data rows
      assert.deepEqual(tblBlock.table_data[0], ['Milestone', 'Description', 'Fee']);
      assert.deepEqual(tblBlock.table_data[1], ['Phase 1', 'UI & Security', '$3,000']);
      assert.deepEqual(tblBlock.table_data[2], ['Phase 2', 'Extraction Engine', '$4,500']);
    });

    it('should gracefully handle empty plain text documents', () => {
      const buffer = Buffer.from('   \n\n  \t  \n', 'utf8');
      const result = extractTxtContent(buffer, 'empty-txt');
      assert.equal(result.blocks.length, 0);
      assert.ok(result.warnings.length > 0);
      assert.match(result.warnings[0], /no readable text/i);
    });
  });

  describe('PDF Extraction', () => {
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
  });

  describe('DOCX Extraction', () => {
    it('should extract document hierarchy, preserving headings, lists, tables, and exact financial figures', () => {
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

      // Verify heading
      const heading = result.blocks.find((b) => b.text === 'CONSULTING AGREEMENT');
      assert.ok(heading);
      assert.equal(heading.type, 'heading');
      assert.equal(heading.metadata?.heading_level, 1);

      // Verify lists
      const lists = result.blocks.filter((b) => b.type === 'list');
      assert.equal(lists.length, 2);
      assert.equal(lists[0].text, 'Backend extraction pipeline implementation');

      // Verify table and preserved financial symbols
      const table = result.blocks.find((b) => b.type === 'table');
      assert.ok(table);
      assert.ok(table.table_data);
      assert.equal(table.table_data.length, 2);
      assert.deepEqual(table.table_data[0], ['Deliverable', 'Due Date', 'Rate']);
      assert.deepEqual(table.table_data[1], ['Milestone 1', 'Nov 15, 2026', '$150.00/hr']);
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

  describe('Extraction Service & Security Gate Enforcement', () => {
    it('should reject unauthorized session access during extraction', async () => {
      const sessionId1 = 'sess-' + crypto.randomUUID();
      const sessionId2 = 'sess-' + crypto.randomUUID();

      const doc = Buffer.from('SECTION 1. CONTRACT\n\nValid contract text.');
      const quarantined = storeInQuarantine(doc, 'contract.txt', 'text/plain', sessionId1);

      // Create valid security report for sessionId1
      const report: FullSecurityReport = {
        fileId: quarantined.fileId,
        metadata: quarantined.metadata,
        status: 'CLEAN_NO_KNOWN_THREATS',
        statusMessage: 'Clean',
        eligibleForContractProcessing: true,
        authenticity: { passed: true, detectedMimeType: 'text/plain', detectedFormat: 'txt', details: [] },
        structure: { passed: true, isZipBomb: false, entryCount: 1, decompressedSize: doc.length, decompressionRatio: 1, pathTraversalAttempts: [], malformedStructure: false, details: [] },
        activeContent: { passed: true, hasVbaMacros: false, hasJavascript: false, hasAutomaticActions: false, hasOleObjects: false, hasSuspiciousExternalRels: false, details: [] },
        malware: { passed: true, scannerUsed: 'clamav', threatName: null, details: [] },
        promptInjection: { passed: true, adversarialPatternsDetected: [], details: [] },
        inspectedAt: new Date().toISOString(),
        scanDurationMs: 15,
      };
      saveSecurityReport(report);

      // Attempt extraction using sessionId2
      const res = await extractContractDocument(quarantined.fileId, sessionId2);
      assert.equal(res.authorized, false);
      assert.match(res.error || '', /session ownership mismatch/i);
    });

    it('should reject files that failed security inspection or have threat detected', async () => {
      const sessionId = 'sess-' + crypto.randomUUID();
      const doc = Buffer.from('Malicious payload content.');
      const quarantined = storeInQuarantine(doc, 'infected.pdf', 'application/pdf', sessionId);

      const threatReport: FullSecurityReport = {
        fileId: quarantined.fileId,
        metadata: quarantined.metadata,
        status: 'THREAT_DETECTED',
        statusMessage: 'Malware found',
        eligibleForContractProcessing: false,
        authenticity: { passed: true, detectedMimeType: 'application/pdf', detectedFormat: 'pdf', details: [] },
        structure: { passed: true, isZipBomb: false, entryCount: 1, decompressedSize: doc.length, decompressionRatio: 1, pathTraversalAttempts: [], malformedStructure: false, details: [] },
        activeContent: { passed: true, hasVbaMacros: false, hasJavascript: false, hasAutomaticActions: false, hasOleObjects: false, hasSuspiciousExternalRels: false, details: [] },
        malware: { passed: false, scannerUsed: 'clamav', threatName: 'Win.Test.EICAR', details: [] },
        promptInjection: { passed: true, adversarialPatternsDetected: [], details: [] },
        inspectedAt: new Date().toISOString(),
        scanDurationMs: 20,
      };
      saveSecurityReport(threatReport);

      const res = await extractContractDocument(quarantined.fileId, sessionId);
      assert.equal(res.success, false);
      assert.equal(res.authorized, true);
      assert.match(res.error || '', /THREAT_DETECTED|Security verification failed/i);
    });

    it('should reject extraction if document SHA-256 fingerprint does not match inspection report', async () => {
      const sessionId = 'sess-' + crypto.randomUUID();
      const originalDoc = Buffer.from('Original verified document content.');
      const quarantined = storeInQuarantine(originalDoc, 'tampered.txt', 'text/plain', sessionId);

      // Save report with a forged/different SHA-256 hash
      const report: FullSecurityReport = {
        fileId: quarantined.fileId,
        metadata: {
          ...quarantined.metadata,
          sha256: '0000000000000000000000000000000000000000000000000000000000000000',
        },
        status: 'CLEAN_NO_KNOWN_THREATS',
        statusMessage: 'Clean',
        eligibleForContractProcessing: true,
        authenticity: { passed: true, detectedMimeType: 'text/plain', detectedFormat: 'txt', details: [] },
        structure: { passed: true, isZipBomb: false, entryCount: 1, decompressedSize: originalDoc.length, decompressionRatio: 1, pathTraversalAttempts: [], malformedStructure: false, details: [] },
        activeContent: { passed: true, hasVbaMacros: false, hasJavascript: false, hasAutomaticActions: false, hasOleObjects: false, hasSuspiciousExternalRels: false, details: [] },
        malware: { passed: true, scannerUsed: 'clamav', threatName: null, details: [] },
        promptInjection: { passed: true, adversarialPatternsDetected: [], details: [] },
        inspectedAt: new Date().toISOString(),
        scanDurationMs: 10,
      };
      saveSecurityReport(report);

      const res = await extractContractDocument(quarantined.fileId, sessionId);
      assert.equal(res.success, false);
      assert.match(res.error || '', /integrity violation|SHA-256/i);
    });

    it('should successfully extract clean, verified contract and cache result', async () => {
      const sessionId = 'sess-' + crypto.randomUUID();
      const contractText =
        'SECTION 1. DEFINITIONS\n\n' +
        'Contractor means John Doe.\n\n' +
        'Client means Acme Corp.\n\n' +
        'SECTION 2. TERM\n\n' +
        'Term begins on Jan 1, 2026.';

      const doc = Buffer.from(contractText, 'utf8');
      const quarantined = storeInQuarantine(doc, 'verified_contract.txt', 'text/plain', sessionId);

      const report: FullSecurityReport = {
        fileId: quarantined.fileId,
        metadata: quarantined.metadata,
        status: 'CLEAN_NO_KNOWN_THREATS',
        statusMessage: 'Clean',
        eligibleForContractProcessing: true,
        authenticity: { passed: true, detectedMimeType: 'text/plain', detectedFormat: 'txt', details: [] },
        structure: { passed: true, isZipBomb: false, entryCount: 1, decompressedSize: doc.length, decompressionRatio: 1, pathTraversalAttempts: [], malformedStructure: false, details: [] },
        activeContent: { passed: true, hasVbaMacros: false, hasJavascript: false, hasAutomaticActions: false, hasOleObjects: false, hasSuspiciousExternalRels: false, details: [] },
        malware: { passed: true, scannerUsed: 'clamav', threatName: null, details: [] },
        promptInjection: { passed: true, adversarialPatternsDetected: [], details: [] },
        inspectedAt: new Date().toISOString(),
        scanDurationMs: 12,
      };
      saveSecurityReport(report);

      const res = await extractContractDocument(quarantined.fileId, sessionId);
      assert.equal(res.success, true);
      assert.equal(res.authorized, true);
      assert.ok(res.result);
      assert.equal(res.result.extraction_status, 'COMPLETED');
      assert.equal(res.result.source_format, 'txt');
      assert.equal(res.result.verified_sha256, quarantined.metadata.sha256);
      assert.ok(res.result.blocks.length >= 4);

      // Verify second call retrieves from cache
      const cachedRes = await extractContractDocument(quarantined.fileId, sessionId);
      assert.equal(cachedRes.result?.document_id, res.result.document_id);
    });
  });

  after(() => {
    setTimeout(() => process.exit(0), 100).unref();
  });
});
