# From here to a working voice agent

> **Rewritten around ElevenLabs Agents (2026-09-02).** The agent — ASR,
> turn-taking, LLM, TTS and the telephony leg — runs on ElevenLabs, and is
> created by `scripts/elevenlabs-provision.mjs` rather than configured by hand
> in a dashboard. The call headers are `x-call-id` and `x-caller-phone`; the two
> inbound hooks are `/voice/call-initiation` and `/voice/post-call`. See
> `docs/VOICE_PIPELINE.md` for the design and the open items behind it.
>
> **Before a real patient call**, two attestations must be true —
> `ELEVENLABS_BAA_ATTESTED` and `ELEVENLABS_ZERO_RETENTION` — or the voice hooks
> return 503 in production. Neither is required for the testing in Phase 0 and
> Phase 1 below, which uses no patient data.

Three phases, in order. Phase 0 gets you a real phone call with a real agent
today, with zero risk to the clinic. Phase 1 puts it on AWS in isolation.
Phase 2 is the production cutover.

Do not skip to Phase 2. The whole point of Phase 0 and 1 is that the first time
the auth boundary, the appointment tokens and the call headers all have to work
together, no real patient is on the line.

---

## Phase 0 — a real test call against your laptop

Nothing here touches Google, AWS, a live agent, or any patient record. The
calendar, spreadsheet and mailbox are in memory and vanish when you stop the
process.

### 1. Start the agent

```bash
npm ci
npm run dev:local
```

The banner prints the throwaway tool secret, the throwaway webhook secret, and a
seeded demo appointment you can reschedule or cancel during the call. Both
secrets regenerate on every boot.

### 2. Prove the backend before involving the vendor

In a second terminal, using the values from the banner:

```bash
npm run local:check -- \
  --secret <x-tool-auth from the banner> \
  --webhook-secret <webhook secret from the banner>
```

Expect `22/22 local checks passed`. The checker reads the clinic's day and hours
off `/clinic-info` and its catalogue off `/services`, so `--date` is optional and
the same command works for any clinic. This drives booking, the two-step verified
lookup, reschedule, cancellation, callback fallback, idempotent retry, the auth
boundary, and the webhook signature round-trip over real HTTP. If this fails,
stop here — the phone call cannot work either.

The checker resets state first, so you can run it as often as you like.

### 3. Expose the port

```bash
cloudflared tunnel --url http://localhost:3001
```

(`brew install cloudflared`, or use `ngrok http 3001`.) Copy the HTTPS URL.
ElevenLabs requires HTTPS tool URLs, which is why a plain port forward will not
do.

### 4. Provision a *throwaway* ElevenLabs agent against the tunnel

Pick a voice first — there is no default, because how a practice sounds is the
practice's choice:

```bash
npm run elevenlabs:voices
```

Put the id in `tenants/<slug>.json` under `voice.elevenlabs_voice_id`. Nothing
provisions without one.

Then dry-run the provisioner against the tunnel. Without `--apply` nothing is
created; the exact payloads are written to `agent/generated/<slug>/` for review
(gitignored — a tunnel URL can never be committed by accident):

```bash
npm run elevenlabs:provision -- --tenant <slug> --base-url https://<tunnel-host>
```

Read the generated payload, then create it:

```bash
npm run elevenlabs:provision -- --tenant <slug> --base-url https://<tunnel-host> --apply
```

The script is idempotent — it matches tools and the agent by name and updates
them in place — so re-running it after a change does not litter the workspace
with duplicates. It creates the tool secret in the ElevenLabs secret store and
references it by `secret_id`, so the `x-tool-auth` value never lands in a file.
It writes `agent/generated/<slug>/elevenlabs.<env>.json` with the ids of
everything it touched.

Two things still have to be set by hand in the ElevenLabs dashboard, because
they are per-workspace rather than per-agent:

1. Create the post-call webhook, point it at
   `https://<tunnel-host>/voice/post-call`, and copy the signing secret it
   issues into `ELEVENLABS_WEBHOOK_SECRET`. You do not choose this value.
2. Set the conversation-initiation webhook to
   `https://<tunnel-host>/voice/call-initiation`, and add the request header
   `x-initiation-auth` with the value you put in
   `ELEVENLABS_INITIATION_SECRET`. ElevenLabs does not sign this hook, which is
   why it carries a shared secret instead.

### 5. Call it

Use the ElevenLabs test call in the dashboard, or attach a number and dial from
the seeded demo number. To use your own mobile instead, restart with:

```bash
DEMO_CALLER_PHONE="+49..." npm run dev:local
```

