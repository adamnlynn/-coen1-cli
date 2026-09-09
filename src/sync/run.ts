import { hostname } from "node:os";
import { type Client } from "../api.js";
import * as api from "../api.js";
import { type CoenConfig, ACTIVE_PROFILE, webUrl } from "../config.js";
import { dayOf } from "../day.js";
import { makeContext } from "../coen-tools/context.js";
import { type SyncPaths, syncPaths, resolveDir } from "./paths.js";
import { readManifest, writeManifest, type Manifest } from "./manifest.js";
import { applySection, ensureFolder, emptyReport, mergeReports, type WriteReport } from "./write.js";
import { processInbox, inboxCount, type InboxResult, emptyInbox } from "./inbox.js";
import { SECTIONS, type SyncContext } from "./sections.js";
import { folderReadme } from "./readme.js";
import { commitAndMaybePush, isRepo, type GitOutcome } from "./git.js";

/**
 * One pass: the inbox, then the mirror, then git. In that order, and the order matters.
 *
 * The inbox goes first because it is the only step that can lose something. Anything waiting in
 * `new/` is checked in and copied into the mirror before the mirror is rebuilt, so the rebuild
 * sees it and the same pass that accepts a check-in is the pass that files it.
 *
 * A section that fails to fetch does not touch its files. An empty list from a section means "the
 * record no longer has any of these"; an empty list because the wifi dropped means nothing at all,
 * and the difference between those two is the difference between a mirror and a shredder.
 */

/** How far back a pass looks when nobody says otherwise. */
export const DEFAULT_WINDOW_DAYS = 90;
/** How often the daemon runs one. */
export const DEFAULT_INTERVAL_MINUTES = 15;
export const DEFAULT_PUSH_INTERVAL_MINUTES = 15;

/** One request's worth of metric events. Hitting this exactly means there are probably more. */
const EVENT_LIMIT = 50_000;

export interface PassResult {
  dir: string;
  full: boolean;
  inbox: InboxResult;
  write: WriteReport;
  sectionErrors: { section: string; error: string }[];
  notes: string[];
  git: GitOutcome | null;
  ms: number;
}

// ─── config accessors ────────────────────────────────────────────────────────

export const syncDir = (cfg: CoenConfig): string | null => cfg.sync?.dir ?? null;
export const syncOn = (cfg: CoenConfig): boolean => !!cfg.sync?.enabled && !!cfg.sync?.dir;
export const windowDays = (cfg: CoenConfig): number => cfg.sync?.windowDays ?? DEFAULT_WINDOW_DAYS;
export const intervalMs = (cfg: CoenConfig): number =>
  Math.max(1, cfg.sync?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES) * 60_000;
export const gitOn = (cfg: CoenConfig): boolean => !!cfg.sync?.git?.enabled;
export const pushOn = (cfg: CoenConfig): boolean => !!cfg.sync?.git?.push;
export const pushIntervalMs = (cfg: CoenConfig): number =>
  Math.max(1, cfg.sync?.git?.pushIntervalMinutes ?? DEFAULT_PUSH_INTERVAL_MINUTES) * 60_000;

/**
 * The day the window starts, always the 1st of a month.
 *
 * Rounding down to a month is not tidiness. Several files in the mirror cover a whole month —
 * `reads/2026-06.md`, `habits/2026-06.md` — and rebuilding one of those from a window that starts
 * on the 9th would silently drop the first eight days out of the file.
 */
export function windowStart(days: number): string {
  const day = dayOf(new Date(Date.now() - days * 86_400_000).toISOString());
  return `${day.slice(0, 7)}-01`;
}

// ─── the pass ────────────────────────────────────────────────────────────────

/** Memoise a fetch, and don't cache a rejection — the next pass deserves a fresh try. */
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => {
    if (!p) {
      p = fn();
      p.catch(() => {
        p = null;
      });
    }
    return p;
  };
}

