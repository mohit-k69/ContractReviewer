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
import { extractContractDocument, getCachedExtraction } from './src/server/extraction/extractionService';
import { normalizeContractDocument, getCachedNormalization } from './src/server/normalization/normalizationService';
import {
  understandContractDocument,
  getCachedUnderstanding,
} from './src/server/understanding/understandingService';
import { startClamAvDevDaemon } from './src/server/security/clamavDevDaemon';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  initQuarantineStorage();

  // Reconcile quarantine files across server restarts (purges expired >2h, restores valid)
  const reconciliation = reconcileQuarantineOnStartup();
  console.log(
    `[QuarantineReconciliation] Restored: ${reconciliation.restored}, Purged expired: ${reconciliation.purged}, Failed: ${reconciliation.failed}`
  );

  // Initialize ClamAV socket daemon for environment if unconfigured
  if (!process.env.CLAMAV_HOST) {
    const clamDaemon = await startClamAvDevDaemon();
    process.env.CLAMAV_HOST = clamDaemon.host;
    process.env.CLAMAV_PORT = clamDaemon.port.toString();
    console.log(`[ClamAV Daemon] Initialized socket antivirus service on ${clamDaemon.host}:${clamDaemon.port}`);
  }

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

  // 5. Document Extraction Endpoint (Phase 2A)
  // Protected by HttpOnly cookie session auth, verifies ownership, CLEAN status, eligibility, and SHA-256 fingerprint
  app.post('/api/contracts/:id/extract', requireSessionAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const fileId = req.params.id;
      const sessionId = req.verifiedSession!.sessionId;

      const extractionResponse = await extractContractDocument(fileId, sessionId);

      if (!extractionResponse.authorized) {
        return res.status(403).json({ error: extractionResponse.error || 'Access denied: Session ownership mismatch.' });
      }

      if (!extractionResponse.success && !extractionResponse.result) {
        return res.status(400).json({ error: extractionResponse.error || 'Extraction failed.' });
      }

      return res.json(extractionResponse.result);
    } catch (err: any) {
      return res.status(500).json({
        error: err.message || 'Internal error during contract document extraction.',
      });
    }
  });

  // 6. Cached Extraction Retrieval Endpoint
  app.get('/api/contracts/:id/extract', requireSessionAuth, (req: AuthenticatedRequest, res) => {
    const fileId = req.params.id;
    const sessionId = req.verifiedSession!.sessionId;

    const cacheLookup = getCachedExtraction(fileId, sessionId);
    if (!cacheLookup.authorized) {
      return res.status(403).json({ error: cacheLookup.error || 'Access denied: Session ownership mismatch.' });
    }

    if (!cacheLookup.exists || !cacheLookup.result) {
      return res.status(404).json({ error: cacheLookup.error || 'No extraction record found for this document.' });
    }

    return res.json(cacheLookup.result);
  });

  // 7. Document Normalization Endpoint (Phase 2B)
  // Protected by HttpOnly cookie session auth, verifies ownership, CLEAN status, eligibility, and SHA-256 fingerprint
  app.post('/api/contracts/:id/normalize', requireSessionAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const fileId = req.params.id;
      const sessionId = req.verifiedSession!.sessionId;

      const normResponse = await normalizeContractDocument(fileId, sessionId);

      if (!normResponse.authorized) {
        return res.status(403).json({ error: normResponse.error || 'Access denied: Session ownership mismatch.' });
      }

      if (!normResponse.success && !normResponse.result) {
        return res.status(400).json({ error: normResponse.error || 'Normalization failed.' });
      }

      return res.json(normResponse.result);
    } catch (err: any) {
      return res.status(500).json({
        error: err.message || 'Internal error during contract document normalization.',
      });
    }
  });

  // 8. Cached Normalization Retrieval Endpoint
  app.get('/api/contracts/:id/normalize', requireSessionAuth, (req: AuthenticatedRequest, res) => {
    const fileId = req.params.id;
    const sessionId = req.verifiedSession!.sessionId;

    const cacheLookup = getCachedNormalization(fileId, sessionId);
    if (!cacheLookup.authorized) {
      return res.status(403).json({ error: cacheLookup.error || 'Access denied: Session ownership mismatch.' });
    }

    if (!cacheLookup.exists || !cacheLookup.result) {
      return res.status(404).json({ error: cacheLookup.error || 'No normalized document found for this document.' });
    }

    return res.json(cacheLookup.result);
  });

  // 9. Contract Understanding Endpoint (Phase 2C)
  // Invokes Google Gemini to extract factual contract understanding from normalized structure
  app.post('/api/contracts/:id/understand', requireSessionAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const fileId = req.params.id;
      const sessionId = req.verifiedSession!.sessionId;

      const understandingResponse = await understandContractDocument(fileId, sessionId);

      if (!understandingResponse.authorized) {
        return res.status(403).json({ error: understandingResponse.error || 'Access denied: Session ownership mismatch.' });
      }

      if (!understandingResponse.success && !understandingResponse.result) {
        return res.status(400).json({ error: understandingResponse.error || 'Contract understanding failed.' });
      }

      return res.json(understandingResponse.result);
    } catch (err: any) {
      return res.status(500).json({
        error: err.message || 'Internal error during contract understanding.',
      });
    }
  });

  // 10. Cached Understanding Retrieval Endpoint
  app.get('/api/contracts/:id/understand', requireSessionAuth, (req: AuthenticatedRequest, res) => {
    const fileId = req.params.id;
    const sessionId = req.verifiedSession!.sessionId;

    const cacheLookup = getCachedUnderstanding(fileId, sessionId);
    if (!cacheLookup.authorized) {
      return res.status(403).json({ error: cacheLookup.error || 'Access denied: Session ownership mismatch.' });
    }

    if (!cacheLookup.exists || !cacheLookup.result) {
      return res.status(404).json({ error: cacheLookup.error || 'No understanding record found for this document.' });
    }

    return res.json(cacheLookup.result);
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
