import { inspectFileAuthenticity } from './authenticityInspector';
import { inspectDocumentStructure } from './structureInspector';
import { inspectActiveContent } from './activeContentInspector';
import { scanForMalware } from './malwareScanner';
import { inspectPromptInjection } from './promptInjectionInspector';
import {
  storeInQuarantine,
  saveSecurityReport,
} from './quarantineManager';
import { FullSecurityReport, SecurityStatus } from './types';

export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

export async function runSecurityInspectionPipeline(
  buffer: Buffer,
  originalFilename: string,
  declaredMimeType: string,
  sessionId: string,
  options: {
    requireExternalScanner?: boolean;
    clamavHost?: string;
    clamavPort?: number;
    timeoutMs?: number;
    scanUrl?: string;
    scanToken?: string;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<FullSecurityReport> {
  const startTime = Date.now();

  // 1. Quarantining phase
  const { fileId, metadata } = storeInQuarantine(
    buffer,
    originalFilename,
    declaredMimeType,
    sessionId
  );

  // File size hard-gate
  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    const report: FullSecurityReport = {
      fileId,
      status: 'REJECTED',
      statusMessage: `File exceeds maximum allowed size of 20 MB (actual: ${(buffer.length / (1024 * 1024)).toFixed(1)} MB).`,
      metadata,
      authenticity: {
        passed: false,
        detectedFormat: 'unknown',
        mimeMatch: false,
        doubleExtensionDetected: false,
        passwordProtected: false,
        corrupted: false,
        details: ['File exceeds 20 MB limit.'],
      },
      structure: {
        passed: false,
        isZipBomb: false,
        entryCount: 0,
        decompressedSize: 0,
        decompressionRatio: 0,
        pathTraversalAttempts: [],
        malformedStructure: false,
        details: ['Inspection skipped due to size violation.'],
      },
      activeContent: {
        passed: false,
        hasJavaScript: false,
        hasAutomaticActions: false,
        hasLaunchActions: false,
        hasEmbeddedFiles: false,
        hasMacros: false,
        hasOleObjects: false,
        hasSuspiciousExternalRelationships: false,
        hasInvalidEncoding: false,
        details: ['Inspection skipped.'],
      },
      malware: {
        passed: false,
        engine: 'Pre-Check',
        threatsFound: [],
        scannerAvailable: true,
        details: ['Inspection skipped.'],
      },
      promptInjection: {
        passed: false,
        flaggedPatterns: [],
        riskLevel: 'NONE',
        details: ['Inspection skipped.'],
      },
      scanDurationMs: Date.now() - startTime,
      eligibleForContractProcessing: false,
      completedAt: new Date().toISOString(),
    };
    saveSecurityReport(report);
    return report;
  }

  // 2. Authenticity inspection
  const authenticity = inspectFileAuthenticity(buffer, originalFilename, declaredMimeType);
  if (!authenticity.passed) {
    const status: SecurityStatus = authenticity.doubleExtensionDetected ? 'THREAT_DETECTED' : 'REJECTED';
    const statusMessage = authenticity.details[0] || 'File failed authenticity inspection.';

    const report: FullSecurityReport = {
      fileId,
      status,
      statusMessage,
      metadata,
      authenticity,
      structure: {
        passed: false,
        isZipBomb: false,
        entryCount: 0,
        decompressedSize: 0,
        decompressionRatio: 0,
        pathTraversalAttempts: [],
        malformedStructure: false,
        details: ['Structure inspection aborted due to authenticity failure.'],
      },
      activeContent: {
        passed: false,
        hasJavaScript: false,
        hasAutomaticActions: false,
        hasLaunchActions: false,
        hasEmbeddedFiles: false,
        hasMacros: false,
        hasOleObjects: false,
        hasSuspiciousExternalRelationships: false,
        hasInvalidEncoding: false,
        details: ['Active content inspection aborted.'],
      },
      malware: {
        passed: false,
        engine: 'Not run',
        threatsFound: [],
        scannerAvailable: true,
        details: ['Malware scan skipped.'],
      },
      promptInjection: {
        passed: false,
        flaggedPatterns: [],
        riskLevel: 'NONE',
        details: ['Prompt injection inspection skipped.'],
      },
      scanDurationMs: Date.now() - startTime,
      eligibleForContractProcessing: false,
      completedAt: new Date().toISOString(),
    };
    saveSecurityReport(report);
    return report;
  }

  // 3. Document structure & ZIP Bomb inspection
  const structure = inspectDocumentStructure(buffer, authenticity.detectedFormat);
  if (!structure.passed) {
    const status: SecurityStatus = structure.isZipBomb || structure.pathTraversalAttempts.length > 0
      ? 'THREAT_DETECTED'
      : 'REJECTED';
    const statusMessage = structure.details[0] || 'Document structure inspection failed.';

    const report: FullSecurityReport = {
      fileId,
      status,
      statusMessage,
      metadata,
      authenticity,
      structure,
      activeContent: {
        passed: false,
        hasJavaScript: false,
        hasAutomaticActions: false,
        hasLaunchActions: false,
        hasEmbeddedFiles: false,
        hasMacros: false,
        hasOleObjects: false,
        hasSuspiciousExternalRelationships: false,
        hasInvalidEncoding: false,
        details: ['Active content inspection aborted.'],
      },
      malware: {
        passed: false,
        engine: 'Not run',
        threatsFound: [],
        scannerAvailable: true,
        details: ['Malware scan skipped.'],
      },
      promptInjection: {
        passed: false,
        flaggedPatterns: [],
        riskLevel: 'NONE',
        details: ['Prompt injection inspection skipped.'],
      },
      scanDurationMs: Date.now() - startTime,
      eligibleForContractProcessing: false,
      completedAt: new Date().toISOString(),
    };
    saveSecurityReport(report);
    return report;
  }

  // 4. Active Content inspection (JavaScript, Macros, Launch Actions, OLE Objects)
  const activeContent = inspectActiveContent(buffer, authenticity.detectedFormat);
  if (!activeContent.passed) {
    const isThreat =
      activeContent.hasLaunchActions ||
      activeContent.hasJavaScript ||
      activeContent.hasMacros ||
      activeContent.hasSuspiciousExternalRelationships;

    const status: SecurityStatus = isThreat ? 'THREAT_DETECTED' : 'REJECTED';
    const statusMessage = activeContent.details[0] || 'Active content detected.';

    const report: FullSecurityReport = {
      fileId,
      status,
      statusMessage,
      metadata,
      authenticity,
      structure,
      activeContent,
      malware: {
        passed: false,
        engine: 'Not run',
        threatsFound: [],
        scannerAvailable: true,
        details: ['Malware scan skipped due to active content rejection.'],
      },
      promptInjection: {
        passed: false,
        flaggedPatterns: [],
        riskLevel: 'NONE',
        details: ['Prompt injection inspection skipped.'],
      },
      scanDurationMs: Date.now() - startTime,
      eligibleForContractProcessing: false,
      completedAt: new Date().toISOString(),
    };
    saveSecurityReport(report);
    return report;
  }

  // 5. Malware & Antivirus Scan
  const malware = await scanForMalware(buffer, options);
  if (!malware.scannerAvailable) {
    // Fail-closed. "Unavailable" = no real scanner could be used; "scan failed" = a scan was attempted and did not complete.
    const unavailable = malware.outcome === 'unavailable';
    const report: FullSecurityReport = {
      fileId,
      status: unavailable ? 'UNAVAILABLE' : 'SCAN_FAILED',
      statusMessage: malware.details[0] || 'Mandatory malware inspection failed.',
      metadata,
      authenticity,
      structure,
      activeContent,
      malware,
      promptInjection: {
        passed: false,
        flaggedPatterns: [],
        riskLevel: 'NONE',
        details: ['Prompt injection inspection skipped.'],
      },
      scanDurationMs: Date.now() - startTime,
      eligibleForContractProcessing: false,
      completedAt: new Date().toISOString(),
    };
    saveSecurityReport(report);
    return report;
  }

  if (!malware.passed) {
    const report: FullSecurityReport = {
      fileId,
      status: 'THREAT_DETECTED',
      statusMessage: `Malicious signature detected: ${malware.threatsFound.join(', ')}`,
      metadata,
      authenticity,
      structure,
      activeContent,
      malware,
      promptInjection: {
        passed: false,
        flaggedPatterns: [],
        riskLevel: 'NONE',
        details: ['Prompt injection inspection skipped.'],
      },
      scanDurationMs: Date.now() - startTime,
      eligibleForContractProcessing: false,
      completedAt: new Date().toISOString(),
    };
    saveSecurityReport(report);
    return report;
  }

  // 6. Prompt Injection inspection
  const promptInjection = inspectPromptInjection(buffer, authenticity.detectedFormat);
  if (!promptInjection.passed) {
    const report: FullSecurityReport = {
      fileId,
      status: 'SUSPICIOUS',
      statusMessage: 'Suspicious AI prompt override directives detected inside document text.',
      metadata,
      authenticity,
      structure,
      activeContent,
      malware,
      promptInjection,
      scanDurationMs: Date.now() - startTime,
      // Suspicious prompt injections are quarantined and not eligible for auto-processing
      eligibleForContractProcessing: false,
      completedAt: new Date().toISOString(),
    };
    saveSecurityReport(report);
    return report;
  }

  // 7. All checks passed cleanly
  const report: FullSecurityReport = {
    fileId,
    status: 'CLEAN_NO_KNOWN_THREATS',
    statusMessage:
      malware.genuine === false
        ? 'DEMO SCANNER ONLY: no genuine antivirus scan was performed. The other security checks passed. (Local development / tests.)'
        : 'All mandatory security checks passed. No known threats detected.',
    metadata,
    authenticity,
    structure,
    activeContent,
    malware,
    promptInjection,
    scanDurationMs: Date.now() - startTime,
    eligibleForContractProcessing: true,
    completedAt: new Date().toISOString(),
  };

  saveSecurityReport(report);
  return report;
}
