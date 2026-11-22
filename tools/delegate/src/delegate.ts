/**
 * delegate: run Codex CLI, Claude Code, Gemini CLI or Antigravity (agy) lanes unattended, on the logins you already have.
 *
 * Each lane keeps state in <root>/<name>/: state.json, events.jsonl (raw backend stream), report.json (structured
 * final report), stderr.log. On "model at capacity" or an API overload the lane resumes the same session after a
 * backoff. A usage or rate limit stops the lane as "limited" without retrying.
 *
 * Compiled to a native binary with scriptc: `bun run build`. The binary needs no JS runtime.
 */

declare function flock(fd: number, operation: number): number;
declare function setCloexec(fd: number): number;
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REPORT_SCHEMA, REVIEW_SCHEMA } from "./schemas";

const VERSION = "0.1.0";
const USAGE = `delegate: run Codex CLI, Claude Code, Gemini CLI or Antigravity (agy) lanes unattended.

  delegate review [--adversarial] [--base REF] [--focus TEXT]
                                           the other model reviews this repo's changes, read-only
  delegate task "TEXT" [--write]    the other model takes this on, read-only unless --write,
                                           which gives it its own worktree and branch
  delegate result [NAME] [--json]   print a lane's report; exits 1 if it failed, 75 if still running
  delegate open [NAME] [--report | --terminal]   open a lane's text report, or resume it in Terminal
  delegate notify [NAME] [--terminal]   repost a clickable alert for a finished lane
  delegate archive [--session ID] [--root R]   hide finished lanes for one orchestrator
  delegate restore [--session ID] [--root R]   return its archived lanes to the list
  delegate clear [--session ID] [--root R] [--yes]   preview or remove its archived lane records
  delegate prune [--days N] [--root R] [--yes]   remove finished local records older than N days (default 7)
  delegate batch MANIFEST.json [--dry-run]   preview or start lanes in the background
  delegate run NAME --dir D --prompt FILE [--root R] [--backend codex|claude|gemini|agy]
                                           one lane in the foreground
  delegate status [--root R] [--session ID] [--archived] [--json]   show lanes and next actions
  delegate wait [NAME] [--session ID | --all]   wait for the selected lanes to finish
  delegate answer [NAME] TEXT [--root R]   resume a lane that asked a question
  delegate continue [NAME] TEXT [--sandbox S]   follow up on a finished lane in the same session
  delegate stop [NAME] [--root R] [--forget]   stop a queued, running or retrying lane
  delegate build [--solo] -- CMD...  run CMD through build-queue when installed (one machine-wide limit),
                                 else holding one of N lane build slots (default 2)
  delegate doctor                   show which backends and folders it found
  delegate --version

review and task flags: --backend --model --effort --name --title --root --idle-timeout --background.
Implicit lane selection stays within the current project and orchestrator. Mutations require a NAME if ambiguous.
Pass --run-id ID with NAME to target an exact run. On Claude, Gemini and Antigravity, read-only is best effort: Codex alone enforces it with a sandbox.

run flags: --root --backend --model --effort --delay --add-dir --derived-data --build-slots --idle-timeout
  --schema (a file, or "review") --shared-context --no-lean.
  --sandbox (Claude/Gemini/Antigravity: read-only drops edits and builds). Codex only: --network --xcode --spm-seed --trust-hooks.
  Claude only: --allowed-tools (comma list) --fallback-model.`;

const HOME = os.homedir();
/** An absolute path. Manifests and agents often pass ~ with no shell to expand it. */
const abs = (file: string) =>
  path.resolve(file === "~" ? HOME : file.startsWith("~/") ? path.join(HOME, file.slice(2)) : file);
const NAME = "delegate";
const setting = (suffix: string): string | undefined => process.env[`DELEGATE_${suffix}`] || undefined;
const CACHE = path.join(HOME, ".cache", NAME);
const PRIVATE_DIR = 0o700; // prompts and transcripts live here
const SLOTS_DIR = path.join(CACHE, "build-slots");
const DEFAULT_ROOT = path.join(CACHE, "runs");
const BACKOFF = (setting("BACKOFF") ?? "60,120,240,480").split(",").map(Number);
const TERMINAL = new Set([
  "done",
  "partial",
  "blocked",
  "failed",
  "needs_input",
  "limited",
  "stopped",
]);
const ACTIVE = new Set(["queued", "running", "retrying"]);
const ARCHIVABLE = new Set(["done", "partial", "failed", "stopped"]);
const DEFAULT_IDLE_TIMEOUT = 3600; // generous: a lane can sit silently through a long build or a wait for a build slot
const PIPE_GRACE_MS = 5000; // keep reading after the backend exits; a background child may hold stdout open
const DRIVER_START_GRACE_S = 120; // a resumed lane has this long to record its driver before it counts as dead
const STOP_GRACE_S = 60; // a crashed `stop` must not hide a dead driver for longer than this
const DRIVER_NEEDLES = [NAME];
const CONTINUE =
  "The previous turn stopped because the model was at capacity. Continue the same task " +
  "from where you stopped. Check what is already done in the worktree before redoing anything.";
// Matched against provider error messages only, never a whole event: its ids and durations contain digits.
// Overload wording wins over a status number: "overloaded (status 429)" is worth a retry.
const OVERLOAD_RE =
  /at capacity|capacity|overloaded|high demand|exceeded retry limit, last status: 5\d\d/i;
const LIMIT_RE =
  /usage.?limit|session limit|weekly limit|hit your [^.]*limit|rate.?limit|quota|too many requests|(?:status|http|error)\D{0,8}429\b/i;
const SERVER_ERROR_RE = /(?:status|http|error)\D{0,8}(?:503|529)\b/i;
const CLAUDE_BASH = [
  "git status",
  "git diff",
  "git log",
  "git add",
  "git commit",
  "git show",
  "just",
  "xcodebuild",
  "xcodegen",
  "swift",
  "swiftlint",
  "rg",
  "fd",
  "bun",
  "delegate build",
];
// Folders xcodebuild, SwiftPM and xcodegen write outside the worktree (opened by the xcode option, codex only).
const XCODE_ROOTS = [
  "Library/Caches/org.swift.swiftpm",
  "Library/org.swift.swiftpm",
  "Library/Caches/com.apple.dt.Xcode",
  "Library/Caches/com.apple.dt.xcodebuild",
  "Library/Developer/Xcode",
  ".xcodegen",
  "Library/Caches/mise",
  ".cache/clang",
  "Library/Logs/CoreSimulator",
].map((dir) => path.join(HOME, dir));
const CLAUDE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];
const CLAUDE_READ_ONLY = [
  "Read",
  "Glob",
  "Grep",
  ...["git status", "git diff", "git log", "git show"].flatMap((cmd) => [
    `Bash(${cmd})`,
    `Bash(${cmd} *)`,
  ]),
];
// these read commands can still write: `git diff --output=FILE`, and --ext-diff runs a configured program
const CLAUDE_GIT_WRITES = ["diff", "log", "show"].flatMap((cmd) => [
  `Bash(git ${cmd} *--output*)`,
  `Bash(git ${cmd} *--ext-diff*)`,
]);
const FALLBACKS: Record<Backend, string[]> = {
  codex: ["/opt/homebrew/bin/codex", path.join(HOME, ".local/bin/codex"), "/usr/local/bin/codex"],
  claude: [
    path.join(HOME, ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ],
  gemini: [
    path.join(HOME, ".local/share/mise/shims/gemini"),
    "/opt/homebrew/bin/gemini",
    path.join(HOME, ".local/bin/gemini"),
    "/usr/local/bin/gemini",
  ],
  agy: [
    path.join(HOME, ".local/bin/agy"),
    "/usr/local/bin/agy",
    "/opt/homebrew/bin/agy",
  ],
};
const EXTRA_PATH = [
  "/opt/homebrew/bin",
  path.join(HOME, ".local/bin"),
  path.join(HOME, ".local/share/mise/shims"),
];
const DEFAULT_MODEL: Record<Backend, string> = {
  codex: "gpt-6.1-sol",
  claude: "sonnet",
  gemini: "auto",
  agy: "gemini-3.8-flash-high",
};
const FOOTER_READ_ONLY =
  "Standing rules for this lane.\n" +
  "This lane is read-only: do not edit files or run builds. Fill the structured report honestly: status " +
  "needs_input with questions if a decision is the user's.\n";
// Shared prefix of every lane prompt. Keep it identical across lanes so provider prompt caches hit.
const FOOTER =
  "Standing rules for this lane.\n" +
  `Before finishing, build once with \`${NAME} build -- <build command>\` and fix every error and warning ` +
  "in files you changed; run focused tests the same way. Fill the structured report honestly: status " +
  "needs_input with questions if a decision is the user's.\n";

type Backend = "codex" | "claude" | "gemini" | "agy";
type Failure = "limit" | "capacity";
type RunResult = "ok" | "error" | "hung" | Failure;
type Sandbox = "read-only" | "workspace-write";

interface Usage {
  input?: number;
  cached?: number;
  output?: number;
}

/** state.json. Older lanes lack the newer fields, so everything but the identity is optional. */
interface State {
  name: string;
  title?: string;
  run_id?: string;
  base_commit?: string;
  backend?: Backend;
  dir: string;
  /** The folder a lane was asked from, when it runs somewhere else, such as a worktree. */
  origin?: string;
  orchestrator?: string;
  archived?: boolean;
  prompt: string;
  prompt_full?: string;
  shared_context?: string;
  lean?: boolean;
  state_dir: string;
  model: string;
  resolved_model?: string;
  effort?: string;
  add_dirs?: string[];
  network?: boolean;
  xcode?: boolean;
  trust_hooks?: boolean;
  derived_data?: string;
  build_slots?: number;
  schema?: string | null;
  sandbox?: Sandbox;
  allowed_tools?: string[] | null;
  fallback_model?: string;
  status?: string;
  started?: string;
  started_ms?: number;
  updated?: string;
  attempts?: number;
  pid?: number | null;
  driver_pid?: number | null;
  driver_started?: string;
  pid_started?: string;
  stopping?: boolean;
  thread_id?: string;
  session_started?: boolean;
  last_activity?: string;
  detail?: string;
  questions?: string[];
  warning?: string;
  usage?: Usage;
  retry_at?: number | null;
  idle_timeout?: number;
  last_error?: string;
  limit_reset?: number | null;
}

/** What one backend invocation learned from its event stream. */
interface RunContext {
  failure?: Failure;
  error?: boolean;
  errorText?: string;
  limitReset?: number;
  seen?: boolean;
  model?: string;
  assistantText?: string;
  preToolText?: string;
  result?: Record<string, any>;
  toolReport?: unknown;
}

const sleep = (seconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
type Sig = "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";
const die = (message: string): never => {
  console.error(message);
  // a driver that dies must not leave its detached backend running
  if (childPid) killGroup(childPid, "SIGTERM");
  process.exit(1);
};

function resolveBin(backend: Backend): string {
  const override = setting(backend.toUpperCase());
  if (override) return override;
  const onPath = (process.env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .map((dir) => path.join(dir, backend));
  for (const candidate of [...onPath, ...FALLBACKS[backend]]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return backend;
}

/** PATH for children: this tool and the usual tool folders first. GUI apps start with a bare PATH. */
function lanePath(): string {
  const inherited = (process.env.PATH || "/usr/bin:/bin").split(":").filter(Boolean);
  return [...new Set([path.dirname(process.execPath), ...EXTRA_PATH, ...inherited])].join(":");
}

/** The optional lifecycle hook. Nothing runs unless you set one. */
const hook = (): string | undefined => {
  const script = setting("HOOK");
  return script ? abs(script) : undefined;
};

const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** A schema's text: `review`, a file, or the default report. */
function schemaText(state: State): string {
  if (!state.schema) return REPORT_SCHEMA;
  return state.schema === "review" ? REVIEW_SCHEMA : fs.readFileSync(state.schema, "utf8");
}

/** Shared prefix first (footer, optional batch context), lane brief last, so prefixes cache across lanes. */
function buildPrompt(base: string, brief: string, shared: string, readOnly: boolean): string {
  const parts = [readOnly ? FOOTER_READ_ONLY : FOOTER];
  if (shared) parts.push(fs.readFileSync(shared, "utf8"));
  parts.push("# Lane brief\n\n" + fs.readFileSync(brief, "utf8"));
  const out = path.join(base, "prompt.full.md");
  fs.rmSync(out, { force: true }); // never write through a link left in the root
  fs.writeFileSync(out, parts.join("\n"));
  return out;
}

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

function ageSeconds(stamp?: string): number {
  const time = Date.parse(stamp ?? "");
  return Number.isNaN(time) ? Infinity : (Date.now() - time) / 1000;
}

const isInside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel));
};

/** The real path, for a path whose tail may not exist yet. */
function realish(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    const parent = path.dirname(file);
    return parent === file ? file : path.join(realish(parent), path.basename(file));
  }
}

/**
 * A lane must not be able to edit its own state, because state.json decides its sandbox on the next resume.
 * Codex's workspace-write also opens /tmp and $TMPDIR. Claude lanes have no sandbox, so only their folder counts.
 */
function rootProblem(
  root: string,
  backend: Backend,
  dir: string,
  addDirs: string[],
  xcode: boolean,
): string | undefined {
  const writable = [dir];
  if (backend === "codex" || backend === "agy") {
    writable.push(...addDirs, "/tmp");
    if (xcode) writable.push(...XCODE_ROOTS);
    if (process.env.TMPDIR) writable.push(process.env.TMPDIR);
  }
  const real = realish(root);
  for (const folder of writable) {
    if (isInside(real, realish(folder)))
      return `root ${root} is writable by the lane (${folder}); put it elsewhere, such as under ~/.cache`;
  }
  return undefined;
}

const SAFE_ID = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

/** state.json reaches argv on every spawn, so nothing in it may have moved a lane out of its limits. */
function stateProblem(root: string, name: string, state: State): string | undefined {
  if (!laneDirectory(laneDir(root, name))) return "lane folder is not a real directory";
  if (realish(state.state_dir) !== realish(laneDir(root, name)))
    return "state_dir does not match the lane";
  if (state.thread_id && !SAFE_ID.test(state.thread_id)) return "thread_id is not a session id";
  if (String(state.model).startsWith("-") || String(state.effort ?? "").startsWith("-"))
    return "model or effort looks like a flag";
  const addDirs: unknown = state.add_dirs ?? [];
  if (!Array.isArray(addDirs) || addDirs.some((dir) => typeof dir !== "string"))
    return "add_dirs is not a list of paths";
  return rootProblem(root, backendOf(state), state.dir, state.add_dirs ?? [], Boolean(state.xcode));
}

