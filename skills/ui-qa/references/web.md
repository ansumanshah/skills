# Web

Default: `agent-browser` via Bash. `agent-browser skills get core` prints the version-matched guide; `--full` adds the command reference. Specialized skills: electron, slack, exploratory testing.

```bash
agent-browser --session app-qa open <url>            # isolate tabs across parallel agents
agent-browser --session app-qa snapshot -i           # interactive refs only
agent-browser --session app-qa batch "fill @e2 'a'" "click @e3" "wait --text 'Saved'"
agent-browser --session app-qa diff snapshot         # only what changed since last snapshot
agent-browser --engine lightpanda open <url>         # fast non-visual DOM/JS checks (~24MB RAM)
agent-browser read <url>                             # agent-readable text, no browser round trip
```

| Need | Use |
| --- | --- |
| Fast non-visual DOM/JS checks, forms, scraping | `agent-browser --engine lightpanda` (fallback to default Chrome on Web API gaps) |
| Visual QA, CSS layout, screenshots | `agent-browser` (default Chrome) + `diff screenshot --baseline` |
| Multi-step known flows | `agent-browser batch` (one shell call instead of one turn per click) |
| Parallel agents on one machine | `agent-browser --session <name>` (and `close` when done) |
| Repeatable E2E or CI | Playwright specs (or `--capture flow` to record); probe state, not screenshots |
| Lighthouse, traces, heap, network debugging | chrome-devtools (enable per repo only) |
| Logged-in real Chrome | claude-in-chrome or `agent-browser --auto-connect` |
| Software keyboard, visualViewport, momentum | Simulator Safari via agent-device ([mobile](mobile.md)) |
| Electron or Tauri app | agent-browser electron skill, then macOS tools for native chrome |

- Prefer `diff snapshot` after actions instead of re-reading full snapshots.
- `--engine obscura` (experimental Rust + V8) is an alternative non-visual engine with stealth/anti-fingerprinting, but rejects `NO_PROXY` / `--proxy-bypass`; stick to `lightpanda` or `chrome` unless needed.
- In the Claude desktop app, `Claude_Browser` is the built-in pane and is preferred for dev servers there.
