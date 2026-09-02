# Claude-led run report — AIVANCE Voice Agent

Prepared by: Claude (lead architect / implementation agent / bounded fix agent)
Date: 2026-08-18
Status: **BLOCKED — awaiting independent Codex review, then Cyrus' approval**

---

## 1. Exact run identity

| Field | Value |
|---|---|
| Run ID | `20260818-152047-run` |
| Isolated branch | `agent/claude-20260818-152047` |
| Implementation commit | `5e4e0c025d05447d41f766f02ca41ea2f91cece8` |
| Base ref / base commit | `5e4e0c025d05447d41f766f02ca41ea2f91cece8` |
| Role scheme | `claude-build-codex-review-v1` |
| Task | `docs/SECURITY_STABILIZATION_TASK.md` (sha256 `67ce6870...e636d3b`) |
| Controller commit | `1b55891` (clean; descendant of `c2e9f6f`) |
| Approval statement required | `APPROVE 20260818-152047-run 5e4e0c025d05447d41f766f02ca41ea2f91cece8` |
| Packet | `.runs/20260818-152047-run/approval-packet.json` — `green: false` |
| Merge / push / publish / deploy | none |

The implementation commit equals the base commit because the Claude builder audited the
hardened candidate against the architecture plan and the acceptance criteria and concluded
that **no further code change was required**. The worktree is clean and the diff against the
base commit is empty.

## 2. Deterministic evidence

| Gate | Result |
|---|---|
| `npm ci` | exit 0 (140 packages; 4 moderate advisories in the `googleapis` chain) |
| `npm run build` (`tsc`) | exit 0 |
| `npm test` (`vitest run`) | exit 0 — **65/65 tests passed, 9/9 files, fully offline** |
| Static voice/security eval | **48/48 passed, 0 failed** |
| Codex independent security review | **UNAVAILABLE — usage limit reached (retry after 2026-08-20 19:19 local)** |

Codex failure is fail-closed by design: the controller preserved the passing evidence, wrote
`40-codex-security-00.md` as "review unavailable", and emitted a blocked packet.

### Note on the first attempt in this run

The first pass of the test stage failed at `npm run build` with `sh: tsc: command not found`.
Root cause: the shell used to launch the controller had `NODE_ENV=production` exported, so
`npm ci` omitted devDependencies (`typescript`, `vitest`). This was an **environment artifact
of the launch shell, not a repository defect**. The run was resumed with a clean environment
(`env -u NODE_ENV ./bin/aivance-pipeline resume 20260818-152047-run`) and all gates then
passed. No test, eval, guard, or acceptance criterion was weakened or skipped.

## 3. Safety invariants verified

- Original checkout `/Users/cyruslang/Desktop/amityville-ai-receptionist/backend` is untouched:
  HEAD still `a5e2cbf`, branch `main`, and exactly the same pre-existing dirty files
  (`retell/system-prompt.txt`, `retell/tools.json`, `src/routes/appointments.ts`,
  `src/routes/tools.ts`, untracked `.DS_Store`). Nothing stashed, reset, cleaned, or committed.
- All work happened inside `.worktrees/20260818-152047-run/claude-implementation`.
- `--base-ref` was used, so no working-tree overlay was applied and Cyrus' staged prompt/tool
  changes are carried only via the reviewed base commit.
- No AWS, Retell production, Google Calendar, Google Sheets, production API, or patient-data
  access. No live call, no calendar write, no Retell publish.
- Git history and Git objects were never inspected for the redacted Google credential; no
  credential value was recovered, reproduced, or printed.
- No push, merge, approve, publish, or deploy.

## 4. Independent lead-architect review (my own read of the candidate)

The candidate genuinely closes the three prior High findings:

- **IDOR / patient authorization** — `authorizedAppointmentMatch()` is the only selector for
  reschedule/cancel. It requires `status=confirmed`, exact identifier match, and a valid
  HMAC `appointment_token` bound to a *verified caller phone* (`x-retell-caller-phone`).
  `find-appointment` returns only a token on a unique match and `409 AMBIGUOUS_APPOINTMENT`
  with zero disclosed fields on multi-match. The `.at(-1)` last-confirmed fallback is gone.
- **Booking race / process-local idempotency** — DynamoDB `TransactWriteItems` with
  `ConditionExpression` reserves every 10-minute segment of the requested interval; idempotency
  and rate-limit state moved to the same shared table; availability is re-checked under the lock.
- **Calendar/Sheets partial failure** — durable `appointment-operation` records, immediate
  rollback, `CONSISTENCY_ERROR` escalation, and a 60-second `reconcilePendingAppointmentMutations()`
  sweep, each covered by deterministic tests.

Also verified: constant-time tool-auth comparison, `assertProductionSecurityConfig()` failing
closed in production on short/missing secrets, missing coordination table, or wildcard CORS;
raw-body `X-Retell-Signature` HMAC verification; `escapeHtml()` on caller-controlled email
fields; recursive PHI log redaction; 32 kb body limit; only `/`, `/health`, `/services`,
`/clinic-info` public (all PHI endpoints and `/current-date` authenticated);
`aws-setup.sh` carrying no credential material, only `file://$..._FILE` operator inputs.

### Residual risks (none rated Critical/High by me; all documented, none blocking)

1. **Empty review surface (process risk, not code).** Because the builder changed nothing, the
   diff Codex will receive on resume is empty. A `VERDICT: PASS` over an empty diff would turn
   the packet green **without any substantive independent review of the hardening itself**.
   See section 6 for the recommended fix before accepting a green packet.
