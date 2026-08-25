/**
 * Per-clinic configuration.
 *
 * Everything that differs between clinics lives in one file per clinic under
 * `tenants/`. At runtime the container receives that file's contents verbatim in
 * TENANT_CONFIG_JSON, which keeps one image for every clinic: no per-tenant
 * build, no per-tenant image tag, and a rollback is the same artifact
 * everywhere.
 *
 * Resolution order, first hit wins:
 *   TENANT_CONFIG_JSON   the deployed path — the tenant file's contents inline
 *   TENANT_CONFIG_PATH   an explicit file, for an ad-hoc local run
 *   TENANT_SLUG          tenants/<slug>.json, the convenient local path
 *
 * There is deliberately no built-in default. A clinic whose configuration failed
 * to arrive must not answer its phone under another clinic's name, hours and
 * services — which is exactly what a default would do, and what the hardcoded
 * BUSINESS_NAME fallback used to do.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

/** Repository root, from either `src/config` (ts-node) or `dist/config` (built). */
const REPO_ROOT = resolve(__dirname, '..', '..');
export const TENANTS_DIR = resolve(REPO_ROOT, 'tenants');

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function toMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * A day the clinic is closed carries no meaningful range, so `open`/`close` are
 * only ordered against each other on days it is open.
 */
const dayHoursSchema = z
  .object({
    open: z.string().regex(HH_MM, 'open must be HH:MM in 24-hour form'),
    close: z.string().regex(HH_MM, 'close must be HH:MM in 24-hour form'),
    closed: z.boolean(),
  })
  .strict()
  .superRefine((day, ctx) => {
    if (day.closed) return;
    if (toMinutes(day.open) >= toMinutes(day.close)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `an open day must close after it opens, got ${day.open}-${day.close}`,
      });
    }
  });

/**
 * All seven days are required. An absent day would otherwise read as "closed"
 * in `booking.ts` and quietly refuse every booking on it.
 */
const businessHoursSchema = z
  .object({
    monday: dayHoursSchema,
    tuesday: dayHoursSchema,
    wednesday: dayHoursSchema,
    thursday: dayHoursSchema,
    friday: dayHoursSchema,
    saturday: dayHoursSchema,
    sunday: dayHoursSchema,
  })
  .strict();

export type BusinessHours = z.infer<typeof businessHoursSchema>;
export type DayKey = keyof BusinessHours;
export type DayHours = BusinessHours[DayKey];

/** Derived from the schema itself so the two can never drift apart. */
export const DAY_KEYS = Object.keys(businessHoursSchema.shape) as DayKey[];

const serviceSchema = z
  .object({
    service_id: z.string().regex(SLUG, 'service_id must be a lower-case slug'),
    name: z.string().min(1),
    category: z.string().min(1),
    duration_minutes: z.number().int().positive().optional(),
    keywords: z.array(z.string().min(1)).min(1, 'a service needs at least one keyword'),
    short_description: z.string().min(1),
  })
  .strict();

export type TenantService = z.infer<typeof serviceSchema>;

