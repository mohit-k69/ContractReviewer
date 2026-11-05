import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { AddressInfo } from 'node:net';
// The real scanning-service code (scanner-service/) is exercised here, with a ClamAV protocol test double behind it.
import { createScannerServer } from '../../../scanner-service/src/app.mjs';
import { closedPort, EICAR, startFakeClamd } from '../../../scanner-service/test/fakeClamd.mjs';
import { runSecurityInspectionPipeline } from './pipeline';
import { scanForMalware } from './malwareScanner';
import { scanViaService, validateScanUrl } from './clamavServiceClient';
import { demoScannerAllowed, scannerMode } from './scannerConfig';
import { startClamAvDevDaemon } from './clamavDevDaemon';

const TOKEN = 'integration-token-0123456789-abcdef';
const CONTRACT = Buffer.from('Independent Contractor Agreement\nSection 1. Services. Contractor shall provide design services.\n');

async function withService<T>(run: (url: string, clamd: Awaited<ReturnType<typeof startFakeClamd>>) => Promise<T>, clamdPort?: number): Promise<T> {
  const clamd = await startFakeClamd();
  const server = createScannerServer({ token: TOKEN, clamdPort: clamdPort ?? clamd.port, scanTimeoutMs: 1500, log: () => {} });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/scan`;
  try {
    return await run(url, clamd);
  } finally {
    await new Promise<void>((r) => { server.close(() => r()); (server as any).closeAllConnections?.(); });
    await clamd.close();
  }
}

/** A stub service that answers with whatever the test dictates. */
async function stub(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => handler(req, res)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/scan`, close: () => new Promise<void>((r) => { server.close(() => r()); (server as any).closeAllConnections?.(); }) };
}
const json = (res: http.ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

test.describe('scanning service client -> real service code -> ClamAV protocol', () => {
  test('real clean response: genuine, eligible, and reported as clean antivirus', async () => {
    await withService(async (url) => {
      const report = await runSecurityInspectionPipeline(CONTRACT, 'contract.txt', 'text/plain', 'sess', { scanUrl: url, scanToken: TOKEN });
      assert.equal(report.status, 'CLEAN_NO_KNOWN_THREATS');
      assert.equal(report.eligibleForContractProcessing, true);
      assert.equal(report.malware.scannerAvailable, true);
      assert.equal(report.malware.outcome, 'clean');
      assert.equal(report.malware.scanner, 'clamav-service');
      assert.equal(report.malware.genuine, true);
      assert.match(report.malware.engine, /^ClamAV/);
      assert.match(report.statusMessage, /No known threats detected/);
    });
  });

  test('EICAR test file: blocked as a threat, never eligible', async () => {
    await withService(async (url) => {
      const report = await runSecurityInspectionPipeline(Buffer.from(EICAR), 'eicar.txt', 'text/plain', 'sess', { scanUrl: url, scanToken: TOKEN });
      assert.equal(report.status, 'THREAT_DETECTED');
      assert.equal(report.eligibleForContractProcessing, false);
      assert.equal(report.malware.outcome, 'threat');
      assert.equal(report.malware.passed, false);
      assert.ok(report.malware.threatsFound.some((t) => /Eicar/i.test(t)));
    });
  });

  test('authentication failure: error, not clean, token not echoed', async () => {
    await withService(async (url) => {
      const report = await runSecurityInspectionPipeline(CONTRACT, 'contract.txt', 'text/plain', 'sess', { scanUrl: url, scanToken: 'wrong-wrong-wrong-wrong-wrong-1' });
      assert.equal(report.status, 'SCAN_FAILED');
      assert.equal(report.eligibleForContractProcessing, false);
      assert.equal(report.malware.scannerAvailable, false);
      assert.equal(report.malware.outcome, 'error');
      assert.match(report.statusMessage, /rejected this application’s credentials/);
      assert.ok(!JSON.stringify(report).includes('wrong-wrong'));
    });
  });

  test('scanner timeout: error, not clean', async () => {
    const hang = await stub(() => { /* never answers */ });
    try {
      const r = await scanViaService(CONTRACT, { url: hang.url, token: TOKEN, timeoutMs: 300 });
      assert.equal(r.outcome, 'error');
      assert.match(r.message, /did not finish/);
    } finally { await hang.close(); }
  });

  test('service unreachable: unavailable, not clean', async () => {
    const port = await closedPort();
    const report = await runSecurityInspectionPipeline(CONTRACT, 'contract.txt', 'text/plain', 'sess', { scanUrl: `http://127.0.0.1:${port}/scan`, scanToken: TOKEN });
    assert.equal(report.status, 'UNAVAILABLE');
    assert.equal(report.eligibleForContractProcessing, false);
    assert.equal(report.malware.scannerAvailable, false);
  });

  test('ClamAV down behind a running service: unavailable, not clean', async () => {
    const down = await closedPort();
    await withService(async (url) => {
      const report = await runSecurityInspectionPipeline(CONTRACT, 'contract.txt', 'text/plain', 'sess', { scanUrl: url, scanToken: TOKEN });
      assert.equal(report.status, 'UNAVAILABLE');
      assert.equal(report.malware.outcome, 'unavailable');
      assert.equal(report.eligibleForContractProcessing, false);
    }, down);
  });

  test('malformed or untrustworthy answers are errors, never clean', async () => {
    const digest = (await import('node:crypto')).createHash('sha256').update(CONTRACT).digest('hex');
    const cases: Array<[string, (res: http.ServerResponse) => void]> = [
      ['not JSON', (res) => json(res, 200, 'clean!')],
      ['empty body', (res) => json(res, 200, '')],
      ['JSON array', (res) => json(res, 200, '[]')],
      ['no status', (res) => json(res, 200, { engine: 'ClamAV', sha256: digest })],
      ['unknown status', (res) => json(res, 200, { status: 'probably-fine', engine: 'ClamAV', sha256: digest })],
      ['clean without an engine', (res) => json(res, 200, { status: 'clean', sha256: digest })],
      ['clean from a non-ClamAV engine', (res) => json(res, 200, { status: 'clean', engine: 'TotallyReal AV', sha256: digest })],
      ['clean about different bytes', (res) => json(res, 200, { status: 'clean', engine: 'ClamAV', sha256: 'f'.repeat(64) })],
      ['clean with a 500', (res) => json(res, 500, { status: 'clean', engine: 'ClamAV', sha256: digest })],
      ['service-side error', (res) => json(res, 502, { status: 'error', reason: 'scan_failed' })],
      ['oversized response', (res) => json(res, 200, 'x'.repeat(200 * 1024))],
    ];
    for (const [name, answer] of cases) {
      const s = await stub((_req, res) => answer(res));
      try {
        const r = await scanViaService(CONTRACT, { url: s.url, token: TOKEN });
        assert.equal(r.outcome, 'error', name);
      } finally { await s.close(); }
    }
  });

  test('a service-reported "unavailable" and HTTP 503/429 are unavailable', async () => {
    for (const [code, body] of [[503, { status: 'unavailable', reason: 'clamav_not_ready' }], [429, {}], [200, { status: 'unavailable' }]] as const) {
      const s = await stub((_req, res) => json(res, code, body));
      try { assert.equal((await scanViaService(CONTRACT, { url: s.url, token: TOKEN })).outcome, 'unavailable', String(code)); } finally { await s.close(); }
    }
  });

  test('a redirect is never followed (the token cannot be forwarded elsewhere)', async () => {
    let followed = false;
    const target = await stub(() => { followed = true; });
    const redirector = await stub((_req, res) => { res.writeHead(307, { location: target.url }); res.end(); });
    try {
      const r = await scanViaService(CONTRACT, { url: redirector.url, token: TOKEN });
      assert.notEqual(r.outcome, 'clean');
      assert.equal(followed, false);
    } finally { await redirector.close(); await target.close(); }
  });

  test('the URL must be HTTPS (plain HTTP only for localhost) and a token is required', async () => {
    assert.equal(validateScanUrl('https://scanner.example.run.app/scan').ok, true);
    assert.equal(validateScanUrl('http://127.0.0.1:8080/scan').ok, true);
    for (const bad of ['http://scanner.example.com/scan', 'ftp://x/scan', 'not a url', '']) assert.equal(validateScanUrl(bad).ok, false, bad);
    const insecure = await scanViaService(CONTRACT, { url: 'http://scanner.example.com/scan', token: TOKEN });
    assert.equal(insecure.outcome, 'error');
    assert.match(insecure.message, /https/);
    assert.equal((await scanViaService(CONTRACT, { url: 'https://scanner.example.com/scan', token: '' })).outcome, 'error');
  });

  test('the bearer token is sent only in the Authorization header, over a body that is the file', async () => {
    let seen: http.IncomingHttpHeaders = {};
    let size = 0;
    const server = http.createServer((req, res) => { seen = req.headers; req.on('data', (c) => (size += c.length)); req.on('end', () => json(res, 200, { status: 'error' })); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      await scanViaService(CONTRACT, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/scan`, token: TOKEN });
      assert.equal(seen.authorization, `Bearer ${TOKEN}`);
      assert.equal(size, CONTRACT.length);
      assert.match(String(seen['x-content-sha256']), /^[0-9a-f]{64}$/);
    } finally { await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }); }
  });
});

test.describe('no real scanner configured', () => {
  const saved = { ...process.env };
  const reset = () => { for (const k of ['CLAMAV_SCAN_URL', 'CLAMAV_SCAN_TOKEN', 'CLAMAV_HOST', 'CLAMAV_PORT', 'ALLOW_DEMO_SCANNER', 'VERCEL', 'NODE_ENV']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
  test.afterEach(reset);

  test('nothing configured: UNAVAILABLE, scannerAvailable false, not eligible, clear message', async () => {
    reset();
    delete process.env.CLAMAV_SCAN_URL; delete process.env.CLAMAV_HOST;
    assert.equal(scannerMode(), 'none');
    const report = await runSecurityInspectionPipeline(CONTRACT, 'contract.txt', 'text/plain', 'sess');
    assert.equal(report.status, 'UNAVAILABLE');
    assert.equal(report.malware.scannerAvailable, false);
    assert.equal(report.malware.genuine, false);
    assert.equal(report.eligibleForContractProcessing, false);
    assert.match(report.statusMessage, /Security scanning is unavailable/);
    assert.match(report.statusMessage, /not scanned and has not been analysed/);
  });

  test('the demo scanner needs explicit enablement and is refused on Vercel and in production', async () => {
    const demo = await startClamAvDevDaemon();
    try {
      process.env.CLAMAV_HOST = demo.host; process.env.CLAMAV_PORT = String(demo.port);
      assert.equal(scannerMode(), 'demo');

      // Not enabled -> unavailable (even though a socket answers "OK")
      delete process.env.ALLOW_DEMO_SCANNER;
      let r = await scanForMalware(CONTRACT);
      assert.equal(r.outcome, 'unavailable');
      assert.equal(r.scannerAvailable, false);

      // Enabled locally -> usable, but explicitly NOT genuine
      process.env.ALLOW_DEMO_SCANNER = '1';
      assert.equal(demoScannerAllowed(), true);
      r = await scanForMalware(CONTRACT);
      assert.equal(r.outcome, 'clean');
      assert.equal(r.scanner, 'demo');
      assert.equal(r.genuine, false);
      assert.match(r.details.join(' '), /not antivirus/i);
      const report = await runSecurityInspectionPipeline(CONTRACT, 'contract.txt', 'text/plain', 'sess');
      assert.equal(report.malware.genuine, false);
      assert.match(report.statusMessage, /DEMO SCANNER ONLY/);

      // Enabled but on Vercel / production -> refused
      for (const env of [{ VERCEL: '1' }, { NODE_ENV: 'production' }]) {
        Object.assign(process.env, env);
        assert.equal(demoScannerAllowed(), false);
        const blocked = await runSecurityInspectionPipeline(CONTRACT, 'contract.txt', 'text/plain', 'sess');
        assert.equal(blocked.status, 'UNAVAILABLE', JSON.stringify(env));
        assert.equal(blocked.eligibleForContractProcessing, false);
        delete process.env.VERCEL; process.env.NODE_ENV = saved.NODE_ENV ?? ''; if (!saved.NODE_ENV) delete process.env.NODE_ENV;
      }
    } finally { await demo.close(); }
  });

  test('a real ClamAV daemon over TCP is genuine; its failure is an error, not clean', async () => {
    const clamd = await startFakeClamd(); // protocol double standing in for clamd
    try {
      // Plain TCP clamd stand-in answering zINSTREAM
      const ok = await scanForMalware(CONTRACT, { clamavHost: '127.0.0.1', clamavPort: clamd.port, timeoutMs: 1500 });
      assert.equal(ok.outcome, 'clean');
      assert.equal(ok.scanner, 'clamav-tcp');
      assert.equal(ok.genuine, true);
    } finally { await clamd.close(); }
    const down = await scanForMalware(CONTRACT, { clamavHost: '127.0.0.1', clamavPort: await closedPort(), timeoutMs: 800 });
    assert.equal(down.outcome, 'error');
    assert.equal(down.scannerAvailable, false);
  });
});

/** Runs the real Vercel handler in a fresh production-like process and returns its summary. */
function probe(env: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.resolve(process.cwd(), 'src/server/vercelUploadProbe.ts')], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'preview', SESSION_SECRET: 'probe-session-secret-0123456789abcdef', ...env },
    });
    let out = ''; let err = '';
    child.stdout.on('data', (c) => (out += c)); child.stderr.on('data', (c) => (err += c));
    const timer = setTimeout(() => { child.kill(); reject(new Error(`probe timed out\n${err}`)); }, 90000);
    child.on('exit', () => {
      clearTimeout(timer);
      const line = out.split('\n').find((l) => l.startsWith('PROBE '));
      if (!line) return reject(new Error(`no result\n${out}\n${err}`));
      resolve({ ...JSON.parse(line.slice(6)), logs: `${out}\n${err}` });
    });
  });
}
const SAMPLE = fs.readFileSync(path.resolve(process.cwd(), 'samples', 'risky-freelance-agreement.txt'), 'utf8');

test.describe('Vercel production path (built from the real handler)', () => {
  test('no scanner configured: health says not configured; upload is UNAVAILABLE and nothing is analysed', async () => {
    const r = await probe({ PROBE_FILE_TEXT: SAMPLE });
    assert.deepEqual(r.health.antivirus, { mode: 'none', configured: false, genuine: false });
    assert.equal(r.http, 200);
    assert.equal(r.status, 'UNAVAILABLE');
    assert.equal(r.eligible, false);
    assert.equal(r.malware.scannerAvailable, false);
    assert.equal(r.hasAnalysis, false);
    assert.equal(r.hasExtraction, false);
    assert.equal(r.hasDecisionReport, false);
    assert.match(r.statusMessage, /Security scanning is unavailable/);
    assert.ok(!/DEMO scanner enabled/i.test(r.logs), 'the demo scanner must not start on Vercel');
  });

  test('ALLOW_DEMO_SCANNER=1 does not start the demo scanner on Vercel', async () => {
    const r = await probe({ PROBE_FILE_TEXT: SAMPLE, ALLOW_DEMO_SCANNER: '1' });
    assert.equal(r.health.antivirus.mode, 'none');
    assert.equal(r.status, 'UNAVAILABLE');
    assert.equal(r.hasDecisionReport, false);
  });

  test('with the scanning service: a clean file is analysed (decision report present); EICAR is blocked and not analysed', async () => {
    await withService(async (url) => {
      const env = { CLAMAV_SCAN_URL: url, CLAMAV_SCAN_TOKEN: TOKEN };
      const clean = await probe({ ...env, PROBE_FILE_TEXT: SAMPLE });
      assert.deepEqual(clean.health.antivirus, { mode: 'clamav-service', configured: true, genuine: true });
      assert.equal(clean.status, 'CLEAN_NO_KNOWN_THREATS');
      assert.equal(clean.malware.genuine, true);
      assert.equal(clean.hasDecisionReport, true);

      const eicar = await probe({ ...env, PROBE_FILE_TEXT: EICAR });
      assert.equal(eicar.status, 'THREAT_DETECTED');
      assert.equal(eicar.eligible, false);
      assert.equal(eicar.hasAnalysis, false);
      assert.equal(eicar.hasDecisionReport, false);

      // The token and URL never appear in logs or responses
      for (const r of [clean, eicar]) assert.ok(!r.logs.includes(TOKEN) && !JSON.stringify(r.health).includes('127.0.0.1'));
    });
  });

  test('wrong token on the real path: scan fails, nothing is analysed', async () => {
    await withService(async (url) => {
      const r = await probe({ CLAMAV_SCAN_URL: url, CLAMAV_SCAN_TOKEN: 'not-the-right-token-not-the-right', PROBE_FILE_TEXT: SAMPLE });
      assert.equal(r.status, 'SCAN_FAILED');
      assert.equal(r.eligible, false);
      assert.equal(r.hasDecisionReport, false);
    });
  });
});

test.describe('secrets stay on the server', () => {
  test('the scanner URL and token are not referenced by browser code or the Vite config', () => {
    const roots = ['src/components', 'src/utils', 'src/App.tsx', 'src/main.tsx', 'vite.config.ts', 'index.html'];
    const walk = (p: string): string[] => {
      if (!fs.existsSync(p)) return [];
      if (fs.statSync(p).isFile()) return [p];
      return fs.readdirSync(p).flatMap((f) => walk(path.join(p, f)));
    };
    for (const file of roots.flatMap(walk).filter((f) => !f.endsWith('.test.ts'))) {
      const src = fs.readFileSync(file, 'utf8');
      assert.ok(!/CLAMAV_SCAN_(URL|TOKEN)|VITE_[A-Z_]*(SCAN|CLAMAV)/.test(src), `${file} must not reference scanner secrets`);
    }
  });

  test('a ClamAV TCP endpoint is never part of the public API surface', () => {
    const app = fs.readFileSync(path.resolve(process.cwd(), 'src/server/app.ts'), 'utf8');
    assert.ok(!/CLAMAV_HOST/.test(app.slice(app.indexOf('/api/health'), app.indexOf('/api/auth/session'))), 'health must not reveal scanner hosts');
  });
});
