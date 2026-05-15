import { z } from 'zod';

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
const timeRegex = /^\d{2}:\d{2}$/;

export const CheckAvailabilitySchema = z.object({
  date:             z.string().regex(dateRegex, 'Date must be YYYY-MM-DD'),
  time:             z.string().regex(timeRegex, 'Time must be HH:MM').optional(),
  service:          z.string().optional(),
  duration_minutes: z.number().int().min(15).max(480).optional(),
  timezone:         z.string().optional(),
});

export const CreateAppointmentSchema = z.object({
  caller_name:      z.string().min(1, 'Name is required').max(100),
  phone:            z.string().min(7, 'Valid phone number required').max(30),
  email:            z.string().email('Invalid email address').optional(),
  service:          z.string().min(1, 'Service is required'),
  date:             z.string().regex(dateRegex, 'Date must be YYYY-MM-DD'),
  time:             z.string().regex(timeRegex, 'Time must be HH:MM'),
  duration_minutes: z.number().int().min(15).max(480).optional(),
  timezone:         z.string().optional(),
  notes:            z.string().max(500).optional(),
});

export const RescheduleAppointmentSchema = z.object({
  appointment_id:  z.string().optional(),
  phone:           z.string().optional(),
  google_event_id: z.string().optional(),
  new_date:        z.string().regex(dateRegex, 'Date must be YYYY-MM-DD'),
  new_time:        z.string().regex(timeRegex, 'Time must be HH:MM'),
  timezone:        z.string().optional(),
}).refine(
  (d) => d.appointment_id || d.phone || d.google_event_id,
  { message: 'Provide appointment_id, phone, or google_event_id to identify the appointment' }
);

export const CancelAppointmentSchema = z.object({
  appointment_id:  z.string().optional(),
  phone:           z.string().optional(),
  google_event_id: z.string().optional(),
}).refine(
  (d) => d.appointment_id || d.phone || d.google_event_id,
  { message: 'Provide appointment_id, phone, or google_event_id to identify the appointment' }
);

export const CreateCallbackSchema = z.object({
  caller_name: z.string().min(1, 'Name is required').max(100),
  phone:       z.string().min(7, 'Valid phone number required').max(30),
  reason:      z.string().max(500).optional(),
});

export type CheckAvailabilityInput      = z.infer<typeof CheckAvailabilitySchema>;
export type CreateAppointmentInput      = z.infer<typeof CreateAppointmentSchema>;
export type RescheduleAppointmentInput  = z.infer<typeof RescheduleAppointmentSchema>;
export type CancelAppointmentInput      = z.infer<typeof CancelAppointmentSchema>;
export type CreateCallbackInput         = z.infer<typeof CreateCallbackSchema>;
