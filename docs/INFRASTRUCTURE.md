# Voice-agent infrastructure

Everything the voice agent needs to run is now declared in this repository:
the coordination store, the IAM boundaries, the per-environment container
configuration, the deploy identity, and an offline harness that exercises the
whole call flow before anything is deployed.

Nothing in here provisions or deploys on its own. Every AWS, Retell, and GitHub
action below is an operator step that Cyrus runs deliberately.

## Topology

One shared load balancer per environment, and one stack per clinic per
environment behind it. Clinics share no state whatsoever — not a table, not a
secret, not a Google resource.

```
infra/cloudformation/shared-alb.yml         one stack per environment
  ├── ALB       voice-agent-<env>            internet-facing, one for all clinics
  ├── Listener  :443 HTTPS                   TLS 1.3 policy; default action is 404,
  │                                          never a forward to some other clinic
  └── Listener  :80  HTTP                    301 to HTTPS

infra/cloudformation/tenant-service.yml     one stack per clinic per environment
  ├── DynamoDB  <svc>-<env>-coordination     TTL on `ttl`, SSE, PITR+deletion protection in production
  ├── Logs      /ecs/<svc>-<env>             30d staging / 365d production
  ├── Secrets   <svc>/<env>/{TOOL_AUTH_SECRET, APPOINTMENT_TOKEN_SECRET,
  │             RETELL_WEBHOOK_SECRET, GOOGLE_CREDENTIALS_BASE64, RESEND_API_KEY}
  ├── IAM       <svc>-<env>-task-execution   may read exactly those five secrets
  ├── IAM       <svc>-<env>-task             may touch exactly that one table
  ├── IAM       <svc>-<env>-github-deploy    OIDC, scoped to one repo + one environment
  ├── TargetGrp <svc>-<env>-tg               health check on /health
  ├── Cert      this clinic's certificate, added to the shared listener
  ├── Rule      host-header <clinic hostname> → this clinic's target group
  ├── SecGroup  accepts :8080 from the load balancer's group only
  └── ECS       <svc>-backend on FARGATE, circuit breaker with rollback
```

`<svc>` is the `SERVICE` value in the clinic's environment file. Clinic #1 keeps
`ai-receptionist`, because its table, secrets and roles already exist in the
account under that name; `new-tenant` sets `SERVICE = <slug>` for every clinic
onboarded afterwards, so their resources are named after them.

**Neither template has ever been submitted to AWS.** Both say so in their
`Description`. `tests/infra/cloudformation.spec.ts` parses them and resolves every
`Ref`, `Fn::GetAtt` and `Fn::Sub` name against what the template declares, which
catches a misspelt reference offline — but it cannot tell you whether AWS accepts
the resource properties, and the VPC, subnet and certificate parameters still have
to come from the real account.

`TOOL_AUTH_SECRET` and `APPOINTMENT_TOKEN_SECRET` use CloudFormation's
`GenerateSecretString`, so those two values are minted inside AWS and never pass
through a terminal, a clipboard, a chat transcript, or an agent. The Google
credential, the Retell signing key, and the Resend key are created empty because
they come from outside AWS.

## Container configuration

`ecs-task-definition.json` is gone. It hardcoded production account IDs, the live
calendar, the live spreadsheet, a mutable `:latest` image tag, and a duplicated
`BUSINESS_NAME`, and it wired none of the new security variables.

It is replaced by a template plus a strict renderer:

```
infra/task-definition.template.json           shape, with ${PLACEHOLDER} values
infra/environments/<slug>.production.json     non-secret production values, per clinic
infra/environments/<slug>.staging.json        non-secret staging values, per clinic
tenants/<slug>.json                           the clinic itself: identity, hours, services, prompt
infra/render.mjs                              renders + validates
```

```bash
npm run infra:render -- --tenant amityville-wellness --env staging --image-tag "$(git rev-parse HEAD)"
```

The clinic's configuration is injected as a single `TENANT_CONFIG_JSON` variable
(~9.5 KB compact, well inside the task-definition limit), *after* placeholder
substitution rather than through it — the clinic file is itself JSON, and pushing
it through a text substitution into a JSON template is an escaping accident
waiting to happen. That injection is what keeps **one image for every clinic**: no
per-tenant build, no per-tenant tag, and a rollback is the same artifact
everywhere.

The renderer refuses to emit a definition that has an unresolved placeholder, a
mutable image tag, a leftover `REPLACE_WITH_*` sentinel, a duplicated
environment variable, a secret ARN from another environment, a coordination
table name that disagrees with the CloudFormation stack, or `NODE_ENV` set to
anything but `production`. Staging additionally refuses to start if it is
pointed at the production calendar or the production appointment spreadsheet —
a booking agent that writes rehearsal appointments into the live calendar is the
single most expensive mistake available here, so it is blocked in code. That
guard is **derived, not remembered**: a non-production environment automatically
forbids whatever its own clinic's production file points at, so a newly onboarded
clinic cannot forget to fill in `forbiddenValues`.

Three more refusals came with the multi-tenant work, all aimed at the same
mistake — a second clinic's files copied from the first and not fully edited:

- an environment file that does not name its clinic in a `tenant` field;
- an environment file whose `tenant` disagrees with the clinic file it is rendered against;
- a **production** `BUSINESS_NAME` that is not exactly the clinic's `display_name`,
  or a non-production one that does not even mention the clinic's short name. A
  clinic must not go live under another clinic's name.

`tests/infra/task-definition.spec.ts` covers each of those failure modes.

## Deploying

