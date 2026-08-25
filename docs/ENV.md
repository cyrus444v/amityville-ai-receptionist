# Environment and production rollout

The service never supplies a production credential. Secrets must be generated and stored by an operator outside this repository. Do not copy `.env` files into the image or commit them.

## Runtime variables

| Variable | Required in production | Secret | Default / purpose |
|---|---:|---:|---|
| `NODE_ENV` | Yes | No | Set to `production`; production startup fails closed if tool auth is missing. |
| `PORT` | No | No | `3001`; HTTP listener port. |
| `TOOL_AUTH_SECRET` | Yes | Yes | Shared secret required on protected tool requests. Production requires at least 32 characters. Supply it in the configured header. |
| `TOOL_AUTH_HEADER` | No | No | `x-tool-auth`. Header name carrying `TOOL_AUTH_SECRET`. |
| `TOOL_AUTH_VERSION` | No | No | `v1`. Returned as `X-Tool-Auth-Version`; `/v1/...` is the canonical versioned route. Existing unversioned routes remain authenticated compatibility aliases. |
| `APPOINTMENT_TOKEN_SECRET` | Yes | Yes | Distinct high-entropy HMAC secret for short-lived, caller-bound appointment selection tokens. Production requires at least 32 characters. |
| `APPOINTMENT_TOKEN_TTL_MS` | No | No | `600000`. Appointment selection-token lifetime. |
| `TELEPHONY_CALLER_PHONE_HEADER` | No | No | `x-caller-phone`. Trusted header the call handler sets to the verified caller number for lookup, reschedule, and cancel tools. |
| `TELEPHONY_CALL_ID_HEADER` | No | No | `x-call-id`. Trusted header the call handler sets to the per-call id, used for shared rate limiting. |
| `COORDINATION_TABLE` | Yes | No | DynamoDB table used for atomic slot/callback claims, cross-task idempotency state, mutation state, and rate-limit counters. Partition key must be string `pk`; TTL attribute is `ttl`. |
| `COORDINATION_REGION` | No | No | `AWS_REGION` or `us-east-1`. Region containing the coordination table. |
| `ALLOWED_ORIGINS` | No | No | Empty. Comma-separated browser origins; requests without an `Origin` header remain allowed for server-to-server calls. Avoid `*` in production. |
| `REQUEST_BODY_LIMIT` | No | No | `32kb`. Express JSON body limit. |
| `RATE_LIMIT_WINDOW_MS` | No | No | `60000`. Shared limiter window. |
| `RATE_LIMIT_MAX` | No | No | `60`. Protected requests per verified call/caller per window. |
| `IDEMPOTENCY_TTL_MS` | No | No | `900000`. Lifetime of request-key replay responses. |
| `TRUST_PROXY_HOPS` | No | No | `1`. Number of trusted proxies in front of Express; verify against the load-balancer topology. |
| `GOOGLE_CREDENTIALS_BASE64` | Yes* | Yes | Base64 service-account JSON. Prefer this single secret. `*`The two variables below are the backward-compatible alternative. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Alternative | No | Service-account email when the base64 JSON is not used. |
| `GOOGLE_PRIVATE_KEY` | Alternative | Yes | Service-account private key when the base64 JSON is not used. |
| `GOOGLE_IMPERSONATE_EMAIL` | As configured | No | Workspace subject for domain-wide delegation. |
| `GOOGLE_CALENDAR_ID` | Yes | No | Calendar identifier; defaults to `primary`. |
| `GOOGLE_SPREADSHEET_ID` | Yes | No | Appointment/callback spreadsheet identifier. |
| `RESEND_API_KEY` | For email | Yes | Resend API credential; booking still works without email only when no email address is supplied. |
| `EMAIL_FROM` | For email | No | Confirmation sender address. |
| `EMAIL_REPLY_TO` | No | No | Reply-to address; defaults to `EMAIL_FROM`. |
| `TENANT_CONFIG_JSON` | **Yes** | No | The clinic's `tenants/<slug>.json`, injected verbatim by `infra/render.mjs`. Required in production: the image ships `dist/` only, so there is no tenant file on disk to fall back to. Carries identity, hours, services, email footer and the clinic-authored prompt sections. |
| `TENANT_CONFIG_PATH` | No | No | An explicit tenant file, for an ad-hoc local run. Ignored when `TENANT_CONFIG_JSON` is set. |
| `TENANT_SLUG` | No | No | Reads `tenants/<slug>.json`. The convenient local form. Refused in production. |
| `BUSINESS_NAME` | No | No | Overrides the clinic display name from the tenant file. No clinic-specific default: unset falls through to the tenant file. |
| `BUSINESS_PHONE` | No | No | Public clinic phone. |
| `BUSINESS_ADDRESS` | No | No | Public clinic address. |
| `BUSINESS_WEBSITE` | No | No | Public clinic website. |
| `TIMEZONE` | No | No | `America/New_York`. |
| `DEFAULT_APPOINTMENT_DURATION` | No | No | `60` minutes. |

