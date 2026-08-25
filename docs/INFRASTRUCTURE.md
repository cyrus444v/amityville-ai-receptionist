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

## Current AWS reality

Read-only discovery against account **668764275927**, region **us-east-1**, on
19 August 2026, as `arn:aws:iam::668764275927:user/aivance-deploy`.

**The headline: nothing is serving traffic, and nothing here is protecting a live
caller.** The premise this project has been carrying — "something already serves
`api.amityvillewellness.com`, so there is a cluster, a service, a load balancer
and a certificate somewhere" — is false. There is no load balancer, and the
hostname does not exist in DNS. That removes the cutover risk from going live: the
first production deploy is a first deploy, not a replacement.

### What exists

| Resource | Value | Notes |
|---|---|---|
| ECS cluster | `ai-receptionist` | the **only** cluster; `-staging` / `-production` do not exist |
| ECS service | `ai-receptionist-backend` | FARGATE, desired 1, running 1, steady since 22 Jul 2026 |
| Task definition | `ai-receptionist-backend:17` | image tag `booking-fix-20260521143407` |
| ECR repository | `ai-receptionist-backend` | **tag mutability: MUTABLE** |
| Target group | `ai-receptionist-tg` | port 8080, target-type `ip`, health path `/`, **`LoadBalancerArns: []`** |
| Load balancers | **none** | `describe-load-balancers` returns an empty list, not a permission error |
| VPC | `vpc-013d30115da21e448` | the account's default VPC, `172.31.0.0/16` |
| Subnets | `subnet-0af34467789fd745e` (us-east-1a), `subnet-07e1fa6100fc4d8c6` (us-east-1b) | both public, `MapPublicIpOnLaunch: true` |
| Security group | `sg-0bba5f8de99ff08d7` | attached to the running task |
| IAM roles in use | `ecsTaskExecutionRole`, `ecsTaskRole` | generic names, not the `<svc>-<env>-*` roles the template creates |
| Log group | `/ecs/ai-receptionist-backend` | not the `/ecs/<svc>-<env>` the template creates |
| Secrets in use | `ai-receptionist/GOOGLE_CREDENTIALS_BASE64`, `ai-receptionist/RESEND_API_KEY` | by reference, no plaintext in the task definition |
| DNS | `amityvillewellness.com` → GoDaddy (`ns37/ns38.domaincontrol.com`), apex and `www` → `46.224.24.118` | **not Route53**; there is no `api` record at all |

### What that means

1. **The running service is orphaned.** Its target group has no load balancer, so
   nothing routes to it, and `api.amityvillewellness.com` is NXDOMAIN. The task is
   running and costing money while being unreachable.

2. **The running service is pre-security-baseline.** Its task definition declares
   13 environment variables and 2 secrets. Absent: `TOOL_AUTH_SECRET`,
   `APPOINTMENT_TOKEN_SECRET`, `RETELL_WEBHOOK_SECRET`, `COORDINATION_TABLE`,
   `ALLOWED_ORIGINS`, `RATE_LIMIT_*`, `TRUST_PROXY_HOPS`, `TENANT_CONFIG_JSON` —
   that is, every control the current code depends on, and the tenant
   configuration the current code refuses to boot without. It cannot be updated in
   place to the current image; it needs the new task definition.

3. **The deploy workflow points at clusters that do not exist.**
   `.github/workflows/deploy.yml` names `ai-receptionist-staging` and
   `ai-receptionist-production`. Neither is there. This is Phase B item 2 and it
   is now a decision, not an unknown — see below.

4. **DNS is at GoDaddy, so Route53 is not in the path.** The `api` record will be
   a CNAME created at GoDaddy pointing at the ALB's DNS name, and the ACM
   certificate will have to be DNS-validated by adding a CNAME there too.
   `shared-alb.yml` creates no Route53 records; it only outputs the ALB DNS name
   and canonical hosted-zone ID, which stay useful if the domain ever moves.

5. **The default VPC's two public subnets are usable as they are.** They span
   us-east-1a and us-east-1b, which satisfies the ALB's two-AZ requirement, and
   they let the Fargate task keep `AssignPublicIp: ENABLED` so no NAT gateway is
   needed. Concretely: `VpcId=vpc-013d30115da21e448`,
   `PublicSubnetIds=subnet-0af34467789fd745e,subnet-07e1fa6100fc4d8c6`,
   `TaskSubnetIds=` the same two.

### What the discovery could not see

The `aivance-deploy` key is a **deploy-time** identity — ECR push and ECS update —
not an infrastructure-provisioning one. It was denied:

| Action | Consequence |
|---|---|
| `acm:ListCertificates` | cannot confirm whether a certificate for `api.amityvillewellness.com` exists. One is required before the ALB can serve HTTPS. |
| `route53:ListHostedZones` | moot — DNS is at GoDaddy |
| `dynamodb:ListTables` | cannot confirm whether any `*-coordination` table already exists |
| `secretsmanager:ListSecrets` | cannot enumerate secrets; two are known from the task definition |

