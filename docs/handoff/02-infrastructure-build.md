# Voice-agent infrastructure build — status

Date: 2026-08-18 · Claude, lead architect / builder · Codex parked at Cyrus's instruction

## Where the work lives

| | |
|---|---|
| Branch | `agent/claude-infra-20260818` |
| Commit | `b449511` |
| Parent | `5e4e0c025d05447d41f766f02ca41ea2f91cece8` (the reviewed candidate) |
| Worktree | `voice-agent-pipeline/.worktrees/infra-20260818/claude-infra` |
| Full design doc | `docs/INFRASTRUCTURE.md` (committed on the branch) |

Stacked on the candidate rather than committed onto `agent/claude-20260818-152047`, so run
`20260818-152047-run` and its evidence stay frozen at `5e4e0c0`. Original checkout
untouched: still `a5e2cbf` with the same four modified files plus untracked `.DS_Store`.

## Verification

| Gate | Result |
|---|---|
| `npm run build` | pass |
| `npm run test:ci` | 118/118 tests, 13 files (was 65/9) |
| Pipeline static eval | 48/48, 0 failed |
| Pipeline transcript eval | 48/48, 0 failed — from harness-generated transcripts |

## What got built

Infrastructure as code. `infra/cloudformation/voice-agent-core.yml`: one stack per
environment — coordination table (TTL, encryption, PITR and deletion protection in
production), log group with per-environment retention, task role scoped to exactly one
table, execution role scoped to exactly five named secrets, and a GitHub OIDC deploy role
pinned to one repo and one environment. The tool and appointment-token secrets are minted
by CloudFormation itself, so those two values are never handled by a person or an agent.

Per-environment container config. Deleted `ecs-task-definition.json` — it hardcoded
production account IDs, the live calendar and spreadsheet, a mutable `:latest` tag, a
duplicated `BUSINESS_NAME`, and wired none of the new security variables. Replaced by a
template plus `infra/render.mjs`, which refuses to emit a definition with an unresolved
placeholder, a mutable tag, a leftover sentinel, a duplicate variable, a cross-environment
secret ARN, a table name disagreeing with CloudFormation, or a non-production `NODE_ENV`.
Staging refuses to render if pointed at the production calendar or spreadsheet — the most
expensive available mistake, now blocked in code.

Staging-first deploys. Staging and production are separate workflow jobs bound to fixed
protected environments; production also requires typing `DEPLOY PRODUCTION`. OIDC roles
replace long-lived AWS keys. Images are always commit-SHA tagged. `scripts/smoke.mjs` runs
a credential-free, read-only post-deploy probe: `/health` must answer 200 and
`/current-date`, `/find-appointment`, `/retell/webhook` must all reject anonymous callers —
so a deploy that leaves the boundary open fails instead of quietly serving patient data.

A real bug found and fixed. `retell/tools.json` declared no headers at all. Once the auth
boundary went live, every tool call would have returned 401 mid-conversation. Each tool now
sends the tool credential and call id, and the three record-specific tools send the verified
caller number — all as Retell dynamic-variable templates, so no secret enters git. A
contract test pins the tool set, requires every URL to map to a path the app actually
protects, and fails the build if a literal credential is ever committed.

Offline end-to-end harness. `npm run harness` drives all eight tools over real HTTP with
only Sheets, Calendar and the mailer faked, so auth, rate limiting, idempotency, caller
verification, appointment tokens, slot coordination and rollback all execute for real.
Eight flows including a cross-caller attack refused with zero mutation, an anonymous write
rejected, a token-less reschedule rejected, and a repeated `Idempotency-Key` producing
exactly one appointment. It emits the transcripts the pipeline now scores 48/48.

Scope, stated plainly: the tool sequences, arguments, responses and outcomes are real; the
spoken utterances are fixtures, because there is no language model in this loop. It proves
backend and authorization behaviour, not how the live agent talks.

A testing gap closed. `tsconfig.json` only included `src/`, so tests and harness were never
typechecked. `tsconfig.test.json` now covers src, tests, harness and infra, wired into
`npm run typecheck`.