/** A lane name becomes a folder, so it must not climb out of the root. Older lanes may have looser names. */
function laneDir(root: string, name: string): string {
  if (!name || name === "." || name === ".." || name.includes("/") || name.startsWith("-"))
    return die(`bad lane name: ${name}`);
  return path.join(root, name);
}

/** New lanes get plain names: no control characters, and no leading dot, which retired lane folders use. */
const LANE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function checkNewName(root: string, name: string): void {
  if (!laneDirectory(laneDir(root, name)) && !LANE_NAME.test(name))
    die(`bad lane name: ${JSON.stringify(name)} (use letters, digits, dot, dash, underscore)`);
}

function writeReport(base: string, report: Record<string, unknown>): void {
  const tmp = path.join(base, "report.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2));
  fs.renameSync(tmp, path.join(base, "report.json"));
}

function laneDirectory(dir: string): boolean {
  try { return fs.lstatSync(dir).isDirectory(); } catch { return false; }
}

/** strict throws on a state.json that exists but can't be read, instead of returning an empty lane. */
function loadState(root: string, name: string, strict = false): State {
  const dir = laneDir(root, name);
  const file = path.join(dir, "state.json");
  try {
    if (laneDirectory(dir)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error: unknown) {
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`can't read ${file}: ${String(error)}`);
  }
  return { name: "", dir: "", prompt: "", state_dir: "", model: "" };
}

/** Read, merge and replace state.json under a flock, so the driver and a lead command never drop each other's fields. */
function saveState(root: string, name: string, changes: Partial<State>): State {
  const dir = laneDir(root, name);
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });
  const lock = fs.openSync(path.join(dir, "state.lock"), "a");
  try {
    setCloexec(lock);
    if (flock(lock, 2) !== 0) return die(`${name}: can't lock state.json`); // LOCK_EX, waits
    let current: State;
    try {
      current = loadState(root, name, true);
    } catch (error) {
      // Merging into an empty state would erase the lane, so stop instead (die also stops the backend).
      return die(`${name}: ${String(error)}`);
    }
    const state = { ...current, ...changes, updated: now() };
    const tmp = path.join(dir, `state.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, path.join(dir, "state.json"));
    return state;
  } finally {
    fs.closeSync(lock);
  }
}

function addUsage(root: string, name: string, input: number, cached: number, output: number): void {
  const usage = loadState(root, name).usage ?? {};
  saveState(root, name, {
    usage: {
      input: (usage.input ?? 0) + input,
      cached: (usage.cached ?? 0) + cached,
      output: (usage.output ?? 0) + output,
    },
  });
}

const backendOf = (state: Partial<State>): Backend => state.backend ?? "codex";
const label = (state: Partial<State>) => {
  const backend = backendOf(state);
  return backend === "claude"
    ? "Claude"
    : backend === "gemini"
      ? "Gemini"
      : backend === "agy"
        ? "Antigravity"
        : "Codex";
};
const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const NOTIFY_TIMEOUT_MS = 6000; // a stuck notification must never hold up a lane
const NOTIFIERS = setting("NOTIFIERS") || path.join(HOME, "Applications/Delegate");
const notifierBin = (backend: Backend) =>
  path.join(NOTIFIERS, `${backend}.app/Contents/MacOS/notifier`);

const REPORT_HEADLINE: Record<string, string> = {
  done: "is done",
  partial: "stopped partway",
  needs_input: "needs your answer",
  blocked: "is blocked",
};

/** Whole-line text: alerts show one paragraph and osascript takes it as a quoted string. */
function alertText(text: string, max: number): string {
  const flat = text
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/ +/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}\u2026` : flat;
}

/** "15:40" today, "Nov 7 15:40" on another day, in the user's own time. */
function localTime(seconds: number): string {
  const date = new Date(seconds * 1000);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const today = date.toDateString() === new Date().toDateString();
  return today ? time : `${date.toDateString().slice(4, 10)} ${time}`;
}

/** Title leads with the lane and its state; the subtitle says whose lane and where. */
function notify(state: Partial<State>, headline: string, message: string, terminal = setting("OPEN_TARGET") === "terminal"): boolean {
  if (setting("NO_NOTIFY")) return false;
  const folder = state.origin ?? state.dir;
  const project = folder ? path.basename(folder) : "";
  const title = alertText(`${state.name} ${headline}`, 80);
  const model = state.resolved_model || state.model || "";
  const subtitle = alertText([label(state), model, project].filter(Boolean).join(" \u00b7 "), 80);
  const text = alertText(message, 220);
  if (process.platform !== "darwin") {
    spawnSync("notify-send", ["--app-name=delegate", "--", title, `${subtitle}\n${text}`], {
      stdio: "ignore",
      timeout: NOTIFY_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    return false;
  }
  const notifier = notifierBin(backendOf(state));
  const target = terminal && state.status !== "needs_input" ? "terminal" : "report";
  if (
    state.name && state.state_dir &&
    fs.existsSync(notifier) &&
    spawnSync(
      notifier,
      [title, subtitle, text, process.execPath, path.dirname(state.state_dir), state.name,
        ...(state.run_id ? [target, state.run_id] : terminal ? ["terminal"] : [])],
      { stdio: "ignore", timeout: NOTIFY_TIMEOUT_MS, killSignal: "SIGKILL" },
    ).status === 0
  )
    return true;
  // osascript always shows the Script Editor icon, so it is only the fallback
  const quote = JSON.stringify;
  const script = `display notification ${quote(text)} with title ${quote(title)} subtitle ${quote(subtitle)} sound name "Glass"`;
  spawnSync(setting("OSASCRIPT") || "/usr/bin/osascript", ["-e", script], {
    stdio: "ignore",
    timeout: NOTIFY_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return false;
}

/** "limit" stops the lane, "capacity" is worth a retry, undefined is an ordinary error. */
function classifyFailure(text: string): Failure | undefined {
  if (OVERLOAD_RE.test(text)) return "capacity";
  if (LIMIT_RE.test(text)) return "limit";
  return SERVER_ERROR_RE.test(text) ? "capacity" : undefined;
}

/** Signal a backend and its tools. Backends start in their own session, so pid is also the group id. */
function killGroup(pid: number | null | undefined, signal: Sig): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {}
}

/** When a process started: with its pid, this is what tells it from a later process reusing the pid. */
function procStart(pid: number | undefined): string {
  if (!pid) return "";
  // lstart's text follows the timezone and locale, and status may run from a different shell than the one that recorded it
  const env: Record<string, string | undefined> = { ...process.env, TZ: "UTC", LC_ALL: "C" };
  return String(
    spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env }).stdout ?? "",
  ).trim();
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** True if pid is still that process: by start time, or for older states if its command contains a needle, so a reused pid is not mistaken for the lane. */
function pidAlive(pid: number | null | undefined, needles: string[], started?: string): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  if (started) {
    const current = procStart(pid);
    return current ? current === started : true;
  }
  const command =
    spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "";
  return command.trim() ? needles.some((needle) => command.includes(needle)) : true;
}

/** Kill a dead lane's backend group, including tools that outlived it, unless its pid now belongs to something else. */
function killBackendGroup(state: Partial<State>): void {
  const pid = state.pid;
  if (!pid) return;
  try {
    process.kill(pid, 0);
  } catch {
    return killGroup(pid, "SIGKILL"); // the leader is gone; tools may remain in its group
  }
  // with no start time the pid could be anyone's by now, so it is left alone
  if (state.pid_started && pidAlive(pid, [], state.pid_started)) killGroup(pid, "SIGKILL");
}

/** Fail an active lane whose driver died. States from before driver_pid existed are left alone. */
function reconcile(root: string, state: State): State {
  if (!ACTIVE.has(state.status ?? "") || !("driver_pid" in state)) return state;
  // no start time means a live pid can't be told from a stranger's, and nothing gets killed on a guess
  if (state.driver_pid && !state.driver_started && pidExists(state.driver_pid)) return state;
  if (state.stopping && ageSeconds(state.updated) < STOP_GRACE_S) return state; // `stop` is taking it down
  const driver = state.driver_pid;
  if (
    pidAlive(driver, DRIVER_NEEDLES, state.driver_started) ||
    (!driver && ageSeconds(state.updated) < DRIVER_START_GRACE_S)
  )
    return state;
  // The driver may have finished between the caller's read and this check, so read the final word.
  const latest = loadState(root, state.name);
  if (!ACTIVE.has(latest.status ?? "") || latest.driver_pid !== driver) return latest;
  killBackendGroup(latest);
  const failed = saveState(root, state.name, {
    status: "failed",
    pid: null,
    detail: `driver process died; ${NAME} continue resumes the session`,
  });
  notify(failed, "failed", `Its driver process died. ${NAME} continue resumes it.`);
  return failed;
}

// ---------------------------------------------------------------- codex backend

function xcodeRoots(): string[] {
  for (const dir of XCODE_ROOTS) fs.mkdirSync(dir, { recursive: true });
  return XCODE_ROOTS;
}

/** APFS-clone a SwiftPM checkout cache into the lane so package resolution works offline. */
function seedSpm(laneRoot: string, seed: string): void {
  const target = path.join(laneRoot, "build/DerivedData/SourcePackages");
  if (
    fs.existsSync(target) ||
    !seed ||
    !fs.statSync(seed, { throwIfNoEntry: false })?.isDirectory()
  )
    return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  spawnSync("/bin/cp", ["-cR", seed, target]);
}

function codexCmd(state: State, resume: boolean): string[] {
  const schemaPath = path.join(state.state_dir, "output.schema.json");
  fs.writeFileSync(schemaPath, schemaText(state));
  const roots = [...(state.add_dirs ?? []), ...(state.xcode ? xcodeRoots() : [])];
  const common = [
    "--json",
    "--skip-git-repo-check",
    "--output-schema",
    schemaPath,
    "-o",
    path.join(state.state_dir, "report.json"),
    "-m",
    state.model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(state.effort)}`,
    "-c",
    `sandbox_mode=${JSON.stringify(state.sandbox === "read-only" ? "read-only" : "workspace-write")}`,
    "-c",
    `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`,
  ];
  if (state.network) common.push("-c", "sandbox_workspace_write.network_access=true");
  if (state.trust_hooks) common.push("--dangerously-bypass-hook-trust");
  if (state.lean) {
    common.push("--ignore-user-config"); // skip config.toml: user plugins, MCP servers and skills list. Auth still works.
  } else {
    const script = hook();
    const command = JSON.stringify(shellQuote(script ?? ""));
    if (script)
      for (const event of ["SessionStart", "PostToolUse", "Stop", "SessionEnd"]) {
        const timeout = event === "SessionEnd" ? 1 : 5;
        common.push(
          "-c",
          `hooks.${event}=[{hooks=[{type="command",command=${command},timeout=${timeout}}]}]`,
        );
      }
  }
  const binary = resolveBin("codex");
  if (resume) return [binary, "exec", "resume", ...common, state.thread_id!, "-"]; // the text goes by stdin: it may start with a dash, and argv shows in ps
  return [binary, "exec", ...common, "-C", state.dir, "-"];
}

function handleCodexLine(
  root: string,
  name: string,
  event: Record<string, any>,
  ctx: RunContext,
): void {
  const kind = event.type ?? "";
  const item = event.item ?? {};
  if (kind === "thread.started") {
    saveState(root, name, { thread_id: event.thread_id });
  } else if (kind === "turn.completed") {
    // an error before this was transient; the turn recovered
    ctx.failure = undefined;
    ctx.errorText = undefined;
    const usage = event.usage ?? {};
    addUsage(
      root,
      name,
      usage.input_tokens ?? 0,
      usage.cached_input_tokens ?? 0,
      usage.output_tokens ?? 0,
    );
  } else if (kind === "item.completed" && item.type === "command_execution") {
    saveState(root, name, { last_activity: String(item.command ?? "").slice(0, 160) });
  } else if (kind === "item.completed" && item.type === "file_change") {
    saveState(root, name, { last_activity: "edited files" });
  } else if (kind === "turn.failed" || kind === "error") {
    const error = event.error;
    const text = String(
      (typeof error === "object" && error ? error.message : error) ?? event.message ?? "",
    );
    ctx.errorText = text;
    ctx.failure = classifyFailure(text) ?? ctx.failure;
  }
}

// --------------------------------------------------------------- claude backend

/** Lean lanes skip user settings to save tokens. The user's guards still apply: deny rules, PreToolUse hooks, sandbox. */
function claudeSettings(script: string | undefined, lean: boolean, readOnly: boolean): string {
  const out: Record<string, unknown> = {};
  const hooks: Record<string, unknown> = {};
  if (lean) {
    let user: Record<string, any> = {};
    try {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(
          path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude"), "settings.json"),
          "utf8",
        ),
      );
      if (isRecord(parsed)) user = parsed;
    } catch {}
    const deny = user.permissions?.deny;
    if (Array.isArray(deny) && deny.length) out.permissions = { deny };
    const all = user.hooks?.PreToolUse;
    // a hook that answers "allow" outranks the deny rules, so a read-only lane keeps only those limited to read tools
    const readTools = ["Read", "Glob", "Grep"];
    const onlyReads = (guard: any) =>
      typeof guard?.matcher === "string" &&
      guard.matcher.split("|").every((tool: string) => readTools.includes(tool.trim()));
    const guards = Array.isArray(all) && readOnly ? all.filter(onlyReads) : all;
    if (Array.isArray(guards) && guards.length) hooks.PreToolUse = guards;
    if (user.sandbox)
      out.sandbox = readOnly ? { ...user.sandbox, autoAllowBashIfSandboxed: false } : user.sandbox;
  }
  if (script) {
    const entry = [{ hooks: [{ type: "command", command: shellQuote(script), timeout: 5 }] }];
    hooks.PostToolUse = entry;
    hooks.Stop = entry;
    hooks.SessionEnd = entry;
  }
  if (Object.keys(hooks).length) out.hooks = hooks;
  return Object.keys(out).length ? JSON.stringify(out) : "";
}

function defaultAllowedTools(): string[] {
  return [...CLAUDE_TOOLS, ...CLAUDE_BASH.flatMap((cmd) => [`Bash(${cmd})`, `Bash(${cmd} *)`])];
}

function claudeCmd(state: State, resume: boolean, sessionId: string): string[] {
  const readOnly = state.sandbox === "read-only";
  const schema = JSON.parse(schemaText(state));
  const cmd = [
    resolveBin("claude"),
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    state.model,
    "--json-schema",
    JSON.stringify(schema),
    "--permission-mode",
    readOnly ? "default" : "acceptEdits",
  ];
  const settings = claudeSettings(hook(), Boolean(state.lean), readOnly);
  if (settings) cmd.push("--settings", settings);
  // A read-only lane ignores the repo's settings: a committed allow rule or hook could undo read-only.
  // no user MCP servers, plugins or user settings: measured 70k -> 31k input tokens
  if (state.lean)
    cmd.push("--strict-mcp-config", "--setting-sources", readOnly ? "" : "project,local");
  else if (readOnly) cmd.push("--setting-sources", "user");
  if (state.effort) cmd.push("--effort", state.effort);
  if (state.fallback_model) cmd.push("--fallback-model", state.fallback_model);
  if (!resume) cmd.push(`--name=${sessionTitle(state)}`);
  cmd.push(resume ? "--resume" : "--session-id", sessionId);
  for (const extra of state.add_dirs ?? []) cmd.push("--add-dir", extra);
  cmd.push(
    "--allowedTools",
    ...(state.allowed_tools ?? (readOnly ? CLAUDE_READ_ONLY : defaultAllowedTools())),
  );
  // Subagents do not inherit the allowlist, so a lane that delegates gets stuck; keep the work in the lane.
  cmd.push(
    "--disallowedTools",
    "Task",
    "Agent",
    ...(readOnly ? ["Edit", "Write", "NotebookEdit", ...CLAUDE_GIT_WRITES] : []),
  );
  return cmd;
}

function toolSummary(block: Record<string, any>): string {
  const data = block.input ?? {};
  const detail = data.command || data.file_path || data.path || data.pattern || "";
  return `${block.name ?? ""} ${detail}`.trim().slice(0, 160);
}

function parseJsonText(text: unknown): Record<string, unknown> | undefined {
  const raw = String(text ?? "").trim();
  if (!raw) return undefined;
  const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "");
  for (const candidate of [cleaned, raw]) {
    try {
      const value = JSON.parse(candidate);
      if (isRecord(value)) return value;
    } catch {}
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const value = JSON.parse(raw.slice(start, end + 1));
      if (isRecord(value)) return value;
    } catch {}
  }
  return undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function handleClaudeLine(
  root: string,
  name: string,
  event: Record<string, any>,
  ctx: RunContext,
): void {
  const kind = event.type ?? "";
  if (kind === "rate_limit_event") {
    const info = event.rate_limit_info ?? {};
    if (info.status === "rejected" && typeof info.resetsAt === "number")
      ctx.limitReset = info.resetsAt;
  } else if (kind === "system" && event.subtype === "init" && typeof event.model === "string") {
    ctx.model = event.model;
  } else if (kind === "assistant") {
    if (typeof event.message?.model === "string") ctx.model = event.message.model;
    if (!ctx.seen) {
      ctx.seen = true;
      saveState(root, name, { session_started: true });
    }
    for (const block of event.message?.content ?? []) {
      if (block.type !== "tool_use") continue;
      if (block.name === "StructuredOutput") ctx.toolReport = block.input;
      else saveState(root, name, { last_activity: toolSummary(block) });
    }
  } else if (kind === "result") {
    ctx.result = event;
    const usage = event.usage ?? {};
    const cached = usage.cache_read_input_tokens ?? 0;
    addUsage(
      root,
      name,
      (usage.input_tokens ?? 0) + cached + (usage.cache_creation_input_tokens ?? 0),
      cached,
      usage.output_tokens ?? 0,
    );
    const status = event.api_error_status;
    if (event.is_error || status || String(event.subtype ?? "").startsWith("error")) {
      const text = [event.subtype, event.result, event.errors].filter(Boolean).join(" ");
      ctx.errorText = text;
      const failure =
        classifyFailure(text) ??
        (status === 429 ? "limit" : status === 503 || status === 529 ? "capacity" : undefined);
      if (failure) ctx.failure = failure;
      else ctx.error = true;
    }
  }
}

function claudeWriteReport(base: string, ctx: RunContext): void {
  if (!ctx.result || ctx.failure || ctx.error) return;
  const report = [
    ctx.result.structured_output,
    parseJsonText(ctx.result.result),
    ctx.toolReport,
  ].find(isRecord);
  if (!report) return;
  writeReport(base, report);
}

// --------------------------------------------------------------- gemini backend

function geminiCmd(state: State, resume: boolean, sessionId: string): string[] {
  const readOnly = state.sandbox === "read-only";
  const cmd = [
    resolveBin("gemini"),
    "-p",
    "",
    "--output-format",
    "stream-json",
    "--model",
    state.model,
    "--approval-mode",
    readOnly ? "plan" : "yolo",
    "--skip-trust",
  ];
  if (state.lean) cmd.push("--extensions", "none", "--allowed-mcp-server-names", "none");
  cmd.push(resume ? "--resume" : "--session-id", sessionId);
  for (const extra of state.add_dirs ?? []) cmd.push("--include-directories", extra);
  return cmd;
}

function handleGeminiLine(
  root: string,
  name: string,
  event: Record<string, any>,
  ctx: RunContext,
): void {
  const kind = event.type ?? "";
  if (kind === "init") {
    if (typeof event.session_id === "string" && SAFE_ID.test(event.session_id))
      saveState(root, name, { thread_id: event.session_id });
    if (typeof event.model === "string") ctx.model = event.model;
  } else if (kind === "message" && event.role === "assistant") {
    if (!ctx.seen) {
      ctx.seen = true;
      saveState(root, name, { session_started: true });
    }
    ctx.assistantText = (ctx.assistantText ?? "") + String(event.content ?? "");
  } else if (kind === "tool_use") {
    if (!ctx.seen) {
      ctx.seen = true;
      saveState(root, name, { session_started: true });
    }
    if (ctx.assistantText) {
      ctx.preToolText = ctx.assistantText;
      ctx.assistantText = "";
    }
    const params = isRecord(event.parameters) ? event.parameters : {};
    const detail =
      params.command || params.file_path || params.path || params.dir_path || params.pattern || "";
    saveState(root, name, {
      last_activity: `${event.tool_name ?? ""} ${detail}`.trim().slice(0, 160),
    });
  } else if (kind === "error") {
    const text = String(event.message ?? "");
    const failure = classifyFailure(text);
    if (failure) {
      ctx.errorText = text;
      ctx.failure = failure;
    } else if (event.severity !== "warning") {
      ctx.errorText = text;
      ctx.error = true;
    }
  } else if (kind === "result") {
    ctx.result = event;
    const stats = isRecord(event.stats) ? event.stats : {};
    const cached = Number(stats.cached ?? 0);
    addUsage(
      root,
      name,
      Number(stats.input_tokens ?? 0),
      cached,
      Number(stats.output_tokens ?? 0),
    );
    if (isRecord(stats.models)) {
      const models = Object.keys(stats.models);
      if (models.length) ctx.model = models[models.length - 1];
    }
    const status = event.api_error_status;
    if (event.status === "error" || event.is_error || status) {
      const errObj = isRecord(event.error) ? event.error : {};
      const text = String(
        errObj.message ?? event.message ?? event.result ?? ctx.errorText ?? "gemini error",
      );
      ctx.errorText = text;
      const failure =
        classifyFailure(text) ??
        (status === 429 ? "limit" : status === 503 || status === 529 ? "capacity" : undefined);
      if (failure) ctx.failure = failure;
      else ctx.error = true;
    }
  }
}

function geminiWriteReport(base: string, ctx: RunContext): void {
  if (!ctx.result || ctx.failure || ctx.error) return;
  const report = [
    ctx.result.structured_output,
    parseJsonText(ctx.assistantText),
    parseJsonText(ctx.preToolText),
    parseJsonText(ctx.result.response),
    parseJsonText(ctx.result.result),
    ctx.toolReport,
  ].find(isRecord);
  if (!report) return;
  writeReport(base, report);
}

// ---------------------------------------------------------------- agy backend

function agyCmd(state: State, resume: boolean, sessionId: string): string[] {
  const readOnly = state.sandbox === "read-only";
  const cmd = [
    resolveBin("agy"),
    "--output-format",
    "stream-json",
    "--model",
    state.model,
    "--dangerously-skip-permissions",
  ];
  const schemaPath = path.join(state.state_dir, "output.schema.json");
  fs.writeFileSync(schemaPath, schemaText(state));
  cmd.push("--json-schema", schemaPath);
  if (readOnly) {
    cmd.push("--mode", "plan");
  } else {
    cmd.push("--mode", "auto");
    if (!state.network) cmd.push("--sandbox");
  }
  if (state.effort) cmd.push("--effort", state.effort);
  for (const extra of state.add_dirs ?? []) cmd.push("--add-dir", extra);
  if (resume) {
    cmd.push("--conversation", sessionId);
  }
  cmd.push("--print", "-");
  return cmd;
}

function handleAgyLine(
  root: string,
  name: string,
  event: Record<string, any>,
  ctx: RunContext,
): void {
  const kind = String(event.event ?? event.type ?? "");
  if (kind === "init") {
    if (typeof event.conversation_id === "string" && SAFE_ID.test(event.conversation_id))
      saveState(root, name, { thread_id: event.conversation_id });
    if (isRecord(event.init) && typeof event.init.model === "string")
      ctx.model = event.init.model;
  } else if (kind === "step_update") {
    const step = isRecord(event.step_update) ? event.step_update : {};
    if (typeof event.conversation_id === "string" && SAFE_ID.test(event.conversation_id)) {
      const state = loadState(root, name);
      if (!state.thread_id) saveState(root, name, { thread_id: event.conversation_id });
    }
    const stepType = String(step.step_type ?? "");
    if (stepType === "agent_response") {
      if (!ctx.seen) {
        ctx.seen = true;
        saveState(root, name, { session_started: true });
      }
      if (step.text_delta) {
        ctx.assistantText = (ctx.assistantText ?? "") + String(step.text_delta);
      }
    } else if (stepType && stepType !== "user_input" && stepType !== "system_message") {
      saveState(root, name, { last_activity: stepType.slice(0, 160) });
    }
  } else if (kind === "result") {
    const res = isRecord(event.result) ? event.result : event;
    ctx.result = res;
    const usage = isRecord(res.usage) ? res.usage : {};
    const input = Number(usage.input_tokens ?? 0);
    const cached = Number(usage.cache_read_tokens ?? 0);
    const output = Number(usage.output_tokens ?? 0);
    addUsage(root, name, input, cached, output);
    if (res.status === "ERROR" || res.status === "FAILED") {
      const text = String(res.error ?? "agy error");
      ctx.errorText = text;
      const failure = classifyFailure(text);
      if (failure) ctx.failure = failure;
      else ctx.error = true;
    }
  }
}

function agyWriteReport(base: string, ctx: RunContext): void {
  if (!ctx.result || ctx.failure || ctx.error) return;
  const report = [
    ctx.result.structured_output,
    parseJsonText(ctx.result.response),
    parseJsonText(ctx.assistantText),
  ].find(isRecord);
  if (!report) return;
  writeReport(base, report);
}

// ----------------------------------------------------------------------- driver

let childPid: number | undefined; // the running backend, for the signal handler

/** Record this process as the lane's driver and take the backend down with it. */
function startDriver(root: string, name: string): void {
  for (const [signal, number] of [
    ["SIGTERM", 15],
    ["SIGINT", 2],
  ] as const) {
    process.on(signal, () => {
      killGroup(childPid, "SIGTERM");
      process.exit(128 + number);
    });
  }
  saveState(root, name, { driver_pid: process.pid, driver_started: procStart(process.pid) });
}

/** Feed stdout lines to onLine until the backend ends. Resolves true if it went silent and was killed. */
function pump(
  child: ChildProcess,
  idleSeconds: number,
  onLine: (line: string) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    let buffer: Buffer = Buffer.alloc(0);
    let last = Date.now();
    let exitedAt = 0;
    let killedAt = 0;
    let hung = false;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (buffer.length) onLine(buffer.toString("utf8") + "\n");
      if (hung) killGroup(child.pid, "SIGKILL");
      child.stdout?.destroy();
      resolve(hung);
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      last = Date.now();
      buffer = Buffer.concat([buffer, chunk]);
      let newline: number;
      while ((newline = buffer.indexOf(10)) !== -1) {
        onLine(buffer.subarray(0, newline + 1).toString("utf8"));
        buffer = buffer.subarray(newline + 1);
      }
    });
    child.on("exit", () => {
      exitedAt ||= Date.now();
    });
    child.on("close", settle);
    child.on("error", settle); // the binary or the lane's directory is missing
    const timer = setInterval(() => {
      const moment = Date.now();
      if (killedAt && moment - killedAt > 5000) killGroup(child.pid, "SIGKILL"); // tools can outlive the backend
      if (exitedAt) {
        if (moment - exitedAt > (killedAt ? PIPE_GRACE_MS + 1000 : PIPE_GRACE_MS)) settle();
      } else if (!killedAt && idleSeconds && moment - last > idleSeconds * 1000) {
        hung = true;
        killedAt = moment;
        killGroup(child.pid, "SIGTERM");
      }
    }, 500);
  });
}

/** One backend invocation. */
async function runOnce(
  root: string,
  name: string,
  resume: boolean,
  message?: string,
): Promise<RunResult> {
  let state = loadState(root, name);
  const backend = backendOf(state);
  const base = state.state_dir;
  const slots = String(state.build_slots ?? 2);
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: lanePath(),
    DELEGATE_STATE_DIR: base,
    DELEGATE_NAME: name,
    DELEGATE_BUILD_SLOTS: slots,
    // each backend sets its own marker; an inherited one would misidentify the caller of a nested command
    CLAUDECODE: undefined,
    CODEX_THREAD_ID: undefined,
    CODEX_SANDBOX: undefined,
    GEMINI_CLI: undefined,
    ANTIGRAVITY_AGENT: undefined,
    ANTIGRAVITY_CONVERSATION_ID: undefined,
    DELEGATE_SESSION: undefined,
  };
  if (state.derived_data) env.DELEGATE_DERIVED_DATA = state.derived_data;
  const problem = stateProblem(root, name, state);
  if (problem) {
    fs.rmSync(path.join(laneDir(root, name), "report.json"), { force: true });
    saveState(root, name, { state_dir: laneDir(root, name), last_error: problem });
    return "error";
  }
  ensureSlots(state.build_slots ?? 2);
  // a stale report from an earlier turn must not be mistaken for this turn's report
  fs.rmSync(path.join(base, "report.json"), { force: true });
  fs.rmSync(path.join(base, "report.txt"), { force: true });
  const initialPrompt = () => fs.readFileSync(state.prompt_full || state.prompt, "utf8");
  let cmd: string[];
  let stdinText: string;
  let handler: typeof handleCodexLine;
  if (backend === "claude") {
    if (!resume)
      state = saveState(root, name, { thread_id: crypto.randomUUID(), session_started: false });
    cmd = claudeCmd(state, resume, state.thread_id!);
    // a restart from the prompt must still carry what the user just said
    stdinText = resume ? message || CONTINUE : initialPrompt() + (message ? `\n\n${message}` : "");
    handler = handleClaudeLine;
  } else if (backend === "gemini") {
    if (!resume)
      state = saveState(root, name, { thread_id: crypto.randomUUID(), session_started: false });
    cmd = geminiCmd(state, resume, state.thread_id!);
    const schemaFooter =
      "\n\nRespond ONLY with a single valid JSON object matching this JSON schema (no markdown code fences or extra text):\n" +
      schemaText(state);
    stdinText =
      (resume ? message || CONTINUE : initialPrompt() + (message ? `\n\n${message}` : "")) +
      schemaFooter;
    handler = handleGeminiLine;
  } else if (backend === "agy") {
    if (!resume)
      state = saveState(root, name, { thread_id: crypto.randomUUID(), session_started: false });
    cmd = agyCmd(state, resume, state.thread_id!);
    stdinText = resume ? message || CONTINUE : initialPrompt() + (message ? `\n\n${message}` : "");
    handler = handleAgyLine;
  } else {
    cmd = codexCmd(state, resume);
    stdinText = resume ? message || CONTINUE : initialPrompt();
    handler = handleCodexLine;
  }
  const ctx: RunContext = {};
  const events = fs.openSync(path.join(base, "events.jsonl"), "a");
  const stderr = fs.openSync(path.join(base, "stderr.log"), "a");
  const onLine = (line: string) => {
    fs.writeSync(events, line);
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (isRecord(event)) handler(root, name, event, ctx);
  };
  const child = spawn(cmd[0]!, cmd.slice(1), {
    cwd: state.dir,
    env,
    detached: true,
    stdio: ["pipe", "pipe", stderr],
  });
  let spawnError = "";
  child.on("error", (error) => {
    spawnError = error.message;
  });
  childPid = child.pid;
  saveState(root, name, {
    pid: child.pid ?? null,
    pid_started: procStart(child.pid),
    status: "running",
  });
  child.stdin!.on("error", () => {}); // the backend may exit without reading its prompt
  child.stdin!.end(stdinText);
  const hung = await pump(child, state.idle_timeout ?? DEFAULT_IDLE_TIMEOUT, onLine);
  const code = spawnError ? 1 : child.exitCode;
  childPid = undefined;
  fs.closeSync(events);
  fs.closeSync(stderr);
  saveState(root, name, {
    pid: null,
    resolved_model: ctx.model ?? "",
    last_error: (spawnError || ctx.errorText || "").slice(0, 300),
    limit_reset: ctx.limitReset ?? null,
  });
  if (hung) return "hung";
  if (backend === "claude") claudeWriteReport(base, ctx);
  else if (backend === "gemini") geminiWriteReport(base, ctx);
  else if (backend === "agy") agyWriteReport(base, ctx);
  if (ctx.failure) return ctx.failure;
  if (ctx.error) return "error";
  return code === 0 ? "ok" : "error";
}

function finish(root: string, name: string, backendFailed = false): void {
  const state = loadState(root, name);
  let report: Record<string, any>;
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(state.state_dir, "report.json"), "utf8"),
    );
    if (!isRecord(parsed)) throw new Error("not an object");
    report = parsed;
  } catch {
    saveState(root, name, { status: "failed", detail: "no structured report" });
    notify(state, "failed", "It finished without a report. See stderr.log in its lane folder.");
    return;
  }
  // a lane must end in a state `wait` recognises, whatever its report schema says
  const reported =
    typeof report.status === "string" && TERMINAL.has(report.status) ? report.status : "partial";
  // a backend that exited with an error can't vouch for a clean finish, whatever it wrote first
  const status = backendFailed && reported === "done" ? "partial" : reported;
  // a report can skip schema enforcement, so a wrong type here must not take the driver down
  const summary = typeof report.summary === "string" ? report.summary : "";
  const questions: string[] = Array.isArray(report.questions)
    ? report.questions.filter((question: unknown) => typeof question === "string")
    : [];
  const finished = saveState(root, name, {
    status,
    detail: summary.slice(0, 300),
    questions,
    warning: backendFailed
      ? `${backendOf(state)} exited with an error after writing this report`
      : "",
  });
  const headline = REPORT_HEADLINE[status] ?? `is ${status}`;
  if (status === "needs_input" && questions.length) {
    const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : "";
    notify(finished, headline, `${questions[0]}${more}`);
  } else {
    notify(finished, headline, summary || "Its report has no summary.");
  }
}

/** Run, resuming on capacity with backoff, until the lane stops for a real reason. */
async function drive(
  root: string,
  name: string,
  firstResume: boolean,
  original?: string,
): Promise<void> {
  let resume = firstResume;
  let message = original;
  let attempt = 0;
  let result: RunResult;
  while (true) {
    result = await runOnce(root, name, resume, message);
    const state = loadState(root, name);
    if (result === "limit") {
      const reset = state.limit_reset;
      const when = reset ? ` Resets ${new Date(reset * 1000).toISOString()}.` : "";
      const reason = state.last_error || "usage limit";
      saveState(root, name, {
        status: "limited",
        retry_at: reset ?? null,
        detail: `${backendOf(state)} ${state.model}: ${reason}.${when} ${NAME} continue resumes it.`,
      });
      const resets = reset ? ` Resets ${localTime(reset)}.` : "";
      notify(state, "hit a usage limit", `${reason}.${resets} ${NAME} continue resumes it.`);
      return;
    }
    if (result === "hung") {
      const minutes = (state.idle_timeout ?? DEFAULT_IDLE_TIMEOUT) / 60;
      saveState(root, name, {
        status: "failed",
        detail: `no output for ${minutes} min, backend killed; ${NAME} continue resumes the session`,
      });
      notify(
        state,
        "failed",
        `No output for ${minutes} min, so it was stopped. ${NAME} continue resumes it.`,
      );
      return;
    }
    if (result !== "capacity") break;
    const canResume =
      backendOf(state) === "codex" ? Boolean(state.thread_id) : Boolean(state.session_started);
    if (attempt >= BACKOFF.length || (backendOf(state) === "codex" && !canResume)) {
      saveState(root, name, { status: "failed", detail: "model at capacity, retries exhausted" });
      notify(state, "failed", "The model stayed at capacity after every retry. Try again later.");
      return;
    }
    const wait = BACKOFF[attempt]!;
    attempt += 1;
    saveState(root, name, {
      status: "retrying",
      attempts: attempt,
      retry_at: Date.now() / 1000 + wait,
    });
    await sleep(wait);
    // claude: if the failed turn never reached the model, start fresh with a new session id
    resume = canResume;
    // the message may not have reached the model before the failure, so send it again
    message = !canResume
      ? original
      : original
        ? `${CONTINUE}\n\nThe last message to you, in case it did not arrive:\n${original}`
        : undefined;
  }
  const state = loadState(root, name);
  if (result === "error" && !fs.existsSync(path.join(state.state_dir, "report.json"))) {
    const reason = state.last_error || "see stderr.log";
    saveState(root, name, {
      status: "failed",
      detail: `${backendOf(state)} exited with an error: ${reason}`,
    });
    notify(state, "failed", `${label(state)} exited with an error: ${reason}.`);
    return;
  }
  finish(root, name, result === "error");
}

// --------------------------------------------------------------------- commands

const BOOLEAN_FLAGS = [
  "network",
  "xcode",
  "trust-hooks",
  "lean",
  "no-lean",
  "adversarial",
  "write",
  "background",
  "json",
  "report",
  "terminal",
  "archived",
  "all",
  "dry-run",
  "yes",
  "forget",
];

function flags(argv: string[], defaults: Record<string, string> = {}, allowed?: string[]) {
  const found = new Map<string, string[]>();
  const positionals: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    i += 1;
    if (arg === "--") {
      while (i < argv.length) {
        positionals.push(argv[i]!);
        i += 1;
      }
    } else if (!arg.startsWith("--")) {
      positionals.push(arg);
    } else {
      const eq = arg.indexOf("=");
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (allowed && !allowed.includes(key))
        die(`unknown flag: --${key}. Text starting with -- goes after a bare --`);
      if (eq !== -1 && BOOLEAN_FLAGS.includes(key)) die(`--${key} takes no value`);
      let value = "true";
      if (eq !== -1) value = arg.slice(eq + 1);
      else if (!BOOLEAN_FLAGS.includes(key)) {
        value = argv[i] ?? "";
        i += 1;
      }
      const list = found.get(key) ?? [];
      list.push(value);
      found.set(key, list);
    }
  }
  const v = (key: string): string | undefined => {
    const list = found.get(key);
    if (list !== undefined && list.length > 0) return list[list.length - 1];
    return Object.keys(defaults).includes(key) ? defaults[key] : undefined;
  };
  const all = (key: string): string[] => found.get(key) ?? [];
  return { v, all, positionals };
}

const defaultBackend = (): Backend => "codex";

/** Argv to run this tool again: a compiled binary is its own entry point. */
function selfCommand(): string[] {
  return [process.execPath];
}

function spawnDetached(argv: string[], log: string): number | undefined {
  const fd = fs.openSync(log, "a");
  const env: Record<string, string | undefined> = {
    ...process.env,
  };
  const child = spawn(argv[0]!, argv.slice(1), { env, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  fs.closeSync(fd);
  return child.pid;
}

const RUN_FLAGS = [
  "root",
  "delay",
  "build-slots",
  "idle-timeout",
  "sandbox",
  "dir",
  "prompt",
  "origin",
  "run-id",
  "schema",
  "backend",
  "model",
  "effort",
  "add-dir",
  "derived-data",
  "shared-context",
  "lean",
  "no-lean",
  "network",
  "xcode",
  "spm-seed",
  "trust-hooks",
  "allowed-tools",
  "fallback-model",
];

const LOCK_STALE_MS = 30_000;

/**
 * One start or resume of a lane at a time. `work` returns why it refused, so the lock is always released first.
 * A lock left by a crash is renamed before removal, which makes two callers clearing it at once very unlikely.
 */
async function laneLock(
  base: string, busy: string, work: (retire: () => string) => Promise<string | undefined>, waitMs = 0,
  soft = false,
): Promise<boolean> {
  if (!laneDirectory(base)) return die(`${path.basename(base)}: lane folder is not a real directory`);
  let lock = path.join(base, "start.lock");
  const take = () => {
    try {
      fs.mkdirSync(lock);
      return true;
    } catch (error: unknown) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST")
        return false;
      return die(`${path.basename(base)}: can't lock this lane: ${String(error)}`);
    }
  };
  let held = take();
  if (!held) {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
        const moved = `${lock}.${process.pid}`;
        fs.renameSync(lock, moved);
        fs.rmSync(moved, { recursive: true, force: true });
        held = take();
      }
    } catch {}
  }
  const deadline = Date.now() + waitMs;
  while (!held && Date.now() < deadline) {
    await sleep(0.025);
    held = take();
  }
  if (!held) {
    if (soft) return false; // the caller skips this lane and goes on
    return die(busy);
  }
  let refusal: string | undefined;
  try {
    refusal = await work(() => {
      // Move the lock with the lane so a new lane can take this name immediately.
      const retired = path.join(path.dirname(base), `.cleared-${crypto.randomUUID()}`);
      fs.renameSync(base, retired);
      lock = path.join(retired, "start.lock");
      return retired;
    });
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
  if (refusal) die(refusal);
  return true;
}

