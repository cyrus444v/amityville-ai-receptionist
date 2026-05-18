import crypto from 'crypto';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { config, BusinessHoursKey } from '../config';
import { appendRow, getRows, updateRowAtIndex, APPT, SHEET_APPOINTMENTS } from '../db/client';
import {
  isSlotAvailable,
  getAvailableSlots,
  createCalendarEvent,
  updateCalendarEvent,
  cancelCalendarEvent,
} from './calendar';
import { logger } from '../utils/logger';
import { sendBookingConfirmation } from './email';
import type { Appointment, AvailabilityResult, BookingResult } from '../types';

dayjs.extend(utc);
dayjs.extend(timezone);

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
function getDayKey(date: string, tz: string): BusinessHoursKey {
  return dayjs.tz(date, tz).format('dddd').toLowerCase() as BusinessHoursKey;
}

function isWithinBusinessHours(date: string, time: string, tz: string): boolean {
  const key = getDayKey(date, tz);
  const hours = config.business.businessHours[key];
  if (!hours || hours.closed) return false;

  const toMinutes = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };

  const req   = toMinutes(time);
  const open  = toMinutes(hours.open);
  const close = toMinutes(hours.close);

  return req >= open && req < close;
}

function businessHoursMessage(): string {
  return (
    `We are open Monday–Friday 9 AM–6 PM (Friday until 5 PM), ` +
    `and Saturday 10 AM–3 PM. We are closed on Sundays.`
  );
}

function rowToAppointment(values: string[]): Appointment {
  const get = (i: number) => values[i] ?? '';
  return {
    id:               get(APPT.id),
    caller_name:      get(APPT.caller_name),
    phone:            get(APPT.phone),
    email:            get(APPT.email) || undefined,
    date_of_birth:    get(APPT.date_of_birth) || undefined,
    is_new_patient:   get(APPT.is_new_patient) === 'true' ? true : get(APPT.is_new_patient) === 'false' ? false : undefined,
    service_name:     get(APPT.service_name),
    appointment_date: get(APPT.appointment_date),
    appointment_time: get(APPT.appointment_time),
    duration_minutes: parseInt(get(APPT.duration_minutes) || '60', 10),
    timezone:         get(APPT.timezone),
    status:           (get(APPT.status) as Appointment['status']) || 'confirmed',
    notes:            get(APPT.notes) || undefined,
    google_event_id:  get(APPT.google_event_id) || undefined,
    created_at:       get(APPT.created_at),
    updated_at:       get(APPT.updated_at),
  };
}

function appointmentToRow(appt: Appointment): (string | number | null)[] {
  const row: (string | number | null)[] = new Array(16).fill('');
  row[APPT.id]               = appt.id;
  row[APPT.caller_name]      = appt.caller_name;
  row[APPT.phone]            = appt.phone;
  row[APPT.email]            = appt.email ?? '';
  row[APPT.date_of_birth]    = appt.date_of_birth ?? '';
  row[APPT.is_new_patient]   = appt.is_new_patient !== undefined ? String(appt.is_new_patient) : '';
  row[APPT.service_name]     = appt.service_name;
  row[APPT.appointment_date] = appt.appointment_date;
  row[APPT.appointment_time] = appt.appointment_time;
  row[APPT.duration_minutes] = appt.duration_minutes;
  row[APPT.timezone]         = appt.timezone;
  row[APPT.status]           = appt.status;
  row[APPT.notes]            = appt.notes ?? '';
  row[APPT.google_event_id]  = appt.google_event_id ?? '';
  row[APPT.created_at]       = appt.created_at;
  row[APPT.updated_at]       = appt.updated_at;
  return row;
}