2. **Caller verification is only as strong as the phone number.** Verification compares the
   Retell-supplied `{{user_number}}` against the stored number. Caller-ID spoofing therefore
   remains a real-world attack path. Inherent to phone-based identification, not a code defect;
   consider a knowledge factor (DOB) for mutations if you want to close it.
3. **Retell signature scheme must be confirmed against live Retell.** Verification expects
   `x-retell-signature: v=<ms-timestamp>,d=<sha256-hex>` with the HMAC computed over
   `rawBody + timestamp`. If Retell's actual ordering or timestamp unit differs, webhooks will
   `401` (fail-closed outage, not a breach). Verify on a staging agent before rollout.
4. **Unconditional lock release.** On reschedule/cancel success the old slot keys are released
   without an owner condition, so a lock held by another writer for that slot could be deleted.
   Low impact (`isSlotAvailable` still re-checks), but it is an ownership-check gap.
5. **Reconciliation cost and concurrency.** Reconciliation runs on every ECS task every 60 s
   using a DynamoDB `Scan` with a filter, and takes no lock, so multiple tasks can reconcile the
   same record concurrently. Operationally noisy and cost-scaling; consider a GSI or a single
   leader task.
6. **Fail-closed dependency on DynamoDB.** With the coordination table unreachable, public tool
   traffic returns `503`. Intentional, but it makes the table a hard availability dependency —
   provision and monitor it before enabling tool auth in Retell.
7. **Crash-window idempotency lockout.** A process crash mid-request leaves a `pending`
   idempotency record, so retries with the same key get `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`
   until the 15-minute TTL. Prevents duplicates; can strand one caller retry.
8. **4 moderate npm advisories** remain in the existing `googleapis` dependency chain
   (0 High, 0 Critical).
9. **The exposed Google service-account key is still live.** No code change can rotate it.

## 5. External setup steps for Cyrus (do NOT let an agent perform these)

1. **Rotate the compromised Google service-account key in Google Cloud** — create a new key,
   update the secret, disable then delete the old key. Treat the old key as compromised
   regardless of what the diff now looks like. Highest priority.
2. **Provision the DynamoDB coordination table**: string partition key `pk`, TTL enabled on
   `ttl`. Grant the ECS task role Get/Put/Update/Delete/Scan on that table only.
   `aws-setup.sh` documents the commands; the pipeline never ran them.
3. **Generate secrets outside the repo** (>=32 chars each, distinct): `TOOL_AUTH_SECRET`,
   `APPOINTMENT_TOKEN_SECRET`; obtain `RETELL_WEBHOOK_SECRET` from Retell. Never paste them
   into a file, issue, or shell history.
4. **Store them in AWS Secrets Manager** and reference them from `ecs-task-definition.json`.
   Set `COORDINATION_TABLE`, `COORDINATION_REGION`, `ALLOWED_ORIGINS` (no `*`),
   `TRUST_PROXY_HOPS`, and the body/rate-limit tunables. Never put secret values in the task
   definition.
5. **Reconfigure Retell manually** — add `x-tool-auth` to every tool, add dynamic
   `x-retell-caller-phone: {{user_number}}` and `x-retell-call-id: {{call_id}}`, and register
   the two-step `find_appointment` flow. **Order matters: add the headers while the current
   backend still ignores them, then deploy the enforcing build.** Otherwise every tool call
   returns 401/403 mid-call.
6. **Append the `referral_source` header to column Q** of the Appointments sheet.
7. **Create/verify the protected GitHub `production` environment** with a required reviewer,
   and confirm `deploy.yml` is `workflow_dispatch` only with `needs: quality`.
8. **Smoke-test after deploy**: unauthenticated `/health`, a signed `/retell/webhook` call,
   and authenticated `/current-date` plus a deliberate lookup miss. Do not smoke-test a write tool.

## 6. Recommended before accepting any green packet

- **Make the independent review substantive.** Have Codex review the real hardening diff
  `a5e2cbf..5e4e0c0`, not the empty `5e4e0c0..5e4e0c0` diff the current run would present.
  Cleanest options: (a) run a one-off read-only Codex review of that commit range outside the
  pipeline and attach it to the run, or (b) have the controller record `base_commit` as
  `a5e2cbf` for review purposes. I deliberately did **not** change the controller or rewrite
  the recorded run provenance — that is Cyrus' call.
- **Pin the test environment in the controller.** `run_test_commands` inherits the caller's
  environment, so a shell with `NODE_ENV=production` silently skips devDependencies and (had
  the build succeeded) would also trip `assertProductionSecurityConfig()`. Recommend
  `NODE_ENV=test` or `env -u NODE_ENV` inside the controller's test stage.
- **Small doc fix**: `prompts/10-architecture-claude.md` still asks for "ordered implementation
  steps for Codex" under the new Claude-builds/Codex-reviews scheme.

## 7. How to resume

Codex reports quota returning **2026-08-20 19:19 local**. After that:

```bash
cd "/Users/cyruslang/.codex/.chatgpt-projects/g-p-67fa5edc49648191975a25fb27df6ad7/voice-agent-pipeline"
env -u NODE_ENV ./bin/aivance-pipeline resume 20260818-152047-run
```

Resume re-runs the tests, evals, and the Codex review on the same isolated branch. A green
packet still requires explicit human approval, and merge and deployment remain separate manual
actions:

```bash
./bin/aivance-pipeline approve 20260818-152047-run \
  --actor "Cyrus Lang" \
  --statement "APPROVE 20260818-152047-run 5e4e0c025d05447d41f766f02ca41ea2f91cece8"
```

That records a local decision only. It does not merge, push, or deploy.
