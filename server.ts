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
} from './src/server/security/quarantineManager';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  initQuarantineStorage();

  const app = express();
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const isProd = process.env.NODE_ENV === 'production';

  app.use(express.json());

  // Configure Multer memory storage (never write untrusted files to public disk)
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_FILE_SIZE_BYTES, // 20 MB
    },
  });

  // 1. Upload & Security Inspection Endpoint
  app.post(
    '/api/contracts/upload',
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
    async (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: 'No contract file provided.' });
        }

        const sessionId = (req.headers['x-session-id'] as string) || 'default-session';
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

  // 2. Security Status Retrieval Endpoint
  app.get('/api/contracts/:id/security-status', (req, res) => {
    const fileId = req.params.id;
    const sessionId = (req.headers['x-session-id'] as string) || 'default-session';

    const { report, authorized } = getSecurityReport(fileId, sessionId);

    if (!authorized) {
      return res.status(403).json({ error: 'Access denied: Unauthorized session.' });
    }

    if (!report) {
      return res.status(404).json({ error: 'Security report not found for specified file ID.' });
    }

    return res.json(report);
  });

  // 3. Secure File Deletion Endpoint
  app.delete('/api/contracts/:id', (req, res) => {
    const fileId = req.params.id;
    const sessionId = (req.headers['x-session-id'] as string) || 'default-session';

    const { success, authorized } = deleteQuarantinedFile(fileId, sessionId);

    if (!authorized) {
      return res.status(403).json({ error: 'Access denied: Unauthorized session.' });
    }

    if (!success) {
      return res.status(404).json({ error: 'File not found or already deleted.' });
    }

    return res.json({ success: true, message: 'Document securely deleted from quarantine.' });
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
    console.log(`Contract Reviewer server running on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
