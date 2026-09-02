/**
 * The agent configuration decides how the clinic sounds and how the call is
 * paced. Most of it is judgement, but a handful of settings are load-bearing —
 * get one wrong and every call is broken in a way no unit test elsewhere sees.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LLM,
  PHONE_AUDIO_FORMAT,
  REQUIRED_DYNAMIC_VARIABLES,
  asrKeywords,
  buildAgentPayload,
  buildConversationConfig,
  builtInTools,
  greetingFor,
  withCallContext,
} from '../../lib/elevenlabs/agent-config.mjs';
import { loadTenantFile } from '../../lib/tenant-file.mjs';
import { initiationVariables } from '../../src/services/call-context';

const base = loadTenantFile('amityville-wellness');
const tenant = { ...base, voice: { elevenlabs_voice_id: 'voice_fixture' } };
const PROMPT = 'REVIEWED PROMPT BODY';

// Boundary types: the builders are plain ESM and tsc infers literal shapes
// from them, which makes "this field is absent" assertions a type error
// rather than the test they are meant to be.
const config: Record<string, any> = buildConversationConfig(tenant, PROMPT, { toolIds: ['tool_a'] });

describe('conversation configuration', () => {
  it('speaks and listens in the telephony codec, so nothing resamples on the hot path', () => {
    expect(PHONE_AUDIO_FORMAT).toBe('ulaw_8000');
    expect(config.asr.user_input_audio_format).toBe('ulaw_8000');
    expect(config.tts.agent_output_audio_format).toBe('ulaw_8000');
  });

  it('runs the reviewed prompt verbatim and suppresses the vendor persona', () => {
    expect(config.agent.prompt.prompt).toBe(PROMPT);
    // 278 reviewed lines lose to a stock "helpful assistant" persona if this
    // flag is not set.
    expect(config.agent.prompt.ignore_default_personality).toBe(true);
  });

  it('starts on the Haiku class the pipeline decision named, with a backup', () => {
    expect(config.agent.prompt.llm).toBe(DEFAULT_LLM);
    expect(DEFAULT_LLM).toMatch(/haiku/);
    // Dead air on a clinic's main line is not an acceptable LLM outage mode.
    expect(config.agent.prompt.backup_llm_config.preference).toBe('default');
  });

  it('gives the model the clinic timezone rather than letting it assume one', () => {
    expect(config.agent.prompt.timezone).toBe(tenant.timezone);
  });

  it('passes the tool ids through and keeps the built-in tools', () => {
    expect(config.agent.prompt.tool_ids).toEqual(['tool_a']);
    expect(Object.keys(config.agent.prompt.built_in_tools)).toContain('end_call');
    expect(Object.keys(config.agent.prompt.built_in_tools)).toContain('skip_turn');
  });

  it('is patient, because clinic callers spell names and read numbers off cards', () => {
    expect(config.turn.turn_eagerness).toBe('patient');
    expect(config.turn.interruption_ignore_terms).toContain('mhm');
  });

  it('redacts keypad entry, which is how a member number would arrive', () => {
    expect(config.conversation.dtmf_input_settings.redact_input).toBe(true);
  });

  it('plays no fake office ambience on a medical line', () => {
    expect(config.conversation.background_sound).toBeUndefined();
  });

  it('refuses to build without a voice the clinic actually chose', () => {
    expect(() => buildConversationConfig(base, PROMPT)).toThrow(/elevenlabs_voice_id/);
  });

  it('lets a clinic override the voice knobs it cares about', () => {
    const custom: Record<string, any> = buildConversationConfig(
      { ...tenant, voice: { ...tenant.voice, speed: 0.9, tts_model_id: 'eleven_turbo_v2_5' } },
      PROMPT,
    );
    expect(custom.tts.speed).toBe(0.9);
    expect(custom.tts.model_id).toBe('eleven_turbo_v2_5');
  });
});

describe('escalation and greeting', () => {
  it('can put a human on the line, which the prompt\'s emergency rule requires', () => {
    const tools: Record<string, any> = builtInTools(tenant);
    expect(tools.transfer_to_number).toBeDefined();
    expect(tools.transfer_to_number.params.transfers[0].transfer_destination.phone_number)
      .toBe(tenant.contact.phone);
  });

  it('greets with the name the clinic says it is spoken as', () => {
    expect(greetingFor(tenant)).toContain(tenant.prompt.spoken_name);
    expect(greetingFor({ ...tenant, voice: { ...tenant.voice, greeting: 'Custom.' } })).toBe('Custom.');
  });

  it('feeds the recogniser the service names it will hear all day', () => {
    const keywords = asrKeywords(tenant);
    expect(keywords.length).toBeGreaterThan(0);
    expect(keywords.length).toBeLessThanOrEqual(100);
    expect(new Set(keywords).size).toBe(keywords.length);
  });
});

describe('live call context', () => {
  const withContext = withCallContext(PROMPT);

  it('appends to the reviewed prompt rather than editing it', () => {
    expect(withContext.startsWith(PROMPT)).toBe(true);
  });

  it('does not contradict the reviewed rule about guessing dates', () => {
    // The prompt says never guess the date without calling get_current_date.
    // The addendum must reconcile with that, not overrule it — two contradictory
    // instructions produce erratic tool use.
    expect(withContext).not.toMatch(/do not (need to )?call get_current_date/i);
    expect(withContext).toMatch(/not a guess/i);
  });

  /**
   * The invariant that matters most here, and the only one that spans both
   * languages: ElevenLabs fails a call outright if the initiation webhook
   * omits a variable the prompt references. The prompt is built in .mjs, the
   * webhook answers from .ts, and nothing but this test connects them.
   */
  it('supplies exactly the variables the prompt references', () => {
    const supplied = Object.keys(initiationVariables('+15550000000')).sort();
    expect(supplied).toEqual([...REQUIRED_DYNAMIC_VARIABLES].sort());
  });

  it('references every declared variable in the prompt text', () => {
    for (const name of REQUIRED_DYNAMIC_VARIABLES) {
      expect(withContext, `${name} is declared but never used`).toContain(`{{${name}}}`);
    }
  });
});

describe('agent payload', () => {
  const payload: Record<string, any> = buildAgentPayload(tenant, PROMPT, { nameSuffix: 'staging', tags: ['staging'] });

  it('is tagged with the clinic so a shared workspace stays sortable', () => {
    expect(payload.tags).toContain(tenant.slug);
    expect(payload.name).toContain('staging');
  });

  it('keeps conversation records on a finite clock', () => {
    expect(payload.platform_settings.privacy.retention_days).toBeGreaterThan(0);
  });

  it('turns on the initiation webhook that supplies the call context', () => {
    expect(payload.platform_settings.overrides.enable_conversation_initiation_client_data_from_webhook)
      .toBe(true);
  });
});
