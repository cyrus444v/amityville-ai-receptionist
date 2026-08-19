#!/usr/bin/env node
/**
 * Drives a full voice-agent flow against a running local server.
 *
 *   npm run dev:local          # in one terminal
 *   npm run local:check        # in another
 *
 * Unlike the vitest harness — which mounts the app in-process — this talks to a
 * real listening server over real HTTP, so it also proves the process boots,
 * the middleware order survives a real socket, and the webhook signature
 * verification works against actual raw bytes.
 *
 * Reads the ephemeral tool secret from the environment or from --secret.
 */

import crypto from 'node:crypto';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const base = (arg('base', process.env.LOCAL_BASE_URL ?? 'http://localhost:3001')).replace(/\/+$/, '');
const toolSecret = arg('secret', process.env.TOOL_AUTH_SECRET);
const webhookSecret = arg('webhook-secret', process.env.RETELL_WEBHOOK_SECRET);
const caller = arg('caller', process.env.DEMO_CALLER_PHONE ?? '+16315550123');

if (!toolSecret) {
  console.error('Missing tool secret. Pass --secret <value> (printed in the dev:local banner).');
  process.exit(2);
}

// Start from a clean slate when the local shell offers a reset hook, so the
// checker is re-runnable against a long-lived dev server.
const resetResponse = await fetch(`${base}/__local/reset`, { method: 'POST' }).catch(() => null);
const resetInfo = resetResponse && resetResponse.ok ? await resetResponse.json() : null;
if (resetInfo) console.log(`ok    local state reset (demo ${resetInfo.demo_date} ${resetInfo.demo_time})`);
else console.log('note  no /__local/reset available — results may depend on existing state');

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function call(path, { method = 'GET', body, headers = {}, auth = true, raw } = {}) {
  const merged = { 'content-type': 'application/json', ...headers };
  if (auth) {
    merged['x-tool-auth'] = toolSecret;
    merged['x-retell-call-id'] = headers['x-retell-call-id'] ?? 'local-check';
    merged['x-retell-caller-phone'] = headers['x-retell-caller-phone'] ?? caller;
  }
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
  const response = await fetch(`${base}${path}`, {
    method,
    headers: merged,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed };
}

// --- boundary ---------------------------------------------------------------
record('health is public', (await call('/health', { auth: false })).status === 200);
record('protected tool rejects anonymous', (await call('/current-date', { auth: false })).status === 401);
record('protected tool accepts the credential', (await call('/current-date')).status === 200);
record(
  'lookup rejects a caller number that does not match',
  (await call('/find-appointment', { method: 'POST', body: { phone: caller }, headers: { 'x-retell-caller-phone': '+19995550000' } })).status === 403,
);

// --- webhook signature ------------------------------------------------------
{
  const unsigned = await call('/retell/webhook', { method: 'POST', auth: false, body: { event: 'call_ended' } });
  record('webhook rejects an unsigned body', unsigned.status === 401, `got ${unsigned.status}`);

  if (webhookSecret) {
    const payload = JSON.stringify({ event: 'call_ended', call_id: 'local-check' });
    const timestamp = String(Date.now());
    const digest = crypto.createHmac('sha256', webhookSecret).update(payload + timestamp, 'utf8').digest('hex');
    const signed = await call('/retell/webhook', {
      method: 'POST',
      auth: false,
      raw: payload,
      headers: { 'x-retell-signature': `v=${timestamp},d=${digest}` },
    });
    record('webhook accepts a correctly signed body', signed.status === 204, `got ${signed.status}`);

    const tampered = await call('/retell/webhook', {
      method: 'POST',
      auth: false,
      raw: `${payload} `,
      headers: { 'x-retell-signature': `v=${timestamp},d=${digest}` },
    });
    record('webhook rejects a body altered after signing', tampered.status === 401, `got ${tampered.status}`);
  } else {
    console.log('skip  webhook signature round-trip (pass --webhook-secret to enable)');
  }
}

// --- booking flow -----------------------------------------------------------
const today = await call('/current-date');
const todayDate = today.body?.today?.date;
record(
  'current-date returns an ISO date the model can anchor on',
  typeof todayDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(todayDate) && typeof today.body?.today?.day_of_week === 'string',
  `${todayDate} (${today.body?.today?.day_of_week})`,
);

// The clinic decides which day and which hours are bookable, so the checker asks
// it rather than assuming. That is what lets this same script verify a second
// clinic with a different week and a different catalogue.
const bookingDate = arg('date', process.env.LOCAL_CHECK_DATE ?? resetInfo?.demo_date);

const clinic = await call('/clinic-info');
const clinicHours = clinic.body?.clinic?.business_hours;
record('clinic-info reports the clinic and its hours', Boolean(clinic.body?.clinic?.name) && Boolean(clinicHours),
  String(clinic.body?.clinic?.name));

const catalogue = await call('/services');
const offered = (catalogue.body?.services ?? []).map((service) => service.name);
record('the clinic offers a catalogue to book from', offered.length > 0, `${offered.length} services`);

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Whole hours the clinic is open on `date`, excluding the seeded demo slot. */
function bookableHoursOn(date) {
  const dayName = DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()];
  const hours = clinicHours?.[dayName];
  if (!hours || hours.closed) return [];
  const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const slots = [];
  for (let at = minutes(hours.open); at + 60 <= minutes(hours.close); at += 60) {
    slots.push(`${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`);
  }
  return slots.filter((slot) => slot !== resetInfo?.demo_time);
}

