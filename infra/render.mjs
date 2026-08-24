/**
 * Renders a tenant-and-environment-specific ECS task definition from
 * infra/task-definition.template.json plus
 * infra/environments/<tenant>.<environment>.json plus tenants/<tenant>.json.
 *
 * The clinic's own configuration is injected as one TENANT_CONFIG_JSON variable
 * rather than templated in, which is what keeps a single image serving every
 * clinic: no per-tenant build, no per-tenant tag, and a rollback is the same
 * artifact everywhere.
 *
 * The renderer is deliberately strict: it refuses to emit a task definition
 * that carries an unresolved placeholder, a mutable image tag, a leftover
 * staging sentinel, a duplicated environment variable, or a secret reference
 * belonging to a different environment. A bad task definition is far more
 * expensive to discover after a deploy than at render time.
 *
 * Pure functions are exported so the offline test suite can exercise every
 * failure mode without touching AWS.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTenantFile } from '../lib/tenant-file.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const REQUIRED_VALUE_KEYS = [
  'SERVICE', 'ENVIRONMENT', 'NODE_ENV', 'AWS_ACCOUNT_ID', 'AWS_REGION',
  'TASK_CPU', 'TASK_MEMORY', 'BUSINESS_NAME', 'TIMEZONE',
  'DEFAULT_APPOINTMENT_DURATION', 'GOOGLE_CALENDAR_ID', 'GOOGLE_SPREADSHEET_ID',
  'TOOL_AUTH_HEADER', 'TOOL_AUTH_VERSION', 'APPOINTMENT_TOKEN_TTL_MS',
  'RETELL_CALLER_PHONE_HEADER', 'RETELL_CALL_ID_HEADER',
  'RETELL_WEBHOOK_TOLERANCE_MS', 'REQUEST_BODY_LIMIT', 'RATE_LIMIT_WINDOW_MS',
  'RATE_LIMIT_MAX', 'IDEMPOTENCY_TTL_MS', 'TRUST_PROXY_HOPS',
];

export const REQUIRED_SECRET_NAMES = [
  'TOOL_AUTH_SECRET',
  'APPOINTMENT_TOKEN_SECRET',
  'RETELL_WEBHOOK_SECRET',
  'GOOGLE_CREDENTIALS_BASE64',
  'RESEND_API_KEY',
];

const MUTABLE_TAGS = new Set(['latest', 'main', 'master', 'production', 'staging']);
const IMAGE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertValidImageTag(imageTag) {
  if (!imageTag) throw new Error('An explicit --image-tag is required; refusing to render an untagged image.');
  if (!IMAGE_TAG_PATTERN.test(imageTag)) throw new Error(`Image tag is not a valid ECR tag: ${imageTag}`);
  if (MUTABLE_TAGS.has(imageTag.toLowerCase())) {
    throw new Error(`Refusing mutable image tag "${imageTag}". Deploy an immutable tag such as the commit SHA.`);
  }
  return imageTag;
}

export function substitute(text, values) {
  const rendered = text.replace(/\$\{([A-Z0-9_]+)\}/g, (whole, key) => {
    if (!(key in values)) return whole;
    return String(values[key]);
  });
  const unresolved = [...rendered.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((match) => match[1]);
  if (unresolved.length > 0) {
    throw new Error(`Unresolved template placeholders: ${[...new Set(unresolved)].join(', ')}`);
  }
  return rendered;
}

export function assertEnvironmentConfig(envConfig, tenant = null) {
  const values = envConfig?.values;
  if (!values) throw new Error('Environment config is missing a "values" object.');

  if (!envConfig.tenant || !SLUG.test(envConfig.tenant)) {
    throw new Error('Environment config must name its clinic in a "tenant" field, as a lower-case slug.');
  }
  if ('TENANT_CONFIG_JSON' in values) {
    throw new Error('TENANT_CONFIG_JSON is injected from tenants/<slug>.json; remove it from the environment config.');
  }
  if (tenant) {
    if (tenant.slug !== envConfig.tenant) {
      throw new Error(`Environment config declares tenant "${envConfig.tenant}" but was given tenants/${tenant.slug}.json.`);
    }
    // The most likely onboarding mistake is a second clinic's environment file
    // copied from the first and left branded with the first clinic's name. In
    // production the name must match exactly; elsewhere it must at least still
    // be recognisably this clinic, so "<clinic> (STAGING)" stays legal.
    if (envConfig.environment === 'production') {
      if (values.BUSINESS_NAME !== tenant.display_name) {
        throw new Error(
          `production BUSINESS_NAME is "${values.BUSINESS_NAME}" but tenants/${tenant.slug}.json says `
          + `"${tenant.display_name}". A clinic must not go live under another clinic's name.`,
        );
      }
    } else if (!values.BUSINESS_NAME.includes(tenant.short_name)) {
      throw new Error(
        `${envConfig.environment} BUSINESS_NAME is "${values.BUSINESS_NAME}", which does not mention `
        + `"${tenant.short_name}". Point this environment at its own clinic.`,
      );
    }
  }

  const missing = REQUIRED_VALUE_KEYS.filter((key) => !(key in values));
  if (missing.length > 0) throw new Error(`Environment config is missing required values: ${missing.join(', ')}`);

  if (values.ENVIRONMENT !== envConfig.environment) {
    throw new Error(`Environment mismatch: file declares "${envConfig.environment}" but ENVIRONMENT is "${values.ENVIRONMENT}".`);
  }

  const sentinels = Object.entries(values)
    .filter(([, value]) => typeof value === 'string' && value.startsWith('REPLACE_WITH_'))
    .map(([key]) => key);
  if (sentinels.length > 0) {
    throw new Error(`Environment config still holds operator placeholders: ${sentinels.join(', ')}. Fill these in before deploying.`);
  }

  for (const [key, forbidden] of Object.entries(envConfig.forbiddenValues ?? {})) {
    if (forbidden.includes(values[key])) {
      throw new Error(
        `${envConfig.environment} may not use the production value for ${key}. `
        + 'Point this environment at its own isolated Google resource.',
      );
    }
  }

  // The app itself fails closed in production, but a mis-set NODE_ENV would
  // silently enable the in-memory coordination fallback and the tool-auth
  // dev bypass. Both environments therefore run with NODE_ENV=production.
  if (values.NODE_ENV !== 'production') {
    throw new Error('NODE_ENV must be "production" so fail-closed guards and the shared coordination store stay active.');
  }

  return envConfig;
}

export function assertRenderedTaskDefinition(definition, envConfig, tenant = null) {
  const containers = definition.containerDefinitions ?? [];
  if (containers.length !== 1) throw new Error('Expected exactly one container definition.');
  const container = containers[0];

  const names = container.environment.map((entry) => entry.name);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate environment variables would silently shadow each other: ${[...new Set(duplicates)].join(', ')}`);
  }

  const blank = container.environment
    .filter((entry) => entry.value === undefined || entry.value === null)
    .map((entry) => entry.name);
  if (blank.length > 0) throw new Error(`Environment variables rendered as null: ${blank.join(', ')}`);

  const secretNames = container.secrets.map((entry) => entry.name).sort();
  const expected = [...REQUIRED_SECRET_NAMES].sort();
  if (secretNames.join(',') !== expected.join(',')) {
    throw new Error(`Secret set mismatch. Expected ${expected.join(', ')} but got ${secretNames.join(', ')}.`);
  }

  const env = envConfig.values.ENVIRONMENT;
  const service = envConfig.values.SERVICE;
  for (const secret of container.secrets) {
    if (!secret.valueFrom.includes(`:secret:${service}/${env}/`)) {
      throw new Error(`Secret ${secret.name} does not resolve inside the ${env} secret namespace: ${secret.valueFrom}`);
    }
  }

  const table = container.environment.find((entry) => entry.name === 'COORDINATION_TABLE')?.value;
  if (table !== `${service}-${env}-coordination`) {
    throw new Error(`COORDINATION_TABLE must be ${service}-${env}-coordination but is ${table}.`);
  }

  if (container.image.endsWith(':latest')) throw new Error('Rendered image still points at :latest.');

  const injected = container.environment.find((entry) => entry.name === 'TENANT_CONFIG_JSON')?.value;
  if (!injected) throw new Error('TENANT_CONFIG_JSON is missing; the task would boot with no clinic configuration.');
  let parsedTenant;
  try {
    parsedTenant = JSON.parse(injected);
  } catch (error) {
    throw new Error(`TENANT_CONFIG_JSON is not valid JSON: ${error.message}`);
  }
  if (parsedTenant.slug !== envConfig.tenant) {
    throw new Error(`TENANT_CONFIG_JSON carries clinic "${parsedTenant.slug}" but this is the ${envConfig.tenant} task definition.`);
  }
  if (tenant && parsedTenant.slug !== tenant.slug) {
    throw new Error(`TENANT_CONFIG_JSON carries clinic "${parsedTenant.slug}" but tenants/${tenant.slug}.json was requested.`);
  }

  return definition;
}

/**
 * Secrets Manager appends a six-character suffix to a secret's ARN when the
 * secret is created, so a correct ARN cannot be derived from the secret's name
 * alone. ECS requires the full ARN in secrets[].valueFrom; a suffix-less
 * reference is authorised against a different resource string than the one the
 * execution role grants, and the task then dies at startup with
 * ResourceInitializationError instead of failing here at render time.
 *
 * The suffixes are account-specific facts, so they belong in the environment
 * config alongside the other values that have to come from the real account.
 * An environment that has not recorded them yet renders exactly as before,
 * which keeps this change from reaching clinics that are not being deployed.
 */
