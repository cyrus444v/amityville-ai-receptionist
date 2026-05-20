import { Router, Request, Response } from 'express';
import {
  CheckAvailabilitySchema,
  CreateAppointmentSchema,
  RescheduleAppointmentSchema,
  CancelAppointmentSchema,
} from '../utils/validation';
import { normaliseDate, normaliseTime, normalisePhone } from '../utils/parse-datetime';
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
    logger.error('check-availability validation failed', { body, error: parsed.error.flatten() });
    return res.json({
      success: false,
      available: false,
      error: 'INVALID_INPUT',
      message: 'I could not process that date or time. Please provide a specific date (e.g. "next Friday") and exact time (e.g. "2 PM").',
    });
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
    const detail = (err as Error).message;
    logger.error('check-availability failed', { error: detail, date, time });
    return res.json({
      success: false,
      available: false,
      error: 'SERVICE_ERROR',
      error_detail: detail,
      message: 'I was unable to check availability right now due to a technical issue. Please try again in a moment.',
    });
  }
});

// POST /create-appointment
router.post('/create-appointment', async (req: Request, res: Response) => {
  const body = { ...req.body };
  if (body.date)          body.date          = normaliseDate(body.date)          ?? body.date;
  if (body.time)          body.time          = normaliseTime(body.time)          ?? body.time;
  if (body.phone)         body.phone         = normalisePhone(body.phone)        ?? body.phone;
  if (body.date_of_birth) body.date_of_birth = normaliseDate(body.date_of_birth) ?? body.date_of_birth;

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
  const body = { ...req.body };
  if (body.new_date) body.new_date = normaliseDate(body.new_date) ?? body.new_date;
  if (body.new_time) body.new_time = normaliseTime(body.new_time) ?? body.new_time;
  if (body.phone)    body.phone    = normalisePhone(body.phone)   ?? body.phone;

  const parsed = RescheduleAppointmentSchema.safeParse(body);
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

// POST /find-appointment — look up a confirmed appointment by phone number
// Used at the start of reschedule/cancel flows to verify the appointment exists
router.post('/find-appointment', async (req: Request, res: Response) => {
  const body = { ...req.body };
  if (body.phone) body.phone = normalisePhone(body.phone) ?? body.phone;

  if (!body.phone) {
    return res.json({ found: false, message: "I couldn't find an appointment — can you double-check that phone number?" });
  }

  try {
    const { getRows, SHEET_APPOINTMENTS, APPT } = await import('../db/client');
    const rows = await getRows(SHEET_APPOINTMENTS);
    const incomingPhone = body.phone;
    logger.info('find-appointment lookup', {
      incoming: incomingPhone,
      stored_phones: rows.map(r => r.values[APPT.phone]),
    });
    const match = rows.find(({ values }) => {
      const storedPhone  = normalisePhone((values[APPT.phone]  ?? '').trim());
      const storedStatus = (values[APPT.status] ?? '').trim();
      return storedPhone === incomingPhone && storedStatus === 'confirmed';
    });

    if (!match) {
      return res.json({
        found: false,
        message: `I don't see a confirmed appointment under ${body.phone}. Could you double-check the number, or would you like to book a new appointment?`,
      });
    }

    const appt = match.values;
    return res.json({
      found: true,
      appointment_id: appt[APPT.id],
      service: appt[APPT.service_name],
      date: appt[APPT.appointment_date],
      time: appt[APPT.appointment_time],
      caller_name: appt[APPT.caller_name],
      google_event_id: appt[APPT.google_event_id],
      message: `I found your appointment: ${appt[APPT.service_name]} on ${appt[APPT.appointment_date]} at ${appt[APPT.appointment_time]}. Is that the one you'd like to reschedule?`,
    });
  } catch (err) {
    logger.error('find-appointment failed', { error: (err as Error).message });
    return res.json({ found: false, message: 'I had trouble looking that up — please try again in a moment.' });
  }
});

// POST /cancel-appointment
router.post('/cancel-appointment', async (req: Request, res: Response) => {
  const body = { ...req.body };
  if (body.phone) body.phone = normalisePhone(body.phone) ?? body.phone;

  const parsed = CancelAppointmentSchema.safeParse(body);
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
