---
name: human-steps
description: Generate an interactive shell script for tasks a person must perform. Use when setting up credentials or CI secrets, provisioning a third-party service, planning a migration with manual stages, or replacing a long list of dashboard click instructions.
---

# Human steps

Keep entered values in the person's terminal process and their chosen destinations.
Never collect those values in agent chat or tools; use script prompts for entry.

## 1. Confirm the scope

Read `.env.example`, README, CI `secrets.*` and `vars.*` references, and service config.
Inspect names and references rather than live credential files.
List stages in dependency order. For every produced value, list its source,
destination path or GitHub repository, and secret flag.
Include payments, DNS approvals, and cutovers as explicit stages when required.
Show the list to the user and get confirmation before generating the script.
Finish when every value has a source, destination, and secret flag in the confirmed list.

## 2. Verify the human path

Write the exact URL, click sequence, and place each value appears for every stage.
When the current UI is unknown, check the vendor's docs or ask the user.
Use verified menu paths. Mark unresolved UI details and resolve them before scripting.
Finish when a stranger can follow every stage without guessing a location or action.

## 3. Generate the script

Copy [template.sh](template.sh) to a scratch path unless a repeatable committed script is requested.
Keep the helper library above `# ---- STAGES ----` unchanged.
Replace the example below that marker with one focused human task per stage.
Set `TOTAL` to the stage count and put stages in dependency order.
Set the agreed working directory before relative file writes or GitHub writes.
Call `open_url` before asking for the value from that page.
Use `ask_secret` for every secret and `ask` for other values.
Write through `write_env`, `set_secret`, or `set_var` to the confirmed destination.
Gate every irreversible action with `confirm`; stop or skip that action on refusal.
Keep the final summary to written names and destinations.
Finish when each scoped value has an input prompt and exactly its agreed write path.

## 4. Check and hand over

Run `bash -n` and `shellcheck`, then `chmod +x` on the generated file.
Report ShellCheck as unavailable if absent; keep that check outstanding.
Trace each value statically from prompt to destination against the confirmed scope.
Match every GitHub secret and variable name to CI and verify the target repository.
`write_env` writes single-quoted values, which Node dotenv and Docker Compose read literally. python-dotenv still expands `${VAR}` inside single quotes, so for a Python app check the value has no `$` or route it by hand. It refuses a value with a single quote or a newline, and refuses to replace an entry that spans several lines; route those values by hand.
Leave execution to the person, including sign-in, value entry, and approvals.
Give the exact command to run from the agreed directory.
Finish when static checks pass, all writes match scope, and the user has that command.
