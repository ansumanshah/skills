# Desktop tool comparison

## Tool routing

Cua Driver with a named session is fastest and smallest for verified accessibility actions, and its `run_steps` batch saves a call. Peekaboo returns large AX output, so use it for annotated or cropped captures. agent-desktop is slower but returns compact scoped trees.

## Capture recipes

Resolve the app and exact window first. Choose a file path for the capture and open only the image needed for the check.

- With **Cua Driver**, use `cua-driver call --screenshot-out-file window.png get_window_state '{"pid":123,"window_id":456,"include_accessibility_tree":false,"display_only":true}'`. Substitute the live PID and window ID. To ground coordinate input, omit `display_only` and pass the same named session used for the action.
- With **agent-desktop**, use `agent-desktop screenshot --app APP --window-id WINDOW window.png`. The file argument keeps base64 out of stdout.
- With **Peekaboo**, use `peekaboo see --window-id ID --no-elements --path window.png`. For AX only, use `peekaboo see --window-id ID --tree --no-screenshot`. Keep the explicit snapshot ID for actions.

## Platform and runtime

- **Cua Driver** documents macOS, Windows, and Linux support, with platform-specific limits on window capture and background input. Read the current platform guide and inspect the live tool schema. Exact target identity, token scope, and screenshot context matter when mixing AX and pixels. [How Cua Driver works](https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works) · [App, window, and screen tools](https://cua.ai/docs/cua-driver/reference/mcp-tools/apps-windows-and-screen)
- **agent-desktop** documents macOS, Windows, and Linux support. The accessibility backend determines which controls are usable. A strict semantic route can refuse duplicate controls or inaccessible surfaces. Use the platform guide shipped with the installed binary for compositor limits and supported surfaces. [agent-desktop FAQ](https://github.com/vercel-labs/agent-desktop/blob/main/docs/faq.md) · [Observation commands](https://github.com/vercel-labs/agent-desktop/blob/main/skills/agent-desktop/references/commands-observation.md)
- **Peekaboo** targets macOS. Exact-window pixel input needs a fresh screenshot receipt from the acting host. Check `peekaboo bridge status --verbose` and the selected host's permissions if capture fails. If `verify` returns unknown, observe the requested outcome again. [Peekaboo CLI reference](https://peekaboo.sh/cli-command-reference.html) · [Capture options](https://github.com/openclaw/Peekaboo/blob/main/docs/commands/see.md)
