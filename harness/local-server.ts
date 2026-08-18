/**
 * Local voice-agent server.
 *
 * Boots the real Express app with the in-memory Google doubles injected by
 * local-fakes-preload.cjs, seeds a couple of demo appointments, and prints
 * everything needed to point a live Retell agent at this process.
 *
 * The point: you can make a real phone call, hear the real agent, and watch real
 * tool calls land — while no calendar, spreadsheet, mailbox or AWS resource is
 * ever touched. Secrets are generated per boot and thrown away on exit.
 *
 *   npm run dev:local
 */

import crypto from 'crypto';
import express from 'express';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

if (process.env.NODE_ENV === 'production') {
  throw new Error('The local server must never run with NODE_ENV=production.');
}

const TZ = process.env.TIMEZONE ?? 'America/New_York';
const PORT = Number(process.env.PORT ?? 3001);
const DEMO_CALLER = process.env.DEMO_CALLER_PHONE ?? '+16315550123';

/** Ephemeral per-boot secrets. Never reuse these anywhere real. */
function ephemeral(name: string): string {
  if (!process.env[name]) process.env[name] = `dev-${crypto.randomBytes(24).toString('hex')}`;
  return process.env[name] as string;
}

process.env.NODE_ENV ??= 'development';
const toolSecret = ephemeral('TOOL_AUTH_SECRET');
ephemeral('APPOINTMENT_TOKEN_SECRET');
const webhookSecret = ephemeral('RETELL_WEBHOOK_SECRET');
process.env.TIMEZONE ??= TZ;
process.env.RATE_LIMIT_MAX ??= '240';

function nextOpenDay(offsetDays = 1): string {
  const openWeekdays = new Set([2, 3, 5, 6]); // Tue, Wed, Fri, Sat
  let cursor = dayjs().tz(TZ).add(offsetDays, 'day').startOf('day');
  while (!openWeekdays.has(cursor.day())) cursor = cursor.add(1, 'day');
  return cursor.format('YYYY-MM-DD');
}

async function main(): Promise<void> {
  const { sheetsFake, calendarFake, mailerFake, resetFakes } = await import('./fake-google');
  const { resetMemoryCoordinationForTests } = await import('../src/services/coordination');
  const { createApp } = await import('../src/index');

  const demoDate = nextOpenDay(1);

  /** (Re)creates the demo appointment plus its backing calendar event. */
  async function seedDemo(): Promise<string> {
    const eventId = await calendarFake.createCalendarEvent({
      summary: 'Demo — Acupuncture',
      description: 'Seeded by the local server',
      date: demoDate,
      startTime: '11:00',
      durationMinutes: 60,
      tz: TZ,
    });
    return sheetsFake.seedAppointment({
      id: 'demo-appt-1',
      caller_name: 'Demo Patient',
      phone: DEMO_CALLER,
      service_name: 'Acupuncture',
      appointment_date: demoDate,
      appointment_time: '11:00',
      duration_minutes: '60',
      timezone: TZ,
      status: 'confirmed',
      google_event_id: eventId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  const demoId = await seedDemo();
  const inner = createApp();

  // Outer shell only observes; it never parses the body, so the Retell webhook
  // still sees the exact raw bytes it needs for signature verification.
  const outer = express();
  outer.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const marker = res.statusCode >= 400 ? 'x' : '>';
      // eslint-disable-next-line no-console
      console.log(`${marker} ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`);
    });
    next();
  });

  // Dev-only: wipe the in-memory calendar, spreadsheet, mailbox and coordination
  // state and re-seed the demo appointment. Lets you rerun a test call or
  // `npm run local:check` from a clean slate without restarting. This route
  // exists only in this local shell — it is not part of the deployed app.
  outer.post('/__local/reset', async (_req, res) => {
    resetFakes();
    resetMemoryCoordinationForTests();
    const seeded = await seedDemo();
    // eslint-disable-next-line no-console
    console.log('  [reset] in-memory state cleared, demo appointment re-seeded');
    res.json({
      reset: true,
      demo_appointment_id: seeded,
      demo_caller_phone: DEMO_CALLER,
      demo_date: demoDate,
      demo_time: '11:00',
    });
  });

  outer.use(inner);

  outer.listen(PORT, () => {
    const line = '─'.repeat(74);
    /* eslint-disable no-console */
    console.log(`\n${line}`);
    console.log('  AIVANCE voice agent — LOCAL MODE');
    console.log('  Calendar, spreadsheet and email are in-memory. Nothing real is touched.');
    console.log(line);
    console.log(`  URL                  http://localhost:${PORT}`);
    console.log(`  Public health check  http://localhost:${PORT}/health`);
    console.log(`  Reset state          curl -X POST http://localhost:${PORT}/__local/reset`);
    console.log('');
    console.log('  Retell custom-tool headers (paste as agent dynamic variables):');
    console.log(`    x-tool-auth             ${toolSecret}`);
    console.log('    x-retell-call-id        {{call_id}}');
    console.log('    x-retell-caller-phone   {{user_number}}');
    console.log('');
    console.log(`  Retell webhook secret   ${webhookSecret}`);
    console.log('  (both regenerate on every boot — they are throwaway dev values)');
    console.log('');
    console.log('  Seeded demo data for reschedule/cancel flows:');
    console.log(`    appointment_id   ${demoId}`);
    console.log(`    caller number    ${DEMO_CALLER}   <- call from this number, or override`);
    console.log(`    when             ${demoDate} at 11:00 (Acupuncture)`);
    console.log('');
    console.log('  Bookable same day: 09:00, 10:00, 13:00, 14:00, 15:00, 16:00');
    console.log(`${line}\n`);
    /* eslint-enable no-console */
  });

  const report = setInterval(() => {
    const appointments = sheetsFake.snapshot('Appointments').length;
    const callbacks = sheetsFake.snapshot('Callbacks').length;
    const events = calendarFake.activeEvents().length;
    if (sheetsFake.writes.length > 0 || mailerFake.sent.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`  [state] appointments=${appointments} callbacks=${callbacks} calendar=${events} emails=${mailerFake.sent.length}`);
      sheetsFake.writes.length = 0;
    }
  }, 15_000);
  report.unref();
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('local server failed to start:', error);
  process.exit(1);
});
