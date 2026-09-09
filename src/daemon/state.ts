import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { CONFIG_DIR, ACTIVE_PROFILE } from "../config.js";

/**
 * Where the daemon keeps what it needs to be found again.
 *
 * One daemon per profile, because the daemon inherits COEN_HOME the way everything else does —
 * `coen agent work daemon start` runs its own, with its own sign-in and its own port.
 *
 * daemon.json is the handle: the pid to signal, the port to reach, and the token to present.
 * It is written after the listener is up, so its presence means "there was a daemon", never
 * "there is about to be one". 0600, because the token is in it.
 */

export const DAEMON_DIR = join(CONFIG_DIR, "daemon");
export const STATE_PATH = join(DAEMON_DIR, "daemon.json");
export const LOG_PATH = join(DAEMON_DIR, "daemon.log");
export const WATCH_PATH = join(DAEMON_DIR, "state.json");

/** The default loopback port. A named profile takes whatever is free instead — two profiles must
 *  not fight over one port, and neither should the daemon and a stray process. */
export const DEFAULT_PORT = 7717;

export interface DaemonState {
  pid: number;
  port: number;
  /** Presented as `Authorization: Bearer` by anything talking to the loopback endpoint. */
  token: string;
  startedAt: number;
  version: string;
  node: string;
  profile: string;
}

/** What the daemon remembers between runs, so a restart doesn't re-fire what already fired. */
export interface WatchState {
  /** The extraction id of the newest read we acted on. Empty string means "we looked once and
   *  there was nothing", which is not the same as never having looked. */
  lastExtractionId?: string;
  /** The newest thought_dump_error event we acted on. */
  lastErrorEventId?: string;
  /** The local day (YYYY-MM-DD) the nudge last went out. */
  lastNudgeDay?: string;
}

export function ensureDaemonDir(): void {
  if (!existsSync(DAEMON_DIR)) mkdirSync(DAEMON_DIR, { recursive: true, mode: 0o700 });
}

export function readState(): DaemonState | null {
  try {
    const raw = readFileSync(STATE_PATH, "utf8").trim();
    if (!raw) return null;
    const s = JSON.parse(raw) as DaemonState;
    return typeof s?.pid === "number" && typeof s.port === "number" ? s : null;
  } catch {
    return null;
  }
}

export function writeState(s: DaemonState): void {
  ensureDaemonDir();
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
}

export function clearState(): void {
  try {
    rmSync(STATE_PATH, { force: true });
  } catch {
    /* ignore */
  }
}

export function readWatchState(): WatchState {
  try {
    return JSON.parse(readFileSync(WATCH_PATH, "utf8")) as WatchState;
  } catch {
    return {};
  }
}

export function writeWatchState(s: WatchState): void {
  try {
    ensureDaemonDir();
    writeFileSync(WATCH_PATH, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  } catch {
    /* a state-file hiccup must not stop the daemon */
  }
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Is that pid still around? Signal 0 asks without sending anything. EPERM means it exists and
 *  belongs to someone else, which for our purposes is still "alive". */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Keep the log from growing forever. Called on every start, so it is bounded per run. */
export function rollLog(maxBytes = 2 * 1024 * 1024): void {
  try {
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > maxBytes) {
      writeFileSync(LOG_PATH, `--- rolled ${new Date().toISOString()} ---\n`);
    }
  } catch {
    /* ignore */
  }
}

/** The name this profile's autostart entry and log lines use. */
export const daemonLabel = (): string =>
  ACTIVE_PROFILE === "default" ? "coen-daemon" : `coen-daemon-${ACTIVE_PROFILE}`;