function isResolvableTimezone(timezone: string): boolean {
  try {
    // The same lookup dayjs.tz performs; an unknown zone throws RangeError.
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The clinic-authored parts of the agent system prompt. The template in
 * agent/system-prompt.template.txt holds the reusable call machinery; these are
 * the sections a clinic writes for itself, plus the names it is known by.
 *
 * Multi-line sections are arrays of lines so they stay readable in the tenant
 * file rather than collapsing into one escaped string.
 */
const promptSchema = z
  .object({
    spoken_name: z.string().min(1),
    locality_long: z.string().min(1),
    timezone_label: z.string().min(1),
    provider_short: z.string().min(1),
    practice_summary: z.string().min(1),
    new_patient_policy: z.string().min(1),
    identity_lines: z.array(z.string()).min(1),
    service_catalogue: z.array(z.string()).min(1),
    patient_priority: z.array(z.string()).min(1),
    insurance_positioning: z.array(z.string()).min(1),
    specialty_intake: z.array(z.string()).min(1),
    caller_segments: z.array(z.string()).min(1),
    objection_handling: z.array(z.string()).min(1),
    brand_messaging: z.array(z.string()).min(1),
  })
  .strict();

export type TenantPrompt = z.infer<typeof promptSchema>;

export const tenantSchema = z
  .object({
    slug: z.string().regex(SLUG, 'slug must be a lower-case slug'),
    display_name: z.string().min(1),
    short_name: z.string().min(1),
    locality: z.string().min(1),
    contact: z
      .object({
        phone: z.string().min(1),
        address: z.string().min(1),
        website: z.string().url(),
      })
      .strict(),
    timezone: z.string().refine(isResolvableTimezone, 'timezone is not a resolvable IANA zone'),
    default_appointment_duration_minutes: z.number().int().positive(),
    business_hours: businessHoursSchema,
    email: z
      .object({
        from: z.string().email(),
        reply_to: z.string().email(),
        footer_locality: z.string().min(1),
      })
      .strict(),
    api: z
      .object({
        production_host: z.string().min(1),
        staging_host: z.string().min(1),
      })
      .strict(),
    prompt: promptSchema,
    services: z.array(serviceSchema).min(1, 'a clinic needs at least one service'),
  })
  .strict()
  .superRefine((tenantConfig, ctx) => {
    const ids = tenantConfig.services.map((service) => service.service_id);
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['services'],
        message: `service_id must be unique, duplicated: ${duplicates.join(', ')}`,
      });
    }
    if (DAY_KEYS.every((day) => tenantConfig.business_hours[day].closed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['business_hours'],
        message: 'a clinic that is closed every day of the week can never be booked',
      });
    }
  });

export type Tenant = z.infer<typeof tenantSchema>;

/** Where a tenant configuration came from, for error messages and boot logs. */
export interface TenantSource {
  origin: string;
  text: string;
}

export const TENANT_ENV_KEYS = ['TENANT_CONFIG_JSON', 'TENANT_CONFIG_PATH', 'TENANT_SLUG'] as const;

export function resolveTenantSource(env: NodeJS.ProcessEnv = process.env): TenantSource {
  const inline = env.TENANT_CONFIG_JSON?.trim();
  if (inline) return { origin: 'TENANT_CONFIG_JSON', text: inline };

  const path = env.TENANT_CONFIG_PATH?.trim();
  if (path) {
    const absolute = isAbsolute(path) ? path : resolve(REPO_ROOT, path);
    return { origin: `TENANT_CONFIG_PATH (${absolute})`, text: readFileSync(absolute, 'utf8') };
  }

  const slug = env.TENANT_SLUG?.trim();
  if (slug) {
    if (!SLUG.test(slug)) {
      throw new Error(`TENANT_SLUG must be a lower-case slug, got "${slug}".`);
    }
    const absolute = resolve(TENANTS_DIR, `${slug}.json`);
    return { origin: `TENANT_SLUG (${absolute})`, text: readFileSync(absolute, 'utf8') };
  }

  throw new Error(
    'No tenant configuration. Set TENANT_CONFIG_JSON (deployed), TENANT_CONFIG_PATH, '
    + 'or TENANT_SLUG (reads tenants/<slug>.json). There is no default on purpose: '
    + 'a clinic must never answer the phone as some other clinic.',
  );
}

export function parseTenant(text: string, origin = 'tenant configuration'): Tenant {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${origin} is not valid JSON: ${(error as Error).message}`);
  }

  const parsed = tenantSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`${origin} is not a valid tenant configuration — ${detail}`);
  }
  return parsed.data;
}

export function loadTenant(env: NodeJS.ProcessEnv = process.env): Tenant {
  const source = resolveTenantSource(env);
  return parseTenant(source.text, source.origin);
}

/**
 * Resolved once at boot. A malformed or absent tenant configuration therefore
 * fails the process at import time rather than mid-call.
 */
export const tenant: Tenant = loadTenant();

/** The clinic's open days, in week order, for prompts and spoken summaries. */
export function openDays(tenantConfig: Tenant = tenant): Array<{ day: DayKey; hours: DayHours }> {
  return DAY_KEYS
    .filter((day) => !tenantConfig.business_hours[day].closed)
    .map((day) => ({ day, hours: tenantConfig.business_hours[day] }));
}
