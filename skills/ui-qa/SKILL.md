---
name: ui-qa
description: Drive and verify real app UI on macOS, iOS Simulator, iPhone, Android and web, using agent-device, agent-browser or desktop drivers. Use for UI QA, "run the app and check it", tapping, typing, screenshots, accessibility reads.
---

# UI QA

One loop everywhere: resolve the exact target, read narrowly, act by element, verify the outcome. Honor a requested tool or interaction method. Shell is for builds, fixtures and logs only.

## Route first

| Target | Primary | Also | Reference |
| --- | --- | --- | --- |
| macOS app window | Cua Driver | agent-desktop (scoped AX), Peekaboo (annotated/cropped captures) | below, [peekaboo](references/macos-peekaboo.md) |
| iOS Simulator / iPhone | agent-device | sim-use (compact outline, `@N` taps), AXe (raw HID, batch, settings) | [mobile](references/mobile.md) |
| Android emulator / device | agent-device | sim-use | [mobile](references/mobile.md) |
| Web page | agent-browser | Playwright specs for repeatable E2E; chrome-devtools for traces | [web](references/web.md) |
| Xcode build, run, test, debug | `xcodebuild` / `xcrun simctl` | `mobilebuildmcp` CLI if installed | project docs |

Check the chosen CLI with `command -v` on first use. macOS setup and permissions: [first-run setup](references/macos-setup.md).

## macOS: execute and prove

Define the visible outcome, then resolve the exact executable, PID, and window.

- With **Cua Driver**, keep one named `session` across CLI calls. Read narrowly with `query` and `include_screenshot:false`. Batch known actions using `run_steps` with readiness checks, result assertions, and one scoped `observe`. Reuse its evidence. For decisions between actions, use `run_script` with explicit time and call limits.
- With **agent-desktop**, use a compact window snapshot or scoped role/name `find`, `get`/`is` for targeted state checks, and `set-value` for fast text entry. For large trees, use `--skeleton --compact` then `--root`. Add `-i` when only interactive controls matter. Keep full qualified refs. Run `agent-desktop skills get desktop` for the version-matched guide.
- For later Cua reads, use `since:"latest"` with the same scope and fresh tokens. Narrow or expand an incomplete tree before using absence as evidence.

For UI acceptance, exercise the intended control and verify the result in app state or rendered output. For visual comparisons, match capture tool, window size, appearance, scale, and data. Skip AX for pixel-only checks and load only relevant evidence.

Keep one controller per desktop and default to background delivery. On a shared machine, isolate web runs with `agent-browser --session <name>` and wrap simulator/emulator boots or full E2E runs in `build-queue --solo` when installed. Refresh stale handles in the same session. On a tool switch, resolve the target again. Ground coordinates in the acting tool's fresh capture. Inspect partial or uncertain effects before another input, and honor permissions and focus limits.

Read [hybrid flows](references/macos-hybrid.md) only for Cua batches, scripts, recovery, or measurement. For per-tool screenshot commands, read [capture recipes](references/macos-evidence.md#capture-recipes). Check unfamiliar options against the installed tool's help or schema.
