# Claude Code handoff — make it live, make it sellable

You are continuing the AIVANCE voice-agent build. Read this file, then
`docs/TENANT_ARCHITECTURE.md`, then `docs/GO_LIVE.md`. The plan is already made;
your job is to execute it and to correct it where reality disagrees.

## Where you are

- Repository: `/Users/cyruslang/aivance-voice-agent` (standalone clone, `origin` is GitHub)
- Branch `agent/claude-infra-20260818`, on the reviewed candidate:
  - `5e4e0c0` hardened security baseline (65 tests, reviewed evidence)
  - `b449511` declarative infrastructure, Retell header fix, offline harness
  - `9ea0814` locally runnable agent, live-server checker, go-live runbook
  - then documentation, the in-repo evaluator, and Phase A (the tenant refactor)
- Green right now: `npm run build`, `npm run test:ci` (232 tests),
  `npm run harness`, `npm run local:check` (22/22 against a live server, for each
  of two clinics), static eval 48/48, transcript eval 48/48.

## Ground rules

1. **Never touch `/Users/cyruslang/Desktop/amityville-ai-receptionist/backend`
   working tree.** It holds Cyrus's uncommitted work. Read it if you must; do not
   edit, stash, reset, clean or commit it. All work happens in this repository.
   It is reachable as the `local-desktop` remote if you need to compare, but treat
   it as read-only.
2. Do not weaken a test, an eval, an authentication boundary or a fail-closed
   guard to get something green. If a check is wrong, fix the check and say why.
3. Nothing merges to `main` and nothing deploys to production without Cyrus
   saying so explicitly, in that moment.
4. The Google service-account key that was previously committed is compromised.
   Never reconstruct it, never read it out of git history. It must be rotated in
   Google Cloud before production traffic.
5. Patient data is PHI. No real patient record leaves the clinic's own Google
   resources, and none appears in a log, a test fixture, or a commit.

## Phase A — make it multi-tenant — DONE

Completed 19 August 2026. All ten refactor steps in
`docs/TENANT_ARCHITECTURE.md` are implemented, four of them differently from the
plan; see "Where this plan was wrong" in that file for what changed and why.

Verified at the end of the phase:

| | |
|---|---|
| `npm run build` | clean |
| `npm run test:ci` | 232 tests (was 118), typecheck of src + tests + harness + infra + lib |
| `npm run harness` | 19 |
| `npm run eval:static` | 48/48 |
| `npm run eval:transcripts` | 48/48 |
| `npm run local:check` | 22/22 against a live server — **for each of two clinics** |

The exit condition held: a second clinic configured only by a tenant file boots
the app, serves the whole tool flow, and reports its own hours, services, timezone
and email footer; and no `Amityville`, `amityvillewellness`, `631-691`, `Broadway`
or `Hurme` survives anywhere under `src/` — enforced by
`tests/unit/tenant-neutrality.spec.ts` rather than by inspection.

Things a reader of the original plan should know changed:

- There is **no tenant default anywhere**, in any environment. Every entry point
  names the clinic it serves. A process that cannot resolve one refuses to start.
- Environment files are now `infra/environments/<slug>.<environment>.json`, and
  every render command takes `--tenant <slug>`. The deploy workflow gained a
  `tenant` input, passed to the renderer through the step environment rather than
  interpolated into the shell command.
- `infra/cloudformation/voice-agent-core.yml` is now `tenant-service.yml`, plus a
  new `shared-alb.yml`. The compute and networking Phase B item 3 asks for are
  written but still unvalidated against AWS.
- `js-yaml` was added as a devDependency so `test:ci` parses both CloudFormation
  templates and resolves every reference. Nothing had ever parsed them.

### The original Phase A brief, for reference

It is entirely local and fully verifiable, and it changes the task
definition shape — so doing it before the AWS work avoids deploying twice.

Follow the ten refactor steps in `docs/TENANT_ARCHITECTURE.md`.
`tenants/amityville-wellness.json` is already written with the real values pulled
out of the code; treat it as the reference shape.

After each step: `npm run test:ci`. At the end of the phase, all of:

```bash
npm run test:ci          # 118+ tests, typecheck of src + tests + harness + infra
npm run harness
npm run dev:local        # then, in another terminal:
npm run local:check -- --secret <banner> --webhook-secret <banner> --date <banner>
```

Phase A is done when a **second** tenant fixture with different business hours
and a different services list boots the app, serves the whole tool flow, and
reports its own hours and footer — proven by a test, and when no literal
`Amityville`, `amityvillewellness`, `631-691` or `Broadway` survives anywhere
under `src/`.

Commit at the end of the phase with the verification numbers in the message.

