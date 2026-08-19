/**
 * Builds the files a new clinic needs, as plain objects.
 *
 * Separated from the CLI so the test suite can validate a scaffolded clinic
 * against the real Zod schema and the real task-definition renderer without
 * writing anything to disk. If the scaffolder ever emits something that would
 * not boot or would not render, the suite says so rather than the operator
 * discovering it an hour into an onboarding.
 */

export const DAY_ORDER = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
];

const CLOSED = { open: '00:00', close: '00:00', closed: true };
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SENTINEL = 'REPLACE_WITH_';

export const REQUIRED_OPTIONS = ['slug', 'displayName', 'shortName', 'locality', 'phone', 'address', 'website'];

/** Parses "tuesday=09:00-17:00" into a business-hours entry. */
export function parseOpenDay(spec) {
  const match = /^([a-z]+)=(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(spec.trim());
  if (!match) throw new Error(`--open must look like tuesday=09:00-17:00, got "${spec}".`);
  const [, day, open, close] = match;
  if (!DAY_ORDER.includes(day)) throw new Error(`Not a day of the week: "${day}".`);
  if (!HH_MM.test(open) || !HH_MM.test(close)) throw new Error(`Times must be HH:MM in 24-hour form: "${spec}".`);
  return { day, hours: { open, close, closed: false } };
}

/** Monday to Friday, nine to five, unless the operator says otherwise. */
export function buildBusinessHours(openSpecs = []) {
  const hours = Object.fromEntries(DAY_ORDER.map((day) => [day, { ...CLOSED }]));
  const specs = openSpecs.length > 0
    ? openSpecs
    : ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((day) => `${day}=09:00-17:00`);
  for (const spec of specs) {
    const { day, hours: dayHours } = parseOpenDay(spec);
    hours[day] = dayHours;
  }
  return hours;
}

function keywordsFor(name) {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
  return words.length > 0 ? [...new Set(words)] : [name.toLowerCase()];
}

export function buildTenant(options) {
  const missing = REQUIRED_OPTIONS.filter((key) => !options[key]);
  if (missing.length > 0) throw new Error(`Missing required options: ${missing.join(', ')}.`);

  const serviceName = options.firstService ?? 'Consultation';
  const duration = options.defaultDuration ?? 60;

  return {
    slug: options.slug,
    display_name: options.displayName,
    short_name: options.shortName,
    locality: options.locality,
    contact: {
      phone: options.phone,
      address: options.address,
      website: options.website,
    },
    timezone: options.timezone ?? 'America/New_York',
    default_appointment_duration_minutes: duration,
    business_hours: buildBusinessHours(options.open ?? []),
    email: {
      from: options.emailFrom ?? 'onboarding@resend.dev',
      reply_to: options.emailReplyTo ?? options.emailFrom ?? 'onboarding@resend.dev',
      footer_locality: options.locality,
    },
    api: {
      production_host: options.productionHost ?? `${SENTINEL}PRODUCTION_HOST`,
      staging_host: options.stagingHost ?? `${SENTINEL}STAGING_HOST`,
    },
    // Starter copy: speakable as written, and plainly the clinic's to replace.
    // Nothing here claims anything about the clinic that it has not stated.
    prompt: {
      spoken_name: options.spokenName ?? options.shortName,
      locality_long: options.localityLong ?? options.locality,
      timezone_label: options.timezoneLabel ?? 'local time',
      provider_short: options.providerShort ?? 'our provider',
      practice_summary: `{{clinic_name}} is a clinic in ${options.localityLong ?? options.locality}.`,
      new_patient_policy: 'Since this is your first visit, please arrive a few minutes early so we can complete your paperwork.',
      identity_lines: [
        `Address: ${options.address}`,
        `Phone: ${options.phone}`,
        `Website: ${options.website}`,
      ],
      service_catalogue: [`- ${serviceName} (${duration} min)`],
      patient_priority: ['HIGH PRIORITY (schedule immediately):', '1. Acute pain patients', '', 'SECONDARY:', '2. Everyone else'],
      insurance_positioning: [
        'NEVER guarantee insurance coverage. NEVER simply say "no" if asked whether you accept a specific insurance.',
        'NEVER end the insurance conversation with the patient still uncertain — always give them a next step.',
        '',
        'If a caller asks whether you accept their insurance:',
        '→ "Let me have someone from our team call you back to go through your benefits with you."',
        '→ Then offer a callback: collect their name and number and call create_callback.',
      ],
      specialty_intake: ['This clinic has declared no specialty intake questions.'],
      caller_segments: ['This clinic has declared no caller segments.'],
      objection_handling: ['"I\'m nervous." → "That\'s completely understandable. Our providers are very experienced."'],
      brand_messaging: [`- "We look forward to seeing you at ${options.shortName}."`],
    },
    services: [
      {
        service_id: options.firstServiceId ?? 'consultation',
        name: serviceName,
        category: options.firstServiceCategory ?? 'general',
        duration_minutes: duration,
        keywords: keywordsFor(serviceName),
        short_description: `${serviceName} appointment.`,
      },
    ],
  };
}

/**
 * An environment file for one clinic. Google resource IDs are left as operator
 * placeholders on purpose: the renderer refuses to build a task definition while
 * a placeholder remains, so a clinic cannot be deployed pointing at nothing — or,
 * worse, at whatever was copied from another clinic's file.
 */
export function buildEnvironment(options, environment) {
  const tenant = options.tenant ?? buildTenant(options);
  const isProduction = environment === 'production';
  const service = options.service ?? tenant.slug;

  return {
    environment,
    tenant: tenant.slug,
    description: isProduction
      ? `Live clinic environment for ${tenant.display_name}. Real callers, real calendar, real patient records.`
      : `Isolated rehearsal environment for ${tenant.display_name}. Must never reference the live calendar, the live appointment spreadsheet, or the live Retell agent.`,
    readonlyRootFilesystem: !isProduction,
    values: {
      SERVICE: service,
      ENVIRONMENT: environment,
      NODE_ENV: 'production',
      AWS_ACCOUNT_ID: options.awsAccountId ?? `${SENTINEL}AWS_ACCOUNT_ID`,
      AWS_REGION: options.awsRegion ?? 'us-east-1',
      TASK_CPU: '512',
      TASK_MEMORY: '1024',

      BUSINESS_NAME: isProduction ? tenant.display_name : `${tenant.short_name} (STAGING - do not treat as real)`,
      BUSINESS_PHONE: tenant.contact.phone,
      BUSINESS_ADDRESS: tenant.contact.address,
      BUSINESS_WEBSITE: tenant.contact.website,
      TIMEZONE: tenant.timezone,
      DEFAULT_APPOINTMENT_DURATION: String(tenant.default_appointment_duration_minutes),

      GOOGLE_CALENDAR_ID: `${SENTINEL}${environment.toUpperCase()}_CALENDAR_ID`,
      GOOGLE_SPREADSHEET_ID: `${SENTINEL}${environment.toUpperCase()}_SPREADSHEET_ID`,
      GOOGLE_IMPERSONATE_EMAIL: '',

      EMAIL_FROM: tenant.email.from,
      EMAIL_REPLY_TO: tenant.email.reply_to,

      TOOL_AUTH_HEADER: 'x-tool-auth',
      TOOL_AUTH_VERSION: 'v1',
      APPOINTMENT_TOKEN_TTL_MS: '600000',
      RETELL_CALLER_PHONE_HEADER: 'x-retell-caller-phone',
      RETELL_CALL_ID_HEADER: 'x-retell-call-id',
      RETELL_WEBHOOK_TOLERANCE_MS: '300000',

      ALLOWED_ORIGINS: '',
      REQUEST_BODY_LIMIT: '32kb',
      RATE_LIMIT_WINDOW_MS: '60000',
      RATE_LIMIT_MAX: isProduction ? '60' : '30',
      IDEMPOTENCY_TTL_MS: '900000',
      TRUST_PROXY_HOPS: '1',
    },
  };
}

/** What the operator still has to do by hand, in order. */
export function remainingSteps(tenant) {
  return [
    `Edit tenants/${tenant.slug}.json: the real services, hours, and the prompt sections this clinic wants.`,
    `Create this clinic's own Google calendar and spreadsheet, share both with the service account, and put their IDs in infra/environments/${tenant.slug}.production.json.`,
    `Create a separate staging calendar and spreadsheet and put their IDs in infra/environments/${tenant.slug}.staging.json. The renderer refuses to point staging at production's.`,
    `Fill in api.production_host and api.staging_host in tenants/${tenant.slug}.json.`,
    'Deploy infra/cloudformation/shared-alb.yml once per environment, if it is not already deployed.',
    `Deploy infra/cloudformation/tenant-service.yml for this clinic with TenantSlug=${tenant.slug} and a free ListenerRulePriority.`,
    `Store this clinic's operator-supplied secrets: GOOGLE_CREDENTIALS_BASE64, RESEND_API_KEY, RETELL_WEBHOOK_SECRET.`,
    `node infra/render.mjs --tenant ${tenant.slug} --env staging --image-tag <sha>`,
    `node scripts/render-retell-agent.mjs --tenant ${tenant.slug} --env staging`,
    'Duplicate a Retell agent, paste in the generated tools and prompt, and place a test call.',
  ];
}
