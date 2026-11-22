# First run on macOS

Use the logged-in desktop session that owns the target window. If no tool was specified, reuse a working installed driver that meets the task. If a needed CLI is missing, install that one once setup is authorized. Follow the user's package manager and version preferences.

## Cua Driver

Run the official installer for macOS 14 or later. These options keep agent configuration and shell startup files intact.

```bash
(
  set -eu
  installer="$(mktemp -t cua-driver-install)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://cua.ai/driver/install.sh -o "$installer"
  /bin/bash "$installer" --no-connect --no-modify-path --no-test
)
```

Use the installed path printed by the installer if the current shell cannot find it. Check `cua-driver permissions status` and `cua-driver status`. If the installed service is stopped, start `cua-driver serve --no-automation-prompts` in a managed background process and retain its process handle. For initial access, `cua-driver permissions grant` opens the guide. The user enables Accessibility and Screen & System Audio Recording for the installed CuaDriver app. [Quickstart](https://cua.ai/docs/cua-driver/quickstart) · [Installer options](https://cua.ai/driver/install.sh)

## agent-desktop

Use `mise use -g npm:agent-desktop@latest` if the user uses mise. Homebrew users can run `brew install agent-desktop`. See the vendor guide for npm or release archives. Check `agent-desktop permissions`. For missing access, `agent-desktop permissions --guide` identifies the launching app that needs Accessibility or Screen Recording. [Install and permissions](https://github.com/vercel-labs/agent-desktop/blob/main/docs/install.md)

## Peekaboo

Homebrew users can install the notarized CLI with `brew install openclaw/tap/peekaboo`. With mise, select the release archive for the shell's architecture.

```bash
peekaboo_arch="$(uname -m)"
mise use -g "github:openclaw/Peekaboo[asset_pattern=peekaboo-macos-${peekaboo_arch}.tar.gz]@latest"
```

Check `peekaboo permissions status`. If Bridge and local results differ, check `peekaboo bridge status --verbose` and have the user grant access to the selected runtime. [Install](https://peekaboo.sh/install.html) · [Release assets](https://github.com/openclaw/Peekaboo/releases) · [Permissions](https://peekaboo.sh/quickstart.html)

## Verify and resume

Run the selected binary's `--version` after installation. Confirm readiness with a read of the intended window through the same runtime you will use for input. If access is missing, tell the user which app or host needs the grant and resume after they complete it.
