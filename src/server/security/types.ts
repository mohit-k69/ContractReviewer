export type SecurityStatus =
  | 'RECEIVED'
  | 'QUARANTINED'
  | 'SCANNING'
  | 'CLEAN_NO_KNOWN_THREATS'
  | 'SUSPICIOUS'
  | 'THREAT_DETECTED'
  | 'REJECTED'
  | 'SCAN_FAILED';

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
