import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { config } from './config.js';
import { pool } from './db.js';
import authRoutes from './routes/auth.js';
import documentRoutes from './routes/documents.js';
import userRoutes from './routes/users.js';
import auditRoutes from './routes/audit.js';

export function createApp() {
  const app = express();
  // Number of proxies in front of the API, so req.ip is the real client (rate limits, audit log).
  // Local: 1 (the Next.js dev proxy). Vercel -> Render: 2.
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cookieParser());
  app.use(express.json({ limit: '3mb' }));   // 3 face frames as JPEG data URLs

  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true, faceMode: config.face.mode });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/documents', documentRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/audit', auditRoutes);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // Errors -> JSON. Database rule violations become readable 409s, so the
  // triggers' own messages reach the user (e.g. "time lock: ... cannot be released before ...").
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${config.maxUploadBytes / 1048576} MB` : err.message;
      return res.status(400).json({ error: msg });
    }
    if (err.code === '23514' || err.code === '23505' || err.code === '42501') {
      return res.status(409).json({ error: err.message });
    }
    if (err.code === '23503') return res.status(400).json({ error: 'Referenced record does not exist' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Server error' : err.message, ...(err.extra || {}) });
  });

  return app;
}
