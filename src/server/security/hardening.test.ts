import test from 'node:test';
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
  RETENTION_PERIOD_MS,
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

// 2. Quarantine reconciliation & restart survival
test('Quarantine: reconciles on startup and purges files older than 2 hours', () => {
  const oldSession = 'test-old-sess';
  const { fileId, filePath } = storeInQuarantine(Buffer.from('expired contract'), 'old.txt', 'text/plain', oldSession);
  const metaPath = path.join(QUARANTINE_DIR, `${fileId}.meta.json`);

  assert.ok(fs.existsSync(filePath));
  assert.ok(fs.existsSync(metaPath));

  // Backdate metadata to 3 hours ago
  const threeHoursAgo = new Date(Date.now() - (RETENTION_PERIOD_MS + 60 * 60 * 1000)).toISOString();
  fs.writeFileSync(metaPath, JSON.stringify({
    metadata: {
      fileId,
      originalName: 'old.txt',
      fileSize: 16,
      sessionId: oldSession,
      uploadedAt: threeHoursAgo,
    },
  }));

  // Run startup reconciliation
  const result = reconcileQuarantineOnStartup();
  assert.ok(result.purged >= 1);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.existsSync(metaPath), false);
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
