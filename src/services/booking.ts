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
import { normalisePhone } from '../utils/parse-datetime';
import { verifyAppointmentAccessToken } from './appointment-access';
import {
  acquireCoordinationKeys,
  coordinationKey,
  listCoordinationRecords,
  putCoordinationRecord,
  releaseCoordinationKeys,
  updateCoordinationState,
} from './coordination';
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

function isPastDate(date: string, tz: string): boolean {
  return dayjs.tz(date, tz).isBefore(dayjs().tz(tz).startOf('day'));
}

function businessHoursMessage(): string {
  const hours = config.business.businessHours;
  const days = Object.entries(hours)
    .filter(([, v]) => !v.closed)
    .map(([day, v]) => {
      const fmt = (t: string) => {
        const [h, m] = t.split(':').map(Number);
        const period = h < 12 ? 'AM' : 'PM';
        const hour = h % 12 === 0 ? 12 : h % 12;
        return m === 0 ? `${hour} ${period}` : `${hour}:${String(m).padStart(2, '0')} ${period}`;
      };
      return `${day.charAt(0).toUpperCase() + day.slice(1)} ${fmt(v.open)}–${fmt(v.close)}`;
    });
  return `Our hours are: ${days.join(', ')}.`;
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
    referral_source:  get(APPT.referral_source) || undefined,
  };
}

function appointmentToRow(appt: Appointment): (string | number | null)[] {
  const row: (string | number | null)[] = new Array(17).fill('');
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
  row[APPT.referral_source]  = appt.referral_source ?? '';
  return row;
}

