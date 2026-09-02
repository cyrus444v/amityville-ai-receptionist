# Voice pipeline

**Status: reversed on 1 September 2026.** Turn-taking is no longer ours. The
agent runs on the ElevenLabs Agents platform, which supplies ASR, the
turn-taking model, the LLM host, TTS and the telephony leg as one service. What
this repository keeps is the part that was always the product: the eight
authenticated HTTPS tools, the 278-line reviewed system prompt, the tenant
model, and the offline harness.

Read the reversal below before the decision table — the table is retained as
history, and most of it no longer describes what runs.

## The reversal, and what it cost (1 September 2026)

The original position is directly below and was argued well: owning turn-taking
is what determines latency, cost per minute, and where patient audio goes. It
was reversed on an explicit instruction to use ElevenLabs to its full extent,
and the trade is worth writing down plainly rather than quietly restating the
architecture as though it had always been this.

**What was given up.** Control of *when the agent talks*. Decisions 0.1–0.3
below are void: there is no Twilio Media Streams socket, no Deepgram, and no
turn-taking engine in this codebase. Barge-in, endpointing and interruption
handling are now ElevenLabs' proprietary turn model, tuned through configuration
(`turn_eagerness`, `interruption_ignore_terms`, `soft_timeout_config`) rather
than owned in code. If that model behaves badly on a specific caller, we
configure around it; we cannot fix it. Phase 2's measured-milliseconds spike
never happened, so the latency claims are the vendor's, not ours.

**What was gained.** A working phone call, far sooner, with the whole
turn-taking problem — the hardest part of the build and the one most likely to
be wrong on the first real call — handled by a vendor whose main business it is.
And, unexpectedly, a *simpler* compliance story: the self-hosted design put
patient audio into three vendors' pipes (Deepgram, Anthropic, ElevenLabs) and
needed a BAA or a written exemption from each. It now needs one.

**What got harder.** That single BAA is Enterprise-tier only, and ElevenLabs
requires Zero Retention Mode alongside it. Under ZRM nothing is retained — no
transcripts, no audio, no tool calls or results. That is in direct tension with
decision 0.5, which wanted transcripts kept precisely so turn-taking failures
stay diagnosable. Both cannot hold. The tension is unresolved and is the first
open item below; it is not resolved by this code, only made visible by it.

**The reversal is not one-way.** `agent/tools.json` and the prompt template
remain vendor-neutral, and `lib/elevenlabs/` is a translation layer over them
rather than a rewrite. A future self-hosted pipeline would re-read the same two
files. Nothing about this change forecloses going back; it only means the going
back would start from a service that works.

## Original decisions (25 August 2026) — retained as history

These describe the self-hosted design. **0.1, 0.2 and 0.3 are void**; 0.4, 0.5
and 0.6 are discussed above and below.

| # | Decision | What it costs |
|---|---|---|
| 0.1 | **Twilio Voice + bidirectional Media Streams** (WebSocket, mulaw 8 kHz) | Twilio holds the number and the media path. It does *not* hold turn-taking — that is the line we are drawing. |
| 0.2 | **Deepgram** streaming STT | A third vendor carrying patient audio. Interim results and word-level timing are what make barge-in possible at all. |
| 0.3 | **Claude, Haiku class**, streaming tokens + tool calling | Time-to-first-token dominates perceived latency in speech. Start at Haiku and move up only if answer quality demands it — measure before moving. |
| 0.4 | **Keep the HTTPS tool boundary**, internal calls over localhost carrying `TOOL_AUTH` | One hop per tool call, but every existing auth-boundary test keeps protecting the path the agent actually uses. Documented escape hatch: move in-process if measurement proves the hop matters. |
| 0.5 | **Transcripts only, with TTL.** No audio at rest | PHI at rest, so the DPA/BAA scope grows — but turn-taking failures become diagnosable, which they are not if we keep nothing. |
| 0.6 | **3 concurrent calls** | `DesiredCount` must rise, deregistration delay must cover the longest call, and the deploy strategy has to drain rather than cut. That is the bulk of Phase 5. |

Decision 0.4 is the one to revisit under measurement. Decisions 0.2 and 0.3 are
the ones with a compliance cost attached — see below.

## Open, and not ours to decide alone

