#!/usr/bin/env node
/**
 * Provisions one clinic's ElevenLabs agent: its secret, its eight webhook
 * tools, its knowledge base, the agent itself, and optionally its phone number.
 *
 *   node scripts/elevenlabs-provision.mjs --tenant amityville-wellness --env staging
 *   node scripts/elevenlabs-provision.mjs --tenant amityville-wellness --env staging --apply
 *   node scripts/elevenlabs-provision.mjs --tenant amityville-wellness --env production --apply \
 *       --phone-number +16316910200 --twilio-sid AC... --twilio-token ...
 *
 * Two properties this script is built around:
 *
 *  - **Dry run by default.** Without --apply nothing is created, and the exact
 *    payloads that would be sent are written to disk for review. Creating a
 *    live agent on a clinic's account is not something to do by typo.
 *  - **Idempotent.** Tools and the agent are matched by name and updated in
 *    place, so running it twice does not leave a workspace full of duplicates
 *    and does not change which agent a phone number points at.
 *
 * It writes agent/generated/<slug>/elevenlabs.<env>.json — the ids of everything
 * it touched. That directory is gitignored; the lockfile names resources on a
 * third party's system and one of them is a secret id.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ElevenLabsClient } from '../lib/elevenlabs/client.mjs';
import { toElevenLabsTools } from '../lib/elevenlabs/tool-config.mjs';
import { buildAgentPayload, withCallContext } from '../lib/elevenlabs/agent-config.mjs';
import { renderSystemPrompt } from '../agent/render-prompt.mjs';
import { loadTools, rewriteToolUrls } from './lib/agent-tools.mjs';
import { REPO_ROOT, hostForEnvironment, listTenantSlugs, loadTenantFile } from '../lib/tenant-file.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

const usage = `usage: node scripts/elevenlabs-provision.mjs --tenant <slug> (--env <production|staging> | --base-url https://host)
                 [--apply] [--phone-number +1... --twilio-sid AC... --twilio-token ...]

  --apply          actually create/update. Without it, nothing is written to ElevenLabs.
  --voice-id       use this voice instead of the tenant file's, for trying one out
  --phone-number   import this Twilio number and point it at the agent (needs sid and token)
  --skip-knowledge do not build the services knowledge base`;

const slug = arg('tenant');
const environment = arg('env');
const explicitBase = arg('base-url');
const apply = flag('apply');
const phoneNumber = arg('phone-number');

if (!slug || (!environment && !explicitBase)) {
  console.error(usage);
  console.error(`\nknown tenants: ${listTenantSlugs().join(', ') || '(none)'}`);
  process.exit(2);
}

const SECRET_NAME = (tenantSlug, env) => `tool-auth-${tenantSlug}-${env}`;

function log(step, detail = '') {
  console.log(`${apply ? '·' : '○'} ${step}${detail ? ` — ${detail}` : ''}`);
}

/** Finds an existing item by name in a list response, whatever it wraps it in. */
function findByName(response, key, name) {
  const items = response?.[key] ?? response ?? [];
  return (Array.isArray(items) ? items : []).find((item) => item.name === name) ?? null;
}

async function ensureSecret(client, name, value) {
  const existing = await client.listSecrets().catch(() => null);
  const found = findByName(existing, 'secrets', name);
  if (found) {
    log('secret', `reusing ${name} (${found.secret_id})`);
    return found.secret_id;
  }
  if (!apply) {
    log('secret', `would create ${name}`);
    return 'DRY_RUN_SECRET_ID';
  }
  const created = await client.createSecret(name, value);
  log('secret', `created ${name} (${created.secret_id})`);
  return created.secret_id;
}

async function ensureTools(client, toolConfigs) {
  const existing = await client.listTools().catch(() => null);
  const ids = [];
  for (const toolConfig of toolConfigs) {
    const found = findByName(existing, 'tools', toolConfig.name)
      ?? (existing?.tools ?? []).find((item) => item.tool_config?.name === toolConfig.name)
      ?? null;
    const id = found?.id ?? found?.tool_id ?? null;

    if (!apply) {
      log('tool', `would ${id ? 'update' : 'create'} ${toolConfig.name} -> ${toolConfig.api_schema.method} ${toolConfig.api_schema.url}`);
      ids.push(id ?? `DRY_RUN_${toolConfig.name}`);
      continue;
    }
    if (id) {
      await client.updateTool(id, toolConfig);
      log('tool', `updated ${toolConfig.name} (${id})`);
      ids.push(id);
    } else {
      const created = await client.createTool(toolConfig);
      const newId = created.id ?? created.tool_id;
      log('tool', `created ${toolConfig.name} (${newId})`);
      ids.push(newId);
    }
  }
  return ids;
}

