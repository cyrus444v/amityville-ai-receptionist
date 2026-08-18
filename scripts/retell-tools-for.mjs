#!/usr/bin/env node
/**
 * Emits a copy of retell/tools.json with the tool URLs pointed at a different
 * base — a tunnel for local testing, or the staging host.
 *
 * The committed retell/tools.json always stays pointed at production, because
 * the pipeline's static eval enforces an allowlisted production host. This
 * writes to retell/generated/ (gitignored) instead, so a tunnel URL can never
 * be committed by accident.
 *
 *   node scripts/retell-tools-for.mjs --base-url https://abc.trycloudflare.com
 *   node scripts/retell-tools-for.mjs --base-url https://staging.example.com --label staging
 *
 * Optionally inlines the tool secret with --inline-secret for a throwaway local
 * agent. Refused for any non-local base URL, so a real credential cannot be
 * written into a file destined for a dashboard paste.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const baseUrl = arg('base-url');
const label = arg('label', 'local');
const inlineSecret = process.argv.includes('--inline-secret');

if (!baseUrl) {
  console.error('usage: node scripts/retell-tools-for.mjs --base-url https://host [--label local] [--inline-secret]');
  process.exit(2);
}

let parsed;
try {
  parsed = new URL(baseUrl);
} catch {
  console.error(`Not a valid URL: ${baseUrl}`);
  process.exit(2);
}
if (parsed.protocol !== 'https:') {
  console.error('Retell requires HTTPS tool URLs. Use a tunnel that terminates TLS.');
  process.exit(2);
}

const isThrowawayHost = /(^|\.)(trycloudflare\.com|ngrok(-free)?\.app|ngrok\.io|loca\.lt)$/.test(parsed.hostname);
if (inlineSecret && !isThrowawayHost) {
  console.error('--inline-secret is only allowed for a throwaway tunnel host. Use a Retell dynamic variable instead.');
  process.exit(2);
}

const tools = JSON.parse(readFileSync(resolve(repoRoot, 'retell/tools.json'), 'utf8'));
const secret = process.env.TOOL_AUTH_SECRET;
if (inlineSecret && !secret) {
  console.error('--inline-secret needs TOOL_AUTH_SECRET in the environment (see the dev:local banner).');
  process.exit(2);
}

const origin = `${parsed.protocol}//${parsed.host}`;
const rewritten = tools.map((tool) => {
  const path = new URL(tool.url).pathname;
  const next = { ...tool, url: `${origin}${path}` };
  if (inlineSecret) next.headers = { ...tool.headers, 'x-tool-auth': secret };
  return next;
});

const outPath = arg('out', resolve(repoRoot, 'retell/generated', `tools.${label}.json`));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(rewritten, null, 2)}\n`, 'utf8');

console.log(outPath);
console.log(`\n${rewritten.length} tools pointed at ${origin}`);
console.log(inlineSecret
  ? 'Tool secret inlined — this file is throwaway, never commit or reuse it.'
  : 'Headers still use {{tool_auth_secret}}; set that dynamic variable on the Retell agent.');