/** Why a lane name can't be started again: one session must never run twice. */
function laneBusy(root: string, name: string): string | undefined {
  const state = reconcile(root, loadState(root, name));
  if (state.archived) return `${name}: archived; restore it or pick another name`;
  return ACTIVE.has(state.status ?? "")
    ? `${name}: still ${state.status}; stop it or pick another name`
    : undefined;
}

async function cmdRun(argv: string[], claimed = false): Promise<void> {
  const { v, all, positionals } = flags(
    argv,
    {
      root: DEFAULT_ROOT,
      delay: "0",
      "build-slots": "2",
      "idle-timeout": String(DEFAULT_IDLE_TIMEOUT),
      sandbox: "workspace-write",
    },
    RUN_FLAGS,
  );
  const name = positionals[0];
  if (!name || !v("dir") || !v("prompt")) return die("usage: delegate run NAME --dir D --prompt FILE");
  checkNewName(abs(v("root")!), name);
  const schemaArg = v("schema") && v("schema") !== "review" ? abs(v("schema")!) : v("schema");
  if (schemaArg && schemaArg !== "review" && !fs.existsSync(schemaArg))
    return die(`--schema: no such file: ${schemaArg}`);
  if (v("backend") && v("backend") !== "codex" && v("backend") !== "claude" && v("backend") !== "gemini" && v("backend") !== "agy")
    return die("--backend: codex, claude, gemini or agy");
  if (v("sandbox") !== "read-only" && v("sandbox") !== "workspace-write")
    return die("--sandbox: read-only or workspace-write");
  const root = abs(v("root")!);
  const base = laneDir(root, name);
  const prompt = abs(v("prompt")!);
  if (!fs.existsSync(prompt)) return die(`--prompt takes a file, and there is none at ${prompt}`);
  const derived = v("derived-data") ? abs(v("derived-data")!) : "";
  const backend = (v("backend") as Backend | undefined) ?? defaultBackend();
  const shared = v("shared-context") ? abs(v("shared-context")!) : "";
  const dir = abs(v("dir")!);
  if (backend === "claude" && v("no-lean") && v("sandbox") === "read-only")
    return die("--no-lean can't be read-only on Claude: your user settings could allow anything");
  const addDirs = [...all("add-dir").map(abs), ...(derived ? [derived] : [])];
  const problem = rootProblem(root, backend, dir, addDirs, Boolean(v("xcode")));
  if (problem) return die(problem);
  fs.mkdirSync(base, { recursive: true, mode: PRIVATE_DIR });
  if (!laneDirectory(base)) return die(`${name}: lane folder is not a real directory`);
  fs.chmodSync(base, PRIVATE_DIR);
  await laneLock(base, `${name}: another start or resume is in progress`, async () => {
    // a claimed lane is queued with no driver; anything else means `_run` was typed over a live lane
    const current = loadState(root, name);
    const ours = claimed && current.status === "queued" && !current.driver_pid;
    const busy = ours ? undefined : laneBusy(root, name);
    if (busy) return busy;
    if (claimed && (!ours || runIDProblem(current, v("run-id")))) return `${name}: queued launch was cancelled`;
    fs.rmSync(path.join(base, "report.json"), { force: true });
    saveState(root, name, {
      // a fresh run owes nothing to a lane that used this name before, its session above all
      thread_id: "",
      run_id: ours && current.run_id ? current.run_id : crypto.randomUUID(),
      base_commit: ours ? current.base_commit ?? "" : "",
      resolved_model: "",
      session_started: false,
      pid: null,
      pid_started: "",
      questions: [],
      detail: "",
      warning: "",
      usage: {},
      stopping: false,
      last_activity: "",
      last_error: "",
      limit_reset: null,
      retry_at: null,
      name,
      title: ours ? current.title ?? "" : "",
      backend,
      dir,
      orchestrator: orchestratorSession() ?? "",
      origin: v("origin") ? abs(v("origin")!) : dir,
      prompt,
      prompt_full: buildPrompt(base, prompt, shared, v("sandbox") === "read-only"),
      lean: !v("no-lean"),
      shared_context: shared,
      state_dir: base,
      model: v("model") ?? DEFAULT_MODEL[backend],
      effort: v("effort") ?? (backend === "codex" ? "medium" : ""),
      add_dirs: addDirs,
      network: Boolean(v("network")),
      xcode: Boolean(v("xcode")),
      trust_hooks: Boolean(v("trust-hooks")),
      derived_data: derived,
      build_slots: Number(v("build-slots")),
      schema: !schemaArg || schemaArg === "review" ? (schemaArg ?? null) : path.resolve(schemaArg),
      sandbox: v("sandbox") as Sandbox,
      status: "queued",
      started: now(),
      started_ms: Date.now(),
      driver_pid: null, // `stop` waits for the real one, and "absent" means a lane from an older runner
      driver_started: "",
      attempts: 0,
      idle_timeout: Number(v("idle-timeout")),
      ...(backend === "claude"
        ? {
            allowed_tools: v("allowed-tools")?.split(",") ?? null,
            fallback_model: v("fallback-model") ?? "",
          }
        : {}),
    });
    startDriver(root, name);
    return undefined;
  });
  if (v("xcode")) seedSpm(dir, v("spm-seed") ? abs(v("spm-seed")!) : "");
  await sleep(Number(v("delay")));
  await drive(root, name, false);
  // a script running a foreground lane must see a failed or limited worker
  const last = loadState(root, name);
  if (!claimed && (last.warning || !["done", "partial"].includes(last.status ?? ""))) process.exit(1);
}

