/**
 * Onboarding proof: a second clinic, configured only by a tenant file, boots the
 * same application and serves the whole voice flow as itself.
 *
 * Riverside deliberately disagrees with clinic #1 on every axis that used to be
 * hardcoded — a different timezone, a different week (it opens on Sunday and
 * closes on Saturday, the reverse of clinic #1), a different services list, a
 * different email footer. If any of those were still baked into the code rather
 * than the configuration, this file fails.
 *
 * It boots by pointing TENANT_CONFIG_PATH at the second clinic before importing
 * the app, which is the same resolution path a container uses with
 * TENANT_CONFIG_JSON.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

import { calendarFake, mailerFake, sheetsFake, resetFakes } from '../../harness/fake-google';
import { VoiceCall } from '../../harness/driver';

vi.mock('../../src/db/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/db/client')>();
  return {
    ...original,
    initSheets: () => sheetsFake.initSheets(),
    appendRow: (...args: Parameters<typeof sheetsFake.appendRow>) => sheetsFake.appendRow(...args),
    getRows: (...args: Parameters<typeof sheetsFake.getRows>) => sheetsFake.getRows(...args),
    updateRowAtIndex: (...args: Parameters<typeof sheetsFake.updateRowAtIndex>) => sheetsFake.updateRowAtIndex(...args),
  };
});

vi.mock('../../src/services/calendar', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/services/calendar')>();
  return {
    ...original,
    isSlotAvailable: (...args: Parameters<typeof calendarFake.isSlotAvailable>) => calendarFake.isSlotAvailable(...args),
    getAvailableSlots: (...args: Parameters<typeof calendarFake.getAvailableSlots>) => calendarFake.getAvailableSlots(...args),
    createCalendarEvent: (...args: Parameters<typeof calendarFake.createCalendarEvent>) => calendarFake.createCalendarEvent(...args),
    updateCalendarEvent: (...args: Parameters<typeof calendarFake.updateCalendarEvent>) => calendarFake.updateCalendarEvent(...args),
    cancelCalendarEvent: (...args: Parameters<typeof calendarFake.cancelCalendarEvent>) => calendarFake.cancelCalendarEvent(...args),
    checkFreeBusy: () => calendarFake.checkFreeBusy(),
  };
});

vi.mock('../../src/services/email', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/services/email')>();
  return {
    ...original,
    sendBookingConfirmation: (...args: Parameters<typeof mailerFake.sendBookingConfirmation>) => mailerFake.sendBookingConfirmation(...args),
  };
});

dayjs.extend(utc);
dayjs.extend(timezone);

const SECOND_TENANT = resolve(__dirname, '../../tenants/riverside-physio.json');
const TZ = 'America/Los_Angeles';
const TOOL_SECRET = 'fixture-tool-secret';
const CALLER = '+19515550199';

const previousSlug = process.env.TENANT_SLUG;
const previousPath = process.env.TENANT_CONFIG_PATH;

/** The clinic this process serves is chosen before the app is imported. */
function serveSecondTenant(): void {
  process.env.TENANT_CONFIG_PATH = SECOND_TENANT;
  delete process.env.TENANT_SLUG;
}

afterAll(() => {
  if (previousPath === undefined) delete process.env.TENANT_CONFIG_PATH;
  else process.env.TENANT_CONFIG_PATH = previousPath;
  if (previousSlug !== undefined) process.env.TENANT_SLUG = previousSlug;
});

function upcoming(weekday: number): string {
  let cursor = dayjs().tz(TZ).add(8, 'day').startOf('day');
  while (cursor.day() !== weekday) cursor = cursor.add(1, 'day');
  return cursor.format('YYYY-MM-DD');
}

const MONDAY = upcoming(1);   // Riverside: 08:00-16:00
const SUNDAY = upcoming(0);   // Riverside: 09:00-13:00. Clinic #1 is closed on Sundays.
const SATURDAY = upcoming(6); // Riverside: closed. Clinic #1 is open on Saturdays.

