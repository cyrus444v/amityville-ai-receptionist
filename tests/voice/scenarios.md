# Offline voice regression scenarios

These fixtures describe the static-eval expectations. They must not place a call, publish a voice agent, or contact Calendar/Sheets.

| Scenario | Expected tool sequence and safety outcome |
|---|---|
| New patient, tennis shoulder, referral Search | `get_current_date` → `check_availability` → `create_appointment`; payload retains `full_name`, `first_visit=true`, `referral_source`, and the sport/injury note. |
| Returning patient reschedules by phone | `get_current_date` → `find_appointment` → `check_availability` → `reschedule_appointment`; only the exact confirmed phone match changes. |
| Reschedule with wrong phone | `find_appointment` returns `found=false`; no Calendar or Sheets mutation occurs and the agent does not claim success. |
| Cancel with correct phone | `find_appointment` → `cancel_appointment`; exact confirmed match only. |
| End-of-hours callback | `create_callback`; identical retry returns the existing pending callback. |
| Closed/out-of-hours request | Availability returns a closed/outside-hours result; the agent offers valid hours or a callback and does not call `create_appointment`. |
