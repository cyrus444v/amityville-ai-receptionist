/**
 * The provisioner, driven end to end against a stand-in for the ElevenLabs API.
 *
 * This script creates live resources on a clinic's account. A dry run only
 * exercises the paths that skip the network, so without something like this the
 * first real execution of the create-and-assign path is against a customer's
 * workspace. It has already earned its place: it caught the knowledge base
 * being created afresh on every run, which leaves an orphaned copy of the
 * service catalogue behind each time and leaves the agent retrieving against a
 * stale one.
 */

import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(__dirname, '../..');
const SLUG = 'amityville-wellness';

interface StubState {
  tier: string;
  posts: string[];
  tools: Array<Record<string, any>>;
  agents: Array<Record<string, any>>;
  docs: Array<Record<string, any>>;
  secrets: Array<Record<string, any>>;
  lastAgentPayload: Record<string, any> | null;
}

let server: Server;
let baseUrl: string;
let state: StubState;

function resetState(): void {
  state = { tier: 'enterprise', posts: [], tools: [], agents: [], docs: [], secrets: [], lastAgentPayload: null };
}

beforeAll(async () => {
  resetState();
  let counter = 0;
  const id = (prefix: string) => `${prefix}_${++counter}`;

  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const url = req.url ?? '';
      if (req.method === 'POST') state.posts.push(url);

      const send = (payload: unknown, status = 200): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (!req.headers['xi-api-key']) return send({ detail: 'no key' }, 401);

      if (url === '/v1/user/subscription') return send({ tier: state.tier });

      if (url === '/v1/convai/secrets') {
        if (req.method === 'GET') return send({ secrets: state.secrets });
        if (!body.value) return send({ detail: 'secret value is required' }, 422);
        const secret = { secret_id: id('sec'), name: body.name };
        state.secrets.push(secret);
        return send(secret);
      }

      if (url === '/v1/convai/tools') {
        if (req.method === 'GET') return send({ tools: state.tools });
        const config = body.tool_config;
        if (config.type !== 'webhook') return send({ detail: 'unsupported tool type' }, 422);
        if (!config.api_schema?.url?.startsWith('https://')) return send({ detail: 'tool url must be https' }, 422);
        const tool = { id: id('tool'), name: config.name, tool_config: config };
        state.tools.push(tool);
        return send(tool);
      }
      if (url.startsWith('/v1/convai/tools/')) return send({ id: url.split('/').pop() });

      if (url === '/v1/convai/knowledge-base') return send({ documents: state.docs });
      if (url === '/v1/convai/knowledge-base/text') {
        if (!body.text) return send({ detail: 'text is required' }, 422);
        const doc = { id: id('doc'), name: body.name };
        state.docs.push(doc);
        return send(doc);
      }

      if (url === '/v1/convai/agents') return send({ agents: state.agents });
      if (url === '/v1/convai/agents/create') {
        const cc = body.conversation_config;
        if (!cc?.agent?.prompt?.prompt) return send({ detail: 'prompt is required' }, 422);
        if (!cc?.tts?.voice_id) return send({ detail: 'voice_id is required' }, 422);
        const agent = { agent_id: id('agent'), name: body.name };
        state.agents.push(agent);
        state.lastAgentPayload = body;
        return send(agent);
      }
      if (url.startsWith('/v1/convai/agents/')) {
        state.lastAgentPayload = body;
        return send({ agent_id: url.split('/').pop() });
      }

      return send({ detail: `no stub route for ${req.method} ${url}` }, 404);
    });
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => { server.close(() => done()); });
  rmSync(resolve(repoRoot, 'agent/generated', SLUG), { recursive: true, force: true });
});

function provision(extra: string[] = []) {
  return execFileAsync('node', [
    'scripts/elevenlabs-provision.mjs',
    '--tenant', SLUG,
    '--base-url', 'https://api-test.example.com',
    '--voice-id', 'voice_test',
    ...extra,
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ELEVENLABS_BASE_URL: baseUrl,
      ELEVENLABS_API_KEY: 'stub-key',
      TOOL_AUTH_SECRET: 'stub-tool-secret-value',
    },
  });
}

