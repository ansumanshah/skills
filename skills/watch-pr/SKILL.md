---
name: watch-pr
description: Watch CI and review bots on an existing pull request and handle each event: triage failures, rerun flakes, fix bot and reviewer findings. Triggers on "watch the PR", "keep an eye on CI", "wait for checks", "handle the review comments", "fix CI failures on the PR".
---

# watch-pr

Watch one PR until it is ready. Post comments through [reply-pr](../reply-pr).

## Start one watcher

- Run one watcher per PR. Never write a sleep loop by hand.
- If the harness has its own PR watcher, such as Claude desktop's, use it.
- Otherwise run `pr-watch` from this skill's `scripts/` folder, by absolute path. Do not read the scripts: `pr-watch --help` has the options.
  ```
  <abs path>/watch-pr/scripts/pr-watch <pr> [--repo owner/repo] [--until green|ready|change] [--every SECONDS]
  ```
- `--until green`: checks pass and stay stable. Default.
- `--until ready`: also waits for review bots, resolved threads, current base, and no change requests. Use it before a merge or handoff.
- `--until change`: stops after the next event. Use it to react to one thing.
- In Claude Code, start it under the Monitor tool so each output line wakes you. Elsewhere, run it as one background command.
- It prints one line per PR event. Exit 0 means done. Exit 1 means something needs action, ten failed polls in a row, or a closed PR. Exit 2 means bad input or another watcher already runs for this PR.
- A PR with no CI checks turns green after the watcher sees one head for 90 seconds.
- Restart the watcher after every push. When an event needs nothing, stay silent.

## Rate limits

If GraphQL fails, run `gh api rate_limit`. Fall back to REST for the PR and check runs.

```
gh api repos/{owner}/{repo}/pulls/<n>
gh api repos/{owner}/{repo}/commits/<sha>/check-runs
```

## Handle each event

Reassess every unresolved thread and every failing check against the current head. Old findings may already be fixed.

- Failing check: reproduce it locally before you push a fix. Use `build-queue <command>` when installed.
- Real failure versus infra flake: rerun a suspected flake once. If it fails again, treat it as real.
- Bot finding that is wrong: reply with a written reason through reply-pr, then resolve the thread as reply-pr describes.
- CodeRabbit is advisory. Fix what is correct and in scope. Answer the rest.
- Human change request: fix it or answer it, then resolve the thread only as [reply-pr](../reply-pr) allows. A thread you leave open for its author goes to the user as a blocker, so `--until ready` does not loop on it.
- Keep the PR to its goal: decline out-of-scope asks with a reason and list them as follow-ups, per the size rule in [open-pr](../open-pr).

## Keep it current

- When the base moves, rebase and push with `--force-with-lease`. Re-run the covering checks after.
- Ask before you close a PR that another PR made obsolete.

## Merging

Merge only if the user asked, under the merge gate in [ship-pr](../ship-pr).

## Stop

Stop the watcher when the PR merges, closes, or you hand it back to the user.
