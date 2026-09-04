/**
 * The tenant configuration is the only thing that separates one clinic from
 * another, so every way it can be wrong is a rejection with a test behind it.
 * A tenant file that parses but is subtly wrong — a missing day, a reversed
 * range, two services sharing an id — would surface as a clinic quietly
 * refusing bookings or answering with another clinic's details.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DAY_KEYS,
  TENANTS_DIR,
  loadTenant,
  openDays,
  parseTenant,
  resolveTenantSource,
  tenant,
} from '../../src/config/tenant';
import { buildBusinessHours, buildEnvironment, buildTenant } from '../../lib/scaffold-tenant.mjs';

const REFERENCE_PATH = resolve(TENANTS_DIR, 'amityville-wellness.json');
const referenceText = readFileSync(REFERENCE_PATH, 'utf8');

/** A deep clone of the reference tenant, to be broken one field at a time. */
function draft(): Record<string, any> {
  return JSON.parse(referenceText);
}

function expectRejected(config: unknown, pattern: RegExp): void {
  expect(() => parseTenant(JSON.stringify(config), 'fixture')).toThrow(pattern);
}

describe('the reference tenant', () => {
  it('is a valid tenant configuration', () => {
    const parsed = parseTenant(referenceText, REFERENCE_PATH);
    expect(parsed.slug).toBe('amityville-wellness');
    expect(parsed.services.length).toBeGreaterThan(0);
  });

  it('is what the process booted with', () => {
    expect(tenant.slug).toBe('amityville-wellness');
  });

  it('covers all seven days', () => {
    expect(DAY_KEYS).toEqual([
      'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    ]);
    expect(Object.keys(tenant.business_hours).sort()).toEqual([...DAY_KEYS].sort());
  });

  it('reports its open days in week order', () => {
    expect(openDays(tenant).map((entry) => entry.day)).toEqual([
      'tuesday', 'wednesday', 'friday', 'saturday',
    ]);
  });
});

/**
 * The region a caller's number is read in when they give it without a country
 * code. It has no default because getting it wrong is silent: the clinic keeps
 * answering the phone, stores the caller's spoken number under one key and
 * their caller ID under another, and never finds the appointment again.
 */
describe('the phone region', () => {
  it('refuses a clinic that does not state one', () => {
    const config = draft();
    delete config.default_phone_region;
    expectRejected(config, /default_phone_region/);
  });

  it.each([
    ['us', 'a lower-case code'],
    ['UK', 'a code that is not the ISO one — Great Britain is GB'],
    ['USA', 'an alpha-3 code'],
    ['', 'an empty string'],
    ['DEU', 'an alpha-3 code for Germany'],
  ])('rejects %s (%s)', (region) => {
    const config = draft();
    config.default_phone_region = region;
    expectRejected(config, /default_phone_region must be an upper-case ISO 3166-1 alpha-2 region/);
  });

  it('accepts a clinic outside the numbering plan clinic #1 is in', () => {
    const config = draft();
    config.default_phone_region = 'DE';
    expect(parseTenant(JSON.stringify(config), 'fixture').default_phone_region).toBe('DE');
  });
});

describe('business hours', () => {
  it('rejects a configuration missing a day', () => {
    const config = draft();
    delete config.business_hours.thursday;
    expectRejected(config, /business_hours\.thursday/);
  });

  it('rejects an unknown day, which would silently never be consulted', () => {
    const config = draft();
    config.business_hours.caturday = { open: '09:00', close: '17:00', closed: false };
    expectRejected(config, /business_hours/);
  });

  it.each([
    ['9:00', 'a single-digit hour'],
    ['24:00', 'an out-of-range hour'],
    ['09:60', 'an out-of-range minute'],
    ['0900', 'a missing separator'],
    ['', 'an empty string'],
  ])('rejects %s as an opening time (%s)', (open) => {
    const config = draft();
    config.business_hours.tuesday.open = open;
    expectRejected(config, /open must be HH:MM/);
  });

  it('rejects an open day that closes before it opens', () => {
    const config = draft();
    config.business_hours.tuesday = { open: '17:00', close: '09:00', closed: false };
    expectRejected(config, /must close after it opens/);
  });

  it('rejects an open day whose range is empty', () => {
    const config = draft();
    config.business_hours.tuesday = { open: '09:00', close: '09:00', closed: false };
    expectRejected(config, /must close after it opens/);
  });

  it('accepts a closed day whose range is meaningless', () => {
    const config = draft();
    config.business_hours.tuesday = { open: '00:00', close: '00:00', closed: true };
    expect(parseTenant(JSON.stringify(config), 'fixture').business_hours.tuesday.closed).toBe(true);
  });

  it('rejects a clinic that is closed every day of the week', () => {
    const config = draft();
    for (const day of DAY_KEYS) {
      config.business_hours[day] = { open: '00:00', close: '00:00', closed: true };
    }
    expectRejected(config, /closed every day of the week/);
  });
});

describe('services', () => {
  it('rejects an empty catalogue', () => {
    const config = draft();
    config.services = [];
    expectRejected(config, /at least one service/);
  });

  it('rejects duplicate service ids', () => {
    const config = draft();
    config.services = [config.services[0], { ...config.services[1], service_id: config.services[0].service_id }];
    expectRejected(config, /service_id must be unique, duplicated: acupuncture/);
  });

  it('rejects a service with no keywords, which could never be matched', () => {
    const config = draft();
    config.services[0].keywords = [];
    expectRejected(config, /at least one keyword/);
  });

  it('rejects a non-slug service id', () => {
    const config = draft();
    config.services[0].service_id = 'Red Light Therapy';
    expectRejected(config, /service_id must be a lower-case slug/);
  });

  it('rejects a zero or negative duration', () => {
    for (const duration of [0, -30]) {
      const config = draft();
      config.services[0].duration_minutes = duration;
      expectRejected(config, /services\.0\.duration_minutes/);
    }
  });
});

describe('identity and contact', () => {
  it('rejects a missing display name', () => {
    const config = draft();
    delete config.display_name;
    expectRejected(config, /display_name/);
  });

  it('rejects an unresolvable timezone', () => {
    const config = draft();
    config.timezone = 'Mars/Olympus_Mons';
    expectRejected(config, /timezone is not a resolvable IANA zone/);
  });

  it('rejects a malformed sender address', () => {
    const config = draft();
    config.email.from = 'not-an-address';
    expectRejected(config, /email\.from/);
  });

  it('rejects an unknown top-level field, which would be a silent typo', () => {
    const config = draft();
    config.buisness_hours = config.business_hours;
    expectRejected(config, /buisness_hours|Unrecognized/);
  });

  it('reports the origin so a bad file is findable', () => {
    expect(() => parseTenant('{', '/tmp/clinic-b.json')).toThrow(/\/tmp\/clinic-b\.json is not valid JSON/);
  });
});

describe('resolution order', () => {
  it('prefers the inline configuration a deployed container receives', () => {
    const source = resolveTenantSource({
      TENANT_CONFIG_JSON: referenceText,
      TENANT_CONFIG_PATH: '/does/not/exist.json',
      TENANT_SLUG: 'also-not-used',
    } as NodeJS.ProcessEnv);
    expect(source.origin).toBe('TENANT_CONFIG_JSON');
  });

  it('reads an explicit path when no inline configuration is set', () => {
    const loaded = loadTenant({ TENANT_CONFIG_PATH: REFERENCE_PATH } as NodeJS.ProcessEnv);
    expect(loaded.slug).toBe('amityville-wellness');
  });

  it('resolves a slug against the tenants directory', () => {
    const loaded = loadTenant({ TENANT_SLUG: 'amityville-wellness' } as NodeJS.ProcessEnv);
    expect(loaded.slug).toBe('amityville-wellness');
  });

  it('refuses a slug that could escape the tenants directory', () => {
    expect(() => resolveTenantSource({ TENANT_SLUG: '../../etc/passwd' } as NodeJS.ProcessEnv))
      .toThrow(/TENANT_SLUG must be a lower-case slug/);
  });

  it('has no default: an unconfigured process refuses to serve any clinic', () => {
    expect(() => resolveTenantSource({} as NodeJS.ProcessEnv))
      .toThrow(/No tenant configuration/);
  });
});

describe('every clinic in the repository', () => {
  const files = readdirSync(TENANTS_DIR).filter((entry) => entry.endsWith('.json'));

  it('has at least tenant #1 and the reference second clinic', () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it.each(files)('%s is a valid tenant configuration', (file) => {
    const path = resolve(TENANTS_DIR, file);
    const parsed = parseTenant(readFileSync(path, 'utf8'), path);
    // A file must be named after the clinic inside it, or TENANT_SLUG resolution
    // would hand the process a different clinic than the operator named.
    expect(parsed.slug).toBe(file.replace(/\.json$/, ''));
  });
});

describe('scaffolding a new clinic', () => {
  const options = {
    slug: 'test-clinic',
    displayName: 'Test Clinic Ltd',
    shortName: 'Test Clinic',
    locality: 'Testville, TS',
    phone: '+1 555-555-0101',
    address: '1 Test Street, Testville, TS 00001',
    website: 'https://www.test-clinic.example',
  };

  it('produces a configuration the application accepts unedited', () => {
    const scaffolded = buildTenant(options);
    const parsed = parseTenant(JSON.stringify(scaffolded), 'scaffolded');
    expect(parsed.slug).toBe('test-clinic');
    expect(parsed.services).toHaveLength(1);
  });

  it('defaults to a Monday-to-Friday week', () => {
    const hours = buildTenant(options).business_hours;
    expect(openDays(parseTenant(JSON.stringify(buildTenant(options)), 'x')).map((entry) => entry.day))
      .toEqual(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']);
    expect(hours.saturday.closed).toBe(true);
    expect(hours.sunday.closed).toBe(true);
  });

  it('takes the open days it is given', () => {
    const scaffolded = buildTenant({ ...options, open: ['thursday=10:00-18:00', 'sunday=09:00-13:00'] });
    expect(openDays(parseTenant(JSON.stringify(scaffolded), 'x')).map((entry) => entry.day))
      .toEqual(['thursday', 'sunday']);
  });

  it('rejects a malformed open day rather than scaffolding a broken week', () => {
    expect(() => buildBusinessHours(['tuesday=9-5'])).toThrow(/--open must look like/);
    expect(() => buildBusinessHours(['caturday=09:00-17:00'])).toThrow(/Not a day of the week/);
    expect(() => buildBusinessHours(['tuesday=17:00-09:00'])).not.toThrow(); // shape is fine…
    expect(() => parseTenant(JSON.stringify(buildTenant({ ...options, open: ['tuesday=17:00-09:00'] })), 'x'))
      .toThrow(/must close after it opens/); // …and the schema catches the meaning
  });

  it('refuses to scaffold a clinic it cannot identify', () => {
    expect(() => buildTenant({ slug: 'nameless' }))
      .toThrow(/Missing required options: displayName, shortName, locality, phone, address, website/);
  });

  it('leaves the Google resources as placeholders the renderer will refuse', () => {
    for (const environment of ['production', 'staging']) {
      const config = buildEnvironment(options, environment);
      expect(config.tenant).toBe('test-clinic');
      expect(config.values.GOOGLE_CALENDAR_ID).toMatch(/^REPLACE_WITH_/);
      expect(config.values.GOOGLE_SPREADSHEET_ID).toMatch(/^REPLACE_WITH_/);
      expect(config.values.NODE_ENV).toBe('production');
      expect(config.values.SERVICE).toBe('test-clinic');
    }
  });

  it('brands production as the clinic and staging unmistakably as a rehearsal', () => {
    expect(buildEnvironment(options, 'production').values.BUSINESS_NAME).toBe('Test Clinic Ltd');
    expect(buildEnvironment(options, 'staging').values.BUSINESS_NAME).toContain('do not treat as real');
    expect(buildEnvironment(options, 'staging').readonlyRootFilesystem).toBe(true);
  });
});

describe('fail-closed in production', () => {
  const SNAPSHOT = { ...process.env };

  /**
   * Rebuilds the config module under a chosen environment. `config` reads the
   * environment once at import, so the module registry has to be reset for each
   * case rather than mutating process.env after the fact.
   */
  async function guardUnder(overrides: Record<string, string | undefined>) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
    const { assertProductionSecurityConfig } = await import('../../src/config');
    return assertProductionSecurityConfig;
  }

  const longSecrets = {
    NODE_ENV: 'production',
    TOOL_AUTH_SECRET: 'a'.repeat(48),
    APPOINTMENT_TOKEN_SECRET: 'b'.repeat(48),
    COORDINATION_TABLE: 'test-production-coordination',
    ALLOWED_ORIGINS: '',
  };

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in SNAPSHOT)) delete process.env[key];
    Object.assign(process.env, SNAPSHOT);
    vi.resetModules();
  });

  it('accepts a production boot whose clinic configuration was injected', async () => {
    const guard = await guardUnder({ ...longSecrets, TENANT_CONFIG_JSON: referenceText, TENANT_SLUG: undefined });
    expect(() => guard()).not.toThrow();
  });

  it('refuses a production boot that read its clinic off the filesystem', async () => {
    // The image ships dist/ only, so a file-resolved tenant in production means
    // the container is reading something a deployed task should not have.
    const guard = await guardUnder({ ...longSecrets, TENANT_CONFIG_JSON: undefined, TENANT_SLUG: 'amityville-wellness' });
    expect(() => guard()).toThrow(/TENANT_CONFIG_JSON must be set when NODE_ENV=production/);
  });

  it('still refuses a production boot with a weak secret, tenant or not', async () => {
    const guard = await guardUnder({
      ...longSecrets, TOOL_AUTH_SECRET: 'short', TENANT_CONFIG_JSON: referenceText, TENANT_SLUG: undefined,
    });
    expect(() => guard()).toThrow(/TOOL_AUTH_SECRET must be set to at least 32 characters/);
  });

  it('lets a non-production process boot from a tenant file', async () => {
    const guard = await guardUnder({ NODE_ENV: 'test', TENANT_SLUG: 'amityville-wellness', TENANT_CONFIG_JSON: undefined });
    expect(() => guard()).not.toThrow();
  });

  // The call handler this service owns sets these headers, so the names are
  // ours to choose. The environment variables stay as overrides for a
  // deployment that needs a different spelling; the defaults carry no vendor.
  it('honours an explicit telephony header override', async () => {
    process.env.TELEPHONY_CALLER_PHONE_HEADER = 'x-telephony-caller';
    process.env.TELEPHONY_CALL_ID_HEADER = 'x-telephony-call';
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.security.callerPhoneHeader).toBe('x-telephony-caller');
    expect(config.security.callIdHeader).toBe('x-telephony-call');
  });

  it('defaults to vendor-neutral header names', async () => {
    delete process.env.TELEPHONY_CALLER_PHONE_HEADER;
    delete process.env.TELEPHONY_CALL_ID_HEADER;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.security.callerPhoneHeader).toBe('x-caller-phone');
    expect(config.security.callIdHeader).toBe('x-call-id');
  });
});
