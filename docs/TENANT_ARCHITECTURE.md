# Selling this to many clinics

Goal: onboard a new clinic in under an hour, without touching application code,
and without any clinic ever being able to see another clinic's patient data.

## The decision: one deployment per tenant, one image, shared load balancer

There are two ways to serve many clinics. This codebase should take the first.

**Per-tenant deployment (chosen).** One ECS service per clinic, one coordination
table per clinic, one set of secrets per clinic, one Retell agent per clinic. The
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
   Google calendar + spreadsheet, its own Retell agent
```

## What is tenant-specific today, and where it is wrong

Recon of the current tree:

| Concern | Where it lives now | Problem |
|---|---|---|
| Business hours | **hardcoded in `src/config/index.ts:73-81`** | cannot be changed without a code edit and redeploy |
| Services catalogue | `src/knowledge/services.json`, statically imported by `src/services/knowledge.ts:1` | baked into the bundle at build time |
| Clinic name | `BUSINESS_NAME` env, with `'Amityville Acupuncture'` as the default in two places | a missing env var silently brands another clinic as Amityville |
| Email footer | **`'Amityville, NY'` hardcoded in `src/services/email.ts:130`** | wrong locality in every other clinic's confirmation mail |
| Phone / address / website | env vars | already fine |
| Timezone, duration | env vars | already fine |
| System prompt | `retell/system-prompt.txt`, 277 lines, only 4 clinic-specific mentions | mostly reusable; needs 4 placeholders plus the services list |
| Calendar / spreadsheet IDs | env vars | already fine |

So the refactor is small and well-bounded: hours, services, name defaults and the
email footer. Everything else is already configuration.

## Target shape

One file per clinic, `tenants/<slug>.json`, holding everything clinic-specific.
`tenants/amityville-wellness.json` is already written with the real values
extracted from the code above — use it as the reference shape.

At runtime the container receives that file's contents as a single
`TENANT_CONFIG_JSON` environment variable, rendered into the task definition by
`infra/render.mjs`. That keeps **one image for all clinics** — no per-tenant
build, no per-tenant image tag, and a rollback is the same artifact everywhere.

`src/config/index.ts` parses and validates it with Zod at boot and fails closed
in production if it is missing or malformed — same posture as
`assertProductionSecurityConfig()`. In development, absence falls back to the
current Amityville defaults so nothing breaks locally.

## Refactor steps

Each step must leave `npm run test:ci`, `npm run harness` and
`npm run local:check` green.

1. **`src/config/tenant.ts` (new)** — Zod schema for the tenant file, loader
   reading `TENANT_CONFIG_JSON` (preferred) or `TENANT_CONFIG_PATH`, plus a
   dev-only fallback. Export `tenant`. Validate: hours cover all seven days,
   `open`/`close` are `HH:MM`, a closed day needs no valid range, at least one
   service, every `service_id` unique, timezone parses under dayjs.
2. **`src/config/index.ts`** — `config.business` now reads from `tenant`. Delete
   the hardcoded `businessHours` block. Keep the env vars as overrides so nothing
   currently deployed changes behaviour. Extend
   `assertProductionSecurityConfig()` to require a valid tenant config in
   production.
3. **`src/services/knowledge.ts`** — read services from `tenant.services` instead
   of importing the JSON. Keep `src/knowledge/services.json` as the seed data
   used to build `tenants/amityville-wellness.json`, or delete it once the tenant
   file is the source of truth.
4. **`src/services/email.ts`** — footer locality and from-name come from the
   tenant; no literal `'Amityville'` anywhere in `src/`.
5. **`retell/system-prompt.template.txt` (new)** — the current prompt with
   `{{clinic_name}}`, `{{clinic_phone}}`, `{{clinic_address}}`,
   `{{business_hours}}`, `{{services}}` placeholders. Keep the rendered
   `retell/system-prompt.txt` for Amityville so the static eval's prompt
   invariants keep passing.
6. **`scripts/render-retell-agent.mjs` (new)** — given a tenant slug and a base
   URL, emit that clinic's `tools.json` and rendered system prompt into
   `retell/generated/<slug>/`. Extends the existing `retell-tools-for.mjs`.
7. **`infra/environments/`** — key files as `<slug>.<environment>.json`, each
   carrying a `tenant` field. The renderer injects `TENANT_CONFIG_JSON` from
   `tenants/<slug>.json`, names the coordination table
   `<slug>-<env>-coordination`, and scopes secrets to `<slug>/<env>/…`. Keep
   every existing guard, including the refusal to point a non-production
   environment at another environment's Google resources.
8. **`infra/cloudformation/`** — split into `shared-alb.yml` (one per account: ALB,
   HTTPS listener, ACM cert, Route53) and `tenant-service.yml` (per clinic:
   coordination table, secrets, roles, log group, ECS service, target group,
   listener rule). The current `voice-agent-core.yml` is most of the second file
   already; it is missing the compute and networking.
9. **`scripts/new-tenant.mjs` (new)** — scaffolds `tenants/<slug>.json` and both
   `infra/environments/<slug>.*.json` from a prompt or a flags interface, then
   prints the remaining manual steps. This is the "onboard in under an hour"
   entry point.
10. **`tests/`** — a tenant-config spec (valid config loads; missing days,
    bad times, duplicate service ids and an absent config in production all
    rejected), and a second tenant fixture proving no Amityville string survives
    in a rendered output.

## Acceptance criteria for "sellable"

- No literal `Amityville`, `amityvillewellness`, `631-691` or `Broadway` anywhere
  under `src/`.
- A second tenant fixture boots the app, serves the tool flow, and reports its
  own hours, services and email footer — verified by a test, not by inspection.
- `npm run local:check` passes against a second tenant with different hours.
- One image, one tag, two tenants, no rebuild.
- Onboarding a clinic is: run `new-tenant`, fill in the Google IDs, deploy the
  tenant stack, render the Retell agent, place a test call.

## What this deliberately does not solve

Billing, a customer-facing admin UI, per-tenant analytics, and prompt
customisation beyond the templated fields. All of those can sit on top of the
tenant file later. Get one clinic live first.
