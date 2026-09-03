/**
 * The 3 September 2026 near-miss, pinned.
 *
 * First test call. The caller said "Wednesday". The agent — told only today,
 * tomorrow and the day after — worked the rest out itself and read back "next
 * Wednesday, September tenth". 10 September 2026 is a Thursday. The next
 * Wednesday was the 9th. The caller said "Yes" to a day they had not asked for.
 *
 * It cost nothing only because the clinic is closed on Thursdays, so
 * check-availability answered CLOSED_DAY and no booking was written. On an open
 * day it would have been a silent misbooking: the caller told one day, the
 * calendar given another.
 *
 * These tests are deterministic. The clock is injected, never read from the
 * machine, so the scenario reproduces on any day of any year.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALENDAR_DAYS,
  currentDateContext,
  dayOfWeekFor,
  dayOfWeekMismatch,
  parseDayOfWeek,
} from '../../src/services/call-context';

/** 10:00 in America/New_York on Thursday 3 September 2026 — the morning of the call. */
const THE_MORNING_OF_THE_CALL = new Date('2026-09-03T14:00:00.000Z');

/**
 * What the fourteen days from that Thursday actually are, written out by hand
 * rather than computed, so this fixture cannot inherit a bug from the code it
 * checks. Open days are tenant #1's: closed Monday, Thursday and Sunday.
 */
const THE_FOURTEEN_DAYS = [
  { date: '2026-09-03', day_of_week: 'Thursday',  is_open: false },
  { date: '2026-09-04', day_of_week: 'Friday',    is_open: true  },
  { date: '2026-09-05', day_of_week: 'Saturday',  is_open: true  },
  { date: '2026-09-06', day_of_week: 'Sunday',    is_open: false },
  { date: '2026-09-07', day_of_week: 'Monday',    is_open: false },
  { date: '2026-09-08', day_of_week: 'Tuesday',   is_open: true  },
  { date: '2026-09-09', day_of_week: 'Wednesday', is_open: true  },
  { date: '2026-09-10', day_of_week: 'Thursday',  is_open: false },
  { date: '2026-09-11', day_of_week: 'Friday',    is_open: true  },
  { date: '2026-09-12', day_of_week: 'Saturday',  is_open: true  },
  { date: '2026-09-13', day_of_week: 'Sunday',    is_open: false },
  { date: '2026-09-14', day_of_week: 'Monday',    is_open: false },
  { date: '2026-09-15', day_of_week: 'Tuesday',   is_open: true  },
  { date: '2026-09-16', day_of_week: 'Wednesday', is_open: true  },
];

function freeze(instant: Date) {
  vi.useFakeTimers();
  vi.setSystemTime(instant);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the 3 September 2026 near-miss', () => {
  beforeEach(() => freeze(THE_MORNING_OF_THE_CALL));

  it('answers "next Wednesday" with the 9th, not the 10th', () => {
    const { next_by_day_of_week } = currentDateContext();

    expect(next_by_day_of_week.Wednesday).toBe('2026-09-09');
    expect(next_by_day_of_week.Wednesday).not.toBe('2026-09-10');
  });

  it('shows the 10th for what it is, so the wrong answer cannot be read as right', () => {
    const tenth = currentDateContext().days.find((day) => day.date === '2026-09-10');

    expect(tenth?.day_of_week).toBe('Thursday');
    expect(dayOfWeekFor('2026-09-10')).toBe('Thursday');
  });

  it('never lets the agent say a weekday the date does not carry', () => {
    // The exact sentence the agent spoke, checked against the table it now has.
    const spoken = { weekday: 'Wednesday', date: '2026-09-10' };
    const row = currentDateContext().days.find((day) => day.date === spoken.date);

    expect(row!.day_of_week).not.toBe(spoken.weekday);
    expect(row!.spoken_date).toBe('Thursday, September 10');
  });
});

