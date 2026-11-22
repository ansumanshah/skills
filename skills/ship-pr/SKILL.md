---
name: ship-pr
description: Take a change from working tree to a merged PR with no supervision, with proof, review, CI, and a merge gate. Use only when the user clearly says to ship or land it while they are away. Triggers on "ship it", "land this", "ship this PR", "merge it when green, I'm away", "take this all the way to merged". Grants merge after the gate passes. For everything but the merge, use ready-pr.
---

# ship-pr

Run end to end and finish with a merged PR. If the user wants everything except the merge, use [ready-pr](../ready-pr).

## Grants

You may, without asking:
- merge after the gate passes
- push with `--force-with-lease` on this branch
- run the app, simulators, browser and desktop automation, and take screenshots, as far as proof needs

You may not:
- touch production
- delete data
- push or change other branches
- bypass harness permission prompts

## Steps

1. Finish the change with the smallest diff. Start on a branch, or in a worktree inside the repo.
2. Prove it (see Proof).
3. Review with [second-opinion](../second-opinion). Use [panel-review](../panel-review) for security, auth, payments, or data loss.
4. Rebase on the base branch. Open the PR with [open-pr](../open-pr).
5. Watch with [watch-pr](../watch-pr). Prove each fix you push.
6. Merge when the gate passes.
7. Report: PR link, merge commit, proof, and every decision you made.

Stay active until the PR merges. Wait on the watcher. Do not end your turn while it runs.

## Proof

Proof is evidence you saw this session. Memory and assumption do not count.

- Reproduce the problem, then show it passing.
- Run the CI checks locally. Use `build-queue <command>` when installed.
- If no test covers the change, add one failing test, then show it pass.
- For UI, run the real app with the `ui-qa` skill and look at the result.

## Merge gate

All of these must hold:

- Proof covers the whole diff.
- Required checks are green.
- Bots are done, and each finding is fixed or answered.
- The independent review approved, or every blocker and should finding it raised is fixed or disproved with evidence. A review that ran out of rounds with open findings stops the merge.
- No human has requested changes.
- The PR is up to date with its base and mergeable.

Merge the way the repo does. Never use admin bypass. Fetch and recheck right before you merge.

## When to ask

Ask only when:
- proof is impossible
- the gate cannot pass
- the next step exceeds the grant
- the goal is ambiguous
- another PR makes this one obsolete

Use the harness question tool. Give full context and a recommended option. In every other case, decide and list the decision in the report.

If there is no question tool, leave the PR open and lead the final message with the question.

## Comments

Post every comment through [reply-pr](../reply-pr).
