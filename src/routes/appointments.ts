import { Router, Request, Response } from 'express';
import {
  CheckAvailabilitySchema,
  CreateAppointmentSchema,
  FindAppointmentSchema,
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
import {
  callerPhoneFromRequest,
  issueAppointmentAccessToken,
  verifyAppointmentAccessToken,
} from '../services/appointment-access';
import { getServiceByName } from '../services/knowledge';

const router = Router();

// POST /check-availability
router.post('/check-availability', async (req: Request, res: Response) => {
  // Normalise natural-language date/time before validation
  const body = { ...req.body };
  if (body.date) body.date = normaliseDate(body.date) ?? body.date;
  if (body.time) body.time = normaliseTime(body.time) ?? body.time;

  const parsed = CheckAvailabilitySchema.safeParse(body);
  if (!parsed.success) {
    logger.error('check-availability validation failed', { error: parsed.error.flatten() });
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
    logger.error('check-availability failed', { error: (err as Error).message, date, time });
    return res.json({
      success: false,
      available: false,
      error: 'SERVICE_ERROR',
      message: 'I was unable to check availability right now due to a technical issue. Please try again in a moment.',
    });
  }
});

// POST /create-appointment
router.post('/create-appointment', async (req: Request, res: Response) => {
  const body = { ...req.body };
  // Alias: LLM sometimes sends full_name instead of caller_name — normalise before validation
  if (body.full_name && !body.caller_name) body.caller_name = body.full_name;
  if (body.date)          body.date          = normaliseDate(body.date)          ?? body.date;
  if (body.time)          body.time          = normaliseTime(body.time)          ?? body.time;
  if (body.phone)         body.phone         = normalisePhone(body.phone)        ?? body.phone;
  if (body.date_of_birth) body.date_of_birth = normaliseDate(body.date_of_birth) ?? body.date_of_birth;
  if (body.service) {
    const service = getServiceByName(body.service);
    if (!service) return res.status(400).json({ success: false, error: 'INVALID_SERVICE' });
    body.service = service.name;
  }

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
    const result = await rescheduleAppointment({ ...parsed.data, caller_phone: callerPhoneFromRequest(req) });
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

  if (body.appointment_date) body.appointment_date = normaliseDate(body.appointment_date) ?? body.appointment_date;
  if (body.appointment_time) body.appointment_time = normaliseTime(body.appointment_time) ?? body.appointment_time;
  const parsed = FindAppointmentSchema.safeParse(body);
  if (!parsed.success) return res.status(400).json({ found: false, error: 'INVALID_INPUT' });

  const verifiedCallerPhone = callerPhoneFromRequest(req);
  if (!verifiedCallerPhone || verifiedCallerPhone !== parsed.data.phone) {
    return res.status(403).json({
      found: false,
      error: 'CALLER_VERIFICATION_REQUIRED',
      message: 'For privacy, appointment details are available only when calling from the number used to book.',
    });
  }

  try {
    const { getRows, SHEET_APPOINTMENTS, APPT } = await import('../db/client');
    const rows = await getRows(SHEET_APPOINTMENTS);
    const incomingPhone = parsed.data.phone;
    const matches = rows.filter(({ values }) => {
      const storedPhone  = normalisePhone((values[APPT.phone]  ?? '').trim());
      const storedStatus = (values[APPT.status] ?? '').trim();
      const matchesDate = !parsed.data.appointment_date
        || (values[APPT.appointment_date] ?? '').trim() === parsed.data.appointment_date;
      const matchesTime = !parsed.data.appointment_time
        || (values[APPT.appointment_time] ?? '').trim() === parsed.data.appointment_time;
      return storedPhone === incomingPhone && storedStatus === 'confirmed' && matchesDate && matchesTime;
    });
    logger.info('find-appointment lookup completed', { match_count: matches.length });

    if (parsed.data.appointment_token) {
      const selected = matches.filter(({ values }) => verifyAppointmentAccessToken(
        parsed.data.appointment_token!,
        values[APPT.id],
        values[APPT.phone],
        verifiedCallerPhone,
      ));
      if (selected.length !== 1) {
        return res.status(403).json({ found: false, error: 'INVALID_APPOINTMENT_TOKEN' });
      }
      const appt = selected[0].values;
      return res.json({
        found: true,
        selection_required: false,
        appointment_id: appt[APPT.id],
        appointment_token: parsed.data.appointment_token,
        service: appt[APPT.service_name],
        date: appt[APPT.appointment_date],
        time: appt[APPT.appointment_time],
        caller_name: appt[APPT.caller_name],
        google_event_id: appt[APPT.google_event_id],
        message: `I found your appointment: ${appt[APPT.service_name]} on ${appt[APPT.appointment_date]} at ${appt[APPT.appointment_time]}. Is that the one you'd like to reschedule?`,
      });
    }

    if (matches.length === 0) {
      return res.json({
        found: false,
        message: 'I do not see a matching confirmed appointment. Please double-check the original date and time.',
      });
    }
    if (matches.length > 1) {
      return res.status(409).json({
        found: false,
        error: 'AMBIGUOUS_APPOINTMENT',
        message: 'More than one appointment matches. Please provide the original appointment date and exact time.',
      });
    }

    const appt = matches[0].values;
    return res.json({
      found: true,
      selection_required: true,
      appointment_id: appt[APPT.id],
      appointment_token: issueAppointmentAccessToken(appt[APPT.id], appt[APPT.phone]),
      message: 'A matching appointment was selected. Call find_appointment again with the private selection token to retrieve its details.',
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
    const result = await cancelAppointment({ ...parsed.data, caller_phone: callerPhoneFromRequest(req) });
    return res.status(result.success ? 200 : 404).json(result);
  } catch (err) {
    logger.error('cancel-appointment failed', { error: (err as Error).message });
    return res.status(500).json({ success: false, message: 'Failed to cancel appointment. Please try again.' });
  }
});

export default router;
