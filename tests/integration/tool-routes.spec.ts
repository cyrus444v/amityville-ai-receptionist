import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  checkAvailability: vi.fn(),
  createAppointment: vi.fn(),
  rescheduleAppointment: vi.fn(),
  cancelAppointment: vi.fn(),
  createCallback: vi.fn(),
  getRows: vi.fn(),
}));

vi.mock('../../src/services/booking', () => ({
  checkAvailability: serviceMocks.checkAvailability,
  createAppointment: serviceMocks.createAppointment,
  rescheduleAppointment: serviceMocks.rescheduleAppointment,
  cancelAppointment: serviceMocks.cancelAppointment,
}));
vi.mock('../../src/services/callback', () => ({ createCallback: serviceMocks.createCallback }));
vi.mock('../../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../../src/db/client')>('../../src/db/client');
  return { ...actual, getRows: serviceMocks.getRows, initSheets: vi.fn(async () => undefined) };
});

import { APPT } from '../../src/db/client';
import { createApp } from '../../src/index';
import { secretsMatch } from '../../src/middleware/tool-auth';
import { resetMemoryCoordinationForTests } from '../../src/services/coordination';

const auth = { 'x-tool-auth': 'fixture-tool-secret' };

function validCreate() {
  return {
    full_name: 'Fixture Patient',
    phone: '5551234567',
    service: 'Acupuncture',
    date: '2026-08-19',
    time: '10:00',
    first_visit: true,
    referral_source: 'Search',
    notes: 'Shoulder pain from tennis',
  };
}

