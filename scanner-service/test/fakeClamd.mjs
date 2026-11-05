import net from 'node:net';

/**
 * A ClamAV protocol TEST DOUBLE (PING / VERSION / INSTREAM). It is not antivirus: it flags the EICAR test string
 * so that the service's handling of "FOUND" answers can be exercised. Real ClamAV is checked by scripts/smoke.sh.
 * modes: 'ok' | 'hang' | 'garbage' | 'error-banner' | 'truncated'
 */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export async function startFakeClamd({ mode = 'ok' } = {}) {
  const seen = { scans: 0 };
  const server = net.createServer((socket) => {
    let received = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.subarray(0, 6).toString() === 'zPING\0' || received.toString().startsWith('zPING')) {
        socket.end(mode === 'hang' ? undefined : 'PONG\0');
        if (mode === 'hang') return;
        return;
      }
      if (received.toString('latin1').startsWith('zVERSION')) {
        socket.end('ClamAV 1.4.2/27000/Tue Nov  4 08:25:11 2025\0');
        return;
      }
      if (received.toString('latin1').startsWith('zINSTREAM\0') && received.subarray(received.length - 4).equals(Buffer.alloc(4))) {
        seen.scans++;
        if (mode === 'hang') return; // never answers
        if (mode === 'garbage') return socket.end('what is this\0');
        if (mode === 'error-banner') return socket.end('INSTREAM size limit exceeded. ERROR\0');
        if (mode === 'truncated') return socket.end('');
        const body = received.toString('latin1');
        socket.end(body.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }) };
}

/** A port nothing listens on (clamd "down"). */
export async function closedPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
