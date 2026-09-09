import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { createClient } from "../api.js";
import { loadConfig, webUrl, ACTIVE_PROFILE, type CoenConfig } from "../config.js";
import { signedIn, currentToken } from "../auth.js";
import { TOOL_NAMES } from "../coen-tools/registry.js";
import { autostart } from "./autostart.js";
import { startHttpServer, type HealthReport } from "./serve-http.js";
import { pollRead, pollNudge, READ_POLL_MS, NUDGE_TICK_MS } from "./watch.js";
import { sendHeartbeat, HEARTBEAT_MS } from "./heartbeat.js";
import { runPass, runInbox, syncOn, syncDir, syncStatus, intervalMs } from "../sync/run.js";
import {
  DEFAULT_PORT,
  LOG_PATH,
  clearState,
  ensureDaemonDir,
  newToken,
  pidAlive,
  readState,
  rollLog,
  writeState,
} from "./state.js";
import { VERSION } from "../version.js";

/**
 * The daemon, in the foreground. `coen daemon start` spawns this detached and the login entry
 * runs this directly, so everything it does is here and nothing is hidden in the launcher.
 *
 * What it does, in order of why it exists:
 *
 *   1. Serves Coen's tools on a loopback port, so any agent on this machine can reach the record
 *      without its own key and without the public MCP server.
 *   2. Keeps the sign-in alive. The token is a seven-day JWT that refreshes when it is within two
 *      days of expiry — but only when something asks for it. A daemon that sat idle for a week
 *      would wake up signed out and take every attached agent down with it.
 *   3. Watches for a check-in's read landing, and runs the same hook Home runs.
 *   4. Nudges at a set time, if one is configured.
 *   5. Tells the web app it is here, so the dashboard can show this machine.
 */

/** How often to ask for the token. Well inside the two-day refresh window, and cheap. */
const TOKEN_TICK_MS = 6 * 60 * 60 * 1000;

/**
 * How often to look in the sync folder's `new/`.
 *
 * One readdir of one directory. A file watcher would look tidier and behave worse — fs.watch
 * reports different things on every platform and reports nothing at all on some network mounts —
 * and ten seconds is the difference between saving a file and it being checked in.
 */
const SYNC_INBOX_MS = 10_000;

/** How often to ASK whether a mirror pass is due. The interval itself is the config's. */
const SYNC_TICK_MS = 60_000;

/**
 * One line in the log.
 *
 * The file is the only place this is written. `coen daemon start` points the child's stdout at
 * the same file, so echoing there too would double every line; systemd sends stdout to the
 * journal and the Windows shim throws it away, so the file cannot be left to the redirection
 * either. The exception is a person watching `coen daemon run` in their own terminal, who should
 * see it as it happens.
 */
export function log(line: string): void {
  const text = `${new Date().toISOString()} ${line}\n`;
  try {
    ensureDaemonDir();
    appendFileSync(LOG_PATH, text);
  } catch {
    /* a log that cannot be written must not stop the daemon */
  }
  if (process.stdout.isTTY) process.stdout.write(text);
}

/** Where the loopback endpoint should listen: env, then config, then 7717 for the default
 *  profile. A named profile takes whatever is free, so two profiles can't collide. */
function wantedPort(cfg: CoenConfig): number {
  const env = Number(process.env.COEN_DAEMON_PORT);
  if (Number.isInteger(env) && env >= 0) return env;
  if (Number.isInteger(cfg.daemon?.port)) return cfg.daemon!.port!;
  return ACTIVE_PROFILE === "default" ? DEFAULT_PORT : 0;
}

