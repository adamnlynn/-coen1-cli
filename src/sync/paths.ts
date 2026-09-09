import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { dayOf, hhmmOf } from "../day.js";

/**
 * Where things go in a sync folder, and the rules about it.
 *
 * Every path a section produces is a RELATIVE path with "/" separators — that is what the
 * manifest stores, so a folder written on one machine reads the same on another. `safeJoin` is
 * the only thing that turns one into a real path, and it refuses anything that would land
 * outside the folder.
 */

/** The one writable directory. Drop a .md here and the next pass checks it in. */
export const INBOX = "new";

/** Ours: the manifest and any file we had to rescue. Hidden, and gitignored. */
export const META = ".coen-sync";

export interface SyncPaths {
  /** The folder itself, absolute. */
  root: string;
  inbox: string;
  meta: string;
  manifest: string;
  /** Where a mirror file someone edited is copied before we overwrite it. */
  edited: string;
  readme: string;
}

export function syncPaths(root: string): SyncPaths {
  const abs = resolve(root);
  return {
    root: abs,
    inbox: join(abs, INBOX),
    meta: join(abs, META),
    manifest: join(abs, META, "manifest.json"),
    edited: join(abs, META, "edited"),
    readme: join(abs, "README.md"),
  };
}

/** Expand a leading ~ and make it absolute, so `coen sync ~/journal` means what it looks like. */
export function resolveDir(input: string): string {
  let s = input.trim();
  if (s === "~") s = homedir();
  else if (s.startsWith("~/") || s.startsWith("~\\")) s = join(homedir(), s.slice(2));
  return resolve(s);
}

/**
 * A relative mirror path to a real one. Throws rather than writing outside the folder — these
 * paths are built from ids and titles that came off the network, so this is not a formality.
 */
export function safeJoin(root: string, rel: string): string {
  const base = resolve(root);
  const abs = resolve(base, rel.split("/").join(sep));
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`refusing to touch a path outside ${base}: ${rel}`);
  }
  return abs;
}

/** Is `rel` inside `new/` or `.coen-sync/`? Neither is ever written or pruned by a section. */
export const isReserved = (rel: string): boolean =>
  rel === INBOX || rel === META || rel.startsWith(`${INBOX}/`) || rel.startsWith(`${META}/`);

/** "Leave the contract" → "leave-the-contract". Empty in, "untitled" out. */
export function slug(text: string | null | undefined, max = 48): string {
  const s = (text ?? "")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return s.slice(0, max).replace(/-+$/, "") || "untitled";
}

/**
 * A key as a filename. Not `slug` — a metric key IS an identifier, and turning `sleep_hours` into
 * `sleep-hours` quietly renames the thing the file is about. Only what a filesystem objects to is
 * replaced.
 */
export function safeName(key: string, max = 80): string {
  const s = key.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, max);
  return s || "unnamed";
}

/** The first 8 hex of a uuid — enough to keep two entries on the same minute apart. */
export const shortId = (id: string): string => id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "unknown";

/** journal/2026/09/2026-09-07-1432-6f0e2a41.md — deterministic, so an entry keeps its path. */
export function journalPath(iso: string, id: string): string {
  const day = dayOf(iso);
  const [year, month] = day.split("-");
  return `journal/${year}/${month}/${day}-${hhmmOf(iso)}-${shortId(id)}.md`;
}

/** decisions/2026/2026-09-03-leave-the-contract.md */
export function datedPath(dir: string, iso: string, title: string | null, id: string): string {
  const day = dayOf(iso);
  const [year] = day.split("-");
  return `${dir}/${year}/${day}-${slug(title)}-${shortId(id)}.md`;
}

