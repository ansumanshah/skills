---
name: watch-pr
description: Watch a pull request through CI and review bots until it is ready, and handle each event. Triggers on "watch the PR", "keep an eye on CI", "wait for checks", "handle the review comments", "fix CI failures on the PR", "get this PR green", "rebase when main moves". Covers one-watcher-per-PR rules, failure triage, flake reruns, bot findings, scope control, rebasing, and merge safety.
---

# watch-pr

Watch one PR until it is ready. Post comments through [reply-pr](../reply-pr).

## Start one watcher

- Run one watcher per PR. Never write a sleep loop by hand.
- If the harness has its own PR watcher, such as Claude desktop's, use it.
- Otherwise run `pr-watch` from this skill's `scripts/` folder, by absolute path.
  ```
  <abs path>/watch-pr/scripts/pr-watch <pr> [--repo o/r] [--until green|ready|change]
  ```
- In Claude Code, start it under the Monitor tool so each output line wakes you. Elsewhere, run it as one background command.
- It prints one line per PR event. Exit 0 means done. Exit 1 means something needs action. Exit 2 means bad input or another watcher already runs for this PR.
- A PR with no CI checks turns green after the watcher sees one head for 90 seconds.
- Restart the watcher after every push.
- When an event needs nothing, stay silent.

## Rate limits

If GraphQL fails, run `gh api rate_limit`. Fall back to REST for the PR and check runs.

```
gh api repos/{o}/{r}/pulls/<n>
gh api repos/{o}/{r}/commits/<sha>/check-runs
```

## Handle each event

Reassess every unresolved thread and every failing check against the current head. Old findings may already be fixed.

- Failing check: reproduce it locally before you push a fix. Use `build-queue <command>` when installed.
- Real failure versus infra flake: rerun a suspected flake once. If it fails again, treat it as real.
- Bot finding that is wrong: reply with a written reason through reply-pr, then resolve the thread.
- CodeRabbit is advisory. Fix what is correct and in scope. Answer the rest.
- Human change request: fix it or answer it, then resolve the thread only as [reply-pr](../reply-pr) allows. A thread you leave open for its author goes to the user as a blocker, so `--until ready` does not loop on it.

## Keep the PR small

Hold the PR to its goal. Decline these with a reason, and list them as follow-ups:

- extra tests beyond the change
- guards for rare cases
- compatibility shims nobody asked for
- micro-performance edits

## Keep it current

- When the base moves, rebase and push with `--force-with-lease`.
- Re-run the covering checks after a rebase.
- Ask before you close a PR that another PR made obsolete.

## Merging

Merge only if the user asked. Right before you merge:

1. Fetch the base and the PR head again.
2. Recheck status, mergeability, and reviews on the live PR.
3. Refuse to merge when the state is BEHIND or DIRTY.
4. Refuse to merge when the base gained commits after the last green run that touch the same files. Rebase and wait for green again.

Merge the way the repo does it: check the allowed merge methods and recent merged PRs. Never use admin bypass.

## Stop

Stop the watcher when the PR merges, closes, or you hand it back to the user.
