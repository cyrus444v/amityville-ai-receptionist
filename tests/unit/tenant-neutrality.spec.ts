/**
 * The application code must not know which clinic it is serving. Every
 * clinic-specific value belongs in a tenant configuration, so onboarding a
 * clinic is a JSON file and not a code change.
 *
 * This is a string-level guard in the same spirit as security-static.spec.ts:
 * it cannot prove the abstraction is right, but it does stop tenant #1's
 * details from creeping back into shared code — which is how a second clinic
 * ends up answering the phone as the first.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../..');

/** Tenant #1's identifying details, in the forms they could plausibly reappear. */
const TENANT_ONE_MARKERS = [
  'amityville',
  'amityvillewellness',
  '631-691',
  '631.691',
  'broadway',
  'hurme',
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') || full.endsWith('.json') || full.endsWith('.sql') ? [full] : [];
  });
}

describe('application code carries no clinic identity', () => {
  const files = sourceFiles(resolve(repoRoot, 'src'));

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it.each(TENANT_ONE_MARKERS)('no file under src/ mentions %s', (marker) => {
    const offenders = files
      .filter((file) => readFileSync(file, 'utf8').toLowerCase().includes(marker))
      .map((file) => relative(repoRoot, file));
    expect(offenders, `move this into tenants/<slug>.json: ${offenders.join(', ')}`).toEqual([]);
  });

  it('ships no bundled service catalogue that would freeze one clinic into the image', () => {
    const bundled = files.filter((file) => file.endsWith('services.json'));
    expect(bundled).toEqual([]);
  });
});
