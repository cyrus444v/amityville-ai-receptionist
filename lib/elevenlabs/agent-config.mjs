/**
 * Builds the ElevenLabs Agents `conversation_config` for one clinic.
 *
 * The reviewed system prompt is re-homed here, not rewritten: it is
 * rendered by the existing agent/render-prompt.mjs from the same tenant file,
 * so the prompt the ElevenLabs agent runs is byte-identical to the prompt the
 * offline harness and both evals already score.
 *
 * Everything clinic-shaped comes from the tenant file. Everything telephony-
 * shaped is fixed here and explained, because these are the settings that
 * decide whether a real caller experiences a receptionist or a robot.
 */

/**
 * Telephony is mulaw 8 kHz in both directions. Twilio sends and accepts
 * `audio/x-mulaw` at 8000 Hz and ElevenLabs speaks `ulaw_8000` natively, so
 * nothing on the hot path resamples — the same headline finding recorded in
 * docs/VOICE_PIPELINE.md, kept true now that ElevenLabs holds the media path.
 */
export const PHONE_AUDIO_FORMAT = 'ulaw_8000';

/**
 * Decision 0.3 said Haiku class: time-to-first-token dominates perceived
 * latency in speech. Moving up is a one-line change here, but measure first.
 */
export const DEFAULT_LLM = 'claude-haiku-4-5';

/** Lowest-latency TTS family. Telephony is 8 kHz, so the extra fidelity of the
 *  larger models is discarded by the codec anyway — it buys nothing but delay. */
export const DEFAULT_TTS_MODEL = 'eleven_flash_v2_5';

/** English-only agents are held to the v2 models. `eleven_flash_v2_5` is the
 *  multilingual build, and agents/create rejects it with "English Agents must
 *  use turbo or flash v2" (400, 3 September 2026). Same family, same latency —
 *  the _5 suffix buys languages this agent has not been configured for. Any
 *  other language keeps the multilingual default. */
export const DEFAULT_TTS_MODEL_EN = 'eleven_flash_v2';

/** @param language BCP-47-ish language code from the tenant file. */
export function defaultTtsModel(language) {
  return String(language ?? 'en').toLowerCase().startsWith('en')
    ? DEFAULT_TTS_MODEL_EN
    : DEFAULT_TTS_MODEL;
}

/** Decision 0.5: keep conversation records long enough to diagnose a failed
 *  call, and no longer. Overridable per clinic; see the PHI note in the docs. */
export const DEFAULT_RETENTION_DAYS = 30;

/** Words a clinic caller says mid-sentence that must not count as an interruption. */
const FILLER_TERMS = ['yeah', 'yep', 'uh huh', 'mhm', 'okay', 'ok', 'right', 'sure'];

function required(value, message) {
  if (value === undefined || value === null || value === '') throw new Error(message);
  return value;
}

/** The line the agent opens with. Clinics may author it; otherwise it is built
 *  from the name the clinic already declares it is spoken as. */
export function greetingFor(tenant) {
  const authored = tenant.voice?.greeting;
  if (authored) return authored;
  const spoken = tenant.prompt?.spoken_name ?? tenant.display_name;
  return `Thank you for calling ${spoken}. How can I help you today?`;
}

/**
 * The system tools the agent may use. These are ElevenLabs-side behaviours, not
 * HTTPS calls, so they cost nothing and cannot fail open.
 */
export function builtInTools(tenant) {
  const transferNumber = tenant.voice?.transfer_number ?? tenant.contact?.phone;
  const spoken = tenant.prompt?.spoken_name ?? tenant.display_name;

  const tools = {
    end_call: {
      name: 'end_call',
      description: 'End the call once the caller has confirmed they need nothing further.',
      response_timeout_secs: 20,
      type: 'system',
      params: { system_tool_type: 'end_call' },
    },
    // A caller pausing to find their calendar or read a phone number off a card
    // must not be talked over. This lets the agent hold the line silently.
    skip_turn: {
      name: 'skip_turn',
      description: 'Stay silent when the caller has paused to look something up or is still thinking.',
      response_timeout_secs: 20,
      type: 'system',
      params: { system_tool_type: 'skip_turn' },
    },
  };

  // The prompt's EMERGENCY ESCALATION section tells the agent to get a human on
  // the line. Without this tool that instruction has nothing to act on.
  if (transferNumber) {
    tools.transfer_to_number = {
      name: 'transfer_to_number',
      description:
        'Transfer the caller to a human at the clinic. Use for a medical emergency, '
        + 'a caller in distress, or an explicit request to speak to a person.',
      response_timeout_secs: 20,
      type: 'system',
      params: {
        system_tool_type: 'transfer_to_number',
        transfers: [{
          transfer_destination: { type: 'phone', phone_number: transferNumber },
          condition: 'The caller has a medical emergency, is in distress, or has asked to speak to a person.',
          transfer_type: 'conference',
        }],
      },
    };
  }

  // An outbound reminder reaching voicemail should leave a message and hang up,
  // not hold a conversation with an answering machine.
  tools.voicemail_detection = {
    name: 'voicemail_detection',
    description: 'Detect an answering machine and leave a short message instead of conversing.',
    response_timeout_secs: 20,
    type: 'system',
    params: {
      system_tool_type: 'voicemail_detection',
      voicemail_message: `This is ${spoken} returning your call. Please call us back when convenient.`,
    },
  };

  return tools;
}

