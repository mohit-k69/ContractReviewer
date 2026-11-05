import crypto from 'node:crypto';
import http from 'node:http';
import { ping, scanBuffer, version } from './clamd.mjs';

/**
 * ClamAV scanning API.
 *
 *   GET  /health   liveness (this process is up). Never touches ClamAV.
 *   GET  /ready    200 only when ClamAV answers PING (signatures loaded); otherwise 503.
 *   POST /scan     body = raw file bytes, header "Authorization: Bearer <SCAN_TOKEN>".
 *
 * /scan answers {status: 'clean' | 'blocked' | 'error' | 'unavailable', ...}. It answers "clean" only when ClamAV
 * itself said so for the bytes received. If ClamAV is down, slow or confused the answer is never "clean".
 *
 * Documents are held in memory for the duration of the request only: nothing is written to disk and neither file
 * contents nor file names are logged.
 */

const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

/** Constant-time comparison of two secrets of any length (compares their SHA-256 digests). */
export function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

export function createScannerServer(config) {
  const {
    token,
    clamdHost = '127.0.0.1',
    clamdPort = 3310,
    maxBytes = 20 * 1024 * 1024,
    scanTimeoutMs = 20000,
    maxConcurrent = 4,
    log = (entry) => console.log(JSON.stringify(entry)),
  } = config;
  if (typeof token !== 'string' || token.length < 24) throw new Error('SCAN_TOKEN must be set to a secret of at least 24 characters.');

  const clamd = { host: clamdHost, port: clamdPort };
  let active = 0;
  let cachedVersion = null;

  const send = (res, code, body, extra = {}) => {
    const payload = JSON.stringify(body);
    if (res.headersSent) return;
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    });
    res.end(payload);
  };

  /** Reject without reading the body, and close the connection so the rest of the upload is not consumed. */
  const rejectAndClose = (req, res, code, body, extra = {}) => {
    send(res, code, body, { connection: 'close', ...extra });
    res.once('finish', () => req.destroy());
  };

  const engineVersion = async () => {
    cachedVersion ??= await version(clamd);
    return cachedVersion;
  };

  async function handleScan(req, res, requestId) {
    const started = Date.now();
    const done = (outcome, bytes = 0, extra = {}) => log({ event: 'scan', requestId, outcome, bytes, durationMs: Date.now() - started, ...extra });

    // 1. Authenticate BEFORE touching the body
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !safeEqual(match[1].trim(), token)) {
      done('unauthorized');
      return rejectAndClose(req, res, 401, { status: 'error', reason: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
    }

    // 2. Size limit, declared and actual
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      done('too_large');
      return rejectAndClose(req, res, 413, { status: 'error', reason: 'file_too_large', maxBytes });
    }

    // 3. ClamAV must be ready, and we must have capacity
    if (active >= maxConcurrent) {
      done('busy');
      return rejectAndClose(req, res, 503, { status: 'unavailable', reason: 'busy' }, { 'retry-after': '5' });
    }
    if (!(await ping(clamd))) {
      done('clamav_not_ready');
      return rejectAndClose(req, res, 503, { status: 'unavailable', reason: 'clamav_not_ready' }, { 'retry-after': '10' });
    }

    active++;
    try {
      // 4. Read the body into memory
      const chunks = [];
      let received = 0;
      try {
        for await (const chunk of req) {
          received += chunk.length;
          if (received > maxBytes) {
            done('too_large', received);
            return rejectAndClose(req, res, 413, { status: 'error', reason: 'file_too_large', maxBytes });
          }
          chunks.push(chunk);
        }
      } catch {
        done('aborted', received);
        return send(res, 400, { status: 'error', reason: 'upload_aborted' });
      }
      const body = Buffer.concat(chunks);
      if (body.length === 0) {
        done('empty');
        return send(res, 400, { status: 'error', reason: 'empty_body' });
      }

      // 5. Integrity: the caller states the hash of what it sent
      const digest = sha256(body).toString('hex');
      const claimed = String(req.headers['x-content-sha256'] || '').toLowerCase();
      if (claimed && claimed !== digest) {
        done('hash_mismatch', body.length);
        return send(res, 400, { status: 'error', reason: 'hash_mismatch' });
      }

      // 6. Scan
      const result = await scanBuffer(body, { ...clamd, timeoutMs: scanTimeoutMs });
      const base = { engine: 'ClamAV', engineVersion: (await engineVersion()) ?? undefined, sha256: digest, scannedBytes: body.length };

      switch (result.state) {
        case 'clean':
          done('clean', body.length);
          return send(res, 200, { status: 'clean', ...base });
        case 'blocked':
          done('blocked', body.length, { signature: result.signature });
          return send(res, 200, { status: 'blocked', signature: result.signature, ...base });
        case 'unavailable':
          done('unavailable', body.length);
          return send(res, 503, { status: 'unavailable', reason: 'clamav_unreachable' }, { 'retry-after': '10' });
        default:
          done('error', body.length, { detail: result.detail });
          return send(res, 502, { status: 'error', reason: result.detail?.includes('did not answer') ? 'scan_timeout' : 'scan_failed' });
      }
    } catch {
      done('exception');
      return send(res, 500, { status: 'error', reason: 'internal_error' });
    } finally {
      active--;
    }
  }

  return http.createServer(async (req, res) => {
    const requestId = crypto.randomUUID();
    let path;
    try {
      path = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
      return send(res, 400, { status: 'error', reason: 'bad_request' });
    }

    try {
      if (path === '/health') {
        if (req.method !== 'GET') return send(res, 405, { status: 'error', reason: 'method_not_allowed' }, { allow: 'GET' });
        return send(res, 200, { status: 'ok' });
      }
      if (path === '/ready') {
        if (req.method !== 'GET') return send(res, 405, { status: 'error', reason: 'method_not_allowed' }, { allow: 'GET' });
        if (await ping(clamd)) return send(res, 200, { status: 'ready', engine: 'ClamAV', engineVersion: (await engineVersion()) ?? undefined });
        return send(res, 503, { status: 'unavailable', reason: 'clamav_not_ready' }, { 'retry-after': '10' });
      }
      if (path === '/scan') {
        if (req.method !== 'POST') return send(res, 405, { status: 'error', reason: 'method_not_allowed' }, { allow: 'POST' });
        return await handleScan(req, res, requestId);
      }
      return send(res, 404, { status: 'error', reason: 'not_found' });
    } catch {
      return send(res, 500, { status: 'error', reason: 'internal_error' });
    }
  });
}
