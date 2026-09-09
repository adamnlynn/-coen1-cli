import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { type SyncPaths } from "./paths.js";

/**
 * What the folder remembers between passes.
 *
 * Two jobs. It records the hash of every file we wrote, which is how a pass writes only what
 * changed and how it knows a file it is about to overwrite was edited by hand. And it holds the
 * check-ins submitted from `new/` that have not come back from the server yet, so the provisional
 * copies we wrote for them are not mistaken for stale files and pruned.
 *
 * It lives in the folder, not in ~/.coen, because it describes the folder — copy the folder to
 * another machine and the next pass there picks up where this one left off.
 */

export interface PendingEntry {
  /** The provisional mirror file written for it, relative to the folder. */
  path: string;
  /** Hash of the normalised text, which is how we recognise it when the server hands it back. */
  textHash: string;
  extractionId: string;
  submittedAt: number;
  /** The file in new/ it came from. For the log, and for saying which one is stuck. */
  from: string;
}

export interface Manifest {
  version: 1;
  /** section → { relative path → content hash }. The only paths a pass will ever delete. */
  files: Record<string, Record<string, string>>;
  pending: PendingEntry[];
  lastPassAt?: number;
  /** When the whole history was last pulled, as opposed to the window. */
  lastFullAt?: number;
  lastPushAt?: number;
  /** Said once, not on every pass — see the journal section. */
  notedStorageOff?: boolean;
}

export const emptyManifest = (): Manifest => ({ version: 1, files: {}, pending: [] });

/** Short sha256. Long enough that two different files colliding is not a thing that happens. */
export const hashOf = (body: string): string =>
  createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);

/** Line endings and surrounding space are not the text. Both sides of a comparison go through
 *  this, so a file saved by an editor that adds a trailing newline still matches. */
export const normaliseText = (t: string): string => t.replace(/\r\n/g, "\n").trim();

export function readManifest(paths: SyncPaths): Manifest {
  try {
    const raw = readFileSync(paths.manifest, "utf8").trim();
    if (!raw) return emptyManifest();
    const m = JSON.parse(raw) as Manifest;
    if (m?.version !== 1 || typeof m.files !== "object") return emptyManifest();
    return { ...emptyManifest(), ...m, files: m.files ?? {}, pending: m.pending ?? [] };
  } catch {
    // A corrupt manifest is not a reason to refuse. The cost is one pass that rewrites every
    // file and prunes nothing — annoying in the git log, harmless on disk.
    return emptyManifest();
  }
}

export function writeManifest(paths: SyncPaths, m: Manifest): void {
  if (!existsSync(paths.meta)) mkdirSync(paths.meta, { recursive: true, mode: 0o700 });
  writeFileSync(paths.manifest, JSON.stringify(m, null, 2) + "\n", { mode: 0o600 });
}
