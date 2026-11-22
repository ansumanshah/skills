---
name: ready-pr
description: Do everything to get a PR ready to merge, then stop without merging. Triggers on "get this ready for me to merge", "do everything but merge", "make it mergeable", "prep this PR, I'll press merge", "ready for review and merge". Same flow as ship-pr with proof, review, CI, and a readiness gate, but merging, auto-merge, and merge queues are forbidden.
---

# ready-pr

Follow [ship-pr](../ship-pr) for every step except the merge. Never merge.

## Allowed

- commit and push
- rebase and resolve conflicts
- `--force-with-lease` on this branch

## Forbidden

- merging the PR, by any method
- enabling auto-merge
- joining a merge queue
- pushing the default branch
- bypassing branch protection
- asking another agent to do any of the above

## Before you start and before each push

1. Check whether auto-merge is on or the PR is in a merge queue.
   ```
   gh pr view <pr> --json autoMergeRequest,state,isDraft
   gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){isInMergeQueue}}}' -f o=<owner> -f r=<repo> -F n=<pr>
   ```
2. If auto-merge is on, turn it off. If the PR is in a merge queue, stop and ask the user to remove it: `--disable-auto` does not dequeue.
   ```
   gh pr merge <pr> --disable-auto
   ```
3. Tell the user you did this.

## Steps

1. Finish the change with the smallest diff.
2. Prove it, as in ship-pr: reproduce then pass, CI checks under `build-queue` when installed, and the real app via `ui-qa` for UI.
3. Review with [second-opinion](../second-opinion). Use [panel-review](../panel-review) for security, auth, payments, or data loss.
4. Rebase and open the PR with [open-pr](../open-pr).
5. Watch with [watch-pr](../watch-pr) and fix what it reports.
6. Post comments through [reply-pr](../reply-pr).

## Readiness gate

Use ship-pr's merge gate as the readiness test:

- proof covers the diff
- required checks are green
- bots are done, findings fixed or answered
- the independent review approved, or every blocker and should is fixed or disproved
- no human change requests
- up to date with base and mergeable

Recheck the live PR at the end. It must be open, not draft, and not auto-merging.

## End in one state

- ready: the gate passes and only the user's merge is left.
- waiting only on human approval: the gate passes except for a required human review. Confirm that on the live PR.
- blocked: say what blocks it, what you tried, and what you need.

## Finish

1. Stop any PR watcher you started.
2. Report: PR link, head SHA, state, proof, review outcome, risks, and the statement that the PR is open and unmerged.
