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

  it.each([
    ['five five five, one two three, four five six seven', '5551234567'],
    ['(555) 123-4567', '5551234567'],
    ['+1 (555) 123-4567', '5551234567'],
    ['', ''],
  ])('normalises phone %s', (input, expected) => {
    expect(normalisePhone(input)).toBe(expected);
  });
});
