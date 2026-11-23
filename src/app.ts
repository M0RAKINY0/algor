import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { docsRouter } from './docs/docs.routes.js';
import { logger as defaultLogger } from './lib/logger.js';
import { errorHandler, notFound } from './middleware/error.js';
import { feedRouter } from './modules/feed/feed.routes.js';
import { ingestRouter } from './modules/ingest/ingest.routes.js';
import { rankingRouter } from './modules/ranking/ranking.routes.js';
import { eventsRouter, signalsRouter } from './modules/signals/signals.routes.js';

export function createApp(options?: { logger?: Logger }) {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS }));
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger: options?.logger ?? defaultLogger }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(docsRouter);

  // Feature routers from src/modules mount here.
  app.use('/api/ingest', ingestRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/signals', signalsRouter);
  app.use('/api/feed', feedRouter);
  app.use('/api/ranking', rankingRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
