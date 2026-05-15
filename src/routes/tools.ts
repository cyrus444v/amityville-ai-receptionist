import { Router, Request, Response } from 'express';
import { searchServices, getAllServices, buildSpokenServiceList } from '../services/knowledge';
import { config } from '../config';
import { z } from 'zod';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { google } from 'googleapis';
import { getSupabaseClient } from '../db/client';

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
  return res.json({
    success: true,
    date: now.format('YYYY-MM-DD'),
    day_of_week: now.format('dddd'),
    time: now.format('HH:mm'),
    timezone: tz,
    iso: now.toISOString(),
  });
});

// GET /health — diagnostic endpoint to verify Google Calendar write access and Supabase connectivity
router.get('/health', async (_req: Request, res: Response) => {
  const checks: Record<string, { ok: boolean; detail: string }> = {};

  // 1. Google Calendar — write access (create + delete a throwaway event)
  try {
    const auth = new google.auth.JWT({
      email: config.google.serviceAccountEmail,
      key: config.google.privateKey,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    const calendar = google.calendar({ version: 'v3', auth });
    const tz = config.business.timezone;
    const start = dayjs().tz(tz).add(1, 'day').hour(10).minute(0).second(0);
    const end = start.add(30, 'minute');

    const created = await calendar.events.insert({
      calendarId: config.google.calendarId,
      requestBody: {
        summary: '[health-check — safe to delete]',
        start: { dateTime: start.toISOString(), timeZone: tz },
        end:   { dateTime: end.toISOString(),   timeZone: tz },
      },
    });
    const eventId = created.data.id!;
    await calendar.events.delete({ calendarId: config.google.calendarId, eventId });

    checks.google_calendar = { ok: true, detail: 'Write access confirmed (test event created and deleted)' };
  } catch (err) {
    checks.google_calendar = { ok: false, detail: (err as Error).message };
  }

  // 2. Supabase — connectivity and table existence
  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('appointments').select('id').limit(1);
    if (error) throw new Error(error.message);
    checks.supabase = { ok: true, detail: 'Connected and appointments table exists' };
  } catch (err) {
    checks.supabase = { ok: false, detail: (err as Error).message };
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
