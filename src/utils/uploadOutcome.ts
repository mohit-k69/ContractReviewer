import type { DecisionReport } from '../server/decision/types';
import { parseUploadResponse } from './securityVerdict';

/**
 * What the user sees after an upload: either the finished Decision Report, or ONE short, plain-English message.
 * The security checks run in the background and their individual steps, scanner details and internal identifiers are
 * never shown. Nothing here ever contains "undefined" or a raw server message.
 */
export type UploadOutcome =
  | { ok: true; report: DecisionReport }
  | { ok: false; message: string };

export const MESSAGES = {
  generic: 'We couldn’t process this file. Please upload a PDF, DOCX or TXT contract that isn’t damaged or password-protected.',
  passwordProtected: 'This file is password-protected, so it can’t be read. Please upload an unprotected copy.',
  tooLarge: 'This file is larger than the 20 MB limit. Please upload a smaller copy.',
  temporarilyUnavailable: 'Contract review is temporarily unavailable. Please try again in a few minutes.',
  tryAgain: 'We couldn’t finish reviewing this contract. Please try again.',
  unreachable: 'We couldn’t reach the review service. Please check your connection and try again.',
} as const;

export function interpretUploadResponse(httpStatus: number, body: unknown): UploadOutcome {
  if (httpStatus === 413) return { ok: false, message: MESSAGES.tooLarge };

  const { report, verdict } = parseUploadResponse(httpStatus, body);

  if (!report) {
    // Not a security report (for example the service could not start, or the request was refused)
    const raw = (body && typeof body === 'object' ? (body as Record<string, unknown>).error : '') as unknown;
    if (typeof raw === 'string' && /20 MB|too large|exceeds maximum/i.test(raw)) return { ok: false, message: MESSAGES.tooLarge };
    return { ok: false, message: verdict.kind === 'unavailable' ? MESSAGES.temporarilyUnavailable : MESSAGES.tryAgain };
  }

  if (!verdict.processable) {
    if (report.authenticity?.passwordProtected) return { ok: false, message: MESSAGES.passwordProtected };
    if (/exceeds maximum allowed size/i.test(report.statusMessage ?? '')) return { ok: false, message: MESSAGES.tooLarge };
    if (verdict.kind === 'unavailable') return { ok: false, message: MESSAGES.temporarilyUnavailable };
    if (verdict.kind === 'error') return { ok: false, message: MESSAGES.tryAgain };
    return { ok: false, message: MESSAGES.generic };
  }

  const analysis = (body as { analysis?: { decisionReport?: DecisionReport; error?: string } }).analysis;
  if (analysis?.decisionReport && !analysis.error) return { ok: true, report: analysis.decisionReport };
  return { ok: false, message: MESSAGES.tryAgain };
}
