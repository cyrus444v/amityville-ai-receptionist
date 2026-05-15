import { google } from 'googleapis';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { config } from '../config';

dayjs.extend(utc);
dayjs.extend(timezone);

function assertCalendarConfigured(): void {
  if (!config.google.serviceAccountEmail || !config.google.privateKey) {
    throw new Error(
      'Google Calendar not configured. Set GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, and GOOGLE_CALENDAR_ID.'
    );
  }
}

function getCalendarClient() {
  assertCalendarConfigured();
  const auth = new google.auth.JWT({
    email: config.google.serviceAccountEmail,
    key: config.google.privateKey,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

export interface BusyPeriod {
  start: string;
  end: string;
}

// ----------------------------------------------------------------
// Check free/busy for a time window
// ----------------------------------------------------------------
export async function checkFreeBusy(
  date: string,
  openTime: string,
  closeTime: string,
  tz: string = config.business.timezone
): Promise<BusyPeriod[]> {
  const calendar = getCalendarClient();
  const timeMin = dayjs.tz(`${date} ${openTime}`, tz).toISOString();
  const timeMax = dayjs.tz(`${date} ${closeTime}`, tz).toISOString();

  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      timeZone: tz,
      items: [{ id: config.google.calendarId }],
    },
  });

  return (res.data.calendars?.[config.google.calendarId]?.busy ?? []) as BusyPeriod[];
}

// ----------------------------------------------------------------
// Check if a specific slot is free
// ----------------------------------------------------------------
export async function isSlotAvailable(
  date: string,
  time: string,
  durationMinutes: number,
  tz: string = config.business.timezone
): Promise<boolean> {
  const calendar = getCalendarClient();
  const start = dayjs.tz(`${date} ${time}`, tz);
  const end = start.add(durationMinutes, 'minute');

  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      timeZone: tz,
      items: [{ id: config.google.calendarId }],
    },
  });

  const busy = res.data.calendars?.[config.google.calendarId]?.busy ?? [];
  return busy.length === 0;
}

// ----------------------------------------------------------------
// Get all available 30-min-increment slots within a window
// ----------------------------------------------------------------
export async function getAvailableSlots(
  date: string,
  durationMinutes: number,
  openTime: string,
  closeTime: string,
  tz: string = config.business.timezone
): Promise<string[]> {
  const busy = await checkFreeBusy(date, openTime, closeTime, tz);
  const close = dayjs.tz(`${date} ${closeTime}`, tz);

  const slots: string[] = [];
  let current = dayjs.tz(`${date} ${openTime}`, tz);

  while (!current.add(durationMinutes, 'minute').isAfter(close)) {
    const slotEnd = current.add(durationMinutes, 'minute');

    const conflict = busy.some((b) => {
      const bStart = dayjs(b.start);
      const bEnd = dayjs(b.end);
      return current.isBefore(bEnd) && slotEnd.isAfter(bStart);
    });

    if (!conflict) slots.push(current.format('HH:mm'));

    current = current.add(30, 'minute');
  }

  return slots;
}

// ----------------------------------------------------------------
// Create a Google Calendar event – returns the new event ID
// ----------------------------------------------------------------
export interface CreateEventParams {
  summary: string;
  description: string;
  date: string;
  startTime: string;
  durationMinutes: number;
  tz: string;
}

export async function createCalendarEvent(params: CreateEventParams): Promise<string> {
  const calendar = getCalendarClient();
  const start = dayjs.tz(`${params.date} ${params.startTime}`, params.tz);
  const end = start.add(params.durationMinutes, 'minute');

  const res = await calendar.events.insert({
    calendarId: config.google.calendarId,
    requestBody: {
      summary: params.summary,
      description: params.description,
      start: { dateTime: start.toISOString(), timeZone: params.tz },
      end:   { dateTime: end.toISOString(),   timeZone: params.tz },
    },
  });

  return res.data.id ?? '';
}

// ----------------------------------------------------------------
// Update an existing event's date/time
// ----------------------------------------------------------------
export async function updateCalendarEvent(
  eventId: string,
  newDate: string,
  newStartTime: string,
  durationMinutes: number,
  tz: string = config.business.timezone
): Promise<void> {
  const calendar = getCalendarClient();
  const start = dayjs.tz(`${newDate} ${newStartTime}`, tz);
  const end = start.add(durationMinutes, 'minute');

  await calendar.events.patch({
    calendarId: config.google.calendarId,
    eventId,
    requestBody: {
      start: { dateTime: start.toISOString(), timeZone: tz },
      end:   { dateTime: end.toISOString(),   timeZone: tz },
    },
  });
}

// ----------------------------------------------------------------
// Cancel (delete) an event
// ----------------------------------------------------------------
export async function cancelCalendarEvent(eventId: string): Promise<void> {
  const calendar = getCalendarClient();
  await calendar.events.delete({
    calendarId: config.google.calendarId,
    eventId,
  });
}
