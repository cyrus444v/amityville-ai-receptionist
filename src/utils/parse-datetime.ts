import * as chrono from 'chrono-node';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = 'America/New_York';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

/**
 * Normalise a date string to YYYY-MM-DD.
 * Accepts ISO dates, natural language ("next Wednesday", "Thursday"), etc.
 * Returns null if unparseable.
 */
export function normaliseDate(input: string): string | null {
  if (!input) return null;
  const s = input.trim();

  // Already correct format
  if (DATE_RE.test(s)) return s;

  // Try chrono-node with reference time = now in Eastern
  const refDate = dayjs().tz(TZ).toDate();
  const parsed = chrono.parseDate(s, refDate, { forwardDate: true });
  if (parsed) {
    return dayjs(parsed).tz(TZ).format('YYYY-MM-DD');
  }

  return null;
}

/**
 * Normalise a time string to HH:MM (24-hour).
 * Accepts "3 PM", "15:00", "3:00 PM", "noon", "15", etc.
 * Returns null if unparseable.
 */
export function normaliseTime(input: string): string | null {
  if (!input) return null;
  const s = input.trim();

  // Already correct format
  if (TIME_RE.test(s)) return s;

  // Try chrono-node — attach an arbitrary date so it can parse time-only strings
  const ref = chrono.parseDate(`today at ${s}`);
  if (ref) {
    const h = String(ref.getHours()).padStart(2, '0');
    const m = String(ref.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }

  // Fallback: bare number like "15" → "15:00"
  const bare = parseInt(s, 10);
  if (!isNaN(bare) && bare >= 0 && bare <= 23) {
    return `${String(bare).padStart(2, '0')}:00`;
  }

  return null;
}