const STRING_FIELDS = [
  "name",
  "dir",
  "prompt",
  "root",
  "backend",
  "model",
  "effort",
  "schema",
  "sandbox",
  "shared_context",
  "derived_data",
  "spm_seed",
  "fallback_model",
];
const LIST_FIELDS = ["add_dirs", "allowed_tools"];
const BOOL_FIELDS = ["lean", "network", "xcode", "trust_hooks"];
const NO_FLAGS = ["model", "effort", "fallback_model"];
const SHARED_FIELDS = [
  "backend",
  "model",
  "effort",
  "schema",
  "sandbox",
  "shared_context",
  "lean",
  "network",
  "xcode",
  "spm_seed",
  "trust_hooks",
  "idle_timeout",
  "allowed_tools",
  "fallback_model",
];
const MANIFEST_FIELDS = [...SHARED_FIELDS, "root", "stagger_seconds", "lanes"];
const LANE_FIELDS = [...SHARED_FIELDS, "name", "dir", "prompt", "add_dirs", "derived_data"];

/** The wrong JSON type does damage here: a string add_dirs would be read one character at a time, "/" included. */
function checkFields(level: Record<string, any>, known: string[]): void {
  // a misspelled "sandbox" must not quietly give a lane that can write
  for (const key of Object.keys(level))
    if (!known.includes(key)) die(`manifest: unknown field: ${key}`);
  const where = String(level.name ?? "manifest");
  for (const key of STRING_FIELDS) {
    if (level[key] !== undefined && typeof level[key] !== "string")
      die(`${where}: ${key} must be a string`);
  }
  for (const key of LIST_FIELDS) {
    const value = level[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item: unknown) => typeof item !== "string"))
      die(`${where}: ${key} must be a list of strings`);
  }
  for (const key of NO_FLAGS)
    if (String(level[key] ?? "").startsWith("-")) die(`${where}: ${key} looks like a flag`);
  for (const key of BOOL_FIELDS)
    if (level[key] !== undefined && typeof level[key] !== "boolean") die(`${where}: ${key} must be a boolean`);
  for (const key of ["idle_timeout", "stagger_seconds"]) {
    const value = level[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
      die(`${where}: ${key} must be a finite nonnegative number`);
  }
}

