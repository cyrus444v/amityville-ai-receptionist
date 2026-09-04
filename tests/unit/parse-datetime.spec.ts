import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { normaliseDate, normalisePhone, normaliseTime } from '../../src/utils/parse-datetime';

describe('date, time, and phone normalization', () => {
  beforeAll(() => vi.setSystemTime(new Date('2026-08-18T14:00:00.000Z')));
  afterAll(() => vi.useRealTimers());

  it.each([
    ['next Wednesday', '2026-08-26'],
    ['Thursday', '2026-08-20'],
    ['June 15th', '2027-06-15'],
    ['2026-08-21', '2026-08-21'],
    ['', null],
    ['2026-02-30', null],
  ])('normalises date %s', (input, expected) => {
    expect(normaliseDate(input as string)).toBe(expected);
  });

  it.each([
    ['Two PM', '14:00'],
    ['noon', '12:00'],
    ['oh eight hundred', '08:00'],
    ['15', '15:00'],
    ['15:30', '15:30'],
    ['99:99', null],
    ['not a time', null],
  ])('normalises time %s', (input, expected) => {
    expect(normaliseTime(input as string)).toBe(expected);
  });

  // The clinic the suite boots as is region US (tenants/amityville-wellness.json),
  // so the un-regioned calls below are the real default path.
  it.each([
    ['five five five, one two three, four five six seven', '+15551234567'],
    ['(555) 123-4567', '+15551234567'],
    ['+1 (555) 123-4567', '+15551234567'],
    ['5551234567', '+15551234567'],
    ['15551234567', '+15551234567'],
    ['', ''],
    ['not a number', 'not a number'],
  ])('normalises phone %s', (input, expected) => {
    expect(normalisePhone(input)).toBe(expected);
  });
});

/**
 * 2026-09-04, first end-to-end call against staging: the caller read their
 * number out as "00491742306370" and that exact string was stored. Calling
 * back, the caller ID arrived as "+491742306370", the lookup compared two
 * strings that were never going to be equal, and the caller could not find,
 * reschedule or cancel their own appointment.
 *
 * Every form of one number has to collapse to one key, in both directions, and
 * the region a bare national number is read in belongs to the clinic.
 */
describe('phone numbers reach one E.164 key from every written form', () => {
  const GERMAN = '+491742306370';
  const AMERICAN = '+16316910200';

  it('answers the incident: 00491742306370 and +491742306370 are one number', () => {
    expect(normalisePhone('00491742306370', 'US')).toBe(GERMAN);
    expect(normalisePhone('+491742306370', 'US')).toBe(GERMAN);
    expect(normalisePhone('00491742306370', 'US')).toBe(normalisePhone('+491742306370', 'US'));

    // …and the other direction: booked from the caller ID, found from the
    // number the caller reads out.
    expect(normalisePhone('+491742306370', 'DE')).toBe(GERMAN);
    expect(normalisePhone('00491742306370', 'DE')).toBe(GERMAN);
  });

  it.each([
    // A German clinic: international, 00-international, and the national form.
    ['+49 174 2306370', 'DE', GERMAN],
    ['+491742306370', 'DE', GERMAN],
    ['0049 174 2306370', 'DE', GERMAN],
    ['00491742306370', 'DE', GERMAN],
    ['0174 2306370', 'DE', GERMAN],
    ['01742306370', 'DE', GERMAN],
    ['0174 / 230 63 70', 'DE', GERMAN],
    ['zero one seven four two three zero six three seven zero', 'DE', GERMAN],
    // The same clinic, given a US number in full.
    ['+1 631 691 0200', 'DE', AMERICAN],
    ['001 631 691 0200', 'DE', AMERICAN],

    // A US clinic: the existing rule, unchanged in meaning.
    ['+1 631-691-0200', 'US', AMERICAN],
    ['+16316910200', 'US', AMERICAN],
    ['1 631 691 0200', 'US', AMERICAN],
    ['16316910200', 'US', AMERICAN],
    ['(631) 691-0200', 'US', AMERICAN],
    ['631 691 0200', 'US', AMERICAN],
    ['6316910200', 'US', AMERICAN],
    ['001 631 691 0200', 'US', AMERICAN],
    ['011 1 631 691 0200', 'US', AMERICAN],
    // The same clinic, given a German number in full — the incident's shape.
    ['+49 174 2306370', 'US', GERMAN],
    ['0049 174 2306370', 'US', GERMAN],
    ['011 49 174 2306370', 'US', GERMAN],
  ] as const)('reads %s in region %s as %s', (input, region, expected) => {
    expect(normalisePhone(input, region)).toBe(expected);
  });

  it.each([
    // Nothing to parse: unchanged, and unchanged the same way on both sides of
    // a comparison, which is all this branch owes the rest of the system.
    ['', 'US', ''],
    ['not a number', 'US', 'not a number'],
    ['abc', 'DE', 'abc'],
    ['1234', 'US', '1234'],
    // A national number from somewhere else, with nothing saying where.
    ['0174 2306370', 'US', '01742306370'],
  ] as const)('leaves %s in region %s stable as %s', (input, region, expected) => {
    expect(normalisePhone(input, region)).toBe(expected);
  });

  it('is the same function on the storing side and the looking-up side', () => {
    // Not a property of the strings but of the code path: whatever a row was
    // stored as, a lookup normalises it again on read before comparing.
    const stored = normalisePhone('00491742306370', 'US');
    const lookedUp = normalisePhone('+49 174 230 63 70', 'US');
    expect(stored).toBe(lookedUp);
    expect(normalisePhone(stored, 'US')).toBe(stored);
  });
});
