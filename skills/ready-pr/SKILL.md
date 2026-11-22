---
name: ready-pr
description: Do everything to get a PR ready to merge, then stop without merging. Triggers on "get this ready for me to merge", "do everything but merge", "make it mergeable", "prep this PR, I'll press merge". For a full merge while the user is away, use ship-pr.
---

# ready-pr

Run [ship-pr](../ship-pr) steps 1 to 5 and use its merge gate as the readiness test. Stop before merge. Never merge.

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
2. If auto-merge is on, turn it off with `gh pr merge <pr> --disable-auto`. If the PR is in a merge queue, stop and ask the user to remove it: `--disable-auto` does not dequeue.
3. Tell the user you did this.

## Readiness

Recheck the live PR at the end. It must be open, not draft, and not auto-merging. Post comments through [reply-pr](../reply-pr).

## End in one state

- ready: the gate passes and only the user's merge is left.
- waiting only on human approval: the gate passes except for a required human review. Confirm that on the live PR.
- blocked: say what blocks it, what you tried, and what you need.

## Finish

1. Stop any PR watcher you started.
2. Report: PR link, head SHA, state, proof, review outcome, risks, and the statement that the PR is open and unmerged.
