/**
 * The task definition is the only place where the security configuration this
 * codebase depends on becomes real. A missing COORDINATION_TABLE, a mutable
 * image tag, a duplicated variable, or a staging environment pointed at the
 * live calendar are all silent-until-production failures, so each one is a
 * render-time error with a test behind it.
 */

import { describe, expect, it } from 'vitest';
import {
  REQUIRED_SECRET_NAMES,
  assertValidImageTag,
  environmentFileName,
  loadEnvironment,
  mergeForbiddenValues,
  loadTemplateText,
  renderTaskDefinition,
  substitute,
} from '../../infra/render.mjs';
import { loadTenantFile } from '../../lib/tenant-file.mjs';

const SHA = '5e4e0c025d05447d41f766f02ca41ea2f91cece8';
const TENANT = 'amityville-wellness';
const tenant = loadTenantFile(TENANT);

function envConfig(environment: string) {
  return loadEnvironment(environment, TENANT);
}

/** Renders with clinic #1 unless a test deliberately supplies another. */
function render(config: any, overrides: Record<string, unknown> = {}) {
  return renderTaskDefinition({
    templateText: loadTemplateText(),
    envConfig: config,
    tenant,
    imageTag: SHA,
    ...overrides,
  });
}

function stagingWithGoogleIds(overrides: Record<string, string> = {}) {
  const config = envConfig('staging');
  config.values.GOOGLE_CALENDAR_ID = 'staging-calendar@example.invalid';
  config.values.GOOGLE_SPREADSHEET_ID = 'staging-spreadsheet-id';
  Object.assign(config.values, overrides);
  return config;
}

describe('image tags', () => {
  it('requires an explicit tag', () => {
    expect(() => assertValidImageTag(undefined)).toThrow(/explicit --image-tag is required/);
  });

  it('rejects mutable tags that could silently redeploy different code', () => {
    for (const tag of ['latest', 'main', 'production', 'staging']) {
      expect(() => assertValidImageTag(tag)).toThrow(/mutable image tag/i);
    }
  });

  it('accepts a commit sha', () => {
    expect(assertValidImageTag(SHA)).toBe(SHA);
  });
});

describe('placeholder substitution', () => {
  it('fails loudly rather than emitting a literal placeholder', () => {
    expect(() => substitute('table=${MISSING_KEY}', {})).toThrow(/Unresolved template placeholders: MISSING_KEY/);
  });
});

