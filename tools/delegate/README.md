# delegate

Delegate coding tasks between Claude Code, Codex, Gemini CLI and Antigravity (agy). Run parallel agents in the background, on the logins you already have. A small native binary with no JS runtime. It makes no network calls of its own: the backends do that.

The [delegate skill](../../skills/delegate) teaches your agent how to use it.

Install the [CLI](#install) and run `delegate doctor` before the first task. From a project terminal, start with `delegate review --backend codex`, `delegate review --backend claude`, `delegate review --backend gemini` or `delegate review --backend agy`. Desktop notifications are optional.

## Use

```bash
delegate review
delegate review --backend gemini --model pro
delegate review --backend agy
delegate review --adversarial --base main --focus "retry safety"
delegate task "why does the login test hang?"
delegate task --write "fix the login test"
delegate result
delegate open
delegate continue "apply finding 1"
```

| Lead | Worker | Example |
| --- | --- | --- |
| Codex | Claude Code (or Gemini / Antigravity) | `delegate review` or `delegate review --backend gemini` |
| Claude Code | Codex (or Gemini / Antigravity) | `delegate review` or `delegate review --backend gemini` |
| Gemini CLI | Claude Code (or Codex / Antigravity) | `delegate review` or `delegate review --backend codex` |
| Antigravity | Claude Code (or Codex / Gemini) | `delegate review` or `delegate review --backend codex` |
| Cursor or a terminal | Codex, Claude Code, Gemini CLI or Antigravity | `delegate review --backend codex`, `claude`, `gemini` or `agy` |

In Cursor, run the command from the project terminal or ask Cursor Agent to run it. Cursor acts as a lead and reads `delegate result`. `delegate --help` lists everything, including `batch` for several lanes at once.

Background tasks and reviews print an exact result command. Keep the lane name, `--root` and `--run-id` together when passing it to `result`, `wait`, `open`, `answer`, `continue` or `stop`. The run ID protects against name reuse. Unnamed commands select lanes in the current project and orchestrator. Use `status --all` or `wait --all` to inspect or wait across the selected root. Use `delegate batch MANIFEST.json --dry-run` to check each lane's provider, model, checkout and permissions before launching it.

Use `delegate status` to find unanswered questions and their exact answer commands. `delegate status --json` returns the same scoped list with titles, run IDs, questions, retry times, and a `next.argv` array for each lane. When `next.requires_text` is true, append the user's answer before running the command. Add `--all`, `--session ID`, or `--archived` to change the scope.

For `task --write`, check the starting commit and worktree printed at launch. The worktree starts from that commit, so the lead's uncommitted changes stay in the original checkout. The result includes commands to inspect the worktree before adopting changes.

## Open the worker session

Workers are headless CLI sessions and never show up as chats in Codex, Claude or Gemini desktop apps. On macOS, `delegate open [NAME]` opens the lane's plain text report with its findings, fixes and questions, or reveals the lane folder with its logs when there is no report. Omit the name to pick the latest lane from the current project, or pass `--root` for a custom run directory. On Linux the command prints the report or folder path. `delegate result --json` returns the structured report for automation.

Use `delegate open NAME --terminal` to resume the same Codex, Claude, Gemini or Antigravity session in Terminal.app from its original folder. macOS may ask for permission to control Terminal the first time. Set `DELEGATE_OPEN_TARGET=terminal` when starting a lane to route its completion alert to Terminal as well.

Run `delegate notify NAME` to post a fresh test alert for a finished lane, then click its banner or its entry in Notification Center. Add `--terminal` to test Terminal instead. The click calls `delegate open`, which shows the report.

Question alerts open the report so the lead can use `delegate answer` to track the follow-up. `delegate result` prints the exact answer command. For a normal completion alert, the click opens the selected provider session. A notification from a replaced run cannot open its replacement.

## Clean up an orchestrator session

Delegate records the lead's `CODEX_THREAD_ID` when launched from Codex. From Claude Code, Cursor, or a terminal, set `DELEGATE_SESSION` to a unique ID before launching workers. Use the same ID across `task`, `review`, `run` and `batch` for that orchestrator. Existing lanes created without an ID are outside this cleanup.

```bash
DELEGATE_SESSION=my-review delegate review --backend codex
delegate archive --session my-review
delegate status --archived --session my-review
delegate restore --session my-review
```

`archive` hides finished lanes in Delegate while keeping reports available by name. `restore` brings them back. Chats that an older build archived with `archive --desktop` stay archived in Codex Desktop; unarchive them there. Running lanes and lanes waiting for input, access or a decision stay visible.

Use `delegate clear --session my-review` to preview removal of archived records. Add `--yes` to remove those local records, including reports, prompts and logs. Git worktrees remain available. Run cleanup from the lead to use its current session automatically, and pass `--root` if the lanes used a custom root.

Use `delegate prune` to preview finished local lane records older than seven days across all orchestrators in the default root. Use `delegate prune --days 1` for records older than 24 hours, and add `--yes` to remove the matches. Age is measured from the last recorded update. Running lanes, lanes waiting for input and Git worktrees are kept. Pass `--root` to prune a custom run directory.

## Install

Apple silicon Macs, with the [GitHub CLI](https://cli.github.com). It downloads the latest release and puts `delegate` in `~/.local/bin`:

```bash
mkdir -p ~/.local/bin && gh release download --repo ansumanshah/skills --pattern 'delegate-*-darwin-arm64.tar.gz' --output - | tar -xz -C ~/.local/bin delegate
```

```bash
delegate doctor
```

Each release also carries a `.sha256` file for the archive. On Linux or an Intel Mac, build it yourself.

## Build

Needs [bun](https://bun.sh), clang and `ar`. They are build-time only.

```bash
bun install
```

```bash
bun run build
```

Then put it on your PATH and check it. Use `install`, not `cp`: on Apple silicon, copying over an existing binary gets the new one killed.

```bash
mkdir -p ~/.local/bin && install -m 755 bin/delegate ~/.local/bin/delegate
```

If `~/.local/bin` is not on your PATH yet, add `export PATH="$HOME/.local/bin:$PATH"` to your shell profile and open a new terminal.

```bash
delegate doctor
```

### Alert icons on macOS

macOS takes a notification's icon from the app that sent it, so `osascript` alerts always show Script Editor. To get the Claude, Codex, Gemini or Antigravity icon, build one small notifier app per backend. It needs the Xcode command line tools:

```bash
bun run notifiers
```

It copies each icon from the app already installed on your Mac, ad-hoc signs the bundles and asks for notification permission. Click Allow on both prompts. Alerts show the project and model, using the model Claude reported when available. Clicking a new alert runs `delegate open` for that exact lane. Rebuild existing notifier apps with `bun run notifiers --no-request` to pick up click handling. Without these apps or notification permission, the `osascript` fallback shows the alert text. Use `delegate open` to navigate from a fallback alert.

Compiled with [scriptc](https://github.com/vercel-labs/scriptc), pinned to an exact version because it is still experimental. Its runtime (Apache-2.0) is linked into the binary.

## What it touches

- Starts `codex` and `claude` with your existing logins. It never reads or stores their credentials.
- Runs `git` for `review` and `task`, `ps` to identify its own processes, `cp` for `--spm-seed`, and whatever you pass to `build`.
- `task --write` makes a worktree and branch under `.worktrees/` in your repo, and adds that folder to git's local exclude file.
- Writes lane state to `~/.cache/delegate`, or the `root` you pass. Each lane's folder is private to your user. Prompts and transcripts stay there until you delete them.
- Passes your environment to each backend, as a shell would.
- Sends desktop alerts through its notifier apps if you built them, otherwise `osascript` or `notify-send`.
- Runs a hook only if you set `DELEGATE_HOOK` to an executable file, and on Codex only with `--no-lean`.
- Lean Claude lanes read your `~/.claude/settings.json` to carry over its deny rules, PreToolUse hooks and sandbox settings. Nothing else from that file is used. Read-only lanes keep only hooks limited to Read, Glob and Grep, because a hook that answers "allow" outranks the deny rules, and they turn off `autoAllowBashIfSandboxed`.
- `--xcode` adds Xcode and SwiftPM cache folders in your home to the Codex lane's writable roots.

Codex lanes are sandboxed by Codex. Claude lanes are not sandboxed: their tool allowlist is not a security boundary. A read-only Claude lane is best effort: it has no edit tools and only read-only git commands, with git's own write flags blocked. Git can still run programs named in a repo's own config, so don't point one at a repo you don't trust.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `DELEGATE_CODEX`, `DELEGATE_CLAUDE`, `DELEGATE_GEMINI` | found on PATH | Backend binary |
| `DELEGATE_BACKOFF` | `60,120,240,480` | Retry waits in seconds |
| `DELEGATE_BUILD_SLOTS` | `2` | Concurrent `build` commands |
| `DELEGATE_HOOK` | none | Script for backend lifecycle events |
| `DELEGATE_NO_NOTIFY` | off | Turn off desktop alerts |
| `DELEGATE_OPEN_TARGET` | report | Set to `terminal` to resume sessions in Terminal.app from `delegate open` and completion alerts |
| `DELEGATE_OSASCRIPT` | `/usr/bin/osascript` | Fallback alert program |
| `DELEGATE_NOTIFIERS` | `~/Applications/Delegate` | Folder holding the notifier apps |

## Test

```bash
bun run test
```

The suite drives the compiled binary against a fake backend. `DELEGATE_BIN` points it at another build.

## Package a release candidate

The first archive targets Apple silicon Macs. From this directory, run `bun install --frozen-lockfile`, `bun run build`, `bun run test` and `bun run package`. The archive and its SHA-256 checksum land in `dist/`. The archive includes the CLI and the licenses for its linked runtime. Notifier apps are built separately on the user's Mac so they can use the icons from locally installed apps.

The [release candidate workflow](../../.github/workflows/delegate.yml) builds and tests the same archive. Before publishing, extract the archive on a Mac, run `delegate doctor`, and click one notification from a completed Codex lane and one from a completed Claude lane. Attach the archive and checksum to a draft GitHub release with the version from `delegate --version`.