/**
 * @param tenant   parsed tenants/<slug>.json
 * @param prompt   the rendered system prompt (from agent/render-prompt.mjs)
 * @param options  { toolIds, knowledgeBase, pronunciationDictionaryId }
 */
export function buildConversationConfig(tenant, prompt, options = {}) {
  const { toolIds = [], knowledgeBase = [], pronunciationDictionaryId = null } = options;
  const voice = tenant.voice ?? {};

  const voiceId = required(
    voice.elevenlabs_voice_id,
    `${tenant.slug} declares no voice.elevenlabs_voice_id. `
    + 'Run `npm run elevenlabs:voices` to list the voices on your account, then add one to the tenant file.',
  );

  return {
    asr: {
      quality: 'high',
      provider: 'elevenlabs',
      user_input_audio_format: PHONE_AUDIO_FORMAT,
      // Names and terms the clinic says constantly. Feeding them to the
      // recogniser is the cheapest accuracy win available, and mishearing a
      // service name sends the caller down the wrong booking flow.
      keywords: asrKeywords(tenant),
    },

    turn: {
      turn_model: 'turn_v3',
      // Clinic callers are frequently elderly, and spell out names and read
      // phone numbers off cards. Patience costs a beat; impatience costs the
      // caller being cut off mid-digit and having to start again.
      turn_eagerness: 'patient',
      turn_timeout: 10,
      spelling_patience: 'auto',
      silence_end_call_timeout: 45,
      interruption_ignore_terms: FILLER_TERMS,
      merge_with_default_ignore_terms: true,
      soft_timeout_config: {
        // 8 is the ceiling, not a preference: the API rejects anything above it
        // with "Soft timeout must be -1 or between 0.5 and 8 seconds" (422 on
        // agents/create, 3 September 2026). This was 12, which is why the first
        // real apply failed. Raise it only if ElevenLabs raises the cap.
        timeout_seconds: 8,
        message: 'Take your time — I am still here.',
        additional_soft_timeout_messages: ['No rush at all. Whenever you are ready.'],
        max_soft_timeouts_per_generation: 2,
        disable_until_first_user_message: true,
      },
    },

    tts: {
      model_id: voice.tts_model_id ?? defaultTtsModel(tenant.voice?.language ?? 'en'),
      voice_id: voiceId,
      agent_output_audio_format: PHONE_AUDIO_FORMAT,
      stability: voice.stability ?? 0.5,
      speed: voice.speed ?? 1.0,
      similarity_boost: voice.similarity_boost ?? 0.8,
      // The prompt already writes times and dates the way they should be
      // spoken, and the clinic reviewed that wording. Let it through unchanged
      // rather than having a second normaliser reinterpret "9 AM".
      text_normalisation_type: 'system_prompt',
      ...(pronunciationDictionaryId
        ? {
          pronunciation_dictionary_locators: [
            { pronunciation_dictionary_id: pronunciationDictionaryId },
          ],
        }
        : {}),
    },

    conversation: {
      text_only: false,
      max_duration_seconds: 900,
      // A booking involves reading back a date, a time and a spelling. Ten
      // minutes is tight for an unhurried caller; fifteen is not generous.
      dtmf_input_settings: {
        dtmf_input_timeout: 3,
        hash_terminator: true,
        // Keypad entry is how a caller would send a date of birth or a member
        // number. It does not belong in a log.
        redact_input: true,
      },
      // Deliberately no background_sound: simulated office ambience on a
      // medical line implies a staffed room that is not there.
    },

    agent: {
      first_message: greetingFor(tenant),
      language: tenant.voice?.language ?? 'en',
      prompt: {
        prompt,
        llm: voice.llm ?? DEFAULT_LLM,
        temperature: 0,
        // The clinic reviewed every line of those instructions. ElevenLabs' stock
        // persona would argue with them.
        ignore_default_personality: true,
        timezone: tenant.timezone,
        tool_ids: toolIds,
        built_in_tools: builtInTools(tenant),
        knowledge_base: knowledgeBase,
        rag: knowledgeBase.length > 0
          ? { enabled: true, max_vector_distance: 0.6, max_documents_length: 50_000 }
          : { enabled: false },
        // A silent LLM outage should degrade to a different model, not to dead
        // air on a clinic's main line.
        backup_llm_config: { preference: 'default' },
      },
    },
  };
}

