# Size survey

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
