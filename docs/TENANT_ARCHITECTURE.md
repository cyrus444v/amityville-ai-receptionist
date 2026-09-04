# Selling this to many clinics

Goal: onboard a new clinic in under an hour, without touching application code,
and without any clinic ever being able to see another clinic's patient data.

## The decision: one deployment per tenant, one image, shared load balancer

There are two ways to serve many clinics. This codebase should take the first.

**Per-tenant deployment (chosen).** One ECS service per clinic, one coordination
table per clinic, one set of secrets per clinic, one voice agent per clinic. The
same container image everywhere; the clinic's identity, hours and services arrive
as configuration. Isolation is structural — a bug in tenant resolution cannot
leak records across clinics, because the process only ever holds one clinic's
credentials.

**Single multi-tenant service (rejected).** One service resolving the clinic per
request. Cheaper to run, but every request path becomes a place where the wrong
`tenant_id` discloses somebody's medical appointment. For protected health
information, at this team size, that trade is not worth it.

The cost objection to per-tenant deployment is the load balancer, not the
compute. Solve it by sharing one ALB across all tenants with host-based listener
rules: one ALB for the whole business, one target group and one listener rule per
clinic, `api.<clinic>.<yourdomain>` or the clinic's own hostname. Fargate compute
for an idle voice backend is small; the ALB is the fixed cost and it amortises.

```
                       ┌──────────── shared ALB (one, for all clinics) ─────────┐
 api.amityville…  ─────┤ host rule → target group → ECS service (amityville)   │
 api.clinic-b…    ─────┤ host rule → target group → ECS service (clinic-b)     │
                       └───────────────────────────────────────────────────────┘
   each service: its own coordination table, its own secrets, its own
   Google calendar + spreadsheet, its own voice agent
```

## What is tenant-specific today, and where it is wrong

Recon of the current tree:

| Concern | Where it lives now | Problem |
|---|---|---|
| Business hours | ~~hardcoded in `src/config/index.ts:73-81`~~ → `tenants/<slug>.json` | fixed |
| Services catalogue | ~~`src/knowledge/services.json`~~ → `tenants/<slug>.json` | fixed; the bundled file is deleted |
| Clinic name | `BUSINESS_NAME` env, now falling back to the tenant file | fixed; no clinic-specific default remains |
| Email footer | ~~hardcoded in `src/services/email.ts:130`~~ → `tenant.email.footer_locality` | fixed |
| Phone / address / website | env vars | already fine |
| Timezone, duration | env vars | already fine |
| System prompt | `agent/system-prompt.template.txt` + `tenant.prompt` | fixed; 16 placeholders, not 4 — see "Where this plan was wrong" |
| Calendar / spreadsheet IDs | env vars | already fine |

The refactor was hours, services, name defaults, the email footer — and, once the
prompt was actually read line by line, considerably more of the prompt than this
table originally claimed.

## Target shape

One file per clinic, `tenants/<slug>.json`, holding everything clinic-specific.
`tenants/amityville-wellness.json` is clinic #1, with the real values extracted
from the code. `tenants/riverside-physio.json` is the reference second clinic:
fictional, unusable for deployment (its Google IDs are placeholders), and
deliberately unlike clinic #1 in timezone, opening days, services and duration —
it exists so the suite can prove none of that is still in the code.

At runtime the container receives that file's contents as a single
`TENANT_CONFIG_JSON` environment variable, injected into the task definition by
`infra/render.mjs`. That keeps **one image for all clinics** — no per-tenant
build, no per-tenant image tag, and a rollback is the same artifact everywhere.

`src/config/tenant.ts` parses and validates it with Zod at boot. There is no
default and no fallback, in any environment: a process that cannot resolve a
clinic refuses to start. In production it must additionally arrive as
`TENANT_CONFIG_JSON` rather than off the filesystem, because the image ships
`dist/` only and a file-resolved clinic there means the container is reading
something it should not be. Resolution order, first hit wins:

| | |
|---|---|
| `TENANT_CONFIG_JSON` | the deployed path — the file's contents, injected |
| `TENANT_CONFIG_PATH` | an explicit file, for an ad-hoc local run |
| `TENANT_SLUG` | reads `tenants/<slug>.json` — the convenient local form |

