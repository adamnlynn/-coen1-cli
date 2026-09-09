import { stdout } from "node:process";
import { spawn, execFileSync } from "node:child_process";
import { openSync, readFileSync, existsSync } from "node:fs";
import { platform } from "node:os";
import { ACTIVE_PROFILE, type CoenConfig } from "../config.js";
import { signedIn } from "../auth.js";
import { autostart, daemonCommand } from "./autostart.js";
import { runDaemon } from "./run.js";
import {
  LOG_PATH,
  clearState,
  ensureDaemonDir,
  pidAlive,
  readState,
  rollLog,
  type DaemonState,
} from "./state.js";
import { type HealthReport } from "./serve-http.js";

/**
 * `coen daemon …`
 *
 * `start` and `stop` each do two things, deliberately: start it AND make it start at login, stop
 * it AND stop it starting at login. That is what a person means by those words. `--no-autostart`
 * and `--keep-autostart` split them when you want them split.
 */

const dim = (s: string) => stdout.write(`\x1b[2m${s}\x1b[0m\n`);
const red = (s: string) => stdout.write(`\x1b[31m${s}\x1b[0m\n`);
const ok = (s: string) => stdout.write(`\x1b[32m${s}\x1b[0m\n`);
const plain = (s: string) => stdout.write(`${s}\n`);

const USAGE =
  "coen daemon — the one process that serves Coen's tools to every agent on this machine,\n" +
  "               and watches for your reads while nothing is on screen\n" +
  "  coen daemon start     start it, and make it start when you log in\n" +
  "                        --no-autostart to start it just this once\n" +
  "  coen daemon stop      stop it, and stop it starting when you log in\n" +
  "                        --keep-autostart to stop it only until the next login\n" +
  "  coen daemon status    running? on what port? signed in as who? connected to what?\n" +
  "  coen daemon restart\n" +
  "  coen daemon logs [-f] what it has been doing\n" +
  "  coen daemon run       run it here, in the foreground (this is what the login entry calls)\n";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The daemon as the state file describes it, and whether that description is still true. */
function live(): { state: DaemonState; alive: boolean } | null {
  const state = readState();
  return state ? { state, alive: pidAlive(state.pid) } : null;
}

