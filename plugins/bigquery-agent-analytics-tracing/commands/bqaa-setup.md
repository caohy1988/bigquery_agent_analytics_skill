---
description: Bootstrap GCP / IAM / BigQuery prerequisites so the BQAA tracing plugin can write agent_events rows. Walks through ADC check, dry-run plan, approval, --execute, and a real round-trip verification.
allowed-tools: Bash, Read, Edit, Write
---

You are about to run the BQAA setup wizard for the user.

Use the `bqaa-setup` skill (it lives in this same plugin) for the full step-by-step. Specifically, follow it in order — Step 1 (gather inputs and confirm), Step 2 (ADC check, **stop and ask the user to run `gcloud auth application-default login` themselves if ADC is missing**), Step 3 (dry-run, show the plan verbatim), Step 4 (wait for explicit approval, then `--execute`), Step 5 (e2e smoke verification), Step 6 (persist `BQAA_*` env so future sessions auto-trace).

User input for this run (parse from the prompt args; ask for the rest):

$ARGUMENTS

If the user supplied a project / dataset / location / service-account in `$ARGUMENTS`, use those defaults. Otherwise ask them once, in a single batched question, before running anything.

Hard rules:

- Never run `gcloud auth login` or `gcloud auth application-default login` yourself.
- Never run `setup_gcp_prereqs.py --execute` without first showing the dry-run plan and getting explicit approval.
- Step 4 must re-run the **exact** Step 3 command with `--execute` appended — do not switch principal / service-account / flag set between dry-run and execute, even if a "better" variant occurs to you mid-run.
- For Step 6 (persist `BQAA_*`), follow the consumer-specific output in the skill: settings.local.json for Claude Code TUI, `ClaudeAgentOptions.env` snippet for Claude Agent SDK, shell exports for Codex CLI. Ask the user which one in Step 1 if `$ARGUMENTS` doesn't say. Do not default to settings.local.json — SDK and Codex consumers don't read it.
- End with the consumer-appropriate hand-off: "restart Claude Code in this directory" for TUI, "use this `ClaudeAgentOptions(env=...)` snippet on every `ClaudeSDKClient`" for SDK, "source the export block / put it in `~/.zshrc`" for Codex.