Deploying either CloudFormation stack needs far more than this key has —
`iam:CreateRole`, `elasticloadbalancing:*`, `dynamodb:CreateTable`,
`secretsmanager:CreateSecret`, `ecs:CreateService`. **Phase B steps 3 and 4 cannot
run with this credential.**

### Discovery completed (19 August 2026, as account root via CloudShell)

The four calls the `aivance-deploy` key was denied were run as the account root
identity (`arn:aws:iam::668764275927:root`) from AWS CloudShell:

- `dynamodb list-tables` -> **no tables exist**. There is no
  `ai-receptionist-coordination`; the stacks create the `*-coordination` tables
  fresh, so there is nothing to migrate and the coordination-table cutover note
  below does not apply to this first launch.
- `secretsmanager list-secrets` -> exactly the two known old-schema secrets,
  `ai-receptionist/GOOGLE_CREDENTIALS_BASE64` and `ai-receptionist/RESEND_API_KEY`.
- `acm list-certificates` -> a certificate for `api.amityvillewellness.com`
  already exists and is **ISSUED**
  (`arn:aws:acm:us-east-1:668764275927:certificate/83bc0bfa-2a49-486b-bf8a-f8f56c6bdd8e`),
  single-domain (SAN = `api.amityvillewellness.com` only), AMAZON_ISSUED, not yet
  attached to any load balancer. It is reused for production. A separate staging
  certificate for `api-staging.amityvillewellness.com` was requested
  (`arn:aws:acm:us-east-1:668764275927:certificate/68ffef65-1b24-4006-90f0-e6973f0b4d55`,
  DNS validation via GoDaddy).

Because the working identity is account root, the Phase-B provisioning policy in
`infra/iam/README.md` was **not** attached: root already exceeds it, so there is
no temporary elevation to detach afterwards. The exposed `aivance-deploy` access
key `AKIAZXNLVATL5LCGWPXQ` was **deactivated and then deleted**; that user now has
no access keys.

### Decisions taken on these findings (19 August 2026)

1. **Two new clusters**, `ai-receptionist-staging` and `ai-receptionist-production`.
   ECS clusters cost nothing, `deploy.yml` and `tenant-service.yml` already name
   them, and mixing both environments into one cluster would weaken exactly the
   separation the rest of this architecture is built on. Because nothing is live
   there is no migration: the stale `ai-receptionist` cluster, its unreachable
   service and the orphaned target group get deleted afterwards. **No code change
   was needed** — the workflow already pointed at these names, and the stack
   creates the service as `${ServiceName}-backend`, which matches.

2. **The clinic has no working phone agent right now.** So this is a first launch,
   not a cutover. Nothing to keep alive, no callers to drop, no rollback target.
   `agent/tools.json` points at `api.amityvillewellness.com`, which does not
   resolve, so any Retell agent still configured from it is non-functional; the
   hostname has to be created before a test call can work at all.

3. **The `aivance-deploy` key gets temporary provisioning rights** rather than a
   second IAM user. The exact policy, why each statement exists, and the commands to
   attach and later detach it are in `infra/iam/README.md`. It is elevation of a
   long-lived key that has been exposed in an agent transcript, so detaching it and
   rotating the key are part of finishing Phase B, not optional follow-ups.

### Cleanup this discovery identified

Not urgent, but all of it is waste or a hazard:

- the orphaned `ai-receptionist-tg` target group;
- the unreachable `ai-receptionist-backend` service and its running task;
- ECR tag mutability is `MUTABLE`, so a tag can be overwritten to point at
  different code. The renderer already refuses mutable tag *names* like `latest`,
  but setting the repository to `IMMUTABLE` closes the same hole at the registry;
- the `ai-receptionist/<NAME>` secrets, once the `<svc>/<env>/<NAME>` set exists.

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

## Offline template review (24 August 2026)

Neither template has been submitted to AWS yet, so this is what a close read
found before spending a round-trip on the account. It does not replace
`aws cloudformation validate-template` — it only means the obvious rejections are
already gone.

**Two changes made**, one of them smaller than it first looked.

- `shared-alb.yml` set `idle_timeout.timeout_seconds` from `Ref: IdleTimeoutSeconds`,
  a `Number` parameter, and `deletion_protection.enabled` from a `FindInMap` onto an
  unquoted YAML boolean, where the property is typed `String`. Both are now explicit
  strings (`Fn::Sub`, quoted mapping values). **This is hardening, not a bug fix, and
  the account proves it:** the staging ALB stack was created from the pre-fix template
  on 19 August 2026 and CloudFormation accepted it. The live attributes read back
  `idle_timeout.timeout_seconds = 60` and `deletion_protection.enabled = false`, so
  CloudFormation coerced both. The explicit strings say what the property actually
  wants, and `tests/infra/cloudformation.spec.ts` keeps them from drifting back.
