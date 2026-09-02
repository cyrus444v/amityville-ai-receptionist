# Objective

Turn the current Amityville voice-agent backend into a deterministic, testable security baseline while preserving the current live behavior and Cyrus' uncommitted prompt/tool changes.

# Required fixes

1. Remove the embedded Google service-account payload from `aws-setup.sh`. Replace it with a safe operator-supplied input or secret reference. Never print or copy the credential.
2. Remove the reschedule fallback that can mutate the last confirmed appointment after any identifier lookup miss. A lookup miss must cause zero Calendar or Sheets mutation.
3. Add deterministic tests for booking, lookup, reschedule, cancellation, callbacks, date/time normalization, and all Retell tool contracts. Tests must use mocks/fixtures and make no network calls.
4. Align `create_appointment` across Retell JSON, route normalization, Zod validation, service logic, and persistence:
   - preserve `full_name`/`caller_name` compatibility;
   - map `first_visit` to the persisted new-patient field;
   - persist `referral_source` explicitly;
   - preserve sport/injury/accident notes.
5. Remove raw patient phone lists and raw request bodies from logs. Add regression tests for redaction.
6. Add explicit request-size limits, restricted configurable CORS, and rate limiting suitable for public voice-tool endpoints.
7. Add a versioned authentication boundary for tool requests using an environment-provided shared secret or signed request mechanism. Keep `/` and health checks usable without the tool credential. Never invent a production secret or place one in source control.
8. Add idempotency protection for write tools and conflict-safe behavior sufficient to prevent duplicate appointment/callback creation in deterministic retry tests.
9. Add a package test script and safe CI quality workflow. Production deployment must reference a protected `production` environment and remain manual/human-approved.
10. Preserve backward compatibility where safe. Document every new required environment variable and the production rollout order.

# Acceptance criteria

- `npm run build` passes.
- `npm test` passes with deterministic offline tests.
- The pipeline static eval reports zero failures.
- No Critical/High issue remains in the task diff.
- No embedded credential, patient record, live API call, calendar write, Retell publish, Git push, merge, or deployment occurs.
- Claude architecture, implementation, and any bounded fix rounds complete in the isolated worktree.
- Deterministic tests/evals and the independent Codex final security review pass.
- The final result is committed only to an isolated `agent/claude-*` branch and awaits Cyrus' approval.

# Explicit non-goals

- Rotating or deleting the already exposed Google key in Google Cloud. That external action requires Cyrus' confirmation and access.
- Rewriting Git history or force-pushing.
- Replacing Retell or changing the live Retell agent.
- Deploying to AWS or changing production secrets.