/** Service names and provider names, deduplicated, as recogniser hints. */
export function asrKeywords(tenant) {
  const fromServices = (tenant.services ?? []).map((service) => service.name ?? service).filter(Boolean);
  const fromPrompt = [tenant.prompt?.provider_short, tenant.prompt?.spoken_name].filter(Boolean);
  const extra = tenant.voice?.asr_keywords ?? [];
  return [...new Set([...fromServices, ...fromPrompt, ...extra])].slice(0, 100);
}

/**
 * Workspace-level settings for the agent. Kept small on purpose: every field
 * here is one the provisioner has actually round-tripped against the API.
 */
export function buildPlatformSettings(tenant) {
  return {
    privacy: {
      retention_days: tenant.voice?.retention_days ?? DEFAULT_RETENTION_DAYS,
    },
    // The initiation webhook is what supplies today's date and the caller's
    // number before the first word is spoken. Without it the agent opens the
    // call not knowing what day it is.
    overrides: {
      enable_conversation_initiation_client_data_from_webhook: true,
    },
  };
}

export function buildAgentPayload(tenant, prompt, options = {}) {
  return {
    name: `${tenant.display_name} — receptionist${options.nameSuffix ? ` (${options.nameSuffix})` : ''}`,
    tags: ['aivance', tenant.slug, ...(options.tags ?? [])],
    conversation_config: buildConversationConfig(tenant, prompt, options),
    platform_settings: buildPlatformSettings(tenant),
  };
}

/**
 * Appends the live-call-context block to the reviewed system prompt.
 *
 * The reviewed lines are not touched. This adds a delimited block after
 * them carrying the values the conversation-initiation webhook supplies, so the
 * agent knows what day it is before it speaks instead of spending a tool
 * round-trip finding out while the caller waits.
 *
 * The wording is careful about one thing. The reviewed prompt's DATE AND TIME
 * RULES say every date must be read off the get_current_date table, and an
 * addendum that said "you don't need to call it" would leave the model holding
 * two contradictory instructions — which is worse than the round-trip it saves.
 * So this block states that these values *are* what that tool returns, already
 * current for this call, and stops at today and tomorrow. Anything the caller
 * names by weekday still needs the table, because a weekday is exactly what the
 * model must not resolve on its own — see services/call-context.ts.
 */
export function withCallContext(prompt) {
  return `${prompt.trimEnd()}

---

LIVE CALL CONTEXT (supplied by the system when this call connected):
- Today is {{today_day_of_week}}, {{today_date}}. The current time is {{current_time}} ({{clinic_timezone}}).
- Tomorrow is {{tomorrow_day_of_week}}, {{tomorrow_date}}.
- The practice is open right now: {{clinic_open_now}}. Open days: {{clinic_open_days}}.
- The caller is phoning from {{caller_phone}}. Use this number for find_appointment. Do not read it aloud unless the caller asks you to confirm it.

These are the same values get_current_date returns, already current for this call, so today's and tomorrow's dates are known and are not a guess. Any other day — including any weekday the caller names — must come from the get_current_date calendar. Call it and read the row; do not work the date out from the two dates above.
`;
}

/** Every dynamic variable the prompt above references. The initiation webhook
 *  must supply all of them: ElevenLabs fails a call that is missing one. */
export const REQUIRED_DYNAMIC_VARIABLES = Object.freeze([
  'today_date', 'today_day_of_week', 'tomorrow_date', 'tomorrow_day_of_week',
  'current_time', 'clinic_timezone', 'clinic_open_now', 'clinic_open_days', 'caller_phone',
]);
