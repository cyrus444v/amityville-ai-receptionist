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

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function csv(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function bodyLimit(value: string | undefined): string {
  const candidate = (value ?? '').trim();
  return /^\d+(?:b|kb|mb)$/i.test(candidate) ? candidate : '32kb';
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),

  google: {
    serviceAccountEmail: googleCreds.email,
    privateKey: googleCreds.key,
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID || '',
    impersonateEmail: process.env.GOOGLE_IMPERSONATE_EMAIL || '',
  },

  security: {
    toolAuthSecret: (process.env.TOOL_AUTH_SECRET || '').trim(),
    toolAuthHeader: (process.env.TOOL_AUTH_HEADER || 'x-tool-auth').toLowerCase(),
    toolAuthVersion: process.env.TOOL_AUTH_VERSION || 'v1',
    allowedOrigins: csv(process.env.ALLOWED_ORIGINS),
    requestBodyLimit: bodyLimit(process.env.REQUEST_BODY_LIMIT),
    rateLimitWindowMs: positiveInteger(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMax: positiveInteger(process.env.RATE_LIMIT_MAX, 60),
    idempotencyTtlMs: positiveInteger(process.env.IDEMPOTENCY_TTL_MS, 15 * 60_000),
    trustProxy: positiveInteger(process.env.TRUST_PROXY_HOPS, 1),
    coordinationTable: (process.env.COORDINATION_TABLE || '').trim(),
    coordinationRegion: (process.env.COORDINATION_REGION || process.env.AWS_REGION || 'us-east-1').trim(),
    appointmentTokenSecret: (process.env.APPOINTMENT_TOKEN_SECRET || '').trim(),
    appointmentTokenTtlMs: positiveInteger(process.env.APPOINTMENT_TOKEN_TTL_MS, 10 * 60_000),
    callerPhoneHeader: (process.env.RETELL_CALLER_PHONE_HEADER || 'x-retell-caller-phone').toLowerCase(),
    callIdHeader: (process.env.RETELL_CALL_ID_HEADER || 'x-retell-call-id').toLowerCase(),
    retellWebhookSecret: (process.env.RETELL_WEBHOOK_SECRET || '').trim(),
    retellWebhookToleranceMs: positiveInteger(process.env.RETELL_WEBHOOK_TOLERANCE_MS, 5 * 60_000),
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

export function assertProductionSecurityConfig(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (config.security.toolAuthSecret.length < 32) throw new Error('TOOL_AUTH_SECRET must be set to at least 32 characters when NODE_ENV=production.');
  if (config.security.appointmentTokenSecret.length < 32) throw new Error('APPOINTMENT_TOKEN_SECRET must be set to at least 32 characters when NODE_ENV=production.');
  if (config.security.retellWebhookSecret.length < 32) throw new Error('RETELL_WEBHOOK_SECRET must be set to at least 32 characters when NODE_ENV=production.');
  if (!config.security.coordinationTable) throw new Error('COORDINATION_TABLE must be set when NODE_ENV=production.');
  if (config.security.allowedOrigins.includes('*')) throw new Error('ALLOWED_ORIGINS must not contain * when NODE_ENV=production.');
}

export type BusinessHoursKey = keyof typeof config.business.businessHours;
