/**
 * The eight HTTPS tools are the whole product. Translating them to a new vendor
 * is exactly the kind of change that looks right and fails on the first call,
 * so the translation is pinned here rather than eyeballed in a dashboard.
 */

import { describe, expect, it } from 'vitest';
import {
  GET_TOOLS,
  HEADER_VARIABLE_MAP,
  READ_ONLY_TOOLS,
  SECRET_PLACEHOLDER,
  toElevenLabsTool,
  toElevenLabsTools,
} from '../../lib/elevenlabs/tool-config.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoTools = JSON.parse(
  readFileSync(resolve(__dirname, '../../agent/tools.json'), 'utf8'),
) as Array<Record<string, any>>;

const SECRET_ID = 'sec_fixture';
// The mapper is plain ESM, so its return type widens to unknown under tsc.
// Typing the boundary once keeps the assertions below readable.
const converted: Array<Record<string, any>> = toElevenLabsTools(repoTools, { secretId: SECRET_ID });
const byName = new Map<string, Record<string, any>>(converted.map((tool) => [tool.name, tool]));

describe('repo tools translate to ElevenLabs webhook tools', () => {
  it('translates every tool, losing none', () => {
    expect(converted).toHaveLength(repoTools.length);
    expect(converted.length).toBeGreaterThanOrEqual(8);
  });

  it('carries each tool name and description across unchanged', () => {
    for (const tool of repoTools) {
      const translated = byName.get(tool.name)!;
      expect(translated, `missing ${tool.name}`).toBeDefined();
      // The description is what the model reasons over. Paraphrasing it during
      // a vendor migration silently changes agent behaviour.
      expect(translated.description).toBe(tool.description);
    }
  });

  it('references the tool secret by id and never inlines its value', () => {
    const serialised = JSON.stringify(converted);
    expect(serialised).not.toContain(SECRET_PLACEHOLDER);
    expect(serialised).not.toContain('fixture-tool-secret');
    for (const tool of converted) {
      expect(tool.api_schema.request_headers['x-tool-auth']).toEqual({ secret_id: SECRET_ID });
    }
  });

  it('maps the caller number to the vendor system variable, not a literal', () => {
    // find_appointment refuses to return anything unless the caller number in
    // the header matches. A literal "{{user_number}}" fails that check on every
    // call, so this mapping is the difference between working and not.
    const find = byName.get('find_appointment')!;
    expect(find.api_schema.request_headers['x-caller-phone'])
      .toEqual({ variable_name: 'system__caller_id' });
    expect(HEADER_VARIABLE_MAP['{{user_number}}']).toBe('system__caller_id');
  });

  it('gives every tool a correlation id header', () => {
    for (const tool of converted) {
      expect(tool.api_schema.request_headers['x-call-id'])
        .toEqual({ variable_name: 'system__conversation_id' });
    }
  });

  it('refuses an unmapped placeholder rather than sending it as text', () => {
    expect(() => toElevenLabsTool(
      { name: 'invented', description: 'x', url: 'https://example.com/x', headers: { 'x-thing': '{{not_mapped}}' } },
      { secretId: SECRET_ID },
    )).toThrow(/unmapped placeholder/);
  });

  it('refuses to build a tool that needs the secret when none was supplied', () => {
    expect(() => toElevenLabsTool(repoTools[0], {})).toThrow(/secretId/);
  });

  it('uses GET only where the backend serves GET', () => {
    for (const tool of converted) {
      const expected = GET_TOOLS.includes(tool.name) ? 'GET' : 'POST';
      expect(tool.api_schema.method, tool.name).toBe(expected);
    }
  });

  it('sends no body schema on a GET, and the exact parameter schema on a POST', () => {
    expect(byName.get('get_current_date')!.api_schema.request_body_schema).toBeUndefined();
    const create = byName.get('create_appointment')!;
    expect(create.api_schema.request_body_schema)
      .toEqual(repoTools.find((tool) => tool.name === 'create_appointment')!.parameters);
  });

  it('protects writes from being abandoned mid-flight, and leaves reads interruptible', () => {
    for (const tool of converted) {
      const isRead = READ_ONLY_TOOLS.includes(tool.name);
      expect(tool.interruption_mode, tool.name).toBe(isRead ? 'allow' : 'disable_during_tool');
      expect(tool.response_timeout_secs, tool.name).toBeGreaterThanOrEqual(5);
      expect(tool.response_timeout_secs, tool.name).toBeLessThanOrEqual(300);
    }
  });

  it('honours the per-tool speech setting the tool file already carried', () => {
    for (const tool of repoTools) {
      expect(byName.get(tool.name)!.pre_tool_speech)
        .toBe(tool.speak_during_execution ? 'force' : 'off');
    }
  });
});
