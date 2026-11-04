import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { FileMetadata, FullSecurityReport } from './types';

// The project directory is read-only on serverless platforms (Vercel), where only the OS temp dir is writable.
export const QUARANTINE_DIR = process.env.QUARANTINE_DIR
  ? path.resolve(process.env.QUARANTINE_DIR)
  : process.env.VERCEL
  ? path.join(os.tmpdir(), 'fineprint-quarantine')
  : path.resolve(process.cwd(), '.quarantine');
export const RETENTION_PERIOD_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface CleanupFailure {
  fileId: string;
  error: string;
  timestamp: string;
}

// Track cleanup failures for audit and observability
const cleanupFailures: CleanupFailure[] = [];

// In-memory registry of quarantined documents with session ownership
const quarantineRegistry = new Map<string, { metadata: FileMetadata; report?: FullSecurityReport }>();

type DocumentRemovedListener = (fileId: string) => void;
const documentRemovedListeners: DocumentRemovedListener[] = [];

export function onDocumentRemoved(listener: DocumentRemovedListener): void {
  documentRemovedListeners.push(listener);
}

export function notifyDocumentRemoved(fileId: string): void {
  for (const listener of documentRemovedListeners) {
    try {
      listener(fileId);
    } catch (err) {
      console.error(`[QuarantineManager] Error in document removed listener for ${fileId}:`, err);
    }
  }
}

export function hasDocumentRecord(fileId: string): boolean {
  return quarantineRegistry.has(fileId);
}

export function purgeDocumentRecord(fileId: string): void {
  quarantineRegistry.delete(fileId);
  notifyDocumentRemoved(fileId);
}

export function getCleanupFailures(): CleanupFailure[] {
  return [...cleanupFailures];
}

