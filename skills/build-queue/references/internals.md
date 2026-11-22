# Build queue internals

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
