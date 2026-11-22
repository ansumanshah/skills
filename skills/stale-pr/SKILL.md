---
name: stale-pr
description: Bring an old pull request up to date and judge whether it should still exist. Triggers on "refresh this PR", "rebase this old PR", "is this PR still relevant", "update the stale PR", "should we close this PR", "revive PR 123". Returns a verdict of REFRESH, REWORK, or CLOSE. Rebases and pushes only when the user asked to update the PR; a question about relevance stays read-only.
---

# stale-pr

Update an old PR, and decide if it should live. Post comments only when asked, through [reply-pr](../reply-pr).

## Rules

- Fetch the latest of every branch involved.
- Treat existing worktree changes as the user's. When you need a checkout, use a disposable worktree inside the repo.
- Refreshing permits rebase and push of the PR branch only. It does not permit merge, close, base change, or scope growth.
- Push with `--force-with-lease` set to the head SHA you recorded before the rebase.

## Steps

1. Record the PR: URL, state, base, head SHA, author, checks, reviews.
   ```
   gh pr view <pr> --json url,state,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,author,statusCheckRollup,reviews
   ```
2. Read everything: diff, description, threads, linked issues.
3. State its smallest goal in one or two sentences.
4. See what landed on the base since the branch diverged.
   ```
   git log --oneline $(git merge-base origin/<base> <head>)..origin/<base> -- <touched paths>
   ```
5. Search for PRs that replaced or compete with it.
6. Ask these questions:
   - Is the problem already solved?
   - Did interfaces move?
   - Does ownership now overlap with other code?
   - Was the code this PR changes removed?
   - Would it bring back old behavior?
   - Does the benefit still pay for upkeep?

A clean rebase is not evidence the PR is still right. Judge by intent.

## Verdict

Pick one:

- REFRESH: rebase, resolve, test, push. If the user only asked whether the PR still belongs, report the verdict and stop before rebasing.
- REWORK: explain the smallest credible rewrite. Stop unless asked to do it.
- CLOSE: cite the evidence. Stop. Never close without permission.

## For REFRESH

1. Rebase in the disposable worktree.
2. Resolve conflicts by current intent and the base's newer rules. On a real design conflict, stop and reconsider the verdict.
3. Compare old and new with `git range-diff <old-base>..<old-head> <new-base>..<new-head>`.
4. Run focused checks. Use `build-queue <command>` when installed.
5. Push with lease to the PR's head repository, not always `origin`. For a fork PR (`isCrossRepository`), push to a remote for `<headRepositoryOwner>/<headRepository>`. That works when you can write to the fork (your own, or you are a collaborator on it) or the author allowed edits from maintainers; if the push is refused, stop and report.
   ```
   git push --force-with-lease=<headRefName>:<recorded-head> <head-remote> HEAD:<headRefName>
   ```
6. If the lease fails, refetch, read what changed, and redo from the rebase.

## Report

Lead with the verdict. Then give: base changes, conflicts, push result, checks, and the remaining decision. Keep facts and judgment in separate lines, and label each.
