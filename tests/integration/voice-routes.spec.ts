/**
 * The two voice-vendor webhooks, end to end through the real app.
 *
 * These routes are the only unauthenticated-by-default surface the service has
 * ever grown, and one of them receives patient-call metadata. Everything here
 * is about proving they are shut to anyone who cannot prove who they are.
 */

import crypto from 'crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { app } from '../../src/index';
import { expectedDigest, parseSignatureHeader } from '../../src/middleware/voice-webhook';
import { initiationVariables } from '../../src/services/call-context';

const WEBHOOK_SECRET = 'fixture-elevenlabs-webhook-secret';
const INITIATION_SECRET = 'fixture-elevenlabs-initiation-secret';

function signed(body: unknown, { secret = WEBHOOK_SECRET, atSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify(body);
  const digest = expectedDigest(secret, String(atSeconds), raw);
  return { raw, header: `t=${atSeconds},v0=${digest}` };
}

const POST_CALL_BODY = {
  type: 'post_call_transcription',
  data: {
    conversation_id: 'conv_123',
    agent_id: 'agent_123',
    status: 'done',
    metadata: { call_duration_secs: 74, termination_reason: 'end_call tool' },
    analysis: { call_successful: 'success' },
  },
};

describe('POST /voice/post-call', () => {
  it('accepts a correctly signed payload', async () => {
    const { raw, header } = signed(POST_CALL_BODY);
    const response = await request(app)
      .post('/voice/post-call')
      .set('content-type', 'application/json')
      .set('elevenlabs-signature', header)
      .send(raw);
    expect(response.status).toBe(200);
  });

  it('rejects a payload with no signature at all', async () => {
    const response = await request(app).post('/voice/post-call').send(POST_CALL_BODY);
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('INVALID_SIGNATURE');
  });

  it('rejects a signature made with the wrong secret', async () => {
    const { raw, header } = signed(POST_CALL_BODY, { secret: 'not-the-secret' });
    const response = await request(app)
      .post('/voice/post-call')
      .set('content-type', 'application/json')
      .set('elevenlabs-signature', header)
      .send(raw);
    expect(response.status).toBe(401);
  });

  it('rejects a body altered after it was signed', async () => {
    const { header } = signed(POST_CALL_BODY);
    const tampered = JSON.stringify({ ...POST_CALL_BODY, data: { conversation_id: 'conv_evil' } });
    const response = await request(app)
      .post('/voice/post-call')
      .set('content-type', 'application/json')
      .set('elevenlabs-signature', header)
      .send(tampered);
    expect(response.status).toBe(401);
  });

  it('rejects a replay of an old request', async () => {
    const hourAgo = Math.floor(Date.now() / 1000) - 3600;
    const { raw, header } = signed(POST_CALL_BODY, { atSeconds: hourAgo });
    const response = await request(app)
      .post('/voice/post-call')
      .set('content-type', 'application/json')
      .set('elevenlabs-signature', header)
      .send(raw);
    expect(response.status).toBe(401);
  });

  /**
   * The vendor's own SDK only checks that a timestamp is not too old, so a
   * captured request stamped far in the future stays valid indefinitely. This
   * service checks both directions; that difference is the point of this test.
   */
  it('rejects a timestamp far in the future, which the vendor SDK would accept', async () => {
    const nextYear = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
    const { raw, header } = signed(POST_CALL_BODY, { atSeconds: nextYear });
    const response = await request(app)
      .post('/voice/post-call')
      .set('content-type', 'application/json')
      .set('elevenlabs-signature', header)
      .send(raw);
    expect(response.status).toBe(401);
  });

  it('rejects a malformed signature header', async () => {
    for (const header of ['garbage', 't=123', 'v0=abc', 't=abc,v0=zzz', '']) {
      const response = await request(app)
        .post('/voice/post-call')
        .set('elevenlabs-signature', header)
        .send(POST_CALL_BODY);
      expect(response.status, `accepted ${header}`).toBe(401);
    }
  });

  it('answers 200 to a shape it cannot parse, so the vendor does not disable the hook', async () => {
    const body = { unexpected: true };
    const { raw, header } = signed(body);
    const response = await request(app)
      .post('/voice/post-call')
      .set('content-type', 'application/json')
      .set('elevenlabs-signature', header)
      .send(raw);
    expect(response.status).toBe(200);
  });
});

describe('body limits', () => {
  /**
   * The tool endpoints are capped at 32kb, which is right for them and far too
   * small for a transcript. A 400-turn call is ~53kb; before the voice routes
   * got their own parser this returned 413, and a webhook that 413s is one the
   * vendor retries and then disables.
   */
  it('accepts a full transcript from a long call', async () => {
    const turns = Array.from({ length: 400 }, (_, index) => ({
      role: index % 2 ? 'agent' : 'user',
      message: 'This is a representative conversational turn of ordinary length for a clinic call.',
      time_in_call_secs: index * 4,
    }));
    const body = { type: 'post_call_transcription', data: { conversation_id: 'c_long', transcript: turns } };
    const { raw, header } = signed(body);
    expect(raw.length).toBeGreaterThan(32 * 1024);

    const response = await request(app)
      .post('/voice/post-call')
      .set('content-type', 'application/json')
      .set('elevenlabs-signature', header)
      .send(raw);
    expect(response.status).toBe(200);
  });

  it('does not widen the limit on the tool endpoints', async () => {
    // The voice parser is mounted first and must apply only to /voice/*.
    const response = await request(app)
      .post('/search-services')
      .set('x-tool-auth', 'fixture-tool-secret')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ query: 'x'.repeat(40 * 1024) }));
    expect(response.status).toBe(413);
  });
});

