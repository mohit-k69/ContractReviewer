import { FullSecurityReport } from './types';

/**
 * The single rule for whether a document may be extracted and analysed. Every stage uses this function.
 *
 *  - CLEAN_NO_KNOWN_THREATS : only when a genuine ClamAV scan completed (malware.genuine === true).
 *  - BASIC_CHECKS_PASSED_NO_ANTIVIRUS : the built-in checks passed and no antivirus ran (malware.genuine === false).
 *
 * Anything else (blocked, suspicious, failed, unavailable, incomplete or internally inconsistent) is not processable.
 */
export function isProcessable(
  report: Pick<FullSecurityReport, 'status' | 'eligibleForContractProcessing'> & { malware?: Pick<FullSecurityReport['malware'], 'genuine'> }
): boolean {
  if (report.eligibleForContractProcessing !== true) return false;
  const genuine = report.malware?.genuine;
  if (report.status === 'CLEAN_NO_KNOWN_THREATS') return genuine === true;
  if (report.status === 'BASIC_CHECKS_PASSED_NO_ANTIVIRUS') return genuine === false;
  return false;
}