export async function runPass(opts: {
  client: Client;
  cfg: CoenConfig;
  dir: string;
  /** Ignore the window and pull the whole history, once. */
  full?: boolean;
  log?: (line: string) => void;
}): Promise<PassResult> {
  const started = Date.now();
  const paths = syncPaths(resolveDir(opts.dir));
  const full = !!opts.full;
  const notes: string[] = [];

  ensureFolder(paths, folderReadme({ record: webUrl(opts.cfg), profile: ACTIVE_PROFILE }));
  const manifest = readManifest(paths);

  // The inbox first, and its result written down straight away: a crash in the middle of the
  // mirror must not lose the fact that a check-in was accepted.
  let inbox: InboxResult;
  try {
    inbox = await processInbox({ client: opts.client, paths, manifest });
  } catch (e) {
    inbox = emptyInbox();
    notes.push(`the inbox couldn't be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (inbox.submitted.length) writeManifest(paths, manifest);

  const sinceDay = full ? null : windowStart(windowDays(opts.cfg));
  const ctx = makeContext(opts.client, opts.cfg);
  const sc: SyncContext = {
    ctx,
    paths,
    manifest,
    sinceDay,
    notes,
    habits: once(() => api.getHabits(opts.client)),
    metrics: once(() => api.listMetrics(opts.client)),
    events: once(async () => {
      const events = await api.listMetricEvents(opts.client, {
        ...(sinceDay ? { start_date: sinceDay } : {}),
        limit: EVENT_LIMIT,
      });
      if (events.length >= EVENT_LIMIT) {
        notes.push(`that is ${EVENT_LIMIT} readings in one window — anything older may be missing.`);
      }
      return events;
    }),
  };

  let write = emptyReport();
  const sectionErrors: PassResult["sectionErrors"] = [];
  for (const section of SECTIONS) {
    try {
      const files = await section.build(sc);
      write = mergeReports(write, applySection(paths, manifest, section.name, files, section.retain?.(sc)));
    } catch (e) {
      // Leave this section's files exactly as they are. We did not learn anything about them.
      sectionErrors.push({ section: section.name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  manifest.lastPassAt = Date.now();
  if (full && !sectionErrors.length) manifest.lastFullAt = Date.now();

  // ── git ────────────────────────────────────────────────────────────────────
  let git: GitOutcome | null = null;
  if (gitOn(opts.cfg) && isRepo(paths.root)) {
    const due = !manifest.lastPushAt || Date.now() - manifest.lastPushAt >= pushIntervalMs(opts.cfg);
    const wantPush = pushOn(opts.cfg) && due;
    git = commitAndMaybePush({
      dir: paths.root,
      email: opts.cfg.auth?.email,
      push: wantPush,
      suffix: hostname(),
    });
    if (git.pushed) manifest.lastPushAt = Date.now();
    if (git.error && opts.log) opts.log(`sync git: ${git.error}`);
  }

  writeManifest(paths, manifest);

  const result: PassResult = {
    dir: paths.root,
    full,
    inbox,
    write,
    sectionErrors,
    notes,
    git,
    ms: Date.now() - started,
  };
  opts.log?.(summarise(result));
  return result;
}

/** One line for the daemon log. Says nothing when there was nothing to say. */
export function summarise(r: PassResult): string {
  const bits: string[] = [];
  if (r.inbox.submitted.length) bits.push(`${r.inbox.submitted.length} checked in`);
  if (r.write.written.length) bits.push(`${r.write.written.length} written`);
  if (r.write.deleted.length) bits.push(`${r.write.deleted.length} removed`);
  if (r.write.rescued.length) bits.push(`${r.write.rescued.length} rescued`);
  if (r.inbox.failed.length) bits.push(`${r.inbox.failed.length} failed`);
  if (r.sectionErrors.length) bits.push(`${r.sectionErrors.length} section(s) errored`);
  if (r.git?.committed) bits.push("committed");
  if (r.git?.pushed) bits.push("pushed");
  return `sync: ${bits.length ? bits.join(" · ") : "nothing changed"} (${Math.round(r.ms / 100) / 10}s)`;
}

/** Just the inbox, for the daemon's fast loop. */
export async function runInbox(opts: {
  client: Client;
  dir: string;
  log?: (line: string) => void;
}): Promise<InboxResult> {
  const paths = syncPaths(resolveDir(opts.dir));
  const manifest = readManifest(paths);
  const result = await processInbox({ client: opts.client, paths, manifest });
  if (result.submitted.length || result.failed.length) {
    writeManifest(paths, manifest);
    opts.log?.(
      `sync inbox: ${result.submitted.length} checked in` +
        (result.failed.length ? ` · ${result.failed.length} failed` : ""),
    );
  }
  return result;
}

/** What `coen daemon status` and `coen sync --status` both read. */
export interface SyncStatus {
  dir: string | null;
  enabled: boolean;
  lastPassAt: number | null;
  /** How many files the mirror is keeping track of. */
  files: number;
  pending: number;
  waiting: number;
  git: { repo: boolean; enabled: boolean; push: boolean; remote?: string };
}

export function syncStatus(cfg: CoenConfig): SyncStatus {
  const dir = syncDir(cfg);
  const base: SyncStatus = {
    dir,
    enabled: syncOn(cfg),
    lastPassAt: null,
    files: 0,
    pending: 0,
    waiting: 0,
    git: { repo: false, enabled: gitOn(cfg), push: pushOn(cfg), ...(cfg.sync?.git?.remote ? { remote: cfg.sync.git.remote } : {}) },
  };
  if (!dir) return base;
  const paths: SyncPaths = syncPaths(dir);
  const m: Manifest = readManifest(paths);
  return {
    ...base,
    lastPassAt: m.lastPassAt ?? null,
    files: Object.values(m.files).reduce((n, sec) => n + Object.keys(sec).length, 0),
    pending: m.pending.length,
    waiting: inboxCount(paths),
    git: { ...base.git, repo: isRepo(paths.root) },
  };
}