## Phase B — reconcile the templates with the real AWS account

This is the part only you can do, because it needs Cyrus's credentials. Nothing
here has ever been checked against reality.

1. Find out what actually exists. Something already serves
   `api.amityvillewellness.com`, so there is a cluster, a service, a load
   balancer and a certificate somewhere:
   ```bash
   aws ecs list-clusters
   aws ecs list-services --cluster <each>
   aws elbv2 describe-load-balancers
   aws elbv2 describe-listeners --load-balancer-arn <arn>
   aws acm list-certificates
   aws route53 list-hosted-zones
   aws dynamodb list-tables
   aws secretsmanager list-secrets
   ```
   Write what you find into `docs/INFRASTRUCTURE.md` under a new "Current AWS
   reality" section. Guessing here costs a broken deploy.
2. **Reconcile the naming.** `.github/workflows/deploy.yml` currently assumes
   clusters `ai-receptionist-staging` / `ai-receptionist-production` and a service
   `ai-receptionist-backend`. The pre-existing deployment used cluster
   `ai-receptionist`. Either adopt the existing names or plan the rename
   explicitly — do not leave the workflow pointing at something that does not
   exist.
3. **Complete the IaC.** *Phase A did the split:* `shared-alb.yml` and
   `tenant-service.yml` now exist, and the compute and networking that were missing
   — cluster, service, target group, listener rule, listener certificate, task
   security group — are written. What remains is the part that needs the account:
   fill in `VpcId`, `TaskSubnetIds`, `PublicSubnetIds`, `CertificateArn`,
   `ClusterName` and `ListenerRulePriority` from what is really there, and **import
   the resources that already exist rather than creating duplicates** — that is why
   `CreateCluster` defaults to `no`.
4. Validate before applying anything:
   ```bash
   aws cloudformation validate-template --template-body file://infra/cloudformation/tenant-service.yml
   aws cloudformation deploy --no-execute-changeset ...   # review the changeset
   ```
   Expect the template to need corrections. It has never been submitted to AWS.

## Phase C — staging, then a real test call

1. Cyrus rotates the Google key. Do not proceed on the old one.
2. Cyrus creates a staging Google calendar and spreadsheet; put their IDs in
   `infra/environments/amityville-wellness.staging.json`. The renderer refuses to build staging while the
   `REPLACE_WITH_*` sentinels remain, and refuses to point staging at the
   production calendar or spreadsheet.
3. Deploy the staging stack, then the staging service.
4. Render the Retell agent for staging, point a **duplicated** Retell agent at it,
   and run the call script in `docs/GO_LIVE.md` §6.
5. `npm run smoke -- https://<staging-host>` must pass — it asserts the auth
   boundary is closed without CI ever holding the tool secret.

## Phase D — production cutover

Only with Cyrus present and agreeing, and only after Phase C succeeded. Follow
`docs/GO_LIVE.md` Phase 2. The header-before-enforcement ordering in step 3 is
not optional: reversing it breaks every live call.

## Layout

This repository is the home of the project now. Two things live elsewhere and are
read-only from here:

- `/Users/cyruslang/Desktop/amityville-ai-receptionist/backend` — the original
  checkout with Cyrus's uncommitted work. Never modify it.
- `/Users/cyruslang/.codex/.chatgpt-projects/g-p-.../voice-agent-pipeline` — the
  agent pipeline controller and its raw run logs. **Not a dependency:** the
  evaluator now lives in this repository under `evals/`, so
  `npm run eval:static` and `npm run eval:transcripts` work standalone and CI
  enforces both.

`docs/handoff/` holds the written history: the security-baseline review, the
infrastructure build report, and the prompt that started this phase.

## Notes that will save you time

- `NODE_ENV=production` is exported in some shells on this machine. That makes
  `npm ci` skip devDependencies and `tsc` disappear. If a build fails oddly, run
  `env -u NODE_ENV`.
- Retell's exact webhook signature scheme is unconfirmed and Cyrus has said it
  need not match theirs — treat the current HMAC-over-`rawBody + timestamp`
  implementation as ours. `npm run local:check` proves it is self-consistent.
- The offline harness writes `harness/transcripts/voice-agent.jsonl`, scored by
  `npm run eval:transcripts`. Keep both evals at 48/48; CI fails otherwise.
- Nothing on `b449511` or `9ea0814` has had independent review. If Codex quota is
  back, a read-only review of `a5e2cbf..HEAD` is worth one pass.

## Agent routing

When a task is better suited to Claude Code, or would be more efficient there,
tell the user to switch to Claude Code. The same applies in reverse: when a task
is mechanical and repetitive, tell the user to hand it to the cheaper model.