function cmdBatch(argv: string[]): void {
  const { v, positionals } = flags(argv, {}, ["dry-run"]);
  const manifestPath = positionals[0];
  if (!manifestPath || positionals.length !== 1) return die("usage: delegate batch MANIFEST.json [--dry-run]");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const root = abs(String(manifest.root ?? DEFAULT_ROOT));
  const stagger: number = manifest.stagger_seconds ?? 30;
  const topBackend: Backend = manifest.backend || defaultBackend();
  // a driver that dies early leaves no state for `status` to show, so check everything before starting any
  if (!Array.isArray(manifest.lanes)) return die("manifest: lanes must be a list");
  checkFields(manifest, MANIFEST_FIELDS);
  for (const lane of manifest.lanes as Record<string, any>[]) checkFields(lane, LANE_FIELDS);
  const seen = new Set<string>();
  for (const lane of manifest.lanes as Record<string, any>[]) {
    const label = String(lane.name);
    checkNewName(root, label);
    const base = laneDir(root, lane.name);
    if (fs.existsSync(base) && !laneDirectory(base)) die(`${label}: lane folder is not a real directory`);
    if (seen.has(label)) die(`${label}: duplicate lane name`);
    seen.add(label);
    const backend = lane.backend || topBackend;
    if (backend !== "codex" && backend !== "claude" && backend !== "gemini" && backend !== "agy")
      die(`${label}: backend must be codex, claude, gemini or agy`);
    const sandbox = lane.sandbox || manifest.sandbox;
    if (sandbox && sandbox !== "read-only" && sandbox !== "workspace-write")
      die(`${label}: sandbox must be read-only or workspace-write`);
    if (backend === "claude" && sandbox === "read-only" && !(lane.lean ?? manifest.lean ?? true))
      die(`${label}: "lean": false can't be read-only on Claude`);
    if (!lane.dir || !lane.prompt) die(`${label}: needs dir and prompt`);
    const busy = laneBusy(root, label);
    if (busy) die(busy);
    const wanted = lane.schema || manifest.schema;
    const schema = wanted === "review" ? "" : wanted;
    const needs = (file: string | undefined, isDir: boolean) => {
      if (!file) return;
      if (!fs.existsSync(abs(file))) die(`${label}: no such file: ${file}`);
      const stat = fs.statSync(abs(file));
      if (isDir ? !stat.isDirectory() : !stat.isFile()) die(`${label}: ${file} must be a ${isDir ? "directory" : "regular file"}`);
      if (!isDir) try { fs.accessSync(abs(file), fs.constants.R_OK); } catch { die(`${label}: ${file} is not readable`); }
    };
    needs(lane.dir, true);
    needs(lane.prompt, false);
    needs(lane.shared_context || manifest.shared_context, false);
    needs(schema, false);
    const addDirs: string[] = [
      ...(lane.add_dirs ?? []).map(abs),
      ...(lane.derived_data ? [abs(lane.derived_data)] : []),
    ];
    const problem = rootProblem(
      root,
      backend,
      abs(lane.dir),
      addDirs,
      Boolean(lane.xcode ?? manifest.xcode),
    );
    if (problem) die(`${label}: ${problem}`);
  }
  const origin = hereFolder();
  manifest.lanes.forEach((lane: Record<string, any>, index: number) => {
    const backend: Backend = lane.backend || topBackend;
    // top-level model, effort and tool settings only apply to lanes on the manifest's own backend
    const inherit = (key: string) =>
      lane[key] || (backend === topBackend ? manifest[key] : undefined);
    const delay = index * stagger;
    if (v("dry-run")) {
      console.log(`${lane.name}: ${backend}/${inherit("model") || DEFAULT_MODEL[backend]} ` +
        `${lane.sandbox || manifest.sandbox || "workspace-write"} ${abs(lane.dir)} ` +
        `(delay ${delay}s, network ${Boolean(lane.network ?? manifest.network)}, trust hooks ${Boolean(lane.trust_hooks ?? manifest.trust_hooks)})`);
      return;
    }
    const cmd = [
      ...selfCommand(),
      "run",
      lane.name,
      "--dir",
      lane.dir,
      "--origin",
      origin,
      "--prompt",
      lane.prompt,
      "--root",
      root,
      "--delay",
      String(delay),
      "--backend",
      backend,
      "--model",
      inherit("model") || DEFAULT_MODEL[backend],
    ];
    if (inherit("effort")) cmd.push("--effort", inherit("effort"));
    for (const extra of lane.add_dirs ?? []) cmd.push("--add-dir", extra);
    if (lane.derived_data) cmd.push("--derived-data", lane.derived_data);
    if (lane.network ?? manifest.network) cmd.push("--network");
    if (lane.xcode ?? manifest.xcode) {
      cmd.push("--xcode");
      const seed = lane.spm_seed || manifest.spm_seed;
      if (seed) cmd.push("--spm-seed", seed);
    }
    // what a lane may do is not a tool setting: it applies whatever the lane's backend
    for (const key of ["schema", "sandbox"]) {
      const value = lane[key] || manifest[key];
      if (value) cmd.push(`--${key}`, value);
    }
    if (inherit("allowed_tools")) cmd.push("--allowed-tools", inherit("allowed_tools").join(","));
    if (inherit("fallback_model")) cmd.push("--fallback-model", inherit("fallback_model"));
    if (lane.trust_hooks ?? manifest.trust_hooks) cmd.push("--trust-hooks");
    const idle = lane.idle_timeout ?? manifest.idle_timeout;
    if (idle !== undefined) cmd.push("--idle-timeout", String(idle));
    const shared = lane.shared_context || manifest.shared_context;
    if (shared) cmd.push("--shared-context", shared);
    if (!(lane.lean ?? manifest.lean ?? true)) cmd.push("--no-lean");
    const base = laneDir(root, lane.name);
    fs.mkdirSync(base, { recursive: true, mode: PRIVATE_DIR });
    if (!laneDirectory(base)) die(`${lane.name}: lane folder is not a real directory`);
    const pid = spawnDetached(cmd, path.join(base, "driver.log"));
    console.log(`${lane.name}: ${backend} driver pid ${pid}, starts in ${delay}s`);
  });
}

function laneRecords(root: string): State[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => !name.startsWith("-"))
    .sort()
    .flatMap((name) => {
      let state: State;
      try {
        state = loadState(root, name, true);
      } catch (error) {
        // one broken record must not take down status, archive or prune for every other lane
        console.error(`${name}: skipped, ${String(error)}`);
        return [];
      }
      return state.name === name ? [state] : [];
    });
}

/** Lane text is untrusted: no control characters, so it cannot fake rows or move the terminal. */
const clean = (text: string) =>
  text.replace(
    /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    " ",
  );

const usageStr = (usage: Usage = {}) =>
  `tok=${fmtTokens(usage.input ?? 0)}/${fmtTokens(usage.cached ?? 0)}/${fmtTokens(usage.output ?? 0)}`;

function statusRow(root: string, state: State) {
  const status = state.status ?? "unknown";
  const needsAnswer = !state.archived && status === "needs_input" && Boolean(state.thread_id && SAFE_ID.test(state.thread_id));
  const command = needsAnswer ? "answer" : !state.archived && ACTIVE.has(status) ? "wait" : "result";
  const argv = [NAME, command, state.name, "--root", root];
  if (state.run_id) argv.push("--run-id", state.run_id);
  return {
    name: state.name, title: sessionTitle(state), run_id: state.run_id ?? null,
    backend: backendOf(state), model: state.resolved_model || state.model,
    status, archived: Boolean(state.archived), orchestrator: state.orchestrator || null,
    project: state.origin ?? state.dir, dir: state.dir,
    detail: clean((status === "running" ? state.last_activity : state.detail) ?? ""),
    warning: clean(state.warning ?? ""), questions: textList(state.questions),
    retry_at: state.retry_at ?? null, limit_reset: state.limit_reset ?? null,
    usage: state.usage ?? {}, next: { argv, requires_text: needsAnswer },
  };
}

interface StatusScope {
  session?: string;
  archived?: boolean;
  project?: string;
  only?: string;
  expected?: string;
  json?: boolean;
}

function printStatus(root: string, scope: StatusScope): void {
  const total = { input: 0, cached: 0, output: 0 };
  const rows: ReturnType<typeof statusRow>[] = [];
  for (const record of laneRecords(root)) {
    if ((scope.only && record.name !== scope.only) || (scope.expected && record.run_id !== scope.expected) ||
        Boolean(record.archived) !== Boolean(scope.archived) || (scope.session && record.orchestrator !== scope.session) ||
        (scope.project && projectOf(record.origin ?? record.dir) !== scope.project)) continue;
    const state = reconcile(root, record);
    const extra = state.status === "running" ? (state.last_activity ?? "") : (state.detail ?? "");
    const usage = state.usage ?? {};
    total.input += usage.input ?? 0;
    total.cached += usage.cached ?? 0;
    total.output += usage.output ?? 0;
    if (scope.json) {
      rows.push(statusRow(root, state));
      continue;
    }
    console.log(
      `${state.name.padEnd(16)} ${backendOf(state).padEnd(7)} ${(state.status ?? "?").padEnd(12)} ` +
        `tries=${state.attempts ?? 0} ${usageStr(usage)} ${clean(extra).slice(0, 90)}`,
    );
    for (const question of state.questions ?? [])
      console.log(`${"".padEnd(16)} ? ${clean(question)}`);
    if (state.status === "needs_input" && state.thread_id && SAFE_ID.test(state.thread_id))
      console.log(`                 Answer with: ${NAME} answer ${clean(laneReference(root, state))} '<your answer>'`);
  }
  if (scope.json) return console.log(JSON.stringify({ version: 1, root, lanes: rows, usage: total }));
  if (total.input || total.cached || total.output) {
    console.log(
      `${"total".padEnd(16)} ${"".padEnd(7)} ${"".padEnd(12)} ${"".padEnd(7)} ${usageStr(total)}  (input/cached/output)`,
    );
  }
}

/** Text with a space is never a flag, so review findings like "- fix the bug" need no `--`. */
const isText = (arg: string) => /^-[\s\S]*\s/.test(arg) && !/^--[a-z-]+=/.test(arg);

function withTextLast(argv: string[]): string[] {
  const end = argv.indexOf("--");
  const flags = end === -1 ? argv : argv.slice(0, end);
  const texts = flags.filter(isText);
  return [
    ...flags.filter((arg) => !isText(arg)),
    "--",
    ...texts,
    ...(end === -1 ? [] : argv.slice(end + 1)),
  ];
}

const rootOption = (argv: string[], defaults: Record<string, string> = {}, allowed?: string[]) =>
  flags(withTextLast(argv), { root: DEFAULT_ROOT, ...defaults }, allowed);

