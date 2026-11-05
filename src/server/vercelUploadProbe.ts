// Test helper (run in a child process): drives the real Vercel handler through session -> upload?analyze=1 and prints a
// summary as JSON. The file text comes from PROBE_FILE_TEXT. Contains no secrets and prints no file contents.
import http from 'node:http';
import handler from './vercelEntry';

const server = http.createServer((req, res) => void handler(req, res));
server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const health = await (await fetch(`${base}/api/health`)).json();
  const session = await fetch(`${base}/api/auth/session`);
  const cookie = (session.headers.getSetCookie()[0] || '').split(';')[0];
  const form = new FormData();
  form.append('file', new Blob([process.env.PROBE_FILE_TEXT ?? ''], { type: 'text/plain' }), 'contract.txt');
  const res = await fetch(`${base}/api/contracts/upload?analyze=1`, { method: 'POST', headers: { cookie }, body: form });
  const body: any = await res.json();
  console.log(
    `PROBE ${JSON.stringify({
      health: { antivirus: health.antivirus },
      http: res.status,
      status: body.status,
      eligible: body.eligibleForContractProcessing,
      statusMessage: body.statusMessage,
      malware: body.malware && { outcome: body.malware.outcome, genuine: body.malware.genuine, scanner: body.malware.scanner, scannerAvailable: body.malware.scannerAvailable },
      hasAnalysis: body.analysis !== undefined,
      hasExtraction: body.analysis?.extractionResult !== undefined,
      hasDecisionReport: body.analysis?.decisionReport !== undefined,
    })}`
  );
  server.close();
  process.exit(0);
});
