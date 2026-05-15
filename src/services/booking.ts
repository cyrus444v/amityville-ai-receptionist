import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { config, BusinessHoursKey } from '../config';
import { getSupabaseClient } from '../db/client';
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

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('appointments')
    .insert({
      caller_name:      params.caller_name,
      phone:            params.phone,
      service_name:     params.service,
      appointment_date: params.date,
      appointment_time: params.time,
      duration_minutes: duration,
      timezone:         tz,
      google_event_id:  eventId,
      status:           'confirmed',
      email:            params.email ?? null,
      notes:            params.notes ?? null,
    })
    .select()
    .single();

  if (error) {
    logger.error('Failed to save appointment to database', { error: error.message });
    return { success: false, message: 'Calendar event created but failed to save to database.', error: 'DATABASE_ERROR' };
  }

  logger.info('Appointment created', { service: params.service, date: params.date, time: params.time });

  // Send confirmation email if address was provided (non-blocking — don't fail the booking if email fails)
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
    appointment: data as Appointment,
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
  const supabase = getSupabaseClient();

  let query = supabase
    .from('appointments')
    .select('*')
    .eq('status', 'confirmed');

  if (params.appointment_id) {
    query = query.eq('id', params.appointment_id);
  } else if (params.phone) {
    query = query.eq('phone', params.phone).order('created_at', { ascending: false }).limit(1);
  } else if (params.google_event_id) {
    query = query.eq('google_event_id', params.google_event_id);
  }

  const { data: rows, error: fetchErr } = await query;
  if (fetchErr || !rows || rows.length === 0) {
    return { success: false, message: 'Appointment not found.', error: 'NOT_FOUND' };
  }

  const appt = rows[0] as Appointment;

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

  const { data: updated, error: updateErr } = await supabase
    .from('appointments')
    .update({ appointment_date: params.new_date, appointment_time: params.new_time, status: 'rescheduled' })
    .eq('id', appt.id)
    .select()
    .single();

  if (updateErr) {
    return { success: false, message: 'Failed to update appointment record.', error: 'DATABASE_ERROR' };
  }

  logger.info('Appointment rescheduled', { id: appt.id, new_date: params.new_date, new_time: params.new_time });

  return {
    success: true,
    appointment: updated as Appointment,
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
  const supabase = getSupabaseClient();

  let query = supabase
    .from('appointments')
    .select('*')
    .eq('status', 'confirmed');

  if (params.appointment_id) {
    query = query.eq('id', params.appointment_id);
  } else if (params.phone) {
    query = query.eq('phone', params.phone).order('created_at', { ascending: false }).limit(1);
  } else if (params.google_event_id) {
    query = query.eq('google_event_id', params.google_event_id);
  }

  const { data: rows, error: fetchErr } = await query;
  if (fetchErr || !rows || rows.length === 0) {
    return { success: false, message: 'Appointment not found.', error: 'NOT_FOUND' };
  }

  const appt = rows[0] as Appointment;

  if (appt.google_event_id) {
    await cancelCalendarEvent(appt.google_event_id);
  }

  await supabase
    .from('appointments')
    .update({ status: 'cancelled' })
    .eq('id', appt.id);

  logger.info('Appointment cancelled', { id: appt.id });

  return {
    success: true,
    message: `Appointment for ${appt.caller_name} on ${appt.appointment_date} at ${appt.appointment_time} has been cancelled.`,
  };
}
