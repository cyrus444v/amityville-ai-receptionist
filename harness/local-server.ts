/**
 * Local voice-agent server.
 *
 * Boots the real Express app with the in-memory Google doubles injected by
 * local-fakes-preload.cjs, seeds a couple of demo appointments, and prints
 * everything needed to point a voice frontend at this process.
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

const PORT = Number(process.env.PORT ?? 3001);
const DEMO_CALLER = process.env.DEMO_CALLER_PHONE ?? '+16315550123';

/**
 * Which clinic this local process serves. There is no application-level default
 * — every entry point names its clinic — so the local server names clinic #1 and
 * says so in the banner. Serve another clinic with:
 *
 *   TENANT_SLUG=riverside-physio npm run dev:local
 */
if (!process.env.TENANT_SLUG && !process.env.TENANT_CONFIG_JSON && !process.env.TENANT_CONFIG_PATH) {
  process.env.TENANT_SLUG = 'amityville-wellness';
}

/** Ephemeral per-boot secrets. Never reuse these anywhere real. */
function ephemeral(name: string): string {
  if (!process.env[name]) process.env[name] = `dev-${crypto.randomBytes(24).toString('hex')}`;
  return process.env[name] as string;
}

process.env.NODE_ENV ??= 'development';
const toolSecret = ephemeral('TOOL_AUTH_SECRET');
ephemeral('APPOINTMENT_TOKEN_SECRET');
process.env.RATE_LIMIT_MAX ??= '240';

/** dayjs day-of-week index for each tenant day key. */
const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

async function main(): Promise<void> {
  const { sheetsFake, calendarFake, mailerFake, resetFakes } = await import('./fake-google');
  const { tenant, DAY_KEYS } = await import('../src/config/tenant');
  const { resetMemoryCoordinationForTests } = await import('../src/services/coordination');
  const { createApp } = await import('../src/index');

  const TZ = tenant.timezone;
  const openWeekdays = new Set(
    DAY_KEYS.filter((day) => !tenant.business_hours[day].closed).map((day) => WEEKDAY_INDEX[day]),
  );

  /** The clinic's next open day, whichever days those are. */
  function nextOpenDay(offsetDays = 1): string {
    let cursor = dayjs().tz(TZ).add(offsetDays, 'day').startOf('day');
    while (!openWeekdays.has(cursor.day())) cursor = cursor.add(1, 'day');
    return cursor.format('YYYY-MM-DD');
  }

  const demoDate = nextOpenDay(1);
  const demoDayKey = DAY_KEYS.find((day) => WEEKDAY_INDEX[day] === dayjs.tz(demoDate, TZ).day())!;
  const demoHours = tenant.business_hours[demoDayKey];
  const demoService = tenant.services[0];
  const demoDuration = demoService.duration_minutes ?? tenant.default_appointment_duration_minutes;

  /** Every whole hour the clinic is open on the demo day, in HH:MM. */
  const bookableHours: string[] = [];
  for (let minute = toMinutes(demoHours.open); minute + 60 <= toMinutes(demoHours.close); minute += 60) {
    bookableHours.push(`${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`);
  }

  // Seed the demo two hours in, when the day is long enough, so a checker still
  // has free slots before and after it.
  const demoTime = bookableHours[Math.min(2, bookableHours.length - 1)] ?? demoHours.open;

  /** (Re)creates the demo appointment plus its backing calendar event. */
  async function seedDemo(): Promise<string> {
    const eventId = await calendarFake.createCalendarEvent({
      summary: `Demo — ${demoService.name}`,
      description: 'Seeded by the local server',
      date: demoDate,
      startTime: demoTime,
      durationMinutes: demoDuration,
      tz: TZ,
    });
    return sheetsFake.seedAppointment({
      id: 'demo-appt-1',
      caller_name: 'Demo Patient',
      phone: DEMO_CALLER,
      service_name: demoService.name,
      appointment_date: demoDate,
      appointment_time: demoTime,
      duration_minutes: String(demoDuration),
      timezone: TZ,
      status: 'confirmed',
      google_event_id: eventId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  const demoId = await seedDemo();
  const inner = createApp();

  // Outer shell only observes; it never parses the body, so a future webhook
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
      demo_time: demoTime,
      demo_service: demoService.name,
      bookable_hours: bookableHours,
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
    console.log(`  Serving              ${tenant.display_name}  [${tenant.slug}]`);
    console.log(`  Timezone             ${TZ}`);
    console.log(`  URL                  http://localhost:${PORT}`);
    console.log(`  Public health check  http://localhost:${PORT}/health`);
    console.log(`  Reset state          curl -X POST http://localhost:${PORT}/__local/reset`);
    console.log('');
    console.log('  Voice-tool headers the call handler must send:');
    console.log(`    x-tool-auth             ${toolSecret}`);
    console.log('    x-call-id        <per-call id>');
    console.log('    x-caller-phone   <caller number>');
    console.log('');
    console.log('  (both regenerate on every boot — they are throwaway dev values)');
    console.log('');
    console.log('  Seeded demo data for reschedule/cancel flows:');
    console.log(`    appointment_id   ${demoId}`);
    console.log(`    caller number    ${DEMO_CALLER}   <- call from this number, or override`);
    console.log(`    when             ${demoDate} at ${demoTime} (${demoService.name})`);
    console.log('');
    console.log(`  ${demoDayKey.charAt(0).toUpperCase() + demoDayKey.slice(1)} hours: ${demoHours.open}-${demoHours.close}`);
    console.log(`  Bookable same day: ${bookableHours.filter((hour) => hour !== demoTime).join(', ')}`);
    console.log('');
    console.log(`  npm run local:check -- --secret ${toolSecret}`);
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
