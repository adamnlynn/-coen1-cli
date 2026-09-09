import { stdout, stdin } from "node:process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { type CoenConfig, saveConfig, ACTIVE_PROFILE } from "../config.js";
import { signedIn } from "../auth.js";
import { createClient, ApiError } from "../api.js";
import { readState, pidAlive } from "../daemon/state.js";
import { resolveDir } from "./paths.js";
import {
  runPass,
  syncStatus,
  syncDir,
  syncOn,
  windowDays,
  gitOn,
  pushOn,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_PUSH_INTERVAL_MINUTES,
  type PassResult,
} from "./run.js";
import { gitAvailable, isRepo, initRepo, refuseInit, remoteUrl, setRemote, commitAndMaybePush } from "./git.js";

/**
 * `coen sync …` and `coen git-sync …`.
 *
 * Both run a pass in the foreground when you ask for one, whether or not the daemon is up — a
 * command that only ever queued work for something else would be a strange thing to type. What
 * the daemon adds is that it keeps happening.
 */

const dim = (s: string): void => void stdout.write(`\x1b[2m${s}\x1b[0m\n`);
const red = (s: string): void => void stdout.write(`\x1b[31m${s}\x1b[0m\n`);
const ok = (s: string): void => void stdout.write(`\x1b[32m${s}\x1b[0m\n`);
const plain = (s: string): void => void stdout.write(`${s}\n`);

const SYNC_USAGE =
  "coen sync — your record as markdown files on this disk\n" +
  "  coen sync <folder>   keep that folder in step with your record, starting now\n" +
  "  coen sync            run a pass now\n" +
  "  coen sync --all      pull the whole history, not just the last few months\n" +
  "  coen sync --status   where it syncs, when it last ran, what is waiting\n" +
  "  coen sync --off      stop syncing (the files stay exactly where they are)\n" +
  "\n" +
  "  Write a check-in by putting a .md file in <folder>/new — the next pass sends it,\n" +
  "  files it under journal/, and deletes the file. Everything else is read-only.\n";

const GIT_USAGE =
  "coen git-sync — keep the sync folder in git\n" +
  "  coen git-sync                 what it is doing now\n" +
  "  coen git-sync on              commit every pass that changes something\n" +
  "  coen git-sync --remote <url>  set origin and push on a timer — asks first\n" +
  "  coen git-sync push            push now\n" +
  "  coen git-sync --off           stop committing (the repository stays)\n";

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

const agentPrefix = ACTIVE_PROFILE === "default" ? "coen" : `coen agent ${ACTIVE_PROFILE}`;

/** Guard every command that talks to the record. */
function requireSignIn(cfg: CoenConfig): boolean {
  if (signedIn(cfg)) return true;
  red(cfg.auth ? "your sign-in has expired." : "not signed in.");
  dim("run `coen login` first — sync reads your record as you.");
  return false;
}

