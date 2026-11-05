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
/**
 * Documents are NOT retained. Each upload is deleted (file, metadata, registry entry and every cache) as soon as its
 * request has finished, whether it succeeded or failed. This age limit is only a safety net for debris that a
 * crashed or killed request could leave behind; it is swept at every upload and by a timer.
 */
export const ORPHAN_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

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
 * Startup: nothing is restored. Any document left on disk by a previous run is deleted, because documents are only
 * ever held for the duration of a single request.
 */
export function reconcileQuarantineOnStartup(): { purged: number; restored: number; failed: number } {
  initQuarantineStorage();
  let purged = 0;
  let failed = 0;
  try {
    for (const name of fs.readdirSync(QUARANTINE_DIR)) {
      if (!name.endsWith('.quarantine') && !name.endsWith('.meta.json')) continue;
      try {
        fs.unlinkSync(path.join(QUARANTINE_DIR, name));
        purged++;
      } catch (err: any) {
        failed++;
        const failure: CleanupFailure = { fileId: name.split('.')[0], error: `Startup purge failed: ${err.message}`, timestamp: new Date().toISOString() };
        cleanupFailures.push(failure);
        console.error('[QuarantineStartupPurgeError]', failure);
      }
    }
  } catch (err: any) {
    console.error('[QuarantineStartupPurgeFatal]', err);
  }
  return { purged, restored: 0, failed };
}

/** Deletes debris older than ORPHAN_MAX_AGE_MS (files left by a request that never finished). */
export function sweepStaleFiles(now = Date.now()): number {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(QUARANTINE_DIR)) {
      if (!name.endsWith('.quarantine') && !name.endsWith('.meta.json')) continue;
      const full = path.join(QUARANTINE_DIR, name);
      try {
        if (now - fs.statSync(full).mtimeMs > ORPHAN_MAX_AGE_MS) {
          fs.unlinkSync(full);
          removed++;
          const fileId = name.split('.')[0];
          if (quarantineRegistry.has(fileId)) purgeDocumentRecord(fileId);
        }
      } catch (err: any) {
        cleanupFailures.push({ fileId: name.split('.')[0], error: `Sweep failed: ${err.message}`, timestamp: new Date().toISOString() });
      }
    }
  } catch {
    // directory missing: nothing to sweep
  }
  return removed;
}

export function storeInQuarantine(
  buffer: Buffer,
  originalFilename: string,
  declaredMimeType: string,
  sessionId: string
): { fileId: string; filePath: string; metadata: FileMetadata } {
  initQuarantineStorage();
  sweepStaleFiles(); // opportunistic: serverless timers may never fire

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

  let failure: CleanupFailure | undefined;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  } catch (err: any) {
    failure = { fileId, error: `Filesystem deletion failed: ${err.message}`, timestamp: new Date().toISOString() };
    cleanupFailures.push(failure);
  }

  // The in-memory registry entry and every cache (extraction, normalization, understanding) are cleared even if a
  // file could not be unlinked; the sweeper removes any remaining file.
  quarantineRegistry.delete(fileId);
  notifyDocumentRemoved(fileId);
  return failure ? { success: false, authorized: true, error: failure.error } : { success: true, authorized: true };
}

// Safety-net sweep for debris only (documents are normally deleted at the end of their own request)
setInterval(() => {
  sweepStaleFiles();
}, 5 * 60 * 1000).unref();
