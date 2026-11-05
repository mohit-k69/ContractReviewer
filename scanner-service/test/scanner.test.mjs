import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScannerServer } from '../src/app.mjs';
import { closedPort, EICAR, startFakeClamd } from './fakeClamd.mjs';

const TOKEN = 'test-token-0123456789-abcdefghij';
const here = path.dirname(fileURLToPath(import.meta.url));

async function start(clamdPort, overrides = {}) {
  const logs = [];
  const server = createScannerServer({ token: TOKEN, clamdPort, scanTimeoutMs: 800, log: (e) => logs.push(e), ...overrides });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, logs, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }) };
}
const scan = (base, body, headers = {}) =>
  fetch(`${base}/scan`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, ...headers }, body });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

test.describe('scanner service', () => {
  test('refuses to start without a strong token', () => {
    assert.throws(() => createScannerServer({ token: '' }), /SCAN_TOKEN/);
    assert.throws(() => createScannerServer({ token: 'short' }), /SCAN_TOKEN/);
  });

  test('clean file: ClamAV says OK -> clean, with engine and the hash of the bytes scanned', async () => {
    const clamd = await startFakeClamd();
    const svc = await start(clamd.port);
    try {
      const text = 'An ordinary contract.';
      const res = await scan(svc.base, text);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'clean');
      assert.equal(body.engine, 'ClamAV');
      assert.match(body.engineVersion, /^ClamAV 1\.4/);
      assert.equal(body.sha256, sha(text));
      assert.equal(body.scannedBytes, text.length);
    } finally { await svc.close(); await clamd.close(); }
  });

  test('EICAR test string: ClamAV FOUND -> blocked with the signature', async () => {
    const clamd = await startFakeClamd();
    const svc = await start(clamd.port);
    try {
      const res = await scan(svc.base, EICAR);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.status, 'blocked');
      assert.equal(body.signature, 'Eicar-Test-Signature');
    } finally { await svc.close(); await clamd.close(); }
  });

  test('authentication: missing, wrong or malformed tokens are rejected before the body is scanned', async () => {
    const clamd = await startFakeClamd();
    const svc = await start(clamd.port);
    try {
      for (const headers of [{}, { authorization: 'Bearer wrong-token-wrong-token-wrong' }, { authorization: 'Basic abc' }, { authorization: TOKEN }]) {
        const res = await fetch(`${svc.base}/scan`, { method: 'POST', headers, body: 'x' });
        assert.equal(res.status, 401);
        assert.equal((await res.json()).status, 'error');
      }
      assert.equal(clamd.seen.scans, 0, 'nothing reached ClamAV');
    } finally { await svc.close(); await clamd.close(); }
  });

  test('size limit: a declared or actual body over the limit is rejected with 413', async () => {
    const clamd = await startFakeClamd();
    const svc = await start(clamd.port, { maxBytes: 1024 });
    try {
      const res = await scan(svc.base, Buffer.alloc(4096, 97));
      assert.equal(res.status, 413);
      assert.equal(clamd.seen.scans, 0);
      const ok = await scan(svc.base, Buffer.alloc(512, 97));
      assert.equal(ok.status, 200);
    } finally { await svc.close(); await clamd.close(); }
  });

  test('the limit matches the application (20 MB) by default', () => {
    const src = fs.readFileSync(path.join(here, '../src/app.mjs'), 'utf8');
    assert.match(src, /maxBytes = 20 \* 1024 \* 1024/);
  });

  test('ClamAV not ready (down): /ready and /scan say unavailable and never clean', async () => {
    const svc = await start(await closedPort());
    try {
      assert.equal((await fetch(`${svc.base}/health`)).status, 200, 'the process itself is alive');
      const ready = await fetch(`${svc.base}/ready`);
      assert.equal(ready.status, 503);
      assert.equal((await ready.json()).status, 'unavailable');
      const res = await scan(svc.base, 'anything');
      assert.equal(res.status, 503);
      assert.equal((await res.json()).status, 'unavailable');
    } finally { await svc.close(); }
  });

  test('ready only when ClamAV answers', async () => {
    const clamd = await startFakeClamd();
    const svc = await start(clamd.port);
    try {
      const ready = await fetch(`${svc.base}/ready`);
      assert.equal(ready.status, 200);
      assert.equal((await ready.json()).status, 'ready');
    } finally { await svc.close(); await clamd.close(); }
  });

  test('a ClamAV that hangs times out as an error, never clean', async () => {
    const clamd = await startFakeClamd({ mode: 'hang' });
    // hang mode never answers PING either, so use a fake that answers PING but hangs on the scan
    await clamd.close();
    const net = await import('node:net');
    const server = net.createServer((s) => {
      s.on('error', () => {});
      let buf = Buffer.alloc(0);
      s.on('data', (c) => { buf = Buffer.concat([buf, c]); if (buf.toString('latin1').startsWith('zPING')) s.end('PONG\0'); });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const svc = await start(server.address().port, { scanTimeoutMs: 300 });
    try {
      const res = await scan(svc.base, 'text');
      const body = await res.json();
      assert.equal(res.status, 502);
      assert.equal(body.status, 'error');
      assert.equal(body.reason, 'scan_timeout');
    } finally { await svc.close(); server.close(); server.closeAllConnections?.(); }
  });

  test('malformed, error-banner and empty ClamAV answers are errors, never clean', async () => {
    for (const mode of ['garbage', 'error-banner', 'truncated']) {
      const clamd = await startFakeClamd({ mode });
      const svc = await start(clamd.port);
      try {
        const res = await scan(svc.base, 'text');
        const body = await res.json();
        assert.equal(body.status, 'error', mode);
        assert.notEqual(res.status, 200, mode);
      } finally { await svc.close(); await clamd.close(); }
    }
  });

  test('a body that does not match the stated hash is rejected', async () => {
    const clamd = await startFakeClamd();
    const svc = await start(clamd.port);
    try {
      const res = await scan(svc.base, 'actual bytes', { 'x-content-sha256': sha('different bytes') });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).reason, 'hash_mismatch');
      assert.equal(clamd.seen.scans, 0);
    } finally { await svc.close(); await clamd.close(); }
  });

  test('empty body, unknown routes and wrong methods', async () => {
    const clamd = await startFakeClamd();
    const svc = await start(clamd.port);
    try {
      assert.equal((await scan(svc.base, '')).status, 400);
      assert.equal((await fetch(`${svc.base}/nope`)).status, 404);
      assert.equal((await fetch(`${svc.base}/scan`)).status, 405);
    } finally { await svc.close(); await clamd.close(); }
  });

  test('too many concurrent scans are turned away as unavailable (not queued unbounded)', async () => {
    const clamd = await startFakeClamd();
    const svc = await start(clamd.port, { maxConcurrent: 0 });
    try {
      const res = await scan(svc.base, 'x');
      assert.equal(res.status, 503);
      assert.equal((await res.json()).reason, 'busy');
    } finally { await svc.close(); await clamd.close(); }
  });

  test('document contents, names and the token are never logged', async () => {
    const clamd = await startFakeClamd();
    const svc = await start(clamd.port);
    const captured = [];
    const realLog = console.log;
    console.log = (...a) => captured.push(a.join(' '));
    try {
      const secretText = 'TOP-SECRET-CLAUSE-the-client-owes-us-nine-million';
      await scan(svc.base, secretText, { 'x-filename': 'confidential-deal.pdf' });
      await fetch(`${svc.base}/scan`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: secretText });
      const everything = JSON.stringify(svc.logs) + captured.join('\n');
      assert.ok(svc.logs.length >= 2, 'requests are logged (outcome, size, duration)');
      for (const forbidden of [secretText, 'confidential-deal', TOKEN, 'nope']) assert.ok(!everything.includes(forbidden), `leaked: ${forbidden}`);
    } finally { console.log = realLog; await svc.close(); await clamd.close(); }
  });

  test('no document is written to disk and no network port other than the API is opened', () => {
    for (const file of ['app.mjs', 'clamd.mjs', 'server.mjs']) {
      const src = fs.readFileSync(path.join(here, '../src', file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      assert.ok(!/node:fs|writeFile|createWriteStream|tmpdir|mkdtemp/.test(src), `${file} must not touch the filesystem`);
    }
    const clamd = fs.readFileSync(path.join(here, '../src/clamd.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.ok(!/\.listen\(/.test(clamd), 'the ClamAV client never listens on a port');
  });

  test('both Cloud Run definitions keep ClamAV private, gate the API on ClamAV, and use a dedicated identity and Secret Manager', () => {
    for (const file of ['service.yaml', 'service.preview.yaml']) {
      const yaml = fs.readFileSync(path.join(here, '..', file), 'utf8');
      const code = yaml.replace(/^\s*#.*$/gm, '');
      const clamav = code.slice(code.indexOf('- name: clamav'));
      assert.ok(!/\bports:/.test(clamav), `${file}: the ClamAV sidecar must declare no ports`);
      assert.equal((code.match(/containerPort:/g) || []).length, 1, `${file}: exactly one published port (the API)`);
      assert.match(code, /containerPort: 8080/);
      assert.match(code, /container-dependencies.*scanner-api.*clamav/);
      assert.match(code, /path: \/ready/);
      assert.match(code, /secretKeyRef:/);
      assert.ok(!/SCAN_TOKEN\s*\n\s*value:/.test(code), `${file}: the token comes from Secret Manager, not a literal`);
      assert.match(code, /serviceAccountName: contract-scanner-sa@__PROJECT_ID__\.iam\.gserviceaccount\.com/, `${file}: dedicated service account`);
      assert.ok(!/compute@developer/.test(code), `${file}: must not use the default Compute Engine account`);
      assert.match(code, /memory: 4Gi/, `${file}: ClamAV keeps 4 GiB in every configuration`);
      assert.match(code, /MAX_UPLOAD_BYTES\s*\n\s*value: "20971520"/);
      assert.match(code, /maxScale/, `${file}: bounded scale`);
      assert.match(code, /image: __REGION__-docker\.pkg\.dev\/__PROJECT_ID__\//, `${file}: images come from your Artifact Registry`);
      assert.ok(!/image: (docker\.io|clamav\/)/.test(code), `${file}: no direct Docker Hub image`);
      assert.ok(!/allUsers/.test(code), `${file}: public invoker access is granted explicitly, not hidden in YAML`);
    }
  });

  test('production is always ready; preview scales to zero; the access model is documented', () => {
    const prod = fs.readFileSync(path.join(here, '../service.yaml'), 'utf8').replace(/^\s*#.*$/gm, '');
    const preview = fs.readFileSync(path.join(here, '../service.preview.yaml'), 'utf8').replace(/^\s*#.*$/gm, '');
    assert.match(prod, /minScale": ?"1"|minScale: "1"/);
    assert.match(prod, /cpu-throttling: "false"/);
    assert.match(preview, /minScale: "0"/);
    assert.match(preview, /cpu-throttling: "true"/);
    assert.match(prod, /name: contract-scanner\n/);
    assert.match(preview, /name: contract-scanner-preview\n/);
    assert.match(prod, /name: contract-scanner-token(?!-)/);
    assert.match(preview, /name: contract-scanner-token-preview/, 'preview uses its own secret');
    const readme = fs.readFileSync(path.join(here, '../README.md'), 'utf8');
    for (const must of ['roles/run.invoker', 'roles/secretmanager.secretAccessor', 'EICAR', 'invoker-iam-disabled', 'CLAMAV_SCAN_URL', 'CLAMAV_SCAN_TOKEN']) {
      assert.ok(readme.includes(must), `README must cover ${must}`);
    }
  });
});
