import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretUploadResponse, MESSAGES } from './uploadOutcome';

const report = (over: any = {}, malware: any = {}, authenticity: any = {}) => ({
  fileId: 'abc', status: 'BASIC_CHECKS_PASSED_NO_ANTIVIRUS', statusMessage: 'Basic document security checks passed. Full antivirus scanning was not performed.',
  metadata: { fileId: 'abc', sha256: 'deadbeef', fileSize: 10 }, authenticity: { passed: true, passwordProtected: false, ...authenticity }, structure: {}, activeContent: {}, promptInjection: {},
  malware: { passed: true, engine: 'Built-in signature checks (not antivirus)', threatsFound: [], scannerAvailable: false, details: [], outcome: 'not_performed', scanner: 'none', genuine: false, ...malware },
  scanDurationMs: 4, eligibleForContractProcessing: true, completedAt: 'now', documentDeleted: true, ...over,
});
const decision = { schema_version: '1.0', deal: { items: [] } };

test.describe('what the user sees after an upload', () => {
  test('success: the Decision Report from the single response', () => {
    const o = interpretUploadResponse(200, { ...report(), analysis: { decisionReport: decision } });
    assert.equal(o.ok, true);
    assert.equal((o as any).report, decision);
  });

  test('rejected files get ONE short, plain message with no technical detail', () => {
    const blocked = [
      report({ status: 'THREAT_DETECTED', eligibleForContractProcessing: false, statusMessage: 'Malicious signature detected: EICAR-Standard-AV-Test-File' }),
      report({ status: 'REJECTED', eligibleForContractProcessing: false, statusMessage: 'Active content detected: PDF contains embedded JavaScript' }),
      report({ status: 'REJECTED', eligibleForContractProcessing: false, statusMessage: 'Malformed PDF structure: missing valid header' }),
    ];
    for (const b of blocked) {
      const o = interpretUploadResponse(200, b);
      assert.equal(o.ok, false);
      assert.equal((o as any).message, MESSAGES.generic);
      assert.ok(!/javascript|signature|eicar|pdf structure|malicious|threat|antivirus|scan|sha|malware|inspection/i.test((o as any).message), (o as any).message);
    }
  });

  test('specific, harmless explanations: password-protected and too large', () => {
    assert.equal((interpretUploadResponse(200, report({ status: 'REJECTED', eligibleForContractProcessing: false }, {}, { passwordProtected: true })) as any).message, MESSAGES.passwordProtected);
    assert.equal((interpretUploadResponse(200, report({ status: 'REJECTED', eligibleForContractProcessing: false, statusMessage: 'File exceeds maximum allowed size of 20 MB (actual: 21.0 MB).' })) as any).message, MESSAGES.tooLarge);
    assert.equal((interpretUploadResponse(413, null) as any).message, MESSAGES.tooLarge);
    assert.equal((interpretUploadResponse(400, { error: 'File size exceeds maximum limit of 20 MB.', status: 'REJECTED' }) as any).message, MESSAGES.tooLarge);
  });

  test('failures never leak internals and never say "undefined"', () => {
    const cases: Array<[number, unknown]> = [
      [503, { error: 'Backend failed to start.', detail: 'FATAL SECURITY ERROR: SESSION_SECRET', diagnostics: {} }],
      [500, null], [200, {}], [401, { error: 'Authentication failed', status: 'UNAUTHORIZED' }],
      [200, report({ status: 'SCAN_FAILED', eligibleForContractProcessing: false, statusMessage: 'ClamAV at 10.0.0.1:3310 timed out' }, { outcome: 'error', scannerAvailable: false })],
      [200, report({ status: 'UNAVAILABLE', eligibleForContractProcessing: false }, { outcome: 'unavailable', scannerAvailable: false })],
      [200, { ...report(), analysis: { error: 'Extraction failed: internal' } }],
      [200, { ...report(), analysis: {} }],
    ];
    for (const [code, body] of cases) {
      const o = interpretUploadResponse(code, body);
      assert.equal(o.ok, false);
      const m = (o as any).message as string;
      assert.ok(Object.values(MESSAGES).includes(m as any), m);
      assert.ok(!/undefined|null|secret|fatal|clamav|backend|extraction|internal|\d+\.\d+\.\d+/i.test(m), m);
    }
    assert.equal((interpretUploadResponse(503, { error: 'x' }) as any).message, MESSAGES.temporarilyUnavailable);
  });

  test('a basic-checks result that is not processable never yields a report', () => {
    const o = interpretUploadResponse(200, { ...report({ eligibleForContractProcessing: false }), analysis: { decisionReport: decision } });
    assert.equal(o.ok, false);
  });
});