async function cmdWait(argv: string[]): Promise<void> {
  const { v, positionals } = rootOption(argv, { poll: "20" }, ["root", "poll", "session", "all", "run-id"]);
  const root = abs(v("root")!);
  const only = positionals[0] ?? "";
  const expected = v("run-id") ?? "";
  if (positionals.length > 1 || (expected && !only)) return die("usage: delegate wait [NAME] [--run-id ID]");
  const session = v("all") || only ? "" : v("session") ?? orchestratorSession() ?? "";
  const project = !only && !v("all") && !v("session") && root === DEFAULT_ROOT ? hereFolder() : "";
  while (true) {
    const states = laneRecords(root).filter((state) => !state.archived &&
      (!only || state.name === only) && (!expected || state.run_id === expected) &&
      (!session || state.orchestrator === session) && (!project || projectOf(state.origin ?? state.dir) === project))
      .map((state) => reconcile(root, state));
    if (!states.length) return die(`no lanes under ${root}`);
    // an older runner's lane can't be checked, so it must not hold `wait` forever
    const unknown = states.filter(
      (state) =>
        ACTIVE.has(state.status ?? "") &&
        (!("driver_pid" in state) || (state.driver_pid && !state.driver_started)),
    );
    const done = (state: State) => TERMINAL.has(state.status ?? "") || unknown.includes(state);
    if (states.every(done)) {
      for (const state of unknown)
        console.error(`${state.name}: started by an older runner, so its state can't be checked`);
      return printStatus(root, { session, project, only, expected });
    }
    await sleep(Number(v("poll")));
  }
}

/** Why this lane can't resume: it needs a session and must be idle, because one session must never run twice. */
function runIDProblem(state: State, expected?: string): string | undefined {
  return expected !== undefined && expected !== state.run_id ? `${state.name}: run ID no longer matches` : undefined;
}

function laneReference(root: string, state: State): string {
  return `${shellQuote(state.name)} --root ${shellQuote(root)}${state.run_id ? ` --run-id ${shellQuote(state.run_id)}` : ""}`;
}

function resumeRefusal(root: string, name: string, expected?: string): string | undefined {
  const state = reconcile(root, loadState(root, name));
  if (!state.name) return `${name}: no such lane under ${root}`;
  const mismatch = runIDProblem(state, expected);
  if (mismatch) return mismatch;
  if (state.archived) return `${name}: archived; restore it before continuing`;
  if (!state.thread_id) return `${name}: no ${label(state)} session to resume`;
  const problem = stateProblem(root, name, state);
  if (problem) return `${name}: ${problem}`;
  if (ACTIVE.has(state.status ?? ""))
    return `${name}: still ${state.status}; wait for it to finish`;
  return undefined;
}

function spawnResume(root: string, name: string, message: string): void {
  const state = saveState(root, name, {
    status: "running",
    questions: [],
    warning: "",
    driver_pid: null,
    driver_started: "",
    pid: null,
    pid_started: "",
    stopping: false,
  });
  fs.writeFileSync(path.join(laneDir(root, name), "resume.txt"), message);
  spawnDetached(
    [...selfCommand(), "_resume", name, "--root", root, ...(state.run_id ? ["--run-id", state.run_id] : [])],
    path.join(laneDir(root, name), "driver.log"),
  );
}

/** NAME and TEXT, or just TEXT. A lone word that names a lane is a forgotten TEXT, never a message to another lane. */
function nameAndText(
  root: string,
  positionals: string[],
  command: string,
  defaultName: () => string,
): [string, string] {
  const usage = `usage: ${NAME} ${command} [NAME] TEXT`;
  const first = positionals[0];
  if (!first) return die(usage);
  if (positionals.length > 1) return [first, positionals.slice(1).join(" ")];
  if (!first.includes("/") && fs.existsSync(path.join(root, first, "state.json")))
    return die(`${first} is a lane, so say what to send it. ${usage}`);
  return [defaultName(), first];
}

/** Without a NAME, an answer goes to the one lane from this folder that asked: never guess between them. */
function askingLane(root: string): string {
  const asking = lanesHere(root).filter((state) => state.status === "needs_input");
  if (asking.length === 1) return asking[0]!.name;
  if (!asking.length) return die("no lane from this folder is waiting for an answer; pass a NAME");
  return die(
    `more than one lane is waiting; pass a NAME: ${asking.map((state) => state.name).join(", ")}`,
  );
}

/** One resume at a time: two at once would lose a message and leave state pointing at a dead driver. */
async function resumeLane(root: string, name: string, expected: string, work: () => string | undefined): Promise<void> {
  const base = laneDir(root, name);
  if (!fs.existsSync(base)) die(`${name}: no such lane under ${root}`);
  await laneLock(
    base,
    `${name}: another start or resume is in progress`,
    async () => resumeRefusal(root, name, expected || undefined) ?? work(),
  );
}

async function cmdAnswer(argv: string[]): Promise<void> {
  const { v, positionals } = rootOption(argv, {}, ["root", "run-id"]);
  const root = abs(v("root")!);
  const [name, text] = nameAndText(root, positionals, "answer", () => askingLane(root));
  await resumeLane(root, name, v("run-id") ?? "", () => {
    spawnResume(
      root,
      name,
      `Answer from the user: ${text}\nContinue the task with this answer and finish the report.`,
    );
    return undefined;
  });
  console.log(`${name}: resumed with your answer`);
}

async function cmdContinue(argv: string[]): Promise<void> {
  const { v, positionals } = rootOption(argv, {}, ["root", "sandbox", "run-id"]);
  const root = abs(v("root")!);
  const [name, text] = nameAndText(root, positionals, "continue", () => latestLane(root, true));
  await resumeLane(root, name, v("run-id") ?? "", () => {
    const sandbox = v("sandbox");
    if (sandbox) {
      if (sandbox !== "read-only" && sandbox !== "workspace-write")
        return "--sandbox: read-only or workspace-write";
      const state = loadState(root, name);
      // its prompt says read-only and its folder may be the user's checkout, so a new lane is the honest way to write
      if (sandbox === "workspace-write" && state.sandbox === "read-only")
        return `${name}: a read-only lane can't start writing; use ${NAME} task --write`;
      if (sandbox === "read-only" && backendOf(state) === "claude" && state.lean === false)
        return `${name}: a non-lean Claude lane can't be read-only: your user settings could allow anything`;
      saveState(root, name, { sandbox: sandbox as Sandbox });
    }
    spawnResume(root, name, `${text}\nWhen done, finish with the structured report.`);
    return undefined;
  });
  console.log(`${name}: continuing the same session`);
}

async function cmdStop(argv: string[]): Promise<void> {
  const { v, positionals } = rootOption(argv, {}, ["root", "forget", "run-id"]);
  const root = abs(v("root")!);
  const name = positionals[0] ?? stopTarget(root);
  if (!loadState(root, name).name) return die(`${name}: no such lane under ${root}`);
  await laneLock(laneDir(root, name), `${name}: another lane operation is in progress`,
    async () => stopLane(root, name, v("run-id") ?? "", Boolean(v("forget"))), 1000);
}

async function stopLane(root: string, name: string, expected: string, forget: boolean): Promise<string | undefined> {
  let state = reconcile(root, loadState(root, name));
  if (!state.name) return `${name}: no such lane under ${root}`;
  const mismatch = runIDProblem(state, expected || undefined);
  if (mismatch) return mismatch;
  if (!ACTIVE.has(state.status ?? "")) {
    console.log(`${name}: already ${state.status}`);
    return undefined;
  }
  if (forget) {
    if (state.driver_started && pidAlive(state.driver_pid, DRIVER_NEEDLES, state.driver_started))
      return `${name}: its driver is running; use ${NAME} stop`;
    saveState(root, name, {
      status: "stopped",
      stopping: false,
      detail: "forgotten; nothing was signalled",
    });
    console.log(
      `${name}: marked stopped. Nothing was signalled, so stop its processes yourself if they remain`,
    );
    return undefined;
  }
  if (!("driver_pid" in state)) {
    return `${name}: started by an older runner without stop support; kill backend pid ${state.pid} yourself, then use stop --forget`;
  }
  if (state.status === "queued" && !state.driver_pid) {
    saveState(root, name, { status: "stopped", detail: "stopped before launch" });
    console.log(`${name}: stopped before launch`);
    return undefined;
  }
  // a just-resumed lane records its driver within moments
  for (let tries = 0; tries < 50 && !state.driver_pid; tries++) {
    await sleep(0.1);
    state = loadState(root, name);
  }
  if (state.driver_pid && !state.driver_started)
    return `${name}: started by an older runner, so pid ${state.driver_pid} can't be confirmed; stop it yourself, then use stop --forget`;
  saveState(root, name, { stopping: true });
  const driver = state.driver_pid;
  const signalDriver = (signal: Sig) => {
    try {
      if (pidAlive(driver, DRIVER_NEEDLES, state.driver_started)) process.kill(driver!, signal);
    } catch {}
  };
  signalDriver("SIGTERM");
  for (let tries = 0; tries < 50 && pidAlive(driver, DRIVER_NEEDLES, state.driver_started); tries++)
    await sleep(0.1);
  signalDriver("SIGKILL");
  const latest = loadState(root, name);
  if (TERMINAL.has(latest.status ?? "")) {
    // it finished before the signal landed
    saveState(root, name, { stopping: false });
    console.log(`${name}: already ${latest.status}`);
    return undefined;
  }
  await sleep(1); // the driver's handler sent the backend SIGTERM; give it a moment, then take the group down
  killBackendGroup(latest);
  saveState(root, name, {
    status: "stopped",
    stopping: false,
    pid: null,
    detail: `stopped; ${NAME} continue resumes the session`,
  });
  console.log(`${name}: stopped`);
  return undefined;
}

// ---------------------------------------------------------------- quick commands

/**
 * Who is calling, from what each host sets. A tool started by the other one inherits both markers, and
 * those can't be told apart, so that case counts as unknown. Lanes drop the markers: see runOnce.
 */
function callerBackend(): Backend | undefined {
  const claude = Boolean(process.env.CLAUDECODE);
  const codex = Boolean(process.env.CODEX_THREAD_ID || process.env.CODEX_SANDBOX);
  const gemini = Boolean(process.env.GEMINI_CLI);
  const agy = Boolean(process.env.ANTIGRAVITY_AGENT || process.env.ANTIGRAVITY_CONVERSATION_ID);
  const count = (claude ? 1 : 0) + (codex ? 1 : 0) + (gemini ? 1 : 0) + (agy ? 1 : 0);
  if (count !== 1) return undefined;
  return claude ? "claude" : codex ? "codex" : gemini ? "gemini" : "agy";
}

function orchestratorSession(): string | undefined {
  return (
    setting("SESSION") ??
    (callerBackend() === "codex"
      ? process.env.CODEX_THREAD_ID
      : callerBackend() === "agy"
        ? process.env.ANTIGRAVITY_CONVERSATION_ID
        : undefined)
  );
}

async function cmdCleanup(command: "archive" | "restore" | "clear" | "prune", argv: string[]): Promise<void> {
  const pruning = command === "prune";
  const removing = pruning || command === "clear";
  const options = pruning ? ["root", "days"] : ["root", "session", "run-id"];
  if (removing) options.push("yes");
  const { v, positionals } = rootOption(argv, {}, options);
  if (positionals.length) return die(pruning ? "usage: delegate prune [--days N] [--root R] [--yes]" : `${command}: pass an orchestrator with --session ID`);
  const session = v("session") ?? orchestratorSession();
  if (!pruning && (!session || !SAFE_ID.test(session))) return die(`${command}: set DELEGATE_SESSION or pass --session ID`);
  const days = Number(v("days") ?? "7");
  if (pruning && (!Number.isInteger(days) || days < 1)) return die("--days must be a positive whole number");
  const cutoff = Date.now() - days * 86_400_000;
  const root = abs(v("root")!);
  const expected = v("run-id");
  const eligible = (state: State) => {
    if (!ARCHIVABLE.has(state.status ?? "") || state.stopping) return false;
    if (pruning) return Date.parse(state.updated ?? state.started ?? "") < cutoff && !(state.pid && pidExists(state.pid));
    if (state.orchestrator !== session || runIDProblem(state, expected)) return false;
    return command === "archive"
      ? !state.archived
      : Boolean(state.archived);
  };
  const records = laneRecords(root).filter(eligible);
  let skipped = false;
  if (!records.length) return console.log(pruning ? `prune: no finished lane records older than ${days} days under ${root}` : `${command}: no matching lanes in this session`);

  for (const record of records) {
    const { name } = record;
    if (removing && !v("yes")) {
      console.log(`${name}: would remove its ${pruning ? "finished" : "archived"} lane record`);
      continue;
    }
    const base = laneDir(root, name);
    if (!fs.lstatSync(base).isDirectory()) return die(`${name}: lane folder is not a directory`);
    let changed = false;
    let retired = "";
    const locked = await laneLock(base, `${name}: another lane operation is in progress`, async (retire) => {
      const state = loadState(root, name);
      if (state.name !== name || state.run_id !== record.run_id || state.started_ms !== record.started_ms || !eligible(state)) return undefined;
      if (state.pid && pidExists(state.pid)) {
        // One busy lane must not end the batch: report it and keep going.
        console.error(`${name}: its backend may still be running; skipped`);
        skipped = true;
        return undefined;
      }
      if (removing) {
        retired = retire();
      } else {
        saveState(root, name, { archived: command === "archive" });
      }
      changed = true;
      return undefined;
    }, 5000, true);
    if (!locked) {
      console.error(`${name}: another lane operation is in progress; skipped`);
      skipped = true;
      continue;
    }
    if (!changed) continue;
    if (retired) fs.rmSync(retired, { recursive: true, force: true });
    console.log(`${name}: ${command === "archive" ? "archived" : command === "restore" ? "restored" : pruning ? "pruned" : "cleared"}`);
  }
  if (removing && !v("yes")) console.log("Pass --yes to remove these lane records.");
  if (skipped) process.exit(1);
}

/** A second opinion comes from the other model, so review and task pick the backend the caller is not. */
function otherBackend(requested: string | undefined, command: string): Backend {
  if (requested) {
    if (requested !== "codex" && requested !== "claude" && requested !== "gemini" && requested !== "agy")
      return die("--backend: codex, claude, gemini or agy");
    return requested;
  }
  const caller = callerBackend();
  if (!caller)
    return die(`${command}: can't tell which tool is calling; pass --backend codex, claude, gemini or agy`);
  return caller === "claude" ? "codex" : "claude";
}

function git(cwd: string, ...args: string[]): { ok: boolean; out: string; status: number | null } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), status: result.status };
}

/** The repo holding the current folder, or the folder itself outside a repo. */
function hereFolder(): string {
  const top = git(process.cwd(), "rev-parse", "--show-toplevel");
  return realish(top.ok && top.out ? top.out : process.cwd());
}