/** The clinic's service catalogue, as a retrievable document. */
function knowledgeText(tenant) {
  const lines = (tenant.services ?? []).map((service) => {
    const parts = [
      `## ${service.name}`,
      service.category ? `Category: ${service.category}` : null,
      service.duration_minutes ? `Duration: ${service.duration_minutes} minutes` : null,
      service.short_description ?? null,
      service.keywords?.length ? `Also asked about as: ${service.keywords.join(', ')}` : null,
    ];
    return parts.filter(Boolean).join('\n');
  });
  return [`# Services offered by ${tenant.display_name}`, '', ...lines].join('\n\n');
}

async function main() {
  const loaded = loadTenantFile(slug);
  // --voice-id lets a voice be auditioned without editing the clinic's file.
  // The tenant file stays the place a chosen voice is recorded.
  const voiceOverride = arg('voice-id');
  const tenant = voiceOverride
    ? { ...loaded, voice: { ...(loaded.voice ?? {}), elevenlabs_voice_id: voiceOverride } }
    : loaded;

  // Validate the only required clinic choice before the first API request. In
  // apply mode the calls below can create a workspace secret, eight tools and a
  // knowledge-base document. Discovering the missing voice only while building
  // the final agent payload would therefore leave partial external state.
  if (!tenant.voice?.elevenlabs_voice_id) {
    throw new Error(
      `${tenant.slug} declares no voice.elevenlabs_voice_id. `
      + 'Choose a voice first or pass --voice-id; nothing was created.',
    );
  }
  const envLabel = environment ?? 'custom';
  const baseUrl = explicitBase ?? `https://${hostForEnvironment(tenant, environment)}`;

  const toolAuthSecret = (process.env.TOOL_AUTH_SECRET ?? '').trim();
  if (apply && !toolAuthSecret) {
    throw new Error('TOOL_AUTH_SECRET must be in the environment: it is stored in the ElevenLabs secret vault so the tools can authenticate.');
  }

  const client = new ElevenLabsClient({ apiKey: (process.env.ELEVENLABS_API_KEY ?? '').trim() });

  // Tier check first. A BAA — and therefore any PHI at all — is Enterprise-only,
  // and finding that out after wiring a clinic's phone number is too late.
  const subscription = await client.subscription();
  const tier = subscription?.tier ?? 'unknown';
  log('account', `tier: ${tier}`);
  const enterpriseTier = /enterprise/i.test(String(tier));
  if (!enterpriseTier) {
    console.warn(
      `\n  ⚠  This workspace is on the "${tier}" tier.\n`
      + '     ElevenLabs will only execute a BAA on Enterprise, and their HIPAA guidance requires\n'
      + '     both a BAA and Zero Retention Mode before an agent may handle PHI. This agent can be\n'
      + '     built and tested, but it must not take a real patient call on this tier.\n',
    );
  }

  // A number creates a path for unscreened public callers. On a tier that
  // cannot execute a BAA, assigning one would turn a staging resource into a
  // PHI ingress before the backend sees (and can reject) the initiation hook.
  if (phoneNumber && !enterpriseTier) {
    throw new Error(
      `Refusing to attach ${phoneNumber} on the "${tier}" tier. `
      + 'Use the dashboard preview with synthetic data; a phone number requires an Enterprise workspace with an executed BAA and ZRM.',
    );
  }

  const secretId = await ensureSecret(client, SECRET_NAME(slug, envLabel), toolAuthSecret);

  const repoTools = rewriteToolUrls(loadTools(REPO_ROOT), baseUrl);
  const toolConfigs = toElevenLabsTools(repoTools, { secretId });
  const toolIds = await ensureTools(client, toolConfigs);

  let knowledgeBase = [];
  if (!flag('skip-knowledge')) {
    const name = `${tenant.display_name} — services`;
    // Reuse before create. The knowledge-base endpoint has no upsert, so
    // creating unconditionally leaves one orphaned copy of the catalogue behind
    // on every single re-provision, and the agent ends up retrieving against
    // whichever stale copy it was last pointed at.
    const existingDocs = await client.listKnowledgeBase().catch(() => null);
    const foundDoc = findByName(existingDocs, 'documents', name);
    const foundId = foundDoc?.id ?? foundDoc?.document_id ?? null;

    if (!apply) {
      log('knowledge base', `would ${foundId ? 'reuse' : 'create'} "${name}" (${(tenant.services ?? []).length} services)`);
      knowledgeBase = foundId ? [{ type: 'text', name, id: foundId, usage_mode: 'auto' }] : [];
    } else if (foundId) {
      knowledgeBase = [{ type: 'text', name, id: foundId, usage_mode: 'auto' }];
      log('knowledge base', `reusing ${foundId}`);
    } else {
      const created = await client.createKnowledgeBaseText(name, knowledgeText(tenant));
      const documentId = created.id ?? created.document_id;
      knowledgeBase = [{ type: 'text', name, id: documentId, usage_mode: 'auto' }];
      log('knowledge base', `created ${documentId}`);
    }
  }

  const templateText = readFileSync(resolve(REPO_ROOT, 'agent/system-prompt.template.txt'), 'utf8');
  const prompt = withCallContext(renderSystemPrompt({ templateText, tenant }));

  const payload = buildAgentPayload(tenant, prompt, {
    toolIds,
    knowledgeBase,
    nameSuffix: envLabel,
    tags: [envLabel],
  });

  const outDir = resolve(REPO_ROOT, 'agent/generated', slug);
  mkdirSync(outDir, { recursive: true });
  const payloadPath = resolve(outDir, `elevenlabs-agent.${envLabel}.json`);
  writeFileSync(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  log('agent payload', payloadPath);

  const existingAgents = await client.listAgents().catch(() => null);
  const foundAgent = findByName(existingAgents, 'agents', payload.name);
  let agentId = foundAgent?.agent_id ?? null;

  if (!apply) {
    log('agent', `would ${agentId ? 'update' : 'create'} "${payload.name}"`);
  } else if (agentId) {
    await client.updateAgent(agentId, payload);
    log('agent', `updated ${agentId}`);
  } else {
    const created = await client.createAgent(payload);
    agentId = created.agent_id;
    log('agent', `created ${agentId}`);
  }

  let phoneNumberId = null;
  if (phoneNumber) {
    const sid = arg('twilio-sid');
    const token = arg('twilio-token') ?? process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new Error('--phone-number needs --twilio-sid and --twilio-token (or TWILIO_AUTH_TOKEN).');

    const existingNumbers = await client.listPhoneNumbers().catch(() => null);
    const found = (Array.isArray(existingNumbers) ? existingNumbers : [])
      .find((item) => item.phone_number === phoneNumber) ?? null;

    if (!apply) {
      log('phone number', `would ${found ? 'reassign' : 'import'} ${phoneNumber}`);
    } else if (found) {
      phoneNumberId = found.phone_number_id;
      // Everything above this point has already been created. A failure to
      // re-point an existing number is worth reporting loudly, but it must not
      // read as though the whole provision failed.
      try {
        await client.assignPhoneNumber(phoneNumberId, agentId);
        log('phone number', `reassigned ${phoneNumber} (${phoneNumberId})`);
      } catch (error) {
        console.error(`\n  ⚠  ${phoneNumber} exists (${phoneNumberId}) but could not be re-pointed at ${agentId}.`);
        console.error(`     ${error.message.split('\n')[0]}`);
        console.error('     Assign it by hand in the ElevenLabs phone-numbers dashboard.\n');
      }
    } else {
      const created = await client.createPhoneNumber({
        phone_number: phoneNumber,
        label: `${tenant.display_name} — ${envLabel}`,
        provider: 'twilio',
        sid,
        token,
        agent_id: agentId,
      });
      phoneNumberId = created.phone_number_id;
      log('phone number', `imported ${phoneNumber} (${phoneNumberId})`);
    }
  }

  const lockfile = {
    tenant: slug,
    environment: envLabel,
    base_url: baseUrl,
    provisioned_at: new Date().toISOString(),
    applied: apply,
    agent_id: agentId,
    secret_id: secretId,
    tool_ids: Object.fromEntries(toolConfigs.map((tool, index) => [tool.name, toolIds[index]])),
    knowledge_base: knowledgeBase,
    phone_number_id: phoneNumberId,
  };
  const lockPath = resolve(outDir, `elevenlabs.${envLabel}.json`);
  writeFileSync(lockPath, `${JSON.stringify(lockfile, null, 2)}\n`, 'utf8');

  console.log(`\n${apply ? 'Provisioned' : 'Dry run complete'}: ${tenant.display_name} (${envLabel})`);
  console.log(`  tools pointed at ${baseUrl}`);
  console.log(`  lockfile ${lockPath}`);
  if (!apply) console.log('\nNothing was created. Re-run with --apply to make these changes.');
  else {
    console.log('\nStill to do by hand, because they are workspace-level and not per-agent:');
    console.log('  1. Settings → Webhooks: post-call webhook -> POST ' + `${baseUrl}/voice/post-call`);
    console.log('     Copy the generated secret into ELEVENLABS_WEBHOOK_SECRET.');
    console.log('  2. Agent → Security: conversation-initiation webhook -> POST ' + `${baseUrl}/voice/call-initiation`);
    console.log('     Add request header with ELEVENLABS_INITIATION_SECRET.');
    console.log('  3. Agent → Privacy → Advanced: engage Zero Retention Mode before any real patient call.');
  }
}

main().catch((error) => {
  console.error(`\nprovision failed: ${error.message}`);
  process.exit(1);
});
