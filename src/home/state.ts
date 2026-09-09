import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { CONFIG_DIR, ensureConfigDir } from "../config.js";

/**
 * Where Home was when you left it — so Ctrl+C is a pause, not a reset.
 *
 * Tabs are stored as the COMMAND that opened them, never as their rendered rows: those rows are
 * ANSI laid out for one terminal width and one moment's data, and restoring them would put a
 * picture of yesterday's journal on the screen. Re-running the command costs a request per tab
 * and gives you the real thing.
 *
 * Per profile by construction: CONFIG_DIR follows COEN_HOME.
 */

export const STATE_PATH = join(CONFIG_DIR, "home-state.json");

export interface SavedTab {
  key: string;
  title: string;
  /** The command that opens it, e.g. "/journal 2026-09-03". Absent for the Home tab. */
  cmd: string;
}

export interface HomeState {
  tabs: SavedTab[];
  /** Index into [Home, ...tabs]. */
  active: number;
  /** Where the active tab was scrolled: rows from the top, and whether it was following the end. */
  scroll?: { top: number; follow: boolean };
  /** An unsent check-in: the finished lines and the one still being typed. */
  draft?: string[];
  input?: string;
  savedAt: number;
}

/** Anything older than this is a different sitting; the tabs are stale and the draft is forgotten. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function loadHomeState(): HomeState | null {
  try {
    const raw = readFileSync(STATE_PATH, "utf8").trim();
    if (!raw) return null;
    const s = JSON.parse(raw) as HomeState;
    if (!Array.isArray(s.tabs) || typeof s.savedAt !== "number") return null;
    if (Date.now() - s.savedAt > MAX_AGE_MS) return null;
    return s;
  } catch {
    return null; // missing or corrupt — start fresh, never fail to open
  }
}

export function saveHomeState(state: Omit<HomeState, "savedAt">): void {
  try {
    ensureConfigDir();
    writeFileSync(STATE_PATH, JSON.stringify({ ...state, savedAt: Date.now() }, null, 2) + "\n", { mode: 0o600 });
  } catch {
    /* a state file we can't write is not worth failing an exit over */
  }
}

export function clearHomeState(): void {
  try {
    writeFileSync(STATE_PATH, "", { mode: 0o600 });
  } catch {
    /* ignore */
  }
}