/** The repo holding a folder, or the folder itself: the identity `status` and `wait` compare. */
function projectOf(dir: string): string {
  const top = git(dir, "rev-parse", "--show-toplevel");
  return realish(top.ok && top.out ? top.out : dir);
}

function projectLabel(dir: string): string {
  const common = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return common.ok && path.basename(common.out) === ".git" ? path.basename(path.dirname(common.out)) : path.basename(dir);
}

function branchLabel(branch: string): string {
  return branch.replace(/^(?:codex\/|lane[-/])/i, "").replace(/[-_/]+/g, " ")
    .replace(/\b(ui|api|cli|sdk|ci)\b/gi, (word) => word.toUpperCase())
    .replace(/^./, (letter) => letter.toUpperCase());
}

function sessionTitle(state: State): string {
  return alertText(clean(state.title || branchLabel(state.name)), 100) || "Worker session";
}

const startedAt = (state: State) => state.started_ms ?? (Date.parse(state.started ?? "") || 0);

const lanesHere = (root: string) => {
  const here = hereFolder();
  const session = orchestratorSession() ?? "";
  return laneRecords(root)
    .filter((state) => !state.archived && (state.orchestrator ?? "") === session && realish(state.origin ?? state.dir) === here)
    .map((state) => reconcile(root, state))
    .sort((a, b) => startedAt(a) - startedAt(b) || a.name.localeCompare(b.name));
};

/** The newest lane asked from this folder, so lanes running elsewhere are never picked by accident. */
function latestLane(root: string, unique = false): string {
  const states = lanesHere(root);
  if (unique && states.length > 1) return die("more than one lane from this session; pass a NAME");
  const latest = states.at(-1);
  return latest ? latest.name : die(`no lanes from this folder under ${root}; pass a NAME`);
}

/** The words of a task or branch as a name that reads well in `status` and in alerts. */
function freshName(root: string, words: string): string {
  const slug = words
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 4)
    .join("-")
    .slice(0, 30);
  for (let tries = 0; tries < 20; tries++) {
    const name = `${slug || "lane"}-${Math.random().toString(16).slice(2, 6).padEnd(4, "0")}`;
    if (!fs.existsSync(laneDir(root, name))) return name;
  }
  return die("could not find a free lane name; pass --name");
}

interface QuickLane {
  name: string;
  title: string;
  root: string;
  backend: Backend;
  dir: string;
  origin: string;
  brief: string;
  baseCommit?: string;
  sandbox: Sandbox;
  schema?: string;
  effort?: string;
  v: (key: string) => string | undefined;
}

/** Take the name before anything else happens: two lanes under one name would break `stop` and `continue`. */
function claimLane(root: string, name: string, backend: Backend, dir: string): void {
  checkNewName(root, name);
  const base = laneDir(root, name);
  const problem = rootProblem(root, backend, dir, [], false);
  if (problem) die(problem);
  fs.mkdirSync(root, { recursive: true });
  try {
    fs.mkdirSync(base, { mode: PRIVATE_DIR });
  } catch (error: unknown) {
    const taken = error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST";
    die(taken ? `${name}: that lane already exists` : `${name}: ${String(error)}`);
  }
}

/** Start a claimed lane: wait and print its result, or detach with --background. */
async function startQuick(lane: QuickLane): Promise<void> {
  const { name, root, backend, dir, origin, sandbox, v } = lane;
  const effort = v("effort") ?? lane.effort;
  const brief = path.join(laneDir(root, name), "brief.md");
  fs.writeFileSync(brief, lane.brief, { flag: "wx", mode: 0o600 });
  // on disk before the driver starts, so `stop`, `result` and `status` can see a lane that is just starting
  const state = saveState(root, name, {
    name,
    title: alertText(v("title") || lane.title, 100),
    run_id: crypto.randomUUID(),
    base_commit: lane.baseCommit ?? "",
    backend,
    dir,
    origin,
    orchestrator: orchestratorSession() ?? "",
    prompt: brief,
    state_dir: laneDir(root, name),
    model: v("model") ?? DEFAULT_MODEL[backend],
    sandbox,
    status: "queued",
    started: now(),
    started_ms: Date.now(),
    driver_pid: null,
    driver_started: "",
  });
  const args = [
    name,
    "--run-id",
    state.run_id!,
    "--dir",
    dir,
    "--origin",
    origin,
    "--prompt",
    brief,
    "--root",
    root,
    "--backend",
    backend,
    "--sandbox",
    sandbox,
    ...(lane.schema ? ["--schema", lane.schema] : []),
    ...(v("model") ? ["--model", v("model")!] : []),
    ...(effort ? ["--effort", effort] : []),
    ...(v("idle-timeout") ? ["--idle-timeout", v("idle-timeout")!] : []),
  ];
  if (v("background")) {
    spawnDetached(
      [...selfCommand(), "_run", ...args],
      path.join(laneDir(root, name), "driver.log"),
    );
    if (v("json")) console.log(JSON.stringify({ name, title: sessionTitle(state), root, run_id: state.run_id, backend, status: "queued", dir, base_commit: state.base_commit, report: null }));
    else console.log(`${name}: running on ${backend}. Read it with: ${NAME} result ${laneReference(root, state)}`);
    return;
  }
  console.error(`${name}: running on ${backend}`);
  await cmdRun(args, true);
  printResult(root, name, Boolean(v("json")));
}

function reviewTarget(top: string, baseArg: string | undefined): string {
  const inspect =
    "Read only what you need around the change, and check how the changed code is called.";
  const uncommitted =
    "Review the uncommitted changes: run `git status --short` and `git diff --no-ext-diff HEAD`, and read every " +
    "untracked file it lists. If the repo has no commits yet, every file counts as new.";
  const against = (label: string, sha: string) =>
    `Review the current branch against ${label}: run \`git diff --no-ext-diff ${sha}...HEAD\`.`;
  const status = git(top, "status", "--porcelain");
  if (!status.ok) return die("review: git status failed");
  const dirty = Boolean(status.out);
  /** True if HEAD has nothing beyond this base. Any other git failure is not "no changes". */
  const unchanged = (label: string, sha: string) => {
    const code = git(top, "diff", "--quiet", "--no-ext-diff", `${sha}...HEAD`).status;
    if (code !== 0 && code !== 1) return die(`review: can't compare this branch with ${label}`);
    return code === 0;
  };
  if (baseArg !== undefined) {
    const base =
      !baseArg || baseArg.startsWith("-")
        ? undefined
        : git(top, "rev-parse", "--verify", "--quiet", `${baseArg}^{commit}`);
    if (!base?.ok) return die(`--base: no such commit: ${baseArg}`);
    const label = clean(baseArg);
    if (!unchanged(label, base.out))
      return `${against(label, base.out)}${dirty ? ` ${uncommitted}` : ""} ${inspect}`;
    return dirty
      ? `${uncommitted} ${inspect}`
      : die(`review: nothing to review against ${baseArg}`);
  }
  if (dirty) return `${uncommitted} ${inspect}`;
  const remoteHead = git(top, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
  // the first base that exists is this branch's base: a stale local main further down would review upstream's commits
  for (const candidate of [remoteHead.ok ? remoteHead.out : "", "main", "master"].filter(Boolean)) {
    const base = git(top, "rev-parse", "--verify", "--quiet", `${candidate}^{commit}`);
    if (!base.ok) continue;
    if (unchanged(candidate, base.out)) break;
    return `${against(candidate, base.out)} ${inspect}`;
  }
  return die(
    "review: nothing to review, the tree is clean and this branch has no changes; pass --base REF",
  );
}

const QUICK_FLAGS = [
  "root",
  "backend",
  "model",
  "effort",
  "name",
  "title",
  "idle-timeout",
  "background",
  "json",
];

async function cmdReview(argv: string[]): Promise<void> {
  const { v, positionals } = flags(argv, { root: DEFAULT_ROOT }, [
    ...QUICK_FLAGS,
    "base",
    "focus",
    "adversarial",
  ]);
  if (positionals.length)
    return die("usage: delegate review [--base REF] [--focus TEXT] [--adversarial]");
  const top = git(process.cwd(), "rev-parse", "--show-toplevel");
  if (!top.ok || !top.out) return die("review: run this inside a git repo");
  const here = realish(top.out);
  const target = reviewTarget(here, v("base"));
  const stance = v("adversarial")
    ? "Argue against shipping this. Question the approach and its assumptions as well as the code, and try to " +
      "find what breaks under retries, concurrency, bad input and partial failure. Give no credit for intent."
    : "Find real bugs a maintainer would want to know about before merging.";
  const brief = [
    "You are reviewing someone else's change. Do not edit anything.",
    target,
    stance,
    "Report only findings you can defend from the code, each with a concrete way it fails and a fix. Skip style. " +
      "No findings is a fine result.",
    ...(v("focus") ? [`Focus on this first: ${v("focus")}`] : []),
  ].join("\n\n");
  const root = abs(v("root")!);
  const branch = git(here, "branch", "--show-current").out;
  const backend = otherBackend(v("backend"), "review");
  const name = v("name") ?? freshName(root, `review ${branch || path.basename(here)}`);
  claimLane(root, name, backend, here);
  await startQuick({
    name,
    title: `${v("adversarial") ? "Adversarial review" : "Review"} · ${projectLabel(here)} · ${branch ? branchLabel(branch) : "Current changes"}`,
    root,
    backend,
    dir: here,
    origin: here,
    brief,
    sandbox: "read-only",
    schema: "review",
    effort: "high",
    v,
  });
}

/** A writing task gets its own worktree and branch, so it can't overwrite work in this checkout. */
function taskWorktree(root: string, top: string, name: string): { dir: string; commit: string } {
  const fail = (message: string): never => {
    fs.rmSync(laneDir(root, name), { recursive: true, force: true });
    return die(`task --write: ${message}`);
  };
  const dir = path.join(top, ".worktrees", name);
  const head = git(top, "rev-parse", "--verify", "--quiet", "HEAD");
  if (!head.ok) return fail("this repo has no commits to branch from");
  if (realish(path.dirname(dir)) !== path.dirname(dir)) return fail(".worktrees must be a real directory inside the repo");
  if (git(top, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`).ok)
    return fail(`a branch named ${name} already exists; pass --name`);
  if (fs.existsSync(dir)) return fail(`${dir} already exists; pass --name`);
  const result = spawnSync("git", ["worktree", "add", "--quiet", "-b", name, dir, head.out], {
    cwd: top,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    // A different launch may have created the branch or directory after the checks above.
    return fail(`${(result.stderr || result.error?.message || "git worktree add failed").trim()}. Check git worktree list before retrying.`);
  }
  try {
    const file = path.resolve(top, git(top, "rev-parse", "--git-path", "info/exclude").out);
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (!current.split("\n").includes(".worktrees/")) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}.worktrees/\n`);
    }
  } catch {
    console.error(
      `${name}: could not add .worktrees/ to git's exclude file, so git status may list it`,
    );
  }
  if (git(top, "status", "--porcelain").out)
    console.error(`${name}: starts from HEAD, so your uncommitted changes are not in its worktree`);
  console.error(`${name}: worktree ${dir} starts at ${head.out}`);
  return { dir, commit: head.out };
}

async function cmdTask(argv: string[]): Promise<void> {
  const { v, positionals } = rootOption(argv, {}, [...QUICK_FLAGS, "write"]);
  const text = positionals.join(" ").trim();
  if (!text) return die('usage: delegate task "what to do" [--write] [--background]');
  const root = abs(v("root")!);
  const here = hereFolder();
  const backend = otherBackend(v("backend"), "task");
  const name = v("name") ?? freshName(root, text);
  claimLane(root, name, backend, here);
  const checkout = v("write") ? taskWorktree(root, here, name) : { dir: here, commit: "" };
  await startQuick({
    name,
    title: `${v("write") ? "Change" : "Task"} · ${projectLabel(here)} · ${text.split("\n", 1)[0]}`,
    root,
    backend,
    dir: checkout.dir,
    baseCommit: checkout.commit,
    origin: here,
    brief: text,
    sandbox: v("write") ? "workspace-write" : "read-only",
    v,
  });
}

/** Report fields are untrusted and may not match the schema, so anything but plain text prints as nothing. */
const fieldText = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? clean(String(value)) : "";

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(fieldText).filter(Boolean) : [];
}

function reportText(report: Record<string, any>): string {
  const lines: string[] = [];
  if (fieldText(report.summary)) lines.push(fieldText(report.summary));
  const findings: unknown[] = Array.isArray(report.findings) ? report.findings : [];
  for (const finding of findings) {
    if (!isRecord(finding)) continue;
    lines.push(
      `\n[${fieldText(finding.severity)}] ${fieldText(finding.file)}:${fieldText(finding.line)}`,
    );
    lines.push(`  ${fieldText(finding.problem)}`);
    if (fieldText(finding.failure_scenario))
      lines.push(`  Fails when: ${fieldText(finding.failure_scenario)}`);
    if (fieldText(finding.fix)) lines.push(`  Fix: ${fieldText(finding.fix)}`);
  }
  const changed = textList(report.files_changed);
  if (changed.length) lines.push(`\nChanged: ${changed.join(", ")}`);
  if (isRecord(report.build) && report.build.ran) {
    const detail = fieldText(report.build.detail);
    lines.push(
      `build: ${report.build.passed === true ? "passed" : "failed"}${detail ? `. ${detail}` : ""}`,
    );
  }
  if (isRecord(report.tests) && report.tests.ran) {
    const detail = fieldText(report.tests.detail);
    const counts = `${fieldText(report.tests.passed) || 0} passed, ${fieldText(report.tests.failed) || 0} failed`;
    lines.push(`tests: ${counts}${detail ? `. ${detail}` : ""}`);
  }
  const untested = textList(report.untested);
  if (untested.length) lines.push(`Not tested: ${untested.join("; ")}`);
  for (const question of textList(report.questions)) lines.push(`? ${question}`);
  if (fieldText(report.notes)) lines.push(`\n${fieldText(report.notes)}`);
  return lines.join("\n").trim();
}

function readReport(base: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(base, "report.json"), "utf8"));
    if (isRecord(parsed)) return parsed;
  } catch {}
  return undefined;
}

