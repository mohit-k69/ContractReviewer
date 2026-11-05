import { inspectFileAuthenticity } from './authenticityInspector';
import { inspectDocumentStructure } from './structureInspector';
import { inspectActiveContent } from './activeContentInspector';
import { scanForMalware } from './malwareScanner';
import { builtInMalwareResult, inspectKnownThreats } from './knownThreatInspector';
import { antivirusPolicy } from './scannerConfig';
import { inspectPromptInjection } from './promptInjectionInspector';
import {
  storeInQuarantine,
  saveSecurityReport,
  deleteQuarantinedFile,
} from './quarantineManager';
import { AntivirusPolicy, BASIC_CHECKS_MESSAGE, FileMetadata, FullSecurityReport, SecurityStatus } from './types';

export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

export interface PipelineOptions {
  /** Test/override hooks for the OPTIONAL antivirus */
  clamavHost?: string;
  clamavPort?: number;
  timeoutMs?: number;
  scanUrl?: string;
  scanToken?: string;
  fetchImpl?: typeof fetch;
  /** Defaults to ANTIVIRUS_POLICY (optional unless set to something else) */
  policy?: AntivirusPolicy;
  requireExternalScanner?: boolean;
}

/**
 * Runs every security check on an upload.
 *
 *   authenticity/MIME -> structure (ZIP bomb, traversal) -> active content (JS, macros, embedded files)
 *   -> built-in known-threat signatures -> prompt-injection -> OPTIONAL antivirus (ClamAV)
 *
 * The built-in checks and the (advisory, non-blocking) prompt-injection check always run, with or without an antivirus. The document is held in the
 * quarantine only while this request is being processed: the caller deletes it afterwards, and this function deletes
 * it itself if inspection throws.
 */
export async function runSecurityInspectionPipeline(
  buffer: Buffer,
  originalFilename: string,
  declaredMimeType: string,
  sessionId: string,
  options: PipelineOptions = {}
): Promise<FullSecurityReport> {
  const stored = storeInQuarantine(buffer, originalFilename, declaredMimeType, sessionId);
  try {
    return await inspect(stored.fileId, stored.metadata, buffer, originalFilename, declaredMimeType, options);
  } catch (err) {
    deleteQuarantinedFile(stored.fileId, sessionId);
    throw err;
  }
}

async function inspect(
  fileId: string,
  metadata: FileMetadata,
  buffer: Buffer,
  originalFilename: string,
  declaredMimeType: string,
  options: PipelineOptions
): Promise<FullSecurityReport> {
  const startTime = Date.now();

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

  // 5. Built-in known-malicious-pattern check. Always runs; independent of any antivirus service.
  const known = inspectKnownThreats(buffer);
  const skippedPromptInjection = { passed: false, flaggedPatterns: [] as string[], riskLevel: 'NONE' as const, details: ['Prompt injection inspection skipped.'] };
  const finish = (
    status: SecurityStatus,
    statusMessage: string,
    malware: FullSecurityReport['malware'],
    promptInjection: FullSecurityReport['promptInjection'],
    eligible: boolean
  ): FullSecurityReport => {
    const report: FullSecurityReport = {
      fileId,
      status,
      statusMessage,
      metadata,
      authenticity,
      structure,
      activeContent,
      malware,
      promptInjection,
      scanDurationMs: Date.now() - startTime,
      eligibleForContractProcessing: eligible,
      completedAt: new Date().toISOString(),
    };
    saveSecurityReport(report);
    return report;
  };

  if (!known.passed) {
    return finish('THREAT_DETECTED', `Malicious signature detected: ${known.threatsFound.join(', ')}`, builtInMalwareResult(known), skippedPromptInjection, false);
  }

  // 6. Prompt-injection inspection. Always runs, but it is ADVISORY: wording such as "ignore", "instructions" or
  //    "system" is ordinary in contracts, so it never blocks a document. The finding is recorded in the report, and
  //    the document text is always passed to the AI as untrusted data (see promptBuilder).
  const promptInjection = inspectPromptInjection(buffer, authenticity.detectedFormat);
  const builtIn = builtInMalwareResult(known);

  // 7. OPTIONAL antivirus. If one is configured it is enforced and fails closed; if none is configured, the policy decides.
  const av = await scanForMalware(buffer, options);
  const policy = options.policy ?? antivirusPolicy();

  switch (av.outcome) {
    case 'threat':
      return finish('THREAT_DETECTED', `Malicious signature detected: ${av.threatsFound.join(', ')}`, { ...av, details: [...av.details, ...known.details] }, promptInjection, false);
    case 'error':
      // A configured antivirus failed (timeout, invalid response, bad credentials...): never downgrade to basic mode.
      return finish('SCAN_FAILED', av.details[0] || 'The antivirus scan failed, so the document was not cleared.', av, promptInjection, false);
    case 'unavailable':
      return finish('UNAVAILABLE', av.details[0] || 'The antivirus scanner is unavailable, so the document was not scanned.', av, promptInjection, false);
    case 'clean':
      return finish('CLEAN_NO_KNOWN_THREATS', 'All mandatory security checks passed. No known threats detected.', { ...av, details: [...av.details, ...known.details] }, promptInjection, true);
    default: {
      // not_performed: no antivirus is configured
      if (policy === 'required') {
        return finish(
          'UNAVAILABLE',
          'Security scanning is unavailable: this deployment requires antivirus scanning (ANTIVIRUS_POLICY=required) but none is configured. Your document was not scanned and has not been analysed.',
          { ...builtIn, outcome: 'unavailable', details: [...builtIn.details, 'Antivirus scanning is required but not configured.'] },
          promptInjection,
          false
        );
      }
      return finish(
        'BASIC_CHECKS_PASSED_NO_ANTIVIRUS',
        BASIC_CHECKS_MESSAGE,
        { ...builtIn, details: [...builtIn.details, 'Full antivirus scanning was not performed.'] },
        promptInjection,
        true
      );
    }
  }
}
