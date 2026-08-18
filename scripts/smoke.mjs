#!/usr/bin/env node
/**
 * Post-deploy smoke test.
 *
 * Deliberately credential-free and read-only. It proves three things without CI
 * ever holding the tool secret and without creating, moving or cancelling any
 * appointment:
 *
 *   1. the service is up and answering an unauthenticated health check;
 *   2. the tool boundary is live — a protected tool rejects an anonymous call;
 *   3. the Retell webhook rejects an unsigned body.
 *
 * A deploy that leaves the auth boundary open therefore fails the smoke test
 * instead of quietly serving patient data.
 */

const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error('usage: node scripts/smoke.mjs https://host');
  process.exit(2);
}

const base = baseUrl.replace(/\/+$/, '');
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 10_000);

async function probe(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
    return { status: response.status, body: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

const checks = [
  {
    name: 'health is public and healthy',
    run: async () => {
      const { status } = await probe('/health');
      return status === 200 ? null : `expected 200, got ${status}`;
    },
  },
  {
    name: 'protected tool rejects an anonymous call',
    run: async () => {
      const { status } = await probe('/current-date');
      return status === 401 ? null : `expected 401 without credentials, got ${status}`;
    },
  },
  {
    name: 'appointment lookup rejects an anonymous call',
    run: async () => {
      const { status } = await probe('/find-appointment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '+10000000000' }),
      });
      return status === 401 ? null : `expected 401 without credentials, got ${status}`;
    },
  },
  {
    name: 'retell webhook rejects an unsigned body',
    run: async () => {
      const { status } = await probe('/retell/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'call_ended' }),
      });
      return status === 401 ? null : `expected 401 for an unsigned webhook, got ${status}`;
    },
  },
];

let failed = 0;
for (const check of checks) {
  try {
    const failure = await check.run();
    if (failure) {
      failed += 1;
      console.error(`FAIL  ${check.name}: ${failure}`);
    } else {
      console.log(`ok    ${check.name}`);
    }
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${check.name}: ${error.message}`);
  }
}

console.log(`${checks.length - failed}/${checks.length} smoke checks passed against ${base}`);
process.exit(failed === 0 ? 0 : 1);
