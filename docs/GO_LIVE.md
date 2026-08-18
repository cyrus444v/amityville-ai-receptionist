# From here to a working voice agent

Three phases, in order. Phase 0 gets you a real phone call with a real agent
today, with zero risk to the clinic. Phase 1 puts it on AWS in isolation.
Phase 2 is the production cutover.

Do not skip to Phase 2. The whole point of Phase 0 and 1 is that the first time
the auth boundary, the appointment tokens and the Retell headers all have to work
together, no real patient is on the line.

---

## Phase 0 — a real test call against your laptop

Nothing here touches Google, AWS, Retell production, or any patient record. The
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

### 2. Prove the backend before involving Retell

In a second terminal, using the values from the banner:

```bash
npm run local:check -- \
  --secret <x-tool-auth from the banner> \
  --webhook-secret <webhook secret from the banner> \
  --date <the seeded date from the banner>
```

Expect `20/20 local checks passed`. This drives booking, the two-step verified
lookup, reschedule, cancellation, callback fallback, idempotent retry, the auth
boundary, and the webhook signature round-trip over real HTTP. If this fails,
stop here — the phone call cannot work either.

The checker resets state first, so you can run it as often as you like.

### 3. Expose the port

```bash
cloudflared tunnel --url http://localhost:3001
```

(`brew install cloudflared`, or use `ngrok http 3001`.) Copy the HTTPS URL.
Retell requires HTTPS, which is why a plain port forward will not do.

### 4. Point a *throwaway* Retell agent at it

Generate the tool config with the tunnel host swapped in:

```bash
npm run retell:tools -- --base-url https://<your-tunnel-host>
```

That writes `retell/generated/tools.local.json` (gitignored — a tunnel URL can
never be committed by accident). In Retell:

1. **Duplicate your existing agent.** Never edit the live one for this.
2. Import or paste the eight tools from the generated file.
3. Paste `retell/system-prompt.txt` as the system prompt.
4. Add an agent-level **dynamic variable** `tool_auth_secret`, set to the
   `x-tool-auth` value from the banner. The tool headers reference it as
   `{{tool_auth_secret}}`, so the secret itself never lives in a file.
5. Confirm each tool sends `x-retell-call-id: {{call_id}}`, and that
   `find_appointment`, `reschedule_appointment` and `cancel_appointment` also
   send `x-retell-caller-phone: {{user_number}}`.
6. Point the agent's webhook at `https://<tunnel-host>/retell/webhook` and set
   the signing secret to the webhook secret from the banner.

### 5. Call it

Use Retell's test call, or assign a test number and dial from the seeded demo
number. To use your own mobile instead, restart with:

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

`npm run local:check` should still be 20/20, now with real slot reservations,
idempotency claims and rate-limit counters. **This path has not been verified
yet** — the Docker daemon was not running when it was written, so treat the first
run as a test of the setup itself.

### Phase 0 exit criteria

You have heard the agent book, reschedule and cancel over a real phone call; the
tool log shows the expected sequences; and no real calendar or spreadsheet was
involved. Only then continue.

---

## Phase 1 — staging on AWS

1. **Rotate the exposed Google service-account key** in Google Cloud first.
   Create the new key, then disable and delete the old one. Everything below
   assumes the old key is dead.
2. Create a **staging Google calendar and a staging spreadsheet**, separate from
   the clinic's. Put their IDs into `infra/environments/staging.json`. The
   renderer refuses to build staging while the `REPLACE_WITH_*` sentinels remain,
   and refuses outright if you point it at the production calendar or spreadsheet.
3. Deploy the stack:
   ```bash
   aws cloudformation deploy \
     --template-file infra/cloudformation/voice-agent-core.yml \
     --stack-name ai-receptionist-staging \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides EnvironmentName=staging CreateGitHubOidcProvider=yes
   ```
   Expect to iterate — this template has never been submitted to AWS.
4. Put the staging Google credential, Retell signing key and Resend key into the
   secret containers the stack created. The tool and appointment-token secrets
   were generated by CloudFormation; you never need to see them.
5. Create the `ai-receptionist-staging` ECS cluster and an
   `ai-receptionist-backend` service on it.
6. Set `AWS_DEPLOY_ROLE_ARN` and `SERVICE_BASE_URL` as variables on the GitHub
   `staging` environment, from the stack outputs.
7. Run the deploy workflow with `target: staging`. The quality gate runs build,
   118 tests, the offline harness and an audit before anything ships, and the
   post-deploy smoke test asserts the auth boundary is closed.
8. Repoint the throwaway Retell agent from the tunnel to the staging host and
   repeat the Phase 0 call script. Check that appointments land in the *staging*
   calendar and spreadsheet.

---

## Phase 2 — production

1. Deploy the production stack (`EnvironmentName=production`,
   `CreateGitHubOidcProvider=no` — the provider is account-global).
2. Store the production secrets. Set the `production` GitHub environment
   variables and **require yourself as a reviewer**.
3. Add the three headers to the **live** Retell agent, and set its
   `tool_auth_secret` dynamic variable — while the currently deployed backend
   still ignores them. Getting this order wrong breaks every live call.
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
| every tool call returns 401 | `tool_auth_secret` missing or wrong on the Retell agent |
| lookup returns 403 `CALLER_VERIFICATION_REQUIRED` | `x-retell-caller-phone: {{user_number}}` not set, or you are calling from a different number than the booking |
| lookup returns 409 `AMBIGUOUS_APPOINTMENT` | several confirmed appointments on that number — the agent must ask for the original date and exact time |
| reschedule/cancel returns 404 "Verified appointment not found" | the selection token is missing, expired (10 min), or bound to another caller |
| webhook returns 401 | signing secret mismatch, clock skew over 5 minutes, or Retell's signature scheme differs from the implementation — see below |
| tools return 503 | the coordination table is unreachable. Intentional: fail closed rather than risk a double booking |
| service starts then dies in production | `assertProductionSecurityConfig` refused to boot. Check the three secrets are ≥32 chars and `COORDINATION_TABLE` is set. Do not weaken this check |

**The webhook scheme is the one genuine unknown.** The implementation expects
`x-retell-signature: v=<ms-timestamp>,d=<sha256-hex>` with the HMAC computed over
`rawBody + timestamp`. `npm run local:check` proves the implementation is
internally consistent — it accepts a correctly signed body and rejects a tampered
one — but only a real Retell webhook confirms the scheme matches theirs. Verify
this in Phase 0 or 1. A mismatch fails closed (401), so it is an outage risk, not
a security hole.

---

## Still owed

- Independent review. Nothing on this branch has been reviewed by a second agent
  or a human. When Codex quota returns, review `a5e2cbf..HEAD`.
- The CloudFormation template and the DynamoDB Local path are unverified against
  the real services.
- 4 moderate `googleapis` advisories remain; 0 high, 0 critical.
