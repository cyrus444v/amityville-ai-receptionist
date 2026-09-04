import * as chrono from 'chrono-node';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { tenant } from '../config/tenant';

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

  if (DATE_RE.test(s)) {
    const [year, month, day] = s.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
      ? s
      : null;
  }

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

  if (TIME_RE.test(s)) {
    const [hour, minute] = s.split(':').map(Number);
    return hour <= 23 && minute <= 59 ? s : null;
  }

  // Convert spelled-out numbers before passing to chrono ("Two PM" → "2 PM")
  const digitised = replaceWordNumbers(s);

  const militaryWords = digitised.match(/^(\d(?:\s+\d)?|\d{2})\s+hundred$/i);
  if (militaryWords) {
    const hour = Number(militaryWords[1].replace(/\s/g, ''));
    if (hour >= 0 && hour <= 23) return `${String(hour).padStart(2, '0')}:00`;
  }

  if (!/\d/.test(digitised)) return null;

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
 * Parses one written form and returns E.164, or nothing if it does not hold a
 * phone number of a length that region could have.
 *
 * `isPossible` and not `isValid`: a number can parse and still be nonsense —
 * "00491742306370" read as a US number is fourteen digits long — and the length
 * check catches exactly that. Full validation would additionally reject the
 * 555 numbers that every fixture, demo and printed example uses.
 */
function toE164(candidate: string, region: CountryCode): string | undefined {
  const parsed = parsePhoneNumberFromString(candidate, region);
  return parsed?.isPossible() ? parsed.number : undefined;
}

/**
 * Normalise a phone number to E.164 — the single written form every stored
 * number and every lookup key is in.
 *
 * The same phone reaches us in several shapes. A caller reads it out and the
 * transcript says "00491742306370"; the same person rings in and the vendor
 * hands us the caller ID "+491742306370"; a national form arrives as
 * "0174 2306370". Those are one number, and they have to produce one string,
 * because every lookup here is a string comparison against what was stored.
 * When they did not, on 2026-09-04, the caller could not find, reschedule or
 * cancel their own appointment.
 *
 * `region` is the clinic's own, so a caller giving a national number is read as
 * a local. It defaults to the tenant's rather than being passed per call site,
 * because storing and comparing must never run under two different regions and
 * an argument at ten call sites is how they would come to.
 */
export function normalisePhone(input: string, region: CountryCode = tenant.default_phone_region): string {
  if (!input) return input;

  const spoken = replaceWordNumbers(input);

  // Everything a human or a transcript puts between the digits — spaces,
  // brackets, dots, slashes, the comma in "five five five, one two three" — is
  // dropped first. Only the leading "+" carries meaning, and only there.
  const digits = spoken.replace(/\D/g, '');
  const compact = `${/^\s*\+/.test(spoken) ? '+' : ''}${digits}`;

  // As given. libphonenumber applies the region's own trunk prefix (DE drops
  // the leading "0") and the region's own international prefix (DE "00",
  // NANP "011"), so most forms are already done here.
  const asGiven = toE164(compact, region);
  if (asGiven) return asGiven;

  // "00" is how most of the world says "+", and a caller says it regardless of
  // where they are calling: a US clinic hears "0049…" from a German patient,
  // and NANP metadata has no "00" prefix to strip. This is the incident case.
  if (digits.startsWith('00')) {
    const asInternational = toE164(`+${digits.slice(2)}`, region);
    if (asInternational) return asInternational;
  }

  // Not a phone number in this region — a national number from somewhere else
  // with no country code carries no way to know where. What matters for the
  // rest of the system is that this branch is stable, not that it is right:
  // storing and looking up both reach it and still agree with each other.
  return digits || input;
}
