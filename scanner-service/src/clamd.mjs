import net from 'node:net';

/**
 * Minimal ClamAV (clamd) protocol client. Commands are null-terminated ("z" prefix).
 * The daemon is reached on localhost only; this module never listens on a network port.
 *
 * Every function resolves; none throws. A result is only "clean" when clamd answered exactly "stream: OK".
 */

const CONNECT_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'EPIPE']);

/** One request/response exchange. `write` receives the connected socket. */
function exchange({ host, port, timeoutMs, write }) {
  return new Promise((resolve) => {
    let settled = false;
    let data = '';
    const socket = new net.Socket();
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, kind: 'timeout', detail: `clamd did not answer within ${timeoutMs} ms` }), timeoutMs);

    socket.on('data', (chunk) => {
      data += chunk.toString('latin1');
    });
    socket.on('end', () => done({ ok: true, data: data.replace(/[\0\r\n]+$/, '').trim() }));
    socket.on('close', () => done({ ok: true, data: data.replace(/[\0\r\n]+$/, '').trim() }));
    socket.on('error', (err) =>
      done({ ok: false, kind: CONNECT_ERRORS.has(err.code) ? 'unreachable' : 'io', detail: `clamd connection error (${err.code || err.message})` })
    );
    socket.connect(port, host, () => {
      Promise.resolve(write(socket)).catch((err) => done({ ok: false, kind: 'io', detail: `clamd write failed (${err.message})` }));
    });
  });
}

async function writeAll(socket, data) {
  if (socket.destroyed || !socket.writable) throw new Error('socket closed');
  if (!socket.write(data)) await new Promise((resolve) => socket.once('drain', resolve));
}

/** True when clamd answers PING with PONG (the daemon has loaded its signatures and is serving). */
export async function ping({ host, port, timeoutMs = 2000 }) {
  const r = await exchange({ host, port, timeoutMs, write: (s) => writeAll(s, 'zPING\0') });
  return r.ok && r.data === 'PONG';
}

/** e.g. "ClamAV 1.4.2/27123/Tue Nov  4 08:25:11 2025", or null. */
export async function version({ host, port, timeoutMs = 2000 }) {
  const r = await exchange({ host, port, timeoutMs, write: (s) => writeAll(s, 'zVERSION\0') });
  return r.ok && /^ClamAV/i.test(r.data) ? r.data.slice(0, 120) : null;
}

/**
 * Streams `buffer` to clamd (zINSTREAM) and classifies the answer.
 * Returns { state: 'clean' | 'blocked' | 'error' | 'unavailable', signature?, detail? }.
 */
export async function scanBuffer(buffer, { host, port, timeoutMs = 20000 }) {
  const r = await exchange({
    host,
    port,
    timeoutMs,
    write: async (socket) => {
      await writeAll(socket, 'zINSTREAM\0');
      const chunkSize = 64 * 1024;
      for (let i = 0; i < buffer.length; i += chunkSize) {
        const chunk = buffer.subarray(i, i + chunkSize);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length, 0);
        await writeAll(socket, len);
        await writeAll(socket, chunk);
      }
      await writeAll(socket, Buffer.alloc(4)); // zero-length chunk ends the stream
    },
  });

  if (!r.ok) return { state: r.kind === 'unreachable' ? 'unavailable' : 'error', detail: r.detail };

  if (/^stream:\s*OK$/.test(r.data)) return { state: 'clean' };
  const found = /^stream:\s*(.+?)\s+FOUND$/.exec(r.data);
  if (found) return { state: 'blocked', signature: found[1].trim().slice(0, 120) };
  // Anything else (ERROR banners, size-limit messages, empty or truncated answers) is NOT clean.
  return { state: 'error', detail: 'clamd returned an unexpected answer' };
}
