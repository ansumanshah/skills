---
name: repo-cleanup
description: Wrap up a repo after agent work - show what takes space and what can go, merge finished branches to main, remove merged worktrees and branches, and clear build output, logs, caches and test leftovers. Use when asked to "clean up", "merge to main and clean up", "remove worktrees", "what is taking space in this repo", "free disk space", or to tidy a repo at the end of a task.
---

# Repo cleanup

Leave the repo with finished work on `main`, no stale worktrees or branches, and no regenerable files. Work inside the current repo unless the user names more. Read the repo's AGENTS.md or CLAUDE.md first: its merge, review and lock rules win over this file.

`main` in this file means the repo's default branch. Find it once with `git symbolic-ref --short refs/remotes/origin/HEAD` (drop the `origin/` prefix) and use that name everywhere below.

Delete only what is merged or can be regenerated. Anything unmerged, uncommitted or not clearly generated is reported and kept until the user says yes for it by name.

## 1. Survey (read-only)

```sh
git fetch --prune
git status --short; git worktree list --porcelain; git branch -vv
git log --oneline main..<branch>                 # per branch: commits not on main
git -C <worktree> status --short                 # per worktree: uncommitted work
git -C <worktree> status --short --ignored       # per worktree: ignored files, which worktree removal deletes too
gh pr list --state merged --head <branch> --json number,mergedAt   # squash or rebase merges git cannot see
build-queue --status; delegate status                     # jobs or workers still using this repo
git clean -ndX | head -50                        # ignored files a clean would remove
du -sh <candidate dirs> 2>/dev/null              # sizes, for the list in step 4
```

Then size the repo, so the user sees what takes the space and what can go:

```sh
du -sh .                                                        # total
du -sh -- * .[!.]* 2>/dev/null | sort -rh | head -15            # biggest top-level entries
git ls-files -oi --exclude-standard --directory -z | xargs -0 -r du -sh 2>/dev/null | sort -rh | head -20   # ignored: build output, caches, deps
git ls-files -o --exclude-standard --directory -z | xargs -0 -r du -sh 2>/dev/null | sort -rh | head -10    # untracked, not ignored: user files
git count-objects -vH                                           # .git itself (size-pack)
```

Present a size table, biggest first, with one verdict per row:

| Path | Size | Kind | Verdict |
|---|---|---|---|
| `node_modules/` | 1.2G | dependencies | deep clean only, reinstall with the lockfile |
| `.build/` | 840M | build output | safe, regenerates on next build |
| `.worktrees/fix-login` | 310M | merged worktree | safe after step 3 |
| `recordings/` | 95M | untracked, not ignored | keep, ask the user |
| `.git` | 60M | history | `git gc` can shrink it; never delete |

Kinds: build output, cache, logs or test output, dependencies, worktree, untracked user file, tracked source, history. Only build output, caches, logs, test output and merged worktrees are "safe"; dependencies are "deep clean only"; untracked user files and tracked source are "keep". End the table with the total that the safe rows would free.

A branch counts as merged when `git branch --merged main` lists it, or when its PR merged and `git diff main...<branch>` is empty or already on main.

Done when you have two tables: each worktree and branch marked merged, unmerged (with commit count) or dirty, and the size table above. Show both to the user before changing anything. When the user only asked what takes space, stop here.

## 2. Merge finished work to main

For each unmerged branch the user wants on main:
- Dirty worktree: ask whether to commit it (repo commit format) or leave it. Keep uncommitted work where it is.
- Run the repo's pre-merge gate for that branch (the review and tests its AGENTS.md names).
- If the repo merges through pull requests, open or finish the PR with [open-pr](../open-pr) and [watch-pr](../watch-pr) instead of merging locally.
- Otherwise `git switch main && git merge --ff-only <branch>`. If it cannot fast-forward, rebase the branch onto main in its worktree, rerun the gate, then fast-forward. Use a merge commit only when the repo's history already does.
- Push only when the user asked.

Done when every chosen branch is contained in main and the gate passed on the merged tip.

## 3. Remove merged worktrees and branches

```sh
git worktree remove <path>      # refuses on uncommitted changes: keep that refusal and report it
git branch -d <branch>          # refuses unmerged branches
git worktree prune
delegate prune                     # preview finished lane records; add --yes when the user agrees
```

`git worktree remove` also deletes the worktree's ignored files without asking, and those can be a `.env`, a local database or hand-made fixtures. Before removing one, check its ignored files from step 1: if any is not build output, a cache, logs or dependencies, list it and keep the worktree until the user says yes for it.

A squash-merged branch needs `git branch -D`: use it only for a branch whose PR you confirmed merged in step 1. Every other `--force` or `-D` waits for the user's yes for that named branch. Delete remote branches only when asked (`git push origin --delete <branch>`).

Done when `git worktree list` shows only the main checkout plus worktrees the user kept, and `git branch` shows only main plus kept branches.

## 4. Clear build output, logs, caches and test leftovers

Skip any directory an active `build-queue` job, delegate worker or dev server in this repo is using. Prefer the repo's own clean recipe (`just clean`, `bun run clean`, `make clean`); cover only what it misses from this list:

- Build output: `.build/`, `build/`, `out/`, `dist/`, `.next/`, `target/`, `.turbo/`, `zig-out/`, `.zig-cache/`, a `DerivedData/` inside the repo.
- Logs and test output: `*.log` at the root, `test-results/`, `coverage/`, `playwright-report/`, end-to-end evidence folders.
- Dependencies, only for a deep clean the user asked for: `node_modules/`, `Pods/`, `.venv/`.
- Test fixtures the repo's docs name, through the script they name. Keep anything with a `.keep` marker and the latest evidence a doc cites.

Before deleting a directory, confirm `git ls-files <dir>` prints nothing. Move to the Trash where the OS has one (`trash <dir>` on macOS 14+, `gio trash` on Linux) so a mistake can be undone; use `rm -rf` only for build output. Machine-wide caches (Xcode DerivedData for this project, SwiftPM, Gradle, simulators) only when the user asks.

Done when the cleared directories are gone and `git status --short` shows no deleted tracked files.

## 5. Report

One short block: branches merged (with tip SHA), worktrees and branches removed, space freed (`du -sh .` before and after), and what was kept and why (unmerged, dirty, in use, `.keep`). If you cleared build output, say that the next build starts cold and give its command.
