import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * Keeping the sync folder in git.
 *
 * Nothing clever. `git add -A`, a commit when something changed, and a push on a timer if there
 * is a remote. The value is not in the git — it is in the folder already being a folder of small
 * files that change one at a time, which is what the diff-writer is for. A pass that rewrote
 * everything would make this history worthless.
 *
 * Two things it refuses to do. It will not `git init` inside a repository that already exists,
 * because pointing sync at a directory in your own project and having it commit your record into
 * that project's history is not recoverable politeness. And it never force-pushes.
 */

export interface GitOutcome {
  committed: boolean;
  pushed: boolean;
  message?: string;
  error?: string;
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    encoding: "utf8",
  }).trim();
}

/** Run a git command and say whether it worked, rather than throwing. */
function tryGit(dir: string, args: string[]): { ok: true; out: string } | { ok: false; error: string } {
  try {
    return { ok: true, out: git(dir, args) };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const text = (err.stderr ? String(err.stderr) : err.message ?? "").trim();
    return { ok: false, error: text || "git failed" };
  }
}

export const gitAvailable = (): boolean => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
};

export const isRepo = (dir: string): boolean => existsSync(resolve(dir, ".git"));

/** The top of the repository this directory is inside, or null if it is inside none. */
export function repoTop(dir: string): string | null {
  const r = tryGit(dir, ["rev-parse", "--show-toplevel"]);
  return r.ok && r.out ? resolve(r.out) : null;
}

/**
 * The guard. Returns the reason to refuse, or null when it is safe to make this a repository.
 *
 * The case that matters: someone runs `coen git-sync ~/src/notes` and that path is inside a
 * project. Committing their whole emotional record into that project's history — and possibly
 * pushing it — is not something to discover afterwards.
 */
export function refuseInit(dir: string): string | null {
  const abs = resolve(dir);
  if (isRepo(abs)) return null; // already its own repo, which is fine
  const top = repoTop(abs);
  if (!top) return null;
  if (top === abs) return null;
  if (abs.startsWith(top + sep)) {
    return `${abs} is inside the git repository at ${top}.\n` +
      "  Committing your record into that repository's history is almost certainly not what you want.\n" +
      "  Point sync at a folder of its own, or run `git init` there yourself if you really mean it.";
  }
  return null;
}

export function initRepo(dir: string): void {
  // -b main where git supports it; older git ignores nothing and errors, so fall back.
  const r = tryGit(dir, ["init", "-b", "main"]);
  if (!r.ok) git(dir, ["init"]);
}

const currentBranch = (dir: string): string => {
  const r = tryGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.ok && r.out && r.out !== "HEAD" ? r.out : "main";
};

export const remoteUrl = (dir: string): string | null => {
  const r = tryGit(dir, ["remote", "get-url", "origin"]);
  return r.ok && r.out ? r.out : null;
};

export function setRemote(dir: string, url: string): void {
  if (remoteUrl(dir)) git(dir, ["remote", "set-url", "origin", url]);
  else git(dir, ["remote", "add", "origin", url]);
}

/**
 * Make sure a commit can be made at all. Git refuses to commit without an identity, and "please
 * tell me who you are" from a background daemon is a mystery, not an error message. The signed-in
 * email is the honest answer and it is set on this repository only.
 */
function ensureIdentity(dir: string, email: string | undefined): void {
  const has = (key: string) => {
    const r = tryGit(dir, ["config", "--get", key]);
    return r.ok && !!r.out;
  };
  if (!has("user.email")) git(dir, ["config", "--local", "user.email", email || "coen@localhost"]);
  if (!has("user.name")) git(dir, ["config", "--local", "user.name", "Coen"]);
}

/** Is there anything to commit? */
function dirty(dir: string): boolean {
  const r = tryGit(dir, ["status", "--porcelain"]);
  return r.ok ? r.out.length > 0 : false;
}

/**
 * The message, built from what is actually staged.
 *
 * Deliberately not from the pass's own write report. The two disagree more often than you would
 * think — the first commit stages a folder the pass did not write this time, and a file changed
 * outside a pass is still a file being committed. The commit should describe the commit.
 */
function messageFor(dir: string): string {
  const staged = tryGit(dir, ["diff", "--cached", "--name-status"]);
  if (!staged.ok || !staged.out) return "coen sync";
  const lines = staged.out.split("\n").filter(Boolean);
  const paths = lines.map((l) => l.split(/\s+/).slice(1)[0] ?? "").filter(Boolean);
  const removed = lines.filter((l) => l.startsWith("D")).length;
  const areas = [...new Set(paths.map((p) => (p.includes("/") ? p.split("/")[0]! : p)))].sort().slice(0, 4);
  const bits = [`${lines.length} file${lines.length === 1 ? "" : "s"}`];
  if (areas.length) bits.push(`(${areas.join(", ")})`);
  if (removed) bits.push(`· ${removed} removed`);
  return `coen sync: ${bits.join(" ")}`;
}

/**
 * One pass's git work: commit if anything changed, push if it is time and there is a remote.
 *
 * A push failure is reported and nothing else. The daemon must not stall on a network that isn't
 * there, and a commit that is sitting locally is not lost.
 */
export function commitAndMaybePush(opts: {
  dir: string;
  email?: string;
  push: boolean;
  /** Appended to the subject — the machine, when several push to one repository. */
  suffix?: string;
}): GitOutcome {
  const { dir, email } = opts;
  if (!isRepo(dir)) return { committed: false, pushed: false, error: "not a git repository" };

  ensureIdentity(dir, email);
  let committed = false;
  let message: string | undefined;
  if (dirty(dir)) {
    const add = tryGit(dir, ["add", "-A"]);
    if (!add.ok) return { committed: false, pushed: false, error: add.error };
    message = messageFor(dir) + (opts.suffix ? ` · ${opts.suffix}` : "");
    const c = tryGit(dir, ["commit", "-m", message]);
    if (!c.ok) return { committed: false, pushed: false, error: c.error };
    committed = true;
  }

  if (!opts.push) return { committed, pushed: false, message };
  if (!remoteUrl(dir)) return { committed, pushed: false, message, error: "no origin remote" };

  const branch = currentBranch(dir);
  const upstream = tryGit(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const p = upstream.ok
    ? tryGit(dir, ["push"])
    : tryGit(dir, ["push", "-u", "origin", branch]);
  return p.ok ? { committed, pushed: true, message } : { committed, pushed: false, message, error: p.error };
}