## Refactor steps — done

All ten are implemented. Verified at the end of the phase: `npm run test:ci`
232 tests, `npm run harness` 19, static eval 48/48, transcript eval 48/48, and
`npm run local:check` 22/22 against a live server for **each** of two clinics.

Four things turned out differently from the plan below. Each is marked *deviation*
in place, and the reasoning is in "Where this plan was wrong" at the end.

Each step left `npm run test:ci`, `npm run harness` and
`npm run local:check` green.

1. ✅ **`src/config/tenant.ts` (new)** — Zod schema for the tenant file, loader
   reading `TENANT_CONFIG_JSON` (preferred), `TENANT_CONFIG_PATH` or
   `TENANT_SLUG`. Exports `tenant`. *Deviation: no dev-only fallback.* Validate: hours cover all seven days,
   `open`/`close` are `HH:MM`, a closed day needs no valid range, at least one
   service, every `service_id` unique, timezone parses under dayjs.
2. ✅ **`src/config/index.ts`** — `config.business` now reads from `tenant`. Delete
   the hardcoded `businessHours` block. Keep the env vars as overrides so nothing
   currently deployed changes behaviour. Extend
   `assertProductionSecurityConfig()` to require a valid tenant config in
   production.
3. ✅ **`src/services/knowledge.ts`** — reads services from `config.services`.
   `src/knowledge/services.json` is deleted: it was byte-identical to the tenant
   file's `services`, verified before removal, and a bundled catalogue is exactly
   what "one image for all clinics" cannot have.
4. ✅ **`src/services/email.ts`** — footer locality, from-name, from-address and
   reply-to come from the tenant. `renderConfirmationEmail()` was split out as a
   pure function so a clinic's rendered mail can be asserted without sending.
5. ✅ **`agent/system-prompt.template.txt` (new)** — *deviation: sixteen
   placeholders, not five.* The prompt was far more clinic-specific than this plan
   assumed. `agent/system-prompt.txt` is unchanged, and
   `tests/unit/system-prompt.spec.ts` asserts the template plus the tenant file
   reproduce it **byte-for-byte** — which is what keeps the static eval's six
   prompt invariants passing, rather than re-checking them by hand.
6. ✅ **`scripts/render-agent.mjs` (new)** — `--tenant <slug>` plus either
   `--env <environment>` or `--base-url`, emitting `tools.json` and the rendered
   prompt into `agent/generated/<slug>/`. The URL rewriting it shares with
   `agent-tools-for.mjs` moved to `scripts/lib/agent-tools.mjs`, including the
   refusal to inline a secret for anything but a throwaway host. It refuses an
   unfilled `REPLACE_WITH_*` host rather than emitting an agent that fails every
   call.
7. ✅ **`infra/environments/`** — keyed as `<slug>.<environment>.json`, each
   carrying a `tenant` field. The renderer injects `TENANT_CONFIG_JSON` from
   `tenants/<slug>.json` *after* substitution, not through it: the clinic's
   configuration is itself JSON, and pushing it through a text substitution into a
   JSON template is an escaping accident waiting to happen. *Deviation: the
   coordination table and secret namespace stay keyed on `SERVICE`, not on the
   slug.* Every existing guard is kept, and the isolation guard is now **derived**
   rather than remembered: a non-production environment automatically forbids
   whatever its own production file points at, so a newly onboarded clinic cannot
   forget to copy its calendar ID into `forbiddenValues`.
8. ✅ **`infra/cloudformation/`** — split into `shared-alb.yml` (one per
   environment: ALB, HTTPS listener with a 404 default, HTTP→HTTPS redirect) and
   `tenant-service.yml` (per clinic: coordination table, secrets, roles, log
   group, target group, listener rule, listener certificate, task security group,
   ECS service). Each clinic attaches **its own** certificate to the shared
   listener, so clinics on different domains share one balancer. Neither template
   has been submitted to AWS — both say so in their `Description`, and
   `tests/infra/cloudformation.spec.ts` now parses them and resolves every `Ref`,
   `Fn::GetAtt` and `Fn::Sub` name, which no check did before.
