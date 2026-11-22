# Mobile: iOS Simulator, iPhone, Android

| Tool | Platforms | Pick it for |
| --- | --- | --- |
| **agent-device** | iOS, Android, tvOS, macOS, HarmonyOS, physical devices | Default. `open <app> --foreground` starts a session and returns the initial interactive `@refs` (skip a redundant `snapshot`). Use `--settle` on `press`/`click`/`fill`/`scroll`/`back` to act, wait for quiet, and print only the UI diff. Use `wait text "..."` / `wait <selector>` / `wait absent <selector>` instead of polling, and `batch` / `replay` for fixed flows. Run `agent-device help <topic>` for gestures, TV, remote, debugging. |
| **sim-use** | iOS Simulator, Android emulator/device, physical iPhone | Smallest cold reads: `sim-use ui` prints a compact outline (~16x smaller than raw AX JSON), then `tap @N`. Also `#id`, `--label X --wait-timeout`, `paste` (bypasses IME for fast UTF-8 text), `keyboard-state`, `multi-touch`, `swipe`, `button`, `screenshot`, `record-video`. Android needs one-time `sim-use android init --udid <serial>`. `sim-use devices` lists targets. |
| **AXe** | iOS Simulator, iPhone | Raw HID and settings: `axe batch`, `settings` (location, status bar), `slider`, `clipboard`, `doctor`, `displays`. Every command needs `--udid`. `axe describe-ui --udid U`, `axe tap --label X --udid U`. |
| **mobilebuildmcp** (optional) | Apple | Build, run, test, debug, logs. Not UI driving. Without it, use `xcodebuild` and `xcrun simctl`. |

## Loop

1. Resolve the target only if ambiguous (`xcrun simctl list devices booted`, `adb devices`, or `sim-use devices`). With `agent-device`, `open <app> --foreground` already returns initial `@refs`; resume an open session instead of reopening.
2. Act with `--settle` (`press @e2 --settle`, `fill @e3 "text" --settle`) and continue from the returned diff. Run `snapshot -i` only when the diff lacks the next target or did not settle. Use `batch` for known multi-step sequences.
3. Verify a named expectation with the diff, `wait text "..."`, or a screenshot of the screen, not the exit code. Coordinates are last resort.
4. Close the session; shut down a simulator you booted.

## Rules

- Don't mix tools mid-flow on one device: refs and aliases are per tool and go stale on any other tool's action.
- Android: `adb` for install, logcat and shell only. Drive the UI through agent-device or sim-use.
- Real-keyboard, visualViewport and momentum behaviour in web pages needs Simulator Safari through agent-device, not browser emulation.
- Use `axe` for touch events no other tool exposes, and for status-bar or location overrides in screenshots.
- For repeatable CI E2E flows on mobile, Maestro YAML flows (via Maestro MCP if installed) beat hand-rolled shell loops.
- To compare tools, use the same screen, a fresh install, and count verified outcome, calls, output bytes and time. Record results here.
