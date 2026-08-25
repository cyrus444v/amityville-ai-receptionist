import dotenv from 'dotenv';
dotenv.config();

import { tenant, type DayKey } from './tenant';

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
    // The telephony layer is ours. These headers are set by the call handler
    // this service owns, not by a vendor, so the names carry no vendor in them.
    callerPhoneHeader: (process.env.TELEPHONY_CALLER_PHONE_HEADER || 'x-caller-phone').toLowerCase(),
    callIdHeader: (process.env.TELEPHONY_CALL_ID_HEADER || 'x-call-id').toLowerCase(),
  },

  // The clinic's identity comes from its tenant configuration. The environment
  // variables remain as per-deployment overrides so that nothing already
  // deployed changes behaviour, but none of them carries a clinic-specific
  // default any more: an unset variable now falls through to the tenant file,
  // never to some other clinic's name.
  business: {
    slug: tenant.slug,
    name: process.env.BUSINESS_NAME || tenant.display_name,
    shortName: tenant.short_name,
    locality: tenant.locality,
    timezone: process.env.TIMEZONE || tenant.timezone,
    defaultDuration: positiveInteger(
      process.env.DEFAULT_APPOINTMENT_DURATION,
      tenant.default_appointment_duration_minutes,
    ),
    phone: process.env.BUSINESS_PHONE || tenant.contact.phone,
    address: process.env.BUSINESS_ADDRESS || tenant.contact.address,
    website: process.env.BUSINESS_WEBSITE || tenant.contact.website,
    businessHours: tenant.business_hours,
  },

  email: {
    fromName: process.env.BUSINESS_NAME || tenant.display_name,
    from: process.env.EMAIL_FROM || tenant.email.from,
    replyTo: process.env.EMAIL_REPLY_TO || tenant.email.reply_to,
    footerLocality: tenant.email.footer_locality,
  },

  services: tenant.services,
} as const;

export function assertProductionSecurityConfig(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (config.security.toolAuthSecret.length < 32) throw new Error('TOOL_AUTH_SECRET must be set to at least 32 characters when NODE_ENV=production.');
  if (config.security.appointmentTokenSecret.length < 32) throw new Error('APPOINTMENT_TOKEN_SECRET must be set to at least 32 characters when NODE_ENV=production.');
  if (!config.security.coordinationTable) throw new Error('COORDINATION_TABLE must be set when NODE_ENV=production.');
  if (config.security.allowedOrigins.includes('*')) throw new Error('ALLOWED_ORIGINS must not contain * when NODE_ENV=production.');
  // The container image carries no tenant files (the Dockerfile ships dist/
  // only), so in production the clinic's configuration must arrive injected.
  // Reaching this line at all means src/config/tenant.ts already parsed and
  // validated it; this catches the case where it was resolved from somewhere
  // a deployed task should not be reading from.
  if (!(process.env.TENANT_CONFIG_JSON || '').trim()) {
    throw new Error('TENANT_CONFIG_JSON must be set when NODE_ENV=production; the image contains no tenant files.');
  }
}

export type BusinessHoursKey = DayKey;
export type { DayKey, DayHours, Tenant, TenantService } from './tenant';
export { tenant, openDays } from './tenant';
