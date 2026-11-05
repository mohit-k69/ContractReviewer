import { MalwareScanResult } from './types';

// Standard EICAR Antivirus Test Signature
export const EICAR_SIGNATURE = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

// Known malicious signatures, exploit shellcode, and embedded executable markers
export const KNOWN_THREAT_PATTERNS = [
  { name: 'EICAR-Standard-AV-Test-File', pattern: EICAR_SIGNATURE },
  { name: 'Embedded-Windows-PE-Executable', pattern: 'This program cannot be run in DOS mode' },
  { name: 'PowerShell-Encoded-Payload', pattern: 'powershell -encodedcommand' },
  { name: 'PowerShell-Download-Cradle', pattern: 'downloadstring(http' },
  { name: 'VBA-AutoOpen-Shell-Exploit', pattern: 'Sub AutoOpen()' },
  { name: 'CVE-2022-30190-Follina-MSDT', pattern: 'ms-msdt:/id pcwdiagnostic' },
];

/**
 * Built-in known-malicious-pattern check. It is a small signature list, NOT antivirus. It runs on every upload,
 * independently of any antivirus service: it never depends on ClamAV being configured, reachable or working.
 */
export function inspectKnownThreats(buffer: Buffer): { passed: boolean; threatsFound: string[]; details: string[] } {
  const latin = buffer.toString('latin1');
  const utf8 = buffer.toString('utf8');
  const threatsFound: string[] = [];
  const details: string[] = [];
  for (const { name, pattern } of KNOWN_THREAT_PATTERNS) {
    if (latin.includes(pattern) || utf8.includes(pattern)) {
      threatsFound.push(name);
      details.push(`Known malicious signature match: ${name}`);
    }
  }
  if (threatsFound.length === 0) details.push('No known malicious signature matched (built-in list; this is not an antivirus scan).');
  return { passed: threatsFound.length === 0, threatsFound, details };
}

/** The malware field of a report when only the built-in signature check ran. Never genuine antivirus. */
export function builtInMalwareResult(check: { passed: boolean; threatsFound: string[]; details: string[] }): MalwareScanResult {
  return {
    passed: check.passed,
    engine: 'Built-in signature checks (not antivirus)',
    threatsFound: check.threatsFound,
    scannerAvailable: false,
    details: check.details,
    outcome: check.passed ? 'not_performed' : 'threat',
    scanner: 'none',
    genuine: false,
  };
}
