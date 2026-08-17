import { Router, Request, Response } from 'express';
import { searchServices, getAllServices, buildSpokenServiceList } from '../services/knowledge';
import { config } from '../config';
import { z } from 'zod';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { google } from 'googleapis';
import { getRows, SHEET_APPOINTMENTS } from '../db/client';

dayjs.extend(utc);
dayjs.extend(timezone);

const router = Router();

// POST /search-services
router.post('/search-services', (req: Request, res: Response) => {
  const schema = z.object({ query: z.string().min(1, 'Query is required') });
  const parsed = schema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Missing required field: query' });
  }

  const results = searchServices(parsed.data.query);
  const serviceNames = results.map((s) => s.name);
  const spokenSummary = buildSpokenServiceList(results);

  return res.json({
    success: true,
    count: results.length,
    matches: results,
    service_names: serviceNames,
    spoken_summary: spokenSummary,
  });
});

// GET /services
router.get('/services', (_req: Request, res: Response) => {
  return res.json({ success: true, services: getAllServices() });
});

// GET /current-date  — gives the LLM today's date in the business timezone so it can calculate relative dates correctly
router.get('/current-date', (_req: Request, res: Response) => {
  const tz = config.business.timezone;
  const now = dayjs().tz(tz);
  const tomorrow = now.add(1, 'day');
  const dayAfter = now.add(2, 'day');
  return res.json({
    success: true,
    today: {
      date: now.format('YYYY-MM-DD'),
      day_of_week: now.format('dddd'),
    },
    tomorrow: {
      date: tomorrow.format('YYYY-MM-DD'),
      day_of_week: tomorrow.format('dddd'),
    },
    day_after_tomorrow: {
      date: dayAfter.format('YYYY-MM-DD'),
      day_of_week: dayAfter.format('dddd'),
    },
    current_time: now.format('HH:mm'),
    timezone: tz,
  });
});

// GET /health — unauthenticated, non-mutating liveness check
router.get('/health', (_req: Request, res: Response) => {
  return res.json({ ok: true });
});

// GET /health/dependencies — authenticated by the app-level tool boundary.
// Dependency checks are deliberately read-only.
router.get('/health/dependencies', async (_req: Request, res: Response) => {
  const checks: Record<string, { ok: boolean; detail: string }> = {};

  // 1. Google Calendar — read access only
  try {
    const auth = new google.auth.JWT({
      email: config.google.serviceAccountEmail,
      key: config.google.privateKey,
      scopes: ['https://www.googleapis.com/auth/calendar'],
      subject: config.google.impersonateEmail || undefined,
    });
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.calendars.get({ calendarId: config.google.calendarId });
    checks.google_calendar = { ok: true, detail: 'reachable' };
  } catch {
    checks.google_calendar = { ok: false, detail: 'unreachable' };
  }

  // 2. Google Sheets — read access
  try {
    await getRows(SHEET_APPOINTMENTS);
    checks.google_sheets = { ok: true, detail: 'reachable' };
  } catch {
    checks.google_sheets = { ok: false, detail: 'unreachable' };
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  return res.status(allOk ? 200 : 500).json({ ok: allOk, checks });
});

// GET /clinic-info
router.get('/clinic-info', (_req: Request, res: Response) => {
  return res.json({
    success: true,
    clinic: {
      name:          config.business.name,
      timezone:      config.business.timezone,
      phone:         config.business.phone,
      address:       config.business.address,
      website:       config.business.website,
      business_hours: config.business.businessHours,
    },
  });
});

export default router;
