import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../../src/db/client')>('../../src/db/client');
  return { ...actual, appendRow: vi.fn(), getRows: vi.fn(), updateRowAtIndex: vi.fn() };
});
vi.mock('../../src/services/calendar', () => ({
  isSlotAvailable: vi.fn(),
  getAvailableSlots: vi.fn(),
  createCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
  cancelCalendarEvent: vi.fn(),
}));
vi.mock('../../src/services/email', () => ({ sendBookingConfirmation: vi.fn(async () => undefined) }));

import { APPT, appendRow, getRows, updateRowAtIndex } from '../../src/db/client';
import {
  cancelCalendarEvent,
  createCalendarEvent,
  getAvailableSlots,
  isSlotAvailable,
  updateCalendarEvent,
} from '../../src/services/calendar';
import {
  cancelAppointment,
  checkAvailability,
  createAppointment,
  reconcilePendingAppointmentMutations,
  rescheduleAppointment,
} from '../../src/services/booking';
import { issueAppointmentAccessToken } from '../../src/services/appointment-access';
import { resetMemoryCoordinationForTests } from '../../src/services/coordination';

function appointmentRow(overrides: Record<number, string> = {}): string[] {
  const row = new Array(17).fill('');
  row[APPT.id] = 'appt-existing';
  row[APPT.caller_name] = 'Fixture Patient';
  row[APPT.phone] = '5551234567';
  row[APPT.service_name] = 'Acupuncture';
  row[APPT.appointment_date] = '2026-08-19';
  row[APPT.appointment_time] = '10:00';
  row[APPT.duration_minutes] = '60';
  row[APPT.timezone] = 'America/New_York';
  row[APPT.status] = 'confirmed';
  row[APPT.google_event_id] = 'event-existing';
  row[APPT.created_at] = '2026-08-18T12:00:00.000Z';
  row[APPT.updated_at] = '2026-08-18T12:00:00.000Z';
  for (const [index, value] of Object.entries(overrides)) row[Number(index)] = value;
  return row;
}

const createInput = {
  full_name: 'Fixture Patient',
  phone: '5551234567',
  service: 'Acupuncture',
  date: '2026-08-19',
  time: '10:00',
  first_visit: true,
  referral_source: 'Search',
  notes: 'Shoulder pain',
  sport: 'Tennis',
  injury: 'Rotator cuff',
  accident: 'None reported',
};