describe('the calendar the agent reads from', () => {
  beforeEach(() => freeze(THE_MORNING_OF_THE_CALL));

  it('is fourteen consecutive days starting today', () => {
    const { days } = currentDateContext();

    expect(days).toHaveLength(CALENDAR_DAYS);
    expect(days.map(({ date, day_of_week, is_open }) => ({ date, day_of_week, is_open })))
      .toEqual(THE_FOURTEEN_DAYS);
  });

  it('labels today and tomorrow so neither has to be counted out', () => {
    const { days } = currentDateContext();

    expect(days[0]).toMatchObject({ label: 'today', days_from_today: 0, date: '2026-09-03' });
    expect(days[1]).toMatchObject({ label: 'tomorrow', days_from_today: 1, date: '2026-09-04' });
    expect(days[6]).toMatchObject({ label: 'in 6 days', date: '2026-09-09' });
  });

  it('carries the clinic hours the booking code enforces', () => {
    const { days } = currentDateContext();

    expect(days.find((day) => day.date === '2026-09-09')?.hours).toBe('09:00-17:00');
    expect(days.find((day) => day.date === '2026-09-05')?.hours).toBe('09:00-12:00');
    expect(days.find((day) => day.date === '2026-09-10')?.hours).toBe('closed');
  });

  it('names every weekday exactly once, and never today', () => {
    const { today, next_by_day_of_week } = currentDateContext();

    expect(Object.keys(next_by_day_of_week).sort()).toEqual([
      'Friday', 'Monday', 'Saturday', 'Sunday', 'Thursday', 'Tuesday', 'Wednesday',
    ]);
    for (const [weekday, date] of Object.entries(next_by_day_of_week)) {
      expect(dayOfWeekFor(date)).toBe(weekday);
      expect(date > today.date).toBe(true);
    }
  });

  it('agrees with today, tomorrow and the day after', () => {
    const context = currentDateContext();

    expect(context.today).toEqual({ date: '2026-09-03', day_of_week: 'Thursday' });
    expect(context.tomorrow).toEqual({ date: '2026-09-04', day_of_week: 'Friday' });
    expect(context.day_after_tomorrow).toEqual({ date: '2026-09-05', day_of_week: 'Saturday' });
    expect(context.days[0]).toMatchObject(context.today);
  });
});

/**
 * Both US transitions of 2026 fall inside a fourteen-day window, and each is
 * entered from a call placed within an hour of local midnight — where a
 * 23-hour or 25-hour day is most likely to push a naive step onto the wrong
 * date. The calendar must be fourteen distinct consecutive days either way.
 */
describe('daylight saving does not shift the calendar', () => {
  it.each([
    ['spring forward', '2026-03-07T04:45:00.000Z', '2026-03-06', '2026-03-08', 'Sunday'],
    ['fall back',      '2026-11-01T03:30:00.000Z', '2026-10-31', '2026-11-01', 'Sunday'],
  ])('keeps every calendar day across %s', (_name, instant, today, transition, weekday) => {
    freeze(new Date(instant));
    const { days } = currentDateContext();

    expect(days[0].date).toBe(today);
    const crossing = days.find((day) => day.date === transition);
    expect(crossing).toBeDefined();
    expect(crossing!.day_of_week).toBe(weekday);

    // Consecutive, with no day skipped and none repeated.
    const dates = days.map((day) => day.date);
    expect(new Set(dates).size).toBe(CALENDAR_DAYS);
    for (let i = 1; i < dates.length; i += 1) {
      const gap = Date.parse(`${dates[i]}T00:00:00Z`) - Date.parse(`${dates[i - 1]}T00:00:00Z`);
      expect(gap).toBe(24 * 60 * 60 * 1000);
    }
  });
});

describe('the weekday cross-check', () => {
  beforeEach(() => freeze(THE_MORNING_OF_THE_CALL));

  it('catches exactly the date the agent got wrong', () => {
    const mismatch = dayOfWeekMismatch('2026-09-10', 'Wednesday');

    expect(mismatch).toMatchObject({
      error: 'DAY_OF_WEEK_MISMATCH',
      date: '2026-09-10',
      day_of_week: 'Thursday',
      expected_day_of_week: 'Wednesday',
      corrected_date: '2026-09-09',
    });
    expect(mismatch!.message).toContain('2026-09-09');
  });

  it('stays out of the way when the date and the caller agree', () => {
    expect(dayOfWeekMismatch('2026-09-09', 'Wednesday')).toBeNull();
    expect(dayOfWeekMismatch('2026-09-09', 'next wednesday')).toBeNull();
    expect(dayOfWeekMismatch('2026-09-09', 'Wed')).toBeNull();
  });

  it('is skipped, not failed, when the weekday is missing or unreadable', () => {
    // A cross-check that cannot be read must never cost a caller their booking.
    for (const value of [undefined, '', '   ', 'sometime', 'the fifteenth', 'Wenesday']) {
      expect(dayOfWeekMismatch('2026-09-10', value)).toBeNull();
    }
  });

  it('reads the weekday out of what a model actually sends', () => {
    expect(parseDayOfWeek('Wednesday')).toBe('Wednesday');
    expect(parseDayOfWeek('  next  Wednesday  ')).toBe('Wednesday');
    expect(parseDayOfWeek('next Wednesday')).toBe('Wednesday');
    expect(parseDayOfWeek('this friday')).toBe('Friday');
    expect(parseDayOfWeek('SAT')).toBe('Saturday');
    expect(parseDayOfWeek('tomorrow')).toBeNull();
  });
});