// ----------------------------------------------------------------
// Check availability
// ----------------------------------------------------------------
export async function checkAvailability(
  date: string,
  time?: string,
  durationMinutes: number = config.business.defaultDuration,
  tz: string = config.business.timezone
): Promise<AvailabilityResult> {
  const today = dayjs.tz(new Date().toISOString(), tz).startOf('day');
  if (dayjs.tz(date, tz).isBefore(today)) {
    return { available: false, message: 'Cannot book appointments in the past.' };
  }

  const key = getDayKey(date, tz);
  const hours = config.business.businessHours[key];

  if (!hours || hours.closed) {
    return { available: false, message: `We are closed on ${dayjs.tz(date, tz).format('dddd')}s. ${businessHoursMessage()}` };
  }

  if (time) {
    if (!isWithinBusinessHours(date, time, tz)) {
      return { available: false, message: `That time is outside our business hours. ${businessHoursMessage()}` };
    }

    const available = await isSlotAvailable(date, time, durationMinutes, tz);
    if (available) {
      return { available: true, message: `${date} at ${time} is available.` };
    }

    const slots = await getAvailableSlots(date, durationMinutes, hours.open, hours.close, tz);
    const slotsMsg = slots.length > 0
      ? ` Other available times on ${date}: ${slots.slice(0, 5).join(', ')}.`
      : ` There are no other available slots on ${date}.`;

    return {
      available: false,
      slots: slots.map((s) => ({ date, time: s, available: true })),
      message: `${date} at ${time} is not available.${slotsMsg}`,
    };
  }

  const slots = await getAvailableSlots(date, durationMinutes, hours.open, hours.close, tz);
  if (slots.length === 0) {
    return { available: false, message: `There are no available slots on ${date}.` };
  }

  return {
    available: true,
    slots: slots.map((s) => ({ date, time: s, available: true })),
    message: `Available times on ${date}: ${slots.slice(0, 6).join(', ')}.`,
  };
}

// ----------------------------------------------------------------
// Create appointment
// ----------------------------------------------------------------
export async function createAppointment(params: {
  caller_name: string;
  phone: string;
  email?: string;
  date_of_birth?: string;
  is_new_patient?: boolean;
  service: string;
  date: string;
  time: string;
  duration_minutes?: number;
  timezone?: string;
  notes?: string;
}): Promise<BookingResult> {
  const tz = params.timezone || config.business.timezone;
  const duration = params.duration_minutes || config.business.defaultDuration;

  if (!isWithinBusinessHours(params.date, params.time, tz)) {
    return { success: false, message: `Requested time is outside business hours. ${businessHoursMessage()}`, error: 'OUTSIDE_BUSINESS_HOURS' };
  }

  const available = await isSlotAvailable(params.date, params.time, duration, tz);
  if (!available) {
    return {
      success: false,
      message: `${params.date} at ${params.time} is no longer available. Please choose another time.`,
      error: 'SLOT_NOT_AVAILABLE',
    };
  }

  const eventId = await createCalendarEvent({
    summary:         `${params.service} – ${params.caller_name}`,
    description:     `Patient: ${params.caller_name}\nService: ${params.service}\nNotes: ${params.notes || 'None'}`,
    date:            params.date,
    startTime:       params.time,
    durationMinutes: duration,
    tz,
  });

  const now = new Date().toISOString();
  const appointment: Appointment = {
    id:               crypto.randomUUID(),
    caller_name:      params.caller_name,
    phone:            params.phone,
    email:            params.email,
    date_of_birth:    params.date_of_birth,
    is_new_patient:   params.is_new_patient,
    service_name:     params.service,
    appointment_date: params.date,
    appointment_time: params.time,
    duration_minutes: duration,
    timezone:         tz,
    google_event_id:  eventId,
    status:           'confirmed',
    notes:            params.notes,
    created_at:       now,
    updated_at:       now,
  };

  try {
    await appendRow(SHEET_APPOINTMENTS, appointmentToRow(appointment));
  } catch (err) {
    logger.error('Failed to save appointment to sheet', { error: (err as Error).message });
    return { success: false, message: 'Calendar event created but failed to save to database.', error: 'DATABASE_ERROR' };
  }

  logger.info('Appointment created', { service: params.service, date: params.date, time: params.time });

  // Send confirmation email (non-blocking)
  if (params.email) {
    sendBookingConfirmation({
      to:               params.email,
      caller_name:      params.caller_name,
      service:          params.service,
      date:             params.date,
      time:             params.time,
      duration_minutes: duration,
    }).catch((err) => logger.error('Confirmation email failed', { error: (err as Error).message }));
  }

  return {
    success: true,
    appointment,
    message: `Appointment confirmed for ${params.caller_name} on ${params.date} at ${params.time} for ${params.service}.${params.email ? ' A confirmation email has been sent.' : ''}`,
  };
}