/** Ask the running daemon how it is. Null when it does not answer. */
async function health(state: DaemonState): Promise<HealthReport | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/health`, {
      headers: { Authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok ? ((await res.json()) as HealthReport) : null;
  } catch {
    return null;
  }
}

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};

// ── start ────────────────────────────────────────────────────────────────────

async function start(args: string[], cfg: CoenConfig): Promise<void> {
  if (!signedIn(cfg)) {
    red(cfg.auth ? "your sign-in has expired." : "not signed in.");
    dim("run `coen login` first — the daemon acts as you, with your sign-in.");
    process.exit(1);
  }

  const cur = live();
  if (cur?.alive) {
    const h = await health(cur.state);
    if (h) {
      dim(`already running (pid ${cur.state.pid}, port ${cur.state.port}).`);
      return;
    }
    // A live pid that will not answer is worse than a dead one: something is wrong with it and
    // starting a second would leave two. Say so rather than guessing.
    red(`pid ${cur.state.pid} is alive but not answering on port ${cur.state.port}.`);
    dim("`coen daemon stop` then start again.");
    process.exit(1);
  }
  if (cur) clearState(); // stale file from a crash

  ensureDaemonDir();
  rollLog();
  const { exe, args: cmdArgs } = daemonCommand();
  const out = openSync(LOG_PATH, "a");
  const child = spawn(exe, cmdArgs, {
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
    env: process.env,
  });
  child.unref();

  // Wait for it to write its state file and answer — up to ten seconds. Reporting "started"
  // before it is listening is how a start that failed looks like one that worked.
  let started: DaemonState | null = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const s = readState();
    if (s && s.pid !== 0 && (await health(s))) {
      started = s;
      break;
    }
    if (child.exitCode !== null && !readState()) break;
  }
  if (!started) {
    red("the daemon didn't come up.");
    dim(`what it said: ${LOG_PATH}   ·   coen daemon logs`);
    process.exit(1);
  }
  ok(`daemon started (pid ${started.pid}) · http://127.0.0.1:${started.port}/mcp`);

  if (args.includes("--no-autostart")) {
    dim("not registered to start at login (--no-autostart).");
    return;
  }
  try {
    const note = autostart().enable();
    ok(`it will start when you log in — ${autostart().describe()}`);
    if (note) dim(note);
  } catch (e) {
    red(`started, but couldn't register it to start at login: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── stop ─────────────────────────────────────────────────────────────────────

async function stop(args: string[]): Promise<void> {
  const keep = args.includes("--keep-autostart");
  const cur = live();

  if (!cur) {
    dim("not running.");
  } else if (!cur.alive) {
    clearState();
    dim(`not running (cleared a stale record of pid ${cur.state.pid}).`);
  } else {
    // Ask first — it closes the port and clears its own state file. Signals are the fallback.
    await fetch(`http://127.0.0.1:${cur.state.port}/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cur.state.token}` },
      signal: AbortSignal.timeout(3_000),
    }).catch(() => {});

    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      await sleep(250);
      gone = !pidAlive(cur.state.pid);
    }
    if (!gone) {
      killPid(cur.state.pid, false);
      for (let i = 0; i < 20 && !gone; i++) {
        await sleep(250);
        gone = !pidAlive(cur.state.pid);
      }
    }
    if (!gone) killPid(cur.state.pid, true);
    clearState();
    ok(gone ? `stopped (pid ${cur.state.pid}).` : `killed (pid ${cur.state.pid}).`);
    dim("every agent on this machine has lost Coen's tools until you start it again.");
  }

  if (keep) {
    // Only claim it, because --keep-autostart is also how `restart` gets here, and a daemon
    // that was never registered is not "still set" to do anything.
    try {
      if (autostart().isEnabled()) dim("still set to start when you log in (--keep-autostart).");
    } catch {
      /* nothing to report on a platform we can't ask */
    }
    return;
  }
  try {
    const a = autostart();
    const was = a.isEnabled();
    a.disable();
    ok(was ? "it will not start when you log in any more." : "it was not set to start at login.");
  } catch (e) {
    red(`couldn't remove the login entry: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** SIGTERM, then SIGKILL. Windows has neither, so taskkill stands in — /T because the daemon may
 *  have spawned stdio MCP children of its own. */
function killPid(pid: number, hard: boolean): void {
  try {
    if (platform() === "win32") {
      execFileSync("taskkill", hard ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"], {
        stdio: "ignore",
      });
    } else {
      process.kill(pid, hard ? "SIGKILL" : "SIGTERM");
    }
  } catch {
    /* already gone */
  }
}

// ── status ───────────────────────────────────────────────────────────────────

async function status(): Promise<void> {
  const label = ACTIVE_PROFILE === "default" ? "" : `  (agent: ${ACTIVE_PROFILE})`;
  const cur = live();
  let a: ReturnType<typeof autostart> | null = null;
  try {
    a = autostart();
  } catch {
    /* unsupported platform — reported below */
  }
  const atLogin = a?.isEnabled() ?? false;

  if (!cur || !cur.alive) {
    if (cur) clearState();
    red(`daemon: not running${label}`);
    plain(`at login:  ${atLogin ? `yes — ${a?.describe()}` : "no"}`);
    // Worth saying outright: with the daemon down there is no Coen for any agent on this
    // machine, not just no HTTP endpoint. `coen mcp serve` carries frames here and serves none
    // of its own.
    dim("no agent on this machine can reach your record while it is down.");
    dim("start it:  coen daemon start");
    return;
  }

  const h = await health(cur.state);
  if (!h) {
    red(`daemon: pid ${cur.state.pid} is alive but not answering on port ${cur.state.port}${label}`);
    dim("coen daemon stop, then start again   ·   coen daemon logs");
    return;
  }

  ok(`daemon: running${label}`);
  plain(`pid:       ${h.pid}  ·  up ${ago(h.startedAt)}  ·  coen ${h.version} on node ${cur.state.node}`);
  plain(`mcp:       http://127.0.0.1:${h.port}/mcp   (${h.tools} tools)`);
  plain(`stdio:     coen mcp serve                   (the same tools, carried to the line above)`);
  plain(`signed in: ${h.signedInAs ?? "nobody"}`);
  plain(`record:    ${h.record}`);
  plain(`attached:  ${h.mcpServers.length ? h.mcpServers.join(", ") : "no external MCP servers"}`);
  plain(`sync:      ${syncLine(h)}`);
  plain(`at login:  ${atLogin ? `yes — ${a?.describe()}` : "no  (coen daemon start registers it)"}`);
  if (h.lastError) red(`last error: ${h.lastError}`);
  dim(`token:     coen mcp url   ·   log: ${LOG_PATH}`);
}

/** The sync folder in one line, or how to get one. */
function syncLine(h: HealthReport): string {
  const s = h.sync;
  if (!s?.dir) return "off  (coen sync ~/journal)";
  const bits = [s.dir];
  if (!s.enabled) bits.push("off — files left in place");
  else {
    bits.push(`${s.files} files`);
    bits.push(s.lastPassAt ? `last pass ${ago(s.lastPassAt)} ago` : "no pass yet");
    if (s.waiting) bits.push(`${s.waiting} waiting in new/`);
    if (s.pending) bits.push(`${s.pending} not back from the journal`);
    if (s.git.enabled) bits.push(s.git.push ? "git: committing and pushing" : "git: committing");
  }
  return bits.join("  ·  ");
}

// ── logs ─────────────────────────────────────────────────────────────────────

function logs(args: string[]): void {
  if (!existsSync(LOG_PATH)) {
    dim("nothing logged yet.");
    return;
  }
  const follow = args.includes("-f") || args.includes("--follow");
  const text = readFileSync(LOG_PATH, "utf8");
  const lines = text.split("\n").filter(Boolean);
  for (const l of lines.slice(-200)) plain(l);
  if (!follow) return;

  // Follow by re-reading what has been appended. A watcher would be tidier, but this works the
  // same on every platform and the file only grows.
  let at = Buffer.byteLength(text);
  setInterval(() => {
    try {
      const next = readFileSync(LOG_PATH);
      if (next.length > at) {
        stdout.write(next.subarray(at).toString());
        at = next.length;
      } else if (next.length < at) {
        at = 0; // rolled
      }
    } catch {
      /* ignore */
    }
  }, 500);
}

// ── entry ────────────────────────────────────────────────────────────────────

export async function runDaemonCommand(args: string[], cfg: CoenConfig): Promise<void> {
  switch (args[0]) {
    case "run":
      return runDaemon();
    case "start":
      return start(args.slice(1), cfg);
    case "stop":
      return stop(args.slice(1));
    case "restart":
      await stop(["--keep-autostart"]);
      return start(args.slice(1), cfg);
    case "status":
      return status();
    case "logs":
    case "log":
      return logs(args.slice(1));
    default:
      dim(USAGE);
  }
}