describe('public voice-tool boundary', () => {
  beforeEach(() => {
    resetMemoryCoordinationForTests();
    serviceMocks.checkAvailability.mockResolvedValue({ available: true, status: 'AVAILABLE', message: 'Available.' });
    serviceMocks.createAppointment.mockResolvedValue({ success: true, message: 'Confirmed.' });
    serviceMocks.rescheduleAppointment.mockResolvedValue({ success: true, message: 'Rescheduled.' });
    serviceMocks.cancelAppointment.mockResolvedValue({ success: true, message: 'Cancelled.' });
    serviceMocks.createCallback.mockResolvedValue({ success: true, message: 'Callback saved.' });
    serviceMocks.getRows.mockResolvedValue([]);
  });

  it('requires v1 authentication on legacy and versioned tool URLs', async () => {
    const app = createApp();
    await request(app).post('/check-availability').send({ date: '2026-08-19' }).expect(401);
    await request(app).post('/check-availability').set(auth).send({ date: '2026-08-19' }).expect(200)
      .expect('X-Tool-Auth-Version', 'v1');
    await request(app).post('/v1/check-availability').set(auth).send({ date: '2026-08-19' }).expect(200)
      .expect('X-Tool-Auth-Version', 'v1');
  });

  it('uses constant-length secret comparison for arbitrary inputs', () => {
    expect(secretsMatch('fixture-tool-secret', 'fixture-tool-secret')).toBe(true);
    expect(secretsMatch('', 'fixture-tool-secret')).toBe(false);
    expect(secretsMatch('x'.repeat(10_000), 'fixture-tool-secret')).toBe(false);
  });

  it.each(['/', '/health', '/clinic-info', '/services'])(
    'keeps %s usable without tool credentials',
    async (route) => {
      await request(createApp()).get(route).expect(200);
    },
  );

  it('protects get_current_date because it is a Retell tool', async () => {
    await request(createApp()).get('/current-date').expect(401);
    await request(createApp()).get('/current-date').set(auth).expect(200);
  });

  it('normalizes and forwards every create_appointment compatibility field', async () => {
    await request(createApp()).post('/create-appointment').set(auth).send(validCreate()).expect(200);
    expect(serviceMocks.createAppointment).toHaveBeenCalledWith(expect.objectContaining({
      caller_name: 'Fixture Patient',
      full_name: 'Fixture Patient',
      first_visit: true,
      is_new_patient: true,
      referral_source: 'Search',
      notes: 'Shoulder pain from tennis',
    }));
  });

  it('looks up only the normalized phone and never logs patient phone data', async () => {
    const row = new Array(17).fill('');
    row[APPT.id] = 'appt-fixture';
    row[APPT.caller_name] = 'Fixture Patient';
    row[APPT.phone] = '5551234567';
    row[APPT.service_name] = 'Acupuncture';
    row[APPT.appointment_date] = '2026-08-19';
    row[APPT.appointment_time] = '10:00';
    row[APPT.status] = 'confirmed';
    serviceMocks.getRows.mockResolvedValue([{ rowIndex: 2, values: row }]);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const app = createApp();
    const selected = await request(app).post('/find-appointment').set(auth)
      .set('x-retell-caller-phone', '+1 (555) 123-4567')
      .send({ phone: '(555) 123-4567' }).expect(200);
    expect(selected.body.selection_required).toBe(true);
    expect(selected.body.appointment_token).toEqual(expect.any(String));
    expect(selected.body).not.toHaveProperty('service');
    expect(selected.body).not.toHaveProperty('caller_name');

    const disclosed = await request(app).post('/find-appointment').set(auth)
      .set('x-retell-caller-phone', '+1 (555) 123-4567')
      .send({ phone: '(555) 123-4567', appointment_token: selected.body.appointment_token }).expect(200);
    expect(disclosed.body.selection_required).toBe(false);
    expect(disclosed.body.service).toBe('Acupuncture');
    expect(logs.mock.calls.flat().join(' ')).not.toMatch(/555\d+/);
  });

  it('rejects unverified and ambiguous appointment lookup without disclosing records', async () => {
    const row = new Array(17).fill('');
    row[APPT.id] = 'appt-one';
    row[APPT.phone] = '5551234567';
    row[APPT.status] = 'confirmed';
    serviceMocks.getRows.mockResolvedValue([
      { rowIndex: 2, values: row },
      { rowIndex: 3, values: [...row.slice(0, APPT.id), 'appt-two', ...row.slice(APPT.id + 1)] },
    ]);
    await request(createApp()).post('/find-appointment').set(auth)
      .send({ phone: '5551234567' }).expect(403)
      .expect((response) => expect(response.body).not.toHaveProperty('appointment_id'));
    await request(createApp()).post('/find-appointment').set(auth).set('x-retell-caller-phone', '5551234567')
      .send({ phone: '5551234567' }).expect(409)
      .expect((response) => {
        expect(response.body.error).toBe('AMBIGUOUS_APPOINTMENT');
        expect(response.body).not.toHaveProperty('appointment_id');
      });
  });

  it('enforces the JSON request-size limit before route execution', async () => {
    await request(createApp()).post('/search-services').set(auth)
      .send({ query: 'x'.repeat(40_000) }).expect(413)
      .expect({ success: false, error: 'REQUEST_TOO_LARGE' });
  });

  it('does not grant browser CORS access to an unconfigured origin', async () => {
    const response = await request(createApp()).get('/services').set('Origin', 'https://untrusted.example').expect(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rate-limits public tool traffic deterministically', async () => {
    const app = createApp();
    for (let index = 0; index < 60; index += 1) {
      await request(app).post('/check-availability').set(auth).send({ date: '2026-08-19' }).expect(200);
    }
    await request(app).post('/check-availability').set(auth).send({ date: '2026-08-19' }).expect(429);
  });

  it('replays write results by idempotency key and rejects payload conflicts', async () => {
    const app = createApp();
    const first = await request(app).post('/create-appointment').set(auth).set('Idempotency-Key', 'retry-1')
      .send(validCreate()).expect(200);
    const replay = await request(app).post('/create-appointment').set(auth).set('Idempotency-Key', 'retry-1')
      .send(validCreate()).expect(200).expect('Idempotency-Replayed', 'true');
    expect(replay.body).toEqual(first.body);
    expect(serviceMocks.createAppointment).toHaveBeenCalledTimes(1);

    await request(app).post('/create-appointment').set(auth).set('Idempotency-Key', 'retry-1')
      .send({ ...validCreate(), time: '11:00' }).expect(409)
      .expect({ success: false, error: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('accepts every declared Retell tool contract without network access', async () => {
    const definitions = JSON.parse(fs.readFileSync(path.resolve('retell/tools.json'), 'utf8')) as Array<{
      name: string;
      parameters: { required: string[] };
    }>;
    const calls: Record<string, { method: 'get' | 'post'; route: string; payload?: Record<string, unknown> }> = {
      get_current_date: { method: 'get', route: '/current-date' },
      check_availability: { method: 'post', route: '/check-availability', payload: { date: '2026-08-19' } },
      find_appointment: { method: 'post', route: '/find-appointment', payload: { phone: '5551234567' } },
      create_appointment: { method: 'post', route: '/create-appointment', payload: validCreate() },
      reschedule_appointment: { method: 'post', route: '/reschedule-appointment', payload: { appointment_id: 'appt-fixture', appointment_token: 'fixture-token-at-least-20-characters', new_date: '2026-08-21', new_time: '10:00' } },
      cancel_appointment: { method: 'post', route: '/cancel-appointment', payload: { appointment_id: 'appt-fixture', appointment_token: 'fixture-token-at-least-20-characters' } },
      create_callback: { method: 'post', route: '/create-callback', payload: { caller_name: 'Fixture Caller', phone: '5551234567' } },
      search_services: { method: 'post', route: '/search-services', payload: { query: 'acupuncture' } },
    };

    expect(Object.keys(calls).sort()).toEqual(definitions.map((tool) => tool.name).sort());
    const app = createApp();
    for (const tool of definitions) {
      const call = calls[tool.name];
      for (const required of tool.parameters.required) expect(call.payload).toHaveProperty(required);
      const pending = call.method === 'get'
        ? request(app).get(call.route).set(auth)
        : request(app).post(call.route).set(auth).set('x-retell-caller-phone', '5551234567').send(call.payload);
      await pending.expect(200);
    }
  });

  it('verifies Retell webhook signatures against the exact raw body', async () => {
    const body = JSON.stringify({ event: 'call_ended', call: { call_id: 'fixture-call' } });
    const timestamp = Date.now();
    const digest = crypto.createHmac('sha256', 'fixture-retell-webhook-secret')
      .update(body + timestamp).digest('hex');
    await request(createApp()).post('/retell/webhook').set('Content-Type', 'application/json')
      .set('x-retell-signature', `v=${timestamp},d=${digest}`).send(body).expect(204);
    await request(createApp()).post('/retell/webhook').set('Content-Type', 'application/json')
      .set('x-retell-signature', `v=${timestamp},d=${'0'.repeat(64)}`).send(body).expect(401);
  });
});
