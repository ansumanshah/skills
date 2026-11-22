---
name: build-queue
description: Share one machine between parallel coding agents (Claude Code, Codex, Gemini CLI, Cursor) so heavy jobs stop starving each other of CPU and memory. Two jobs run at once; whole-machine jobs (Xcode, Gradle, VM, E2E) run alone with --solo. Kernel locks free themselves on crash, show who holds them and log every run. Use before running xcodebuild, swift build, gradle, cargo, expo run, a full test suite, a simulator run or a benchmark, when several agents or worktrees share one Mac, or when builds slow down, time out or fight over simulators.
---

# Build queue

`build-queue` gives the machine three slots. Two heavy jobs run at once across every repo, worktree and agent, and a third joins when memory is free; a `--solo` job waits for every slot and runs alone. Everything else runs unwrapped.

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

## How jobs fit together

- A slot job gets a parallelism cap of half the cores (`BUILD_QUEUE_JOBS` to change): `build-queue` adds `-jobs N` and `-maximum-parallel-testing-workers 2` to `xcodebuild`, `--max-workers=N` to `gradlew`, `--jobs N` to `swift build` and `swift test`, and sets `CARGO_BUILD_JOBS`. A flag you pass yourself wins. `--solo` jobs run uncapped.
- The caps apply when `build-queue` wraps the tool directly. Inside `bash -c` or a script only `CARGO_BUILD_JOBS` reaches it, which is one more reason to wrap the heavy step itself.
- Before starting beside a running job, `build-queue` checks free memory and waits while it is under 20% (`BUILD_QUEUE_MIN_FREE`), printing `build-queue: waiting for memory`. A job that would run alone always starts.
- A third job beside two needs twice that free memory (40%).
- `--status` marks any job holding a slot for over 30 minutes.
- SwiftPM locks a package's build folder, so a second `swift build`/`swift test` on the same package (same `--package-path` and `--scratch-path`) waits without taking a slot, leaving it to other jobs. `--solo swift build|test` runs as a slot job.

## Build caches

- `build-queue` turns on build caches: `COMPILATION_CACHE_ENABLE_CACHING=YES` on `xcodebuild` when a build action is named, and `--build-cache` on `gradlew`. A flag you pass yourself wins, including `--no-build-cache`.
- Gradle's cache is shared by every checkout. Xcode keeps its cache inside DerivedData, so a clean build or a worktree with its own DerivedData starts empty. Set `BUILD_QUEUE_XCODE_CACHE` to an absolute path outside DerivedData to share one cache: a clean build of a small app into a new DerivedData folder then hit the cache for 268 of 390 compile steps and took 19 s against 29 s with no cache. The folder grows (about 700 MB for that app) and nothing prunes it, so delete it when it gets large.
- When a run takes over three times what the same command usually takes, it prints `build-queue: cold build (412s, usually 50s)`. That checkout built from scratch: point it at the main checkout's build output, or fix what invalidated the cache, before the next run.
- `--log` marks those runs in the `cold` column.

## Keep jobs short

A slot is held for the job's whole run, so a shorter job frees it sooner for everyone.

- While iterating, run the narrowest test that covers the change: `swift test --filter LoginTests`, `./gradlew :app:testDebugUnitTest --tests '*Login*'`, `bun test login`. Run the full suite once, before you report done or open the PR.
- Reuse build output. In a new git worktree, point it at the main checkout's build cache if the project has a way to, so it does not build from scratch.
- After Android work, `./gradlew --stop` returns the Gradle and Kotlin daemons' memory to other jobs.
- `build-queue --log` shows each job's duration, peak memory and free memory at start. A job that runs long but stays small can drop `--solo`; one that peaks near the machine's memory needs it. Note that out-of-tree daemons (Gradle, Kotlin, `XCBBuildService`, Simulator) are not counted in `peak_mb`, so keep those `--solo`.

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
