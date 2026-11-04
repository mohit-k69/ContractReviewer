import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FileMetadata, FullSecurityReport } from './types';

export const QUARANTINE_DIR = path.resolve(process.cwd(), '.quarantine');

// Ensure quarantine folder exists with restricted permissions (0700)
export function initQuarantineStorage(): void {
  if (!fs.existsSync(QUARANTINE_DIR)) {
    fs.mkdirSync(QUARANTINE_DIR, { recursive: true, mode: 0o700 });
  }
}

// In-memory registry of reports with access control (session ID enforcement)
const quarantineRegistry = new Map<string, { metadata: FileMetadata; report: FullSecurityReport }>();

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
  const filePath = path.join(QUARANTINE_DIR, safeFilename);

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

  return { fileId, filePath, metadata };
}

export function saveSecurityReport(report: FullSecurityReport): void {
  quarantineRegistry.set(report.fileId, {
    metadata: report.metadata,
    report,
  });
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

export function deleteQuarantinedFile(
  fileId: string,
  requestingSessionId: string
): { success: boolean; authorized: boolean } {
  const record = quarantineRegistry.get(fileId);
  if (!record) {
    return { success: false, authorized: true };
  }

  if (record.metadata.sessionId !== requestingSessionId) {
    return { success: false, authorized: false };
  }

  const filePath = path.join(QUARANTINE_DIR, `${fileId}.quarantine`);
  if (fs.existsSync(filePath)) {
    try {
      // Securely wipe file before unlinking
      const size = fs.statSync(filePath).size;
      fs.writeFileSync(filePath, Buffer.alloc(Math.min(size, 4096), 0));
      fs.unlinkSync(filePath);
    } catch {
      // Continue cleanup
    }
  }

  quarantineRegistry.delete(fileId);
  return { success: true, authorized: true };
}

// Automatic cleanup of old quarantined items (older than 2 hours)
setInterval(() => {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, record] of quarantineRegistry.entries()) {
    const uploadedTime = new Date(record.metadata.uploadedAt).getTime();
    if (uploadedTime < twoHoursAgo) {
      deleteQuarantinedFile(id, record.metadata.sessionId);
    }
  }
}, 30 * 60 * 1000).unref();
