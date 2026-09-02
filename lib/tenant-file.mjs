/**
 * Reads a tenant file. Shared by the infrastructure renderer and the generator
 * scripts, so both agree on what a tenant file is called and what it must hold.
 *
 * src/config/tenant.ts and its Zod schema remain the authority on what a valid
 * tenant configuration is, and tests/unit/tenant-config.spec.ts validates every
 * file in tenants/ against it on every run. The checks here only exist so a
 * script fails with a clear sentence instead of a TypeError.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TENANTS_DIR = resolve(REPO_ROOT, 'tenants');

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SENTINEL = 'REPLACE_WITH_';

export function listTenantSlugs() {
  return readdirSync(TENANTS_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.replace(/\.json$/, ''))
    .sort();
}

export function tenantPath(slug) {
  if (!SLUG.test(slug)) throw new Error(`Not a tenant slug: ${slug}`);
  return resolve(TENANTS_DIR, `${slug}.json`);
}

export function loadTenantFile(slug) {
  const path = tenantPath(slug);
  let tenant;
  try {
    tenant = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`No tenant file at ${path}. Known tenants: ${listTenantSlugs().join(', ') || '(none)'}.`);
    }
    throw new Error(`${path} is not valid JSON: ${error.message}`);
  }
  for (const key of ['slug', 'display_name', 'timezone', 'business_hours', 'services', 'prompt', 'api']) {
    if (!(key in tenant)) throw new Error(`${path} is missing "${key}".`);
  }
  if (tenant.slug !== slug) {
    throw new Error(`${path} declares slug "${tenant.slug}" but is filed as "${slug}".`);
  }
  return tenant;
}

/**
 * The host a rendered agent should talk to. Refuses an unfilled operator
 * placeholder: pointing a staging agent at the literal string
 * REPLACE_WITH_STAGING_HOST produces an agent that fails every call.
 */
export function hostForEnvironment(tenant, environment) {
  const key = `${environment}_host`;
  const host = tenant.api?.[key];
  if (!host) throw new Error(`${tenant.slug} declares no api.${key}.`);
  if (host.startsWith(SENTINEL)) {
    throw new Error(`${tenant.slug} still has the operator placeholder in api.${key} (${host}). Fill in the real host first.`);
  }
  return host;
}