describe('production task definition', () => {
  const definition = render(envConfig('production'));
  const container = definition.containerDefinitions[0];
  const env = new Map(container.environment.map((entry: { name: string; value: string }) => [entry.name, entry.value]));

  it('pins an immutable image', () => {
    expect(container.image).toContain(`:${SHA}`);
    expect(container.image).not.toContain(':latest');
  });

  it('wires every security variable the runtime config reads', () => {
    for (const name of [
      'TOOL_AUTH_HEADER', 'TOOL_AUTH_VERSION', 'APPOINTMENT_TOKEN_TTL_MS',
      'RETELL_CALLER_PHONE_HEADER', 'RETELL_CALL_ID_HEADER', 'RETELL_WEBHOOK_TOLERANCE_MS',
      'ALLOWED_ORIGINS', 'REQUEST_BODY_LIMIT', 'RATE_LIMIT_WINDOW_MS', 'RATE_LIMIT_MAX',
      'IDEMPOTENCY_TTL_MS', 'TRUST_PROXY_HOPS', 'COORDINATION_TABLE', 'COORDINATION_REGION',
    ]) {
      expect(env.has(name), `${name} is not set in the task definition`).toBe(true);
    }
  });

  it('runs with the fail-closed production guards active', () => {
    expect(env.get('NODE_ENV')).toBe('production');
  });

  it('never sets a wildcard CORS origin', () => {
    expect(env.get('ALLOWED_ORIGINS')).not.toContain('*');
  });

  it('resolves the coordination table for its own environment', () => {
    expect(env.get('COORDINATION_TABLE')).toBe('ai-receptionist-production-coordination');
  });

  it('supplies every secret by reference only', () => {
    expect(container.secrets.map((entry: { name: string }) => entry.name).sort())
      .toEqual([...REQUIRED_SECRET_NAMES].sort());
    for (const secret of container.secrets) {
      expect(secret.valueFrom).toMatch(/^arn:aws:secretsmanager:/);
      expect(secret).not.toHaveProperty('value');
    }
  });

  it('emits no duplicate variables', () => {
    const names = container.environment.map((entry: { name: string }) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('staging isolation', () => {
  it('refuses to render while operator placeholders remain', () => {
    expect(() => render(envConfig('staging'))).toThrow(/operator placeholders/);
  });

  it('refuses to point staging at the production calendar', () => {
    const config = stagingWithGoogleIds({ GOOGLE_CALENDAR_ID: 'cyrus.lang1@gmail.com' });
    expect(() => render(config)).toThrow(/may not use the production value for GOOGLE_CALENDAR_ID/);
  });

  it('refuses to point staging at the production spreadsheet', () => {
    const config = stagingWithGoogleIds({ GOOGLE_SPREADSHEET_ID: '1Nn7nMjzC0SkqP2PcjE69i_J-tmGiDUsXyCIpSjCDTjs' });
    expect(() => render(config)).toThrow(/may not use the production value for GOOGLE_SPREADSHEET_ID/);
  });

  it('renders a fully isolated staging definition once configured', () => {
    const definition = render(stagingWithGoogleIds());
    const container = definition.containerDefinitions[0];
    const env = new Map(container.environment.map((entry: { name: string; value: string }) => [entry.name, entry.value]));
    expect(env.get('COORDINATION_TABLE')).toBe('ai-receptionist-staging-coordination');
    expect(container.readonlyRootFilesystem).toBe(true);
    for (const secret of container.secrets) {
      expect(secret.valueFrom).toContain('ai-receptionist/staging/');
      expect(secret.valueFrom).not.toContain('/production/');
    }
  });

  it('rejects a config whose declared environment disagrees with its values', () => {
    const config = stagingWithGoogleIds();
    config.values.ENVIRONMENT = 'production';
    expect(() => render(config)).toThrow(/Environment mismatch/);
  });

  it('rejects a non-production NODE_ENV that would enable the dev bypasses', () => {
    const config = stagingWithGoogleIds({ NODE_ENV: 'development' });
    expect(() => render(config)).toThrow(/NODE_ENV must be "production"/);
  });
});

describe('tenant wiring', () => {
  it('keys environment files by clinic and environment', () => {
    expect(environmentFileName(TENANT, 'production')).toBe('amityville-wellness.production.json');
    expect(() => environmentFileName('Amityville Wellness', 'production')).toThrow(/Invalid tenant slug/);
    expect(() => environmentFileName(TENANT, 'Production')).toThrow(/Invalid environment name/);
  });

  it('injects the clinic configuration the container boots from', () => {
    const definition = render(envConfig('production'));
    const env = new Map(definition.containerDefinitions[0].environment
      .map((entry: { name: string; value: string }) => [entry.name, entry.value]));
    const injected = JSON.parse(env.get('TENANT_CONFIG_JSON') as string);
    expect(injected.slug).toBe(TENANT);
    expect(injected.business_hours.tuesday).toEqual({ open: '09:00', close: '17:00', closed: false });
    expect(injected.services).toHaveLength(tenant.services.length);
    expect(injected.prompt.spoken_name).toBe(tenant.prompt.spoken_name);
  });

  it('refuses to render without a clinic configuration to inject', () => {
    expect(() => render(envConfig('production'), { tenant: null }))
      .toThrow(/TENANT_CONFIG_JSON is missing/);
  });

  it('refuses an environment file that does not name its clinic', () => {
    const config = envConfig('production');
    delete config.tenant;
    expect(() => render(config)).toThrow(/must name its clinic in a "tenant" field/);
  });

  it('refuses an environment file paired with a different clinic', () => {
    const config = envConfig('production');
    config.tenant = 'some-other-clinic';
    expect(() => render(config)).toThrow(/declares tenant "some-other-clinic"/);
  });

  it('refuses a hand-set TENANT_CONFIG_JSON that would shadow the injected one', () => {
    const config = envConfig('production');
    config.values.TENANT_CONFIG_JSON = '{}';
    expect(() => render(config)).toThrow(/is injected from tenants/);
  });

  it("refuses to take a clinic live under another clinic's name", () => {
    const config = envConfig('production');
    config.values.BUSINESS_NAME = 'Some Other Clinic';
    expect(() => render(config)).toThrow(/must not go live under another clinic's name/);
  });

  it('refuses a staging environment branded as a different clinic', () => {
    const config = stagingWithGoogleIds({ BUSINESS_NAME: 'Clinic B (STAGING)' });
    expect(() => render(config)).toThrow(/does not mention "Amityville Wellness"/);
  });

  it("still allows a staging suffix on the clinic's own name", () => {
    const definition = render(stagingWithGoogleIds());
    const env = new Map(definition.containerDefinitions[0].environment
      .map((entry: { name: string; value: string }) => [entry.name, entry.value]));
    expect(env.get('BUSINESS_NAME')).toContain('STAGING');
    expect(JSON.parse(env.get('TENANT_CONFIG_JSON') as string).slug).toBe(TENANT);
  });
});

describe('staging isolation is derived, not remembered', () => {
  it('forbids the production Google resources even when staging does not list them', () => {
    const config = loadEnvironment('staging', TENANT);
    expect(config.forbiddenValues.GOOGLE_CALENDAR_ID).toContain('cyrus.lang1@gmail.com');
    expect(config.forbiddenValues.GOOGLE_SPREADSHEET_ID)
      .toContain('1Nn7nMjzC0SkqP2PcjE69i_J-tmGiDUsXyCIpSjCDTjs');
  });

  it('unions what the file declares with what production actually uses', () => {
    const merged = mergeForbiddenValues(
      { GOOGLE_CALENDAR_ID: ['old-calendar@example.invalid'] },
      { GOOGLE_CALENDAR_ID: 'live-calendar@example.invalid', GOOGLE_SPREADSHEET_ID: 'live-sheet' },
    );
    expect(merged.GOOGLE_CALENDAR_ID).toEqual(['old-calendar@example.invalid', 'live-calendar@example.invalid']);
    expect(merged.GOOGLE_SPREADSHEET_ID).toEqual(['live-sheet']);
  });

  it('ignores an absent or empty production value rather than forbidding the empty string', () => {
    expect(mergeForbiddenValues({}, { GOOGLE_CALENDAR_ID: '' })).toEqual({});
    expect(mergeForbiddenValues({}, {})).toEqual({});
  });
});