- `tenant-service.yml` gave the ECS service `Cluster: { Ref: ClusterName }` — a
  parameter, so a plain string. With `CreateCluster=yes` that leaves no edge in the
  dependency graph between the cluster and the service, and a single pass that both
  creates the cluster and has a `BootstrapTaskDefinitionArn` can attempt the service
  first. It is now `Fn::If [ShouldCreateCluster, Ref Cluster, Ref ClusterName]`, so
  the dependency exists exactly when this stack owns the cluster. This one never
  fired in the staging run only because pass 1 was deliberately made with an empty
  `BootstrapTaskDefinitionArn`, which skips the service resource entirely.

**Watch-items.** No code change; each is a judgement call at deploy time.

1. **Certificate used twice.** If the shared listener's `DefaultCertificateArn` is
   the same ARN a clinic then attaches via `ListenerCertificate`, the second
   attachment is at best a no-op. For a single-clinic environment, consider giving
   the listener the clinic certificate as its default and skipping the per-tenant
   one, or watch that resource specifically in the first staging run.
2. **Secret ARNs were partial — and it did not work.** This was listed here as a
   tolerable sharp edge on the theory that Secrets Manager resolves partial ARNs.
   The first staging deploy disproved it: task definition revision `:1` built
   `…:secret:ai-receptionist/<env>/<NAME>` without the six-character random suffix
   and the task could not start. `infra/render.mjs` now appends the real suffixes
   via `applySecretArnSuffixes()`, read from a `secretArnSuffixes` block in the
   environment file, so the rendered `valueFrom` matches the execution role's
   `read-service-secrets` resources character for character. Staging revision `:2`
   carries the full ARNs; **revision `:1` is broken and must never be referenced.**

   The guard is opt-in per environment. `amityville-wellness.production` and both
   `riverside-physio` environments still render suffix-less ARNs and will fail the
   same way on their first deploy. Record each environment's real suffixes (from the
   stack's `*SecretArn` outputs) before deploying it.
3. **No ECR repository in the tenant stack.** It creates everything else a clinic
   owns, but the image repository is assumed to exist. True for clinic #1
   (`ai-receptionist-backend`); a second real clinic needs its repository created
   before its first deploy, or the `DeployRole`'s scoped ECR permission points at
   nothing.
4. **Target group name ceiling.** `${ServiceName}-${EnvironmentName}-tg` must stay
   within 32 characters. `ai-receptionist-production-tg` is 29. `ServiceName`'s own
   pattern allows 41, so a long clinic slug fails at create time, not at validate
   time.
5. `containerInsights: enabled` on each cluster is a real CloudWatch line item for a
   service that is idle most of the day.
6. The GitHub OIDC `ThumbprintList` is the legacy value. IAM no longer verifies
   thumbprints for `token.actions.githubusercontent.com`, so it is harmless — but it
   is not doing anything either.

**Names verified consistent across the templates, the task definition and the
workflow.** `SERVICE` is `ai-receptionist` in both `amityville-wellness` environment
files, which matches the `ServiceName` parameter default, so the roles, the
`/ecs/ai-receptionist-<env>` log group, the `ai-receptionist/<env>/*` secret paths
and the `ai-receptionist-<env>-coordination` table the task definition references are
exactly the ones the stack creates. The container name `ai-receptionist-backend`
matches both `CONTAINER_NAME` in `deploy.yml` and `LoadBalancers.ContainerName` in the
stack; the ECR repository matches `ECR_REPOSITORY` and the `DeployRole`'s scoped
resource. Both deploy jobs declare `environment: staging|production`, which is what
the OIDC trust policy's `sub` claim requires — without it the role assumption fails.
The new target group names do not collide with the orphaned `ai-receptionist-tg`, so
the cleanup can happen before or after the launch.

## Deploying

**Build the image for `linux/amd64`.** Fargate runs amd64 here, and a plain
`docker build` on an Apple Silicon machine produces an arm64-only manifest that ECS
refuses with `CannotPullContainerError: image Manifest does not contain descriptor
matching platform 'linux/amd64'`. The task never starts and the reason looks nothing
like a build problem. Always pass the flag:

```bash
docker build --platform linux/amd64 -t <registry>/<svc>-backend:<sha> .
```

The GitHub Actions runner is amd64, so the deploy workflow is unaffected — this bites
only when bootstrapping by hand from a developer machine.


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

`agent/tools.json` previously declared no headers, so after the auth boundary
went live every tool call would have returned 401 mid-conversation. Each tool now
declares:

| Header | Value | Purpose |
|---|---|---|
| `x-tool-auth` | `{{tool_auth_secret}}` | versioned tool credential |
| `x-call-id` | `{{call_id}}` | shared rate limiting per call, not per Retell IP |
| `x-caller-phone` | `{{user_number}}` | verified caller number; only on `find_appointment`, `reschedule_appointment`, `cancel_appointment` |

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
