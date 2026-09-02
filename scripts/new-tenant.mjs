#!/usr/bin/env node
/**
 * Scaffolds a new clinic: its tenant configuration and both environment files.
 * This is the "onboard a clinic in under an hour" entry point.
 *
 *   node scripts/new-tenant.mjs \
 *     --slug clinic-b \
 *     --display-name "Riverside Physiotherapy" \
 *     --short-name "Riverside Physio" \
 *     --locality "Riverside, CA" \
 *     --phone "+1 951-555-0100" \
 *     --address "12 River Road, Riverside, CA 92501" \
 *     --website "https://www.example.com" \
 *     --open monday=08:00-16:00 --open thursday=10:00-18:00
 *
 * Writes tenants/<slug>.json and infra/environments/<slug>.{staging,production}.json,
 * then prints what is left to do by hand. Refuses to overwrite an existing clinic
 * without --force: silently rewriting a live clinic's configuration is not a
 * mistake worth making convenient.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { REPO_ROOT, listTenantSlugs } from '../lib/tenant-file.mjs';
import { buildEnvironment, buildTenant, remainingSteps } from '../lib/scaffold-tenant.mjs';

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

/** Every occurrence, so --open can be repeated once per open day. */
function flags(name) {
  const values = [];
  process.argv.forEach((token, index) => {
    if (token === `--${name}`) values.push(process.argv[index + 1]);
  });
  return values.filter(Boolean);
}

const options = {
  slug: flag('slug'),
  displayName: flag('display-name'),
  shortName: flag('short-name'),
  locality: flag('locality'),
  localityLong: flag('locality-long'),
  phone: flag('phone'),
  address: flag('address'),
  website: flag('website'),
  timezone: flag('timezone'),
  timezoneLabel: flag('timezone-label'),
  spokenName: flag('spoken-name'),
  providerShort: flag('provider'),
  productionHost: flag('production-host'),
  stagingHost: flag('staging-host'),
  emailFrom: flag('email-from'),
  emailReplyTo: flag('email-reply-to'),
  firstService: flag('first-service'),
  firstServiceId: flag('first-service-id'),
  firstServiceCategory: flag('first-service-category'),
  defaultDuration: flag('default-duration') ? Number(flag('default-duration')) : undefined,
  service: flag('service'),
  awsAccountId: flag('aws-account-id'),
  awsRegion: flag('aws-region'),
  open: flags('open'),
};

const force = process.argv.includes('--force');

if (!options.slug) {
  console.error('usage: node scripts/new-tenant.mjs --slug <slug> --display-name "..." --short-name "..." --locality "..." --phone "..." --address "..." --website "https://..." [--open tuesday=09:00-17:00 ...]');
  console.error(`\nexisting clinics: ${listTenantSlugs().join(', ') || '(none)'}`);
  process.exit(2);
}

function write(path, data) {
  const absolute = resolve(REPO_ROOT, path);
  if (existsSync(absolute) && !force) {
    throw new Error(`${path} already exists. Pass --force only if you mean to overwrite this clinic's configuration.`);
  }
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return relative(REPO_ROOT, absolute);
}

try {
  const tenant = buildTenant(options);
  const written = [
    write(`tenants/${tenant.slug}.json`, tenant),
    write(`infra/environments/${tenant.slug}.production.json`, buildEnvironment({ ...options, tenant }, 'production')),
    write(`infra/environments/${tenant.slug}.staging.json`, buildEnvironment({ ...options, tenant }, 'staging')),
  ];

  console.log(`${tenant.display_name} scaffolded as "${tenant.slug}":\n`);
  for (const path of written) console.log(`  ${path}`);
  console.log('\nStill to do, in this order:\n');
  remainingSteps(tenant).forEach((step, index) => console.log(`  ${index + 1}. ${step}`));
  console.log('\nNothing above touches another clinic. Run npm run test:ci when the files are filled in.');
} catch (error) {
  console.error(`new-tenant failed: ${error.message}`);
  process.exit(1);
}
