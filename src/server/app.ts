import express from 'express';
import multer from 'multer';
import { runSecurityInspectionPipeline, MAX_FILE_SIZE_BYTES } from './security/pipeline';
import {
  getSecurityReport,
  deleteQuarantinedFile,
  initQuarantineStorage,
  reconcileQuarantineOnStartup,
} from './security/quarantineManager';
import {
  requireSessionAuth,
  createSignedSessionToken,
  attachSessionCookie,
  rateLimitSessionIssuance,
  verifyOriginProtection,
  AuthenticatedRequest,
} from './security/sessionAuth';
import { uploadResourceGuard } from './security/resourceProtection';
import { extractContractDocument, getCachedExtraction } from './extraction/extractionService';
import { normalizeContractDocument, getCachedNormalization } from './normalization/normalizationService';
import { understandContractDocument, getCachedUnderstanding } from './understanding/understandingService';
import { generateRiskReport, getCachedRiskReport } from './risk/riskService';
import { analyzeUploadedContract } from './analysisPipeline';
import { startClamAvDevDaemon } from './security/clamavDevDaemon';
import { demoScannerAllowed, scannerMode } from './security/scannerConfig';
import { probeScannerService } from './security/clamavServiceClient';

let runtimeReady: Promise<void> | null = null;

/**
 * One-time runtime initialisation shared by the long-running server and the serverless entry point:
 * quarantine storage, startup reconciliation, and the embedded ClamAV-protocol scanner when no
 * external ClamAV is configured.
 */
export function initServerRuntime(): Promise<void> {
  if (!runtimeReady) {
    runtimeReady = (async () => {
      initQuarantineStorage();

      // Reconcile quarantine files across restarts (purges expired >2h, restores valid)
      const reconciliation = reconcileQuarantineOnStartup();
      console.log(
        `[QuarantineReconciliation] Restored: ${reconciliation.restored}, Purged expired: ${reconciliation.purged}, Failed: ${reconciliation.failed}`
      );

      // The embedded demo scanner is NOT antivirus. It starts only when no real scanner is configured AND it was
      // explicitly enabled (ALLOW_DEMO_SCANNER=1) outside Vercel/production. Otherwise uploads report UNAVAILABLE.
      if (!process.env.CLAMAV_SCAN_URL && !process.env.CLAMAV_HOST) {
        if (demoScannerAllowed()) {
          const clamDaemon = await startClamAvDevDaemon();
          process.env.CLAMAV_HOST = clamDaemon.host;
          process.env.CLAMAV_PORT = clamDaemon.port.toString();
          console.warn(`[ClamAV] DEMO scanner enabled on ${clamDaemon.host}:${clamDaemon.port}. This is not antivirus; local development only.`);
        } else {
          console.warn('[ClamAV] No antivirus scanner configured (CLAMAV_SCAN_URL). Uploads will be reported as UNAVAILABLE and will not be analysed.');
        }
      }
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
    const antivirus: Record<string, unknown> = {
      mode,
      configured: mode !== 'none',
      // Only a real ClamAV (service or daemon) counts. The demo scanner and "none" never do.
      genuine: mode === 'clamav-service' || mode === 'clamav-tcp',
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
      routes: ['/api/auth/session', '/api/contracts/upload', '/api/contracts/:id/{security-status,extract,normalize,understand,risk-report}'],
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

        // Optional single-request mode (?analyze=1): after a CLEAN inspection, run extraction, normalization,
        // understanding and the review report in this same request. Needed on serverless hosts where separate
        // requests can land on different instances; the step-by-step endpoints below remain available.
        if (req.query.analyze === '1' && report.eligibleForContractProcessing && report.fileId) {
          const analysis = await analyzeUploadedContract(report.fileId, sessionId);
          return res.json({ ...report, analysis });
        }

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

  // 11. Contract Risk Report Endpoint (Phase 3)
  // Reuses the cached extraction -> normalization -> understanding pipeline; adds deterministic risk rules only.
  app.post('/api/contracts/:id/risk-report', requireSessionAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const fileId = req.params.id;
      const sessionId = req.verifiedSession!.sessionId;

      const response = await generateRiskReport(fileId, sessionId);
      if (!response.authorized) {
        return res.status(403).json({ error: response.error || 'Access denied: Session ownership mismatch.' });
      }
      if (!response.success || !response.report) {
        return res.status(400).json({ error: response.error || 'Risk report generation failed.' });
      }
      return res.json(response.report);
    } catch (err: any) {
      return res.status(500).json({
        error: err.message || 'Internal error during risk report generation.',
      });
    }
  });

  // 12. Cached Risk Report Retrieval Endpoint (never triggers new analysis)
  app.get('/api/contracts/:id/risk-report', requireSessionAuth, (req: AuthenticatedRequest, res) => {
    const fileId = req.params.id;
    const sessionId = req.verifiedSession!.sessionId;

    const lookup = getCachedRiskReport(fileId, sessionId);
    if (!lookup.authorized) {
      return res.status(403).json({ error: lookup.error || 'Access denied: Session ownership mismatch.' });
    }
    if (!lookup.exists || !lookup.report) {
      return res.status(404).json({ error: lookup.error || 'No risk report found for this document.' });
    }
    return res.json(lookup.report);
  });

  return app;
}