1. **The BAA, and the contradiction inside it.** ElevenLabs will handle PHI only
   under an executed BAA *and* Zero Retention Mode; the BAA is Enterprise tier
   only. ZRM retains nothing — not transcripts, not audio, not tool calls or
   their results. Decision 0.5 wanted transcripts kept with a TTL so turn-taking
   failures stay diagnosable. **Both cannot be true.** Someone has to choose:
   diagnosable calls, or PHI-eligible calls. The code currently assumes the
   second, keeps no transcript, and captures only the non-PHI envelope
   (duration, termination reason, success classification) so that *something*
   remains to debug with. This must be settled before a real patient calls.
2. **A phone number has to be bought,** and pointed at ElevenLabs — either a
   Twilio number imported with `--phone-number`, or a SIP trunk. Nothing has
   been signed up for.
3. **Tier.** Everything below Enterprise can build and test this agent but must
   not take a real patient call on it. `scripts/elevenlabs-provision.mjs` prints
   the tier and warns.
4. ~~Log access for a media socket~~ — moot. There is no media socket now; call
   diagnostics come from the post-call webhook and the ElevenLabs dashboard.


## What is already built, and must survive

- The eight HTTPS tools, live and tested against staging.
- `agent/generated/amityville-wellness/system-prompt.txt` — 278 reviewed lines.
  This becomes the LLM system prompt directly. Re-home it; do not rewrite it.
- `harness/` plus the eight transcript scenarios. This is the offline safety net
  and the only way the pipeline is testable without a phone. Extend it.
- Baseline: typecheck clean, vitest green. Held at every phase.

## Phase 1 — done

Configuration is provider-neutral: `TELEPHONY_CALLER_PHONE_HEADER`,
`TELEPHONY_CALL_ID_HEADER`, `TELEPHONY_WEBHOOK_SECRET`,
`TELEPHONY_WEBHOOK_TOLERANCE_MS`. The `RETELL_*` spellings are still accepted as
fallbacks, and the header defaults still name Retell's headers — **on purpose**:
the task definition currently deployed sets `RETELL_*`, so removing the fallback
would stop the running container from booting before any replacement exists.
`TOOL_AUTH_SECRET` / `_HEADER` / `_VERSION` were already provider-neutral and
were not touched.

Nothing was deleted. `src/routes/retell.ts`, `agent/` and the `retell:*` scripts
stay until the self-hosted path handles all six call scenarios in staging.

## Verified vendor facts (25 August 2026) — retained as history

**These describe the self-hosted design and no longer describe what runs.** The
Twilio Media Streams and Deepgram protocol notes below were researched properly
and are correct as far as they go; they are kept because they are exactly what a
future self-hosted attempt would need, and re-deriving them costs a day. For the
facts that apply to the current design, see the section further down.

**The headline: mulaw 8 kHz end to end, no resampling on the hot path.** Twilio
sends and accepts `audio/x-mulaw` at 8000 Hz, Deepgram accepts `mulaw` as a
streaming encoding, and ElevenLabs can emit `ulaw_8000` directly. Nothing in the
audio path has to be converted, which removes both a latency cost and a class of
bug from the design before it is written.

### Twilio Media Streams — [WebSocket messages](https://www.twilio.com/docs/voice/media-streams/websocket-messages)

Twilio → us: `connected`, `start` (carries `streamSid`, `callSid`, `mediaFormat`),
`media` (`media.payload` base64, `media.track` inbound/outbound, `sequenceNumber`,
`timestamp`), `dtmf`, `stop`, and `mark` echoed back when queued audio has
finished playing.

Us → Twilio: `media` (`{event, streamSid, media:{payload}}`), `mark`
(`{event, streamSid, mark:{name}}`), and `clear` (`{event, streamSid}`).

**`clear` is the barge-in primitive.** It "empties all buffered audio and causes
any `mark` messages to be sent back". Without it the caller keeps hearing
sentences they already interrupted, because that audio is queued at Twilio, not
at us. Paired with `mark`, it also tells us *how much* of the reply was actually
heard — which is exactly what the conversation history has to record after an
interrupt, rather than what we generated.

### Twilio request signing — [Security](https://www.twilio.com/docs/usage/security)

HMAC-SHA1 over the full URL with the POST parameters sorted and concatenated,
keyed by the account Auth Token, base64-encoded, sent as `X-Twilio-Signature`.
For JSON bodies the body is *not* folded in that way: a `bodySHA256` query
parameter carries a hex SHA-256 of the body and the URL is signed with it
included.

