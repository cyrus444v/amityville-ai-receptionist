# AIVANCE Voice Agent

Voice receptionist for clinics: takes calls through Retell, books, reschedules and
cancels appointments against Google Calendar and Sheets, and confirms by email.
First customer is Amityville Acupuncture, Microneedling & Wellness. Everything
clinic-specific — identity, hours, services, email footer, the clinic-authored
prompt sections — lives in one file per clinic under `tenants/`, so a further
clinic is a configuration change and not a code change.

## Quick start — run it and call it, with nothing real attached

```bash
npm ci
npm run dev:local
```

The banner names the clinic being served, then prints throwaway secrets and a
seeded demo appointment. Calendar, spreadsheet and mailbox are in memory and
vanish on exit — no Google, no AWS, no patient data.

In a second terminal, with the values from the banner:

```bash
npm run local:check -- --secret <...> --webhook-secret <...>
```

Expect `22/22`. The checker asks the running server which day and hours are
bookable, so the same command verifies any clinic:

```bash
TENANT_SLUG=riverside-physio PORT=3002 npm run dev:local
npm run local:check -- --base http://localhost:3002 --caller +19515550199 --secret <...>
```

Then follow `docs/GO_LIVE.md` §3–6 to tunnel the port, point a duplicated Retell
agent at it, and place a real test call.

## Where to read next

| File | What it is |
|---|---|
| `docs/GO_LIVE.md` | the runbook: test call → staging → production, plus a symptom-to-cause table |
| `docs/TENANT_ARCHITECTURE.md` | how this is sellable to many clinics, the refactor that got there, and where the plan was wrong |
| `docs/CLAUDE_CODE_HANDOFF.md` | the current work order, in four phases |
| `docs/INFRASTRUCTURE.md` | the AWS topology, the task-definition renderer, the Retell surface |
| `docs/ENV.md` | every environment variable and the production rollout order |
| `docs/handoff/` | written history: security review, infrastructure build, originating prompt |

## Layout

```
src/          the service
tests/        232 tests — unit, integration, infra, and the offline voice harness
harness/      in-memory Google doubles + the local server + the flow driver
infra/        CloudFormation, per-environment config, the task-definition renderer
tenants/      one file per clinic (identity, hours, services, prompt sections)
lib/          tenant-file reading and clinic scaffolding, shared by scripts and infra
retell/       the agent's tool contract and system prompt
scripts/      local check, post-deploy smoke test, Retell config generator
evals/        the voice and security evaluator, scenarios and fixtures
```

## Commands

| | |
|---|---|
| `npm run dev:local` | run the agent locally with in-memory Google |
| `npm run local:check` | drive 22 flow and boundary checks against a running server |
| `npm run test:ci` | typecheck (src, tests, harness, infra) + all tests |
| `npm run harness` | the offline voice harness; writes scorable transcripts |
| `npm run eval:static` | 48 prompt/tool/backend contract and security checks |
| `npm run eval:transcripts` | scores the harness transcripts against the voice scenarios |
| `npm run infra:render` | render a task definition: `-- --tenant <slug> --env <environment> --image-tag <sha>` |
| `npm run retell:tools` | emit a tool config pointed at a tunnel or staging host |
| `npm run retell:agent` | emit one clinic's tools **and** rendered system prompt |
| `npm run new-tenant` | scaffold a new clinic and print what is left to do by hand |
| `npm run smoke` | read-only post-deploy probe of a deployed host |

## Status

Green: build, 232 tests, static eval 48/48, transcript eval 48/48, and 22/22 local
checks against a live server for **each** of two clinics.

The tenant refactor in `docs/TENANT_ARCHITECTURE.md` is implemented: no clinic
identity remains anywhere under `src/`, and a second clinic boots the same
application, serves the whole tool flow, and reports its own hours, services,
timezone and email footer — proven by `tests/harness/second-tenant.spec.ts`, not
by inspection.

Not yet done: **the CloudFormation has never been applied to AWS.** It is now
split into `shared-alb.yml` and `tenant-service.yml`, and the compute and
networking it was missing are written, but nothing in it has been validated
against a real account — the VPC, subnet and certificate parameters still have to
come from there. Nothing has had independent review since the security baseline.

**Before any production traffic:** the Google service-account key that was once
committed to this repository is compromised and must be rotated in Google Cloud.
It remains in this repository's history — rotation is mandatory, and purging the
history is a separate decision.

## Onboarding another clinic

```bash
npm run new-tenant -- --slug <slug> --display-name "..." --short-name "..." \
  --locality "..." --phone "..." --address "..." --website "https://..." \
  --open tuesday=09:00-17:00 --open saturday=09:00-12:00
```

That writes `tenants/<slug>.json` and both `infra/environments/<slug>.*.json`,
then prints the remaining manual steps in order. The Google calendar and
spreadsheet IDs are deliberately left as placeholders: the renderer refuses to
build a task definition while one remains, and refuses to point a staging
environment at any calendar or spreadsheet its own production file uses.

## Related locations

- `~/Desktop/amityville-ai-receptionist/backend` — the original checkout with
  uncommitted work. Read-only; available here as the `local-desktop` remote.
- `~/.codex/.chatgpt-projects/g-p-*/voice-agent-pipeline` — the agent pipeline
  controller (multi-agent orchestration) and its raw run logs. The evaluator it
  used now lives here in `evals/`, so nothing in this repository depends on that
  folder. It is history, not a dependency.