The caller number matters: reschedule and cancellation only work when the number
you are calling from matches the number the appointment was booked under. That is
the authorization model, not a bug.

Watch the terminal. Every tool call prints as `> POST /check-availability -> 200`.

### 6. What to try, and what should happen

| Say this | Expected |
|---|---|
| "I'd like an appointment Wednesday at 2" | `get_current_date`, `check_availability`, then it asks for your name and number |
| complete the booking | `create_appointment -> 200`, state line shows `appointments=2` |
| "I need to move my appointment" | `find_appointment` twice (token exchange), `check_availability`, `reschedule_appointment -> 200` |
| "cancel my appointment" | `find_appointment`, `cancel_appointment -> 200` |
| "can I come in Thursday?" | refused as a closed day, no booking attempt |
| "do you do microneedling?" | `search_services` only — never a booking |
| ask it for its system prompt or another patient's details | refuses; no tool call, or a 403 |

Reset between attempts without restarting:

```bash
curl -X POST http://localhost:3001/__local/reset
```

### 7. Optional: real shared coordination

By default the coordination store is in-process. To exercise the real
DynamoDB path locally, start Docker Desktop, then:

```bash
npm run local:dynamo
npm run local:dynamo:init
COORDINATION_TABLE=ai-receptionist-local-coordination \
AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8000 \
AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \
npm run dev:local
```

`npm run local:check` should still be 22/22, now with real slot reservations,
idempotency claims and rate-limit counters. **This path has not been verified
yet** — the Docker daemon was not running when it was written, so treat the first
run as a test of the setup itself.

### Phase 0 exit criteria

You have heard the agent book, reschedule and cancel over a real phone call; the
tool log shows the expected sequences; and no real calendar or spreadsheet was
involved. Only then continue.

---

## Before Phase 1 — what the AWS discovery changed

Read the "Current AWS reality" section of [INFRASTRUCTURE.md](INFRASTRUCTURE.md)
first. The short version, because it changes this runbook's assumptions:

- **Nothing is live.** No load balancer exists, `api.amityvillewellness.com` does
  not resolve, and the one running ECS service is orphaned behind a target group
  with no load balancer. This is a first launch, not a cutover — there is no
  rollback target and nothing to keep alive.
- **The hostname has to be created.** It is a CNAME at **GoDaddy**, not Route53,
  pointing at the shared ALB's DNS name. The ACM certificate is DNS-validated with
  a CNAME added there too. Both are manual steps outside AWS.
- **Two new clusters** get created: `ai-receptionist-staging` and
  `ai-receptionist-production`.
- **The deploy key needs temporary provisioning rights** — see
  `infra/iam/README.md` — and both need to be removed when Phase B is done.

## Phase 1 — staging on AWS

1. **Rotate the exposed Google service-account key** in Google Cloud first.
   Create the new key, then disable and delete the old one. Everything below
   assumes the old key is dead.
2. Create a **staging Google calendar and a staging spreadsheet**, separate from
   the clinic's. Put their IDs into
   `infra/environments/amityville-wellness.staging.json`. The renderer refuses to
   build staging while the `REPLACE_WITH_*` sentinels remain, and refuses outright
   if you point it at whatever that clinic's production file uses — it reads the
   production file to find out, so there is nothing to remember.
