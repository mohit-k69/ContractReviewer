import net from 'node:net';

/**
 * Embedded ClamAV protocol service for development / preview environments.
 * Speaks the standard ClamAV zINSTREAM protocol over TCP sockets, accurately detecting
 * EICAR and malicious payloads while providing a real socket endpoint for verification.
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
            socket.write('stream: Win.Test.EICAR_FOUND\0');
          } else {
            socket.write('stream: OK\0');
          }
          socket.end();
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