describe('booking service', () => {
  beforeEach(() => {
    resetMemoryCoordinationForTests();
    vi.setSystemTime(new Date('2026-08-18T12:00:00.000Z'));
    vi.mocked(getRows).mockResolvedValue([]);
    vi.mocked(isSlotAvailable).mockResolvedValue(true);
    vi.mocked(getAvailableSlots).mockResolvedValue([]);
    vi.mocked(createCalendarEvent).mockResolvedValue('event-new');
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('creates once and persists every Retell field in append-only columns', async () => {
    const result = await createAppointment(createInput);
    expect(result.success).toBe(true);
    expect(createCalendarEvent).toHaveBeenCalledTimes(1);
    expect(appendRow).toHaveBeenCalledTimes(1);
    const row = vi.mocked(appendRow).mock.calls[0][1];
    expect(row[APPT.caller_name]).toBe('Fixture Patient');
    expect(row[APPT.is_new_patient]).toBe('true');
    expect(row[APPT.referral_source]).toBe('Search');
    expect(row[APPT.notes]).toContain('Shoulder pain');
    expect(row[APPT.notes]).toContain('Sport: Tennis');
    expect(row[APPT.notes]).toContain('Injury: Rotator cuff');
    expect(row[APPT.notes]).toContain('Accident: None reported');
  });

  it('returns an existing confirmed appointment on a deterministic retry', async () => {
    const first = await createAppointment(createInput);
    expect(first.success).toBe(true);
    vi.mocked(getRows).mockResolvedValue([{ rowIndex: 2, values: appointmentRow({ [APPT.referral_source]: 'Search' }) }]);
    const second = await createAppointment(createInput);
    expect(second.success).toBe(true);
    expect(second.appointment?.id).toBe('appt-existing');
    expect(createCalendarEvent).toHaveBeenCalledTimes(1);
    expect(appendRow).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent identical writes', async () => {
    let release!: (rows: []) => void;
    vi.mocked(getRows).mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const first = createAppointment(createInput);
    const second = createAppointment(createInput);
    release([]);
    const [a, b] = await Promise.all([first, second]);
    expect(a.appointment?.id).toBe(b.appointment?.id);
    expect(createCalendarEvent).toHaveBeenCalledTimes(1);
    expect(appendRow).toHaveBeenCalledTimes(1);
  });

  it('rolls back the Calendar event when persistence fails', async () => {
    vi.mocked(appendRow).mockRejectedValueOnce(new Error('fixture sheet failure'));
    const result = await createAppointment(createInput);
    expect(result.error).toBe('DATABASE_ERROR');
    expect(cancelCalendarEvent).toHaveBeenCalledWith('event-new');
  });

  it('causes zero mutation after a reschedule lookup miss', async () => {
    vi.mocked(getRows).mockResolvedValue([{ rowIndex: 2, values: appointmentRow() }]);
    const result = await rescheduleAppointment({
      phone: '5559999999',
      caller_phone: '5551234567',
      appointment_token: issueAppointmentAccessToken('appt-existing', '5551234567'),
      new_date: '2026-08-21',
      new_time: '10:00',
    });
    expect(result.error).toBe('NOT_FOUND');
    expect(updateCalendarEvent).not.toHaveBeenCalled();
    expect(updateRowAtIndex).not.toHaveBeenCalled();
    expect(isSlotAvailable).not.toHaveBeenCalled();
  });

  it('causes zero mutation for a valid token presented from a different caller number', async () => {
    vi.mocked(getRows).mockResolvedValue([{ rowIndex: 2, values: appointmentRow() }]);
    const result = await rescheduleAppointment({
      appointment_id: 'appt-existing',
      caller_phone: '5559999999',
      appointment_token: issueAppointmentAccessToken('appt-existing', '5551234567'),
      new_date: '2026-08-21',
      new_time: '10:00',
    });
    expect(result.error).toBe('NOT_FOUND');
    expect(updateCalendarEvent).not.toHaveBeenCalled();
    expect(updateRowAtIndex).not.toHaveBeenCalled();
    expect(isSlotAvailable).not.toHaveBeenCalled();
  });

  it('reschedules a matching confirmed appointment', async () => {
    vi.mocked(getRows).mockResolvedValue([{ rowIndex: 2, values: appointmentRow() }]);
    const result = await rescheduleAppointment({
      appointment_id: 'appt-existing',
      caller_phone: '5551234567',
      appointment_token: issueAppointmentAccessToken('appt-existing', '5551234567'),
      new_date: '2026-08-21',
      new_time: '10:00',
    });
    expect(result.success).toBe(true);
    expect(updateCalendarEvent).toHaveBeenCalledWith('event-existing', '2026-08-21', '10:00', 60, 'America/New_York');
    expect(updateRowAtIndex).toHaveBeenCalledTimes(1);
  });

  it('does not mutate on cancellation miss and cancels an exact match', async () => {
    vi.mocked(getRows).mockResolvedValue([{ rowIndex: 2, values: appointmentRow() }]);
    const token = issueAppointmentAccessToken('appt-existing', '5551234567');
    const miss = await cancelAppointment({ appointment_id: 'missing', appointment_token: token, caller_phone: '5551234567' });
    expect(miss.error).toBe('NOT_FOUND');
    expect(cancelCalendarEvent).not.toHaveBeenCalled();
    expect(updateRowAtIndex).not.toHaveBeenCalled();

    const found = await cancelAppointment({ appointment_id: 'appt-existing', appointment_token: token, caller_phone: '5551234567' });
    expect(found.success).toBe(true);
    expect(cancelCalendarEvent).toHaveBeenCalledWith('event-existing');
    expect(updateRowAtIndex).toHaveBeenCalledTimes(1);
  });

  it('allows only one distributed reservation for concurrent overlapping bookings', async () => {
    const first = createAppointment(createInput);
    const second = createAppointment({ ...createInput, phone: '5559990000', time: '10:10' });
    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(createCalendarEvent).toHaveBeenCalledTimes(1);
    expect(appendRow).toHaveBeenCalledTimes(1);
  });

  it('rolls back the sheet when a reschedule calendar update fails', async () => {
    vi.mocked(getRows).mockResolvedValue([{ rowIndex: 2, values: appointmentRow() }]);
    vi.mocked(updateCalendarEvent).mockRejectedValueOnce(new Error('fixture calendar failure'));
    const result = await rescheduleAppointment({
      appointment_id: 'appt-existing',
      appointment_token: issueAppointmentAccessToken('appt-existing', '5551234567'),
      caller_phone: '5551234567',
      new_date: '2026-08-21',
      new_time: '10:00',
    });
    expect(result.error).toBe('CALENDAR_ERROR');
    expect(updateRowAtIndex).toHaveBeenCalledTimes(2);
    expect(vi.mocked(updateRowAtIndex).mock.calls[1][2][APPT.appointment_date]).toBe('2026-08-19');
  });

  it('rolls back the sheet and reports failure when Calendar cancellation fails', async () => {
    vi.mocked(getRows).mockResolvedValue([{ rowIndex: 2, values: appointmentRow() }]);
    vi.mocked(cancelCalendarEvent).mockRejectedValueOnce(new Error('fixture calendar failure'));
    const result = await cancelAppointment({
      appointment_id: 'appt-existing',
      appointment_token: issueAppointmentAccessToken('appt-existing', '5551234567'),
      caller_phone: '5551234567',
    });
    expect(result.error).toBe('CALENDAR_ERROR');
    expect(updateRowAtIndex).toHaveBeenCalledTimes(2);
    expect(vi.mocked(updateRowAtIndex).mock.calls[1][2][APPT.status]).toBe('confirmed');
  });

  it('durably reconciles a reschedule after both Calendar and immediate rollback fail', async () => {
    vi.mocked(getRows).mockResolvedValue([{ rowIndex: 2, values: appointmentRow() }]);
    vi.mocked(updateCalendarEvent).mockRejectedValueOnce(new Error('fixture calendar failure'));
    vi.mocked(updateRowAtIndex)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('fixture rollback failure'));
    const input = {
      appointment_id: 'appt-existing',
      appointment_token: issueAppointmentAccessToken('appt-existing', '5551234567'),
      caller_phone: '5551234567',
      new_date: '2026-08-21',
      new_time: '10:00',
    };
    const result = await rescheduleAppointment(input);
    expect(result.error).toBe('CONSISTENCY_ERROR');

    vi.mocked(updateRowAtIndex).mockResolvedValue(undefined);
    vi.mocked(updateCalendarEvent).mockResolvedValue(undefined);
    await reconcilePendingAppointmentMutations();
    expect(updateCalendarEvent).toHaveBeenLastCalledWith(
      'event-existing', '2026-08-21', '10:00', 60, 'America/New_York',
    );
  });

  it('rejects past, closed-day, and outside-hours requests before Calendar mutation', async () => {
    const past = await createAppointment({ ...createInput, date: '2026-08-11' });
    const closed = await createAppointment({ ...createInput, date: '2026-08-20' });
    const late = await createAppointment({ ...createInput, time: '18:00' });
    expect([past.error, closed.error, late.error]).toEqual(['PAST_DATE', 'OUTSIDE_BUSINESS_HOURS', 'OUTSIDE_BUSINESS_HOURS']);
    expect(createCalendarEvent).not.toHaveBeenCalled();
    expect(appendRow).not.toHaveBeenCalled();
  });

  it('normalizes availability outcomes without writes', async () => {
    const past = await checkAvailability('2026-08-11', '10:00');
    const closed = await checkAvailability('2026-08-20', '10:00');
    expect(past.status).toBe('PAST_DATE');
    expect(closed.status).toBe('CLOSED_DAY');
    expect(createCalendarEvent).not.toHaveBeenCalled();
  });
});
