import express from 'express';
import cors from 'cors';
import { config, assertProductionSecurityConfig } from './config';
import { logger } from './utils/logger';
import { initSheets } from './db/client';
import appointmentsRouter from './routes/appointments';
import callbacksRouter from './routes/callbacks';
import toolsRouter from './routes/tools';
import retellRouter from './routes/retell';
import { toolAuth } from './middleware/tool-auth';
import { createRateLimiter } from './middleware/rate-limit';
import { createIdempotencyMiddleware } from './middleware/idempotency';
import { reconcilePendingAppointmentMutations } from './services/booking';

const protectedToolPaths = [
  '/current-date', '/check-availability', '/create-appointment', '/reschedule-appointment',
  '/cancel-appointment', '/find-appointment', '/create-callback',
  '/search-services', '/health/dependencies',
].flatMap((path) => [path, `/v1${path}`]);

const writeToolPaths = [
  '/create-appointment', '/reschedule-appointment', '/cancel-appointment', '/create-callback',
].flatMap((path) => [path, `/v1${path}`]);

export function createApp(): express.Express {
  assertProductionSecurityConfig();
  const app = express();
  app.set('trust proxy', config.security.trustProxy);

  app.use(cors({
    origin(origin, callback) {
      const allowed = !origin
        || config.security.allowedOrigins.includes('*')
        || config.security.allowedOrigins.includes(origin);
      callback(null, allowed);
    },
  }));
  app.use(express.json({
    limit: config.security.requestBodyLimit,
    verify(req, _res, buffer) {
      (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  }));

  const rateLimiter = createRateLimiter({
    windowMs: config.security.rateLimitWindowMs,
    max: config.security.rateLimitMax,
  });
  app.use(protectedToolPaths, toolAuth, rateLimiter);
  app.use(writeToolPaths, createIdempotencyMiddleware({ ttlMs: config.security.idempotencyTtlMs }));

  app.get('/', (_req, res) => {
    res.json({ status: 'ok', service: 'AI Receptionist Backend', timestamp: new Date().toISOString() });
  });

  app.use(retellRouter);

  for (const prefix of ['/', '/v1']) {
    app.use(prefix, appointmentsRouter);
    app.use(prefix, callbacksRouter);
    app.use(prefix, toolsRouter);
  }

  app.use((err: Error & { status?: number; type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err.status === 413 || err.type === 'entity.too.large') {
      res.status(413).json({ success: false, error: 'REQUEST_TOO_LARGE' });
      return;
    }
    if (err.status === 400) {
      res.status(400).json({ success: false, error: 'INVALID_JSON' });
      return;
    }
    logger.error('Unhandled error', { error: err.message });
    res.status(500).json({ success: false, message: 'Internal server error' });
  });

  return app;
}

export const app = createApp();

export function startServer() {
  assertProductionSecurityConfig();
  const reconcile = () => reconcilePendingAppointmentMutations().catch((err) => {
    logger.error('Failed to reconcile appointment mutations', { error: (err as Error).message });
  });
  initSheets().then(reconcile).catch((err) => {
    logger.error('Failed to initialise Google Sheets', { error: (err as Error).message });
  });
  const reconciliationTimer = setInterval(reconcile, 60_000);
  reconciliationTimer.unref();

  const server = app.listen(config.port, () => {
    logger.info(`Server running on port ${config.port}`);
  });

  // Graceful shutdown — ECS sends SIGTERM before stopping the container
  const shutdown = () => {
    clearInterval(reconciliationTimer);
    logger.info('Shutdown signal received, closing server...');
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

if (require.main === module) startServer();

export default app;
