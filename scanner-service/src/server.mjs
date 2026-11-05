import { createScannerServer } from './app.mjs';
import { ping } from './clamd.mjs';

const num = (name, fallback) => {
  const v = process.env[name];
  const n = v === undefined || v === '' ? fallback : Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number.`);
  return n;
};

let server;
try {
  server = createScannerServer({
    token: process.env.SCAN_TOKEN ?? '', // refuses to start without a strong token (fail-closed)
    clamdHost: process.env.CLAMD_HOST || '127.0.0.1',
    clamdPort: num('CLAMD_PORT', 3310),
    maxBytes: num('MAX_UPLOAD_BYTES', 20 * 1024 * 1024),
    scanTimeoutMs: num('SCAN_TIMEOUT_MS', 20000),
    maxConcurrent: num('MAX_CONCURRENT_SCANS', 4),
  });
} catch (err) {
  console.error(JSON.stringify({ event: 'fatal', message: err.message }));
  process.exit(1);
}

const port = num('PORT', 8080);
server.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'listening', port }));
  // Report ClamAV readiness while it loads its signatures. /scan answers 503 until it is ready.
  const watch = setInterval(async () => {
    if (await ping({ host: process.env.CLAMD_HOST || '127.0.0.1', port: num('CLAMD_PORT', 3310) })) {
      console.log(JSON.stringify({ event: 'clamav_ready' }));
      clearInterval(watch);
    }
  }, 5000);
  watch.unref();
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
