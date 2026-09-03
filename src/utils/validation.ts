import { z } from 'zod';

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
const timeRegex = /^\d{2}:\d{2}$/;

function isRealDate(value: string): boolean {
  if (!dateRegex.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function isRealTime(value: string): boolean {
  if (!timeRegex.test(value)) return false;
  const [hour, minute] = value.split(':').map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

const dateField = z.string().refine(isRealDate, 'Date must be a valid YYYY-MM-DD date');
const timeField = z.string().refine(isRealTime, 'Time must be a valid HH:MM time');

/**
 * The weekday the caller named, in their own words ("Wednesday", "next Wed").
 *
 * Optional, and deliberately not validated as an enum: an unrecognised value is
 * treated as absent rather than as a rejection. See dayOfWeekMismatch.
 */
const expectedDayOfWeekField = z.string().max(20).optional();

export const CheckAvailabilitySchema = z.object({
  date:                 dateField,
  time:                 timeField.optional(),
  service:              z.string().optional(),
  duration_minutes:     z.number().int().min(15).max(480).optional(),
  timezone:             z.string().optional(),
  expected_day_of_week: expectedDayOfWeekField,
});

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

export const CreateAppointmentSchema = z.object({
  caller_name:      optionalText(100),
  full_name:        optionalText(100),
  phone:            z.string().min(4, 'Phone number required').max(30),
  date_of_birth:    z.string().optional(), // YYYY-MM-DD or spoken e.g. "January 5th 1990"
  email:            z.string().email('Invalid email address').optional(),
  is_new_patient:   z.boolean().optional(),
  first_visit:      z.boolean().optional(),
  referral_source:  optionalText(200),
  service:          z.string().min(1, 'Service is required'),
  date:             dateField,
  time:             timeField,
  duration_minutes: z.number().int().min(15).max(480).optional(),
  timezone:         z.string().optional(),
  notes:            z.string().max(500).optional(),
  expected_day_of_week: expectedDayOfWeekField,
  sport:            optionalText(100),
  injury:           optionalText(300),
  accident:         optionalText(300),
}).refine(
  (data) => Boolean(data.caller_name || data.full_name),
  { message: 'Name is required', path: ['caller_name'] },
).transform((data) => ({
  ...data,
  caller_name: data.caller_name ?? data.full_name!,
  is_new_patient: data.first_visit ?? data.is_new_patient,
}));

export const FindAppointmentSchema = z.object({
  phone:            z.string().min(4, 'Phone number required').max(30),
  appointment_date: dateField.optional(),
  appointment_time: timeField.optional(),
  appointment_token: z.string().min(20).optional(),
});

export const RescheduleAppointmentSchema = z.object({
  appointment_id:  z.string().optional(),
  phone:           z.string().optional(),
  google_event_id: z.string().optional(),
  appointment_token: z.string().min(20, 'Appointment selection token required'),
  new_date:        dateField,
  new_time:        timeField,
  timezone:        z.string().optional(),
});

export const CancelAppointmentSchema = z.object({
  appointment_id:  z.string().optional(),
  phone:           z.string().optional(),
  google_event_id: z.string().optional(),
  appointment_token: z.string().min(20, 'Appointment selection token required'),
});

export const CreateCallbackSchema = z.object({
  caller_name: z.string().min(1, 'Name is required').max(100),
  phone:       z.string().min(4, 'Phone number required').max(30),
});

export type CheckAvailabilityInput      = z.infer<typeof CheckAvailabilitySchema>;
export type CreateAppointmentInput      = z.infer<typeof CreateAppointmentSchema>;
export type FindAppointmentInput        = z.infer<typeof FindAppointmentSchema>;
export type RescheduleAppointmentInput  = z.infer<typeof RescheduleAppointmentSchema>;
export type CancelAppointmentInput      = z.infer<typeof CancelAppointmentSchema>;
export type CreateCallbackInput         = z.infer<typeof CreateCallbackSchema>;
