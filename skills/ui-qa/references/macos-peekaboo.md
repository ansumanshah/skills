# Peekaboo quick reference

Verified against Peekaboo 4.9.8. Run `peekaboo learn` for the full agent guide and `peekaboo <command> --help` for flags.

## Loop

```bash
peekaboo window list --app APP --json                 # resolve the exact window id
peekaboo see --window-id ID --tree --no-screenshot --json   # AX only, cheapest read
peekaboo see --window-id ID --path /tmp/w.png         # element map + exact-window image, prints a snapshot id
peekaboo click "Save" --snapshot SNAP --app APP       # query or --on <element id> from that see
peekaboo type "text" --snapshot SNAP --clear          # background; confirms via AX readback
peekaboo press return --app APP                       # keys and chords
peekaboo verify --app APP --on button:Reload --exists --enabled --json   # polls until stable, no sleeps
```

`verify` returns satisfied, unsatisfied, or unknown; unknown is not success, so re-observe. `--on` takes an AXIdentifier or `role:label`, not a snapshot element id (use `ui_elements[].identifier` from `see --json`). Also `--value-equals`, `--window-bounds`, `--window-exists`.

- Reuse the snapshot id from the latest `see` of the same window. Re-run `see` after any UI change.
- `see --roi x,y,w,h` crops to window-local points; `--depth`, `--max-elements`, `--max-children` bound the AX tree.
- Background is the default for `click`, `type`, `menu`. Background coordinate clicks need `--snapshot` from a fresh exact-window `see`. Add `--foreground` only with consent.
- `type` success needs a confirmed receiver change; `--accept-dispatched` is unverified and retry-unsafe. Read back before repeating.

## Other commands worth knowing

| Need | Command |
| --- | --- |
| Menu path | `menu click --app APP --path "Format > Font > Show Fonts"`, `menu list --app APP` |
| Status-bar items | `menubar` |
| Set a field without typing | `set-value`, `action` (named AX action) |
| Select text or place a caret | `select-text` |
| Dialogs and alerts | `dialog` |
| Window geometry | `window move/resize/set-bounds/focus` |
| Launch without stealing focus | `app launch NAME` (existing process only); `--foreground` to open |
| Clipboard | `clipboard`, `paste` (restores previous clipboard) |
| Chrome page content | `browser` (prefer agent-browser for web work) |
| Sanity check | `permissions status`, `bridge status --verbose` |

## When Peekaboo is the right pick

Annotated, cropped, or ROI captures; `menubar`/`dialog`/`dock`/`space` coverage that the other two lack; video frame extraction via `capture`. For interaction loops prefer Cua Driver (batches, scripts, token-scoped reads).

`peekaboo agent` runs Peekaboo's own LLM agent. Do not use it: this skill keeps the loop in the calling agent.