`aws-setup.sh` additionally requires `GOOGLE_CREDENTIALS_BASE64_FILE`, `TOOL_AUTH_SECRET_FILE` and `APPOINTMENT_TOKEN_SECRET_FILE` to point to operator-owned readable files. It passes credential files directly to the AWS CLI and never prints their contents. `RESEND_API_KEY_FILE` is optional and handled the same way.

## Protected endpoints

Authentication applies to every voice tool, including current date, availability, appointment lookup and writes, callbacks, service search, and deep dependency diagnostics. Send `x-tool-auth: <secret>` unless `TOOL_AUTH_HEADER` is changed. `/v1` routes and legacy aliases enforce the same policy. Only `/`, `/health`, `/clinic-info`, and `/services` remain open and non-mutating. The service mounts no webhook route: telephony is handled in-process rather than by a third-party orchestrator calling back in.

Appointment lookup also requires the call handler to send the verified caller number in `x-caller-phone`. The supplied number must match the booked number. A unique match first returns only a short-lived `appointment_token`; a second lookup call must present that token before details are disclosed. Reschedule and cancellation require the same token and re-check it against the actual caller number. Ambiguous matches disclose no appointment details and must be narrowed by original date and exact time.

Write tools accept an optional `Idempotency-Key` header. Reusing a key with another body returns `409`; concurrent use returns a conflict instead of executing twice. Appointment and callback services also use atomic shared claims when the header is absent. Appointment claims cover every ten-minute segment in the requested interval, preventing overlapping bookings across ECS tasks. Rate counters and operation states use the same shared table. No patient name, phone number, notes, or response body is stored there; keys use SHA-256 digests.

## Production rollout order

1. Generate distinct high-entropy values for `TOOL_AUTH_SECRET` and `APPOINTMENT_TOKEN_SECRET` outside the repository. Do not paste any of them into an issue, command history, or tracked file.
2. Deploy `infra/cloudformation/shared-alb.yml` once per environment, then `infra/cloudformation/tenant-service.yml` per clinic per environment. It creates the coordination table (string partition key `pk`, TTL on `ttl`), the log group, the least-privilege task roles, the secret containers, and the OIDC deploy role. `aws-setup.sh` remains as the manual alternative; neither is run by this repository.
3. Have the call handler send `x-tool-auth`, `x-caller-phone` (the verified caller number) and `x-call-id` (the per-call id) on every tool request. Add and test the `find_appointment` flow.
4. Store the operator-supplied secret values in Secrets Manager under `ai-receptionist/<environment>/...`. The task definition is rendered from `infra/task-definition.template.json` plus `infra/environments/<slug>.<environment>.json` plus `tenants/<slug>.json` and references secrets by ARN only — see [INFRASTRUCTURE.md](INFRASTRUCTURE.md). `COORDINATION_TABLE` and `COORDINATION_REGION` are rendered automatically; never place a secret value in the task definition.
5. Append the `referral_source` header to column Q of the Appointments sheet. Existing rows may leave that trailing column empty.
6. Configure `ALLOWED_ORIGINS` without `*`, proxy hops, and rate limits for the production topology. Browser origins are not needed for server-to-server traffic.
7. Create or verify the GitHub `production` environment and require Cyrus (or another designated reviewer) for deployments.
8. Run the manual deployment workflow and approve the protected environment only after its quality job succeeds.
9. Smoke-test unauthenticated `/health` and authenticated read-only `/current-date` and lookup-miss calls. Do not use a write tool for the smoke test.

If authentication is misconfigured, fix the call handler and ECS secret references before redeploying. Production intentionally refuses to start without `TOOL_AUTH_SECRET`; do not weaken that check as a rollback.

The previously exposed Google credential still requires external rotation by Cyrus. This repository change neither rotates nor revokes it.
