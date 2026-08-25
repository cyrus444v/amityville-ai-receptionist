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
- `retell/generated/amityville-wellness/system-prompt.txt` — 278 reviewed lines.
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

Nothing was deleted. `src/routes/retell.ts`, `retell/` and the `retell:*` scripts
stay until the self-hosted path handles all six call scenarios in staging.

## Next

Phase 2, and nothing else first: answer a call, stream audio in, stream audio
back out, and report measured milliseconds for every hop. Vendor protocol shapes
get read from current documentation before any adapter is written — an adapter
built from recalled API shapes fails on the first real call.
