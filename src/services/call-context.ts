import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { config, openDays } from '../config';
import type { DayKey } from '../config';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * What "now" is, in the clinic's timezone.
 *
 * This exists so that the /current-date tool and the conversation-initiation
 * webhook cannot disagree. They are two different ways of telling the same
 * agent what day it is, and an agent told "Tuesday" by one and "Wednesday" by
 * the other books the wrong appointment.
 *
 * It also exists so the agent never has to do calendar arithmetic. On 3
 * September 2026 — a Thursday — the agent was told only today, tomorrow and the
 * day after. A caller said "Wednesday", the model worked out "next Wednesday,
 * September tenth" on its own, and read that back. The 10th was a Thursday; the
 * next Wednesday was the 9th. Nothing was booked only because the clinic is
 * closed on Thursdays and check-availability answered CLOSED_DAY. On an open day
 * the caller would have been confirmed onto a day they never asked for.
 *
 * So every weekday the agent could plausibly be asked for is enumerated here,
 * already paired with its date: `days` below is a lookup table, not a starting
 * point for a calculation.
 */

export interface DayFacts {
  date: string;
  day_of_week: string;
}

/** One row of the lookup table. Every field is readable without a further step. */
export interface CalendarDay extends DayFacts {
  /** 0 is today. Present so "three days from now" needs no counting either. */
  days_from_today: number;
  /** "today", "tomorrow", or "in N days" — the same fact in words. */
  label: string;
  is_open: boolean;
  /** "09:00-17:00", or "closed". */
  hours: string;
  /** How to say this date back to the caller: "Wednesday, September 9". */
  spoken_date: string;
}

export interface CurrentDateContext {
  today: DayFacts;
  tomorrow: DayFacts;
  day_after_tomorrow: DayFacts;
  current_time: string;
  timezone: string;
  /** Today plus the next 13 days, in order. `days[0]` is always today. */
  days: CalendarDay[];
  /**
   * Weekday name -> the soonest date after today that falls on it.
   *
   * Strictly after today, so a caller who says "Wednesday" on a Wednesday is
   * never silently handed today. All seven weekdays are always present.
   */
  next_by_day_of_week: Record<string, string>;
}

const DAY_KEYS: readonly DayKey[] = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

/** How far ahead the table reaches. Two full weeks, so every weekday appears twice. */
export const CALENDAR_DAYS = 14;

function facts(moment: dayjs.Dayjs): DayFacts {
  return { date: moment.format('YYYY-MM-DD'), day_of_week: moment.format('dddd') };
}

/**
 * The calendar days are stepped in UTC, off today's date in the clinic's zone.
 *
 * A date falls on the same weekday in every timezone, and UTC has no daylight
 * saving, so `add(n, 'day')` here is plain calendar addition and stays correct
 * by construction. Stepping the zone-aware instant instead would land on the
 * right day too, but only because dayjs pins the offset at `.tz()` and adds
 * 24 hours to a fixed-offset instant — correct through a DST transition by a
 * property of the plugin rather than of the calendar. This does not depend on
 * that; `daylight saving does not shift the calendar` in the spec pins it.
 */
function calendarDay(startOfToday: dayjs.Dayjs, offset: number): CalendarDay {
  const moment = startOfToday.add(offset, 'day');
  const hours = config.business.businessHours[DAY_KEYS[moment.day()]];
  const isOpen = Boolean(hours) && !hours.closed;
  return {
    ...facts(moment),
    days_from_today: offset,
    label: offset === 0 ? 'today' : offset === 1 ? 'tomorrow' : `in ${offset} days`,
    is_open: isOpen,
    hours: isOpen ? `${hours.open}-${hours.close}` : 'closed',
    spoken_date: moment.format('dddd, MMMM D'),
  };
}

export function currentDateContext(): CurrentDateContext {
  const tz = config.business.timezone;
  const now = dayjs().tz(tz);
  const startOfToday = dayjs.utc(now.format('YYYY-MM-DD'));

  const days = Array.from({ length: CALENDAR_DAYS }, (_, offset) => calendarDay(startOfToday, offset));

  // Strictly after today, so the first occurrence of each weekday is unambiguous.
  const next: Record<string, string> = {};
  for (const day of days.slice(1)) {
    if (!next[day.day_of_week]) next[day.day_of_week] = day.date;
  }

  return {
    today: facts(startOfToday),
    tomorrow: facts(startOfToday.add(1, 'day')),
    day_after_tomorrow: facts(startOfToday.add(2, 'day')),
    current_time: now.format('HH:mm'),
    timezone: tz,
    days,
    next_by_day_of_week: next,
  };
}

