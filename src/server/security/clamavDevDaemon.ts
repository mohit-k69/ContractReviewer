import net from 'node:net';
import { registerDemoEndpoint, unregisterDemoEndpoint } from './scannerConfig';

/**
 * Embedded DEMO scanner for local development and automated tests ONLY.
 *
 * It speaks the ClamAV zINSTREAM protocol so the rest of the pipeline can be exercised, but it is NOT antivirus:
 * it recognises two test strings and answers "OK" for everything else. Every endpoint it opens is registered as a
 * demo endpoint, so the scanner reports it as non-genuine, and it is refused outright on Vercel and in production
 * (see scannerConfig.ts). It must never be started there.
 */
export async function startClamAvDevDaemon(): Promise<{ host: string; port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let received = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        if (socket.writableEnded) return;
        received = Buffer.concat([received, chunk]);
        // ClamAV zINSTREAM protocol ends with 4-byte zero length chunk [0, 0, 0, 0]
        if (
          received.length >= 4 &&
          received.subarray(received.length - 4).equals(Buffer.from([0, 0, 0, 0]))
        ) {
          const payloadStr = received.toString('latin1');
          if (
            payloadStr.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ||
            payloadStr.includes('This program cannot be run in DOS mode')
          ) {
            socket.write('stream: Win.Test.EICAR FOUND\0');
          } else {
            socket.write('stream: OK\0');
          }
          socket.end();
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      registerDemoEndpoint('127.0.0.1', addr.port);
      resolve({
        host: '127.0.0.1',
        port: addr.port,
        close: () => {
          unregisterDemoEndpoint('127.0.0.1', addr.port);
          return new Promise((res) => server.close(() => res()));
        },
      });
    });
  });
}
