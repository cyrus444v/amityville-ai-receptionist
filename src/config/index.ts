import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),

  google: {
    serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
    privateKey: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
  },

  supabase: {
    url: process.env.SUPABASE_URL || '',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },

  business: {
    name: process.env.BUSINESS_NAME || 'Amityville Holistic Center',
    timezone: process.env.TIMEZONE || 'America/New_York',
    defaultDuration: parseInt(process.env.DEFAULT_APPOINTMENT_DURATION || '60', 10),
    phone: process.env.BUSINESS_PHONE || '',
    address: process.env.BUSINESS_ADDRESS || '',
    website: process.env.BUSINESS_WEBSITE || '',
    businessHours: {
      monday:    { open: '09:00', close: '18:00', closed: false },
      tuesday:   { open: '09:00', close: '18:00', closed: false },
      wednesday: { open: '09:00', close: '18:00', closed: false },
      thursday:  { open: '09:00', close: '18:00', closed: false },
      friday:    { open: '09:00', close: '17:00', closed: false },
      saturday:  { open: '10:00', close: '15:00', closed: false },
      sunday:    { open: '00:00', close: '00:00', closed: true  },
    },
  },
} as const;

export type BusinessHoursKey = keyof typeof config.business.businessHours;
