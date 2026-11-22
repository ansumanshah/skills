# Desktop tool comparison

## Local results

On 9 November 2026, the installed CLIs were agent-desktop 1.2.0, Peekaboo 4.9.8, and Cua Driver 0.44.0 on arm64 macOS 27.2. The fixture was a background AppKit window containing a counter, one increment button, and six decoy buttons. Each trial opened a fresh fixture window, read count 0, pressed the unique button through accessibility, and verified count 1 from a new read. The shell used a permitted runtime route after its sandboxed checks could not reach the desktop services.

| Route | Verified | Median CLI loop | Median raw stdout |
| --- | ---: | ---: | ---: |
| Cua Driver, named session + `run_steps` with observation | 5/5 | 1.25 s | 1,948 bytes |
| Cua Driver, named session + separate click and read | 5/5 | 1.28 s | 1,788 bytes |
| Peekaboo, fresh AX-only JSON | 5/5 | 1.99 s | 16,593 bytes |
| agent-desktop, compact AX snapshots | 5/5 | 3.03 s | 3,588 bytes |
| Cua Driver, unnamed separate CLI calls | 0/5 | n/a | n/a |

The unnamed Cua click refused the token in all five trials. The named session resolved it. Cua's batched route took two measured calls. The other successful routes took three. The loop sums command wall time and stdout for observation, action, and verification. Fixture startup, window discovery, session cleanup, model inference, and image tokens are outside these numbers. Stdout bytes are a context-size proxy. A shell projection can shrink any tool's model-facing response, especially Peekaboo's JSON. The Cua reads used a targeted query, while the other two tools returned the compact tree or full element map for the small window.

An exact-window screenshot smoke check yielded readable images in all three tools. Peekaboo returned a 360 × 322 logical-size image, Cua returned 720 × 644 pixels, and agent-desktop returned 812 × 736 pixels with window padding. Use the actual image metadata for coordinate mapping. One capture per tool with different framing and scale provides no comparative capture timing.

Historical local notes record a successful agent-desktop Finder AX read and a successful Peekaboo AX-only Finder observation. Peekaboo window verification in that earlier session returned unknown despite finding elements. This benchmark covers a single native button and one window image. Text editing, app-specific menus, Electron, canvas input, and Windows/Linux performance have separate coverage needs.

## Capture recipes

Resolve the app and exact window first. Choose a file path for the capture and open only the image needed for the check.

- With **Cua Driver**, use `cua-driver call --screenshot-out-file window.png get_window_state '{"pid":123,"window_id":456,"include_accessibility_tree":false,"display_only":true}'`. Substitute the live PID and window ID. To ground coordinate input, omit `display_only` and pass the same named session used for the action.
- With **agent-desktop**, use `agent-desktop screenshot --app APP --window-id WINDOW window.png`. The file argument keeps base64 out of stdout.
- With **Peekaboo**, use `peekaboo see --window-id ID --no-elements --path window.png`. For AX only, use `peekaboo see --window-id ID --tree --no-screenshot`. Keep the explicit snapshot ID for actions.

## Platform and runtime

- **Cua Driver** documents macOS, Windows, and Linux support, with platform-specific limits on window capture and background input. Read the current platform guide and inspect the live tool schema. Exact target identity, token scope, and screenshot context matter when mixing AX and pixels. [How Cua Driver works](https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works) · [App, window, and screen tools](https://cua.ai/docs/cua-driver/reference/mcp-tools/apps-windows-and-screen)
- **agent-desktop** documents macOS, Windows, and Linux support. The accessibility backend determines which controls are usable. A strict semantic route can refuse duplicate controls or inaccessible surfaces. Use the platform guide shipped with the installed binary for compositor limits and supported surfaces. [agent-desktop FAQ](https://github.com/vercel-labs/agent-desktop/blob/main/docs/faq.md) · [Observation commands](https://github.com/vercel-labs/agent-desktop/blob/main/skills/agent-desktop/references/commands-observation.md)
- **Peekaboo** targets macOS. Exact-window pixel input needs a fresh screenshot receipt from the acting host. Check `peekaboo bridge status --verbose` and the selected host's permissions if capture fails. If `verify` returns unknown, observe the requested outcome again. [Peekaboo CLI reference](https://peekaboo.sh/cli-command-reference.html) · [Capture options](https://github.com/openclaw/Peekaboo/blob/main/docs/commands/see.md)

## Usability and evaluation ideas

- Choose the cheapest observation that can answer the next question. Use semantic lookup for a named control, pixels for visual evidence or an AX gap, and both when one modality is ambiguous. Save images to a file and load only those needed. [Cua observation and delivery model](https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works) · [Peekaboo observation shapes](https://peekaboo.sh/cli-command-reference.html)
- Reduce round trips by verifying with a bounded read or Cua's batched observation. Keep the same query scope for deltas and preserve structured refusal fields when filtering output. [Cua batch and script tools](https://cua.ai/docs/cua-driver/reference/mcp-tools/batch-recording-and-settings)
- To compare another workload, reset the same fixture, alternate tool order, hold the model and prompt constant for end-to-end tests, and define success in app state. Record verified outcomes, setup and loop time, calls and retries, text output, and images separately. Split cold and warm runs and include misses and focus disruption. Mac-native and ported tasks can give different rankings. [OSWorld](https://papers.nips.cc/paper_files/paper/2024/file/5d413e48f84dc61244b6be550f1cd8f5-Paper-Datasets_and_Benchmarks_Track.pdf) · [MacArena](https://arxiv.org/abs/2606.06560)

## Hybrid fixture check

On 11 November 2026, Cua Driver 0.44.0 was checked against the synthetic AppKit counter through a separate task-owned daemon and named session. A batch with `wait_for`, `expect`, and `observe` changed the counter from 0 to 1. A bounded `run_script` read the starting value, pressed the button, and verified 2. A missing readiness marker failed the first step in `wait_for`; a fresh read confirmed the counter stayed at 2. The fixture, named session, and test daemon were closed.

The initial check found the normal daemon stopped before input. Starting the installed signed driver on the separate test endpoint resolved that condition. This verifies the native batch and script patterns on one controlled window. Real application flows and model-to-model comparisons require their own checks.
