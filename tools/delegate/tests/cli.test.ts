// Runner behaviour against a fake backend: `bun test`. No model is called and HOME is a temp folder.
// DELEGATE_BIN tests another build. Bun is only the test runner here; the tool never needs it.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

setDefaultTimeout(40_000);

const TOOL = path.resolve(import.meta.dir, "..");
const RUNS = path.join(TOOL, ".test-runs"); // outside /tmp and $TMPDIR, which a Codex lane can write
const BIN = process.env.DELEGATE_BIN || path.join(TOOL, "bin/delegate");
const FAKE = path.join(import.meta.dir, "fakes/codex");
const SCHEMA = path.join(TOOL, "schemas/report.schema.json");
const ACTIVE = ["queued", "running", "retrying"];
const REPORT = { status: "done", summary: "ok", files_changed: [], questions: [] };
const THREAD = { type: "thread.started", thread_id: "t1" };
const DONE = { type: "turn.completed", usage: {} };
const CLAUDE_OK = { type: "result", subtype: "success", structured_output: REPORT, usage: {} };

type Call = { argv: string[]; stdin: string; pid: number };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  }).stdout.trim();
  return Boolean(stat) && !stat.startsWith("Z");
}

let work: string;
let base: string;
let root: string;
let prompt: string;
let log: string;
let env: Record<string, string>;
let drivers: ChildProcess[];

const scenario = (...steps: object[]) =>
  fs.writeFileSync(env.FAKE_SCENARIO!, JSON.stringify(steps));
const cli = (...args: string[]) =>
  spawnSync(BIN, [...args, "--root", root], { env, encoding: "utf8", timeout: 20_000 });
const state = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "a/state.json"), "utf8"));
  } catch {
    return {};
  }
};
const calls = (): Call[] =>
  fs.existsSync(log)
    ? fs
        .readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];

function start(backend = "codex", ...extra: string[]): ChildProcess {
  const proc = spawn(
    BIN,
    [
      "run",
      "a",
      "--dir",
      work,
      "--prompt",
      prompt,
      "--root",
      root,
      "--backend",
      backend,
      "--schema",
      SCHEMA,
      ...extra,
    ],
    { env, stdio: "ignore" },
  );
  drivers.push(proc);
  return proc;
}

