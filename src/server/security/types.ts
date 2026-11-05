export type SecurityStatus =
  | 'RECEIVED'
  | 'QUARANTINED'
  | 'SCANNING'
  | 'CLEAN_NO_KNOWN_THREATS'
  | 'SUSPICIOUS'
  | 'THREAT_DETECTED'
  | 'REJECTED'
  | 'SCAN_FAILED'
  /** No real antivirus is configured or reachable, so the document was NOT scanned (fail-closed) */
  | 'UNAVAILABLE'
  /**
   * Every built-in check passed (authenticity, structure, active content, known-threat signatures, prompt-injection),
   * but NO antivirus scan was performed. This is NOT a clean antivirus result and never says the file is malware-free.
   */
  | 'BASIC_CHECKS_PASSED_NO_ANTIVIRUS';

/** Fixed wording for the basic-checks result. Must never be reworded to suggest the file is safe or virus-free. */
export const BASIC_CHECKS_MESSAGE = 'Basic document security checks passed. Full antivirus scanning was not performed.';

/**
 * optional (default): a configured ClamAV is used and enforced; with none configured, the built-in checks decide.
 * required: a genuine ClamAV scan is mandatory; with none configured, uploads are UNAVAILABLE.
 */
export type AntivirusPolicy = 'optional' | 'required';

export interface FileMetadata {
  fileId: string;
  originalName: string;
  fileSize: number;
  sha256: string;
  mimeType: string;
  detectedExtension: string;
  sessionId: string;
  uploadedAt: string;
}

export interface AuthenticityInspectionResult {
  passed: boolean;
  detectedFormat: 'pdf' | 'docx' | 'txt' | 'unknown';
  mimeMatch: boolean;
  doubleExtensionDetected: boolean;
  passwordProtected: boolean;
  corrupted: boolean;
  details: string[];
}

export interface MalwareScanResult {
  passed: boolean;
  engine: string;
  threatsFound: string[];
  scannerAvailable: boolean;
  details: string[];
  /** How the scan ended. Only 'clean' with `genuine: true` is a real antivirus clean verdict. */
  outcome?: 'clean' | 'threat' | 'error' | 'unavailable' | 'not_performed';
  /** Which kind of scanner produced the result */
  scanner?: 'clamav-service' | 'clamav-tcp' | 'none';
  /** True only when a real ClamAV engine completed the scan. Built-in checks are never genuine antivirus. */
  genuine?: boolean;
  engineVersion?: string;
}

export interface ActiveContentInspectionResult {
  passed: boolean;
  hasJavaScript: boolean;
  hasAutomaticActions: boolean;
  hasLaunchActions: boolean;
  hasEmbeddedFiles: boolean;
  hasMacros: boolean;
  hasOleObjects: boolean;
  hasSuspiciousExternalRelationships: boolean;
  hasInvalidEncoding: boolean;
  details: string[];
}

export interface DocumentStructureResult {
  passed: boolean;
  isZipBomb: boolean;
  entryCount: number;
  decompressedSize: number;
  decompressionRatio: number;
  pathTraversalAttempts: string[];
  malformedStructure: boolean;
  details: string[];
}

export interface PromptInjectionInspectionResult {
  passed: boolean;
  flaggedPatterns: string[];
  riskLevel: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
  details: string[];
}

export interface FullSecurityReport {
  fileId: string;
  status: SecurityStatus;
  statusMessage: string;
  metadata: FileMetadata;
  authenticity: AuthenticityInspectionResult;
  structure: DocumentStructureResult;
  activeContent: ActiveContentInspectionResult;
  malware: MalwareScanResult;
  promptInjection: PromptInjectionInspectionResult;
  scanDurationMs: number;
  eligibleForContractProcessing: boolean;
  completedAt: string;
}
