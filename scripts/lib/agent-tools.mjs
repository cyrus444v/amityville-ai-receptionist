/**
 * Shared Retell tool-config handling for scripts/agent-tools-for.mjs and
 * scripts/render-agent.mjs.
 *
 * The committed agent/tools.json always stays pointed at tenant #1's production
 * host, because the static eval enforces an allowlisted production host. Both
 * scripts write to agent/generated/ (gitignored) instead, so a tunnel URL or an
 * inlined secret can never be committed by accident.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Hosts whose URLs are inherently throwaway, so inlining a dev secret is safe. */
const THROWAWAY_HOST = /(^|\.)(trycloudflare\.com|ngrok(-free)?\.app|ngrok\.io|loca\.lt)$/;

export function isThrowawayHost(hostname) {
  return THROWAWAY_HOST.test(hostname);
}

export function parseHttpsBase(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Not a valid URL: ${baseUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Retell requires HTTPS tool URLs. Use a tunnel that terminates TLS.');
  }
  return parsed;
}

export function loadTools(repoRoot) {
  return JSON.parse(readFileSync(resolve(repoRoot, 'agent/tools.json'), 'utf8'));
}

/**
 * Repoints every tool at `baseUrl`, keeping each tool's path. Optionally inlines
 * the tool secret — refused for anything but a throwaway host, so a real
 * credential cannot be written into a file destined for a dashboard paste.
 */
export function rewriteToolUrls(tools, baseUrl, { inlineSecret = null } = {}) {
  const parsed = parseHttpsBase(baseUrl);
  if (inlineSecret && !isThrowawayHost(parsed.hostname)) {
    throw new Error('Refusing to inline a tool secret for a non-throwaway host. Use a Retell dynamic variable instead.');
  }
  const origin = `${parsed.protocol}//${parsed.host}`;
  return tools.map((tool) => {
    const { pathname } = new URL(tool.url);
    const next = { ...tool, url: `${origin}${pathname}` };
    if (inlineSecret) next.headers = { ...tool.headers, 'x-tool-auth': inlineSecret };
    return next;
  });
}
