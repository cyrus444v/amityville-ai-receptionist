#!/usr/bin/env node
/**
 * Lists the voices available on the account, so a clinic can be given a
 * voice_id that actually exists.
 *
 *   ELEVENLABS_API_KEY=... node scripts/elevenlabs-voices.mjs
 *   ELEVENLABS_API_KEY=... node scripts/elevenlabs-voices.mjs --search calm
 *
 * The chosen id goes into tenants/<slug>.json under voice.elevenlabs_voice_id.
 * There is no default: a clinic's phone voice is a branding decision, and
 * picking one on their behalf is not this script's job.
 */

import { ElevenLabsClient } from '../lib/elevenlabs/client.mjs';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1];
}

const search = (arg('search') ?? '').toLowerCase();

const client = new ElevenLabsClient({ apiKey: (process.env.ELEVENLABS_API_KEY ?? '').trim() });

const { voices = [] } = await client.listVoices();

const matching = voices.filter((voice) => {
  if (!search) return true;
  const haystack = [voice.name, voice.category, voice.description, ...Object.values(voice.labels ?? {})]
    .filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(search);
});

if (matching.length === 0) {
  console.log(search ? `No voice matches "${search}".` : 'No voices on this account.');
  process.exit(0);
}

for (const voice of matching) {
  const labels = Object.entries(voice.labels ?? {}).map(([key, value]) => `${key}=${value}`).join(' ');
  console.log(`${voice.voice_id}  ${voice.name}`);
  console.log(`    ${[voice.category, labels].filter(Boolean).join('  ')}`);
}
console.log(`\n${matching.length} voice(s). Put one id in tenants/<slug>.json as voice.elevenlabs_voice_id.`);
console.log('For telephony prefer a voice that stays intelligible at 8 kHz — test before committing to it.');
