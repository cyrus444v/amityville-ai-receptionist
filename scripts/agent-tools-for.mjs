#!/usr/bin/env node
/**
 * Emits a copy of agent/tools.json with the tool URLs pointed at a different
 * base — a tunnel for local testing, or the staging host.
 *
 * The committed agent/tools.json always stays pointed at production, because
 * the pipeline's static eval enforces an allowlisted production host. This
 * writes to agent/generated/ (gitignored) instead, so a tunnel URL can never
 * be committed by accident.
 *
 *   node scripts/agent-tools-for.mjs --base-url https://abc.trycloudflare.com
 *   node scripts/agent-tools-for.mjs --base-url https://staging.example.com --label staging
 *
 * Optionally inlines the tool secret with --inline-secret for a throwaway local
 * agent. Refused for any non-local base URL, so a real credential cannot be
 * written into a file destined for a dashboard paste.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isThrowawayHost, loadTools, parseHttpsBase, rewriteToolUrls } from './lib/agent-tools.mjs';

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
  console.error('usage: node scripts/agent-tools-for.mjs --base-url https://host [--label local] [--inline-secret]');
  process.exit(2);
}

let parsed;
try {
  parsed = parseHttpsBase(baseUrl);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
if (inlineSecret && !isThrowawayHost(parsed.hostname)) {
  console.error('--inline-secret is only allowed for a throwaway tunnel host. Use an agent-level dynamic variable instead.');
  process.exit(2);
}

const secret = process.env.TOOL_AUTH_SECRET;
if (inlineSecret && !secret) {
  console.error('--inline-secret needs TOOL_AUTH_SECRET in the environment (see the dev:local banner).');
  process.exit(2);
}

const origin = `${parsed.protocol}//${parsed.host}`;
let rewritten;
try {
  rewritten = rewriteToolUrls(loadTools(repoRoot), baseUrl, { inlineSecret: inlineSecret ? secret : null });
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const outPath = arg('out', resolve(repoRoot, 'agent/generated', `tools.${label}.json`));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(rewritten, null, 2)}\n`, 'utf8');

console.log(outPath);
console.log(`\n${rewritten.length} tools pointed at ${origin}`);
console.log(inlineSecret
  ? 'Tool secret inlined — this file is throwaway, never commit or reuse it.'
  : 'Headers still use {{tool_auth_secret}}; set that dynamic variable on the voice agent.');
