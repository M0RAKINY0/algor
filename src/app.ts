import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { docsRouter } from './docs/docs.routes.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFound } from './middleware/error.js';
import { ingestRouter } from './modules/ingest/ingest.routes.js';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS }));
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(docsRouter);

  // Feature routers from src/modules mount here.
  app.use('/api/ingest', ingestRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
