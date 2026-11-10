import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { query } from './db.js';
import authRouter from './routes/auth.js';
import reportsRouter from './routes/reports.js';
import forecastRouter from './routes/forecast.js';

export function createApp({ realtime }) {
  const app = express();
  app.set('trust proxy', 1); // correct client IPs for rate limiting behind a load balancer
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json({ limit: '50kb' }));

  app.get('/api/health', async (_req, res) => {
    try {
      await query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.use('/api/auth', authRouter);
  app.use('/api/reports', reportsRouter({ realtime }));
  app.use('/api/forecast', forecastRouter());

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.status && err.status < 500) {
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
