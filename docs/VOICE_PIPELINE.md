# Self-hosted voice pipeline

We own turn-taking. No third-party orchestrator — no Retell, no Vapi, no Twilio
ConversationRelay. Vendors supply transport, transcription, tokens and speech;
the decision of *when the agent talks* stays in this codebase, because that is
what determines latency, cost per minute, and where patient audio goes.

**Status: decided, not yet designed.** The architecture below the decision table
is deliberately absent until the Phase 2 transport spike produces measured
milliseconds. Designing a latency budget from estimates is how you find out on
the first real call that it was never reachable.

## Decisions (25 August 2026)

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

1. **BAAs.** Self-hosting moves patient audio and transcripts onto our
   infrastructure and into three vendors' pipes (Deepgram, Anthropic,
   ElevenLabs). The clinic is in New York, so this is US health data. Each vendor
   needs a signed BAA or a written reason none is required. Decision 0.5 (keeping
   transcripts) widens this rather than narrowing it. This must be settled before
   a real patient calls — not before the code is written, but not after either.
2. **A phone number has to be bought.** Options and cost to be presented; nothing
   is to be signed up for without an explicit go-ahead.
3. **Log access.** The `aivance-provision` key cannot read CloudWatch logs
   (`GetLogEvents`, `FilterLogEvents`, `DescribeLogStreams` are not granted).
   Debugging a media socket without logs is guesswork. The main policy has ~126
   characters of headroom and cannot grow, so this needs a *second* attached
   policy with log-read actions. Worth doing before Phase 2, not during it.

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

## Verified vendor facts (25 August 2026)

Read from current documentation, not recalled. Cited because an adapter written
from remembered API shapes fails on the first real call.

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

## Next

Phase 2, and nothing else first: answer a call, stream audio in, stream audio
back out, and report measured milliseconds for every hop. Vendor protocol shapes
get read from current documentation before any adapter is written — an adapter
built from recalled API shapes fails on the first real call.