// A tenant that has genuinely not chosen a voice yet. This deliberately does
// not reuse SLUG: that clinic picked a voice on 3 September 2026, and the test
// then asserted the opposite of reality. The precondition below fails loudly if
// this tenant ever picks one too, instead of the test quietly inverting.
const VOICELESS_SLUG = 'riverside-physio';

function provisionWithoutVoice(extra: string[] = []) {
  return execFileAsync('node', [
    'scripts/elevenlabs-provision.mjs',
    '--tenant', VOICELESS_SLUG,
    '--base-url', 'https://api-test.example.com',
    ...extra,
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ELEVENLABS_BASE_URL: baseUrl,
      ELEVENLABS_API_KEY: 'stub-key',
      TOOL_AUTH_SECRET: 'stub-tool-secret-value',
    },
  });
}

describe('elevenlabs-provision', () => {
  it('fails before any API request when no voice has been chosen', async () => {
    resetState();
    const fixture = JSON.parse(
      readFileSync(join(repoRoot, 'tenants', `${VOICELESS_SLUG}.json`), 'utf8'),
    );
    expect(
      fixture.voice?.elevenlabs_voice_id,
      `${VOICELESS_SLUG} has chosen a voice — this test needs a tenant that has not`,
    ).toBeUndefined();
    await expect(provisionWithoutVoice(['--apply'])).rejects.toMatchObject({
      stderr: expect.stringContaining('nothing was created'),
    });
    expect(state.posts).toEqual([]);
  });

  it('will not attach a public phone number on a non-Enterprise tier', async () => {
    resetState();
    state.tier = 'grant';
    await expect(provision([
      '--apply',
      '--phone-number', '+15551234567',
      '--twilio-sid', 'AC_test',
      '--twilio-token', 'token_test',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining('Refusing to attach'),
    });
    expect(state.posts).toEqual([]);
  });

  it('creates nothing without --apply', async () => {
    resetState();
    const { stdout } = await provision();
    expect(stdout).toContain('Dry run complete');
    expect(state.posts.filter((path) => path !== '/v1/user/subscription')).toEqual([]);
  });

  it('provisions the full surface with --apply', async () => {
    resetState();
    const { stdout } = await provision(['--apply']);
    expect(stdout).toContain('Provisioned');
    expect(state.tools).toHaveLength(8);
    expect(state.agents).toHaveLength(1);
    expect(state.docs).toHaveLength(1);
    expect(state.secrets).toHaveLength(1);
  });

  /** The regression this file exists for. */
  it('creates no duplicates when run again', async () => {
    resetState();
    await provision(['--apply']);
    await provision(['--apply']);
    expect(state.tools, 'tools were re-created').toHaveLength(8);
    expect(state.agents, 'a second agent was created').toHaveLength(1);
    expect(state.docs, 'a duplicate knowledge base document was created').toHaveLength(1);
    expect(state.secrets, 'the secret was re-created').toHaveLength(1);
  });

  it('sends the reviewed prompt and the telephony codec', () => {
    const cc = state.lastAgentPayload!.conversation_config;
    expect(cc.tts.agent_output_audio_format).toBe('ulaw_8000');
    expect(cc.asr.user_input_audio_format).toBe('ulaw_8000');
    expect(cc.agent.prompt.prompt).toContain('ONE QUESTION AT A TIME');
    expect(cc.agent.prompt.prompt).toContain('LIVE CALL CONTEXT');
  });

  it('never puts the tool secret in a payload or a file on disk', () => {
    const everything = JSON.stringify(state);
    expect(everything).not.toContain('stub-tool-secret-value');
    for (const tool of state.tools) {
      expect(tool.tool_config.api_schema.request_headers['x-tool-auth'])
        .toHaveProperty('secret_id');
    }
  });
});
