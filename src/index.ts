import express from 'express';
import cors from 'cors';
import { config } from './config';
import { logger } from './utils/logger';
import appointmentsRouter from './routes/appointments';
import callbacksRouter from './routes/callbacks';
import toolsRouter from './routes/tools';

const app = express();

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'AI Receptionist Backend',
    timestamp: new Date().toISOString(),
  });
});

// Retell AI tool endpoints
app.use('/', appointmentsRouter);  // /check-availability, /create-appointment, /reschedule-appointment, /cancel-appointment
app.use('/', callbacksRouter);      // /create-callback

// Utility endpoints
app.use('/', toolsRouter);          // /search-services, /services, /clinic-info

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', { error: err.message });
  res.status(500).json({ success: false, message: 'Internal server error' });
});

const server = app.listen(config.port, () => {
  logger.info(`Server running on port ${config.port}`);

  // Self-ping every 10 minutes to prevent Render free-tier cold starts during active use.
  // Remove this once upgraded to a paid Render plan with "always on" enabled.
  if (process.env.SELF_PING_URL) {
    setInterval(() => {
      fetch(process.env.SELF_PING_URL as string).catch(() => {/* silent */});
    }, 10 * 60 * 1000);
  }
});

export { server };

export default app;
