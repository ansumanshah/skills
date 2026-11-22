# skills

Skills for coding agents that do real work on real machines: run several agents at once, check the actual app, and take a change all the way to a merged pull request.

They work in Claude Code, Codex, Gemini CLI, Cursor and any agent that reads `SKILL.md` files. Each one is a short Markdown file you can read in a minute and edit to fit how you work.

Three agents, one Mac, nothing fighting:

```bash
delegate task --write --backend codex --name fix-login "fix the login test"   # Codex works in its own worktree
delegate review --backend gemini --background                                 # Gemini reviews your diff meanwhile
build-queue --solo xcodebuild -scheme App test                                   # your build waits its turn
```

```
build-queue: skipped after 10s
slot 0: held 2m10s by pid 123 in ~/code/app: xcodebuild test
slot 1: held 0m40s by pid 456 in ~/code/api: swift test
```

## Install

Claude Code:

```bash
claude plugin marketplace add ansumanshah/skills
```

```bash
claude plugin install parallel-agents@ansumanshah
```

Codex:

```bash
codex plugin marketplace add ansumanshah/skills
```

```bash
codex plugin add parallel-agents@ansumanshah
```

Gemini CLI:

```bash
gemini extensions install https://github.com/ansumanshah/skills
```

Cursor, Amp, OpenCode and other agents, everything or one skill:

```bash
npx skills add ansumanshah/skills -g
```

```bash
npx skills add ansumanshah/skills --skill grill
```

Pick one install method per agent. Two of them give you every skill twice.

Skills run with your agent's permissions. Read one before you install it.

## Skills

### Run agents

| Skill | What it does |
|---|---|
| [delegate](skills/delegate) | Hand a task or a review to another model (Claude Code, Codex, Gemini CLI, Antigravity) and keep working while it runs. Needs the [delegate CLI](tools/delegate). |
| [build-queue](skills/build-queue) | Two heavy jobs at a time, a third when memory is free, Xcode and Gradle alone, with shared build caches turned on, so parallel agents stop fighting over one machine. Ships the `build-queue` script. |
| [ui-qa](skills/ui-qa) | Run the app and check it the way a user would, on macOS, iOS, Android and the web. |

### Ship pull requests

| Skill | What it does |
|---|---|
| [ship-pr](skills/ship-pr) | Takes a change to a merged PR while you are away: proves it, reviews it, opens it, watches CI, merges. |
| [ready-pr](skills/ready-pr) | The same, but stops with the PR ready for you to merge. |
| [second-opinion](skills/second-opinion) | A reviewer from another model provider checks the diff in rounds until you both agree. Panel mode runs three providers at once and scores each round, for changes that must not break. |
| [open-pr](skills/open-pr) | A short PR that starts with the problem and ends with a test plan. |
| [watch-pr](skills/watch-pr) | Watches CI and review bots, fixes what is real and answers what is not. Ships `pr-watch`. |
| [take-over](skills/take-over) | Finishes someone else's PR, branch or agent session and keeps their credit. |
| [stale-pr](skills/stale-pr) | Rebases an old PR and decides whether it should still exist. |
| [reply-pr](skills/reply-pr) | Formats every comment an agent posts for you, so readers know a model wrote it. |
| [repo-cleanup](skills/repo-cleanup) | Shows what takes space and what can go, merges finished branches to main, removes merged worktrees and branches, and clears build output, logs and caches. Keeps anything unmerged. |

### Think and write

| Skill | What it does |
|---|---|
| [grill](skills/grill) | Interviews you about a plan in rounds, with a recommended answer for every question, until nothing is left assumed. |
| [tdd](skills/tdd) | Red, then green, one behaviour at a time, at boundaries you agreed on. |
| [human-steps](skills/human-steps) | Writes a script that walks you through the steps only you can do: dashboards, API keys, secrets. The agent never sees the values. |
| [skill-writing](skills/skill-writing) | How to write skills and AGENTS.md files that trigger when they should and get followed the same way every time. |

The PR skills call each other, so install them together. They use `delegate`, `build-queue` and `ui-qa` when those are installed and fall back to your agent's own tools when not.

## Tools

Three skills ship a small program. None of them sends data anywhere except the services you already use.

| Tool | What it is | Needs |
|---|---|---|
| [`delegate`](tools/delegate) | Runs headless Claude Code, Codex, Gemini CLI and Antigravity workers on the logins you already have, with retries, reports and desktop alerts. A native binary. | macOS or Linux, the agent CLIs you want to use |
| [`build-queue`](skills/build-queue/scripts/build-queue) | A small shell script with three job slots and a `--solo` mode. Slots free themselves if a job crashes. | macOS (`lockf`) or Linux (`flock`) |
| [`pr-watch`](skills/watch-pr/scripts/pr-watch) | Prints one line per real PR event and exits when the PR is green or ready. Standard library Python. | macOS, Linux or WSL, Python 3.9+, an authenticated [GitHub CLI](https://cli.github.com) |

`ui-qa` uses existing UI drivers (Cua Driver, agent-desktop, Peekaboo, agent-device, agent-browser). Its [first-run setup](skills/ui-qa/references/macos-setup.md) covers installing them and granting macOS access.

## Contributing

Run the repo check before every commit:

```bash
bun scripts/check.ts
```

It checks every skill's front matter and the plugin manifests, and blocks home paths, tokens and em-dashes. CI also runs the tests for `delegate`, `build-queue` and `pr-watch`.

## License

[MIT](LICENSE)