async function until(check: () => unknown, timeout = 15_000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out; state=${JSON.stringify(state())} calls=${calls().length}`);
}

async function exited(proc: ChildProcess, timeout = 25_000): Promise<void> {
  await until(() => proc.exitCode !== null || proc.signalCode !== null, timeout);
}

async function settle() {
  await until(() => state().status && !ACTIVE.includes(state().status));
  return state();
}

async function runToEnd(steps: object[], backend = "codex", ...extra: string[]) {
  scenario(...steps);
  await exited(start(backend, ...extra));
  return state();
}

beforeEach(() => {
  base = fs.realpathSync(
    fs.mkdtempSync(path.join((fs.mkdirSync(RUNS, { recursive: true }), RUNS), "lane-")),
  );
  root = path.join(base, "runs");
  work = path.join(base, "work");
  fs.mkdirSync(work);
  prompt = path.join(base, "prompt.md");
  log = path.join(base, "fake.log");
  fs.writeFileSync(prompt, "do the thing");
  drivers = [];
  env = {
    ...process.env,
    HOME: base,
    DELEGATE_BACKOFF: "0,0",
    DELEGATE_NO_NOTIFY: "1",
    DELEGATE_HOOK: "/usr/bin/true",
    DELEGATE_CODEX: FAKE,
    DELEGATE_CLAUDE: FAKE,
    DELEGATE_GEMINI: FAKE,
    DELEGATE_AGY: FAKE,
    DELEGATE_NO_BUILD_QUEUE: "1",
    FAKE_LOG: log,
    FAKE_SCENARIO: path.join(base, "scenario.json"),
  } as Record<string, string>;
  for (const key of ["CLAUDECODE", "CODEX_THREAD_ID", "CODEX_SANDBOX", "GEMINI_CLI", "ANTIGRAVITY_AGENT", "ANTIGRAVITY_CONVERSATION_ID", "DELEGATE_SESSION", "DELEGATE_OPEN_TARGET"]) delete env[key];
});

afterEach(() => {
  for (const proc of drivers)
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  for (const call of calls()) if (alive(call.pid)) process.kill(call.pid, "SIGKILL");
  fs.rmSync(base, { recursive: true, force: true });
});

describe("reports", () => {
  test("a failed continue does not reuse the previous report", async () => {
    const first = await runToEnd([
      { lines: [THREAD, DONE], report: REPORT },
      { lines: [{ type: "turn.failed", error: { message: "boom" } }], exit: 1 },
    ]);
    expect(first.status).toBe("done");
    cli("continue", "a", "more");
    await until(() => calls().length === 2);
    const last = await settle();
    expect(last.status).toBe("failed");
    expect(last.detail).toContain("boom");
  });

  test("a transient error followed by success is not retried", async () => {
    const final = await runToEnd([
      {
        lines: [THREAD, { type: "error", message: "at capacity, reconnecting 1/5" }, DONE],
        report: REPORT,
      },
    ]);
    expect(final.status).toBe("done");
    expect(calls().length).toBe(1);
  });

  test("a report status outside the known set still ends the lane", async () => {
    const final = await runToEnd([
      { lines: [THREAD, DONE], report: { status: "approved", summary: "fine" } },
    ]);
    expect(final.status).toBe("partial");
  });

  test("a missing backend binary fails instead of crashing the driver", async () => {
    env.DELEGATE_CODEX = path.join(base, "missing");
    const final = await runToEnd([{}]);
    expect(final.status).toBe("failed");
    expect(final.detail).toContain("exited with an error");
  });
});

describe("hangs", () => {
  test("idle timeout kills the backend and fails the lane", async () => {
    const final = await runToEnd([{ lines: [THREAD], sleep: 60 }], "codex", "--idle-timeout", "1");
    expect(final.status).toBe("failed");
    expect(final.detail).toContain("no output");
    await until(() => !alive(calls()[0]!.pid));
  });

  test("a descendant holding stdout does not block the lane", async () => {
    const final = await runToEnd([{ lines: [THREAD, DONE], report: REPORT, holder: 30 }]);
    expect(final.status).toBe("done");
  });

  test("status fails a lane whose driver died and kills its backend", async () => {
    scenario({ lines: [THREAD], sleep: 60 });
    const driver = start();
    await until(() => calls().length && state().pid);
    driver.kill("SIGKILL");
    await exited(driver);
    expect(cli("status").stdout).toContain("failed");
    expect(state().detail).toContain("driver");
    await until(() => !alive(calls()[0]!.pid));
  });

  test("wait returns after a driver dies", async () => {
    scenario({ lines: [THREAD], sleep: 60 });
    const driver = start();
    await until(() => calls().length && state().pid);
    driver.kill("SIGKILL");
    await exited(driver);
    expect(cli("wait", "--poll", "1").status).toBe(0);
  });

  test("a lane from the older runner is never reconciled", () => {
    fs.mkdirSync(path.join(root, "a"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "a/state.json"),
      JSON.stringify({
        name: "a",
        status: "running",
        pid: 999999,
        updated: "2020-01-01T00:00:00Z",
      }),
    );
    cli("status");
    expect(state().status).toBe("running");
  });

  test("a resumed lane without a driver yet is not failed inside the grace period", () => {
    fs.mkdirSync(path.join(root, "a"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "a/state.json"),
      JSON.stringify({
        name: "a",
        status: "running",
        driver_pid: null,
        updated: new Date().toISOString(),
      }),
    );
    cli("status");
    expect(state().status).toBe("running");
  });
});

describe("stop", () => {
  test("stops a running lane, which can then continue", async () => {
    scenario({ lines: [THREAD], sleep: 60 }, { lines: [THREAD, DONE], report: REPORT });
    const driver = start();
    await until(() => calls().length && state().thread_id);
    expect(cli("stop", "a").status).toBe(0);
    await exited(driver, 10_000);
    expect(state().status).toBe("stopped");
    await until(() => !alive(calls()[0]!.pid));
    cli("continue", "a", "go on");
    await until(() => calls().length === 2);
    expect((await settle()).status).toBe("done");
  });

  test("status during a slow stop does not report a dead driver", async () => {
    // a shell backend that ignores SIGTERM for a moment, keeping the stop window open
    const slow = path.join(base, "codex");
    fs.writeFileSync(
      slow,
      '#!/bin/sh\ntrap "sleep 1; exit 0" TERM\necho \'{"type":"thread.started","thread_id":"t1"}\'\nsleep 60 &\nwait\n',
    );
    fs.chmodSync(slow, 0o755);
    env.DELEGATE_CODEX = slow;
    scenario({});
    start();
    await until(() => state().thread_id);
    const stopper = spawn(BIN, ["stop", "a", "--root", root], { env, stdio: "ignore" });
    drivers.push(stopper);
    await until(() => state().stopping);
    expect(cli("continue", "a", "overlap").stderr).toContain("another start or resume is in progress");
    const seen = new Set<string>();
    while (stopper.exitCode === null) {
      cli("status");
      seen.add(state().status);
      await Bun.sleep(20);
    }
    expect(seen.has("failed")).toBe(false);
    expect(state().status).toBe("stopped");
  });

  test("stop and idle kill take down tools that ignore SIGTERM", async () => {
    const stubborn = path.join(base, "codex");
    const pidFile = path.join(base, "tool.pid");
    fs.writeFileSync(
      stubborn,
      `#!/bin/sh
echo '{"type":"thread.started","thread_id":"t1"}'
/bin/sh -c 'trap "" TERM; echo $$ > ${pidFile}; exec /bin/sleep 60' >/dev/null 2>&1 &
sleep 60
`,
    );
    fs.chmodSync(stubborn, 0o755);
    env.DELEGATE_CODEX = stubborn;
    scenario({});
    const driver = start();
    await until(() => state().thread_id && fs.existsSync(pidFile));
    const tool = Number(fs.readFileSync(pidFile, "utf8"));
    expect(cli("stop", "a").status).toBe(0);
    await exited(driver, 10_000);
    await until(() => !alive(tool));
    fs.rmSync(pidFile);
    const hung = start("codex", "--idle-timeout", "1");
    await until(() => fs.existsSync(pidFile));
    const second = Number(fs.readFileSync(pidFile, "utf8"));
    await exited(hung, 20_000);
    expect(state().detail).toContain("no output");
    await until(() => !alive(second));
  });

  test("stops a queued lane before it starts", async () => {
    scenario({ lines: [THREAD, DONE], report: REPORT });
    const driver = start("codex", "--delay", "60");
    await until(() => state().status === "queued" && state().driver_pid);
    expect(cli("stop", "a").status).toBe(0);
    await exited(driver, 10_000);
    expect(state().status).toBe("stopped");
    expect(calls()).toEqual([]);
  });

  test("answer is refused while the lane runs", async () => {
    scenario({ lines: [THREAD], sleep: 60 });
    start();
    await until(() => calls().length && state().thread_id);
    expect(cli("answer", "a", "x").status).not.toBe(0);
    expect(calls().length).toBe(1);
  });
});

describe("limits", () => {
  test("a Codex usage limit stops without retry", async () => {
    const final = await runToEnd([
      {
        lines: [
          THREAD,
          {
            type: "turn.failed",
            error: {
              message: "You've hit your usage limit.",
            },
          },
        ],
        exit: 1,
      },
    ]);
    expect(final.status).toBe("limited");
    expect(calls().length).toBe(1);
    expect(final.detail).toContain(final.model);
  });

  test("a Claude session limit keeps its reset time", async () => {
    const final = await runToEnd(
      [
        {
          lines: [
            {
              type: "rate_limit_event",
              rate_limit_info: { status: "rejected", resetsAt: 1900000000 },
            },
            {
              type: "result",
              is_error: true,
              subtype: "success",
              api_error_status: 429,
              result: "You've hit your session limit",
            },
          ],
          exit: 1,
        },
      ],
      "claude",
    );
    expect(final.status).toBe("limited");
    expect(final.retry_at).toBe(1900000000);
    expect(calls().length).toBe(1);
  });

  test("a Claude limit before any output restarts fresh on continue", async () => {
    const limited = {
      lines: [{ type: "result", is_error: true, result: "usage limit reached" }],
      exit: 1,
    };
    const first = await runToEnd([limited, { lines: [CLAUDE_OK] }], "claude");
    expect(first.status).toBe("limited");
    cli("continue", "a", "go on");
    await until(() => calls().length === 2);
    expect((await settle()).status).toBe("done");
    expect(calls()[1]!.argv).toContain("--session-id");
    expect(calls()[1]!.argv).not.toContain("--resume");
    expect(calls()[1]!.stdin).toContain("go on");
    expect(calls()[1]!.stdin).toContain("do the thing");
  });

  test("digits elsewhere in an event do not look like capacity", async () => {
    const final = await runToEnd(
      [
        {
          lines: [
            {
              type: "result",
              is_error: true,
              duration_ms: 1429,
              result: "bad",
              session_id: "x-529-y",
            },
          ],
          exit: 1,
        },
      ],
      "claude",
    );
    expect(final.status).toBe("failed");
    expect(calls().length).toBe(1);
  });

  test.each([
    ["Context limit reached", "failed", 1],
    ["agent thread limit reached", "failed", 1],
    ["timed out after 429 ms", "failed", 1],
    ["request id 503", "failed", 1],
    ["You've hit your weekly limit", "limited", 1],
    ["API Error: 429 Specific rate limit detail.", "limited", 1],
    ["We're currently experiencing high demand", "done", 2],
    ["overloaded (status 429)", "done", 2],
    ["exceeded retry limit, last status: 500", "done", 2],
  ])("classifies %p as %p", async (message, status, runs) => {
    const final = await runToEnd([
      { lines: [THREAD, { type: "turn.failed", error: { message } }], exit: 1 },
      { lines: [DONE], report: REPORT },
    ]);
    expect(final.status).toBe(status as string);
    expect(calls().length).toBe(runs as number);
  });

  test("a Claude 529 retries", async () => {
    const final = await runToEnd(
      [
        {
          lines: [
            { type: "result", subtype: "success", api_error_status: 529, result: "API error" },
          ],
        },
        { lines: [CLAUDE_OK] },
      ],
      "claude",
    );
    expect(final.status).toBe("done");
    expect(calls().length).toBe(2);
  });

  test("capacity retries resend the user's answer without nesting it", async () => {
    const capacity = {
      lines: [{ type: "turn.failed", error: { message: "model at capacity" } }],
      exit: 1,
    };
    const first = await runToEnd([
      {
        lines: [THREAD, DONE],
        report: { ...REPORT, status: "needs_input", questions: ["which?"] },
      },
      capacity,
      capacity,
      { lines: [DONE], report: REPORT },
    ]);
    expect(first.status).toBe("needs_input");
    cli("answer", "a", "use option B");
    await until(() => calls().length === 4);
    expect((await settle()).status).toBe("done");
    const message = calls()[3]!.stdin;
    expect(message).toContain("use option B");
    expect(message.split("The last message to you").length).toBe(2);
  });
});

describe("cli", () => {
  test("batch starts detached lanes that finish with their own settings", async () => {
    scenario({ lines: [THREAD, DONE], report: REPORT });
    const manifest = path.join(base, "batch.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        root,
        stagger_seconds: 0,
        backend: "codex",
        model: "m1",
        effort: "high",
        idle_timeout: 77,
        lanes: [{ name: "a", dir: work, prompt, schema: SCHEMA }],
      }),
    );
    expect(spawnSync(BIN, ["batch", manifest], { env }).status).toBe(0);
    const final = await settle();
    expect(final.status).toBe("done");
    expect(final.model).toBe("m1");
    expect(final.effort).toBe("high");
    expect(final.idle_timeout).toBe(77);
    expect(final.lean).toBe(true);
  });

  test("codex hooks load only on non-lean lanes, without changing trust policy", async () => {
    scenario({ lines: [THREAD, DONE], report: REPORT });
    await exited(start());
    await exited(start("codex", "--no-lean"));
    const hooks = (call: Call) => call.argv.filter((arg) => arg.startsWith("hooks."));
    expect(hooks(calls()[0]!)).toHaveLength(0);
    expect(hooks(calls()[1]!)).toHaveLength(4);
    for (const call of calls()) expect(call.argv).not.toContain("--dangerously-bypass-hook-trust");
  });

  test("codex arguments stay as the backend expects them", async () => {
    await runToEnd([
      { lines: [THREAD, DONE], report: REPORT },
      { lines: [DONE], report: REPORT },
    ]);
    const argv = calls()[0]!.argv;
    expect(argv.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(argv.at(-1)).toBe("-");
    expect(argv).toContain("--ignore-user-config");
    expect(calls()[0]!.stdin).toContain("# Lane brief");
    cli("continue", "a", "more");
    await until(() => calls().length === 2);
    await settle();
    const resumed = calls()[1]!.argv;
    expect(resumed.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
    expect(resumed.at(-2)).toBe("t1");
    expect(resumed.at(-1)).toBe("-");
    expect(calls()[1]!.stdin).toContain("more");
  });

  test("Codex workers start a plain CLI session, never a Desktop thread", async () => {
    const lane = await runToEnd([{ lines: [THREAD, DONE], report: REPORT }], "codex", "--sandbox", "read-only");
    expect(lane.status).toBe("done");
    const [call] = calls();
    expect(call!.argv[0]).toBe("exec");
    expect(call!.argv).not.toContain("resume");
    expect(call!.stdin).toContain("do the thing");
  });
});

describe("lane records", () => {
  test("a state.json that can't be read is skipped by listings, not erased", async () => {
    await runToEnd([{ lines: [THREAD, DONE], report: REPORT }]);
    const file = path.join(root, "a/state.json");
    fs.writeFileSync(file, "{not json");
    const result = cli("status");
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("a: skipped");
    expect(fs.readFileSync(file, "utf8")).toBe("{not json");
  });

  test.each([".hidden", "two\nlines", "pr #12"])("a new lane named %p is refused", (name) => {
    const prompt = path.join(base, "p.md");
    fs.writeFileSync(prompt, "x");
    const result = cli("run", name as string, "--dir", work, "--prompt", prompt);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("bad lane name");
  });
});

describe("cli arguments", () => {
  test("continue text starting with a dash reaches the backend", async () => {
    await runToEnd([
      { lines: [THREAD, DONE], report: REPORT },
      { lines: [DONE], report: REPORT },
    ]);
    spawnSync(BIN, ["continue", "--root", root, "--", "a", "-x is the flag to fix"], { env });
    await until(() => calls().length === 2);
    await settle();
    expect(calls()[1]!.stdin).toContain("-x is the flag to fix");
  });

  test.each([
    ["continue", "- fix the bug"],
    ["answer", "--opt is what I meant"],
  ])("%s text with a dash and a space needs no --", async (command, text) => {
    await runToEnd([
      { lines: [THREAD, DONE], report: REPORT },
      { lines: [DONE], report: REPORT },
    ]);
    expect(cli(command as string, "a", text as string).status).toBe(0);
    await until(() => calls().length === 2);
    await settle();
    expect(calls()[1]!.stdin).toContain(text as string);
  });

  test("subcommand help prints usage", () => {
    const result = spawnSync(BIN, ["run", "--help"], { env, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("delegate batch");
  });

  test("inline text given as --prompt is refused before a lane starts", () => {
    const result = spawnSync(
      BIN,
      ["run", "a", "--dir", work, "--prompt", "fix the bug", "--root", root],
      { env, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--prompt takes a file");
    expect(result.stderr).not.toContain("ENOENT");
    expect(fs.existsSync(path.join(root, "a"))).toBe(false);
  });

  test("continue and answer name a missing lane as missing", () => {
    for (const command of ["continue", "answer"]) {
      const result = spawnSync(BIN, [command, "ghost", "hello", "--root", root], {
        env,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("ghost: no such lane");
      expect(result.stderr).not.toContain("session to resume");
    }
  });

  test("the caller's .env and bunfig.toml are ignored", () => {
    const repo = path.join(base, "repo");
    const marker = path.join(base, "preloaded");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, ".env"), "LEAK_CHECK=leaked\nDELEGATE_BUILD_SLOTS=9\n");
    fs.writeFileSync(
      path.join(repo, "preload.js"),
      `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`,
    );
    fs.writeFileSync(path.join(repo, "bunfig.toml"), 'preload = ["./preload.js"]\n');
    const result = spawnSync(BIN, ["build", "--", "/bin/sh", "-c", 'echo "[$LEAK_CHECK]"'], {
      env,
      cwd: repo,
      encoding: "utf8",
    });
    expect(result.stdout).toBe("[]\n");
    expect(fs.existsSync(marker)).toBe(false);
    fs.writeFileSync(path.join(repo, "bunfig.toml"), "not [ valid toml");
    expect(spawnSync(BIN, ["status", "--root", root], { env, cwd: repo }).status).toBe(0);
  });

  test("status accepts --poll", async () => {
    expect(cli("status", "--poll", "5").status).toBe(0);
  });
});

describe("build", () => {
  const build = (...args: string[]) =>
    spawnSync(BIN, ["build", ...args], { env, encoding: "utf8", timeout: 20_000 });

  test("passes the command's exit code and output through", () => {
    const result = build("--", "/bin/sh", "-c", "echo hi; exit 7");
    expect(result.status).toBe(7);
    expect(result.stdout).toBe("hi\n");
  });

  test("runs a command given without --", () => {
    expect(build("--slots", "1", "/bin/echo", "a", "--", "b").stdout).toBe("a -- b\n");
    expect(build("--slots=1", "/bin/echo", "--slots").stdout).toBe("--slots\n");
  });

  test("a held slot blocks a second build until it is free", async () => {
    const holder = spawn(BIN, ["build", "--slots", "1", "--", "/bin/sleep", "2"], {
      env,
      stdio: "ignore",
    });
    drivers.push(holder);
    await Bun.sleep(500);
    const began = Date.now();
    expect(build("--slots", "1", "--", "/usr/bin/true").status).toBe(0);
    expect(Date.now() - began).toBeGreaterThan(1000);
  });

  test("--slots wins over the slot count a lane inherits", async () => {
    const holder = spawn(BIN, ["build", "--slots", "1", "--", "/bin/sleep", "2"], { env, stdio: "ignore" });
    drivers.push(holder);
    await Bun.sleep(500);
    const began = Date.now();
    const result = spawnSync(BIN, ["build", "--slots", "1", "--", "/usr/bin/true"], {
      env: { ...env, DELEGATE_BUILD_SLOTS: "4" }, encoding: "utf8", timeout: 20_000,
    });
    expect(result.status).toBe(0);
    expect(Date.now() - began).toBeGreaterThan(1000);
  });

  test("--solo without build-queue holds every slot", async () => {
    const holder = spawn(BIN, ["build", "--solo", "--slots", "2", "--", "/bin/sleep", "2"], { env, stdio: "ignore" });
    drivers.push(holder);
    await Bun.sleep(500);
    const began = Date.now();
    expect(build("--slots", "2", "--", "/usr/bin/true").status).toBe(0);
    expect(Date.now() - began).toBeGreaterThan(1000);
  });

  test("routes through build-queue when it is on PATH, passing --solo and a queueing timeout", () => {
    const bin = path.join(base, "bin");
    fs.mkdirSync(bin);
    const seen = path.join(base, "build-queue.log");
    fs.writeFileSync(path.join(bin, "build-queue"), `#!/bin/sh\nprintf '%s\\n' "$BUILD_QUEUE_TIMEOUT" "$@" > "${seen}"\nexit 4\n`, { mode: 0o755 });
    const run = (...args: string[]) => spawnSync(BIN, ["build", ...args], {
      env: { ...env, DELEGATE_NO_BUILD_QUEUE: "", PATH: `${bin}:${env.PATH}`, BUILD_QUEUE_STATE_DIR: path.join(base, "build-queue-state") },
      encoding: "utf8", timeout: 20_000,
    });
    expect(run("--solo", "--", "/bin/echo", "hi").status).toBe(4);
    expect(fs.readFileSync(seen, "utf8")).toBe("1800\n--solo\n/bin/echo\nhi\n");
    expect(run("/bin/echo", "x").status).toBe(4);
    expect(fs.readFileSync(seen, "utf8")).toBe("1800\n/bin/echo\nx\n");
  });

  test("a daemon started by a build does not keep its slot", async () => {
    expect(
      build("--slots", "1", "--", "/bin/sh", "-c", "/bin/sleep 8 >/dev/null 2>&1 &").status,
    ).toBe(0);
    const began = Date.now();
    expect(build("--slots", "1", "--", "/usr/bin/true").status).toBe(0);
    expect(Date.now() - began).toBeLessThan(3000);
  });
});

