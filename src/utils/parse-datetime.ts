import * as chrono from 'chrono-node';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = 'America/New_York';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

// Spoken number words → digit strings (multi-digit numbers stay multi-digit, e.g. "ten" → "10")
const WORD_TO_DIGIT: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  ten: '10', eleven: '11', twelve: '12', thirteen: '13',
  fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17',
  eighteen: '18', nineteen: '19', twenty: '20',
  noon: '12', midnight: '0',
  oh: '0', o: '0',   // "oh eight hundred", "o nine hundred"
};

const WORD_PATTERN = new RegExp(
  `\\b(${Object.keys(WORD_TO_DIGIT).join('|')})\\b`,
  'gi'
);

function replaceWordNumbers(s: string): string {
  return s.replace(WORD_PATTERN, (m) => WORD_TO_DIGIT[m.toLowerCase()] ?? m);
}

// ----------------------------------------------------------------

/**
 * Normalise a date string to YYYY-MM-DD.
 * Handles ISO dates, natural language ("next Wednesday", "Thursday"), etc.
 */
export function normaliseDate(input: string): string | null {
  if (!input) return null;
  const s = input.trim();

  if (DATE_RE.test(s)) return s;

  const refDate = dayjs().tz(TZ).toDate();
  const parsed = chrono.parseDate(s, refDate, { forwardDate: true });
  if (parsed) return dayjs(parsed).tz(TZ).format('YYYY-MM-DD');

  return null;
}

/**
 * Normalise a time string to HH:MM (24-hour).
 * Handles "3 PM", "Two PM", "15:00", "noon", "3", etc.
 */
export function normaliseTime(input: string): string | null {
  if (!input) return null;
  const s = input.trim();

  if (TIME_RE.test(s)) return s;

  // Convert spelled-out numbers before passing to chrono ("Two PM" → "2 PM")
  const digitised = replaceWordNumbers(s);

  const ref = chrono.parseDate(`today at ${digitised}`);
  if (ref) {
    return `${String(ref.getHours()).padStart(2, '0')}:${String(ref.getMinutes()).padStart(2, '0')}`;
  }

  // Bare hour number: "15" → "15:00"
  const bare = parseInt(digitised, 10);
  if (!isNaN(bare) && bare >= 0 && bare <= 23) {
    return `${String(bare).padStart(2, '0')}:00`;
  }

  return null;
}

/**
 * Normalise a spoken phone number to a digit string.
 * "zero four nine six seven eight nine ten" → "049678910"
 * Each number word contributes its digits directly (including "ten" → "10").
 */
export function normalisePhone(input: string): string {
  if (!input) return input;

  const withDigits = replaceWordNumbers(input);

  // Strip everything except digits and leading +
  const cleaned = withDigits.replace(/[^\d+]/g, '');
  return cleaned || input;
}
