# Hybrid app checks

Use shell, accessibility, and pixels for the parts of the task each can prove. HCU exposes these channels in one agent loop. Here, this skill coordinates the channels while Cua supplies window targeting, batches, scripts, and observations. [HCU](https://github.com/microsoft/Hybrid-Computer-Use) · [Cua execution tools](https://cua.ai/docs/cua-driver/reference/mcp-tools/batch-recording-and-settings)

## Choose the method

Use shell for builds, fixture preparation, and logs when the task permits. For UI acceptance, drive the intended control and inspect the resulting UI or independent application state. For pixels, capture the bound window with the active driver. Use one controller on a shared desktop. Reserve a separate desktop or VM for workflows that need exclusive foreground control.

## Fixed actions

Replace the sample PID, window, selectors, and expected text with values from the target app. Choose a session label for this run. This batch waits for readiness, presses a known control, asserts the result, and returns one observation.

```json
{
  "session": "app-ui-check",
  "pid": 123,
  "window_id": 456,
  "delivery_mode": "background",
  "foreground_fallback": false,
  "steps": [{
    "tool": "click",
    "args": {"role": "button", "name": "Save"},
    "wait_for": {"text": "Ready", "timeout_ms": 2000},
    "expect": [{"text": "Saved", "timeout_ms": 2000}]
  }],
  "observe": {"query": "Saved", "include_screenshot": false}
}
```

Pass the object to `cua-driver call run_steps`. Check `ok`, each failed step's `phase`, and the returned observation. The `executed` count includes attempted steps that failed a readiness check. Split at a screen change when the next target needs observation.

## Logic between actions

Use `run_script` for branches, loops, and state checks between actions. Send the JavaScript body as `script` with the same named session, a task-sized `timeout_ms`, and a small `max_calls` budget. This example assumes a text value of Ready before saving.

```javascript
const app = await cua.getApp({pid: 123, windowId: 456});
const before = await app.query({text: "Ready"});
if (before.length !== 1 || before[0].value !== "Ready") {
  throw new Error("Unexpected starting state");
}
await app.click({role: "button", name: "Save"});
await app.waitFor({text: "Saved", timeout_ms: 2000});
const after = await app.query({text: "Saved"});
if (after.length !== 1 || after[0].value !== "Saved") {
  throw new Error("Save postcondition failed");
}
return {verified: true, evidence: after[0].value};
```

Read the returned `ok`, `value`, and call log. Keep shell and filesystem work in the agent's shell. Use `run_script` only when the installed driver advertises it.

## Recover and measure

A failed check stops the batch. Inspect the failed phase and current state before choosing another action. Resolve stale handles afresh and read back an uncertain effect before retrying a mutation. End this run's named session and release resources it owns when finished.

For comparisons, use the same fixtures and reset state between runs. Record verified completion, total elapsed time, driver calls, retries, image count, and focus changes. Use actual model token usage when available and label response-size proxies. The local fixture check in [evidence](macos-evidence.md#hybrid-fixture-check) covers both success and a blocked readiness condition.
