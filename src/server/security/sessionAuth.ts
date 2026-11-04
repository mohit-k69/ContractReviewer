import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';

// Secret used for signing session tokens
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface AuthenticatedSession {
  sessionId: string;
  issuedAt: number;
}

/**
 * Creates a cryptographically signed session token:
 * format: <sessionId>.<timestamp>.<hmacHex>
 */
export function createSignedSessionToken(sessionId?: string): string {
  const id = sessionId || crypto.randomBytes(16).toString('hex');
  const timestamp = Date.now().toString();
  const payload = `${id}.${timestamp}`;
  const hmac = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('hex');

  return `${payload}.${hmac}`;
}

/**
 * Verifies a signed session token. Returns the verified sessionId or null if invalid/tampered/expired.
 */
export function verifySessionToken(token: string | undefined): AuthenticatedSession | null {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [sessionId, timestampStr, signature] = parts;
  const timestamp = parseInt(timestampStr, 10);

  if (isNaN(timestamp)) return null;

  // Check expiration
  if (Date.now() - timestamp > TOKEN_MAX_AGE_MS) {
    return null;
  }

  // Verify HMAC signature using constant-time comparison
  const expectedHmac = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(`${sessionId}.${timestampStr}`)
    .digest('hex');

  const sigBuf = Buffer.from(signature, 'hex');
  const expectedBuf = Buffer.from(expectedHmac, 'hex');

  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  return { sessionId, issuedAt: timestamp };
}

export interface AuthenticatedRequest extends Request {
  verifiedSession?: AuthenticatedSession;
}

/**
 * Express middleware that enforces cryptographically verified session authentication.
 * Looks for token in 'x-session-token' header or 'contract_session' cookie.
 * Does NOT accept arbitrary caller-provided identifiers without valid cryptographic signatures.
 */
export function requireSessionAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  // Check header or cookie
  const authHeader = req.headers['x-session-token'] as string | undefined;
  const cookieHeader = req.headers['cookie'];

  let token = authHeader;

  if (!token && cookieHeader) {
    const cookies = cookieHeader.split(';').map((c) => c.trim());
    for (const c of cookies) {
      if (c.startsWith('fineprint_session=')) {
        token = c.substring('fineprint_session='.length);
        break;
      }
    }
  }

  const session = verifySessionToken(token);

  if (!session) {
    res.status(401).json({
      error: 'Authentication failed: Missing or invalid cryptographic session token. Cross-user or unauthenticated access is prohibited.',
      status: 'UNAUTHORIZED',
    });
    return;
  }

  req.verifiedSession = session;
  next();
}
