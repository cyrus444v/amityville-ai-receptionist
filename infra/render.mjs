/**
 * Renders an environment-specific ECS task definition from
 * infra/task-definition.template.json plus infra/environments/<env>.json.
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

const HERE = dirname(fileURLToPath(import.meta.url));

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

export function assertEnvironmentConfig(envConfig) {
  const values = envConfig?.values;
  if (!values) throw new Error('Environment config is missing a "values" object.');

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

export function assertRenderedTaskDefinition(definition, envConfig) {
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

  return definition;
}

export function renderTaskDefinition({ templateText, envConfig, imageTag }) {
  assertValidImageTag(imageTag);
  assertEnvironmentConfig(envConfig);
  const values = { ...envConfig.values, IMAGE_TAG: imageTag };
  const definition = JSON.parse(substitute(templateText, values));
  if (typeof envConfig.readonlyRootFilesystem === 'boolean') {
    definition.containerDefinitions[0].readonlyRootFilesystem = envConfig.readonlyRootFilesystem;
  }
  return assertRenderedTaskDefinition(definition, envConfig);
}

export function loadEnvironment(environment) {
  if (!/^[a-z]+$/.test(environment)) throw new Error(`Invalid environment name: ${environment}`);
  return JSON.parse(readFileSync(join(HERE, 'environments', `${environment}.json`), 'utf8'));
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
  if (!environment) {
    console.error('usage: node infra/render.mjs --env <staging|production> --image-tag <tag> [--out <path>]');
    process.exit(2);
  }
  try {
    const definition = renderTaskDefinition({
      templateText: loadTemplateText(),
      envConfig: loadEnvironment(environment),
      imageTag: args['image-tag'],
    });
    const output = args.out ?? join(HERE, 'generated', `task-definition.${environment}.json`);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(definition, null, 2)}\n`, 'utf8');
    console.log(output);
  } catch (error) {
    console.error(`render failed: ${error.message}`);
    process.exit(1);
  }
}
