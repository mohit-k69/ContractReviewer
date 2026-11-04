import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';

const isProduction = process.env.NODE_ENV === 'production';

// In production, require persistent SESSION_SECRET
if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error('FATAL SECURITY ERROR: SESSION_SECRET environment variable is mandatory in production mode.');
}

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
export const COOKIE_NAME = 'fineprint_session';

export interface AuthenticatedSession {
  sessionId: string;
  issuedAt: number;
}

export interface AuthenticatedRequest extends Request {
  verifiedSession?: AuthenticatedSession;
}

// IP-based session issuance rate limiting (max 10 per minute per IP)
const sessionIssuanceCounts = new Map<string, number[]>();
const ISSUANCE_LIMIT = 10;
const ISSUANCE_WINDOW_MS = 60 * 1000;

export function rateLimitSessionIssuance(req: Request, res: Response, next: NextFunction): void {
  const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowStart = now - ISSUANCE_WINDOW_MS;

  const timestamps = (sessionIssuanceCounts.get(ip) || []).filter((t) => t > windowStart);
  if (timestamps.length >= ISSUANCE_LIMIT) {
    res.status(429).json({
      error: 'Too many session creation requests from this IP. Please wait a moment.',
      status: 'REJECTED',
    });
    return;
  }

  timestamps.push(now);
  sessionIssuanceCounts.set(ip, timestamps);
  next();
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
 * Sets HttpOnly, SameSite=Strict cookie on the response without exposing token in response JSON
 */
export function attachSessionCookie(res: Response, token: string): void {
  const secureFlag = isProduction ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict${secureFlag}; Max-Age=86400`
  );
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

/**
 * Origin and Referer validation middleware for state-changing requests (CSRF protection)
 */
export function verifyOriginProtection(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return next();
  }

  const origin = req.headers['origin'] as string | undefined;
  const host = req.headers['host'];

  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host !== host) {
        res.status(403).json({
          error: 'Cross-Site Request Forgery (CSRF) blocked: Origin header mismatch.',
          status: 'UNAUTHORIZED',
        });
        return;
      }
    } catch {
      res.status(403).json({
        error: 'Invalid Origin header.',
        status: 'UNAUTHORIZED',
      });
      return;
    }
  }

  next();
}

/**
 * Express middleware that enforces HttpOnly cookie session authentication.
 * Does NOT accept token via custom headers or JSON bodies.
 */
export function requireSessionAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const cookieHeader = req.headers['cookie'];
  let token: string | undefined;

  if (cookieHeader) {
    const cookies = cookieHeader.split(';').map((c) => c.trim());
    for (const c of cookies) {
      if (c.startsWith(`${COOKIE_NAME}=`)) {
        token = c.substring(COOKIE_NAME.length + 1);
        break;
      }
    }
  }

  const session = verifySessionToken(token);

  if (!session) {
    res.status(401).json({
      error: 'Authentication failed: Missing or invalid secure session cookie. Please refresh the page.',
      status: 'UNAUTHORIZED',
    });
    return;
  }

  req.verifiedSession = session;
  next();
}