// Ensure quarantine folder exists with restricted permissions (0700)
export function initQuarantineStorage(): void {
  if (!fs.existsSync(QUARANTINE_DIR)) {
    fs.mkdirSync(QUARANTINE_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Startup reconciliation:
 * Scans quarantine storage on server boot to:
 * 1. Purge expired files (> 2 hours) across server restarts.
 * 2. Re-register non-expired documents and reports into memory.
 * 3. Detect and remove orphaned .quarantine files without metadata.
 * 4. Record any cleanup failures explicitly.
 */
export function reconcileQuarantineOnStartup(): { purged: number; restored: number; failed: number } {
  initQuarantineStorage();

  let purged = 0;
  let restored = 0;
  let failed = 0;
  const now = Date.now();

  try {
    const files = fs.readdirSync(QUARANTINE_DIR);
    const metaFiles = files.filter((f) => f.endsWith('.meta.json'));
    const quarantineFiles = new Set(files.filter((f) => f.endsWith('.quarantine')));

    for (const metaFileName of metaFiles) {
      const fileId = metaFileName.replace('.meta.json', '');
      const metaPath = path.join(QUARANTINE_DIR, metaFileName);
      const quatPath = path.join(QUARANTINE_DIR, `${fileId}.quarantine`);

      quarantineFiles.delete(`${fileId}.quarantine`);

      try {
        const raw = fs.readFileSync(metaPath, 'utf8');
        const data = JSON.parse(raw);
        const uploadedTime = new Date(data.metadata.uploadedAt).getTime();

        if (now - uploadedTime > RETENTION_PERIOD_MS) {
          // Expired file: purge
          if (fs.existsSync(quatPath)) fs.unlinkSync(quatPath);
          fs.unlinkSync(metaPath);
          purged++;
          notifyDocumentRemoved(fileId);
        } else {
          // Valid non-expired file: restore to registry
          quarantineRegistry.set(fileId, {
            metadata: data.metadata,
            report: data.report,
          });
          restored++;
        }
      } catch (err: any) {
        failed++;
        const failure: CleanupFailure = {
          fileId,
          error: `Startup reconciliation failed for ${metaFileName}: ${err.message}`,
          timestamp: new Date().toISOString(),
        };
        cleanupFailures.push(failure);
        console.error('[QuarantineReconciliationError]', failure);
      }
    }

    // Handle orphaned .quarantine files without metadata
    for (const orphanName of quarantineFiles) {
      const orphanPath = path.join(QUARANTINE_DIR, orphanName);
      try {
        const stat = fs.statSync(orphanPath);
        if (now - stat.mtimeMs > RETENTION_PERIOD_MS) {
          fs.unlinkSync(orphanPath);
          purged++;
        }
      } catch (err: any) {
        failed++;
        cleanupFailures.push({
          fileId: orphanName,
          error: `Failed removing orphaned file: ${err.message}`,
          timestamp: new Date().toISOString(),
        });
      }
    }
  } catch (err: any) {
    console.error('[QuarantineReconciliationFatal]', err);
  }

  return { purged, restored, failed };
}

export function storeInQuarantine(
  buffer: Buffer,
  originalFilename: string,
  declaredMimeType: string,
  sessionId: string
): { fileId: string; filePath: string; metadata: FileMetadata } {
  initQuarantineStorage();

  const fileId = crypto.randomUUID();
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const safeFilename = `${fileId}.quarantine`;
  const metaFilename = `${fileId}.meta.json`;
  const filePath = path.join(QUARANTINE_DIR, safeFilename);
  const metaPath = path.join(QUARANTINE_DIR, metaFilename);

  // Write isolated file with strict non-executable permissions (0600)
  fs.writeFileSync(filePath, buffer, { mode: 0o600 });

  const metadata: FileMetadata = {
    fileId,
    originalName: path.basename(originalFilename),
    fileSize: buffer.length,
    sha256,
    mimeType: declaredMimeType,
    detectedExtension: path.extname(originalFilename).toLowerCase(),
    sessionId,
    uploadedAt: new Date().toISOString(),
  };

  // Persist metadata to disk so it survives restarts
  fs.writeFileSync(metaPath, JSON.stringify({ metadata }), { mode: 0o600 });

  quarantineRegistry.set(fileId, { metadata });

  return { fileId, filePath, metadata };
}

export function saveSecurityReport(report: FullSecurityReport): void {
  const existing = quarantineRegistry.get(report.fileId);
  const metadata = existing?.metadata || report.metadata;

  quarantineRegistry.set(report.fileId, {
    metadata,
    report,
  });

  // Update persistent metadata with report
  const metaPath = path.join(QUARANTINE_DIR, `${report.fileId}.meta.json`);
  try {
    fs.writeFileSync(metaPath, JSON.stringify({ metadata, report }), { mode: 0o600 });
  } catch (err: any) {
    console.error(`Failed persisting security report for ${report.fileId}:`, err);
  }
}

export function getSecurityReport(
  fileId: string,
  requestingSessionId: string
): { report?: FullSecurityReport; authorized: boolean } {
  const record = quarantineRegistry.get(fileId);
  if (!record) {
    return { authorized: true };
  }

  // Enforce session ownership
  if (record.metadata.sessionId !== requestingSessionId) {
    return { authorized: false };
  }

  return { report: record.report, authorized: true };
}

export function getQuarantinedFileBuffer(
  fileId: string,
  requestingSessionId: string
): { buffer?: Buffer; metadata?: FileMetadata; authorized: boolean; error?: string } {
  const record = quarantineRegistry.get(fileId);
  if (!record) {
    return { authorized: true, error: 'Document not found in quarantine registry.' };
  }

  if (record.metadata.sessionId !== requestingSessionId) {
    return { authorized: false, error: 'Access denied: Session ownership mismatch.' };
  }

  const filePath = path.join(QUARANTINE_DIR, `${fileId}.quarantine`);
  if (!fs.existsSync(filePath)) {
    return { authorized: true, error: 'Quarantined file payload does not exist on disk.' };
  }

  try {
    const buffer = fs.readFileSync(filePath);
    return { buffer, metadata: record.metadata, authorized: true };
  } catch (err: any) {
    return { authorized: true, error: `Failed reading quarantined document: ${err.message}` };
  }
}

export function deleteQuarantinedFile(
  fileId: string,
  requestingSessionId: string
): { success: boolean; authorized: boolean; error?: string } {
  const record = quarantineRegistry.get(fileId);
  if (!record) {
    return { success: false, authorized: true, error: 'Document not found in quarantine registry.' };
  }

  if (record.metadata.sessionId !== requestingSessionId) {
    return { success: false, authorized: false, error: 'Access denied: Session ownership mismatch.' };
  }

  const filePath = path.join(QUARANTINE_DIR, `${fileId}.quarantine`);
  const metaPath = path.join(QUARANTINE_DIR, `${fileId}.meta.json`);

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    if (fs.existsSync(metaPath)) {
      fs.unlinkSync(metaPath);
    }
  } catch (err: any) {
    const failure: CleanupFailure = {
      fileId,
      error: `Filesystem deletion failed: ${err.message}`,
      timestamp: new Date().toISOString(),
    };
    cleanupFailures.push(failure);
    return {
      success: false,
      authorized: true,
      error: failure.error,
    };
  }

  quarantineRegistry.delete(fileId);
  notifyDocumentRemoved(fileId);
  return { success: true, authorized: true };
}

// Periodic cleanup loop checking for expired files
setInterval(() => {
  const now = Date.now();
  for (const [id, record] of quarantineRegistry.entries()) {
    const uploadedTime = new Date(record.metadata.uploadedAt).getTime();
    if (now - uploadedTime > RETENTION_PERIOD_MS) {
      const del = deleteQuarantinedFile(id, record.metadata.sessionId);
      if (!del.success && del.error) {
        cleanupFailures.push({
          fileId: id,
          error: `Periodic cleanup failed: ${del.error}`,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }
}, 15 * 60 * 1000).unref();
