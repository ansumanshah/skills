---
name: panel-review
description: Review a diff with three reviewers from three providers at once (Claude, GPT, Gemini), triage their reports, fix verified problems, and repeat for up to 3 rounds. Triggers on "panel review", "three-model review", "review with Claude, GPT and Gemini", "get all the models to review this", "high-stakes review". Use for security, auth, payments, data loss, or when the user asks for a panel. Records scores per member per round.
---

# panel-review

Run three read-only reviewers in parallel. For a single reviewer, use [second-opinion](../second-opinion). Post PR comments through [reply-pr](../reply-pr).

## Members

- Default: one Claude, one GPT, one Gemini.
- If the user names members, use those.
- Use the strongest current model of each provider, at high effort.
- If a member is unreachable, do not substitute another model. Say which one is missing and continue with the rest.

## Before round one

1. Fix issues you already know about.
2. Run the covering checks. Use `build-queue <command>` when installed.
3. Find the base with merge-base against the PR base or default branch. Every member gets the same base.
4. Write two sentences: the intent, and what is out of scope.

## Launch

Use the `delegate` CLI when installed. Lane names are permanent, so give each run and round a unique name, such as `<topic>-<member>-r1`. All lanes are read-only.

```
delegate review --background --name <unique> --base <sha> --backend claude --model opus --effort high --focus "<intent>"
delegate review --background --name <unique> --base <sha> --backend codex --model <strongest GPT> --effort high --focus "<intent>"
delegate review --background --name <unique> --base <sha> --backend gemini --model pro --focus "<intent>"
delegate status               # poll as each member finishes, or `delegate wait` for the full round
delegate result <NAME>
```

Swap in the strongest current model of each provider. Gemini ignores `--effort`.

Without `delegate`, use the harness's own subagents on each provider.

## Shared brief

Send the same brief to all members: intent, out of scope, base SHA, severities (blocker, should, nit). Ask for this reply:

```
SCORE: <0-10>
VERDICT: APPROVE | CHANGES
F1 [blocker|should|nit] path:line - finding - suggested fix
```

## Triage

- Triage each report as it lands. Do not wait for all three.
- Do not edit files while a reviewer is still reading them. Collect fixes and apply them after the round ends.
- Verify each finding yourself before you act. Reproduce it or read the code.
- Fix verified blockers and shoulds.
- Decline nits and list them as follow-ups.
- Dispute wrong findings with evidence.
- Guard scope. Do not let review grow the PR past its goal.

## Rounds

1. After fixes, re-run the checks.
2. Start a new round on the new diff, with new lane names.
3. Stop when all members approve, or after 3 rounds.
4. Show open disputes to the user and let them decide.

## Record scores

Put a table in the PR description, one row per member, one column per round. Write `no score` when a member gave none. With no PR, put the table in the final reply.

```
| Member | Round 1 | Round 2 | Round 3 |
|--------|---------|---------|---------|
| Claude | 6 | 8 | 9 |
| GPT    | 7 | 9 | no score |
| Gemini | 5 | 8 | 9 |
```
