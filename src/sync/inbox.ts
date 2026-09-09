import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Client, submitPulse, ApiError } from "../api.js";
import { type SyncPaths, journalPath } from "./paths.js";
import { type Manifest, hashOf, normaliseText } from "./manifest.js";
import { writeTracked, ensureInboxWritable } from "./write.js";
import { frontMatter, doc, body as renderBody } from "./render.js";

/**
 * `new/` — the only part of this folder that does something.
 *
 * Write a markdown file in there and it becomes a check-in, through the same route as
 * `coen pulse` and the Home input. One file is one check-in. There is deliberately no format to
 * learn: no front matter, no header, nothing to get wrong. Whatever is in the file is what gets
 * sent, exactly as written.
 *
 * The order is the point. The mirror copy is written FIRST and the original is deleted last, so
 * there is no moment where the only copy of what someone wrote is in flight. If the check-in
 * fails, nothing is deleted at all — the file stays put with a .error beside it saying why, and
 * the next pass tries again.
 */

/** A file younger than this has its size checked twice before we touch it. Editors write in
 *  stages, and half a thought is not a check-in. */
const SETTLE_MS = 2_000;

export interface InboxResult {
  submitted: { from: string; path: string }[];
  failed: { from: string; error: string }[];
  /** Files that were still being written. They are not a problem — they are next pass's work. */
  waiting: number;
}

export const emptyInbox = (): InboxResult => ({ submitted: [], failed: [], waiting: 0 });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Has the file stopped changing? */
async function settled(abs: string): Promise<boolean> {
  try {
    const a = statSync(abs);
    if (Date.now() - a.mtimeMs >= SETTLE_MS) return true;
    await sleep(400);
    const b = statSync(abs);
    return b.size === a.size && b.mtimeMs === a.mtimeMs;
  } catch {
    return false;
  }
}

/** The .md files waiting to be checked in, oldest first so a morning's writing goes up in order. */
function candidates(inbox: string): string[] {
  let names: string[];
  try {
    names = readdirSync(inbox, { withFileTypes: true })
      .filter((d) => d.isFile() && !d.name.startsWith(".") && /\.(md|markdown|txt)$/i.test(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
  return names.sort((a, b) => {
    try {
      return statSync(join(inbox, a)).mtimeMs - statSync(join(inbox, b)).mtimeMs;
    } catch {
      return 0;
    }
  });
}

function noteError(inbox: string, name: string, message: string): void {
  try {
    writeFileSync(
      join(inbox, `${name}.error`),
      `${new Date().toISOString()}\n\n${message}\n\n` +
        "The file above is untouched. Coen will try again on the next pass.\n",
    );
  } catch {
    /* if we can't even write the note, the file is still there, which is the part that matters */
  }
}

const dropError = (inbox: string, name: string): void => {
  try {
    const p = join(inbox, `${name}.error`);
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* ignore */
  }
};

export async function processInbox(opts: {
  client: Client;
  paths: SyncPaths;
  manifest: Manifest;
}): Promise<InboxResult> {
  const { client, paths, manifest } = opts;
  const result = emptyInbox();
  if (!existsSync(paths.inbox)) return result;
  ensureInboxWritable(paths);

  for (const name of candidates(paths.inbox)) {
    const abs = join(paths.inbox, name);
    if (!(await settled(abs))) {
      result.waiting++;
      continue;
    }

    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch (e) {
      result.failed.push({ from: name, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!normaliseText(text)) {
      const why = "there is nothing in this file — a check-in needs some words.";
      noteError(paths.inbox, name, why);
      result.failed.push({ from: name, error: why });
      continue;
    }

    let extractionId: string;
    try {
      extractionId = (await submitPulse(client, text)).extractionId;
    } catch (e) {
      const why = e instanceof ApiError || e instanceof Error ? e.message : String(e);
      noteError(paths.inbox, name, why);
      result.failed.push({ from: name, error: why });
      continue;
    }

    // Accepted. Write our copy before removing theirs.
    const submittedAt = new Date().toISOString();
    const path = journalPath(submittedAt, extractionId);
    writeTracked(paths, manifest, "journal", {
      path,
      body: doc(
        frontMatter({
          submitted: submittedAt,
          extraction_id: extractionId,
          source: "cli-sync",
          from: name,
          // Not in the journal on the server yet. The next pass swaps this for the real entry,
          // with its id and its read — unless journal storage is off, in which case this stays,
          // and it is the only copy there is.
          stored: "not yet",
        }),
        renderBody(text),
      ),
    });
    manifest.pending.push({
      path,
      textHash: hashOf(normaliseText(text)),
      extractionId,
      submittedAt: Date.now(),
      from: name,
    });

    try {
      unlinkSync(abs);
    } catch {
      // The check-in went through and the copy is written; a file we couldn't delete would be
      // sent twice, so say so rather than leaving it to happen quietly.
      noteError(paths.inbox, name, "this was checked in, but the file couldn't be deleted — remove it by hand, or it will be checked in again.");
    }
    dropError(paths.inbox, name);
    result.submitted.push({ from: name, path });
  }

  return result;
}

/** How many files are sitting in new/ right now. For `coen sync --status` and the daemon health. */
export function inboxCount(paths: SyncPaths): number {
  return candidates(paths.inbox).length;
}
