---
name: take-over
description: Finish someone else's unfinished PR, branch, or agent session toward its original goal, keeping their credit. Triggers on "pick up this PR", "finish this branch", "continue where the other agent stopped", "take over this work", "resume the stalled delegate worker", "complete PR 123".
---

# take-over

Finish work that another person or agent started. Post comments through [reply-pr](../reply-pr).

## Treat the handoff as a lead

A handoff note is a claim, not proof. Check it.

1. Read the source (PR, branch, or session log), every review thread, and every later correction from the user.
2. Find the real current head. Check for uncommitted work in any worktree or session.
3. For a stalled `delegate` worker, read its output and its diff: `delegate result <NAME>`.
4. State the original goal in one or two sentences.

## Keep credit

- Preserve authorship and co-author trailers on the original commits, through squashes.
- Name and link the original PR or session in your PR.
- Add trailers only for verified identities. Never invent one.

## Where to work

- Default: a new branch holding the original commits, with your fixes on top.
- Work in place only if the user asks.
- Do not change the original PR or unrelated work without permission.

## Steps

1. Judge and rebase with [stale-pr](../stale-pr) on your new branch, and skip its push step: push to the original PR branch only when the user asked for in-place work. If the verdict is REWORK or CLOSE, stop and report.
2. Change only what the goal needs.
3. Recheck the source for movement before you push. The original may have gained commits.
4. Verify the original failure yourself. Reproduce it, then show the fix.
5. Verify real usage of the feature, beyond the test suite. Use `ui-qa` for UI.
6. Say what you could not verify.
7. Open the PR with [open-pr](../open-pr). Watch it with [watch-pr](../watch-pr).
8. Merge or close the original PR only with the user's permission.

## Report

Write five short lists: Inherited (kept from the original), Changed (and why), Verified (command or output), Credit (who and how), Open decisions (for the user).
