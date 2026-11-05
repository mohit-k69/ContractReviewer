import express from 'express';
import multer from 'multer';
import { MAX_FILE_SIZE_BYTES } from './security/pipeline';
import { initQuarantineStorage, reconcileQuarantineOnStartup } from './security/quarantineManager';
import {
  requireSessionAuth,
  createSignedSessionToken,
  attachSessionCookie,
  rateLimitSessionIssuance,
  verifyOriginProtection,
  AuthenticatedRequest,
} from './security/sessionAuth';
import { uploadResourceGuard } from './security/resourceProtection';
import { runUploadWorkflow } from './uploadWorkflow';
import { antivirusPolicy, scannerMode } from './security/scannerConfig';
import { probeScannerService } from './security/clamavServiceClient';

let runtimeReady: Promise<void> | null = null;

/**
 * One-time runtime initialisation shared by the long-running server and the serverless entry point:
 * quarantine storage and the startup purge of any leftover documents. No antivirus is started: an optional
 * ClamAV is configured through the environment, and without one only the built-in checks run.
 */
export function initServerRuntime(): Promise<void> {
  if (!runtimeReady) {
    runtimeReady = (async () => {
      initQuarantineStorage();

      // Nothing is restored across restarts: anything left on disk is deleted
      const reconciliation = reconcileQuarantineOnStartup();
      console.log(
        `[QuarantineStartup] Leftover documents purged: ${reconciliation.purged}, failed: ${reconciliation.failed} (documents are never restored)`
      );

      const mode = scannerMode();
      console.log(
        mode === 'none'
          ? `[Security] No antivirus configured (ANTIVIRUS_POLICY=${antivirusPolicy()}). Built-in checks only; full antivirus scanning is not performed.`
          : `[Security] Antivirus configured (${mode}); it is enforced and fails closed.`
      );
    })().catch((err) => {
      runtimeReady = null; // allow a retry on the next request
      throw err;
    });
  }
  return runtimeReady;
}

/**
 * Builds the Express application with every API route. It does not listen and does not serve the
 * frontend: server.ts (long-running) and api/index.js (Vercel serverless) both wrap this same app.
 */
export function createApp() {
  const app = express();

  app.use(express.json());

  // Apply Origin / Referer CSRF protection on state-changing requests
  app.use(verifyOriginProtection);

  // Configure Multer memory storage (never write untrusted files to public disk)
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_FILE_SIZE_BYTES, // 20 MB
    },
  });

  // Deployment health check (no authentication, no secrets). Lets a deployment prove the backend is reachable.
  app.get('/api/health', async (req, res) => {
    const mode = scannerMode();
    const policy = antivirusPolicy();
    const antivirus: Record<string, unknown> = {
      mode,
      configured: mode !== 'none',
      // Only a real ClamAV counts as genuine antivirus. "none" means built-in checks only.
      genuine: mode !== 'none',
    };
    // ?probe=1 additionally asks the scanning service whether ClamAV is ready (no document is sent).
    if (req.query.probe === '1' && mode === 'clamav-service') {
      Object.assign(antivirus, { ready: (await probeScannerService(process.env.CLAMAV_SCAN_URL!)).ready });
    }
    res.json({
      ok: true,
      runtime: process.env.VERCEL ? 'vercel-serverless' : 'node-server',
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      sessionSecretConfigured: Boolean(process.env.SESSION_SECRET),
      antivirus,
      securityPolicy: {
        antivirusPolicy: policy,
        // What an upload gets today: a genuine antivirus scan, basic checks only, or nothing (policy "required")
        scanLevel: mode !== 'none' ? 'antivirus' : policy === 'required' ? 'unavailable' : 'basic-checks-only',
        fullAntivirusScanning: mode !== 'none',
        documentRetention: 'none (deleted when the request finishes)',
      },
      routes: ['/api/auth/session', '/api/contracts/upload?analyze=1'],
    });
  });

  // 1. Session Issuance Endpoint
  // Rate-limited, sets HttpOnly/SameSite=Strict cookie, does NOT leak token in JSON response
  app.get('/api/auth/session', rateLimitSessionIssuance, (_req, res) => {
    const token = createSignedSessionToken();
    attachSessionCookie(res, token);
    res.json({ success: true, message: 'Secure session established.' });
  });

  // 2. Upload & Security Inspection Endpoint
  // Protected by HttpOnly cookie session, upload concurrency guard, rate limits, and 30s timeout
  app.post(
    '/api/contracts/upload',
    requireSessionAuth,
    uploadResourceGuard,
    (req, res, next) => {
      upload.single('file')(req, res, (err) => {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            error: 'File size exceeds maximum limit of 20 MB.',
            status: 'REJECTED',
          });
        }
        if (err) {
          return res.status(400).json({
            error: err.message || 'File upload failed.',
            status: 'SCAN_FAILED',
          });
        }
        next();
      });
    },
    async (req: AuthenticatedRequest, res) => {
      if (!req.file) {
        return res.status(400).json({ error: 'No contract file provided.', status: 'REJECTED' });
      }
      // ?analyze=1 is the supported workflow: inspection AND the full analysis run in this single request, and the
      // document and every intermediate result are deleted before the answer is returned (see uploadWorkflow.ts).
      const result = await runUploadWorkflow({
        buffer: req.file.buffer,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        sessionId: req.verifiedSession!.sessionId,
        analyze: req.query.analyze === '1',
      });
      return res.status(result.status).json(result.body);
    }
  );

  // Documents are never retained, so there is nothing to fetch, extract, normalize or understand afterwards.
  // The former step-by-step endpoints are disabled; they answered from copies of the document held on the server.
  const gone = (_req: express.Request, res: express.Response) =>
    res.status(410).json({
      error: 'Gone: documents are processed in a single request and deleted immediately. Use POST /api/contracts/upload?analyze=1.',
      status: 'GONE',
    });
  for (const route of ['security-status', 'extract', 'normalize', 'understand', 'risk-report']) {
    app.all(`/api/contracts/:id/${route}`, requireSessionAuth, gone);
  }

  // Idempotent: there is nothing retained to delete, and the response says so.
  app.delete('/api/contracts/:id', requireSessionAuth, (_req, res) =>
    res.json({ success: true, message: 'No document is retained by the server; nothing to delete.' })
  );

  return app;
}