function reportView(root: string, state: State): string {
  const base = laneDir(root, state.name);
  const report = ACTIVE.has(state.status ?? "") ? undefined : readReport(base);
  if (!report) return "";
  const sections = [sessionTitle(state), `${state.status} on ${backendOf(state)}`, reportText(report)];
  if (state.warning) sections.push(`Warning: ${clean(state.warning)}`);
  if (state.status === "needs_input")
    sections.push(`Answer with: ${NAME} answer ${laneReference(root, state)} '<your answer>'`);
  const view = path.join(base, "report.txt");
  const temp = `${view}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, sections.filter(Boolean).join("\n\n") + "\n", { flag: "wx", mode: 0o600 });
  fs.renameSync(temp, view);
  return view;
}

const RESULT_NOT_READY = 75;

/** Prints the lane and exits non-zero unless it got through its work, so `task ... && next` is safe. */
function printResult(root: string, name: string, json: boolean, expected?: string): void {
  const record = loadState(root, name);
  const mismatch = runIDProblem(record, expected);
  if (mismatch) return die(mismatch);
  const state = reconcile(root, record);
  if (!state.name) return die(`${name}: no such lane under ${root}`);
  const active = ACTIVE.has(state.status ?? "");
  const report = active ? undefined : readReport(laneDir(root, name));
  if (json) {
    console.log(
      JSON.stringify({ name, title: sessionTitle(state), root, run_id: state.run_id ?? null, backend: backendOf(state), thread_id: state.thread_id ?? null,
        status: state.status, dir: state.dir, base_commit: state.base_commit || null,
        detail: state.detail ?? "", warning: state.warning ?? "", report: report ?? null }),
    );
  } else if (active) {
    console.log(`${name}: still ${state.status}. ${clean(state.last_activity ?? "")}`.trim());
  } else {
    console.log(`${name}: ${state.status} on ${backendOf(state)}`);
    if (state.origin && realish(state.origin) !== realish(state.dir))
      console.log(`worktree: ${state.dir}`);
    if (state.base_commit)
      console.log(`base: ${state.base_commit}\ninspect: git -C ${shellQuote(state.dir)} status --short\n` +
        `         git -C ${shellQuote(state.dir)} diff ${state.base_commit}`);
    if (state.warning) console.log(`warning: ${clean(state.warning)}`);
    if (report) console.log(`\n${reportText(report)}`);
    else console.log(clean(state.detail ?? "no report"));
    if (state.status === "needs_input")
      console.log(`Answer with: ${NAME} answer ${laneReference(root, state)} '<your answer>'`);
  }
  if (active) process.exit(RESULT_NOT_READY);
  if (state.warning || !(report && (state.status === "done" || state.status === "partial")))
    process.exit(1);
}

function cmdResult(argv: string[]): void {
  const { v, positionals } = rootOption(argv, {}, ["root", "json", "run-id"]);
  const root = abs(v("root")!);
  printResult(root, positionals[0] ?? latestLane(root), Boolean(v("json")), v("run-id"));
}

async function cmdNotify(argv: string[]): Promise<void> {
  const { v, positionals } = rootOption(argv, {}, ["root", "terminal", "run-id"]);
  if (positionals.length > 1) return die("usage: delegate notify [NAME] [--root ROOT] [--terminal]");
  const root = abs(v("root")!);
  const name = positionals[0] ?? latestLane(root);
  await laneLock(laneDir(root, name), `${name}: another lane operation is in progress`, async () => {
    let state = loadState(root, name);
    if (!state.name || !TERMINAL.has(state.status ?? "")) return `${name}: a finished lane is required`;
    const mismatch = runIDProblem(state, v("run-id"));
    if (mismatch) return mismatch;
    if (!state.run_id) state = saveState(root, name, { run_id: crypto.randomUUID() });
    if (!notify(state, "test alert", "Click to open its report.", Boolean(v("terminal")) || setting("OPEN_TARGET") === "terminal"))
      return "a clickable alert requires the macOS notifier app and notification permission";
    return undefined;
  });
  console.log(`${name}: posted a clickable test alert`);
}

function cmdOpen(argv: string[]): void {
  const { v, positionals } = rootOption(argv, {}, ["root", "report", "terminal", "run-id"]);
  if (positionals.length > 1 || (v("report") && v("terminal")))
    return die("usage: delegate open [NAME] [--root ROOT] [--report | --terminal]");
  const root = abs(v("root")!);
  const name = positionals[0] ?? latestLane(root);
  const state = loadState(root, name);
  if (!state.name) return die(`${name}: no such lane under ${root}`);
  const mismatch = runIDProblem(state, v("run-id"));
  if (mismatch) return die(mismatch);
  const base = laneDir(root, name);
  if (process.platform !== "darwin") {
    console.log(reportView(root, state) || base);
    return;
  }
  const id = state.thread_id;
  const launch = (command: string, args: string[], cwd: string) =>
    spawnSync(command, args, {
      cwd, stdio: "ignore", timeout: 8000, killSignal: "SIGKILL",
      env: { ...process.env, PATH: lanePath() },
    }).status === 0;
  const backend = backendOf(state);
  if (!v("report") && (v("terminal") || setting("OPEN_TARGET") === "terminal") && TERMINAL.has(state.status ?? "") &&
      typeof id === "string" && SAFE_ID.test(id) && (backend === "codex" || state.session_started)) {
    const args =
      backend === "codex"
        ? ["resume", "--sandbox", state.sandbox === "read-only" ? "read-only" : "workspace-write", id]
        : backend === "agy"
          ? ["--conversation", id]
          : ["--resume", id];
    const command = `cd -- ${shellQuote(state.dir)} && exec ${[resolveBin(backend), ...args].map(shellQuote).join(" ")}`;
    const script = 'on run argv\n tell application "Terminal"\n do script (item 1 of argv)\n activate\n end tell\nend run';
    if (launch(setting("OSASCRIPT") || "/usr/bin/osascript", ["-e", script, command], process.cwd())) return;
    return die(`${name}: Terminal could not open the session`);
  }
  const report = reportView(root, state);
  if (report && launch("open", ["-t", report], process.cwd())) return;
  if (!launch("open", ["-R", base], process.cwd())) return die(`could not open ${base}`);
}

/** Without a NAME, stop only when one lane from this folder is active: never guess between them. */
function stopTarget(root: string): string {
  const active = lanesHere(root).filter((state) => ACTIVE.has(state.status ?? ""));
  if (active.length === 1) return active[0]!.name;
  if (!active.length) return die("no running lane from this folder");
  return die(
    `more than one lane is running; pass a NAME: ${active.map((state) => state.name).join(", ")}`,
  );
}

async function cmdResume(argv: string[]): Promise<void> {
  const { v, positionals } = rootOption(argv);
  const name = positionals[0]!;
  const root = abs(v("root")!);
  const state = loadState(root, name);
  if (state.status !== "running" || state.driver_pid || runIDProblem(state, v("run-id"))) return;
  const textFile = path.join(laneDir(root, name), "resume.txt");
  const text = fs.readFileSync(textFile, "utf8");
  fs.rmSync(textFile, { force: true });
  startDriver(root, name);
  // a Claude or Gemini session that never reached the model does not exist, so it starts over from its prompt
  if (backendOf(state) !== "codex" && !state.session_started) await drive(root, name, false, text);
  else await drive(root, name, true, text);
}

const slotFile = (index: number) => path.join(SLOTS_DIR, `slot-${index}.lock`);

/** The driver makes the slot files. A sandboxed lane only opens them to read, which is all flock needs, so it cannot replace one with a link. */
function ensureSlots(count: number): void {
  fs.mkdirSync(SLOTS_DIR, { recursive: true, mode: PRIVATE_DIR });
  for (let index = 0; index < count; index++) fs.closeSync(fs.openSync(slotFile(index), "a"));
}

function openSlot(index: number): number {
  try {
    return fs.openSync(slotFile(index), "r");
  } catch {}
  try {
    ensureSlots(index + 1);
    return fs.openSync(slotFile(index), "r");
  } catch {
    return -1;
  }
}

/** Hold one of N build slots while CMD runs, so at most N builds share the Mac. flock frees a slot if its holder dies. */
/** build-queue on PATH whose state folder this process can write. A sandboxed lane can't, so it keeps the lane slots. */
function buildQueueBin(): string | undefined {
  if (setting("NO_BUILD_QUEUE")) return undefined;
  const found = lanePath().split(":").map((dir) => path.join(dir, "build-queue")).find((file) => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
  });
  if (!found) return undefined;
  const state = process.env.BUILD_QUEUE_STATE_DIR || path.join(process.env.XDG_STATE_HOME || path.join(HOME, ".local/state"), "build-queue");
  const probe = path.join(state, `.delegate-probe-${process.pid}`);
  try {
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return found;
  } catch {
    return undefined;
  }
}

async function cmdBuild(argv: string[]): Promise<void> {
  // the command starts at `--` or the first non-flag; everything after it belongs to the command
  let flagged = false;
  let requested = "2";
  let start = 0;
  let solo = false;
  while (argv[start] === "--slots" || argv[start]?.startsWith("--slots=") || argv[start] === "--solo") {
    if (argv[start] === "--solo") {
      solo = true;
      start += 1;
      continue;
    }
    if (argv[start] === "--slots") {
      requested = argv[start + 1] ?? requested;
      flagged = true;
      start += 2;
    } else {
      requested = argv[start]!.slice("--slots=".length);
      flagged = true;
      start += 1;
    }
  }
  const command = argv[start] === "--" ? argv.slice(start + 1) : argv.slice(start);
  if (!command.length) return die("usage: delegate build [--solo] -- CMD...");
  const queue = buildQueueBin();
  if (queue) {
    // One limit for the whole machine: leads use build-queue directly, so lane builds join the same slots.
    // A worker runs unattended, so it queues instead of skipping after build-queue's default 10 s.
    const result = spawnSync(queue, [...(solo ? ["--solo"] : []), ...command], {
      stdio: "inherit",
      env: { ...process.env, BUILD_QUEUE_TIMEOUT: process.env.BUILD_QUEUE_TIMEOUT ?? "1800" },
    });
    if (result.error) return die(`build-queue: ${result.error.message}`);
    process.exit(result.status ?? (result.signal ? 128 + ((os.constants.signals as any)[result.signal] ?? 0) : 1));
  }
  const cap = setting("BUILD_SLOTS");
  // inside a lane, --slots may lower the cap the lead set but never raise it
  const slots = flagged && cap ? Math.min(Number(requested), Number(cap)) : Number(flagged ? requested : cap ?? requested);
  if (!Number.isInteger(slots) || slots < 1)
    return die(`build slots must be a positive whole number, not ${slots}`);
  const LOCK_EX_NB = 2 | 4;
  if (solo) {
    // without build-queue, --solo holds every slot so no other build runs beside it
    // shortcut: only the first `slots` slots are held, so a plain build with a larger --slots can still run beside it; upgrade by holding a fixed maximum
    while (true) {
      const held: number[] = [];
      for (let index = 0; index < slots; index++) {
        const handle = openSlot(index);
        if (handle < 0) return die(`no usable build slots in ${SLOTS_DIR}`);
        setCloexec(handle);
        if (flock(handle, LOCK_EX_NB) !== 0) { fs.closeSync(handle); break; }
        held.push(handle);
      }
      if (held.length === slots) {
        const result = spawnSync(command[0]!, command.slice(1), { stdio: "inherit" });
        if (result.error) console.error(`${command[0]}: ${result.error.message}`);
        process.exit(result.status ?? (result.signal ? 128 + ((os.constants.signals as any)[result.signal] ?? 0) : 127));
      }
      for (const handle of held) fs.closeSync(handle);
      await sleep(1);
    }
  }
  while (true) {
    let opened = 0;
    for (let index = 0; index < slots; index++) {
      const handle = openSlot(index);
      if (handle < 0) continue;
      opened += 1;
      setCloexec(handle); // a daemon started by the build must not keep the slot
      if (flock(handle, LOCK_EX_NB) !== 0) {
        fs.closeSync(handle);
        continue;
      }
      const result = spawnSync(command[0]!, command.slice(1), { stdio: "inherit" });
      if (result.error) console.error(`${command[0]}: ${result.error.message}`);
      process.exit(
        result.status ??
          (result.signal ? 128 + ((os.constants.signals as any)[result.signal] ?? 0) : 127),
      );
    }
    if (!opened) return die(`no usable build slots in ${SLOTS_DIR}`);
    await sleep(5);
  }
}

function cmdDoctor(): void {
  let found = 0;
  for (const backend of ["codex", "claude", "gemini", "agy"] as const) {
    const binary = resolveBin(backend);
    const version = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, PATH: lanePath() },
    });
    if (version.status === 0) {
      found += 1;
      console.log(`${backend}: ${binary} (${String(version.stdout).trim()})`);
    } else {
      console.log(`${backend}: not found`);
    }
  }
  console.log(`delegate: ${process.execPath}`);
  console.log(`state: ${CACHE}`);
  if (process.platform === "darwin") {
    for (const backend of ["codex", "claude", "gemini", "agy"] as const) {
      const app = fs.existsSync(notifierBin(backend));
      console.log(
        `${backend} alerts: ${app ? notifierBin(backend) : "osascript (bun run notifiers adds the icon)"}`,
      );
    }
  }
  if (!found) die("install codex, claude, gemini or agy to run lanes");
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "build" && (rest.includes("-h") || rest.includes("--help")))
    return console.log(USAGE);
  switch (command) {
    case "run":
      return cmdRun(rest);
    case "batch":
      return cmdBatch(rest);
    case "review":
      return cmdReview(rest);
    case "task":
      return cmdTask(rest);
    case "result":
      return cmdResult(rest);
    case "open":
      return cmdOpen(rest);
    case "notify":
      return cmdNotify(rest);
    case "archive":
    case "restore":
    case "clear":
    case "prune":
      return cmdCleanup(command, rest);
    case "status": {
      const { v } = rootOption(rest, {}, ["root", "poll", "session", "archived", "all", "json"]);
      const root = abs(v("root")!);
      return printStatus(root, {
        // same implicit scope as `wait`: the current project and orchestrator
        project: !v("all") && !v("session") && !v("archived") && root === DEFAULT_ROOT ? hereFolder() : "",
        session: v("all") ? "" : v("session") ?? orchestratorSession() ?? "",
        archived: Boolean(v("archived")), json: Boolean(v("json")),
      });
    }
    case "wait":
      return cmdWait(rest);
    case "answer":
      return cmdAnswer(rest);
    case "continue":
      return cmdContinue(rest);
    case "stop":
      return cmdStop(rest);
    case "_run":
      return cmdRun(rest, true);
    case "_resume":
      return cmdResume(rest);
    case "build":
      return cmdBuild(rest);
    case "doctor":
      return cmdDoctor();
    case "-V":
    case "--version":
      console.log(`delegate ${VERSION}`);
      return;
    case "-h":
    case "--help":
    case undefined:
      console.log(USAGE);
      return;
    default:
      die(`unknown command: ${command}\n\n${USAGE}`);
  }
}

await main().catch((error: unknown) =>
  die(`delegate: ${error instanceof Error ? error.message : String(error)}`),
);

process.exit(0); // a background child may still hold the backend's stdout open