async function freshApp() {
  serveSecondTenant();
  vi.resetModules();
  const coordination = await import('../../src/services/coordination');
  coordination.resetMemoryCoordinationForTests();
  const { createApp } = await import('../../src/index');
  return createApp();
}

async function loadedConfig() {
  serveSecondTenant();
  vi.resetModules();
  return import('../../src/config');
}

function newCall(app: Awaited<ReturnType<typeof freshApp>>, scenarioId: string) {
  return new VoiceCall({ app, scenarioId, callerPhone: CALLER, callId: `second-${scenarioId}`, toolSecret: TOOL_SECRET });
}

beforeEach(() => {
  resetFakes();
});

describe('a second clinic, configured only by a tenant file', () => {
  it('boots as itself', async () => {
    const { config } = await loadedConfig();
    expect(config.business.slug).toBe('riverside-physio');
    expect(config.business.name).toBe('Riverside Physiotherapy & Rehab');
    expect(config.business.timezone).toBe(TZ);
    expect(config.business.defaultDuration).toBe(45);
    expect(config.business.phone).toBe('+1 951-555-0100');
  });

  it('reports its own hours, not clinic #1\'s', async () => {
    const app = await freshApp();
    const response = await newCall(app, 'clinic-info').tool('get_current_date');
    expect(response.status).toBe(200);
    expect(response.response.timezone).toBe(TZ);

    const { config } = await loadedConfig();
    expect(config.business.businessHours.sunday).toEqual({ open: '09:00', close: '13:00', closed: false });
    expect(config.business.businessHours.saturday.closed).toBe(true);
    expect(config.business.businessHours.wednesday.closed).toBe(true);
  });

  it('opens on the day clinic #1 is closed, and closes on the day clinic #1 is open', async () => {
    const app = await freshApp();
    const call = newCall(app, 'week-shape');

    const sunday = await call.tool('check_availability', { date: SUNDAY, time: '10:00' });
    expect(sunday.response.status).toBe('AVAILABLE');

    const saturday = await call.tool('check_availability', { date: SATURDAY, time: '10:00' });
    expect(saturday.response.status).toBe('CLOSED_DAY');
    expect(String(saturday.response.message)).toContain('Sunday 9 AM–1 PM');
  });

  it('refuses a time outside its own opening hours', async () => {
    const app = await freshApp();
    const call = newCall(app, 'hours');
    // 16:00 is inside clinic #1's Tuesday but is Riverside's Monday closing time.
    const late = await call.tool('check_availability', { date: MONDAY, time: '16:00' });
    expect(late.response.status).toBe('OUTSIDE_HOURS');

    const early = await call.tool('check_availability', { date: MONDAY, time: '08:00' });
    expect(early.response.status).toBe('AVAILABLE');
  });

  it('offers its own services and none of clinic #1\'s', async () => {
    const app = await freshApp();
    const call = newCall(app, 'services');

    const own = await call.tool('search_services', { query: 'dry needling' });
    expect(own.response.count).toBe(1);
    expect(own.response.service_names).toEqual(['Dry Needling']);

    // Note: search matches keywords by substring in both directions, so
    // "microneedling" would match Riverside's "needling". That is pre-existing
    // behaviour, identical for clinic #1; probe with a term that shares no
    // substring with anything Riverside offers.
    const foreign = await call.tool('search_services', { query: 'acupuncture' });
    expect(foreign.response.count).toBe(0);

    const all = await call.tool('search_services', { query: 'what services do you offer' });
    expect(all.response.service_names).toEqual(['Physiotherapy', 'Dry Needling', 'Gait Analysis']);
    expect(JSON.stringify(all.response)).not.toMatch(/amityville/i);
  });

  it('serves the whole flow — book, look up, reschedule, cancel — as itself', async () => {
    const app = await freshApp();
    const call = newCall(app, 'full-flow');

    const booked = await call.tool('create_appointment', {
      full_name: 'Sam Okonkwo',
      phone: CALLER,
      service: 'Physiotherapy',
      date: MONDAY,
      time: '09:00',
      first_visit: true,
    });
    expect(booked.status).toBe(200);
    expect(booked.response.success).toBe(true);

    // The clinic's own default duration, not clinic #1's sixty minutes.
    const stored = sheetsFake.snapshot('Appointments');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain('45');

    const taken = await call.tool('check_availability', { date: MONDAY, time: '09:00' });
    expect(taken.response.available).toBe(false);

    const lookup = await call.tool('find_appointment', { phone: CALLER });
    expect(lookup.response.selection_required).toBe(true);
    const token = lookup.response.appointment_token as string;
    expect(token).toBeTruthy();

    const details = await call.tool('find_appointment', { phone: CALLER, appointment_token: token });
    expect(details.response.found).toBe(true);
    expect(details.response.service).toBe('Physiotherapy');

    const moved = await call.tool('reschedule_appointment', {
      appointment_id: details.response.appointment_id,
      phone: CALLER,
      appointment_token: token,
      new_date: SUNDAY,
      new_time: '10:00',
    });
    expect(moved.response.success).toBe(true);

    const cancelled = await call.tool('cancel_appointment', {
      appointment_id: details.response.appointment_id,
      phone: CALLER,
      appointment_token: token,
    });
    expect(cancelled.response.success).toBe(true);
    expect(calendarFake.activeEvents()).toHaveLength(0);
  });

  it('keeps the auth boundary closed for the second clinic too', async () => {
    const app = await freshApp();
    const call = newCall(app, 'boundary');

    const anonymous = await call.tool('get_current_date', {}, { headers: { 'x-tool-auth': undefined } });
    expect(anonymous.status).toBe(401);

    const otherCaller = await call.tool('find_appointment',
      { phone: CALLER },
      { headers: { 'x-retell-caller-phone': '+19995550000' } });
    expect(otherCaller.status).toBe(403);
  });

  it('signs its confirmation email with its own name and locality', async () => {
    serveSecondTenant();
    vi.resetModules();
    const { renderConfirmationEmail } = await import('../../src/services/email');
    const rendered = renderConfirmationEmail({
      to: 'patient@example.invalid',
      caller_name: 'Sam Okonkwo',
      service: 'Physiotherapy',
      date: MONDAY,
      time: '09:00',
      duration_minutes: 45,
    });
    expect(rendered.from).toBe('Riverside Physiotherapy & Rehab <onboarding@resend.dev>');
    expect(rendered.html).toContain('Riverside, CA');
    expect(rendered.html).not.toMatch(/amityville/i);
  });

  it('renders a system prompt with no trace of clinic #1', async () => {
    const { readFileSync } = await import('node:fs');
    const { renderSystemPrompt } = await import('../../retell/render-prompt.mjs');
    const templateText = readFileSync(resolve(__dirname, '../../retell/system-prompt.template.txt'), 'utf8');
    const tenant = JSON.parse(readFileSync(SECOND_TENANT, 'utf8'));
    const prompt: string = renderSystemPrompt({ templateText, tenant });

    for (const marker of ['amityville', 'broadway', 'hurme', '631', 'acupuncture']) {
      expect(prompt.toLowerCase(), `prompt still mentions ${marker}`).not.toContain(marker);
    }
    expect(prompt).toContain('BUSINESS HOURS (Pacific Time):');
    expect(prompt).toContain('- Sunday: 9 AM – 1 PM');
    expect(prompt).toContain('- Wednesday, Friday, Saturday: CLOSED');
    expect(prompt).toContain(tenant.prompt.spoken_name);
    expect(prompt).toContain('You are the virtual receptionist for Riverside Physio in Riverside, California.');
  });
});
