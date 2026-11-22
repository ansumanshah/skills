# Delegate batches and sandboxes

## Manifest root

Keep `root` where lanes cannot write. The tool refuses a root inside a lane's `dir`, and for Codex lanes also inside `/tmp`, `$TMPDIR` or an added folder, because a lane must not be able to edit its own state. Leave `root` out to use a folder in your cache.

## Lean lanes

Lanes start lean, without your user config, plugins or MCP servers. Lean Claude lanes keep your deny rules, PreToolUse hooks and sandbox settings, but lose other user settings such as `env`. Read-only ones keep only hooks limited to Read, Glob and Grep. Use `"lean": false` only if a lane needs them.

## Sandbox and approval flags by backend

- Codex: workspace-write with no network unless `network` is set. `.git` is read-only, so the lead commits.
- Claude: the tool allowlist reduces accidents but is not a security boundary, because it includes builds and `bun`, and either can run any command. `"sandbox": "read-only"` removes edits and builds, and ignores the repo's Claude settings. It can't be combined with `"lean": false`. On other Claude lanes the repo's `.claude/settings.json` still applies, including its hooks and allow rules. Override with `allowed_tools`.
- Gemini: `"sandbox": "read-only"` runs with `--approval-mode plan` (read-only mode) and `"workspace-write"` runs with `--approval-mode yolo`.
- Antigravity: `"sandbox": "read-only"` runs with `--mode plan`, and `"workspace-write"` runs with `--mode auto` (and adds `--sandbox` unless `network` is requested).

Only use Claude, Gemini or Antigravity lanes on repos you trust, and never give a lane credentials it could push with unless you mean to.
