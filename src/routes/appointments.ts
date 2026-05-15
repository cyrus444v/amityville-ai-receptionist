import { Router, Request, Response } from 'express';
import {
  CheckAvailabilitySchema,
  CreateAppointmentSchema,
  RescheduleAppointmentSchema,
  CancelAppointmentSchema,
} from '../utils/validation';
import { normaliseDate, normaliseTime } from '../utils/parse-datetime';
import {
  checkAvailability,
  createAppointment,
  rescheduleAppointment,
  cancelAppointment,
} from '../services/booking';
import { config } from '../config';
import { logger } from '../utils/logger';

const router = Router();

// POST /check-availability
router.post('/check-availability', async (req: Request, res: Response) => {
  // Normalise natural-language date/time before validation
  const body = { ...req.body };
  if (body.date) body.date = normaliseDate(body.date) ?? body.date;
  if (body.time) body.time = normaliseTime(body.time) ?? body.time;

  const parsed = CheckAvailabilitySchema.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: parsed.error.flatten() });
  }

  const { date, time, duration_minutes, timezone: tz } = parsed.data;

  try {
    const result = await checkAvailability(
      date,
      time,
      duration_minutes ?? config.business.defaultDuration,
      tz ?? config.business.timezone
    );
    return res.json({ success: true, ...result });
  } catch (err) {
    logger.error('check-availability failed', { error: (err as Error).message });
    return res.status(500).json({ success: false, message: 'Failed to check availability. Please try again.' });
  }
});

// POST /create-appointment
router.post('/create-appointment', async (req: Request, res: Response) => {
  const body = { ...req.body };
  if (body.date) body.date = normaliseDate(body.date) ?? body.date;
  if (body.time) body.time = normaliseTime(body.time) ?? body.time;

  const parsed = CreateAppointmentSchema.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: parsed.error.flatten() });
  }

  try {
    const result = await createAppointment(parsed.data);
    return res.status(result.success ? 200 : 409).json(result);
  } catch (err) {
    logger.error('create-appointment failed', { error: (err as Error).message });
    return res.status(500).json({ success: false, message: 'Failed to create appointment. Please try again.' });
  }
});

// POST /reschedule-appointment
router.post('/reschedule-appointment', async (req: Request, res: Response) => {
  const parsed = RescheduleAppointmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: parsed.error.flatten() });
  }

  try {
    const result = await rescheduleAppointment(parsed.data);
    return res.status(result.success ? 200 : 404).json(result);
  } catch (err) {
    logger.error('reschedule-appointment failed', { error: (err as Error).message });
    return res.status(500).json({ success: false, message: 'Failed to reschedule appointment. Please try again.' });
  }
});

// POST /cancel-appointment
router.post('/cancel-appointment', async (req: Request, res: Response) => {
  const parsed = CancelAppointmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: parsed.error.flatten() });
  }

  try {
    const result = await cancelAppointment(parsed.data);
    return res.status(result.success ? 200 : 404).json(result);
  } catch (err) {
    logger.error('cancel-appointment failed', { error: (err as Error).message });
    return res.status(500).json({ success: false, message: 'Failed to cancel appointment. Please try again.' });
  }
});

export default router;
