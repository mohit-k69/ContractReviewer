// Test helper (run in a child process): serves /api/health through the real Vercel handler and prints the result as JSON.
import http from 'node:http';
import handler from './vercelEntry';

const server = http.createServer((req, res) => void handler(req, res));
server.listen(0, '127.0.0.1', async () => {
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  console.log(`PROBE ${JSON.stringify({ status: res.status, body: await res.json() })}`);
  server.close();
  process.exit(0);
});
