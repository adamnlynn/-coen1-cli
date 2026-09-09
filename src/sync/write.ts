import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type SyncPaths, safeJoin, isReserved } from "./paths.js";
import { type Manifest, hashOf } from "./manifest.js";

/**
 * Putting a section's files on disk.
 *
 * Three rules, and they are the whole reason this is its own file.
 *
 * **Write only what changed.** Every body is hashed against what the manifest says we last wrote.
 * A pass that rewrote all six hundred files every fifteen minutes would make the git history
 * useless and the folder's timestamps a lie.
 *
 * **Read-only, because it is a copy.** Mirror files are 0444. The record is the record; a mirror
 * you can edit is a mirror that disagrees with it and never says so. `new/` is the exception, and
 * it is the only one.
 *
 * **Never lose someone's writing.** If a file's content is not what we recorded writing, someone
 * made it writable and changed it. It is copied into .coen-sync/edited/ before it is overwritten.
 * A background process that silently eats what you wrote is not something you can trust with a
 * journal.
 *
 * And one rule about deleting: the only paths a pass will ever delete are paths the manifest says
 * this section wrote. Anything else in the folder is somebody else's and is left alone.
 */

export interface MirrorFile {
  /** Relative to the folder, "/" separators. */
  path: string;
  body: string;
}

export interface WriteReport {
  written: string[];
  deleted: string[];
  rescued: string[];
  unchanged: number;
  /** Files outside this pass's window: not fetched, not compared, not deleted. */
  retained: number;
}

export const emptyReport = (): WriteReport => ({ written: [], deleted: [], rescued: [], unchanged: 0, retained: 0 });

export function mergeReports(a: WriteReport, b: WriteReport): WriteReport {
  return {
    written: [...a.written, ...b.written],
    deleted: [...a.deleted, ...b.deleted],
    rescued: [...a.rescued, ...b.rescued],
    unchanged: a.unchanged + b.unchanged,
    retained: a.retained + b.retained,
  };
}

const MIRROR_MODE = 0o444;
const WRITABLE_MODE = 0o644;

/** chmod that shrugs — a folder on a filesystem with no permission bits still syncs. */
function tryChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    /* FAT, a network mount, Windows being Windows */
  }
}

/** Is this file currently writable by us? Used to avoid a chmod on every file on every pass. */
function isWritable(path: string): boolean {
  try {
    return (statSync(path).mode & 0o200) !== 0;
  } catch {
    return false;
  }
}

/** Keep what someone wrote by hand before we overwrite it. */
function rescue(paths: SyncPaths, rel: string): string {
  const from = safeJoin(paths.root, rel);
  let dest = join(paths.edited, ...rel.split("/"));
  if (existsSync(dest)) dest = `${dest}.${Date.now()}`;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(from, dest);
  tryChmod(dest, WRITABLE_MODE);
  return rel;
}

/** Delete a mirror file. It is read-only, so it has to be made writable first. */
function removeFile(abs: string): void {
  try {
    tryChmod(abs, WRITABLE_MODE);
    unlinkSync(abs);
  } catch {
    /* already gone */
  }
}

/**
 * Tidy up directories a prune emptied. Stops at the folder root and never touches `new/` or
 * `.coen-sync/`, which exist whether or not anything is in them.
 */
function pruneEmptyDirs(paths: SyncPaths, rels: string[]): void {
  const seen = new Set<string>();
  for (const rel of rels) {
    let dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    while (dir && !seen.has(dir) && !isReserved(dir)) {
      seen.add(dir);
      const abs = safeJoin(paths.root, dir);
      try {
        if (readdirSync(abs).length === 0) rmdirSync(abs);
        else break;
      } catch {
        break;
      }
      dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    }
  }
}

/**
 * Write one section's files, prune what it no longer produces, and record it all in the manifest.
 *
 * Only call this with a section that fetched successfully. A section whose network call failed
 * produced an empty list, and an empty list means "delete everything you wrote last time".
 */
