import { stdout } from "node:process";
import { createInterface } from "node:readline";
import { SESSIONS_DIR, ARCHIVED_SESSIONS_DIR, archiveSession, listSessions, loadSession } from "./sessions.js";

/**
 * `coen sessions …` on the plain console.
 *
 * Sessions used to have two homes: the whole transcript here, and a summary in the dashboard,
 * where a delete button was the only way to clear one out. The dashboard copy is gone, so the
 * tidying has to live where the sessions do.
 *
 * Nothing here deletes. `prune` and `rm` move a session into ~/.coen/sessions/archive, which is
 * what `coen agent <name> --archive` does with a profile: it drops out of the switcher, out of
 * /sessions and out of resume-on-launch, and comes back if you move the file out again.
 */

const dim = (s: string) => stdout.write(`\x1b[2m${s}\x1b[0m\n`);
const red = (s: string) => stdout.write(`\x1b[31m${s}\x1b[0m\n`);
const ok = (s: string) => stdout.write(`\x1b[32m${s}\x1b[0m\n`);
const plain = (s: string) => stdout.write(`${s}\n`);

const USAGE =
  "coen sessions — your chat sessions, which live on this machine\n" +
  "  coen sessions                    open the switcher (needs a terminal)\n" +
  "  coen sessions list               every session, newest first\n" +
  "  coen sessions show <id>          one session's summary\n" +
  "  coen sessions prune [--days N]   archive anything untouched for N days (default 90)\n" +
  "  coen sessions rm <id>            archive one\n" +
  `\n  they are files: ${SESSIONS_DIR}\n  archived ones move to ${ARCHIVED_SESSIONS_DIR} and can be moved back\n`;

const ago = (ms: number): string => {
  const d = Math.floor((Date.now() - ms) / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  return `${d}d ago`;
};

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    }),
  );
}

/** Returns true when the command was handled here; false means "open the switcher". */
export async function runSessionsCommand(args: string[]): Promise<boolean> {
  const sub = args[0];
  if (!sub) return false;

  if (sub === "list") {
    const list = listSessions();
    if (!list.length) {
      dim("no sessions yet.");
      return true;
    }
    for (const s of list) {
      const cost = s.costUsd != null ? ` · $${s.costUsd.toFixed(2)}` : "";
      plain(`${s.id}  ${ago(s.updatedAt).padEnd(10)} ${String(s.messageCount).padStart(4)} msgs${cost}  ${s.title}`);
    }
    return true;
  }

  if (sub === "show") {
    const s = args[1] ? loadSession(args[1]) : null;
    if (!s) {
      red(`no session "${args[1] ?? ""}". \`coen sessions list\` shows the ids.`);
      return true;
    }
    plain(`${s.title || "untitled"}  (${s.messages.length} messages, ${ago(s.updatedAt)})`);
    plain(s.summary ? `\n${s.summary}` : "\nno summary yet — /summarize in the chat writes one.");
    return true;
  }

  if (sub === "rm" || sub === "archive") {
    const id = args[1];
    if (!id) {
      red("usage: coen sessions rm <id>");
      return true;
    }
    if (!loadSession(id)) {
      red(`no session "${id}".`);
      return true;
    }
    ok(archiveSession(id) ? `archived ${id} → ${ARCHIVED_SESSIONS_DIR}` : `couldn't archive ${id}`);
    return true;
  }

  if (sub === "prune") {
    const i = args.indexOf("--days");
    const days = i >= 0 ? Math.max(1, parseInt(args[i + 1] ?? "", 10) || 90) : 90;
    const cutoff = Date.now() - days * 86_400_000;
    const stale = listSessions().filter((s) => s.updatedAt < cutoff);
    if (!stale.length) {
      dim(`nothing untouched for ${days} days.`);
      return true;
    }
    for (const s of stale) plain(`  ${s.id}  ${ago(s.updatedAt).padEnd(10)} ${s.title}`);
    const forced = args.some((a) => a === "--yes" || a === "-y");
    if (!forced) {
      if (!process.stdin.isTTY) {
        red("re-run with --yes to archive these.");
        return true;
      }
      if (!(await confirm(`Archive ${stale.length} session${stale.length === 1 ? "" : "s"}? [y/N] `))) {
        plain("aborted.");
        return true;
      }
    }
    let n = 0;
    for (const s of stale) if (archiveSession(s.id)) n++;
    ok(`archived ${n} → ${ARCHIVED_SESSIONS_DIR}`);
    return true;
  }

  dim(USAGE);
  return true;
}
