#!/usr/bin/env node
/**
 * Renders one clinic's complete voice agent surface: its tool configuration and
 * its system prompt, both pointed at a chosen host.
 *
 *   node scripts/render-agent.mjs --tenant amityville-wellness --env production
 *   node scripts/render-agent.mjs --tenant amityville-wellness --env staging
 *   node scripts/render-agent.mjs --tenant clinic-b --base-url https://abc.trycloudflare.com --inline-secret
 *
 * Writes agent/generated/<slug>/tools.json and system-prompt.txt. That directory
 * is gitignored: a rendered agent may carry a tunnel URL or a throwaway secret,
 * and neither belongs in the repository.
 *
 * This is the "render the voice agent" step of onboarding a clinic.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderSystemPrompt } from '../agent/render-prompt.mjs';
import { loadTools, rewriteToolUrls } from './lib/agent-tools.mjs';
import { REPO_ROOT, hostForEnvironment, listTenantSlugs, loadTenantFile } from '../lib/tenant-file.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const usage = 'usage: node scripts/render-agent.mjs --tenant <slug> (--env <production|staging> | --base-url https://host) [--inline-secret]';

const slug = arg('tenant');
const environment = arg('env');
const explicitBase = arg('base-url');
const wantsInlineSecret = process.argv.includes('--inline-secret');

if (!slug || (!environment && !explicitBase)) {
  console.error(usage);
  console.error(`\nknown tenants: ${listTenantSlugs().join(', ') || '(none)'}`);
  process.exit(2);
}

try {
  const tenant = loadTenantFile(slug);

  const baseUrl = explicitBase ?? `https://${hostForEnvironment(tenant, environment)}`;

  const inlineSecret = wantsInlineSecret ? process.env.TOOL_AUTH_SECRET : null;
  if (wantsInlineSecret && !inlineSecret) {
    throw new Error('--inline-secret needs TOOL_AUTH_SECRET in the environment (see the dev:local banner).');
  }

  const tools = rewriteToolUrls(loadTools(REPO_ROOT), baseUrl, { inlineSecret });

  const templateText = readFileSync(resolve(REPO_ROOT, 'agent/system-prompt.template.txt'), 'utf8');
  const prompt = renderSystemPrompt({ templateText, tenant });

  const outDir = resolve(REPO_ROOT, 'agent/generated', slug);
  mkdirSync(outDir, { recursive: true });
  const toolsPath = resolve(outDir, 'tools.json');
  const promptPath = resolve(outDir, 'system-prompt.txt');
  writeFileSync(toolsPath, `${JSON.stringify(tools, null, 2)}\n`, 'utf8');
  writeFileSync(promptPath, prompt, 'utf8');

  console.log(toolsPath);
  console.log(promptPath);
  console.log(`\n${tenant.display_name} — ${tools.length} tools pointed at ${baseUrl}`);
  console.log(`prompt: ${prompt.split('\n').length} lines, hours and services taken from tenants/${slug}.json`);
  console.log(inlineSecret
    ? 'Tool secret inlined — this file is throwaway, never commit or reuse it.'
    : 'Headers still use {{tool_auth_secret}}; set that dynamic variable on the voice agent.');
} catch (error) {
  console.error(`render failed: ${error.message}`);
  process.exit(1);
}