export const SECRET_ARN_SUFFIX = /^[A-Za-z0-9]{6}$/;

export function applySecretArnSuffixes(definition, envConfig) {
  const suffixes = envConfig.secretArnSuffixes;
  if (!suffixes) return definition;

  const container = definition.containerDefinitions[0];
  const carried = container.secrets.map((entry) => entry.name);

  const unknown = Object.keys(suffixes).filter((name) => !carried.includes(name));
  if (unknown.length > 0) {
    throw new Error(`secretArnSuffixes names secrets this task definition does not carry: ${unknown.join(', ')}`);
  }
  const omitted = carried.filter((name) => !(name in suffixes));
  if (omitted.length > 0) {
    throw new Error(
      `secretArnSuffixes is declared but omits ${omitted.join(', ')}. List every secret or remove the block: `
      + 'a partly-suffixed set is exactly the failure this guard exists to prevent.',
    );
  }

  for (const secret of container.secrets) {
    const suffix = suffixes[secret.name];
    if (!SECRET_ARN_SUFFIX.test(suffix)) {
      throw new Error(
        `secretArnSuffixes.${secret.name} must be the six-character suffix Secrets Manager assigned, not "${suffix}".`,
      );
    }
    if (!secret.valueFrom.endsWith(`-${suffix}`)) {
      secret.valueFrom = `${secret.valueFrom}-${suffix}`;
    }
  }
  return definition;
}