export function applySection(
  paths: SyncPaths,
  manifest: Manifest,
  section: string,
  files: MirrorFile[],
  /** Paths the section could not speak about this pass — carried through, never deleted. */
  retain?: (rel: string) => boolean,
): WriteReport {
  const report = emptyReport();
  const prev = manifest.files[section] ?? {};
  const next: Record<string, string> = {};

  for (const file of files) {
    const rel = file.path;
    if (isReserved(rel)) throw new Error(`section "${section}" tried to write into a reserved path: ${rel}`);
    const abs = safeJoin(paths.root, rel);
    const newHash = hashOf(file.body);

    if (existsSync(abs)) {
      let diskHash: string | null = null;
      try {
        diskHash = hashOf(readFileSync(abs, "utf8"));
      } catch {
        diskHash = null; // unreadable — treat it as absent and overwrite
      }
      if (diskHash === newHash) {
        next[rel] = newHash;
        report.unchanged++;
        if (isWritable(abs)) tryChmod(abs, MIRROR_MODE); // e.g. straight out of a git clone
        continue;
      }
      // The content differs from what we are about to write. If it also differs from what we
      // recorded writing, it is not ours to throw away.
      if (diskHash !== null && prev[rel] !== diskHash) report.rescued.push(rescue(paths, rel));
      tryChmod(abs, WRITABLE_MODE);
    } else {
      mkdirSync(dirname(abs), { recursive: true });
    }

    writeFileSync(abs, file.body);
    tryChmod(abs, MIRROR_MODE);
    next[rel] = newHash;
    report.written.push(rel);
  }

  for (const rel of Object.keys(prev)) {
    if (rel in next || isReserved(rel)) continue;
    // Outside the window: this pass never asked about it, so it has no standing to delete it.
    if (retain?.(rel)) {
      next[rel] = prev[rel]!;
      report.retained++;
      continue;
    }
    const abs = safeJoin(paths.root, rel);
    if (existsSync(abs)) removeFile(abs);
    report.deleted.push(rel);
  }

  manifest.files[section] = next;
  if (report.deleted.length) pruneEmptyDirs(paths, report.deleted);
  return report;
}

/**
 * Write one file and record it, without pruning anything.
 *
 * The inbox needs this: it writes a provisional journal file the moment a check-in is accepted,
 * long before the section that owns `journal/` next runs. Recording the hash here is what makes
 * that section see the file as already current rather than something to rewrite.
 */
export function writeTracked(paths: SyncPaths, manifest: Manifest, section: string, file: MirrorFile): void {
  const abs = safeJoin(paths.root, file.path);
  mkdirSync(dirname(abs), { recursive: true });
  if (existsSync(abs)) tryChmod(abs, WRITABLE_MODE);
  writeFileSync(abs, file.body);
  tryChmod(abs, MIRROR_MODE);
  manifest.files[section] = { ...(manifest.files[section] ?? {}), [file.path]: hashOf(file.body) };
}

/**
 * The folder itself: the root, the inbox, and our own directory. The two files that describe the
 * folder to a person are written once and never again — they are the person's to edit, and a
 * README that reappears every fifteen minutes is a README nobody trusts.
 */
export function ensureFolder(paths: SyncPaths, readme: string): void {
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.inbox, { recursive: true });
  mkdirSync(paths.meta, { recursive: true, mode: 0o700 });
  if (!existsSync(paths.readme)) writeFileSync(paths.readme, readme);

  const gitignore = join(paths.root, ".gitignore");
  if (!existsSync(gitignore)) {
    writeFileSync(
      gitignore,
      "# Coen's own state for this folder: hashes, and anything it had to rescue.\n" +
        "# It describes this machine's copy, so it does not belong in the history.\n" +
        ".coen-sync/\n",
    );
  }
  // A stray .gitkeep so an empty new/ survives a clone — the one directory that has to be there.
  const keep = join(paths.inbox, ".gitkeep");
  if (!existsSync(keep)) writeFileSync(keep, "");
}

/** The inbox must stay writable whatever else happens. */
export function ensureInboxWritable(paths: SyncPaths): void {
  try {
    if (!isWritable(paths.inbox)) tryChmod(paths.inbox, 0o755);
  } catch {
    /* ignore */
  }
}
