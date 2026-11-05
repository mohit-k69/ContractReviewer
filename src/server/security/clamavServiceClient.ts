import crypto from 'node:crypto';

/**
 * Client for the separate ClamAV scanning service (scanner-service/, deployed on Google Cloud Run).
 *
 * The document is sent over authenticated HTTPS and scanned in memory by a real ClamAV daemon that runs privately
 * next to the service. This client never turns a failure into a clean result: only a well-formed "clean" answer
 * from a ClamAV engine, for exactly the bytes we sent, is clean.
 *
 * Outcomes
 *   clean       the service scanned the file with ClamAV and found nothing
 *   threat      ClamAV matched a signature
 *   error       a scan was attempted but did not complete or could not be trusted
 *               (timeout, rejected credentials, malformed or inconsistent response, internal error)
 *   unavailable the scan could not be performed (service unreachable, ClamAV not ready, service busy)
 */
export type ServiceOutcome = 'clean' | 'threat' | 'error' | 'unavailable';

export interface ServiceScanResult {
  outcome: ServiceOutcome;
  /** Signature name, for a threat */
  threat?: string;
  engineVersion?: string;
  /** Safe, user-facing explanation. Never contains the token. */
  message: string;
}

export interface ServiceScanOptions {
  url: string;
  token: string;
  timeoutMs?: number;
  /** Injected in tests */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_SERVICE_TIMEOUT_MS = 25000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** HTTPS only. Plain HTTP is accepted solely for a loopback address (local development and tests). */
export function validateScanUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'CLAMAV_SCAN_URL is not a valid URL.' };
  }
  if (url.protocol === 'https:') return { ok: true, url };
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return { ok: true, url };
  return { ok: false, reason: 'CLAMAV_SCAN_URL must use https:// (plain http is allowed only for localhost).' };
}

const sha256 = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');

async function readBounded(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('response too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const isAbort = (e: any): boolean => e?.name === 'TimeoutError' || e?.name === 'AbortError';

const fail = (outcome: 'error' | 'unavailable', message: string): ServiceScanResult => ({ outcome, message });

export async function scanViaService(buffer: Buffer, options: ServiceScanOptions): Promise<ServiceScanResult> {
  const target = validateScanUrl(options.url);
  if (!target.ok) return fail('error', `Security scanning is misconfigured: ${target.reason}`);
  if (!options.token) return fail('error', 'Security scanning is misconfigured: CLAMAV_SCAN_TOKEN is not set.');

  const timeoutMs = options.timeoutMs ?? DEFAULT_SERVICE_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;
  const digest = sha256(buffer);

  let res: Response;
  try {
    res = await doFetch(target.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.token}`,
        'content-type': 'application/octet-stream',
        'x-content-sha256': digest,
      },
      body: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) as unknown as BodyInit,
      // Never follow a redirect: it could carry the token to another host.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    if (isAbort(e)) return fail('error', `The security scan did not finish within ${Math.round(timeoutMs / 1000)} seconds, so the document was not cleared.`);
    return fail('unavailable', 'The antivirus scanning service could not be reached, so the document was not scanned.');
  }

  let text: string;
  try {
    text = await readBounded(res);
  } catch (e: any) {
    return isAbort(e)
      ? fail('error', 'The security scan did not finish in time, so the document was not cleared.')
      : fail('error', 'The antivirus scanning service sent an unreadable response, so the document was not cleared.');
  }

  if (res.status === 401 || res.status === 403) {
    return fail('error', 'The antivirus scanning service rejected this application’s credentials (check CLAMAV_SCAN_TOKEN). The document was not scanned.');
  }
  if (res.status === 413) return fail('error', 'The antivirus scanning service rejected the file as too large. The document was not scanned.');
  if (res.status === 429 || res.status === 503) {
    return fail('unavailable', 'The antivirus scanning service is not ready or is busy right now. The document was not scanned; please try again shortly.');
  }

  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    return fail('error', 'The antivirus scanning service sent a malformed response, so the document was not cleared.');
  }
  if (!body || typeof body !== 'object' || typeof body.status !== 'string') {
    return fail('error', 'The antivirus scanning service sent a malformed response, so the document was not cleared.');
  }

  const engine = typeof body.engine === 'string' ? body.engine : '';
  const engineVersion = typeof body.engineVersion === 'string' ? body.engineVersion.slice(0, 80) : undefined;
  const isClamAV = /^ClamAV/i.test(engine);

  switch (body.status) {
    case 'clean':
      // A clean verdict must come from ClamAV, with a 2xx status, and be about exactly the bytes we sent.
      if (res.status !== 200 || !isClamAV || body.sha256 !== digest) {
        return fail('error', 'The antivirus scanning service’s answer could not be verified, so the document was not cleared.');
      }
      return { outcome: 'clean', engineVersion, message: 'Scanned with ClamAV: no threat detected.' };
    case 'blocked': {
      if (res.status !== 200 || !isClamAV || body.sha256 !== digest) {
        return fail('error', 'The antivirus scanning service’s answer could not be verified, so the document was not cleared.');
      }
      const signature = typeof body.signature === 'string' && body.signature.trim() ? body.signature.trim().slice(0, 120) : 'Threat detected by ClamAV';
      return { outcome: 'threat', threat: signature, engineVersion, message: `ClamAV detected a threat: ${signature}` };
    }
    case 'unavailable':
      return fail('unavailable', 'The antivirus engine is not ready. The document was not scanned; please try again shortly.');
    case 'error':
      return fail('error', 'The antivirus scan failed, so the document was not cleared.');
    default:
      return fail('error', 'The antivirus scanning service sent an unrecognised answer, so the document was not cleared.');
  }
}

/** Readiness of the scanning service (GET <base>/ready). Used by /api/health?probe=1. Never throws. */
export async function probeScannerService(scanUrl: string, timeoutMs = 4000, fetchImpl: typeof fetch = fetch): Promise<{ ready: boolean; reason?: string }> {
  const target = validateScanUrl(scanUrl);
  if (!target.ok) return { ready: false, reason: 'misconfigured URL' };
  const ready = new URL('/ready', target.url);
  try {
    const res = await fetchImpl(ready, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    return res.status === 200 ? { ready: true } : { ready: false, reason: `scanner answered HTTP ${res.status}` };
  } catch (e: any) {
    return { ready: false, reason: isAbort(e) ? 'timed out' : 'unreachable' };
  }
}
