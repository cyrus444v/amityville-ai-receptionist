# Your uncommitted changes vs. the current tree

Provenance record. On 2026-08-17 the pipeline copied your four uncommitted files
into an isolated worktree and used them as the starting point for the security
hardening. The hardening then rewrote parts of the same files — so they are **not**
byte-identical to what you had, and this document exists so the difference is
auditable rather than assumed.

Your original is untouched at
`~/Desktop/amityville-ai-receptionist/backend` (still `a5e2cbf` + four modified
files). Nothing was overwritten there.

What you should check personally: whether the clinic policy wording you wrote in
the system prompt — cancellation policy, insurance scripts, new-patient handling —
survived the rewrite the way you meant it. That is domain judgement, not something
a test can assert.

Legend: `-` your version, `+` the current tree.

## retell/system-prompt.txt

```diff
@@ -137,21 +137,25 @@
 
 CANCELLATION FLOW:
 STEP 1 — Ask: "What phone number was the appointment booked under?"
-STEP 2 — Call cancel_appointment with that phone number.
-STEP 3 — "Done — that appointment has been cancelled. You're welcome to call back anytime to rebook."
+STEP 2 — Call find_appointment with that phone number. The backend verifies it against the caller's actual number and returns only an opaque selection token. Never speak or reveal appointment_token.
+STEP 3 — If more than one appointment matches, ask for the original appointment date and exact time, then call find_appointment again with those details. Do not guess or select the first match.
+STEP 4 — Call find_appointment again with the selected appointment_token to retrieve details, then ask the caller to confirm them.
+STEP 5 — Call cancel_appointment with appointment_id and appointment_token exactly as returned.
+STEP 6 — Only after a successful tool result: "Done — that appointment has been cancelled. You're welcome to call back anytime to rebook."
 
 ---
 
 RESCHEDULING FLOW:
 STEP 0 — Call get_current_date silently.
 STEP 1 — Ask: "What phone number was the appointment booked under?"
-STEP 2 — Ask: "What new day works for you?"
-Wait. Do NOT suggest days.
-STEP 3 — Ask: "And what time?"
+STEP 2 — Call find_appointment. If multiple appointments match, ask for the original date and exact time and call it again. Never reveal appointment_token and never select the first match.
+STEP 3 — Call find_appointment again with appointment_token to retrieve details. Ask the caller to confirm them. Then ask: "What new day works for you?"
+Wait. Do NOT suggest days.
+STEP 4 — Ask: "And what time?"
 Wait. Must be an exact time — not "morning" or "afternoon".
-STEP 4 — Call check_availability with both date and exact time.
-STEP 5 — If available, call reschedule_appointment.
-STEP 6 — Confirm the new details.
+STEP 5 — Call check_availability with both date and exact time.
+STEP 6 — If available, call reschedule_appointment with appointment_id and appointment_token exactly as returned by find_appointment.
+STEP 7 — Confirm the new details only after a successful tool result.
 
 ---
 
```

## retell/tools.json — structural summary

- tools yours: 7 · current: 8
- added: find_appointment
- `cancel_appointment`: params +appointment_token; headers +x-retell-call-id,x-retell-caller-phone,x-tool-auth
- `check_availability`: headers +x-retell-call-id,x-tool-auth
- `create_appointment`: headers +x-retell-call-id,x-tool-auth
- `create_callback`: headers +x-retell-call-id,x-tool-auth
- `get_current_date`: headers +x-retell-call-id,x-tool-auth
- `reschedule_appointment`: params +appointment_token; headers +x-retell-call-id,x-retell-caller-phone,x-tool-auth
- `search_services`: headers +x-retell-call-id,x-tool-auth

## src/routes/appointments.ts and src/routes/tools.ts

Substantially rewritten by the hardening — caller verification, appointment
selection tokens, input normalisation, PHI-safe logging. Review them as new code
rather than as a diff:

```
diff -u ~/Desktop/amityville-ai-receptionist/backend/src/routes/appointments.ts \
        ~/aivance-voice-agent/src/routes/appointments.ts
```
