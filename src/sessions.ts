import { join } from "node:path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  renameSync,
} from "node:fs";
import type { ModelMessage } from "ai";
import { CONFIG_DIR } from "./config.js";

export const SESSIONS_DIR = join(CONFIG_DIR, "sessions");
// Archived sessions live in a subdir; listSessions()'s *.json filter excludes the folder,
// so archived sessions drop out of /switch, /sessions, latestSession() and resume-on-launch.
export const ARCHIVED_SESSIONS_DIR = join(SESSIONS_DIR, "archive");

export interface Session {
  id: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  messages: ModelMessage[];
  /** Last stored summary (coen-cli /summarize, /compact, /exit); also synced to Coen 1. */
  summary?: string;
  /** How many user turns `summary` covers (see userTurnCount). The next summary is a rewrite of
   *  `summary` plus the turns after this; nothing new → nothing to do. */
  summarizedUserTurns?: number;
  /** Cumulative model token usage over this session's lifetime (persists across resumes). */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number };
  /** Estimated USD spent over this session's lifetime, priced turn by turn at the model in use
   *  (so a mid-session /model switch is priced correctly). Absent on sessions from before pricing. */
  costUsd?: number;
  /** Cached agent orientation (whoami) — its presence means this session
   *  has been grounded, so reloads re-inject it instead of re-calling the tools. */
  orientation?: string;
  /** Cached life snapshot (get_life_snapshot) + when it was taken. Reused while fresh so a
   *  resumed session doesn't re-run a dozen queries; /snapshot forces a refresh. */
  snapshot?: { text: string; at: number };
  /** Exact prompt-token size of the context after the last reply (the "window fullness"),
   *  so a resumed session shows an accurate `ctx` figure without a re-estimate. */
  contextTokens?: number;
}

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  totalTokens?: number;
  costUsd?: number;
}

function ensureSessionsDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  }
}

function rand4(): string {
  return Math.random().toString(36).slice(2, 6);
}

/** A fresh, empty session. Not written to disk until it has at least one message. */
export function newSession(): Session {
  const now = Date.now();
  return {
    id: `${now.toString(36)}-${rand4()}`,
    createdAt: now,
    updatedAt: now,
    title: "",
    messages: [],
  };
}

/** Persist a session. Skips empty ones; best-effort — never throws on disk trouble. */
export function saveSession(s: Session): void {
  if (!s.messages.length) return;
  try {
    ensureSessionsDir();
    writeFileSync(join(SESSIONS_DIR, `${s.id}.json`), JSON.stringify(s, null, 2) + "\n", {
      mode: 0o600,
    });
  } catch {
    /* ignore — a save hiccup must not crash the chat */
  }
}

/** Move a session aside (recoverable). Returns true on success, false if missing/failed.
 *  Recover by moving the file back into SESSIONS_DIR. Mirrors the profile `--archive` pattern. */
export function archiveSession(id: string): boolean {
  try {
    const src = join(SESSIONS_DIR, `${id}.json`);
    if (!existsSync(src)) return false;
    if (!existsSync(ARCHIVED_SESSIONS_DIR)) {
      mkdirSync(ARCHIVED_SESSIONS_DIR, { recursive: true, mode: 0o700 });
    }
    let dest = join(ARCHIVED_SESSIONS_DIR, `${id}.json`);
    if (existsSync(dest)) dest = join(ARCHIVED_SESSIONS_DIR, `${id}-${Date.now()}.json`);
    renameSync(src, dest);
    return true;
  } catch {
    return false;
  }
}

/** Load a session by id, or null if missing/corrupt. */
export function loadSession(id: string): Session | null {
  try {
    const raw = readFileSync(join(SESSIONS_DIR, `${id}.json`), "utf8").trim();
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (!s || typeof s.id !== "string" || !Array.isArray(s.messages)) return null;
    // A session summarized before the turn count existed: treat its summary as current, so
    // opening and closing it doesn't re-summarize until something new is said.
    if (s.summary && s.summarizedUserTurns == null) {
      s.summarizedUserTurns = s.messages.filter((m) => m.role === "user").length;
    }
    return s;
  } catch {
    return null;
  }
}

/** Recent sessions, newest first. Corrupt files are skipped. */
export function listSessions(): SessionMeta[] {
  let files: string[];
  try {
    files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return []; // no sessions dir yet
  }
  const metas: SessionMeta[] = [];
  for (const f of files) {
    const s = loadSession(f.replace(/\.json$/, ""));
    if (!s) continue;
    metas.push({
      id: s.id,
      title: s.title || (firstUserText(s) ?? "untitled"),
      updatedAt: s.updatedAt ?? s.createdAt ?? 0,
      messageCount: s.messages.length,
      totalTokens: s.usage?.totalTokens,
      costUsd: s.costUsd,
    });
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The most recently updated session, fully loaded, or null. */
export function latestSession(): Session | null {
  const [top] = listSessions();
  return top ? loadSession(top.id) : null;
}

/** First user message text (for fallback titles), if any. */
export function firstUserText(s: Session): string | undefined {
  const m = s.messages.find((x) => x.role === "user");
  if (!m) return undefined;
  return typeof m.content === "string" ? m.content : undefined;
}