**Caveat worth knowing before it costs an afternoon:** for the Media Streams
WebSocket upgrade, validation may require a trailing `/` appended to the URL
passed to the validator.

### Deepgram streaming — [Live Audio reference](https://developers.deepgram.com/reference/speech-to-text/listen-streaming), [Endpointing](https://developers.deepgram.com/docs/endpointing), [Interim Results](https://developers.deepgram.com/docs/interim-results), [Utterance End](https://developers.deepgram.com/docs/utterance-end)

`encoding=mulaw`, `sample_rate=8000`, `channels=1`. Close cleanly with
`{"type":"CloseStream"}`.

Three independent signals, and the turn-taking engine needs all three:

- `interim_results=true` → preliminary transcripts with `is_final:false`, then
  `is_final:true` once a segment is settled.
- `endpointing` (default 10 ms) → sets `speech_final:true` when a pause is
  detected. Concatenate `is_final` transcripts into a buffer; `speech_final`
  means the buffer is a complete utterance.
- `utterance_end_ms=<n>` → a silence gap after the last finalized word.
  **Requires `interim_results=true`.** Runs independently of endpointing, so
  both can be on at once — which is what we want: endpointing is fast and
  sometimes wrong, `utterance_end_ms` is slower and steadier.

`vad_events=true` emits a *Speech Started* message. That is the cheapest possible
barge-in trigger — it fires before any transcript exists, which is the difference
between cutting the agent off mid-word and cutting it off a syllable late.

Word-level timings arrive as `channel.alternatives[].words[]` with `start`, `end`
and `confidence` in seconds.

### ElevenLabs — [Streaming TTS](https://elevenlabs.io/docs/api-reference/text-to-speech/stream)

`output_format` accepts `ulaw_8000` (and `alaw_8000`, `pcm_8000`…). We take
`ulaw_8000` and hand the bytes to Twilio untouched. The WebSocket streaming
endpoint and its incremental-text/flush semantics are **not** covered by that
page and still need verifying before Phase 3 — sentence-by-sentence feeding is
what keeps first-audio under budget, so it is not optional.

## How it fits together now

```
caller
  │
  ▼
Twilio number (held by ElevenLabs)
  │
  ▼
ElevenLabs Agents
  ├── ASR (ulaw_8000, service names as keywords)
  ├── turn-taking model (turn_v3, patient)
  ├── LLM: Claude Haiku class, running the reviewed 278-line prompt
  ├── TTS (ulaw_8000, per-clinic voice)
  │
  ├── on connect ──► POST /voice/call-initiation   (shared secret)
  │                    ◄── today's date, open/closed, caller number
  ├── during call ──► the eight webhook tools      (secret_id from the vault)
  │                    ◄── availability, bookings, cancellations
  └── on hangup ───► POST /voice/post-call         (HMAC-SHA256, vendor-signed)
                       ◄── 200
```

The service is never a client of ElevenLabs at runtime — it only answers those
two hooks. Everything that talks *to* ElevenLabs is an operator script.

### What lives where

| Path | What it is |
|---|---|
| `agent/tools.json` | the eight tools, vendor-neutral, unchanged |
| `agent/system-prompt.template.txt` | the reviewed prompt machinery, unchanged |
| `lib/elevenlabs/tool-config.mjs` | translates the tools into webhook tool configs |
| `lib/elevenlabs/agent-config.mjs` | builds `conversation_config` from a tenant file |
| `lib/elevenlabs/client.mjs` | a thin API client; operator scripts only |
| `scripts/elevenlabs-provision.mjs` | creates/updates the agent. Dry-run by default |
| `scripts/elevenlabs-voices.mjs` | lists voices so a clinic can be given one |
| `src/routes/voice.ts` | the two inbound webhooks |
| `src/middleware/voice-webhook.ts` | signature and shared-secret verification |
| `src/services/voice-vendor.ts` | the PHI gate |

## Provisioning a clinic

