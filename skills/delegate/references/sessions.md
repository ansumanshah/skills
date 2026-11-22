# Delegate sessions, reports and cleanup

## Open a worker

- Workers are headless CLI sessions. They never appear as chats in Codex, Claude or Gemini desktop apps. On macOS, `delegate open [NAME]` or a click on a completion alert opens the readable text report. On Linux it prints the report or lane folder path. `delegate result --json` returns the structured report for automation. Use `--title` with `review` or `task` to set the report title.
- Use `delegate open NAME --terminal` to resume the worker's session in Terminal.app. Set `DELEGATE_OPEN_TARGET=terminal` on launch to send the lane's completion alert there. To test a click without another worker run, use `delegate notify NAME` or `delegate notify NAME --terminal` and click the new alert in Notification Center.

## Follow-up targeting

Use the launch's lane name, `--root` and `--run-id` together in follow-up commands. Without a name, selection stays within the current project and orchestrator. `result` shows the newest lane. `answer`, `continue` and `stop` require a name if more than one lane matches. For a question, use the answer command printed by `delegate result` so the follow-up stays tracked.

## Session grouping

Delegate groups workers by the lead's session ID: the Codex thread ID in Codex, the conversation ID in Antigravity, and `DELEGATE_SESSION` everywhere else. Pass `--session ID` from another session and `--root` for a custom run root.

## Archive, restore, clear, prune

- `delegate archive` when the orchestrator is finished; `delegate restore` brings those workers back.
- `delegate clear` previews archived local records and removes them only with `--yes`.
- `delegate prune` previews finished local records older than seven days across all orchestrators in the selected root. Use `--days N` for a different cutoff and `--yes` to remove the matches when authorized. Worktrees stay available.
