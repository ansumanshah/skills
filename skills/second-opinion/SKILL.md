---
name: second-opinion
description: Run a bounded second-model review of a diff in rounds, answer every finding, and stop on approval or budget. Triggers on "get a second opinion", "have another model review this", "review loop", "cross-review my changes", "run delegate review", "review before I push". Uses one reviewer from a different provider than the author, a ledger of findings, and a 3 round budget (5 for security, auth, data loss, or concurrency).
---

# second-opinion

Review a diff with one reviewer from a different provider. For three reviewers at once, use [panel-review](../panel-review). Post PR comments through [reply-pr](../reply-pr).

## Budget

- 3 rounds by default.
- 5 rounds only for security, auth, data loss, concurrency, or when the user asks.
- Stop early when only nits remain.
- Use one reviewer. The reviewer must not spawn other agents.

## Set the scope

1. Leave unrelated changes alone.
2. Find the base with merge-base against the PR base, or the default branch if there is no PR.
   ```
   git merge-base HEAD origin/<base>
   ```
3. Keep the base and scope fixed every round. Regenerate the diff each round so the reviewer sees your fixes.
4. Write two sentences: the intent, and what is out of scope.
5. Run the covering checks first. Do not send a diff that fails them.

## Pick the reviewer

- Use a different provider than the author. Your own model family does not count.
- Size the reviewer to the diff: the provider's default model for routine changes, its strongest only for the 5 round topics above.
- Preferred: the `delegate` CLI. Lane names are permanent, so each run needs a unique name.
  ```
  delegate review --name <unique> --base <sha> --focus "<intent>" [--backend codex|claude|gemini|agy] [--model M] [--effort E] [--background]
  delegate result <NAME>
  ```
- Else use a native subagent that runs on another provider.
- If neither exists, say so. Do not review with the same model and call it a second opinion.

## Brief

Keep it compact. Include the intent, the out-of-scope line, the base SHA, and the severities:

- blocker: wrong behavior, data loss, security hole
- should: real defect or risk worth fixing now
- nit: style or taste

Ask for this reply format:

```
F1 [blocker|should|nit] path:line - finding - suggested fix
F2 ...
VERDICT: APPROVE | CHANGES
```

## Ledger

Keep a table: finding id, severity, outcome (fixed, declined, disputed, follow-up).

## Answer every finding

- Fix with the smallest change. Try deleting or narrowing code first.
- Or disagree, with evidence: code, output, or a test.
- Or decline a nit and list it as a follow-up.
- Never agree only to finish.
- If review grew the diff, cut it back.

## Next round

Start another round only if budget remains and something real is open. Send the reply to the same reviewer so it keeps context.

```
delegate continue <NAME> "<answers and what changed>"
delegate wait
```

Do not push during the loop.

## Stop

Stop on APPROVE, when a dispute survives two replies, or when the budget runs out. For a dispute, show both sides briefly and let the user decide.

## Report

State rounds used, reviewer and model, changes made, diff size before and after, and the outcome of each finding.