```bash
# once per environment
aws cloudformation deploy \
  --template-file infra/cloudformation/shared-alb.yml \
  --stack-name voice-agent-staging-alb \
  --parameter-overrides EnvironmentName=staging VpcId=<vpc> PublicSubnetIds=<subnet-a,subnet-b> \
                        DefaultCertificateArn=<acm-arn>

# once per clinic per environment
aws cloudformation deploy \
  --template-file infra/cloudformation/tenant-service.yml \
  --stack-name ai-receptionist-staging \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides EnvironmentName=staging CreateGitHubOidcProvider=yes \
                        TenantSlug=amityville-wellness HostName=<host> CertificateArn=<acm-arn> \
                        ListenerRulePriority=100 HttpsListenerArn=<from shared-alb> \
                        LoadBalancerSecurityGroupId=<from shared-alb> VpcId=<vpc> \
                        TaskSubnetIds=<subnet-a,subnet-b> ClusterName=<cluster>
```

Then the same command for `production` with `CreateGitHubOidcProvider=no` (the
provider is account-global; creating it twice fails).

Set `AWS_DEPLOY_ROLE_ARN` and `SERVICE_BASE_URL` as *variables* on each GitHub
environment from the stack outputs. Require a reviewer on `production`.

Deployment itself is the `Deploy to AWS ECS` workflow, run manually:

- `target: staging` deploys staging.
- `target: production` additionally requires typing `DEPLOY PRODUCTION` into the
  confirmation input, and runs in the protected `production` environment.
- Each job assumes its environment's role through OIDC. There are no
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` secrets anywhere in the workflow.
- The image is always tagged with the commit SHA, never a moving tag.
- After the service stabilises, `scripts/smoke.mjs` runs a credential-free,
  read-only probe: `/health` must answer 200, and `/current-date`,
  `/find-appointment` and `/retell/webhook` must all answer 401 to an anonymous
  caller. A deploy that leaves the tool boundary open fails here instead of
  quietly serving patient data. The smoke test never calls a write tool.

### Production coordination-table cutover

Production currently reads `ai-receptionist-coordination`; the stack creates
`ai-receptionist-production-coordination`. That table holds only short-lived
digests — slot reservations, idempotency claims, rate-limit counters, in-flight
mutation state — so there is nothing to migrate. But during the cutover two
tasks could briefly consult different tables, which weakens slot reservation for
the length of one deploy. Cut over while the clinic is closed. Idempotency and
rate limiting degrade harmlessly; double-booking is still caught by the
availability re-check against the real calendar.

## Retell agent surface

`retell/tools.json` previously declared no headers, so after the auth boundary
went live every tool call would have returned 401 mid-conversation. Each tool now
declares:

| Header | Value | Purpose |
|---|---|---|
| `x-tool-auth` | `{{tool_auth_secret}}` | versioned tool credential |
| `x-retell-call-id` | `{{call_id}}` | shared rate limiting per call, not per Retell IP |
| `x-retell-caller-phone` | `{{user_number}}` | verified caller number; only on `find_appointment`, `reschedule_appointment`, `cancel_appointment` |

These are Retell dynamic-variable templates. `tool_auth_secret` is set once as an
agent-level dynamic variable in the Retell dashboard, so the real secret stays
out of git. `tests/unit/retell-contract.spec.ts` enforces that every header value
remains a `{{template}}` — committing a literal credential fails the build — and
that every tool URL maps to a path the app actually protects.

**Rollout order matters.** Add the headers in Retell *while the current backend
still ignores them*, then deploy the enforcing build. The reverse order breaks
every live call.

## Offline voice harness

`npm run harness` boots the real Express app and drives all eight tools over
HTTP with the exact headers Retell sends. Only Sheets, Calendar, and the mailer
are replaced by in-memory doubles, so tool auth, rate limiting, idempotency,
validation, caller verification, appointment tokens, slot coordination, and
rollback all execute for real.

Covered flows: new-patient booking with sport/injury notes and referral source;
closed-day refusal; taken-slot alternatives; two-step verified reschedule;
verified cancellation; grounded service answer; callback fallback on a calendar
outage; and a cross-caller attack that is refused with zero mutation. It also
asserts an anonymous write is rejected, a token-less reschedule is rejected, and
a repeated `Idempotency-Key` produces exactly one appointment.

The run writes `harness/transcripts/voice-agent.jsonl`, which the pipeline
scores:

```bash
./bin/aivance-pipeline eval --transcripts \
  "<worktree>/harness/transcripts/voice-agent.jsonl"
```

**Scope, stated plainly.** The tool sequences, arguments, backend responses and
outcomes in those transcripts are real. The caller and agent utterances are
fixtures — there is no language model in this loop. Use the harness to prove
backend contract and authorization behaviour. It says nothing about how the live
agent speaks, so `medical_emergency` is deliberately not emitted, and
`prompt_injection` is emitted only as evidence that the backend refused a
cross-caller attempt.

## What still has to happen outside this repository

1. Rotate the exposed Google service-account key in Google Cloud.
2. Deploy the two CloudFormation stacks.
3. Put the Google, Retell and Resend secret values into Secrets Manager.
4. Fill in `infra/environments/amityville-wellness.staging.json` with a staging calendar ID and a
   staging spreadsheet ID. The renderer refuses to build staging until you do.
5. Create the staging ECS cluster/service (`ai-receptionist-staging`) and confirm
   the production cluster name matches `ai-receptionist-production`.
6. Configure the Retell agent headers and the `tool_auth_secret` dynamic variable.
7. Set the GitHub environment variables and the production reviewer.
8. Deploy staging, rehearse the full call flow against it, and only then deploy
   production.
