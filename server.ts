import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { runSecurityInspectionPipeline, MAX_FILE_SIZE_BYTES } from './src/server/security/pipeline';
import {
  getSecurityReport,
  deleteQuarantinedFile,
  initQuarantineStorage,
  reconcileQuarantineOnStartup,
} from './src/server/security/quarantineManager';
import {
  requireSessionAuth,
  createSignedSessionToken,
  attachSessionCookie,
  rateLimitSessionIssuance,
  verifyOriginProtection,
  AuthenticatedRequest,
} from './src/server/security/sessionAuth';
import { uploadResourceGuard } from './src/server/security/resourceProtection';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  initQuarantineStorage();

  // Reconcile quarantine files across server restarts (purges expired >2h, restores valid)
  const reconciliation = reconcileQuarantineOnStartup();
  console.log(
    `[QuarantineReconciliation] Restored: ${reconciliation.restored}, Purged expired: ${reconciliation.purged}, Failed: ${reconciliation.failed}`
  );

  const app = express();
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const isProd = process.env.NODE_ENV === 'production';

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
      try {
        if (!req.file) {
          return res.status(400).json({ error: 'No contract file provided.' });
        }

        const sessionId = req.verifiedSession!.sessionId;
        const originalName = req.file.originalname;
        const mimeType = req.file.mimetype;
        const buffer = req.file.buffer;

        // Run full security inspection pipeline
        const report = await runSecurityInspectionPipeline(
          buffer,
          originalName,
          mimeType,
          sessionId
        );

        return res.json(report);
      } catch (error: any) {
        return res.status(500).json({
          error: error?.message || 'Internal security inspection failure.',
          status: 'SCAN_FAILED',
        });
      }
    }
  );

  // 3. Security Status Retrieval Endpoint
  app.get('/api/contracts/:id/security-status', requireSessionAuth, (req: AuthenticatedRequest, res) => {
    const fileId = req.params.id;
    const sessionId = req.verifiedSession!.sessionId;

    const { report, authorized } = getSecurityReport(fileId, sessionId);

    if (!authorized) {
      return res.status(403).json({ error: 'Access denied: Cross-user session access violation.' });
    }

    if (!report) {
      return res.status(404).json({ error: 'Security report not found for specified file ID.' });
    }

    return res.json(report);
  });

  // 4. Quarantined Document Deletion Endpoint
  app.delete('/api/contracts/:id', requireSessionAuth, (req: AuthenticatedRequest, res) => {
    const fileId = req.params.id;
    const sessionId = req.verifiedSession!.sessionId;

    const result = deleteQuarantinedFile(fileId, sessionId);

    if (!result.authorized) {
      return res.status(403).json({ error: 'Access denied: Cross-user session deletion violation.' });
    }

    if (!result.success) {
      return res.status(500).json({
        error: result.error || 'Filesystem deletion failure: could not delete quarantined file.',
      });
    }

    return res.json({ success: true, message: 'Document removed from quarantine.' });
  });

  // Vite middleware in dev or static files in production
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`FinePrint Contract Reviewer server running on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
