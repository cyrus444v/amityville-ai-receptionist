export interface Appointment {
  id: string;
  caller_name: string;
  phone: string;
  email?: string;
  service_id?: string;
  service_name: string;
  appointment_date: string;   // YYYY-MM-DD
  appointment_time: string;   // HH:MM
  duration_minutes: number;
  timezone: string;
  google_event_id?: string;
  status: 'confirmed' | 'cancelled' | 'rescheduled';
  notes?: string;
  created_at: string;
  updated_at: string;
}

export interface Callback {
  id: string;
  caller_name: string;
  phone: string;
  reason?: string;
  status: 'pending' | 'completed' | 'missed';
  created_at: string;
  updated_at: string;
}

export interface Service {
  service_id: string;
  name: string;
  category: string;
  keywords: string[];
  short_description: string;
  duration_minutes?: number;
}

export interface TimeSlot {
  date: string;
  time: string;
  available: boolean;
}

export interface AvailabilityResult {
  available: boolean;
  slots?: TimeSlot[];
  message: string;
}

export interface BookingResult {
  success: boolean;
  appointment?: Appointment;
  message: string;
  error?: string;
}

export interface BusinessHours {
  open: string;
  close: string;
  closed: boolean;
}
