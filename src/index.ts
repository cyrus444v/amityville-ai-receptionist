import express from 'express';
import cors from 'cors';
import { config } from './config';
import { logger } from './utils/logger';
import { initSheets } from './db/client';
import appointmentsRouter from './routes/appointments';
import callbacksRouter from './routes/callbacks';
import toolsRouter from './routes/tools';

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'AI Receptionist Backend', timestamp: new Date().toISOString() });
});

app.use('/', appointmentsRouter);
app.use('/', callbacksRouter);
app.use('/', toolsRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', { error: err.message });
  res.status(500).json({ success: false, message: 'Internal server error' });
});

initSheets().catch((err) => {
  logger.error('Failed to initialise Google Sheets', { error: (err as Error).message });
});

const server = app.listen(config.port, () => {
  logger.info(`Server running on port ${config.port}`);
});

// Graceful shutdown — ECS sends SIGTERM before stopping the container
const shutdown = () => {
  logger.info('Shutdown signal received, closing server...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { server };
export default app;