export async function runDaemon(): Promise<void> {
  // One per profile. A live pid in the state file means one is already up; a dead one is a
  // leftover from a crash or a kill -9 and is cleared out of the way.
  const existing = readState();
  if (existing && existing.pid !== process.pid && pidAlive(existing.pid)) {
    process.stderr.write(
      `a coen daemon is already running for "${ACTIVE_PROFILE}" (pid ${existing.pid}, port ${existing.port}).\n` +
        "  coen daemon status   ·   coen daemon restart\n",
    );
    process.exit(1);
  }
  if (existing) clearState();

  rollLog();
  let cfg = loadConfig();
  if (!signedIn(cfg)) {
    log(cfg.auth ? "sign-in has expired — run `coen login`. Not starting." : "not signed in — run `coen login`. Not starting.");
    process.exit(1);
  }

  // The client writes a refreshed token back into the config; keep our copy current so the
  // health report and the heartbeat don't describe a token we no longer hold.
  const client = createClient(cfg, (auth) => {
    cfg = { ...cfg, auth };
  });

  const token = newToken();
  const startedAt = Date.now();
  let lastError: string | null = null;
  let stopping = false;
  let autostartEnabled = false;
  try {
    autostartEnabled = autostart().isEnabled();
  } catch {
    /* reporting only — a daemon still runs where we can't read the login entry */
  }

  /**
   * The sync settings as they are on disk right now, not as they were when the daemon started.
   *
   * `coen sync ~/journal` in another terminal has to take effect without a restart — the whole
   * point of that command is that something keeps it going afterwards. Everything else on the
   * daemon's config is deliberately the copy it started with.
   */
  const syncCfg = (): CoenConfig => ({ ...cfg, sync: loadConfig().sync });

  const wanted = wantedPort(cfg);
  const health = (): HealthReport => ({
    ok: true,
    pid: process.pid,
    version: VERSION,
    profile: ACTIVE_PROFILE,
    startedAt,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    port: http?.port ?? wanted,
    signedInAs: cfg.auth?.email ?? null,
    record: webUrl(cfg),
    tools: TOOL_NAMES.length,
    mcpServers: Object.keys(cfg.mcpServers ?? {}),
    autostart: autostartEnabled,
    sync: syncStatus(syncCfg()),
    lastError,
  });

  const listen = (port: number) =>
    startHttpServer({ client, cfg, token, port, health, onShutdown: () => void stop("asked to") });

  let http: Awaited<ReturnType<typeof listen>> | undefined;
  const server = await listen(wanted).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EADDRINUSE" || wanted === 0) throw e;
    // Something else has 7717. Take a free port rather than refusing to start — `coen daemon
    // status` and `coen mcp url` both read the real port back out of daemon.json.
    log(`port ${wanted} is taken — taking a free one instead. Set daemon.port to pin it.`);
    return listen(0);
  });
  http = server;

  writeState({
    pid: process.pid,
    port: server.port,
    token,
    startedAt,
    version: VERSION,
    node: process.version,
    profile: ACTIVE_PROFILE,
  });

  log(
    `daemon up — ${cfg.auth!.email} · ${TOOL_NAMES.length} tools on http://127.0.0.1:${server.port}/mcp · ` +
      `record ${webUrl(cfg)} · machine ${hostname()}`,
  );

  // ── the loops ──────────────────────────────────────────────────────────────
  const deps = { client, cfg, log };
  const every = (ms: number, name: string, fn: () => Promise<void>) => {
    const tick = () => {
      void fn().catch((e) => {
        lastError = `${name}: ${e instanceof Error ? e.message : String(e)}`;
        log(lastError);
      });
    };
    const t = setInterval(tick, ms);
    t.unref?.();
    tick();
    return t;
  };

  // One pass at a time. The inbox loop and the mirror loop both write the same manifest, and the
  // mirror loop runs the inbox itself.
  //
  // Both tick the moment they are created, so the ORDER below matters: the mirror goes first and
  // takes the lock, and the inbox tick that follows finds it held and does nothing — which is
  // right, because the pass it is waiting behind is already reading new/. Put the inbox first and
  // the folder does not get its first mirror pass for a whole minute.
  let syncBusy = false;
  const withSync = async (fn: (c: CoenConfig) => Promise<void>): Promise<void> => {
    const c = syncCfg();
    if (!syncOn(c) || syncBusy) return;
    syncBusy = true;
    try {
      await fn(c);
    } finally {
      syncBusy = false;
    }
  };

  const timers = [
    every(READ_POLL_MS, "read watch", () => pollRead({ ...deps, cfg })),
    every(SYNC_TICK_MS, "sync", () =>
      withSync(async (c) => {
        // Due by the clock, or never run at all. Asking every minute rather than setting an
        // interval means a machine that was asleep for six hours syncs when it wakes, and a
        // changed interval takes effect without a restart.
        const last = syncStatus(c).lastPassAt;
        if (last && Date.now() - last < intervalMs(c)) return;
        await runPass({ client, cfg: c, dir: syncDir(c)!, log });
      }),
    ),
    every(SYNC_INBOX_MS, "sync inbox", () =>
      withSync(async (c) => {
        await runInbox({ client, dir: syncDir(c)!, log });
      }),
    ),
    every(NUDGE_TICK_MS, "nudge", () => pollNudge({ ...deps, cfg })),
    every(HEARTBEAT_MS, "heartbeat", async () => {
      // Best effort by design: the dashboard being five minutes out of date is not worth a log
      // line every time the wifi drops, and it is not why the daemon exists.
      const err = await sendHeartbeat(client, cfg, { port: server.port, running: true });
      if (err) lastError = `heartbeat: ${err}`;
      else if (lastError?.startsWith("heartbeat:")) lastError = null;
    }),
    every(TOKEN_TICK_MS, "sign-in", async () => {
      const t = await currentToken(cfg, (auth) => {
        cfg = { ...cfg, auth };
      });
      if (!t) {
        log("the sign-in has expired — run `coen login`. Tools will fail until then.");
        lastError = "signed out";
      } else {
        lastError = lastError === "signed out" ? null : lastError;
      }
    }),
  ];

  // ── shutdown ───────────────────────────────────────────────────────────────
  async function stop(why: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    log(`stopping (${why})`);
    for (const t of timers) clearInterval(t);
    // One last heartbeat, so the dashboard says "offline" now rather than in fifteen minutes.
    // Two seconds, then give up — a stop must not hang on a network that isn't there.
    await Promise.race([
      sendHeartbeat(client, cfg, { port: null, running: false }),
      new Promise((r) => setTimeout(r, 2_000)),
    ]).catch(() => {});
    await server.close().catch(() => {});
    clearState();
    process.exit(0);
  }

  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGHUP", () => void stop("SIGHUP"));
  // A crash must not leave a state file claiming a live daemon.
  process.on("uncaughtException", (e) => {
    log(`uncaught: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    void stop("uncaught exception");
  });

  // Hold the process open. Every timer is unref'd so this is the only thing keeping it alive,
  // which means `stop` really does end it.
  await new Promise<void>(() => {});
}
