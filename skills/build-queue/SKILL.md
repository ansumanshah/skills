---
name: build-queue
description: Queue heavy builds and tests so parallel agents share one machine; whole-machine jobs run alone with --solo. Use before xcodebuild, swift build, gradle, cargo, expo run, a full test suite, a simulator run or a benchmark, when several agents share one Mac, or when builds are slow or fight over simulators.
---

# Build queue

Two heavy jobs run at once across every repo, worktree and agent, and a third joins when memory is free. A `--solo` job waits for every slot and runs alone. Everything else runs unwrapped.

Works on macOS (`/usr/bin/lockf`) and Linux (`flock`). If `build-queue` is not on PATH, the copy that ships with this skill is `scripts/build-queue` next to this file. Offer the user `mkdir -p ~/.local/bin && install -m 755 <this skill's folder>/scripts/build-queue ~/.local/bin/build-queue` and install only on their yes. Until it is installed, run commands unwrapped and say that nothing is limiting parallel builds.

## Use

Wrap the heavy command itself, and nothing around it. The slot is held for as long as the wrapped command runs, so a wrapped session or chain holds it through every idle minute.

```bash
build-queue --solo xcodebuild -scheme App test
build-queue --solo ./gradlew assembleRelease
build-queue swift test
build-queue bun run test
```

| Wrap with | Jobs |
|---|---|
| `build-queue --solo` | Xcode builds and tests, Gradle, Expo prebuild/run, Cargo release builds, VM or emulator boots, full E2E or simulator suites |
| `build-queue` | SwiftPM builds and tests, a full JS/TS or Go test suite, Tauri dev builds, packaging, benchmarks |
| nothing | edits, `git`, linters, typechecks, a single fast test, read-only commands, QA sessions, orchestration scripts, agent loops |

In a long script or a chain (`a && b && c`), wrap only the heavy step inside it: `prep && build-queue --solo ./gradlew test && report`. If a wrapped script calls `build-queue` again internally, it passes straight through without taking a second slot (except nesting `--solo` inside a slot job, which exits `64` instead of deadlocking).

## Caps and caches

- Parallelism caps and build-cache flags are added automatically only when `build-queue` wraps the tool directly, not inside `bash -c` or a script (only `CARGO_BUILD_JOBS` reaches those). A flag you pass yourself wins.
- `BUILD_QUEUE_XCODE_CACHE` set to an absolute path outside DerivedData shares one Xcode cache across checkouts. Nothing prunes it, so delete it when it gets large.
- When a run takes over three times what the same command usually takes, it prints `build-queue: cold build (412s, usually 50s)`. That checkout built from scratch: point it at the main checkout's build output, or fix what invalidated the cache, before the next run. `--log` marks those runs in the `cold` column.
- Read [internals](references/internals.md) when tuning slots, caps or caches, or when a job behaves unexpectedly.

## Keep jobs short

A slot is held for the job's whole run, so a shorter job frees it sooner.

- While iterating, run the narrowest test that covers the change (`swift test --filter LoginTests`, `bun test login`). Run the full suite once, before you report done.
- After Android work, `./gradlew --stop` returns the daemons' memory to other jobs.
- `build-queue --log` shows each job's duration, peak memory and free memory at start. A job that runs long but stays small can drop `--solo`; one that peaks near the machine's memory needs it. Out-of-tree daemons (Gradle, Kotlin, `XCBBuildService`, Simulator) are not counted in `peak_mb`, so keep those `--solo`.

## When the slots are busy

`build-queue` waits 10 seconds, then skips the command, exits `75` and prints who holds each slot:

```
build-queue: skipped after 10s
slot 0: held 2m10s by pid 123 in ~/code/app: xcodebuild test
slot 1: held 0m40s by pid 456 in ~/code/api: swift test
```

Exit `75` together with that `build-queue: skipped` line means the job never ran. It is not a test failure. Exit `75` without the line came from your command itself. After a skip, pick one:

- Queue it: `build-queue --wait <command>` (waits up to 1800s; or `--timeout <sec>` / `BUILD_QUEUE_TIMEOUT=1800`), run in the background, and wait for it to finish.
- Do other work and try once more later.

Never retry in a loop, and never kill a holder.

## Inspect

```bash
build-queue --status   # "free" (exit 0), or who holds each slot (exit 1)
build-queue --log 10   # last 10 runs: started, waited, duration, exit, peak_mb, free_pct, mode, cold, checkout, command
```

The kernel drops a slot when its job exits, so a crashed agent never leaves it stuck. A waiting `--solo` job stops new jobs from starting, so it is not starved. `BUILD_QUEUE_SLOTS=2` drops the third slot on a small machine.
