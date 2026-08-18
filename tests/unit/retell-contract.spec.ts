/**
 * Drift guard between the Retell agent surface and the backend.
 *
 * The Retell tool config is edited in a dashboard, far away from this code. If
 * the two diverge, callers hear failures mid-conversation rather than a build
 * error. These assertions pin every property the backend now depends on, and
 * additionally forbid a real secret from ever being committed into the tool
 * config: the auth header must remain a Retell dynamic-variable template.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface RetellTool {
  name: string;
  url: string;
  headers?: Record<string, string>;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
}

const repoRoot = resolve(__dirname, '../..');

function read(relative: string): string {
  return readFileSync(resolve(repoRoot, relative), 'utf8');
}

const tools = JSON.parse(read('retell/tools.json')) as RetellTool[];
const indexSource = read('src/index.ts');

const EXPECTED_TOOLS = [
  'get_current_date', 'check_availability', 'create_appointment',
  'reschedule_appointment', 'cancel_appointment', 'create_callback',
  'search_services', 'find_appointment',
] as const;

/** Tools that mutate or disclose a specific patient record. */
const CALLER_BOUND_TOOLS = ['find_appointment', 'reschedule_appointment', 'cancel_appointment'] as const;

const AUTH_HEADER = 'x-tool-auth';
const CALLER_PHONE_HEADER = 'x-retell-caller-phone';
const CALL_ID_HEADER = 'x-retell-call-id';

function protectedPaths(): string[] {
  const block = indexSource.slice(
    indexSource.indexOf('const protectedToolPaths'),
    indexSource.indexOf('const writeToolPaths'),
  );
  return [...block.matchAll(/'(\/[a-z0-9/-]+)'/g)].map((match) => match[1]);
}

describe('retell tool contract', () => {
  it('declares exactly the expected tool set', () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('routes every tool at an HTTPS path the app actually protects', () => {
    const allowed = new Set(protectedPaths());
    expect(allowed.size).toBeGreaterThan(0);
    for (const tool of tools) {
      const url = new URL(tool.url);
      expect(url.protocol).toBe('https:');
      const path = url.pathname.replace(/^\/v1/, '');
      expect(allowed.has(path), `${tool.name} posts to unprotected path ${url.pathname}`).toBe(true);
    }
  });

  it('sends the versioned tool credential on every tool', () => {
    for (const tool of tools) {
      expect(tool.headers, `${tool.name} declares no headers`).toBeTruthy();
      expect(tool.headers?.[AUTH_HEADER], `${tool.name} is missing ${AUTH_HEADER}`).toBe('{{tool_auth_secret}}');
    }
  });

  it('never commits a literal credential into the tool config', () => {
    for (const tool of tools) {
      for (const [header, value] of Object.entries(tool.headers ?? {})) {
        const isTemplate = /^\{\{[a-z_]+\}\}$/.test(value);
        expect(
          isTemplate,
          `${tool.name}.${header} must stay a Retell dynamic-variable template, not a literal value`,
        ).toBe(true);
      }
    }
    expect(read('retell/tools.json')).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });

  it('binds the verified caller number to every record-specific tool', () => {
    for (const name of CALLER_BOUND_TOOLS) {
      const tool = tools.find((item) => item.name === name);
      expect(tool, `${name} is missing from the tool config`).toBeTruthy();
      expect(tool?.headers?.[CALLER_PHONE_HEADER], `${name} must forward the verified caller number`).toBe('{{user_number}}');
    }
  });

  it('sends the call id so rate limiting is shared per call, not per Retell IP', () => {
    for (const tool of tools) {
      expect(tool.headers?.[CALL_ID_HEADER], `${tool.name} is missing ${CALL_ID_HEADER}`).toBe('{{call_id}}');
    }
  });

  it('requires the selection token on both mutation tools', () => {
    for (const name of ['reschedule_appointment', 'cancel_appointment']) {
      const tool = tools.find((item) => item.name === name);
      const properties = Object.keys(tool?.parameters?.properties ?? {});
      expect(properties, `${name} must accept appointment_token`).toContain('appointment_token');
    }
  });

  it('keeps the create_appointment payload aligned with the persisted fields', () => {
    const tool = tools.find((item) => item.name === 'create_appointment');
    const properties = Object.keys(tool?.parameters?.properties ?? {});
    for (const field of ['phone', 'service', 'date', 'time']) {
      expect(properties, `create_appointment must accept ${field}`).toContain(field);
    }
    expect(
      properties.includes('full_name') || properties.includes('caller_name'),
      'create_appointment must accept a caller name field',
    ).toBe(true);
  });
});