async function confirm(question: string): Promise<boolean> {
  if (!stdin.isTTY) return false;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

// ─── reporting a pass ────────────────────────────────────────────────────────

function report(r: PassResult): void {
  for (const s of r.inbox.submitted) plain(`  checked in  ${s.from}  →  ${s.path}`);
  for (const f of r.inbox.failed) red(`  couldn't check in ${f.from}: ${f.error}`);

  const w = r.write;
  const parts = [
    `${w.written.length} written`,
    `${w.unchanged} unchanged`,
    w.deleted.length ? `${w.deleted.length} removed` : null,
    // Said out loud, because otherwise a folder holding 400 files reports 290 and looks wrong.
    w.retained ? `${w.retained} older than the window, left alone` : null,
  ].filter(Boolean);
  plain(`  ${parts.join(" · ")}  in ${Math.round(r.ms / 100) / 10}s`);

  if (w.rescued.length) {
    // The one thing worth interrupting for: they edited a mirror file and we put the record back.
    ok(`  ${w.rescued.length} file(s) you had edited were kept first:`);
    for (const rel of w.rescued.slice(0, 10)) dim(`    .coen-sync/edited/${rel}`);
  }
  for (const e of r.sectionErrors) red(`  ${e.section} didn't sync: ${e.error}`);
  if (r.sectionErrors.length) dim("  those files were left as they are — nothing was deleted.");
  for (const n of r.notes) dim(`  ${n}`);
  if (r.inbox.waiting) dim(`  ${r.inbox.waiting} file(s) in new/ were still being written.`);
  if (r.git?.committed) dim(`  committed${r.git.pushed ? " and pushed" : ""}.`);
  if (r.git?.error) dim(`  git: ${r.git.error}`);
}

/** Said after a foreground pass: this only keeps happening if the daemon is up. */
function daemonNote(): void {
  const state = readState();
  if (state && pidAlive(state.pid)) {
    dim("the daemon will keep it in step from here.");
    return;
  }
  dim("nothing will keep this in step until the daemon is running:  coen daemon start");
}

// ─── coen sync ───────────────────────────────────────────────────────────────

async function pass(cfg: CoenConfig, dir: string, full: boolean): Promise<void> {
  const client = createClient(cfg);
  try {
    const r = await runPass({ client, cfg, dir, full });
    report(r);
  } catch (e) {
    red(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}

async function setUp(cfg: CoenConfig, raw: string, full: boolean): Promise<void> {
  const dir = resolveDir(raw);
  const existing = syncDir(cfg);
  if (existing && existing !== dir) {
    dim(`this profile was syncing to ${existing}. It will sync to ${dir} from now on.`);
    dim("the old folder is left exactly as it is.");
  }
  saveConfig({ ...cfg, sync: { ...cfg.sync, dir, enabled: true } });
  ok(`syncing to ${dir}`);
  await pass({ ...cfg, sync: { ...cfg.sync, dir, enabled: true } }, dir, full);
  plain("");
  plain(`  write a check-in:  $EDITOR ${dir}/new/today.md`);
  plain(`  what it is:        ${dir}/README.md`);
  daemonNote();
}

function status(cfg: CoenConfig): void {
  const s = syncStatus(cfg);
  if (!s.dir) {
    plain("sync: off");
    dim(`turn it on:  ${agentPrefix} sync ~/journal`);
    return;
  }
  plain(`folder:    ${s.dir}${s.enabled ? "" : "   (off — files left in place)"}`);
  if (!existsSync(s.dir)) red("           that folder is gone. Run the command again to rebuild it.");
  plain(`last pass: ${s.lastPassAt ? ago(s.lastPassAt) : "never"}  ·  ${s.files} files  ·  last ${windowDays(cfg)} days`);
  plain(`new/:      ${s.waiting ? `${s.waiting} waiting to be checked in` : "empty"}`);
  if (s.pending) plain(`pending:   ${s.pending} checked in, not back from the journal yet`);
  const git = s.git.repo
    ? s.git.enabled
      ? `committing${s.git.push ? ` · pushing to ${s.git.remote ?? "origin"}` : " · not pushing"}`
      : "a repository, but coen isn't committing to it"
    : `off  (${agentPrefix} git-sync on)`;
  plain(`git:       ${git}`);
  const state = readState();
  const up = !!state && pidAlive(state.pid);
  plain(`daemon:    ${up ? `running — a pass every ${cfg.sync?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES} minutes` : "not running — nothing is keeping this in step"}`);
}

function off(cfg: CoenConfig): void {
  const dir = syncDir(cfg);
  if (!dir || !syncOn(cfg)) {
    dim("sync is already off.");
    return;
  }
  saveConfig({ ...cfg, sync: { ...cfg.sync, enabled: false } });
  ok("sync is off.");
  dim(`${dir} is untouched — the files are yours.`);
}

export async function runSyncCommand(args: string[], cfg: CoenConfig): Promise<void> {
  const flags = args.filter((a) => a.startsWith("-"));
  const rest = args.filter((a) => !a.startsWith("-"));
  const has = (...names: string[]) => flags.some((f) => names.includes(f));

  if (has("--help", "-h")) return dim(SYNC_USAGE);
  if (has("--status", "-s")) return status(cfg);
  if (has("--off")) return off(cfg);

  if (!requireSignIn(cfg)) {
    process.exitCode = 1;
    return;
  }
  const full = has("--all", "-a");

  if (rest[0]) return setUp(cfg, rest[0], full);

  const dir = syncDir(cfg);
  if (!dir) {
    dim(SYNC_USAGE);
    return;
  }
  if (!syncOn(cfg)) dim(`sync is off for this profile — running one pass anyway. Turn it back on: ${agentPrefix} sync ${dir}`);
  await pass(cfg, dir, full);
  daemonNote();
}

// ─── coen git-sync ───────────────────────────────────────────────────────────

/** The folder git-sync acts on: the one named, else the sync folder. */
function targetDir(cfg: CoenConfig, named: string | undefined): string | null {
  if (named) return resolveDir(named);
  return syncDir(cfg);
}

function gitStatus(cfg: CoenConfig): void {
  const dir = syncDir(cfg);
  if (!dir) {
    plain("git-sync: nothing to commit — sync isn't set up.");
    dim(`  ${agentPrefix} sync ~/journal`);
    return;
  }
  plain(`folder:   ${dir}`);
  plain(`repo:     ${isRepo(dir) ? "yes" : `no  (${agentPrefix} git-sync on)`}`);
  plain(`commits:  ${gitOn(cfg) ? "on — every pass that changes something" : "off"}`);
  const remote = isRepo(dir) ? remoteUrl(dir) : null;
  plain(
    `push:     ${
      pushOn(cfg)
        ? `on — at most every ${cfg.sync?.git?.pushIntervalMinutes ?? DEFAULT_PUSH_INTERVAL_MINUTES} minutes`
        : "off"
    }${remote ? `  →  ${remote}` : ""}`,
  );
  if (pushOn(cfg) && !remote) red("push is on but there is no origin remote — nothing is leaving this machine.");
}

async function gitOn_(cfg: CoenConfig, named: string | undefined): Promise<CoenConfig | null> {
  const dir = targetDir(cfg, named);
  if (!dir) {
    red("there is no sync folder yet.");
    dim(`  ${agentPrefix} sync ~/journal    then    ${agentPrefix} git-sync on`);
    return null;
  }
  if (!gitAvailable()) {
    red("git isn't on PATH.");
    return null;
  }
  if (!existsSync(dir)) {
    red(`${dir} doesn't exist yet — run \`${agentPrefix} sync ${dir}\` first.`);
    return null;
  }
  const refusal = refuseInit(dir);
  if (refusal) {
    red("refusing to make that a git repository.");
    dim(refusal);
    return null;
  }
  if (!isRepo(dir)) {
    initRepo(dir);
    ok(`git repository created in ${dir}`);
  }
  const next: CoenConfig = { ...cfg, sync: { ...cfg.sync, dir, git: { ...cfg.sync?.git, enabled: true } } };
  saveConfig(next);
  ok("committing on every pass that changes something.");
  dim("nothing leaves this machine until you set a remote:  " + agentPrefix + " git-sync --remote <url>");
  return next;
}

async function setRemoteAndPush(cfg: CoenConfig, url: string, yes: boolean): Promise<void> {
  const dir = syncDir(cfg);
  if (!dir || !isRepo(dir)) {
    red(`there is no repository to push. Run \`${agentPrefix} git-sync on\` first.`);
    return;
  }
  // Pushing is the moment the record leaves this machine. Say exactly what and where, once.
  plain("");
  plain(`  This will push ${dir} to`);
  plain(`  ${url}`);
  plain("");
  dim("  That folder is your whole record in plain text: everything you have written, your reads,");
  dim("  your habits, your decisions. Whoever can read that remote can read all of it.");
  plain("");
  if (!yes && !(await confirm("  Push it there?"))) {
    dim("nothing changed.");
    return;
  }
  setRemote(dir, url);
  saveConfig({
    ...cfg,
    sync: { ...cfg.sync, git: { ...cfg.sync?.git, enabled: true, push: true, remote: url } },
  });
  ok(`origin set — pushing at most every ${cfg.sync?.git?.pushIntervalMinutes ?? DEFAULT_PUSH_INTERVAL_MINUTES} minutes.`);
  pushNow({ ...cfg, sync: { ...cfg.sync, git: { ...cfg.sync?.git, enabled: true, push: true, remote: url } } });
}

function pushNow(cfg: CoenConfig): void {
  const dir = syncDir(cfg);
  if (!dir || !isRepo(dir)) {
    red("no repository to push.");
    return;
  }
  const r = commitAndMaybePush({ dir, email: cfg.auth?.email, push: true });
  if (r.committed) ok("committed.");
  if (r.pushed) ok("pushed.");
  else if (r.error) red(`push failed: ${r.error}`);
  else dim("nothing to push.");
}

function gitOff(cfg: CoenConfig): void {
  if (!gitOn(cfg) && !pushOn(cfg)) {
    dim("git-sync is already off.");
    return;
  }
  saveConfig({ ...cfg, sync: { ...cfg.sync, git: { ...cfg.sync?.git, enabled: false, push: false } } });
  ok("git-sync is off — no more commits, no more pushes.");
  dim("the repository and its history are untouched.");
}

export async function runGitSyncCommand(args: string[], cfg: CoenConfig): Promise<void> {
  const flags = args.filter((a) => a.startsWith("-"));
  const rest = args.filter((a) => !a.startsWith("-"));
  const has = (...names: string[]) => flags.some((f) => names.includes(f));

  if (has("--help", "-h")) return dim(GIT_USAGE);
  if (has("--off")) return gitOff(cfg);

  const remoteFlag = args.indexOf("--remote");
  if (remoteFlag !== -1) {
    const url = args[remoteFlag + 1];
    if (!url || url.startsWith("-")) {
      red("usage: coen git-sync --remote <url>");
      return;
    }
    const next = (await gitOn_(cfg, undefined)) ?? cfg;
    return setRemoteAndPush(next, url, has("--yes", "-y"));
  }

  if (rest[0] === "push") return pushNow(cfg);
  if (rest[0] === "on") {
    await gitOn_(cfg, rest[1]);
    return;
  }
  if (rest[0]) {
    await gitOn_(cfg, rest[0]);
    return;
  }
  gitStatus(cfg);
}