export function renderTaskDefinition({ templateText, envConfig, imageTag, tenant }) {
  assertValidImageTag(imageTag);
  assertEnvironmentConfig(envConfig, tenant);
  const values = { ...envConfig.values, IMAGE_TAG: imageTag };
  const definition = JSON.parse(substitute(templateText, values));
  const container = definition.containerDefinitions[0];

  // Injected after substitution rather than templated in: the clinic's
  // configuration is itself JSON, and pasting it through a text substitution
  // into a JSON template is an escaping accident waiting to happen.
  if (tenant) {
    container.environment.push({ name: 'TENANT_CONFIG_JSON', value: JSON.stringify(tenant) });
  }

  if (typeof envConfig.readonlyRootFilesystem === 'boolean') {
    container.readonlyRootFilesystem = envConfig.readonlyRootFilesystem;
  }
  applySecretArnSuffixes(definition, envConfig);
  return assertRenderedTaskDefinition(definition, envConfig, tenant);
}

export function environmentFileName(tenantSlug, environment) {
  if (!SLUG.test(tenantSlug)) throw new Error(`Invalid tenant slug: ${tenantSlug}`);
  if (!/^[a-z]+$/.test(environment)) throw new Error(`Invalid environment name: ${environment}`);
  return `${tenantSlug}.${environment}.json`;
}

/** Google resources a non-production environment must never be pointed at. */
export const ISOLATED_GOOGLE_KEYS = ['GOOGLE_CALENDAR_ID', 'GOOGLE_SPREADSHEET_ID'];

export function mergeForbiddenValues(declared, productionValues, keys = ISOLATED_GOOGLE_KEYS) {
  const merged = { ...(declared ?? {}) };
  for (const key of keys) {
    const value = productionValues?.[key];
    if (typeof value !== 'string' || value === '') continue;
    merged[key] = [...new Set([...(merged[key] ?? []), value])];
  }
  return merged;
}

export function loadEnvironment(environment, tenantSlug) {
  const file = environmentFileName(tenantSlug, environment);
  const envConfig = JSON.parse(readFileSync(join(HERE, 'environments', file), 'utf8'));
  if (environment === 'production') return envConfig;

  // A newly onboarded clinic must not have to remember to copy its own
  // production calendar and spreadsheet into its staging file's forbiddenValues.
  // They are derived from that clinic's production file instead, so the
  // isolation guard is on by default rather than by diligence.
  try {
    const productionFile = environmentFileName(tenantSlug, 'production');
    const production = JSON.parse(readFileSync(join(HERE, 'environments', productionFile), 'utf8'));
    envConfig.forbiddenValues = mergeForbiddenValues(envConfig.forbiddenValues, production.values);
  } catch (error) {
    // A clinic may legitimately have no production environment yet.
    if (error.code !== 'ENOENT') throw error;
  }
  return envConfig;
}

export function loadTemplateText() {
  return readFileSync(join(HERE, 'task-definition.template.json'), 'utf8');
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) args[token.slice(2)] = argv[index + 1];
  }
  return args;
}

if (process.argv[1] && process.argv[1].endsWith('render.mjs')) {
  const args = parseArgs(process.argv.slice(2));
  const environment = args.env;
  const tenantSlug = args.tenant;
  if (!environment || !tenantSlug) {
    console.error('usage: node infra/render.mjs --tenant <slug> --env <staging|production> --image-tag <tag> [--out <path>]');
    process.exit(2);
  }
  try {
    const definition = renderTaskDefinition({
      templateText: loadTemplateText(),
      envConfig: loadEnvironment(environment, tenantSlug),
      tenant: loadTenantFile(tenantSlug),
      imageTag: args['image-tag'],
    });
    const output = args.out ?? join(HERE, 'generated', `task-definition.${tenantSlug}.${environment}.json`);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(definition, null, 2)}\n`, 'utf8');
    console.log(output);
  } catch (error) {
    console.error(`render failed: ${error.message}`);
    process.exit(1);
  }
}
