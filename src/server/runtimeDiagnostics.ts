/**
 * Safe, secret-free description of the runtime environment, used when the backend cannot start.
 * It reports only booleans, a three-way presence state and two well-known non-secret variables.
 * It never contains the value of SESSION_SECRET (or any other variable).
 */
export interface StartupDiagnostics {
  /** 'missing' = not set at all, 'empty' = set to an empty string, 'present' = set to a non-empty value */
  sessionSecret: 'missing' | 'empty' | 'present';
  nodeEnv: string | null;
  vercelEnv: string | null;
  onVercel: boolean;
  /**
   * True when some variable is named almost like SESSION_SECRET (different case, stray spaces or quotes) but not
   * exactly. That is a typo in the dashboard, not a code problem. Only the boolean is reported, never a name.
   */
  similarlyNamedVariable: boolean;
}

export function describeStartupEnvironment(env: NodeJS.ProcessEnv = process.env): StartupDiagnostics {
  const raw = env.SESSION_SECRET;
  const normalise = (k: string): string => k.replace(/["'\s]/g, '').toUpperCase();
  return {
    sessionSecret: raw === undefined ? 'missing' : raw === '' ? 'empty' : 'present',
    nodeEnv: env.NODE_ENV ?? null,
    vercelEnv: env.VERCEL_ENV ?? null,
    onVercel: Boolean(env.VERCEL),
    similarlyNamedVariable: Object.keys(env).some((k) => k !== 'SESSION_SECRET' && normalise(k) === 'SESSION_SECRET'),
  };
}
