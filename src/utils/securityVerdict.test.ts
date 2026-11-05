import test from 'node:test';
import assert from 'node:assert/strict';
import { isSecurityReport, parseUploadResponse, verdictOf } from './securityVerdict';

const report = (over: any = {}, malware: any = {}) => ({
  fileId: 'f1',
  status: 'CLEAN_NO_KNOWN_THREATS',
  statusMessage: 'All mandatory security checks passed. No known threats detected.',
  metadata: { fileId: 'f1', sha256: 'abc' },
  authenticity: {}, structure: {}, activeContent: {}, promptInjection: {},
  malware: { passed: true, engine: 'ClamAV', threatsFound: [], scannerAvailable: true, details: [], outcome: 'clean', scanner: 'clamav-service', genuine: true, ...malware },
  scanDurationMs: 5, eligibleForContractProcessing: true, completedAt: 'now',
  ...over,
});

test.describe('security verdict shown to the user', () => {
  test('clean: only when a genuine antivirus scan completed', () => {
    const v = parseUploadResponse(200, report()).verdict;
    assert.equal(v.kind, 'clean');
    assert.equal(v.processable, true);
    assert.match(v.title, /antivirus scan completed/i);
  });

  test('demo scanner: never presented as clean antivirus', () => {
    const v = parseUploadResponse(200, report({ statusMessage: 'DEMO SCANNER ONLY: no genuine antivirus scan was performed.' }, { genuine: false, scanner: 'demo' })).verdict;
    assert.equal(v.kind, 'demo');
    assert.match(v.title, /not antivirus/i);
  });

  test('threat detected and policy blocks: blocked, not processable', () => {
    for (const status of ['THREAT_DETECTED', 'SUSPICIOUS', 'REJECTED']) {
      const v = parseUploadResponse(200, report({ status, eligibleForContractProcessing: false, statusMessage: 'Malicious signature detected: ClamAV:Eicar' }, { passed: false, outcome: 'threat' })).verdict;
      assert.equal(v.kind, 'blocked', status);
      assert.equal(v.processable, false);
    }
    assert.match(parseUploadResponse(200, report({ status: 'THREAT_DETECTED', eligibleForContractProcessing: false }, { passed: false })).verdict.title, /Threat detected/);
  });

  test('scan failed: error; unavailable: unavailable. Neither is processable', () => {
    const err = parseUploadResponse(200, report({ status: 'SCAN_FAILED', eligibleForContractProcessing: false, statusMessage: 'The security scan did not finish within 25 seconds.' }, { passed: false, scannerAvailable: false, outcome: 'error' })).verdict;
    assert.equal(err.kind, 'error');
    assert.match(err.message, /did not finish/);
    const un = parseUploadResponse(200, report({ status: 'UNAVAILABLE', eligibleForContractProcessing: false, statusMessage: '' }, { passed: false, scannerAvailable: false, outcome: 'unavailable', genuine: false })).verdict;
    assert.equal(un.kind, 'unavailable');
    assert.match(un.message, /not scanned and has not been analysed/);
    assert.equal(un.processable, false);
  });

  test('a body that is not a security report is an explicit error, never "undefined"', () => {
    const bodies: Array<[number, unknown]> = [
      [503, { error: 'Backend failed to start.', detail: 'SESSION_SECRET missing', diagnostics: {} }],
      [400, { error: 'No contract file provided.' }],
      [401, { error: 'Authentication failed', status: 'UNAUTHORIZED' }],
      [500, null],
      [200, {}],
      [200, 'text'],
      [200, { status: 'CLEAN_NO_KNOWN_THREATS' }],
      [200, { status: 'SOMETHING_NEW', eligibleForContractProcessing: true, fileId: 'x', malware: {}, metadata: {} }],
    ];
    for (const [code, body] of bodies) {
      const { report: r, verdict } = parseUploadResponse(code, body);
      assert.equal(r, undefined);
      assert.ok(['error', 'unavailable'].includes(verdict.kind));
      assert.equal(verdict.processable, false);
      assert.ok(!/undefined|null|\[object/i.test(`${verdict.title} ${verdict.message}`), `${code}: ${verdict.message}`);
    }
    assert.match(parseUploadResponse(503, { error: 'Backend failed to start.' }).verdict.message, /Backend failed to start/);
    assert.match(parseUploadResponse(500, null).verdict.message, /HTTP 500/);
  });

  test('an inconsistent report fails closed', () => {
    // Clean but no scanner information
    assert.equal(parseUploadResponse(200, report({}, { genuine: undefined })).verdict.kind, 'error');
    // Clean but the scanner was not available
    assert.equal(parseUploadResponse(200, report({}, { scannerAvailable: false })).verdict.kind, 'error');
    // Clean status but not eligible
    assert.equal(parseUploadResponse(200, report({ eligibleForContractProcessing: false })).verdict.kind, 'error');
    // A blocked status that claims to be eligible must not be processable
    const v = parseUploadResponse(200, report({ status: 'THREAT_DETECTED', eligibleForContractProcessing: true })).verdict;
    assert.equal(v.processable, false);
    assert.equal(v.kind, 'error');
  });

  test('isSecurityReport and verdictOf agree', () => {
    assert.equal(isSecurityReport(report()), true);
    assert.equal(isSecurityReport({ error: 'x' }), false);
    assert.equal(verdictOf(report() as any).kind, 'clean');
  });
});
