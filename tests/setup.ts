import { vi } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.TOOL_AUTH_SECRET = 'fixture-tool-secret';
process.env.APPOINTMENT_TOKEN_SECRET = 'fixture-appointment-token-secret';
// The suite runs as tenant #1. There is no built-in tenant default, so every
// entry point names the clinic it is serving — see src/config/tenant.ts.
process.env.TENANT_SLUG = 'amityville-wellness';
process.env.RATE_LIMIT_MAX = '60';
process.env.REQUEST_BODY_LIMIT = '32kb';
delete process.env.GOOGLE_CREDENTIALS_BASE64;
delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
delete process.env.GOOGLE_PRIVATE_KEY;

vi.stubGlobal('fetch', vi.fn(async () => {
  throw new Error('Network access is disabled in tests');
}));