## Your next steps, in order

1. Rotate the exposed Google service-account key in Google Cloud. Still the top item.
2. Deploy the two CloudFormation stacks (`CreateGitHubOidcProvider=yes` on the first only).
3. Put the Google, Retell and Resend secret values into Secrets Manager.
4. Fill in a staging calendar ID and staging spreadsheet ID in
   `infra/environments/staging.json` — staging will not render until you do.
5. Create the `ai-receptionist-staging` ECS cluster/service; confirm production is
   `ai-receptionist-production`.
6. Configure the Retell headers and the `tool_auth_secret` dynamic variable — add the
   headers while the current backend still ignores them, then deploy the enforcing build.
7. Set `AWS_DEPLOY_ROLE_ARN` and `SERVICE_BASE_URL` per GitHub environment; require a
   production reviewer.
8. Deploy staging, rehearse the call flow, then production.

## Open items

- Codex review is still owed. Nothing on this branch has had independent review, and the
  candidate's own review is still outstanding (Codex quota returns 2026-08-20 19:19). When
  it does, review the real range `a5e2cbf..b449511` rather than an empty diff.
- Production coordination-table rename (`ai-receptionist-coordination` →
  `ai-receptionist-production-coordination`) needs a closed-hours cutover. Nothing to
  migrate — the table holds only short-lived digests — but two tasks briefly reading
  different tables weakens slot reservation for one deploy.
- Retell signature scheme still needs confirming against live Retell on staging; a mismatch
  means webhooks 401 (fail-closed outage, not a breach).
- CloudFormation is validated structurally and by YAML parse only. It has never been
  submitted to AWS, so expect first-deploy corrections.
- 4 moderate `googleapis` advisories remain; 0 high, 0 critical.

No push, merge, deploy, Retell publish, AWS call, or credential access occurred.

---

# Addendum — runnable local agent (commit `9ea0814`)

Branch `agent/claude-claude-infra-20260818` now has two commits on top of the
reviewed candidate:

- `b449511` declarative infrastructure (staging/production stacks, renderer, OIDC
  deploys, Retell header fix, offline harness)
- `9ea0814` a locally runnable, callable agent

**Read `docs/GO_LIVE.md` on the branch — that is the actual runbook.**

## What you can do right now, without any credential

```bash
npm ci
npm run dev:local        # prints throwaway secrets + a seeded demo appointment
npm run local:check -- --secret <...> --webhook-secret <...> --date <...>
```

20/20 checks against a live server: auth boundary, booking, two-step verified
lookup, reschedule, cancel, callback fallback, idempotent retry, cross-caller
refusal, and a full webhook signature round-trip.

Then `cloudflared tunnel --url http://localhost:3001`,
`npm run retell:tools -- --base-url https://<tunnel>`, point a **duplicated**
Retell agent at it, and call. Calendar, spreadsheet and mailbox are in memory —
the clinic's data is never involved. `curl -X POST localhost:3001/__local/reset`
between attempts.

## Design notes

- The fakes are injected by a `Module._load` preload, so `src/` contains no dev
  switch and production has no bypass. The preload throws if
  `NODE_ENV=production`.
- Secrets are generated per boot and discarded. `retell-tools-for.mjs` writes to
  gitignored `retell/generated/`, rejects non-HTTPS, and refuses to inline a
  secret for anything but a throwaway tunnel host.
- `bootstrap-local-dynamo.mjs` refuses any non-local DynamoDB endpoint.

## Verified this session

build · 118/118 tests · static eval 48/48 · transcript eval 48/48 · 20/20 local
checks against a live server, twice in a row.

## Unverified

- The DynamoDB Local path — Docker daemon was not running.
- The CloudFormation template against real AWS.
- **Retell's exact webhook signature scheme.** The implementation is internally
  consistent (signed accepted, tampered rejected); only a real Retell webhook
  confirms it matches theirs. A mismatch fails closed with 401.
- Independent review of either commit.

Recommended: continue in Claude Code from here — deploys, Retell wiring and
live-call debugging all want a real terminal.