```bash
# 1. Pick a voice. There is no default — how a practice sounds is theirs to choose.
ELEVENLABS_API_KEY=... npm run elevenlabs:voices -- --search calm
#    Put the id in tenants/<slug>.json under voice.elevenlabs_voice_id

# 2. Dry run. Nothing is created; the exact payloads are written to
#    agent/generated/<slug>/ for review.
ELEVENLABS_API_KEY=... TOOL_AUTH_SECRET=... \
  npm run elevenlabs:provision -- --tenant <slug> --env staging

# 3. Apply. Idempotent: matches by name and updates in place.
ELEVENLABS_API_KEY=... TOOL_AUTH_SECRET=... \
  npm run elevenlabs:provision -- --tenant <slug> --env staging --apply
```

Three things the script deliberately does **not** do, because they are
workspace-level settings rather than per-agent ones and are worth a human
looking at:

1. **Post-call webhook** → `POST https://<host>/voice/post-call`. ElevenLabs
   generates the signing secret; copy it into `ELEVENLABS_WEBHOOK_SECRET`.
2. **Conversation-initiation webhook** → `POST https://<host>/voice/call-initiation`,
   with a request header carrying `ELEVENLABS_INITIATION_SECRET`.
3. **Zero Retention Mode**, under Privacy → Advanced. Required before any real
   patient call, and attested back to the service via `ELEVENLABS_ZERO_RETENTION`.

## Verified vendor facts for the current design (1 September 2026)

Read from current documentation and, where the documentation stopped short, from
the vendor's published SDK. Cited because an adapter written from remembered API
shapes fails on the first real call.

- **Agent creation** — `POST /v1/convai/agents/create`, with `conversation_config`
  (`asr`, `turn`, `tts`, `conversation`, `agent.prompt`) and `platform_settings`.
  [API reference](https://elevenlabs.io/docs/api-reference/agents/create)
- **Webhook tools** — `POST /v1/convai/tools` with `tool_config.type = "webhook"`.
  Headers take either `{secret_id}` from the workspace vault or
  `{variable_name}` for a dynamic variable, which is how the tool secret stays
  out of every rendered file.
  [API reference](https://elevenlabs.io/docs/api-reference/tools/create)
- **System dynamic variables** — `system__caller_id`, `system__conversation_id`,
  `system__call_sid` and friends. These replace Retell's `{{user_number}}` and
  `{{call_id}}`.
  [Dynamic variables](https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables)
- **Conversation initiation webhook** — payload carries `caller_id`, `agent_id`,
  `called_number`, `call_sid`, `conversation_id`; the response must be
  `{type: "conversation_initiation_client_data", dynamic_variables: {...}}` and
  **must contain every variable the prompt references**, or the call fails.
  [Twilio personalization](https://elevenlabs.io/docs/eleven-agents/customization/personalization/twilio-personalization)
- **Post-call webhook signature** — header `elevenlabs-signature`, value
  `t=<unix seconds>,v0=<hex>`, where the hex is HMAC-SHA256 over the literal
  string `` `${t}.${rawBody}` ``. **This is not in the API reference**; their
  docs only say "use the SDK". It was read out of
  `@elevenlabs/elevenlabs-js@2.65.0`, `wrapper/webhooks.js`, rather than guessed.
  Two deliberate divergences from that SDK, both tighter: its timestamp check is
  one-sided (a future-dated capture replays forever) and its digest comparison
  is a plain string `!==`. Ours is two-sided and constant-time.
  [Post-call webhooks](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks)
- **HIPAA** — BAA plus Zero Retention Mode, Enterprise tier only. Without ZRM an
  agent "is no longer deemed a covered service for purposes of the BAA".
  [HIPAA](https://elevenlabs.io/docs/eleven-agents/legal/hipaa)
- **mulaw 8 kHz end to end still holds.** `ulaw_8000` is accepted for both
  `user_input_audio_format` and `agent_output_audio_format`, so nothing
  resamples on the hot path — the one finding from the original design that
  survived the reversal intact.

## Next

1. Choose a voice and add it to the tenant file; nothing provisions without one.
2. Dry-run the provisioner, read the generated payload, then apply to staging.
3. Settle the ZRM-versus-diagnosability contradiction in open item 1. It is the
   only blocker between a working staging agent and a real patient call.
4. Buy and attach a number, then run the call script in `docs/GO_LIVE.md` §6
   against the staging agent.
5. Whatever `claude-haiku-4-5` resolves to on the account is confirmed by the
   provisioner's first apply — the model id list is documented by name, not by
   API identifier, so the first create is what proves it.