/** The weekday a YYYY-MM-DD date falls on. Timezone-independent by construction. */
export function dayOfWeekFor(date: string): string {
  return dayjs.utc(date).format('dddd');
}

const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

/**
 * Reads a caller-supplied weekday out of whatever the model sent.
 *
 * Returns null for anything unrecognisable. That is deliberate: this field is a
 * cross-check, and an unparseable cross-check must fall back to no cross-check
 * rather than refuse a booking the caller is entitled to.
 */
export function parseDayOfWeek(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value.trim().toLowerCase().replace(/^(next|this|coming|on)\s+/, '').replace(/[.,]$/, '');
  if (!cleaned) return null;
  return WEEKDAY_NAMES.find(
    (name) => name.toLowerCase() === cleaned || name.slice(0, 3).toLowerCase() === cleaned,
  ) ?? null;
}

export interface DayOfWeekMismatch {
  error: 'DAY_OF_WEEK_MISMATCH';
  date: string;
  day_of_week: string;
  expected_day_of_week: string;
  /** The date the caller most likely meant: the soonest one on that weekday. */
  corrected_date: string;
  message: string;
}

/**
 * Whether a date and the weekday the caller named actually agree.
 *
 * The two arrive by independent routes — the date is the model's own conversion,
 * the weekday is what the caller said — so a disagreement means the conversion
 * is wrong. Returning it as a distinct error is the difference between a caller
 * hearing "let me check that day" and a caller being booked onto a day they
 * never asked for.
 */
export function dayOfWeekMismatch(date: string, expected: string | undefined): DayOfWeekMismatch | null {
  const wanted = parseDayOfWeek(expected);
  if (!wanted) return null;

  const actual = dayOfWeekFor(date);
  if (actual === wanted) return null;

  const corrected = currentDateContext().next_by_day_of_week[wanted];
  return {
    error: 'DAY_OF_WEEK_MISMATCH',
    date,
    day_of_week: actual,
    expected_day_of_week: wanted,
    corrected_date: corrected,
    message: `${date} is a ${actual}, not a ${wanted}. The next ${wanted} is ${corrected}. `
      + 'Ask the caller which day they meant before going any further; do not book either date yet.',
  };
}

/** Whether the clinic is open at this moment, by the same hours the booking code enforces. */
export function isOpenNow(): boolean {
  const tz = config.business.timezone;
  const now = dayjs().tz(tz);
  const hours = config.business.businessHours[DAY_KEYS[now.day()]];
  if (!hours || hours.closed) return false;
  const minutes = now.hour() * 60 + now.minute();
  const [openHour, openMinute] = hours.open.split(':').map(Number);
  const [closeHour, closeMinute] = hours.close.split(':').map(Number);
  return minutes >= openHour * 60 + openMinute && minutes < closeHour * 60 + closeMinute;
}

/**
 * The variables handed to the agent before it speaks its first word.
 *
 * Supplying today's date up front removes a tool round-trip from the opening of
 * every booking — the prompt's TOOL RULES require the date before any relative
 * date is resolved, and this satisfies that requirement at zero latency.
 *
 * Every key here must always be present. ElevenLabs requires the initiation
 * response to carry every variable the agent references, and a missing one
 * fails the call rather than degrading it.
 */
export function initiationVariables(callerId: string): Record<string, string> {
  const context = currentDateContext();
  return {
    today_date: context.today.date,
    today_day_of_week: context.today.day_of_week,
    tomorrow_date: context.tomorrow.date,
    tomorrow_day_of_week: context.tomorrow.day_of_week,
    current_time: context.current_time,
    clinic_timezone: context.timezone,
    clinic_open_now: String(isOpenNow()),
    clinic_open_days: openDays().map(({ day }) => day).join(', '),
    caller_phone: callerId,
  };
}
