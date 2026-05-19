import dotenv from 'dotenv';
dotenv.config();

// Support GOOGLE_CREDENTIALS_BASE64 (entire service account JSON encoded as base64)
// This avoids all private key formatting issues with env vars
function getGoogleCredentials() {
  if (process.env.GOOGLE_CREDENTIALS_BASE64) {
    const json = JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64.trim(), 'base64').toString('utf8').trim());
    return { email: json.client_email, key: json.private_key };
  }
  return {
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
    key: (process.env.GOOGLE_PRIVATE_KEY || '')
      .replace(/^["']|["']$/g, '')
      .replace(/\\n/g, '\n'),
  };
}

const googleCreds = getGoogleCredentials();

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),

  google: {
    serviceAccountEmail: googleCreds.email,
    privateKey: googleCreds.key,
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID || '',
  },

  business: {
    name: process.env.BUSINESS_NAME || 'Amityville Acupuncture',
    timezone: process.env.TIMEZONE || 'America/New_York',
    defaultDuration: parseInt(process.env.DEFAULT_APPOINTMENT_DURATION || '60', 10),
    phone: process.env.BUSINESS_PHONE || '',
    address: process.env.BUSINESS_ADDRESS || '',
    website: process.env.BUSINESS_WEBSITE || '',
    businessHours: {
      monday:    { open: '00:00', close: '00:00', closed: true  },
      tuesday:   { open: '09:00', close: '17:00', closed: false },
      wednesday: { open: '09:00', close: '17:00', closed: false },
      thursday:  { open: '00:00', close: '00:00', closed: true  },
      friday:    { open: '09:00', close: '17:00', closed: false },
      saturday:  { open: '09:00', close: '12:00', closed: false },
      sunday:    { open: '00:00', close: '00:00', closed: true  },
    },
  },
} as const;

export type BusinessHoursKey = keyof typeof config.business.businessHours;
