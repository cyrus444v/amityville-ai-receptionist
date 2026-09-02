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
 */

export interface DayFacts {
  date: string;
  day_of_week: string;
}

export interface CurrentDateContext {
  today: DayFacts;
  tomorrow: DayFacts;
  day_after_tomorrow: DayFacts;
  current_time: string;
  timezone: string;
}

const DAY_KEYS: readonly DayKey[] = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

function facts(moment: dayjs.Dayjs): DayFacts {
  return { date: moment.format('YYYY-MM-DD'), day_of_week: moment.format('dddd') };
}

export function currentDateContext(): CurrentDateContext {
  const tz = config.business.timezone;
  const now = dayjs().tz(tz);
  return {
    today: facts(now),
    tomorrow: facts(now.add(1, 'day')),
    day_after_tomorrow: facts(now.add(2, 'day')),
    current_time: now.format('HH:mm'),
    timezone: tz,
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
