/**
 * Which antivirus (if any) this deployment is configured to use. One place decides, so the runtime start-up,
 * the scan itself and /api/health can never disagree.
 *
 *   clamav-service : an authenticated HTTPS scanning service running a real ClamAV (production)
 *   clamav-tcp     : a real ClamAV daemon reached directly over TCP (self-hosted)
 *   demo           : the embedded demo scanner. Local development and automated tests ONLY.
 *   none           : nothing is configured; documents are NOT scanned and are NOT analysed
 */
export type ScannerMode = 'clamav-service' | 'clamav-tcp' | 'demo' | 'none';

type Env = NodeJS.ProcessEnv;

/** The demo scanner can never run on Vercel or in production, and only when it is switched on explicitly. */
export function demoScannerAllowed(env: Env = process.env): boolean {
  return env.ALLOW_DEMO_SCANNER === '1' && !env.VERCEL && env.NODE_ENV !== 'production';
}

/** Demo endpoints started in this process (host:port). A client cannot tell them apart from a real daemon otherwise. */
const demoEndpoints = new Set<string>();
export const registerDemoEndpoint = (host: string, port: number): void => void demoEndpoints.add(`${host}:${port}`);
export const unregisterDemoEndpoint = (host: string, port: number): void => void demoEndpoints.delete(`${host}:${port}`);
export const isDemoEndpoint = (host: string, port: number): boolean => demoEndpoints.has(`${host}:${port}`);

export function scannerMode(env: Env = process.env): ScannerMode {
  if (env.CLAMAV_SCAN_URL) return 'clamav-service';
  if (env.CLAMAV_HOST) {
    const port = env.CLAMAV_PORT ? parseInt(env.CLAMAV_PORT, 10) : 3310;
    return isDemoEndpoint(env.CLAMAV_HOST, port) ? 'demo' : 'clamav-tcp';
  }
  return 'none';
}
