---
name: skill-writing
description: Write agent instructions in SKILL.md, AGENTS.md, CLAUDE.md, and their linked docs. Use when creating or editing a skill, writing or trimming AGENTS.md or CLAUDE.md, fixing missed triggers, fixing unwanted triggers, or fixing inconsistent skill execution.
---

# Skill writing

## Make the pointer earn its context

Treat the description as an always-loaded pointer that costs context each turn.
Use it to tell the agent when to load the body. Lead with the key action or topic.
Name each distinct trigger once. Keep procedure in the body.
Apply the same rule to an AGENTS.md line that points to another document.
Finish when each intended case has one clear trigger and each word helps routing.

## Choose who invokes it

Use model invocation when the agent or another skill must discover the skill itself.
Give that skill an agent-facing description with its triggering cases.
Use `disable-model-invocation: true` when only a person should type the invocation.
Give that version a human-facing one-line description; it costs no automatic context.
Check the target harness: Claude Code, Codex, Gemini CLI, and Cursor differ.
Finish when the chosen mode and its context behavior match that harness.

## Order content by need

Put steps the agent always runs first in SKILL.md, then reference used sometimes.
Move detail needed by only some cases to a sibling file.
Link it relatively at the relevant step and say when to read it.
Keep each concept's rule, example, and caveat together under one heading.
Long files dilute attention even when every line is true.
Finish when the common path reads in order and each optional branch has a clear link.

## Give each step a finish line

End every step with a checkable done condition.
Use "every caller updated and its focused test passes" as a concrete finish line.
Replace "until understood" with observable evidence so the agent keeps working.
Choose one familiar word for a recurring idea, such as "red" for a failing test.
Reuse that word throughout the document.
Finish when someone can verify each step's result without guessing intent.

## State the desired action

Write what the agent should do. A ban puts the banned action in mind.
Reserve bans for hard safety rules and pair each with the action to take instead.
Finish when each instruction points to an action and a result.

## Prune to one source

Keep one source of truth per rule. Link to config, scripts, or `--help` for cheap lookups.
Repeat their details only when the lookup costs enough to justify it.
Record unwritten conventions and their reasons. Delete stale rules and obvious advice.
Finish when each surviving line changes a decision or preserves needed project knowledge.

## Check before delivery

- Check description triggers against the intended cases.
- Check every step's done condition.
- Check file length against the agreed budget; split optional detail when needed.
- Resolve every relative link.
- Keep each rule in one place.

Where the harness permits, try real prompts that should trigger and prompts that should not.
Inspect which skill actually loads. Revise the pointer and repeat failed cases.
Finish when the checklist passes and any unavailable invocation checks are reported.
