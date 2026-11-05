import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {
  createSignedSessionToken,
  verifySessionToken,
  verifyOriginProtection,
  rateLimitSessionIssuance,
  COOKIE_NAME,
} from './sessionAuth';
import {
  storeInQuarantine,
  reconcileQuarantineOnStartup,
  getCleanupFailures,
  QUARANTINE_DIR,
  ORPHAN_MAX_AGE_MS,
  sweepStaleFiles,
  hasDocumentRecord,
} from './quarantineManager';
import { queryClamAVDaemon } from './malwareScanner';
import {
  uploadResourceGuard,
  getActiveUploadCounts,
  resetResourceLimits,
  MAX_GLOBAL_CONCURRENT_UPLOADS,
  MAX_SESSION_CONCURRENT_UPLOADS,
} from './resourceProtection';

// 1. ClamAV protocol & backpressure test server
async function createTestClamAVServer(handler: (socket: net.Socket, data: Buffer) => void): Promise<{
  host: string;
  port: number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let received = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        received = Buffer.concat([received, chunk]);
        // If final 0-length chunk received
        if (received.length >= 4 && received.subarray(received.length - 4).equals(Buffer.from([0, 0, 0, 0]))) {
          handler(socket, received);
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        host: '127.0.0.1',
        port: addr.port,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

test('ClamAV: strictly accepts exact valid clean response', async () => {
  const server = await createTestClamAVServer((socket) => {
    socket.write('stream: OK\0');
    socket.end();
  });
  try {
    const res = await queryClamAVDaemon(Buffer.from('clean contract data'), server.host, server.port);
    assert.equal(res.scanned, true);
    assert.equal(res.threat, undefined);
  } finally {
    await server.close();
  }
});

test('ClamAV: strictly accepts exact threat found response', async () => {
  const server = await createTestClamAVServer((socket) => {
    socket.write('stream: Win.Test.EICAR_HDB-1 FOUND\0');
    socket.end();
  });
  try {
    const res = await queryClamAVDaemon(Buffer.from('eicar file data'), server.host, server.port);
    assert.equal(res.scanned, true);
    assert.equal(res.threat, 'Win.Test.EICAR_HDB-1');
  } finally {
    await server.close();
  }
});

test('ClamAV: rejects malformed or unexpected responses (e.g. error banner or unexpected string)', async () => {
  const server = await createTestClamAVServer((socket) => {
    socket.write('stream: UNKNOWN SCAN ERROR 500\0');
    socket.end();
  });
  try {
    const res = await queryClamAVDaemon(Buffer.from('some data'), server.host, server.port);
    assert.equal(res.scanned, false);
    assert.match(res.error || '', /malformed, incomplete or unexpected/);
  } finally {
    await server.close();
  }
});

test('ClamAV: handles socket streaming and backpressure with large buffer', async () => {
  const largeBuffer = Buffer.alloc(100 * 1024, 'B'); // 100 KB streamed in 2KB chunks
  let receivedBytes = 0;

  const server = await createTestClamAVServer((socket, data) => {
    receivedBytes = data.length;
    socket.write('stream: OK\0');
    socket.end();
  });
  try {
    const res = await queryClamAVDaemon(largeBuffer, server.host, server.port);
    assert.equal(res.scanned, true);
    assert.ok(receivedBytes > 100 * 1024);
  } finally {
    await server.close();
  }
});

// 2. Quarantine: nothing survives a restart, and debris is swept
test('Quarantine: startup deletes every leftover document and restores nothing', () => {
  const live = storeInQuarantine(Buffer.from('fresh contract'), 'new.txt', 'text/plain', 'test-sess-a');
  const old = storeInQuarantine(Buffer.from('older contract'), 'old.txt', 'text/plain', 'test-sess-b');
  for (const f of [live, old]) {
    assert.ok(fs.existsSync(f.filePath));
    assert.ok(fs.existsSync(path.join(QUARANTINE_DIR, `${f.fileId}.meta.json`)));
  }

  const result = reconcileQuarantineOnStartup();
  assert.ok(result.purged >= 4, 'both payloads and both metadata files are deleted');
  assert.equal(result.restored, 0, 'documents are never restored');
  for (const f of [live, old]) {
    assert.equal(fs.existsSync(f.filePath), false);
    assert.equal(fs.existsSync(path.join(QUARANTINE_DIR, `${f.fileId}.meta.json`)), false);
  }
});

test('Quarantine: the safety-net sweep removes only debris older than the orphan age limit', () => {
  const { fileId, filePath } = storeInQuarantine(Buffer.from('stuck contract'), 'stuck.txt', 'text/plain', 'test-sess-c');
  const metaPath = path.join(QUARANTINE_DIR, `${fileId}.meta.json`);
  assert.equal(sweepStaleFiles(), 0, 'a file from a request that is still running is left alone');
  assert.ok(fs.existsSync(filePath));

  const removed = sweepStaleFiles(Date.now() + ORPHAN_MAX_AGE_MS + 60 * 1000);
  assert.ok(removed >= 2);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.existsSync(metaPath), false);
  assert.equal(hasDocumentRecord(fileId), false, 'the in-memory record is gone too');
});

// 2b. storeInQuarantine is atomic from a cleanup perspective
const quarantineLeftovers = (): string[] =>
  fs.readdirSync(QUARANTINE_DIR).filter((f) => f.endsWith('.quarantine') || f.endsWith('.meta.json'));

/** Makes fs.writeFileSync fail for files matching `failOn`, after delegating earlier writes to the real function. */
function failWritesTo(failOn: RegExp, error: Error) {
  const real = fs.writeFileSync;
  const written: string[] = [];
  const spy = mock.method(fs, 'writeFileSync', (file: any, ...rest: any[]) => {
    written.push(String(file));
    if (failOn.test(String(file))) throw error;
    return (real as any)(file, ...rest);
  });
  return { spy, written, restore: () => spy.mock.restore() };
}

test('storeInQuarantine: a metadata-write failure removes the already-written upload, leaves no registry entry, and rethrows the original error', () => {
  const before = quarantineLeftovers();
  const original = new Error('ENOSPC: no space left on device (simulated metadata write)');
  const sim = failWritesTo(/\.meta\.json$/, original);
  let thrown: unknown;
  try {
    storeInQuarantine(Buffer.from('contract that must not be left behind'), 'c.txt', 'text/plain', 'atomic-sess-1');
  } catch (err) {
    thrown = err;
  } finally {
    sim.restore();
  }

  assert.equal(thrown, original, 'the ORIGINAL error is rethrown, not a cleanup error');
  // The payload really had been written before the metadata write failed
  assert.equal(sim.written.length, 2);
  assert.match(sim.written[0], /\.quarantine$/);
  assert.match(sim.written[1], /\.meta\.json$/);
  const fileId = path.basename(sim.written[0]).replace('.quarantine', '');

  assert.equal(fs.existsSync(path.join(QUARANTINE_DIR, `${fileId}.quarantine`)), false, 'no quarantine file remains');
  assert.equal(fs.existsSync(path.join(QUARANTINE_DIR, `${fileId}.meta.json`)), false, 'no metadata file remains');
  assert.equal(hasDocumentRecord(fileId), false, 'no registry entry remains');
  assert.deepEqual(quarantineLeftovers().filter((f) => !before.includes(f)), [], 'nothing new on disk at all');
});

test('storeInQuarantine: a failing upload write (possibly partial) leaves nothing behind', () => {
  const before = quarantineLeftovers();
  const original = new Error('EIO: simulated payload write failure');
  const real = fs.writeFileSync;
  // Simulate a PARTIAL write: some bytes reach the disk, then the write fails
  const spy = mock.method(fs, 'writeFileSync', (file: any, data: any, ...rest: any[]) => {
    if (/\.quarantine$/.test(String(file))) {
      (real as any)(file, 'partial', ...rest);
      throw original;
    }
    return (real as any)(file, data, ...rest);
  });
  try {
    assert.throws(() => storeInQuarantine(Buffer.from('another contract'), 'c.txt', 'text/plain', 'atomic-sess-2'), (e) => e === original);
  } finally {
    spy.mock.restore();
  }
  assert.deepEqual(quarantineLeftovers().filter((f) => !before.includes(f)), []);
});

test('storeInQuarantine: if the cleanup itself fails, the original error is still the one thrown and the failure is recorded', () => {
  const before = quarantineLeftovers();
  const failuresBefore = getCleanupFailures().length;
  const original = new Error('simulated metadata write failure');
  const sim = failWritesTo(/\.meta\.json$/, original);
  const realRm = fs.rmSync;
  const rm = mock.method(fs, 'rmSync', () => {
    throw new Error('EBUSY: simulated cleanup failure');
  });
  try {
    assert.throws(() => storeInQuarantine(Buffer.from('stuck contract'), 'c.txt', 'text/plain', 'atomic-sess-3'), (e) => e === original);
  } finally {
    rm.mock.restore();
    sim.restore();
  }
  const fileId = path.basename(sim.written[0]).replace('.quarantine', '');
  assert.equal(hasDocumentRecord(fileId), false, 'the registry entry is removed even when file cleanup fails');
  assert.ok(getCleanupFailures().length > failuresBefore, 'the cleanup failure is recorded for the sweeper');
  // The stuck file is what the safety-net sweep exists for
  assert.ok(sweepStaleFiles(Date.now() + ORPHAN_MAX_AGE_MS + 60_000) >= 1);
  assert.deepEqual(quarantineLeftovers().filter((f) => !before.includes(f)), []);
  void realRm;
});

test('storeInQuarantine: the normal path is unchanged (payload, metadata and registry entry all exist)', async () => {
  const { fileId, filePath } = storeInQuarantine(Buffer.from('normal contract'), 'ok.txt', 'text/plain', 'atomic-sess-4');
  try {
    assert.ok(fs.existsSync(filePath));
    assert.ok(fs.existsSync(path.join(QUARANTINE_DIR, `${fileId}.meta.json`)));
    assert.equal(hasDocumentRecord(fileId), true);
  } finally {
    const { deleteQuarantinedFile } = await import('./quarantineManager');
    assert.equal(deleteQuarantinedFile(fileId, 'atomic-sess-4').success, true);
  }
  assert.equal(hasDocumentRecord(fileId), false);
});

// 3. CSRF / Origin protection
test('CSRF: rejects state-changing requests when Origin does not match Host', () => {
  let blocked = false;
  let status = 0;

  const req: any = {
    method: 'POST',
    headers: {
      origin: 'https://malicious-site.com',
      host: 'localhost:3000',
    },
  };
  const res: any = {
    status: (code: number) => {
      status = code;
      return {
        json: () => {
          blocked = true;
        },
      };
    },
  };
  const next = () => {};

  verifyOriginProtection(req, res, next);
  assert.equal(blocked, true);
  assert.equal(status, 403);
});

test('CSRF: allows requests when Origin matches Host', () => {
  let passed = false;
  const req: any = {
    method: 'POST',
    headers: {
      origin: 'http://localhost:3000',
      host: 'localhost:3000',
    },
  };
  const res: any = {};
  const next = () => {
    passed = true;
  };

  verifyOriginProtection(req, res, next);
  assert.equal(passed, true);
});

// 4. Session issuance rate limiting
test('Session: rate-limits excessive session creation requests from single IP', () => {
  let rejectedCount = 0;

  for (let i = 0; i < 15; i++) {
    const req: any = {
      headers: { 'x-forwarded-for': '192.168.1.100' },
      socket: {},
    };
    let status = 0;
    const res: any = {
      status: (code: number) => {
        status = code;
        return { json: () => {} };
      },
    };
    let calledNext = false;
    const next = () => {
      calledNext = true;
    };

    rateLimitSessionIssuance(req, res, next);
    if (status === 429) rejectedCount++;
  }

  assert.equal(rejectedCount >= 5, true);
});

// 5. Upload resource protection & concurrency limits
test('ResourceProtection: enforces global and per-session concurrency limits', () => {
  resetResourceLimits();

  const req: any = {
    verifiedSession: { sessionId: 'heavy-session' },
    setTimeout: () => {},
  };
  let statusCode = 0;
  const res: any = {
    status: (code: number) => {
      statusCode = code;
      return { json: () => {} };
    },
    on: () => {},
  };

  // Upload 1: OK
  uploadResourceGuard(req, res, () => {});
  assert.equal(statusCode, 0);

  // Upload 2: OK
  uploadResourceGuard(req, res, () => {});
  assert.equal(statusCode, 0);

  // Upload 3 for same session: Exceeds MAX_SESSION_CONCURRENT_UPLOADS (2) -> 429 Too Many Requests
  uploadResourceGuard(req, res, () => {});
  assert.equal(statusCode, 429);
});
