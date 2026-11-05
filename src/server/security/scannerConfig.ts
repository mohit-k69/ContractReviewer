import { AntivirusPolicy } from './types';

/**
 * Which antivirus (if any) is configured. One place decides, so the pipeline and /api/health cannot disagree.
 *
 *   clamav-service : an authenticated HTTPS ClamAV scanning service (scanner-service/, optional)
 *   clamav-tcp     : a real ClamAV daemon reached directly over TCP (optional)
 *   none           : no antivirus is configured. Only the built-in checks run (see ANTIVIRUS_POLICY).
 *
 * The behaviour is identical on Vercel Preview and Production: nothing here depends on VERCEL_ENV.
 */
export type ScannerMode = 'clamav-service' | 'clamav-tcp' | 'none';

type Env = NodeJS.ProcessEnv;

export function scannerMode(env: Env = process.env): ScannerMode {
  if (env.CLAMAV_SCAN_URL) return 'clamav-service';
  if (env.CLAMAV_HOST) return 'clamav-tcp';
  return 'none';
}

/**
 * ANTIVIRUS_POLICY: "optional" (default) or "required". Any other value is treated as "required" (fail closed)
 * instead of silently weakening the policy.
 */
export function antivirusPolicy(env: Env = process.env): AntivirusPolicy {
  const raw = (env.ANTIVIRUS_POLICY ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'optional') return 'optional';
  return 'required';
}
