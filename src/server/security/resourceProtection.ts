import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './sessionAuth';

export const MAX_GLOBAL_CONCURRENT_UPLOADS = 10;
export const MAX_SESSION_CONCURRENT_UPLOADS = 2;
export const MAX_SESSION_UPLOADS_PER_WINDOW = 10;
export const UPLOAD_RATE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
export const UPLOAD_TIMEOUT_MS = 30000; // 30 seconds

// Concurrency counters
let activeGlobalUploads = 0;
const activeSessionUploads = new Map<string, number>();

// Rate limiting counters: sessionId -> array of upload timestamps
const sessionUploadTimestamps = new Map<string, number[]>();

export function getActiveUploadCounts(): { global: number; sessionCount: number } {
  return {
    global: activeGlobalUploads,
    sessionCount: activeSessionUploads.size,
  };
}

export function resetResourceLimits(): void {
  activeGlobalUploads = 0;
  activeSessionUploads.clear();
  sessionUploadTimestamps.clear();
}

/**
 * Middleware that guards upload resource consumption:
 * 1. Global concurrency limit
 * 2. Per-session concurrency limit
 * 3. Per-session rate limit
 * 4. Request timeout
 */
export function uploadResourceGuard(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const sessionId = req.verifiedSession?.sessionId;
  if (!sessionId) {
    res.status(401).json({
      error: 'Authentication required before uploading documents.',
      status: 'UNAUTHORIZED',
    });
    return;
  }

  // 1. Check global concurrency
  if (activeGlobalUploads >= MAX_GLOBAL_CONCURRENT_UPLOADS) {
    res.status(429).json({
      error: 'Server is currently processing maximum concurrent uploads. Please retry shortly.',
      status: 'REJECTED',
    });
    return;
  }

  // 2. Check per-session concurrency
  const sessionActive = activeSessionUploads.get(sessionId) || 0;
  if (sessionActive >= MAX_SESSION_CONCURRENT_UPLOADS) {
    res.status(429).json({
      error: 'You already have active contract uploads in progress. Please wait for them to finish.',
      status: 'REJECTED',
    });
    return;
  }

  // 3. Check per-session rate limit
  const now = Date.now();
  const windowStart = now - UPLOAD_RATE_WINDOW_MS;
  const timestamps = (sessionUploadTimestamps.get(sessionId) || []).filter((t) => t > windowStart);

  if (timestamps.length >= MAX_SESSION_UPLOADS_PER_WINDOW) {
    res.status(429).json({
      error: 'Upload rate limit exceeded (maximum 10 uploads per 5 minutes). Please try again later.',
      status: 'REJECTED',
    });
    return;
  }

  // Increment counters
  activeGlobalUploads++;
  activeSessionUploads.set(sessionId, sessionActive + 1);
  timestamps.push(now);
  sessionUploadTimestamps.set(sessionId, timestamps);

  // Set request timeout
  req.setTimeout(UPLOAD_TIMEOUT_MS, () => {
    if (!res.headersSent) {
      res.status(504).json({
        error: 'Upload processing timed out after 30 seconds.',
        status: 'SCAN_FAILED',
      });
    }
  });

  // Ensure counters decrement on finish, close, or error
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeGlobalUploads = Math.max(0, activeGlobalUploads - 1);
    const current = activeSessionUploads.get(sessionId) || 1;
    if (current <= 1) {
      activeSessionUploads.delete(sessionId);
    } else {
      activeSessionUploads.set(sessionId, current - 1);
    }
  };

  res.on('finish', release);
  res.on('close', release);
  res.on('error', release);

  next();
}