function combinedNotes(params: CreateAppointmentParams): string | undefined {
  const notes = [
    params.notes?.trim(),
    params.sport?.trim() ? `Sport: ${params.sport.trim()}` : undefined,
    params.injury?.trim() ? `Injury: ${params.injury.trim()}` : undefined,
    params.accident?.trim() ? `Accident: ${params.accident.trim()}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return notes.length > 0 ? notes.join('\n') : undefined;
}

function appointmentIdentity(params: CreateAppointmentParams): string {
  return crypto.createHash('sha256').update([
    normalisePhone(params.phone),
    params.service.trim().toLowerCase(),
    params.date,
    params.time,
  ].join('|')).digest('hex');
}

function rowIdentity(values: string[]): string {
  return crypto.createHash('sha256').update([
    normalisePhone(values[APPT.phone] ?? ''),
    (values[APPT.service_name] ?? '').trim().toLowerCase(),
    (values[APPT.appointment_date] ?? '').trim(),
    (values[APPT.appointment_time] ?? '').trim(),
  ].join('|')).digest('hex');
}

function slotCoordinationKeys(date: string, time: string, durationMinutes: number, tz: string): string[] {
  const start = dayjs.tz(`${date} ${time}`, tz);
  const keys: string[] = [];
  for (let offset = 0; offset < durationMinutes; offset += 10) {
    keys.push(coordinationKey('appointment-slot', `${tz}|${start.add(offset, 'minute').format('YYYY-MM-DD|HH:mm')}`));
  }
  return keys;
}

function reservationExpiry(date: string, time: string, durationMinutes: number, tz: string): number {
  return dayjs.tz(`${date} ${time}`, tz).add(durationMinutes, 'minute').add(1, 'day').valueOf();
}

function authorizedAppointmentMatch(
  values: string[],
  params: {
    appointment_token: string;
    caller_phone?: string;
    appointment_id?: string;
    phone?: string;
    google_event_id?: string;
  },
): boolean {
  if ((values[APPT.status] ?? '').trim() !== 'confirmed') return false;
  if (params.appointment_id && (values[APPT.id] ?? '').trim() !== params.appointment_id) return false;
  if (params.phone && normalisePhone(values[APPT.phone] ?? '') !== normalisePhone(params.phone)) return false;
  if (params.google_event_id && (values[APPT.google_event_id] ?? '').trim() !== params.google_event_id) return false;
  return verifyAppointmentAccessToken(
    params.appointment_token,
    values[APPT.id] ?? '',
    values[APPT.phone] ?? '',
    params.caller_phone,
  );
}

interface MutationOperationData {
  type: 'reschedule' | 'cancel';
  appointmentId: string;
  rowIndex: number;
  eventId?: string;
  oldDate: string;
  oldTime: string;
  newDate?: string;
  newTime?: string;
  durationMinutes: number;
  timezone: string;
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
    return { available: false, status: 'PAST_DATE', message: 'Cannot book appointments in the past.' };
  }

  const key = getDayKey(date, tz);
  const hours = config.business.businessHours[key];

  if (!hours || hours.closed) {
    return { available: false, status: 'CLOSED_DAY', message: `We are closed on ${dayjs.tz(date, tz).format('dddd')}s. ${businessHoursMessage()}` };
  }

  if (time) {
    if (!isWithinBusinessHours(date, time, tz)) {
      return { available: false, status: 'OUTSIDE_HOURS', message: `That time is outside our business hours. ${businessHoursMessage()}` };
    }

    const available = await isSlotAvailable(date, time, durationMinutes, tz);
    if (available) {
      return { available: true, status: 'AVAILABLE', message: `${date} at ${time} is available. Proceed with booking.` };
    }

    const slots = await getAvailableSlots(date, durationMinutes, hours.open, hours.close, tz);
    const slotsMsg = slots.length > 0
      ? ` Other available times on ${date}: ${slots.slice(0, 5).join(', ')}.`
      : ` There are no other available slots on ${date}.`;

    return {
      available: false,
      status: 'NOT_AVAILABLE',
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
export interface CreateAppointmentParams {
  caller_name?: string;
  full_name?: string;
  phone: string;
  email?: string;
  date_of_birth?: string;
  is_new_patient?: boolean;
  first_visit?: boolean;
  referral_source?: string;
  service: string;
  date: string;
  time: string;
  duration_minutes?: number;
  timezone?: string;
  notes?: string;
  sport?: string;
  injury?: string;
  accident?: string;
}

const appointmentWrites = new Map<string, Promise<BookingResult>>();

export async function createAppointment(params: CreateAppointmentParams): Promise<BookingResult> {
  const identity = appointmentIdentity(params);
  const existingWrite = appointmentWrites.get(identity);
  if (existingWrite) return existingWrite;

  const write = createAppointmentOnce(params).finally(() => {
    if (appointmentWrites.get(identity) === write) appointmentWrites.delete(identity);
  });
  appointmentWrites.set(identity, write);
  return write;
}

async function createAppointmentOnce(params: CreateAppointmentParams): Promise<BookingResult> {
  const callerName = params.caller_name?.trim() || params.full_name?.trim();
  if (!callerName) {
    return { success: false, message: 'Caller name is required.', error: 'INVALID_INPUT' };
  }

  const tz = params.timezone || config.business.timezone;
  const duration = params.duration_minutes || config.business.defaultDuration;
  const identity = appointmentIdentity(params);
  const writeOwner = crypto.randomUUID();
  let rows: Awaited<ReturnType<typeof getRows>>;
  try {
    rows = await getRows(SHEET_APPOINTMENTS);
  } catch (err) {
    logger.error('Failed to check appointment idempotency', { error: (err as Error).message });
    return { success: false, message: 'Failed to verify appointment state.', error: 'DATABASE_ERROR' };
  }

  const duplicate = rows.find(({ values }) =>
    (values[APPT.status] ?? '').trim() === 'confirmed' && rowIdentity(values) === identity
  );
  if (duplicate) {
    return {
      success: true,
      appointment: rowToAppointment(duplicate.values),
      message: 'This appointment was already confirmed.',
    };
  }


  if (isPastDate(params.date, tz)) {
    return { success: false, message: 'Cannot book appointments in the past.', error: 'PAST_DATE' };
  }

  if (!isWithinBusinessHours(params.date, params.time, tz)) {
    return { success: false, message: `Requested time is outside business hours. ${businessHoursMessage()}`, error: 'OUTSIDE_BUSINESS_HOURS' };
  }

  const reservationKeys = [
    coordinationKey('appointment-write', identity),
    ...slotCoordinationKeys(params.date, params.time, duration, tz),
  ];
  let reserved: boolean;
  try {
    reserved = await acquireCoordinationKeys(
      reservationKeys,
      writeOwner,
      reservationExpiry(params.date, params.time, duration, tz),
    );
  } catch (err) {
    logger.error('Failed to acquire appointment reservation', { error: (err as Error).message });
    return { success: false, message: 'Failed to reserve the appointment slot.', error: 'COORDINATION_ERROR' };
  }
  if (!reserved) {
    return { success: false, message: 'That appointment is already booked or being confirmed.', error: 'SLOT_NOT_AVAILABLE' };
  }

  let available: boolean;
  try {
    available = await isSlotAvailable(params.date, params.time, duration, tz);
  } catch (err) {
    await releaseCoordinationKeys(reservationKeys, writeOwner);
    throw err;
  }
  if (!available) {
    await releaseCoordinationKeys(reservationKeys, writeOwner);
    return {
      success: false,
      message: `${params.date} at ${params.time} is no longer available. Please choose another time.`,
      error: 'SLOT_NOT_AVAILABLE',
    };
  }

  const notes = combinedNotes(params);
  let eventId: string;
  try {
    eventId = await createCalendarEvent({
      summary:         `${params.service} – ${callerName}`,
      description:     `Patient: ${callerName}\nService: ${params.service}\nNotes: ${notes || 'None'}`,
      date:            params.date,
      startTime:       params.time,
      durationMinutes: duration,
      tz,
    });
  } catch (err) {
    await releaseCoordinationKeys(reservationKeys, writeOwner);
    throw err;
  }

  const now = new Date().toISOString();
  const appointment: Appointment = {
    id:               crypto.randomUUID(),
    caller_name:      callerName,
    phone:            params.phone,
    email:            params.email,
    date_of_birth:    params.date_of_birth,
    is_new_patient:   params.first_visit ?? params.is_new_patient,
    referral_source:  params.referral_source,
    service_name:     params.service,
    appointment_date: params.date,
    appointment_time: params.time,
    duration_minutes: duration,
    timezone:         tz,
    google_event_id:  eventId,
    status:           'confirmed',
    notes,
    created_at:       now,
    updated_at:       now,
  };

  try {
    await appendRow(SHEET_APPOINTMENTS, appointmentToRow(appointment));
  } catch (err) {
    logger.error('Failed to save appointment to sheet', { error: (err as Error).message });
    try {
      if (eventId) await cancelCalendarEvent(eventId);
    } catch (cleanupError) {
      logger.error('Failed to roll back orphaned calendar event', { error: (cleanupError as Error).message });
    }
    await releaseCoordinationKeys(reservationKeys, writeOwner);
    return { success: false, message: 'Failed to save appointment.', error: 'DATABASE_ERROR' };
  }

  logger.info('Appointment created', { service: params.service, date: params.date, time: params.time });

  // Send confirmation email (non-blocking)
  if (params.email) {
    sendBookingConfirmation({
      to:               params.email,
      caller_name:      callerName,
      service:          params.service,
      date:             params.date,
      time:             params.time,
      duration_minutes: duration,
    }).catch((err) => logger.error('Confirmation email failed', { error: (err as Error).message }));
  }

  return {
    success: true,
    appointment,
    message: `Appointment confirmed for ${callerName} on ${params.date} at ${params.time} for ${params.service}.${params.email ? ' A confirmation email has been sent.' : ''}`,
  };
}

// ----------------------------------------------------------------
// Reschedule appointment
// ----------------------------------------------------------------
export async function rescheduleAppointment(params: {
  appointment_id?: string;
  phone?: string;
  google_event_id?: string;
  appointment_token: string;
  caller_phone?: string;
  new_date: string;
  new_time: string;
  timezone?: string;
}): Promise<BookingResult> {
  const tz = params.timezone || config.business.timezone;

  const rows = await getRows(SHEET_APPOINTMENTS);
  const matches = rows.filter(({ values }) => authorizedAppointmentMatch(values, params));

  if (matches.length !== 1) {
    return { success: false, message: 'Verified appointment not found.', error: 'NOT_FOUND' };
  }
  const match = matches[0];

  const appt = rowToAppointment(match.values);

  if (isPastDate(params.new_date, tz)) {
    return { success: false, message: 'Cannot reschedule appointments into the past.', error: 'PAST_DATE' };
  }

  if (!isWithinBusinessHours(params.new_date, params.new_time, tz)) {
    return { success: false, message: `New time is outside business hours. ${businessHoursMessage()}`, error: 'OUTSIDE_BUSINESS_HOURS' };
  }

  const owner = crypto.randomUUID();
  const mutationKey = coordinationKey('appointment-mutation', appt.id);
  const newSlotKeys = slotCoordinationKeys(params.new_date, params.new_time, appt.duration_minutes, tz);
  const claimedKeys = [mutationKey, ...newSlotKeys];
  const claimed = await acquireCoordinationKeys(
    claimedKeys,
    owner,
    reservationExpiry(params.new_date, params.new_time, appt.duration_minutes, tz),
  );
  if (!claimed) {
    return { success: false, message: 'That appointment or time is already being changed.', error: 'CONFLICT' };
  }

  let available: boolean;
  try {
    available = await isSlotAvailable(params.new_date, params.new_time, appt.duration_minutes, tz);
  } catch (err) {
    await releaseCoordinationKeys(claimedKeys, owner);
    throw err;
  }
  if (!available) {
    await releaseCoordinationKeys(claimedKeys, owner);
    return { success: false, message: `${params.new_date} at ${params.new_time} is not available.`, error: 'SLOT_NOT_AVAILABLE' };
  }

  const updated: Appointment = {
    ...appt,
    appointment_date: params.new_date,
    appointment_time: params.new_time,
    status: 'confirmed',
    updated_at: new Date().toISOString(),
  };

  const operationKey = coordinationKey('appointment-operation', `${appt.id}|reschedule|${owner}`);
  const operationExpires = Date.now() + 7 * 24 * 60 * 60_000;
  const operationData: MutationOperationData = {
    type: 'reschedule',
    appointmentId: appt.id,
    rowIndex: match.rowIndex,
    eventId: appt.google_event_id,
    oldDate: appt.appointment_date,
    oldTime: appt.appointment_time,
    newDate: params.new_date,
    newTime: params.new_time,
    durationMinutes: appt.duration_minutes,
    timezone: tz,
  };
  await putCoordinationRecord(operationKey, {
    owner,
    state: 'pending',
    expiresAt: operationExpires,
    data: JSON.stringify(operationData),
  });

  try {
    await updateRowAtIndex(SHEET_APPOINTMENTS, match.rowIndex, appointmentToRow(updated));
  } catch (err) {
    logger.error('Failed to update appointment in sheet', { error: (err as Error).message });
    await updateCoordinationState(operationKey, owner, 'sheet_failed');
    await releaseCoordinationKeys(claimedKeys, owner);
    return { success: false, message: 'Failed to update appointment record.', error: 'DATABASE_ERROR' };
  }

  await updateCoordinationState(operationKey, owner, 'sheet_updated');
  try {
    if (appt.google_event_id) {
      await updateCalendarEvent(appt.google_event_id, params.new_date, params.new_time, appt.duration_minutes, tz);
    }
  } catch (err) {
    logger.error('Failed to reschedule calendar event', { error: (err as Error).message });
    try {
      await updateRowAtIndex(SHEET_APPOINTMENTS, match.rowIndex, appointmentToRow(appt));
      await updateCoordinationState(operationKey, owner, 'rolled_back');
      await releaseCoordinationKeys(claimedKeys, owner);
      return { success: false, message: 'The calendar could not be updated; no changes were kept.', error: 'CALENDAR_ERROR' };
    } catch (rollbackError) {
      logger.error('Reschedule requires reconciliation', { error: (rollbackError as Error).message, id: appt.id });
      await updateCoordinationState(operationKey, owner, 'reconciliation_required');
      return { success: false, message: 'The appointment change requires staff reconciliation.', error: 'CONSISTENCY_ERROR' };
    }
  }

  await updateCoordinationState(operationKey, owner, 'calendar_updated');
  await releaseCoordinationKeys(slotCoordinationKeys(appt.appointment_date, appt.appointment_time, appt.duration_minutes, appt.timezone));
  await releaseCoordinationKeys([mutationKey], owner);
  await updateCoordinationState(operationKey, owner, 'completed');

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
  appointment_token: string;
  caller_phone?: string;
}): Promise<BookingResult> {
  const rows = await getRows(SHEET_APPOINTMENTS);
  const matches = rows.filter(({ values }) => authorizedAppointmentMatch(values, params));

  if (matches.length !== 1) {
    return { success: false, message: 'Verified appointment not found.', error: 'NOT_FOUND' };
  }
  const match = matches[0];

  const appt = rowToAppointment(match.values);

  const cancelled: Appointment = {
    ...appt,
    status: 'cancelled',
    updated_at: new Date().toISOString(),
  };

  const owner = crypto.randomUUID();
  const mutationKey = coordinationKey('appointment-mutation', appt.id);
  const operationKey = coordinationKey('appointment-operation', `${appt.id}|cancel|${owner}`);
  const operationExpires = Date.now() + 7 * 24 * 60 * 60_000;
  const claimed = await acquireCoordinationKeys([mutationKey], owner, operationExpires);
  if (!claimed) return { success: false, message: 'That appointment is already being changed.', error: 'CONFLICT' };
  const operationData: MutationOperationData = {
    type: 'cancel',
    appointmentId: appt.id,
    rowIndex: match.rowIndex,
    eventId: appt.google_event_id,
    oldDate: appt.appointment_date,
    oldTime: appt.appointment_time,
    durationMinutes: appt.duration_minutes,
    timezone: appt.timezone,
  };
  await putCoordinationRecord(operationKey, {
    owner,
    state: 'pending',
    expiresAt: operationExpires,
    data: JSON.stringify(operationData),
  });

  try {
    await updateRowAtIndex(SHEET_APPOINTMENTS, match.rowIndex, appointmentToRow(cancelled));
  } catch (err) {
    logger.error('Failed to cancel appointment in sheet', { error: (err as Error).message });
    await updateCoordinationState(operationKey, owner, 'sheet_failed');
    await releaseCoordinationKeys([mutationKey], owner);
    return { success: false, message: 'Failed to cancel appointment record.', error: 'DATABASE_ERROR' };
  }

  await updateCoordinationState(operationKey, owner, 'sheet_updated');
  try {
    if (appt.google_event_id) await cancelCalendarEvent(appt.google_event_id);
  } catch (err) {
    logger.error('Failed to cancel calendar event', { error: (err as Error).message });
    try {
      await updateRowAtIndex(SHEET_APPOINTMENTS, match.rowIndex, appointmentToRow(appt));
      await updateCoordinationState(operationKey, owner, 'rolled_back');
      await releaseCoordinationKeys([mutationKey], owner);
      return { success: false, message: 'The calendar could not be cancelled; no changes were kept.', error: 'CALENDAR_ERROR' };
    } catch (rollbackError) {
      logger.error('Cancellation requires reconciliation', { error: (rollbackError as Error).message, id: appt.id });
      await updateCoordinationState(operationKey, owner, 'reconciliation_required');
      return { success: false, message: 'The cancellation requires staff reconciliation.', error: 'CONSISTENCY_ERROR' };
    }
  }

  await updateCoordinationState(operationKey, owner, 'calendar_updated');
  await releaseCoordinationKeys(slotCoordinationKeys(appt.appointment_date, appt.appointment_time, appt.duration_minutes, appt.timezone));
  await releaseCoordinationKeys([mutationKey], owner);
  await updateCoordinationState(operationKey, owner, 'completed');

  logger.info('Appointment cancelled', { id: appt.id });

  return {
    success: true,
    message: `Appointment for ${appt.caller_name} on ${appt.appointment_date} at ${appt.appointment_time} has been cancelled.`,
  };
}

export async function reconcilePendingAppointmentMutations(): Promise<void> {
  const operations = await listCoordinationRecords('appointment-operation#');
  for (const { key, record } of operations) {
    if (!record.data || ['completed', 'rolled_back', 'sheet_failed'].includes(record.state ?? '')) continue;
    let operation: MutationOperationData;
    try {
      operation = JSON.parse(record.data) as MutationOperationData;
    } catch {
      await updateCoordinationState(key, record.owner, 'invalid_operation');
      continue;
    }

    try {
      const rows = await getRows(SHEET_APPOINTMENTS);
      const match = rows.find(({ values }) => (values[APPT.id] ?? '') === operation.appointmentId);
      if (!match) throw new Error('Appointment row no longer exists.');
      const current = rowToAppointment(match.values);

      if (operation.type === 'reschedule') {
        const desired: Appointment = {
          ...current,
          appointment_date: operation.newDate!,
          appointment_time: operation.newTime!,
          status: 'confirmed',
          updated_at: new Date().toISOString(),
        };
        await updateRowAtIndex(SHEET_APPOINTMENTS, match.rowIndex, appointmentToRow(desired));
        if (operation.eventId) {
          await updateCalendarEvent(
            operation.eventId,
            operation.newDate!,
            operation.newTime!,
            operation.durationMinutes,
            operation.timezone,
          );
        }
        await releaseCoordinationKeys(slotCoordinationKeys(
          operation.oldDate,
          operation.oldTime,
          operation.durationMinutes,
          operation.timezone,
        ));
      } else {
        const desired: Appointment = {
          ...current,
          status: 'cancelled',
          updated_at: new Date().toISOString(),
        };
        await updateRowAtIndex(SHEET_APPOINTMENTS, match.rowIndex, appointmentToRow(desired));
        if (operation.eventId) await cancelCalendarEvent(operation.eventId);
        await releaseCoordinationKeys(slotCoordinationKeys(
          operation.oldDate,
          operation.oldTime,
          operation.durationMinutes,
          operation.timezone,
        ));
      }

      await updateCoordinationState(key, record.owner, 'completed');
      await releaseCoordinationKeys([coordinationKey('appointment-mutation', operation.appointmentId)]);
    } catch (err) {
      logger.error('Appointment mutation reconciliation deferred', {
        error: (err as Error).message,
        id: operation.appointmentId,
      });
      await updateCoordinationState(key, record.owner, 'reconciliation_required').catch(() => undefined);
    }
  }
}