if (!bookingDate) {
  console.log('\nPass --date YYYY-MM-DD (the seeded date from the dev:local banner) to run the booking flow.');
} else if (bookableHoursOn(bookingDate).length < 3) {
  console.log(`\n${bookingDate} has fewer than three free hours in this clinic's schedule; pass --date for one of its open days.`);
} else {
  const [firstSlot, secondSlot, thirdSlot] = bookableHoursOn(bookingDate);
  const service = offered[0];
  console.log(`note  booking ${service} on ${bookingDate} at ${firstSlot}/${secondSlot}, rescheduling to ${thirdSlot}`);

  const availability = await call('/check-availability', { method: 'POST', body: { date: bookingDate, time: firstSlot } });
  record('availability check succeeds', availability.body.available === true, String(availability.body.status));

  const booking = await call('/create-appointment', {
    method: 'POST',
    body: {
      full_name: 'Local Check',
      phone: caller,
      service,
      date: bookingDate,
      time: firstSlot,
      first_visit: true,
      referral_source: 'Local check',
    },
  });
  record('booking succeeds', booking.body.success === true, booking.body.message ?? '');

  const replay = await call('/create-appointment', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'local-check-1' },
    body: { full_name: 'Local Check', phone: caller, service, date: bookingDate, time: secondSlot },
  });
  const replayAgain = await call('/create-appointment', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'local-check-1' },
    body: { full_name: 'Local Check', phone: caller, service, date: bookingDate, time: secondSlot },
  });
  record('idempotent retry replays instead of double-booking', replay.status === 200 && replayAgain.status === 200);

  const taken = await call('/check-availability', { method: 'POST', body: { date: bookingDate, time: firstSlot } });
  record('the slot just booked is now unavailable', taken.body.available === false, String(taken.body.status));

  // two-step verified lookup, then reschedule
  const first = await call('/find-appointment', { method: 'POST', body: { phone: caller, appointment_date: bookingDate, appointment_time: firstSlot } });
  const token = first.body.appointment_token;
  record('unique lookup returns only a selection token', first.body.selection_required === true && Boolean(token) && first.body.service === undefined);

  const details = await call('/find-appointment', { method: 'POST', body: { phone: caller, appointment_token: token } });
  record('token exchange discloses the appointment', details.body.found === true && details.body.time === firstSlot);

  const noToken = await call('/reschedule-appointment', { method: 'POST', body: { phone: caller, new_date: bookingDate, new_time: thirdSlot } });
  record('reschedule without a token is refused', noToken.status === 400);

  const stolen = await call('/reschedule-appointment', {
    method: 'POST',
    headers: { 'x-retell-caller-phone': '+19995550000' },
    body: { appointment_id: details.body.appointment_id, phone: caller, appointment_token: token, new_date: bookingDate, new_time: thirdSlot },
  });
  record('reschedule from another caller is refused', stolen.status === 404 || stolen.status === 403);

  const moved = await call('/reschedule-appointment', {
    method: 'POST',
    body: { appointment_id: details.body.appointment_id, phone: caller, appointment_token: token, new_date: bookingDate, new_time: thirdSlot },
  });
  record('verified reschedule succeeds', moved.body.success === true, moved.body.message ?? '');

  const cancelled = await call('/cancel-appointment', {
    method: 'POST',
    body: { appointment_id: details.body.appointment_id, phone: caller, appointment_token: token },
  });
  record('verified cancellation succeeds', cancelled.body.success === true);

  const services = await call('/search-services', { method: 'POST', body: { query: service } });
  record('service search is grounded in this clinic\'s own catalogue',
    (services.body.count ?? 0) > 0 && (services.body.service_names ?? []).includes(service),
    String(services.body.service_names));

  const callback = await call('/create-callback', { method: 'POST', body: { caller_name: 'Local Check', phone: caller } });
  record('callback fallback works', callback.body.success === true);
}

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} local checks passed against ${base}`);
process.exit(failed.length === 0 ? 0 : 1);