describe('POST /voice/call-initiation', () => {
  it('answers with the call context when the shared secret matches', async () => {
    const response = await request(app)
      .post('/voice/call-initiation')
      .set('x-initiation-auth', INITIATION_SECRET)
      .send({ caller_id: '+15551230000', conversation_id: 'conv_1', call_sid: 'CA1' });

    expect(response.status).toBe(200);
    expect(response.body.type).toBe('conversation_initiation_client_data');
    expect(response.body.dynamic_variables.caller_phone).toBe('+15551230000');
    expect(response.body.dynamic_variables.today_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('rejects a missing or wrong shared secret', async () => {
    const missing = await request(app).post('/voice/call-initiation').send({});
    expect(missing.status).toBe(401);

    const wrong = await request(app)
      .post('/voice/call-initiation')
      .set('x-initiation-auth', 'wrong')
      .send({});
    expect(wrong.status).toBe(401);
  });

  /**
   * The caller is listening to silence while this runs. A 4xx here drops a real
   * call, so a body we did not expect must still produce a usable answer.
   */
  it('never fails a call over an unexpected body', async () => {
    const response = await request(app)
      .post('/voice/call-initiation')
      .set('x-initiation-auth', INITIATION_SECRET)
      .send({ caller_id: 12345, surprise: { nested: true } });

    expect(response.status).toBe(200);
    expect(Object.keys(response.body.dynamic_variables).sort())
      .toEqual(Object.keys(initiationVariables('')).sort());
  });

  it('reports the same day the /current-date tool reports', async () => {
    const initiation = await request(app)
      .post('/voice/call-initiation')
      .set('x-initiation-auth', INITIATION_SECRET)
      .send({ caller_id: '+15551230000' });

    const tool = await request(app)
      .get('/current-date')
      .set('x-tool-auth', 'fixture-tool-secret');

    expect(initiation.body.dynamic_variables.today_date).toBe(tool.body.today.date);
    expect(initiation.body.dynamic_variables.today_day_of_week).toBe(tool.body.today.day_of_week);
  });
});

describe('signature parsing', () => {
  it('accepts the vendor format and rejects everything else', () => {
    expect(parseSignatureHeader('t=1700000000,v0=abc123')).toEqual({
      timestampSeconds: 1700000000,
      digestHex: 'abc123',
    });
    expect(parseSignatureHeader('v0=abc123')).toBeNull();
    expect(parseSignatureHeader('t=nope,v0=abc')).toBeNull();
    expect(parseSignatureHeader('t=1,v0=not-hex!')).toBeNull();
  });

  it('computes the digest over `${timestamp}.${rawBody}`, as the vendor SDK does', () => {
    const raw = '{"a":1}';
    const expected = crypto.createHmac('sha256', 'k').update('123.{"a":1}', 'utf8').digest('hex');
    expect(expectedDigest('k', '123', raw)).toBe(expected);
  });
});
