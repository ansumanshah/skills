---
name: second-opinion
description: Review a diff with reviewers from other model providers, in rounds, answering every finding. Use for "second opinion", "cross-review", "review before I push", and high-stakes diffs. "Panel review" or "three-model review" runs three providers at once and scores each round.
---

# second-opinion

One reviewer from a different provider by default; panel mode runs three. Post PR comments through [reply-pr](../reply-pr).

## Policy

- 3 rounds by default. 5 only for security, auth, data loss, concurrency, or when the user asks.
- Stop on approval, when only nits remain, when the budget runs out, or when a dispute survives two replies. Show both sides of a dispute to the user.
- Do not push during the loop.
- Reviewers are read-only and must not spawn other agents.
- Do not send a diff that fails its checks.

## Set the scope

1. Leave unrelated changes alone.
2. Fix known issues, then run the covering checks. Use `build-queue <command>` when installed.
3. Find the base once and keep it every round: `git merge-base HEAD origin/<base>` (the default branch if there is no PR). Regenerate the diff each round so reviewers see your fixes.
4. Write two sentences: the intent, and what is out of scope.

## Pick reviewers

- Use a different provider than the author. Your own model family does not count.
- Single mode: the provider's default model for routine changes, its strongest for the 5 round topics.
- Use the `delegate` CLI. Without it, use whatever the harness has for running another provider's model; if it has nothing, say so and stop. Lane names are permanent, so every run and round needs a new name, such as `<topic>-<member>-r1`.
  ```
  delegate review --name <unique> --base <sha> --focus "<intent>" [--backend codex|claude|gemini|agy] [--model M] [--effort E] [--background]
  delegate result <NAME>
  ```
- Pass `--background` to run lanes in parallel or keep working. `delegate wait` is needed only for background runs.
- `delegate result` exits 1 when the lane failed: say so, then rerun under a new name or treat that reviewer as missing. It exits 75 while the lane still runs: `delegate wait <NAME>`, then ask again.
- If a provider cannot be reached, treat it as missing and say so in the report. Do not substitute another model for it. Never review with your own model family and call it a second opinion.

## Brief

Send the intent, the out-of-scope line, the base SHA, and these severities:

- blocker: wrong behavior, data loss, security hole
- should: real defect or risk worth fixing now
- nit: style or taste

Ask for this reply (panel mode adds the first line):

```
SCORE: <0-10>
F1 [blocker|should|nit] path:line - finding - suggested fix
F2 ...
VERDICT: APPROVE | CHANGES
```

## Ledger and answers

Keep a table: finding id, severity, outcome (fixed, declined, disputed, follow-up). Answer every finding:

- Verify it first: reproduce it or read the code.
- Fix with the smallest change. Try deleting or narrowing code first.
- Or disagree, with evidence: code, output, or a test.
- Or decline a nit and list it as a follow-up.
- Never agree only to finish. If review grew the diff, cut it back.

## Next round

Start another round only if budget remains and something real is open. Re-run the checks first. Send single-mode replies to the same reviewer so it keeps context:

```
delegate continue <NAME> "<answers and what changed>"
delegate wait
```

## Panel mode

- Launch three reviewers in parallel with `delegate review --background`: one Claude, one GPT, one Gemini, or the members the user names. Use each provider's strongest current model: `--backend claude --model <strongest> --effort high`, `--backend codex --model <strongest> --effort high`, `--backend gemini --model <strongest>`. Gemini ignores `--effort`.
- Every member gets the same base and brief.
- Triage each report as it lands. Do not edit files while any reviewer is still reading; collect fixes and apply them after the round ends.
- Each round starts new lanes with new names on the new diff.
- Stop when all members approve or the budget ends.
- Record scores in the PR description, or the final reply with no PR: one row per member, one column per round, `no score` when none was given.

```
| Member | Round 1 | Round 2 | Round 3 |
|--------|---------|---------|---------|
| Claude | 6 | 8 | 9 |
| GPT    | 7 | 9 | no score |
| Gemini | 5 | 8 | 9 |
```

## Report

State rounds used, reviewers and models, missing providers, changes made, diff size before and after, and the outcome of each finding.
