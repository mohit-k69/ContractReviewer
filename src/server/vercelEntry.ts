import type { IncomingMessage, ServerResponse } from 'node:http';
import { describeStartupEnvironment } from './runtimeDiagnostics';

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * config.json routes `/api/<rest>` to this function as `/api?__p=<rest>`. Depending on how the platform
 * presents a rewritten request, `req.url` may be the original path or the rewritten one; this restores the
 * original `/api/<rest>` path in both cases and strips the helper parameter.
 */
export function restoreApiPath(rawUrl: string | undefined): string {
  const url = rawUrl || '/';
  const parsed = new URL(url, 'http://localhost');
  const rest = parsed.searchParams.get('__p');
  if (rest === null) return url;
  parsed.searchParams.delete('__p');
  const clean = rest.replace(/^\/+/, '');
  return `/api${clean ? `/${clean}` : ''}${parsed.search}`;
}

let appPromise: Promise<NodeHandler> | null = null;

/**
 * Lazily builds the Express app once per function instance. `./app` is imported dynamically so that a
 * configuration error thrown while loading it (for example a missing SESSION_SECRET in production) is
 * reported as a clear JSON 503 instead of an opaque platform crash page.
 */
function getApp(): Promise<NodeHandler> {
  if (!appPromise) {
    appPromise = (async () => {
      // Safe diagnostic (no secret values): shows what this function instance actually sees at startup.
      console.log('[vercel] startup environment:', JSON.stringify(describeStartupEnvironment()));
      const { createApp, initServerRuntime } = await import('./app');
      await initServerRuntime();
      return createApp() as unknown as NodeHandler;
    })().catch((err) => {
      appPromise = null; // retry on the next request
      throw err;
    });
  }
  return appPromise;
}

/** Vercel serverless entry point: every /api/* request is routed here and served by the same Express app. */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const app = await getApp();
    req.url = restoreApiPath(req.url);
    app(req, res);
  } catch (err: any) {
    const diagnostics = describeStartupEnvironment();
    console.error('[vercel] backend failed to start:', err, JSON.stringify(diagnostics));
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: 'Backend failed to start.',
        // Startup errors are configuration messages (never secrets); keep them short.
        detail: String(err?.message || 'unknown error').slice(0, 300),
        // Presence flags only: never any secret value. Lets an operator see what the deployed function can read.
        diagnostics,
      })
    );
  }
}
