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
  loadEnvironment,
  loadTemplateText,
  renderTaskDefinition,
  substitute,
} from '../../infra/render.mjs';

const SHA = '5e4e0c025d05447d41f766f02ca41ea2f91cece8';

function envConfig(environment: string) {
  return loadEnvironment(environment);
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
  const definition = renderTaskDefinition({
    templateText: loadTemplateText(),
    envConfig: envConfig('production'),
    imageTag: SHA,
  });
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
    expect(() => renderTaskDefinition({
      templateText: loadTemplateText(),
      envConfig: envConfig('staging'),
      imageTag: SHA,
    })).toThrow(/operator placeholders/);
  });

  it('refuses to point staging at the production calendar', () => {
    const config = stagingWithGoogleIds({ GOOGLE_CALENDAR_ID: 'cyrus.lang1@gmail.com' });
    expect(() => renderTaskDefinition({
      templateText: loadTemplateText(),
      envConfig: config,
      imageTag: SHA,
    })).toThrow(/may not use the production value for GOOGLE_CALENDAR_ID/);
  });

  it('refuses to point staging at the production spreadsheet', () => {
    const config = stagingWithGoogleIds({ GOOGLE_SPREADSHEET_ID: '1Nn7nMjzC0SkqP2PcjE69i_J-tmGiDUsXyCIpSjCDTjs' });
    expect(() => renderTaskDefinition({
      templateText: loadTemplateText(),
      envConfig: config,
      imageTag: SHA,
    })).toThrow(/may not use the production value for GOOGLE_SPREADSHEET_ID/);
  });

  it('renders a fully isolated staging definition once configured', () => {
    const definition = renderTaskDefinition({
      templateText: loadTemplateText(),
      envConfig: stagingWithGoogleIds(),
      imageTag: SHA,
    });
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
    expect(() => renderTaskDefinition({
      templateText: loadTemplateText(),
      envConfig: config,
      imageTag: SHA,
    })).toThrow(/Environment mismatch/);
  });

  it('rejects a non-production NODE_ENV that would enable the dev bypasses', () => {
    const config = stagingWithGoogleIds({ NODE_ENV: 'development' });
    expect(() => renderTaskDefinition({
      templateText: loadTemplateText(),
      envConfig: config,
      imageTag: SHA,
    })).toThrow(/NODE_ENV must be "production"/);
  });
});