// ----------------------------------------------------------------
// Reschedule appointment
// ----------------------------------------------------------------
export async function rescheduleAppointment(params: {
  appointment_id?: string;
  phone?: string;
  google_event_id?: string;
  new_date: string;
  new_time: string;
  timezone?: string;
}): Promise<BookingResult> {
  const tz = params.timezone || config.business.timezone;

  const rows = await getRows(SHEET_APPOINTMENTS);
  const match = rows.find(({ values }) => {
    if (values[APPT.status] !== 'confirmed') return false;
    if (params.appointment_id) return values[APPT.id] === params.appointment_id;
    if (params.phone) return values[APPT.phone] === params.phone;
    if (params.google_event_id) return values[APPT.google_event_id] === params.google_event_id;
    return false;
  }) ?? rows.filter(({ values }) => values[APPT.status] === 'confirmed').at(-1);
  // fallback: last confirmed row when phone lookup should match but no explicit key given

  if (!match) {
    return { success: false, message: 'Appointment not found.', error: 'NOT_FOUND' };
  }

  const appt = rowToAppointment(match.values);

  if (!isWithinBusinessHours(params.new_date, params.new_time, tz)) {
    return { success: false, message: `New time is outside business hours. ${businessHoursMessage()}`, error: 'OUTSIDE_BUSINESS_HOURS' };
  }

  const available = await isSlotAvailable(params.new_date, params.new_time, appt.duration_minutes, tz);
  if (!available) {
    return { success: false, message: `${params.new_date} at ${params.new_time} is not available.`, error: 'SLOT_NOT_AVAILABLE' };
  }

  if (appt.google_event_id) {
    await updateCalendarEvent(appt.google_event_id, params.new_date, params.new_time, appt.duration_minutes, tz);
  }

  const updated: Appointment = {
    ...appt,
    appointment_date: params.new_date,
    appointment_time: params.new_time,
    status: 'rescheduled',
    updated_at: new Date().toISOString(),
  };

  try {
    await updateRowAtIndex(SHEET_APPOINTMENTS, match.rowIndex, appointmentToRow(updated));
  } catch (err) {
    logger.error('Failed to update appointment in sheet', { error: (err as Error).message });
    return { success: false, message: 'Failed to update appointment record.', error: 'DATABASE_ERROR' };
  }

  logger.info('Appointment rescheduled', { id: appt.id, new_date: params.new_date, new_time: params.new_time });

  return {
    success: true,
    appointment: updated,
    message: `Appointment rescheduled to ${params.new_date} at ${params.new_time}.`,
  };
}

// ----------------------------------------------------------------
// Cancel appointment
// ----------------------------------------------------------------
export async function cancelAppointment(params: {
  appointment_id?: string;
  phone?: string;
  google_event_id?: string;
}): Promise<BookingResult> {
  const rows = await getRows(SHEET_APPOINTMENTS);
  const match = rows.find(({ values }) => {
    if (values[APPT.status] !== 'confirmed') return false;
    if (params.appointment_id) return values[APPT.id] === params.appointment_id;
    if (params.phone) return values[APPT.phone] === params.phone;
    if (params.google_event_id) return values[APPT.google_event_id] === params.google_event_id;
    return false;
  });

  if (!match) {
    return { success: false, message: 'Appointment not found.', error: 'NOT_FOUND' };
  }

  const appt = rowToAppointment(match.values);

  if (appt.google_event_id) {
    await cancelCalendarEvent(appt.google_event_id);
  }

  const cancelled: Appointment = {
    ...appt,
    status: 'cancelled',
    updated_at: new Date().toISOString(),
  };

  try {
    await updateRowAtIndex(SHEET_APPOINTMENTS, match.rowIndex, appointmentToRow(cancelled));
  } catch (err) {
    logger.error('Failed to cancel appointment in sheet', { error: (err as Error).message });
  }

  logger.info('Appointment cancelled', { id: appt.id });

  return {
    success: true,
    message: `Appointment for ${appt.caller_name} on ${appt.appointment_date} at ${appt.appointment_time} has been cancelled.`,
  };
}