9. ✅ **`scripts/new-tenant.mjs` (new)** — a flags interface; the builders live in
   `lib/scaffold-tenant.mjs` so the suite validates a scaffolded clinic against
   the real Zod schema and the real renderer without writing files. Google IDs are
   left as `REPLACE_WITH_*` on purpose: the renderer refuses to build while one
   remains, so a clinic cannot be deployed pointing at another clinic's calendar.
   It refuses to overwrite an existing clinic without `--force`.
10. ✅ **`tests/`** — `tenant-config.spec.ts` (schema rejections, resolution
    order, every file in `tenants/` validated, the scaffolder's output validated,
    the production fail-closed guard), `tenant-neutrality.spec.ts` (no clinic
    identity under `src/`), `system-prompt.spec.ts` (byte-for-byte reproduction,
    and the prompt's advertised hours cross-checked against what `booking.ts`
    actually enforces), and `tests/harness/second-tenant.spec.ts` — the second
    clinic booting the same app and serving the whole flow as itself.

## Acceptance criteria for "sellable"

- No literal `Amityville`, `amityvillewellness`, `631-691` or `Broadway` anywhere
  under `src/`.
- A second tenant fixture boots the app, serves the tool flow, and reports its
  own hours, services and email footer — verified by a test, not by inspection.
- `npm run local:check` passes against a second tenant with different hours.
- One image, one tag, two tenants, no rebuild.
- Onboarding a clinic is: run `new-tenant`, fill in the Google IDs, deploy the
  tenant stack, provision the voice agent, place a test call.

## Where this plan was wrong

1. **A dev-only Amityville fallback was a bad idea.** Step 1 originally called for
   one. It would have put the literal `Amityville` back into `src/`, breaking this
   document's own acceptance criterion, and it reproduces exactly the failure this
   document identifies for `BUSINESS_NAME`: *"a missing env var silently brands
   another clinic as Amityville."* There is no default anywhere. Every entry point
   names the clinic it serves — `tests/setup.ts`, `harness/local-server.ts` and
   `.env.example` — and a process with no tenant configuration refuses to start,
   in development as well as in production.

2. **The coordination table and secret namespace stay keyed on `SERVICE`.** Step 7
   called for `<slug>-<env>-coordination`. For clinic #1 that renames a DynamoDB
   table and a Secrets Manager namespace that **already exist in AWS** as
   `ai-receptionist/*` — work Phase B would then have to undo. `SERVICE` remains
   the infrastructure identity; `new-tenant` sets `SERVICE = <slug>` for every
   clinic onboarded afterwards, so new clinics do get slug-named resources. Same
   end state, no rename of live infrastructure.

3. **The system prompt was much more clinic-specific than "only 4 mentions".** The
   real inventory: the clinic name twice, the address, the website, the provider's
   name, the hours block, a thirteen-line spoken services list that does *not*
   match `services[]`, the lead-priority list, a **second phone number**
   (`631.532.8548`) buried in the new-patient policy, and acupuncture-specific
   insurance and objection copy. So the tenant file gained a `prompt` section of
   clinic-authored blocks. The template keeps the reusable machinery: the four
   flows, the tool rules, the one-question rule, the emergency escalation.

4. **Two files outside `src/` also carried clinic #1's week**, and the acceptance
   criteria depended on them. `harness/local-server.ts` hardcoded
   `openWeekdays = [2, 3, 5, 6]`, and `scripts/local-check.mjs` hardcoded the
   times `15:00`/`16:00`/`13:00` and the service `Acupuncture`. Both now derive
   from the clinic: the local server from its tenant, and the checker from
   `/clinic-info` and `/services` on the running server. Until that changed,
   "local:check passes against a second tenant with different hours" was
   unreachable.

One observation, out of scope and left alone: `searchServices` matches keywords by
substring in **both** directions, so a caller asking about "microneedling" also
matches a clinic offering "dry needling". That behaviour predates this phase and
affects clinic #1 identically; changing search semantics is not a tenant refactor.

## What this deliberately does not solve

Billing, a customer-facing admin UI, per-tenant analytics, and prompt
customisation beyond the templated fields. All of those can sit on top of the
tenant file later. Get one clinic live first.