describe("review fixes", () => {
  test("foreground run exits non-zero when the worker fails", async () => {
    scenario({ lines: [THREAD], exit: 1 });
    const proc = start("codex");
    await exited(proc);
    expect(state().status).not.toBe("done");
    expect(proc.exitCode).toBe(1);
  });

  test("foreground run exits 0 when the worker is done", async () => {
    scenario({ lines: [THREAD, DONE], report: REPORT });
    const proc = start("codex");
    await exited(proc);
    expect(proc.exitCode).toBe(0);
  });

  test("foreground run exits non-zero when a done report comes with a non-zero exit", async () => {
    scenario({ lines: [THREAD, DONE], report: REPORT, exit: 3 });
    const proc = start("codex");
    await exited(proc);
    expect(proc.exitCode).toBe(1);
  });

  test("--solo without build-queue dies when the slot folder is unusable", () => {
    fs.mkdirSync(path.join(base, ".cache/delegate"), { recursive: true });
    fs.writeFileSync(path.join(base, ".cache/delegate/build-slots"), "");
    const result = spawnSync(BIN, ["build", "--solo", "--", "/usr/bin/true"], {
      env, encoding: "utf8", timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no usable build slots");
  });

  test("status in a subfolder finds a lane run from that subfolder", () => {
    scenario({ lines: [THREAD, DONE], report: REPORT });
    spawnSync("git", ["init", "-q"], { cwd: work });
    const sub = path.join(work, "sub");
    fs.mkdirSync(sub);
    const run = (...args: string[]) => spawnSync(BIN, args, { env, encoding: "utf8", cwd: sub });
    expect(run("run", "a", "--dir", sub, "--prompt", prompt, "--backend", "codex", "--schema", SCHEMA).status).toBe(0);
    expect(run("status").stdout).toContain("a ");
  });

  test("status without flags stays in the current project", async () => {
    scenario({ lines: [THREAD, DONE], report: REPORT });
    const other = path.join(base, "other");
    fs.mkdirSync(other);
    spawnSync("git", ["init", "-q"], { cwd: work });
    const run = (cwd: string, ...args: string[]) => spawnSync(BIN, args, { env, encoding: "utf8", cwd });
    const started = run(work, "run", "a", "--dir", work, "--prompt", prompt, "--backend", "codex", "--schema", SCHEMA);
    expect(started.status).toBe(0);
    const here = run(work, "status"); expect(here.stdout + here.stderr).toContain("a ");
    expect(run(other, "status").stdout).not.toContain("a ");
    expect(run(other, "status", "--all").stdout).toContain("a ");
  });

  test("batch preflight rejects a directory as a prompt before launching anything", () => {
    const manifest = path.join(base, "dirs.json");
    fs.writeFileSync(manifest, JSON.stringify({ root, stagger_seconds: 0, lanes: [
      { name: "good", dir: work, prompt },
      { name: "bad", dir: work, prompt: work },
    ] }));
    const result = spawnSync(BIN, ["batch", manifest, "--dry-run"], { env, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("regular file");
    const file = spawnSync(BIN, ["batch", manifest.replace("dirs", "d2")], { env });
    expect(file.status).not.toBe(0);
  });
});

describe("portability", () => {
  test("an embedded schema is used when none is given, and `review` selects the other one", async () => {
    scenario({ lines: [] });
    for (const [lane, extra, key] of [
      ["plain", [], "files_changed"],
      ["rev", ["--schema", "review"], "findings"],
    ] as const) {
      const proc = spawn(
        BIN,
        [
          "run",
          lane,
          "--dir",
          work,
          "--prompt",
          prompt,
          "--root",
          root,
          "--backend",
          "codex",
          ...extra,
        ],
        { env, stdio: "ignore" },
      );
      drivers.push(proc);
      await exited(proc);
      expect(fs.readFileSync(path.join(root, lane, "output.schema.json"), "utf8")).toContain(key);
    }
  });

  test("a missing schema file is refused, before a batch starts any lane", () => {
    const manifest = path.join(base, "m.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({ root, lanes: [{ name: "a", dir: work, prompt, schema: "/nope.json" }] }),
    );
    const result = spawnSync(BIN, ["batch", manifest], { env, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("/nope.json");
    expect(fs.existsSync(path.join(root, "a"))).toBe(false);
  });

  test("a lane name cannot leave the root, and lane folders are private", async () => {
    const result = spawnSync(
      BIN,
      ["run", "../evil", "--dir", work, "--prompt", prompt, "--root", root],
      { env, encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("bad lane name");
    expect(fs.existsSync(path.join(base, "evil"))).toBe(false);
    scenario({ lines: [] });
    const proc = spawn(BIN, ["run", "a", "--dir", work, "--prompt", prompt, "--root", root], {
      env,
      stdio: "ignore",
    });
    drivers.push(proc);
    await exited(proc);
    expect(fs.statSync(path.join(root, "a")).mode & 0o077).toBe(0);
  });

  test("no hook means no hook flags", async () => {
    const quiet = { ...env, DELEGATE_HOOK: "", HOME: base, DELEGATE_CLAUDE: FAKE };
    scenario({ lines: [CLAUDE_OK] });
    const proc = spawn(
      BIN,
      ["run", "a", "--dir", work, "--prompt", prompt, "--root", root, "--backend", "claude"],
      { env: quiet, stdio: "ignore" },
    );
    drivers.push(proc);
    await exited(proc);
    expect(state().status).toBe("done");
    expect(fs.readFileSync(log, "utf8")).not.toContain("--settings");
  });

  test("doctor and --version answer without a backend call", () => {
    expect(spawnSync(BIN, ["--version"], { encoding: "utf8" }).stdout).toMatch(/^delegate \d/);
    const doctor = spawnSync(BIN, ["doctor"], { env, encoding: "utf8" });
    expect(doctor.stdout).toContain("state:");
  });

  test("a root inside the lane folder is refused", () => {
    const result = spawnSync(BIN, ["run", "a", "--dir", base, "--prompt", prompt, "--root", root], {
      env,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("writable by the lane");
  });

  test("a lane directory symlink cannot put its state in the worker checkout", async () => {
    fs.mkdirSync(root);
    const target = path.join(work, "redirected");
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(root, "a"), "dir");
    const driver = start();
    await exited(driver);
    expect(driver.exitCode).toBe(1);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  test("a relative root resolves against the caller", async () => {
    scenario({ lines: [] });
    const proc = spawn(BIN, ["run", "a", "--dir", work, "--prompt", prompt, "--root", "runs"], {
      env,
      stdio: "ignore",
      cwd: base,
    });
    drivers.push(proc);
    await exited(proc);
    expect(calls()[0]!.argv).toContain(path.join(root, "a/output.schema.json"));
  });

  test("a batch with one bad lane starts none", () => {
    const manifest = path.join(base, "m.json");
    for (const bad of [
      { backend: "bogus" },
      { sandbox: "none" },
      { name: "--x" },
      { name: "../x" },
      { prompt: "" },
    ]) {
      fs.writeFileSync(
        manifest,
        JSON.stringify({
          root,
          lanes: [
            { name: "good", dir: work, prompt },
            { name: "b", dir: work, prompt, ...bad },
          ],
        }),
      );
      expect(spawnSync(BIN, ["batch", manifest], { env }).status).toBe(1);
    }
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        root,
        lanes: [
          { name: "a", dir: work, prompt },
          { name: "a", dir: work, prompt },
        ],
      }),
    );
    expect(spawnSync(BIN, ["batch", manifest], { env }).status).toBe(1);
    expect(fs.existsSync(path.join(root, "good"))).toBe(false);
  });

  test("status strips control characters from lane text", () => {
    fs.mkdirSync(path.join(root, "a"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "a/state.json"),
      JSON.stringify({
        name: "a",
        dir: work,
        prompt,
        model: "m",
        state_dir: path.join(root, "a"),
        status: "done",
        detail: "x\u001b[2Jy\nfake row",
      }),
    );
    const out = spawnSync(BIN, ["status", "--root", root], { env, encoding: "utf8" }).stdout;
    expect(out).not.toContain("\u001b");
    expect(out).toContain("fake row");
    expect(out.trim().split("\n").length).toBe(1);
  });

  test("build refuses a bad slot count", () => {
    const result = spawnSync(BIN, ["build", "--", "/usr/bin/true"], {
      env: { ...env, DELEGATE_BUILD_SLOTS: "abc" },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
  });

  test("a read-only Claude lane gets no edit tools", async () => {
    scenario({ lines: [CLAUDE_OK] });
    const proc = spawn(
      BIN,
      [
        "run",
        "a",
        "--dir",
        work,
        "--prompt",
        prompt,
        "--root",
        root,
        "--backend",
        "claude",
        "--sandbox",
        "read-only",
      ],
      { env, stdio: "ignore" },
    );
    drivers.push(proc);
    await exited(proc);
    const argv = calls()[0]!.argv;
    expect(
      argv.slice(argv.indexOf("--allowedTools"), argv.indexOf("--disallowedTools")),
    ).not.toContain("Edit");
    expect(argv).toContain("default");
  });

  const backendArgv = () => calls()[0]!.argv;
  const run = async (extra: string[], envExtra: Record<string, string> = {}) => {
    const proc = spawn(
      BIN,
      ["run", "a", "--dir", work, "--prompt", prompt, "--root", root, ...extra],
      { env: { ...env, ...envExtra }, stdio: "ignore" },
    );
    drivers.push(proc);
    await exited(proc);
  };

  test("a root Codex can write through tmp or an added folder is refused", () => {
    const bad: string[][] = [
      ["--root", "/tmp/pa-test-root"],
      ["--root", path.join(process.env.TMPDIR || "/tmp", "pa-x")],
      ["--add-dir", base],
    ];
    for (const extra of bad) {
      const result = spawnSync(
        BIN,
        [
          "run",
          "a",
          "--dir",
          work,
          "--prompt",
          prompt,
          "--root",
          root,
          "--backend",
          "codex",
          ...extra,
        ],
        { env, encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("writable by the lane");
    }
    expect(fs.existsSync("/tmp/pa-test-root")).toBe(false);
    expect(fs.existsSync(path.join(root, "a"))).toBe(false);
  });

  test("a state.json edited to widen a lane is refused on continue", async () => {
    scenario({ lines: [] });
    await run(["--backend", "codex"]);
    const file = path.join(root, "a/state.json");
    const clean = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const change of [
      { add_dirs: ["/"] },
      { thread_id: "--yolo" },
      { model: "--yolo" },
      { add_dirs: "/" },
      { state_dir: "/tmp/x" },
    ]) {
      fs.writeFileSync(
        file,
        JSON.stringify({ ...clean, status: "done", thread_id: "t1", ...change }),
      );
      const result = spawnSync(BIN, ["continue", "a", "more", "--root", root], {
        env,
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
    }
  });

  test("a lane stays alive when status runs under another timezone and locale", async () => {
    const sleeper = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    drivers.push(sleeper);
    const started = spawnSync("ps", ["-o", "lstart=", "-p", String(sleeper.pid)], {
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      encoding: "utf8",
    }).stdout.trim();
    fs.mkdirSync(path.join(root, "a"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "a/state.json"),
      JSON.stringify({
        name: "a",
        dir: work,
        prompt,
        model: "m",
        status: "running",
        state_dir: path.join(root, "a"),
        driver_pid: sleeper.pid,
        driver_started: started,
      }),
    );
    const out = spawnSync(BIN, ["status", "--root", root], {
      env: { ...env, TZ: "Asia/Tokyo", LC_ALL: "de_DE.UTF-8" },
      encoding: "utf8",
    }).stdout;
    expect(out).toContain("running");
    expect(out).not.toContain("died");
  });

  test("batch refuses wrong JSON types before starting anything", () => {
    const manifest = path.join(base, "m.json");
    for (const bad of [
      { add_dirs: "/tmp/x" },
      { allowed_tools: "Read,Grep" },
      { model: 5 },
      { model: "--yolo" },
      { idle_timeout: "1" },
      { network: "false" },
      { trust_hooks: "false" },
      { lean: 0 },
    ]) {
      fs.writeFileSync(
        manifest,
        JSON.stringify({
          root,
          lanes: [
            { name: "good", dir: work, prompt },
            { name: "b", dir: work, prompt, ...bad },
          ],
        }),
      );
      expect(spawnSync(BIN, ["batch", manifest], { env }).status).toBe(1);
    }
    expect(fs.existsSync(path.join(root, "good"))).toBe(false);
  });

  test("batch preview shows effective permissions without starting workers", () => {
    const manifest = path.join(base, "preview.json");
    fs.writeFileSync(manifest, JSON.stringify({ root, sandbox: "read-only", lanes: [{ name: "one", dir: work, prompt }] }));
    const preview = spawnSync(BIN, ["batch", manifest, "--dry-run"], { env, encoding: "utf8" });
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain(`one: codex/gpt-6.1-sol read-only ${work}`);
    expect(fs.existsSync(root)).toBe(false);
  });

  test("~ in a manifest means the home folder", async () => {
    fs.writeFileSync(path.join(base, "p.md"), "brief");
    const manifest = path.join(base, "m.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        root: "~/runs",
        stagger_seconds: 0,
        lanes: [{ name: "a", dir: "~/work", prompt: "~/p.md" }],
      }),
    );
    scenario({ lines: [] });
    const result = spawnSync(BIN, ["batch", manifest], { env, cwd: work, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(work, "~"))).toBe(false);
    for (let tries = 0; tries < 100 && !fs.existsSync(path.join(root, "a/state.json")); tries++)
      await Bun.sleep(50);
    expect(fs.existsSync(path.join(root, "a/state.json"))).toBe(true);
  });

  test("a hook runs as its own program, whatever its language", async () => {
    scenario({ lines: [] });
    await run(["--backend", "codex", "--no-lean"]);
    expect(backendArgv().join(" ")).not.toContain("/bin/sh");
    expect(backendArgv().join(" ")).toContain("/usr/bin/true");
  });

  test("a lean Claude lane keeps the user's deny rules and guard hooks only", async () => {
    fs.mkdirSync(path.join(base, ".claude"));
    fs.writeFileSync(
      path.join(base, ".claude/settings.json"),
      JSON.stringify({
        env: { SECRET: "x" },
        enabledPlugins: { p: true },
        permissions: { deny: ["Bash(rm *)"], allow: ["Bash(*)"] },
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "guard" }] }],
          SessionStart: [{ hooks: [] }],
        },
      }),
    );
    scenario({ lines: [CLAUDE_OK] });
    await run(["--backend", "claude"]);
    const argv = backendArgv();
    const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!);
    expect(settings.permissions).toEqual({ deny: ["Bash(rm *)"] });
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("guard");
    expect(settings.hooks.SessionStart).toBeUndefined();
    expect(settings.env).toBeUndefined();
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("project,local");
  });

  test("a read-only lane ignores repo settings and is not told to build", async () => {
    scenario({ lines: [CLAUDE_OK] });
    await run(["--backend", "claude", "--sandbox", "read-only"]);
    const argv = backendArgv();
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
    const brief = fs.readFileSync(path.join(root, "a/prompt.full.md"), "utf8");
    expect(brief).toContain("read-only");
    expect(brief).not.toContain("build once");
  });
});

describe.skipIf(process.platform !== "darwin")("alerts", () => {
  const seen = (file: string) =>
    fs.existsSync(file) ? fs.readFileSync(file, "utf8").trimEnd().split("\n") : [];
  let posted: string;
  let fallback: string;

  /** A fake notifier app per backend and a fake osascript, each logging its arguments. */
  const fakes = (body = "exit 0") => {
    posted = path.join(base, "posted.log");
    fallback = path.join(base, "fallback.log");
    for (const backend of ["claude", "codex", "gemini", "agy"]) {
      const dir = path.join(base, `notifiers/${backend}.app/Contents/MacOS`);
      fs.mkdirSync(dir, { recursive: true });
      const script = `#!/bin/sh\nprintf '${backend}\\n' >> "${posted}"\nprintf '%s\\n' "$@" >> "${posted}"\n${body}\n`;
      fs.writeFileSync(path.join(dir, "notifier"), script, { mode: 0o755 });
    }
    const osa = path.join(base, "osascript");
    fs.writeFileSync(osa, `#!/bin/sh\nprintf '%s\\n' "$2" >> "${fallback}"\n`, { mode: 0o755 });
    delete env.DELEGATE_NO_NOTIFY;
    env.DELEGATE_NOTIFIERS = path.join(base, "notifiers");
    env.DELEGATE_OSASCRIPT = osa;
  };

  test("a finished lane leads with its name and state, from its backend's app", async () => {
    fakes();
    await runToEnd([
      { lines: [THREAD, DONE], report: { status: "done", summary: "Login works." } },
    ]);
    expect(seen(posted)).toEqual([
      "codex", "a is done", "Codex · gpt-6.1-sol · work", "Login works.", BIN, root, "a", "report", state().run_id,
    ]);
    expect(seen(fallback)).toEqual([]);
  });

  test("a lane with a question shows the first one and counts the rest", async () => {
    fakes();
    const report = {
      status: "needs_input",
      summary: "Stuck.",
      questions: ["Which port?", "Why?", "How?"],
    };
    await runToEnd([{ lines: [THREAD, DONE], report }]);
    expect(seen(posted).slice(1, 4)).toEqual([
      "a needs your answer",
      "Codex · gpt-6.1-sol · work",
      "Which port? (+2 more)",
    ]);
    expect(seen(posted).slice(-2)).toEqual(["report", state().run_id]);
  });

  test("a Claude lane alerts from the Claude app with a next step on failure", async () => {
    fakes();
    env.DELEGATE_CLAUDE = path.join(base, "missing");
    await exited(start("claude"));
    const [app, title, subtitle, message] = seen(posted);
    expect([app, title, subtitle]).toEqual(["claude", "a failed", "Claude · sonnet · work"]);
    expect(message).toStartWith("Claude exited with an error");
  });

  test("a Claude alert shows the model that answered after a fallback", async () => {
    fakes();
    await runToEnd([{ lines: [
      { type: "system", subtype: "init", model: "claude-opus-5-5" },
      { type: "assistant", message: { model: "claude-sonnet-5-5", content: [] } },
      CLAUDE_OK,
    ] }], "claude", "--model", "opus", "--fallback-model", "sonnet");
    expect(seen(posted).slice(0, 3)).toEqual(["claude", "a is done", "Claude · claude-sonnet-5-5 · work"]);
  });

  test("a refused notifier falls back to osascript, with text flattened and capped", async () => {
    fakes("exit 3");
    const summary = `line one\nline "two"\t${"x".repeat(400)}`;
    await runToEnd([{ lines: [THREAD, DONE], report: { status: "partial", summary } }]);
    const [script] = seen(fallback);
    expect(script).toStartWith('display notification "line one line \\"two\\" xxx');
    expect(script).toContain('…" with title "a stopped partway" subtitle "Codex · gpt-6.1-sol · work"');
    const body = script!.slice("display notification ".length, script!.indexOf(" with title "));
    expect(JSON.parse(body).length).toBeLessThanOrEqual(220);
  });

  test("a notifier that hangs cannot hold up the lane", async () => {
    fakes("exec /bin/sleep 60");
    const began = Date.now();
    await runToEnd([{ lines: [THREAD, DONE], report: { status: "done", summary: "Fine." } }]);
    expect(Date.now() - began).toBeLessThan(15_000);
    expect(seen(fallback).length).toBe(1);
  });

  test("no notifier app means osascript, and doctor says so", async () => {
    fakes();
    fs.rmSync(path.join(base, "notifiers"), { recursive: true });
    await runToEnd([{ lines: [THREAD, DONE], report: { status: "done", summary: "Fine." } }]);
    expect(seen(fallback).length).toBe(1);
    const doctor = spawnSync(BIN, ["doctor"], { env, encoding: "utf8" });
    expect(doctor.stdout).toContain("codex alerts: osascript");
  });

  test("open shows the text report, not a desktop chat", async () => {
    const opener = path.join(base, "open");
    const opened = path.join(base, "opened.log");
    fs.writeFileSync(opener, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${opened}"\n`, { mode: 0o755 });
    env.PATH = `${base}:${env.PATH}`;
    await runToEnd([{ lines: [THREAD, DONE], report: REPORT }]);
    expect(cli("open", "a").status).toBe(0);
    expect(seen(opened)).toEqual(["-t", path.join(root, "a/report.txt")]);
    expect(fs.readFileSync(path.join(root, "a/report.txt"), "utf8")).toBe("A\n\ndone on codex\n\nok\n");
    expect(JSON.parse(fs.readFileSync(path.join(root, "a/report.json"), "utf8"))).toEqual(REPORT);
  });

  test("terminal alerts and direct opens target the same worker and quote its checkout", async () => {
    fakes();
    const renamed = path.join(base, "work's tree");
    fs.renameSync(work, renamed);
    work = renamed;
    await runToEnd([{ lines: [THREAD, DONE], report: REPORT }], "codex", "--sandbox", "read-only");
    fs.unlinkSync(posted);
    expect(cli("notify", "a", "--terminal").status).toBe(0);
    expect(seen(posted).slice(-4)).toEqual([root, "a", "terminal", state().run_id]);
    const osa = env.DELEGATE_OSASCRIPT!;
    fs.writeFileSync(osa, `#!/bin/sh\nprintf '%s\\n' "$3" > "${fallback}"\n`, { mode: 0o755 });
    expect(cli("open", "a", "--terminal").status).toBe(0);
    expect(seen(fallback)[0]).toContain("work'\\''s tree' && exec ");
    expect(seen(fallback)[0]).toEndWith("'resume' '--sandbox' 'read-only' 't1'");
  });

  test("an old notification cannot open a newer run with the same name", async () => {
    fakes();
    await runToEnd([
      { lines: [THREAD, DONE], report: REPORT },
      { lines: [{ ...THREAD, thread_id: "replacement" }, DONE], report: REPORT },
    ]);
    const previous = state().run_id;
    await exited(start());
    expect(state().run_id).not.toBe(previous);
    expect(cli("open", "a", "--run-id", previous).stderr).toContain("run ID no longer matches");
    expect(cli("result", "a", "--run-id", previous).status).toBe(1);
  });
});

describe("quick commands", () => {
  const gitIn = (dir: string, ...args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args], {
      cwd: dir,
      encoding: "utf8",
    });
  let repo: string;
  let callerEnv: Record<string, string>;
  const cli = (args: string[], over: Record<string, string> = callerEnv, cwd = repo) =>
    spawnSync(BIN, [...args, "--root", root], {
      env: over,
      cwd,
      encoding: "utf8",
      timeout: 20_000,
    });
  const laneNames = () =>
    fs.readdirSync(root).filter((name) => fs.existsSync(path.join(root, name, "state.json")));
  const laneState = (name: string) =>
    JSON.parse(fs.readFileSync(path.join(root, name, "state.json"), "utf8"));
  const lanePrompt = (name: string) =>
    fs.readFileSync(path.join(root, name, "prompt.full.md"), "utf8");
  const finding = {
    severity: "high",
    file: "a.ts",
    line: 3,
    problem: "drops the retry",
    failure_scenario: "on a 529",
    fix: "keep it",
  };

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(base, "repo-"));
    gitIn(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-qm", "init");
    const clear: Record<string, string> = { ...env };
    for (const key of ["CLAUDECODE", "CODEX_THREAD_ID", "CODEX_SANDBOX", "GEMINI_CLI", "ANTIGRAVITY_AGENT", "ANTIGRAVITY_CONVERSATION_ID", "DELEGATE_SESSION"]) delete clear[key];
    callerEnv = { ...clear, CLAUDECODE: "1" };
  });

  test("archive, restore and clear affect only finished lanes of the selected orchestrator", () => {
    const codex: Record<string, string> = { ...callerEnv, CODEX_THREAD_ID: "lead-a" };
    delete codex.CLAUDECODE;
    const other = { ...callerEnv, DELEGATE_SESSION: "lead-b" };
    scenario(
      { lines: [THREAD, DONE], report: REPORT },
      { lines: [THREAD, DONE], report: REPORT },
      { lines: [THREAD, DONE], report: { ...REPORT, status: "needs_input", questions: ["Which file?"] } },
    );
    const task = (name: string, over: Record<string, string>) =>
      cli(["task", "--backend", "codex", "--name", name, "check this"], over);
    expect(task("a-done", codex).status).toBe(0);
    expect(task("b-done", other).status).toBe(0);
    expect(task("a-question", codex).status).toBe(1);
    const status = JSON.parse(cli(["status", "--json"], codex).stdout);
    expect(status).toMatchObject({ version: 1, root });
    expect(status.lanes.map((lane: { name: string }) => lane.name)).toEqual(["a-done", "a-question"]);
    expect(status.lanes[1]).toMatchObject({
      status: "needs_input", questions: ["Which file?"],
      next: { argv: ["delegate", "answer", "a-question", "--root", root, "--run-id", laneState("a-question").run_id], requires_text: true },
    });
    expect(cli(["status"], codex).stdout).toContain("Answer with: delegate answer 'a-question'");
    expect(laneState("a-done").orchestrator).toBe("lead-a");
    expect(cli(["archive"]).status).toBe(1);
    expect(cli(["archive"], codex).stdout).toContain("a-done: archived");
    const active = cli(["status"]).stdout;
    expect(active).toContain("b-done");
    expect(active).toContain("a-question");
    expect(active).not.toContain("a-done");
    expect(cli(["status", "--archived", "--session", "lead-a"]).stdout).toContain("a-done");
    expect(cli(["result", "a-done"]).status).toBe(0);
    expect(cli(["continue", "a-done", "follow up"]).stderr).toContain("restore it");
    expect(cli(["restore", "--session", "lead-a"]).stdout).toContain("a-done: restored");
    expect(cli(["clear", "--yes"], codex).stdout).toContain("no matching lanes");
    expect(cli(["archive"], codex).status).toBe(0);
    expect(cli(["clear"], codex).stdout).toContain("would remove");
    expect(laneNames()).toContain("a-done");
    expect(cli(["clear", "--yes"], codex).stdout).toContain("a-done: cleared");
    expect(laneNames().sort()).toEqual(["a-question", "b-done"]);
    expect(task("a-done", codex).status).toBe(1); // fake backend still returns needs_input
    expect(laneNames()).toContain("a-done");
  });

  test("prune previews and removes only finished records older than the selected cutoff", () => {
    const stamp = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    for (const [name, status, updated, archived] of [
      ["old", "done", stamp(8), false],
      ["archived-old", "stopped", stamp(8), true],
      ["two-days", "failed", stamp(2), false],
      ["recently-updated", "done", stamp(0.5), false],
      ["still-running", "running", stamp(8), false],
      ["waiting", "needs_input", stamp(8), false],
      ["no-date", "done", "invalid", false],
    ]) {
      const dir = path.join(root, String(name));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
        name, status, updated, archived, started: stamp(10), dir: repo, state_dir: dir, prompt, model: "fixture",
      }));
    }
    const preview = cli(["prune"]);
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("old: would remove");
    expect(preview.stdout).toContain("archived-old: would remove");
    expect(preview.stdout).not.toContain("two-days:");
    expect(laneNames()).toHaveLength(7);
    expect(cli(["prune", "--days", "0", "--yes"]).status).toBe(1);
    expect(cli(["prune", "--yes"]).status).toBe(0);
    expect(cli(["prune", "--days", "1", "--yes"], { ...callerEnv, DELEGATE_SESSION: "another-lead" }).stdout).toContain("two-days: pruned");
    expect(laneNames().sort()).toEqual(["no-date", "recently-updated", "still-running", "waiting"]);
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("one\n");
  });

  test("review from Claude goes to Codex, read-only, and prints the findings", () => {
    fs.writeFileSync(path.join(repo, "new.txt"), "two\n");
    scenario({ report: { status: "done", summary: "one problem", findings: [finding] } });
    const result = cli(["review"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[high] a.ts:3");
    expect(result.stdout).toContain("Fails when: on a 529");
    const [name] = laneNames();
    expect(name).toMatch(/^review-main-[0-9a-f]{4}$/);
    expect(laneState(name!).title).toBe(`Review · ${path.basename(repo)} · Main`);
    expect(laneState(name!)).toMatchObject({
      backend: "codex",
      sandbox: "read-only",
      schema: "review",
      effort: "high",
    });
    expect(lanePrompt(name!)).toContain("uncommitted changes");
  });

  test("review from Codex goes to Claude", () => {
    fs.writeFileSync(path.join(repo, "new.txt"), "two\n");
    const over = { ...callerEnv, CODEX_THREAD_ID: "t" } as Record<string, string>;
    delete over.CLAUDECODE;
    scenario({ lines: [] });
    cli(["review"], over);
    expect(laneState(laneNames()[0]!).backend).toBe("claude");
  });

  test("review from Gemini CLI goes to Claude, and any caller can target Gemini", () => {
    fs.writeFileSync(path.join(repo, "new.txt"), "two\n");
    const over = { ...callerEnv, GEMINI_CLI: "1" } as Record<string, string>;
    delete over.CLAUDECODE;
    scenario({ lines: [] });
    cli(["review", "--name", "from-gemini"], over);
    expect(laneState("from-gemini").backend).toBe("claude");
    scenario({
      lines: [
        { type: "init", session_id: "g-sess-1", model: "auto" },
        { type: "tool_use", tool_name: "run_shell_command", parameters: { command: "git status" } },
        { type: "message", role: "assistant", content: "Checking repo...\n" },
        { type: "tool_use", tool_name: "read_file", parameters: { file_path: "new.txt" } },
        { type: "message", role: "assistant", content: "```json\n" + JSON.stringify({ status: "done", summary: "gemini ok", findings: [] }) + "\n```" },
        { type: "result", status: "success", stats: { input_tokens: 120, cached: 40, output_tokens: 30, models: { "gemini-3.1-pro-preview": {} } } },
      ],
    });
    const res = cli(["review", "--backend", "gemini", "--name", "to-gemini"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("gemini ok");
    const st = laneState("to-gemini");
    expect(st).toMatchObject({
      backend: "gemini",
      model: "auto",
      resolved_model: "gemini-3.1-pro-preview",
      thread_id: "g-sess-1",
      session_started: true,
      sandbox: "read-only",
      usage: { input: 120, cached: 40, output: 30 },
    });
    const argv = calls().at(-1)!.argv;
    expect(argv).toContain("--approval-mode");
    expect(argv[argv.indexOf("--approval-mode") + 1]).toBe("plan");
  });

  test("review from Antigravity goes to Claude, and any caller can target Antigravity", () => {
    fs.writeFileSync(path.join(repo, "new.txt"), "two\n");
    const over = { ...callerEnv, ANTIGRAVITY_AGENT: "1" } as Record<string, string>;
    delete over.CLAUDECODE;
    scenario({ lines: [] });
    cli(["review", "--name", "from-agy"], over);
    expect(laneState("from-agy").backend).toBe("claude");
    scenario({
      lines: [
        { event: "init", conversation_id: "agy-conv-1", init: { model: "gemini-3.8-flash-high" } },
        { event: "step_update", conversation_id: "agy-conv-1", step_update: { step_type: "agent_response", text_delta: "Inspecting..." } },
        {
          event: "result",
          result: {
            conversation_id: "agy-conv-1",
            status: "SUCCESS",
            structured_output: { status: "done", summary: "agy ok", findings: [] },
            usage: { input_tokens: 150, cache_read_tokens: 50, output_tokens: 35 },
          },
        },
      ],
    });
    const res = cli(["review", "--backend", "agy", "--name", "to-agy"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("agy ok");
    const st = laneState("to-agy");
    expect(st).toMatchObject({
      backend: "agy",
      model: "gemini-3.8-flash-high",
      resolved_model: "gemini-3.8-flash-high",
      thread_id: "agy-conv-1",
      session_started: true,
      sandbox: "read-only",
      usage: { input: 150, cached: 50, output: 35 },
    });
    const argv = calls().at(-1)!.argv;
    expect(argv).toContain("--mode");
    expect(argv[argv.indexOf("--mode") + 1]).toBe("plan");
    expect(argv).toContain("--json-schema");
  });

  test("agy task --write runs in auto mode with sandbox when network is false", () => {
    scenario({
      lines: [
        { event: "init", conversation_id: "agy-conv-2", init: { model: "gemini-3.8-flash-high" } },
        { event: "step_update", conversation_id: "agy-conv-2", step_update: { step_type: "agent_response", text_delta: "Fixing..." } },
        {
          event: "result",
          result: {
            conversation_id: "agy-conv-2",
            status: "SUCCESS",
            structured_output: { status: "done", summary: "agy write ok", findings: [] },
            usage: { input_tokens: 200, cache_read_tokens: 0, output_tokens: 40 },
          },
        },
      ],
    });
    const res = cli(["task", "--backend", "agy", "--name", "write-agy", "--write", "fix things"]);
    expect(res.status).toBe(0);
    const argv = calls().at(-1)!.argv;
    expect(argv).toContain("--mode");
    expect(argv[argv.indexOf("--mode") + 1]).toBe("auto");
    expect(argv).toContain("--sandbox");
  });

  test("a plain shell has to name the backend, and nothing starts", () => {
    fs.writeFileSync(path.join(repo, "new.txt"), "two\n");
    const over = { ...callerEnv };
    delete over.CLAUDECODE;
    const result = cli(["review"], over);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--backend");
    expect(fs.existsSync(root) ? laneNames() : []).toEqual([]);
  });

  test("both tools' markers at once count as unknown", () => {
    fs.writeFileSync(path.join(repo, "new.txt"), "two\n");
    const result = cli(["review"], { ...callerEnv, CODEX_THREAD_ID: "t" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--backend");
  });

  test("a lane's backend doesn't inherit its caller's markers", () => {
    fs.writeFileSync(path.join(repo, "new.txt"), "two\n");
    const dump = path.join(base, "envdump");
    fs.writeFileSync(
      dump,
      `#!/bin/sh\nenv > ${base}/seen.env\necho '{"type":"thread.started","thread_id":"t1"}'\n`,
      { mode: 0o755 },
    );
    cli(["review", "--backend", "codex"], {
      ...callerEnv,
      DELEGATE_CODEX: dump,
      CODEX_THREAD_ID: "x",
      CODEX_SANDBOX: "x",
      GEMINI_CLI: "1",
      ANTIGRAVITY_AGENT: "1",
      ANTIGRAVITY_CONVERSATION_ID: "conv-1",
    });
    const seen = fs.readFileSync(path.join(base, "seen.env"), "utf8");
    expect(seen).not.toMatch(/^CLAUDECODE=/m);
    expect(seen).not.toMatch(/^CODEX_THREAD_ID=/m);
    expect(seen).not.toMatch(/^CODEX_SANDBOX=/m);
    expect(seen).not.toMatch(/^GEMINI_CLI=/m);
    expect(seen).not.toMatch(/^ANTIGRAVITY_AGENT=/m);
    expect(seen).not.toMatch(/^ANTIGRAVITY_CONVERSATION_ID=/m);
  });

  test("adversarial, focus and base all reach the brief", () => {
    gitIn(repo, "checkout", "-qb", "feature");
    fs.writeFileSync(path.join(repo, "b.txt"), "two\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-qm", "b");
    const mainSha = gitIn(repo, "rev-parse", "main").stdout.trim();
    scenario({ report: { status: "done", summary: "fine", findings: [] } });
    cli(["review", "--adversarial", "--base", "main", "--focus", "- retry safety"]);
    const prompt = lanePrompt(laneNames()[0]!);
    expect(prompt).toContain("Argue against shipping");
    expect(prompt).toContain(`git diff --no-ext-diff ${mainSha}...HEAD`);
    expect(prompt).toContain("- retry safety");
  });

  test("a clean tree finds its branch's changes, or says there are none", () => {
    expect(cli(["review"]).stderr).toContain("nothing to review");
    gitIn(repo, "checkout", "-qb", "feature");
    fs.writeFileSync(path.join(repo, "b.txt"), "two\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-qm", "b");
    scenario({ report: { status: "done", summary: "fine", findings: [] } });
    expect(cli(["review"]).status).toBe(0);
    expect(lanePrompt(laneNames()[0]!)).toContain("against main");
  });

  test("a base that isn't a commit is refused, flag-shaped ones too", () => {
    fs.writeFileSync(path.join(repo, "new.txt"), "two\n");
    expect(cli(["review", "--base", "nope"]).stderr).toContain("no such commit");
    expect(cli(["review", "--base=--output=x"]).stderr).toContain("no such commit");
  });

  test("review needs a git repo", () => {
    expect(cli(["review"], callerEnv, "/").stderr).toContain("inside a git repo");
  });

  test("task takes inline text, is read-only, and names itself after the words", () => {
    scenario({
      report: { status: "done", summary: "it hangs on login", files_changed: [], questions: [] },
    });
    const result = cli(["task", "Why does the login test hang?"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("it hangs on login");
    const [name] = laneNames();
    expect(name).toMatch(/^why-does-the-login-[0-9a-f]{4}$/);
    expect(laneState(name!).sandbox).toBe("read-only");
    expect(lanePrompt(name!)).toContain("Why does the login test hang?");
  });

  test("task --write gets its own worktree and branch, kept out of git status", () => {
    scenario({
      report: { status: "done", summary: "fixed", files_changed: ["a.txt"], questions: [] },
    });
    const result = cli(["task", "--write", "--name", "fix-it", "fix the bug"]);
    expect(result.status).toBe(0);
    const worktree = path.join(fs.realpathSync(repo), ".worktrees/fix-it");
    expect(result.stdout).toContain(`worktree: ${worktree}`);
    expect(laneState("fix-it")).toMatchObject({
      sandbox: "workspace-write",
      dir: worktree,
      origin: fs.realpathSync(repo),
    });
    expect(gitIn(repo, "branch", "--list", "fix-it").stdout).toContain("fix-it");
    expect(gitIn(repo, "status", "--porcelain").stdout).toBe("");
  });

  test("a task never reuses a lane name", () => {
    scenario({ report: { status: "done", summary: "fine", files_changed: [], questions: [] } });
    cli(["task", "--name", "same", "one"]);
    expect(cli(["task", "--name", "same", "two"]).stderr).toContain("already exists");
  });

  test("a failed worktree add preserves a competing checkout and its changes", () => {
    const wrapper = path.join(base, "git");
    const winner = path.join(repo, ".worktrees/contested");
    fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1 $2" = 'worktree add' ]; then
  "$TEST_GIT" "$@" || exit 1
  printf 'competing work' > "$TEST_WINNER/marker.txt"
fi
exec "$TEST_GIT" "$@"
`, { mode: 0o755 });
    const result = cli(["task", "--write", "--name", "contested", "go"], {
      ...callerEnv, PATH: `${base}:${callerEnv.PATH}`, TEST_GIT: Bun.which("git")!, TEST_WINNER: winner,
    });
    expect(result.status).toBe(1);
    expect(fs.readFileSync(path.join(winner, "marker.txt"), "utf8")).toBe("competing work");
    expect(gitIn(repo, "branch", "--list", "contested").stdout).toContain("contested");
  });

  test("implicit follow-up and wait stay with their lead session", async () => {
    const leadA = { ...callerEnv, DELEGATE_SESSION: "lead-a" };
    const leadB = { ...callerEnv, DELEGATE_SESSION: "lead-b" };
    scenario({ lines: [THREAD, DONE], report: REPORT });
    expect(cli(["task", "--name", "a", "first"], leadA).status).toBe(0);
    expect(cli(["task", "--name", "b", "second"], leadB).status).toBe(0);
    expect(cli(["result"], leadA).stdout).toContain("a: done");
    expect(cli(["continue", "my follow-up"], leadA).stdout).toContain("a: continuing");
    const waited = cli(["wait", "--poll", "0.05"], leadA);
    expect(waited.status).toBe(0);
    expect(waited.stdout).not.toMatch(/^b\s/m);
    expect(cli(["result"], callerEnv).status).toBe(1);
  });

  test("no NAME means the newest lane from this repo, never another repo's", () => {
    scenario({
      lines: [{ type: "thread.started", thread_id: "abc" }],
      report: { status: "done", summary: "from here", files_changed: [], questions: [] },
    });
    cli(["task", "--name", "here", "one"]);
    const other = fs.mkdtempSync(path.join(base, "other-"));
    gitIn(other, "init", "-q");
    expect(cli(["result"], callerEnv, other).stderr).toContain("no lanes from this folder");
    expect(cli(["result"]).stdout).toContain("from here");
    const json = JSON.parse(cli(["result", "--json"]).stdout);
    expect(json).toMatchObject({ name: "here", status: "done" });
    expect(cli(["continue", "go on"]).stdout).toContain("here: continuing");
  });

  test("result fails on a lane with no report, and says when one is still running", async () => {
    scenario({ exit: 1 });
    const failed = cli(["task", "--name", "bad", "one"]);
    expect(failed.status).toBe(1);
    scenario({ sleep: 5 });
    const started = cli(["task", "--background", "--name", "slow", "two"]);
    expect(started.stdout).toContain(`result 'slow' --root '${root}' --run-id '`);
    await until(
      () =>
        fs.existsSync(path.join(root, "slow", "state.json")) &&
        laneState("slow").status === "running",
    );
    expect(cli(["result", "slow"]).stdout).toContain("still running");
    expect(cli(["stop"]).stdout).toContain("slow: stopped");
  });

  test("stop without a NAME won't guess between two running lanes", async () => {
    scenario({ sleep: 5 });
    cli(["task", "--background", "--name", "one", "first"]);
    cli(["task", "--background", "--name", "two", "second"]);
    await until(() =>
      ["one", "two"].every(
        (name) =>
          fs.existsSync(path.join(root, name, "state.json")) &&
          laneState(name).status === "running",
      ),
    );
    const result = cli(["stop"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("one, two");
    cli(["stop", "one"]);
    cli(["stop", "two"]);
  });

  const settle2 = (name: string) => until(() => !ACTIVE.includes(laneState(name).status));
  const started = async (name: string) =>
    until(
      () =>
        fs.existsSync(path.join(root, name, "state.json")) && laneState(name).status === "running",
    );

  test("a forgotten TEXT is refused instead of messaging the newest lane", () => {
    scenario({
      lines: [THREAD],
      report: { status: "done", summary: "fine", files_changed: [], questions: [] },
    });
    cli(["task", "--name", "older", "one"]);
    cli(["task", "--name", "newer", "two"]);
    const before = calls().length;
    const result = cli(["continue", "older"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("older is a lane");
    expect(calls().length).toBe(before);
    expect(laneState("newer").status).toBe("done");
  });

  test("unquoted words after a NAME all arrive", async () => {
    scenario({
      lines: [THREAD],
      report: { status: "done", summary: "fine", files_changed: [], questions: [] },
    });
    cli(["task", "--name", "one", "first"]);
    expect(cli(["continue", "one", "fix", "the", "bug"]).status).toBe(0);
    await until(() => calls().length === 2);
    expect(calls()[1].stdin).toContain("fix the bug");
  });

  test("answer without a NAME goes to the one lane that asked", async () => {
    scenario({
      lines: [THREAD],
      report: { status: "done", summary: "fine", files_changed: [], questions: [] },
    });
    cli(["task", "--name", "plain", "first"]);
    scenario({
      lines: [THREAD],
      report: {
        status: "needs_input",
        summary: "which?",
        files_changed: [],
        questions: ["which?"],
      },
    });
    expect(cli(["task", "--name", "asks", "second"]).status).toBe(1);
    scenario({
      lines: [THREAD],
      report: { status: "done", summary: "fine", files_changed: [], questions: [] },
    });
    cli(["task", "--name", "newest", "third"]);
    expect(cli(["answer", "red"]).stdout).toContain("asks: resumed");
  });

  test("the newest lane is right within one second", () => {
    scenario({ report: { status: "done", summary: "fine", files_changed: [], questions: [] } });
    cli(["task", "--name", "zfirst", "one"]);
    cli(["task", "--name", "asecond", "two"]);
    expect(cli(["result"]).stdout).toContain("asecond");
  });

  test("review can't take a lane name in use, and a bad name writes nothing", async () => {
    fs.writeFileSync(path.join(repo, "new.txt"), "two\n");
    scenario({ sleep: 5 });
    cli(["review", "--background", "--name", "live"]);
    await started("live");
    const before = laneState("live").driver_pid;
    const result = cli(["review", "--background", "--name", "live"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already exists");
    expect(laneState("live").driver_pid).toBe(before);
    cli(["stop", "live"]);
    const victim = path.join(base, ".cache", "victim.md");
    fs.mkdirSync(path.dirname(victim), { recursive: true });
    fs.writeFileSync(victim, "keep");
    expect(cli(["review", "--name", "../../victim"]).stderr).toContain("bad lane name");
    expect(fs.readFileSync(victim, "utf8")).toBe("keep");
  });

  test("stop right after --background reaches the lane", async () => {
    scenario({ sleep: 5 });
    cli(["task", "--background", "--name", "quick", "go"]);
    const result = cli(["stop", "quick"]);
    expect(result.stderr).not.toContain("older runner");
    expect(result.status).toBe(0);
    expect(cli(["result", "quick"]).stdout).toContain("stopped");
  });

  test("result reports failures honestly and exits non-zero", () => {
    scenario({
      report: {
        status: "partial",
        summary: "half",
        files_changed: [],
        questions: [],
        untested: ["the login"],
        build: { ran: true, passed: false, warnings: 0, detail: "xcodebuild" },
        tests: { ran: true, passed: 10, failed: 2, detail: "" },
      },
    });
    const partial = cli(["task", "--name", "half", "go"]);
    expect(partial.status).toBe(0);
    expect(partial.stdout).toContain("build: failed. xcodebuild");
    expect(partial.stdout).toContain("tests: 10 passed, 2 failed");
    expect(partial.stdout).toContain("Not tested: the login");
    scenario({ report: { status: "blocked", summary: "stuck", files_changed: [], questions: [] } });
    expect(cli(["task", "--name", "stuck", "go"]).status).toBe(1);
    expect(cli(["result", "stuck", "--json"]).status).toBe(1);
  });

  test("result --json stays JSON while a lane runs", async () => {
    scenario({ sleep: 5 });
    const started_ = JSON.parse(
      cli(["task", "--background", "--json", "--name", "js", "go"]).stdout,
    );
    expect(started_).toMatchObject({ name: "js", status: "queued" });
    await started("js");
    expect(JSON.parse(cli(["result", "js", "--json"]).stdout)).toMatchObject({
      status: "running",
      report: null,
    });
    cli(["stop", "js"]);
  });

  test("a malformed report doesn't crash result", () => {
    scenario({
      report: {
        status: "done",
        summary: { toString: 1 },
        findings: [null, 5],
        questions: 5,
        files_changed: "x",
      },
    });
    const result = cli(["task", "--name", "odd", "go"]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("delegate:");
  });

  test("a read-only lane can't be widened on continue", () => {
    scenario({
      lines: [THREAD],
      report: { status: "done", summary: "fine", files_changed: [], questions: [] },
    });
    cli(["task", "--name", "ro", "go"]);
    const result = cli(["continue", "ro", "edit it", "--sandbox", "workspace-write"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("task --write");
    expect(laneState("ro").sandbox).toBe("read-only");
  });

  test("a failed --write start leaves nothing behind, and the retry works", () => {
    scenario({ report: { status: "done", summary: "fine", files_changed: [], questions: [] } });
    fs.mkdirSync(path.join(repo, ".worktrees/taken"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".worktrees/taken/x"), "");
    const first = cli(["task", "--write", "--name", "taken", "go"]);
    expect(first.status).toBe(1);
    expect(gitIn(repo, "branch", "--list", "taken").stdout).toBe("");
    expect(fs.existsSync(path.join(root, "taken"))).toBe(false);
    fs.rmSync(path.join(repo, ".worktrees"), { recursive: true });
    expect(cli(["task", "--write", "--name", "taken", "go"]).status).toBe(0);
  });

  test("--write=false, misspelled flags and empty bases are refused", () => {
    fs.writeFileSync(path.join(repo, "new.txt"), "two\n");
    expect(cli(["task", "--write=false", "go"]).stderr).toContain("--write takes no value");
    expect(cli(["task", "--wrtie", "--name", "x", "go"]).stderr).toContain("unknown flag: --wrtie");
    expect(cli(["review", "--adverserial"]).stderr).toContain("unknown flag");
    expect(cli(["review", "--base="]).stderr).toContain("no such commit");
    expect(fs.existsSync(root) ? laneNames() : []).toEqual([]);
  });

  test("an old branch with nothing new is not reviewed", () => {
    fs.writeFileSync(path.join(repo, "b.txt"), "two\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-qm", "b");
    gitIn(repo, "checkout", "-qb", "old", "HEAD~1");
    expect(cli(["review"]).stderr).toContain("nothing to review");
    expect(cli(["review", "--base", "main"]).stderr).toContain("nothing to review");
  });

  test("a read-only Claude lane blocks git's own write flags", () => {
    fs.writeFileSync(path.join(repo, "new.txt"), "two\n");
    scenario({ lines: [] });
    cli(["review", "--backend", "claude"]);
    const denied = calls()[0].argv.join(" ");
    for (const rule of [
      "Bash(git diff *--output*)",
      "Bash(git log *--output*)",
      "Bash(git show *--ext-diff*)",
    ])
      expect(denied).toContain(rule);
  });

  test("a read-only Claude lane drops user hooks that can see Bash, and keeps the others", () => {
    fs.mkdirSync(path.join(base, ".claude"), { recursive: true });
    const hook = (matcher: unknown, command: string) => ({
      matcher,
      hooks: [{ type: "command", command }],
    });
    fs.writeFileSync(
      path.join(base, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            hook("Bash", "bash-guard"),
            hook("", "any-guard"),
            hook("Read|Bash", "mixed-guard"),
            hook("Read", "read-guard"),
          ],
        },
      }),
    );
    fs.writeFileSync(path.join(repo, "new.txt"), "two\n");
    scenario({ lines: [] });
    cli(["review", "--backend", "claude"]);
    const argv = calls()[0].argv;
    const settings = argv[argv.indexOf("--settings") + 1]!;
    expect(settings).toContain("read-guard");
    for (const dropped of ["bash-guard", "any-guard", "mixed-guard"])
      expect(settings).not.toContain(dropped);
  });

  test("stop right after batch reaches the lane", async () => {
    const manifest = path.join(base, "stop.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({ root, stagger_seconds: 0, lanes: [{ name: "b", dir: repo, prompt }] }),
    );
    scenario({ sleep: 5 });
    expect(spawnSync(BIN, ["batch", manifest], { env: callerEnv }).status).toBe(0);
    await until(() => fs.existsSync(path.join(root, "b", "state.json")));
    const result = cli(["stop", "b"]);
    expect(result.stderr).not.toContain("older runner");
    expect(result.status).toBe(0);
  });

  test("a report with no usable status still ends the lane", () => {
    for (const [index, report] of [
      { summary: "s" },
      { status: 5 },
      { status: null },
      { status: ["done"] },
      { foo: 1 },
    ].entries()) {
      scenario({ report });
      const result = cli(["task", "--name", `odd-${index}`, "go"]);
      expect(result.stderr).not.toContain("expected string");
      expect(laneState(`odd-${index}`).status).toBe("partial");
    }
    scenario({ report: [1, 2] });
    cli(["task", "--name", "not-object", "go"]);
    expect(laneState("not-object").status).toBe("failed");
  });

  test("a backend that fails after its report can't end the lane done", () => {
    scenario({
      exit: 1,
      report: { status: "done", summary: "all good", files_changed: [], questions: [] },
    });
    const result = cli(["task", "--name", "bad-exit", "go"]);
    expect(laneState("bad-exit").status).toBe("partial");
    expect(result.stdout).toContain("warning: codex exited with an error");
    expect(result.status).toBe(1);
  });

  test("read-only hooks: only plain read-tool matchers survive, and sandbox can't auto-allow", () => {
    fs.mkdirSync(path.join(base, ".claude"), { recursive: true });
    const hook = (matcher: unknown, command: string) => ({
      matcher,
      hooks: [{ type: "command", command }],
    });
    fs.writeFileSync(
      path.join(base, ".claude/settings.json"),
      JSON.stringify({
        sandbox: { enabled: true },
        hooks: {
          PreToolUse: [
            hook(".*", "dot-star"),
            hook("[Bb]ash", "class"),
            hook("Ba.*", "prefix"),
            hook("NotebookEdit", "notebook"),
            hook("Read|Grep", "kept"),
          ],
        },
      }),
    );
    fs.writeFileSync(path.join(repo, "new.txt"), "two\n");
    scenario({ lines: [] });
    cli(["review", "--backend", "claude"]);
    const argv = calls()[0].argv;
    const settings = argv[argv.indexOf("--settings") + 1]!;
    expect(settings).toContain("kept");
    for (const dropped of ["dot-star", "class", "prefix", "notebook"])
      expect(settings).not.toContain(dropped);
    expect(JSON.parse(settings).sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: false,
    });
    expect(argv).toContain("NotebookEdit");
  });

  test("a non-lean read-only Claude lane is refused", () => {
    const result = cli([
      "run",
      "x",
      "--dir",
      repo,
      "--prompt",
      prompt,
      "--backend",
      "claude",
      "--sandbox",
      "read-only",
      "--no-lean",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--no-lean");
  });

  test("misspelled flags and manifest fields can't turn read-only into writing", () => {
    expect(
      cli(["run", "x", "--dir", repo, "--prompt", prompt, "--sanbox", "read-only"]).stderr,
    ).toContain("unknown flag: --sanbox");
    for (const args of [
      ["continue", "x", "hi", "--nope"],
      ["answer", "x", "hi", "--nope"],
      ["stop", "x", "--nope"],
      ["wait", "--nope"],
      ["status", "--nope"],
    ])
      expect(cli(args).stderr).toContain("unknown flag");
    const manifest = path.join(base, "typo.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        root,
        stagger_seconds: 0,
        sanbox: "read-only",
        lanes: [{ name: "t", dir: repo, prompt }],
      }),
    );
    expect(
      spawnSync(BIN, ["batch", manifest], { env: callerEnv, encoding: "utf8" }).stderr,
    ).toContain("unknown field: sanbox");
  });

  test("a manifest's top-level sandbox and schema reach its lanes", async () => {
    const manifest = path.join(base, "top.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        root,
        stagger_seconds: 0,
        sandbox: "read-only",
        schema: "review",
        lanes: [{ name: "t", dir: repo, prompt }],
      }),
    );
    scenario({ report: { status: "done", summary: "fine", findings: [] } });
    expect(spawnSync(BIN, ["batch", manifest], { env: callerEnv }).status).toBe(0);
    await until(
      () => fs.existsSync(path.join(root, "t", "state.json")) && laneState("t").status === "done",
    );
    expect(laneState("t")).toMatchObject({ sandbox: "read-only", schema: "review" });
  });

  test("run refuses a live lane, and a fresh run forgets the old session", async () => {
    scenario({
      lines: [THREAD],
      report: { status: "done", summary: "first", files_changed: [], questions: [] },
    });
    expect(
      cli(["run", "again", "--dir", repo, "--prompt", prompt, "--sandbox", "read-only"]).status,
    ).toBe(0);
    expect(laneState("again").thread_id).toBe("t1");
    scenario({ lines: [], exit: 1 });
    cli(["run", "again", "--dir", repo, "--prompt", prompt]);
    expect(laneState("again").thread_id).toBeFalsy();
    expect(calls().at(-1)!.argv).not.toContain("resume");
    scenario({ lines: [THREAD], sleep: 5 });
    cli(["task", "--background", "--name", "live", "go"]);
    await started("live");
    const result = cli(["run", "live", "--dir", repo, "--prompt", prompt]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("still running");
    cli(["stop", "live"]);
  });

  test("two continues at once: one runs, the other is told, and the lane survives", async () => {
    scenario({
      lines: [THREAD],
      report: { status: "done", summary: "fine", files_changed: [], questions: [] },
    });
    cli(["task", "--name", "both", "go"]);
    scenario({
      lines: [THREAD],
      sleep: 2,
      report: { status: "done", summary: "fine", files_changed: [], questions: [] },
    });
    const results = await Promise.all(
      ["one", "two"].map(
        (text) =>
          new Promise<number>((resolve) => {
            spawn(BIN, ["continue", "both", text, "--root", root], {
              env: callerEnv,
              cwd: repo,
              stdio: "ignore",
            }).on("exit", (code) => resolve(code ?? -1));
          }),
      ),
    );
    expect(results.filter((code) => code === 0).length).toBe(1);
    await settle2("both");
    expect(laneState("both").status).toBe("done");
    expect(fs.existsSync(path.join(root, "both", "start.lock"))).toBe(false);
  });

  test("result exits 75 while a lane runs", async () => {
    scenario({ sleep: 5 });
    cli(["task", "--background", "--name", "wip", "go"]);
    await started("wip");
    expect(cli(["result", "wip"]).status).toBe(75);
    expect(cli(["result", "wip", "--json"]).status).toBe(75);
    cli(["stop", "wip"]);
  });

  test("a live driver with no start time is never killed or signalled on a guess", async () => {
    const sleeper = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    const dir = path.join(root, "old");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({
        name: "old",
        dir: repo,
        prompt: "",
        state_dir: dir,
        model: "m",
        status: "running",
        driver_pid: sleeper.pid,
        started: "2026-01-01T00:00:00Z",
      }),
    );
    expect(cli(["status"]).stdout).toContain("running");
    expect(cli(["stop", "old"]).stderr).toContain("older runner");
    expect(sleeper.exitCode).toBe(null);
    expect(sleeper.signalCode).toBe(null);
    sleeper.kill("SIGKILL");
  });

  test("wait doesn't hang on an older runner's lane", () => {
    const dir = path.join(root, "older");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({
        name: "older",
        dir: repo,
        prompt: "",
        state_dir: dir,
        model: "m",
        status: "running",
      }),
    );
    expect(cli(["wait"]).stderr).toContain("older runner");
  });

  test("--base keeps uncommitted work in the brief, and a stale local main isn't the base", () => {
    fs.writeFileSync(path.join(repo, "new.txt"), "two\n");
    scenario({ report: { status: "done", summary: "fine", findings: [] } });
    expect(cli(["review", "--base", "main", "--name", "dirty"]).status).toBe(0);
    expect(lanePrompt("dirty")).toContain("uncommitted changes");
    fs.rmSync(path.join(repo, "new.txt"));
    fs.writeFileSync(path.join(repo, "b.txt"), "two\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-qm", "b");
    gitIn(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    gitIn(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    gitIn(repo, "checkout", "-qb", "topic");
    gitIn(repo, "branch", "-f", "main", "HEAD~1");
    expect(cli(["review"]).stderr).toContain("nothing to review");
  });

  test("unrelated histories are an error, not an empty or runnable review", () => {
    gitIn(repo, "checkout", "-q", "--orphan", "other");
    fs.writeFileSync(path.join(repo, "o.txt"), "o\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-qm", "other");
    expect(cli(["review", "--base", "main"]).stderr).toContain("can't compare");
  });

  test("a refused continue leaves no lock, so the retry gets the real answer", () => {
    scenario({
      lines: [THREAD],
      report: { status: "done", summary: "fine", files_changed: [], questions: [] },
    });
    cli(["task", "--name", "ro2", "go"]);
    expect(cli(["continue", "ro2", "x", "--sandbox", "bogus"]).stderr).toContain("--sandbox:");
    expect(cli(["continue", "ro2", "x", "--sandbox", "workspace-write"]).stderr).toContain(
      "can't start writing",
    );
    expect(fs.existsSync(path.join(root, "ro2", "start.lock"))).toBe(false);
    expect(cli(["continue", "ro2", "x"]).status).toBe(0);
  });

  test("a lock left by a crash clears itself, and a fresh one still refuses", () => {
    scenario({
      lines: [THREAD],
      report: { status: "done", summary: "fine", files_changed: [], questions: [] },
    });
    cli(["task", "--name", "crash", "go"]);
    const lock = path.join(root, "crash", "start.lock");
    fs.mkdirSync(lock);
    expect(cli(["continue", "crash", "x"]).stderr).toContain("in progress");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    expect(cli(["continue", "crash", "x"]).status).toBe(0);
  });

  test("two runs at once under one name start one backend", async () => {
    scenario({ lines: [THREAD, DONE], report: REPORT, sleep: 2 });
    const codes = await Promise.all(
      [1, 2].map(
        () =>
          new Promise<number>((resolve) => {
            spawn(BIN, ["run", "twin", "--dir", repo, "--prompt", prompt, "--root", root], {
              env: callerEnv,
              cwd: repo,
              stdio: "ignore",
            }).on("exit", (code) => resolve(code ?? -1));
          }),
      ),
    );
    expect(codes.filter((code) => code !== 0).length).toBe(1);
    expect(calls().length).toBe(1);
  });

  test("the internal start flag is gone from the public command", () => {
    expect(cli(["run", "x", "--dir", repo, "--prompt", prompt, "--claimed"]).stderr).toContain(
      "unknown flag",
    );
  });

  test("batch refuses before starting anything", async () => {
    const batch = (body: object) => {
      const manifest = path.join(base, "pre.json");
      fs.writeFileSync(manifest, JSON.stringify({ root, stagger_seconds: 0, ...body }));
      return spawnSync(BIN, ["batch", manifest], { env: callerEnv, encoding: "utf8" });
    };
    const lane = { name: "p", dir: repo, prompt };
    expect(
      batch({ lanes: [{ ...lane, backend: "claude", sandbox: "read-only", lean: false }] }).stderr,
    ).toContain("can't be read-only");
    expect(batch({ sandbox: "readonly", lanes: [lane] }).stderr).toContain("sandbox must be");
    expect(batch({ schema: "/no/such/schema.json", lanes: [lane] }).stderr).toContain(
      "no such file",
    );
    expect(batch({ delay: 9, lanes: [lane] }).stderr).toContain("unknown field: delay");
    expect(batch({ lanes: [{ ...lane, root: "/tmp/x" }] }).stderr).toContain("unknown field: root");
    expect(fs.existsSync(path.join(root, "p", "state.json"))).toBe(false);
    scenario({ sleep: 5 });
    cli(["task", "--background", "--name", "p", "go"]);
    await started("p");
    const busy = batch({ lanes: [lane] });
    expect(busy.status).toBe(1);
    expect(busy.stderr).toContain("still running");
    cli(["stop", "p"]);
  });

  test("a manifest's read-only applies to every backend in it", async () => {
    const manifest = path.join(base, "mix.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        root,
        stagger_seconds: 0,
        backend: "codex",
        sandbox: "read-only",
        lanes: [{ name: "mixed", dir: repo, prompt, backend: "claude" }],
      }),
    );
    scenario({ lines: [] });
    expect(spawnSync(BIN, ["batch", manifest], { env: callerEnv }).status).toBe(0);
    await until(() => fs.existsSync(path.join(root, "mixed", "state.json")));
    expect(laneState("mixed").sandbox).toBe("read-only");
  });

  test("continue can't make a non-lean Claude lane read-only", () => {
    scenario({ lines: [] });
    cli(["run", "nl", "--dir", repo, "--prompt", prompt, "--backend", "claude", "--no-lean"]);
    const dir = path.join(root, "nl", "state.json");
    fs.writeFileSync(
      dir,
      JSON.stringify({
        ...laneState("nl"),
        status: "done",
        thread_id: "abc",
        session_started: true,
      }),
    );
    expect(cli(["continue", "nl", "look", "--sandbox", "read-only"]).stderr).toContain(
      "can't be read-only",
    );
    expect(laneState("nl").sandbox).toBe("workspace-write");
  });

  test("a dead lane's backend pid with no start time is left alone", () => {
    const stranger = spawn("/bin/sleep", ["30"], { stdio: "ignore", detached: true });
    const dir = path.join(root, "gone");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({
        name: "gone",
        dir: repo,
        prompt: "",
        state_dir: dir,
        model: "m",
        status: "running",
        driver_pid: 999999,
        driver_started: "x",
        pid: stranger.pid,
        started: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
      }),
    );
    expect(cli(["status"]).stdout).toContain("failed");
    expect(stranger.signalCode).toBe(null);
    stranger.kill("SIGKILL");
  });

  test("wait moves on from a lane it can't check, and stop --forget frees its name", () => {
    const stranger = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    const dir = path.join(root, "stuck");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({
        name: "stuck",
        dir: repo,
        prompt: "",
        state_dir: dir,
        model: "m",
        status: "running",
        driver_pid: stranger.pid,
        started: "2026-01-01T00:00:00Z",
      }),
    );
    expect(cli(["wait"]).stderr).toContain("older runner");
    expect(cli(["stop", "stuck"]).stderr).toContain("--forget");
    expect(cli(["stop", "stuck", "--forget"]).status).toBe(0);
    expect(laneState("stuck").status).toBe("stopped");
    expect(stranger.signalCode).toBe(null);
    stranger.kill("SIGKILL");
  });

  test("a resumed lane drops the old warning", async () => {
    scenario({
      lines: [THREAD],
      exit: 1,
      report: { status: "done", summary: "s", files_changed: [], questions: [] },
    });
    cli(["task", "--name", "warned", "go"]);
    expect(laneState("warned").warning).toBeTruthy();
    scenario({
      lines: [THREAD],
      report: { status: "done", summary: "s", files_changed: [], questions: [] },
    });
    cli(["continue", "warned", "again"]);
    await settle2("warned");
    expect(laneState("warned").warning).toBeFalsy();
  });

  test("a settings.json holding null doesn't crash a Claude lane", () => {
    fs.mkdirSync(path.join(base, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(base, ".claude/settings.json"), "null");
    scenario({ lines: [] });
    const result = cli(["task", "--backend", "claude", "--name", "nullset", "go"]);
    expect(result.stderr).not.toContain("Cannot read properties");
  });

  test("stop --forget refuses a lane whose driver is alive, and so does a typed _run", async () => {
    scenario({ sleep: 5 });
    cli(["task", "--background", "--name", "alive", "go"]);
    await started("alive");
    const result = cli(["stop", "alive", "--forget"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("driver is running");
    expect(laneState("alive").status).toBe("running");
    expect(cli(["_run", "alive", "--dir", repo, "--prompt", prompt]).stderr).toContain(
      "still running",
    );
    cli(["stop", "alive"]);
  });

  test("bidi controls can't reorder a finding", () => {
    scenario({ report: { status: "done", summary: "ok\u202Efake", findings: [] } });
    fs.writeFileSync(path.join(repo, "new.txt"), "two\n");
    expect(cli(["review"]).stdout).not.toContain("\u202E");
  });

  test("lane text can't move the terminal in result", () => {
    scenario({ report: { status: "done", summary: "ok\u001b[2Jfake", findings: [] } });
    fs.writeFileSync(path.join(repo, "new.txt"), "two\n");
    expect(cli(["review"]).stdout).not.toContain("\u001b");
  });
});
