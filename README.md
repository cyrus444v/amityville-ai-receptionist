# AIVANCE Voice Agent

Voice receptionist for clinics: takes calls through Retell, books, reschedules and
cancels appointments against Google Calendar and Sheets, and confirms by email.
First customer is Amityville Acupuncture, Microneedling & Wellness; the system is
being generalised so a further clinic can be onboarded in under an hour.

## Quick start — run it and call it, with nothing real attached

```bash
npm ci
npm run dev:local
```

The banner prints throwaway secrets and a seeded demo appointment. Calendar,
spreadsheet and mailbox are in memory and vanish on exit — no Google, no AWS, no
patient data.

In a second terminal, with the values from the banner:

```bash
npm run local:check -- --secret <...> --webhook-secret <...> --date <...>
```

Expect `20/20`. Then follow `docs/GO_LIVE.md` §3–6 to tunnel the port, point a
duplicated Retell agent at it, and place a real test call.

## Where to read next

| File | What it is |
|---|---|
| `docs/GO_LIVE.md` | the runbook: test call → staging → production, plus a symptom-to-cause table |
| `docs/TENANT_ARCHITECTURE.md` | how this becomes sellable to many clinics, and the ordered refactor to get there |
| `docs/CLAUDE_CODE_HANDOFF.md` | the current work order, in four phases |
| `docs/INFRASTRUCTURE.md` | the AWS topology, the task-definition renderer, the Retell surface |
| `docs/ENV.md` | every environment variable and the production rollout order |
| `docs/handoff/` | written history: security review, infrastructure build, originating prompt |

## Layout

```
src/          the service
tests/        118 tests — unit, integration, infra, and the offline voice harness
harness/      in-memory Google doubles + the local server + the flow driver
infra/        CloudFormation, per-environment config, the task-definition renderer
tenants/      one file per clinic (business identity, hours, services)
retell/       the agent's tool contract and system prompt
scripts/      local check, post-deploy smoke test, Retell config generator
```

## Commands

| | |
|---|---|
| `npm run dev:local` | run the agent locally with in-memory Google |
| `npm run local:check` | drive 20 flow and boundary checks against a running server |
| `npm run test:ci` | typecheck (src, tests, harness, infra) + all tests |
| `npm run harness` | the offline voice harness; writes scorable transcripts |
| `npm run infra:render` | render a task definition for an environment |
| `npm run retell:tools` | emit a tool config pointed at a tunnel or staging host |
| `npm run smoke` | read-only post-deploy probe of a deployed host |

## Status

Green: build, 118 tests, static eval 48/48, transcript eval 48/48, 20/20 local
checks against a live server.

Not yet done: the CloudFormation has never been applied to AWS and declares no
compute or networking; the tenant refactor in `docs/TENANT_ARCHITECTURE.md` is
planned but not implemented; nothing has had independent review since the security
baseline.

**Before any production traffic:** the Google service-account key that was once
committed to this repository is compromised and must be rotated in Google Cloud.
It remains in this repository's history — rotation is mandatory, and purging the
history is a separate decision.

## Related locations

- `~/Desktop/amityville-ai-receptionist/backend` — the original checkout with
  uncommitted work. Read-only; available here as the `local-desktop` remote.
- `~/.codex/.chatgpt-projects/g-p-*/voice-agent-pipeline` — the agent pipeline
  controller and its recorded run evidence.
