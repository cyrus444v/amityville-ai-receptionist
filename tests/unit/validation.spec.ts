import { describe, expect, it } from 'vitest';
import {
  CancelAppointmentSchema,
  CreateAppointmentSchema,
  RescheduleAppointmentSchema,
} from '../../src/utils/validation';

const valid = {
  phone: '5551234567',
  service: 'Acupuncture',
  date: '2026-08-19',
  time: '10:00',
};

describe('voice tool input validation', () => {
  it('accepts full_name and maps first_visit to the persisted field', () => {
    const parsed = CreateAppointmentSchema.parse({
      ...valid,
      full_name: 'Fixture Patient',
      first_visit: true,
      referral_source: 'Search',
      notes: 'Shoulder pain from tennis',
    });

    expect(parsed.caller_name).toBe('Fixture Patient');
    expect(parsed.is_new_patient).toBe(true);
    expect(parsed.referral_source).toBe('Search');
    expect(parsed.notes).toContain('tennis');
  });

  it('keeps caller_name and is_new_patient backward compatible', () => {
    const parsed = CreateAppointmentSchema.parse({ ...valid, caller_name: 'Legacy Caller', is_new_patient: false });
    expect(parsed.caller_name).toBe('Legacy Caller');
    expect(parsed.is_new_patient).toBe(false);
  });

  it('gives first_visit precedence when both patient flags are present', () => {
    const parsed = CreateAppointmentSchema.parse({
      ...valid,
      caller_name: 'Fixture Patient',
      is_new_patient: false,
      first_visit: true,
    });
    expect(parsed.is_new_patient).toBe(true);
  });

  it('rejects missing names and impossible dates or times', () => {
    expect(CreateAppointmentSchema.safeParse(valid).success).toBe(false);
    expect(CreateAppointmentSchema.safeParse({ ...valid, caller_name: 'A', date: '2026-02-30' }).success).toBe(false);
    expect(CreateAppointmentSchema.safeParse({ ...valid, caller_name: 'A', time: '25:00' }).success).toBe(false);
  });

  it.each([RescheduleAppointmentSchema, CancelAppointmentSchema])(
    'requires a signed selection token while accepting legacy identifiers',
    (schema) => {
      const scheduleFields = schema === RescheduleAppointmentSchema
        ? { new_date: '2026-08-19', new_time: '10:00' }
        : {};
      expect(schema.safeParse({ ...scheduleFields }).success).toBe(false);
      expect(schema.safeParse({ ...scheduleFields, phone: '5551234567' }).success).toBe(false);
      const appointment_token = 'fixture-token-at-least-20-characters';
      expect(schema.safeParse({ ...scheduleFields, phone: '5551234567', appointment_token }).success).toBe(true);
      expect(schema.safeParse({ ...scheduleFields, phone: '5551234567', appointment_id: 'appt-1', appointment_token }).success).toBe(true);
    },
  );
});
