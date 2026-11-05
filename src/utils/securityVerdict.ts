import type { FullSecurityReport, SecurityStatus } from '../server/security/types';

/**
 * Turns the upload response into ONE explicit security decision the UI can show. Pure and framework-free, so it can
 * be tested. Anything that is not a well-formed security report is an error, never a silent clean and never the
 * string "undefined".
 *
 *   clean        a genuine antivirus (ClamAV) scan completed and found nothing
 *   demo         the local-development demo scanner "passed" the file; this is NOT antivirus (dev/test only)
 *   blocked      a threat or a policy violation: the document is blocked
 *   error        scanning (or the request) failed; the document was not cleared
 *   unavailable  no real scanner is configured or reachable; the document was not scanned
 */
export type VerdictKind = 'clean' | 'demo' | 'blocked' | 'error' | 'unavailable';

export interface SecurityVerdict {
  kind: VerdictKind;
  title: string;
  message: string;
  /** True only when the document may be extracted and analysed */
  processable: boolean;
}

const KNOWN: ReadonlySet<string> = new Set<SecurityStatus>([
  'RECEIVED', 'QUARANTINED', 'SCANNING', 'CLEAN_NO_KNOWN_THREATS', 'SUSPICIOUS', 'THREAT_DETECTED', 'REJECTED', 'SCAN_FAILED', 'UNAVAILABLE',
]);

export function isSecurityReport(body: unknown): body is FullSecurityReport {
  if (!body || typeof body !== 'object') return false;
  const r = body as Record<string, unknown>;
  return (
    typeof r.status === 'string' &&
    KNOWN.has(r.status) &&
    typeof r.eligibleForContractProcessing === 'boolean' &&
    typeof r.fileId === 'string' &&
    !!r.malware && typeof r.malware === 'object' &&
    !!r.metadata && typeof r.metadata === 'object'
  );
}

const text = (v: unknown, max = 240): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** The decision for a well-formed report. */
export function verdictOf(report: FullSecurityReport): SecurityVerdict {
  const message = text(report.statusMessage, 400);
  switch (report.status) {
    case 'CLEAN_NO_KNOWN_THREATS': {
      const genuine = report.malware.genuine;
      if (!report.eligibleForContractProcessing || report.malware.scannerAvailable !== true || typeof genuine !== 'boolean') {
        // Fail closed on an inconsistent report
        return { kind: 'error', title: 'Security result could not be trusted', message: 'The security result was inconsistent, so the document was not cleared.', processable: false };
      }
      return genuine
        ? { kind: 'clean', title: 'Clean — antivirus scan completed', message: 'A genuine antivirus scan (ClamAV) completed and found no known threats.', processable: true }
        : { kind: 'demo', title: 'Demo scan only — not antivirus', message: message || 'A development stand-in scanner was used. No genuine antivirus scan was performed.', processable: true };
    }
    case 'THREAT_DETECTED':
      return { kind: 'blocked', title: 'Threat detected — document blocked', message: message || 'This document was blocked by the security inspection.', processable: false };
    case 'SUSPICIOUS':
    case 'REJECTED':
      return { kind: 'blocked', title: 'Document blocked', message: message || 'This document did not pass the security inspection.', processable: false };
    case 'UNAVAILABLE':
      return {
        kind: 'unavailable',
        title: 'Security scanning is unavailable',
        message: message || 'No antivirus scanner is configured or reachable, so your document was not scanned and has not been analysed.',
        processable: false,
      };
    case 'SCAN_FAILED':
      return { kind: 'error', title: 'Security scan failed', message: message || 'The antivirus scan did not complete, so the document was not cleared.', processable: false };
    default:
      return { kind: 'error', title: 'Security scan incomplete', message: 'The security inspection did not finish, so the document was not cleared.', processable: false };
  }
}

/**
 * Parses an upload response (any HTTP status, any body). A report that says it is eligible for processing is
 * only trusted when its status is the genuine-or-demo clean status; any other combination is an error.
 */
export function parseUploadResponse(httpStatus: number, body: unknown): { report?: FullSecurityReport; verdict: SecurityVerdict } {
  if (isSecurityReport(body)) {
    const verdict = verdictOf(body);
    if (body.eligibleForContractProcessing && !verdict.processable) {
      return { verdict: { kind: 'error', title: 'Security result could not be trusted', message: 'The security result was inconsistent, so the document was not cleared.', processable: false } };
    }
    return { report: body, verdict };
  }

  // Not a security report: describe what actually came back
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const reason = text(b.error) || text(b.detail);
  const detail = text(b.error) && text(b.detail) ? ` ${text(b.detail)}` : '';
  const unavailableStatus = httpStatus === 503 || b.status === 'UNAVAILABLE';
  const where = httpStatus ? ` (HTTP ${httpStatus})` : '';
  return {
    verdict: {
      kind: unavailableStatus ? 'unavailable' : 'error',
      title: unavailableStatus ? 'Security scanning is unavailable' : 'Security inspection failed',
      message: reason
        ? `The security inspection did not return a decision${where}: ${reason}${detail}`
        : `The security inspection did not return a valid decision${where}. The document was not cleared.`,
      processable: false,
    },
  };
}
