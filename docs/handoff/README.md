# Archive — do not follow these as instructions

These files are a dated record of how the project got here: the task prompts
given to earlier agents, the reviews that came back, and a provenance note for
the original uncommitted working tree. They are kept because they explain
decisions that the current code no longer shows on its face.

**They are history, not a runbook.** Several describe a telephony vendor
(Retell) that has since been removed from the service entirely — there is no
`src/routes/retell.ts`, no `RETELL_*` configuration, and no Retell dashboard
step anywhere in the current process. `05-phase-b-prompt.txt` in particular
instructs an agent to work in that dashboard; that instruction is void.

They are deliberately left unedited. Rewriting a record of what was true in
August 2026 to match September 2026 would destroy the only reason to keep it.

For what actually runs, read, in this order:

- [`../VOICE_PIPELINE.md`](../VOICE_PIPELINE.md) — the design, and the open
  questions behind it
- [`../GO_LIVE.md`](../GO_LIVE.md) — the current runbook, from a laptop test
  call to production
- [`../INFRASTRUCTURE.md`](../INFRASTRUCTURE.md) — what exists in AWS and what
  the templates create