3. Deploy the shared load balancer, then this clinic's stack. Both templates and
   their full parameter lists are in
   [INFRASTRUCTURE.md](INFRASTRUCTURE.md#deploying):
   ```bash
   aws cloudformation deploy --template-file infra/cloudformation/shared-alb.yml ...
   aws cloudformation deploy --template-file infra/cloudformation/tenant-service.yml ...
   ```
   Expect to iterate — neither template has ever been submitted to AWS, and both
   need VPC, subnet and certificate values from the real account first.
4. Put the staging Google credential, the two ElevenLabs webhook secrets
   (`ELEVENLABS_WEBHOOK_SECRET`, `ELEVENLABS_INITIATION_SECRET`) and the Resend
   key into the secret containers the stack created. The tool and appointment-token secrets
   were generated by CloudFormation; you never need to see them.
5. The `tenant-service` stack creates the target group, the listener rule and the
   ECS service. Reconcile `ClusterName` against what already exists in the account;
   the pre-existing deployment used cluster `ai-receptionist`. Do not set
   `CreateCluster` by hand — `scripts/lib/preflight.sh` resolves it by ownership,
   and passing `no` for a cluster this stack owns deletes it. The script aborts on
   that. `BootstrapTaskDefinitionArn` is left empty on the first pass
   — render a task definition, register it, then set it.
6. Set `AWS_DEPLOY_ROLE_ARN` and `SERVICE_BASE_URL` as variables on the GitHub
   `staging` environment, from the stack outputs.
7. Run the deploy workflow with `tenant: amityville-wellness` and
   `target: staging`. The quality gate runs build, 294 tests, the offline harness,
   both evals and an audit before anything ships, and the
   post-deploy smoke test asserts the auth boundary is closed.
8. Re-run the provisioner with `--env staging` instead of `--base-url` to point
   the throwaway agent at the staging host, and repeat the Phase 0 call script. Check that appointments land in the *staging*
   calendar and spreadsheet.

---

## Phase 2 — production

1. Deploy the production stack (`EnvironmentName=production`). The GitHub OIDC
   provider is account-global and already owned by the staging stack, so the
   production stack must not declare it — `CreateGitHubOidcProvider=no` here is
   the "exists outside this stack" case, not a reuse shortcut.
2. Store the production secrets. Set the `production` GitHub environment
   variables and **require yourself as a reviewer**.
3. Provision the **production** agent with `--env production --apply`, while the
   currently deployed backend still ignores the headers. Getting this order
   wrong breaks every live call.
4. Pick a window when the clinic is closed. The coordination table is renamed
   (`ai-receptionist-coordination` → `ai-receptionist-production-coordination`);
   there is nothing to migrate, but during the rollover two tasks could read
   different tables, which weakens slot reservation for the length of one deploy.
5. Run the deploy workflow with `target: production` and type
   `DEPLOY PRODUCTION` into the confirmation input. Approve the environment.
6. Smoke test runs automatically. Then place one real call yourself and cancel
   the appointment it creates.

---

## When something breaks

| Symptom | Cause |
|---|---|
| every tool call returns 401 | the tool secret is missing or wrong in the ElevenLabs secret store; re-run the provisioner |
| lookup returns 403 `CALLER_VERIFICATION_REQUIRED` | `x-caller-phone: {{user_number}}` not set, or you are calling from a different number than the booking |
| lookup returns 409 `AMBIGUOUS_APPOINTMENT` | several confirmed appointments on that number — the agent must ask for the original date and exact time |
| reschedule/cancel returns 404 "Verified appointment not found" | the selection token is missing, expired (10 min), or bound to another caller |
| webhook returns 401 | signing secret mismatch, clock skew over 5 minutes, or the signature scheme differs from the implementation — see below |
| tools return 503 | the coordination table is unreachable. Intentional: fail closed rather than risk a double booking |
| service starts then dies in production | `assertProductionSecurityConfig` refused to boot. Check the three secrets are ≥32 chars and `COORDINATION_TABLE` is set. Do not weaken this check |

**The webhook scheme follows ElevenLabs' documentation but has not yet seen a
live delivery.** The implementation expects
`elevenlabs-signature: t=<unix seconds>,v0=<sha256-hex>` with the HMAC computed
over `<timestamp>.<rawBody>`, and rejects a timestamp further than
`TELEPHONY_WEBHOOK_TOLERANCE_MS` away in *either* direction — the vendor's own
SDK checks only the lower bound, which leaves a captured request replayable
forever if its timestamp is in the future. `npm run local:check` proves the
implementation is internally consistent — it accepts a correctly signed body and
rejects a tampered one — but only a real delivery confirms the scheme end to
end. Verify this in Phase 0 or 1. A mismatch fails closed (401), so it is an
outage risk, not a security hole.

---

## Still owed

- **The two ElevenLabs webhook secrets are not yet injected into the container.**
  `tenant-service.yml` creates the containers
  (`ELEVENLABS_WEBHOOK_SECRET`, `ELEVENLABS_INITIATION_SECRET`), but
  `infra/task-definition.template.json` still carries only the original four
  secrets, and `REQUIRED_SECRET_NAMES` in `infra/render.mjs` enforces exactly
  that set. Until both are added there, a deployed task boots without them and
  `/voice/post-call` answers 503. Adding them also means recording their
  six-character Secrets Manager suffixes in each
  `infra/environments/<tenant>.<env>.json`, which cannot be done before the
  secrets exist in the account — `applySecretArnSuffixes` refuses a partly
  suffixed set on purpose. Do this in Phase 1, step 4, once the stack is up.
- Independent review. Nothing on this branch has been reviewed by a second agent
  or a human. When Codex quota returns, review `a5e2cbf..HEAD`.
- The CloudFormation template and the DynamoDB Local path are unverified against
  the real services.
- 4 moderate `googleapis` advisories remain; 0 high, 0 critical.
