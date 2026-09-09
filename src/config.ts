import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from "node:fs";

export type ProviderId = "anthropic" | "openai" | "google";

// An external MCP server the user attaches (Todoist, a filesystem server, etc.).
// `url` ⇒ remote (Streamable HTTP); `command` ⇒ local (stdio). Shape mirrors the
// Claude/Cursor `mcpServers` convention so configs can be pasted across tools.
export interface McpServerConfig {
  // Remote
  url?: string;
  headers?: Record<string, string>; // static auth (e.g. { Authorization: "Bearer …" })
  oauth?: boolean; // drive the OAuth login flow for this server
  clientId?: string; // optional pre-registered OAuth client (skips dynamic registration)
  clientSecret?: string;
  scope?: string;
  // Local (stdio)
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // Common
  disabled?: boolean;
}

export interface CoenConfig {
  provider?: ProviderId;
  model?: string;
  // Per-provider remembered model, so switching back to a provider restores it.
  models?: Partial<Record<ProviderId, string>>;
  apiKeys?: Partial<Record<ProviderId, string>>;
  // Gemini endpoint override (see googleBaseUrl). Unset = the SDK's default Gemini API host.
  googleBaseUrl?: string;
  // Last-known dashboard theme, cached so the right accent paints before the
  // network fetch returns. `colorScheme` is a ColorScheme key (see theme.ts).
  theme?: { colorScheme: string };
  // External MCP servers, keyed by a short name (used as the tool-name prefix).
  mcpServers?: Record<string, McpServerConfig>;
  // Tool keys hidden from the model (disable-list — everything else stays enabled).
  disabledTools?: string[];
  // Confirm before the agent runs any write/mutating MCP tool (create/update/delete,
  // logging, etc.). Defaults to true; set false (or COEN_CONFIRM_WRITES=0) to run unprompted.
  confirmWrites?: boolean;
  // Model prices in USD per 1M tokens, keyed by model id — adds to or overrides the table in
  // pricing.ts (e.g. { "gemini-4-flash": { "input": 1, "output": 5 } }).
  pricing?: Record<string, { input: number; output: number; cachedInput?: number }>;
  // The web app's host. Everything the CLI reads and writes goes here, with the sign-in below:
  // Home, the chat's tools, and the tools it serves to other agents on this machine.
  webUrl?: string;
  // The signed-in person for Home: the JWT from POST /api/auth/login and when it expires (unix ms).
  auth?: { email: string; token: string; expiresAt: number };
  // Shell commands run on an event, by Home while it is open and by the daemon when it is not
  // (see hooks.ts). `onRead` fires when a check-in's read lands or fails, with COEN_EVENT,
  // COEN_EXTRACTION_ID and COEN_SUMMARY in the environment — e.g.
  // `notify-send "Coen" "$COEN_SUMMARY"`. `onNudge` fires at daemon.nudgeAt with COEN_REMINDER
  // and COEN_HABITS_LEFT. Output is discarded; a failure is noted, not fatal.
  hooks?: { onRead?: string; onNudge?: string };
  // A folder on this disk kept in step with the record (see src/sync). `dir` is absolute — it is
  // resolved once, when it is set, so a daemon started from anywhere writes to the same place.
  // `windowDays` is how far back a pass looks (`coen sync --all` ignores it for one pass);
  // `intervalMinutes` is how often the daemon runs one. `git` is `coen git-sync`: commits happen
  // on every pass that wrote something, pushes only on their own timer.
  sync?: {
    dir?: string;
    enabled?: boolean;
    windowDays?: number;
    intervalMinutes?: number;
    git?: { enabled?: boolean; push?: boolean; pushIntervalMinutes?: number; remote?: string };
  };
  // The background daemon (see src/daemon). `port` is the loopback port its MCP endpoint listens
  // on — unset means 7717 for the default profile and whatever is free for a named one.
  // `nudgeAt` is a local HH:MM; unset means no nudge.
  daemon?: { port?: number; nudgeAt?: string };
}

// The active agent's root. Profiles redirect this via COEN_HOME (set by the
// bootstrap in index.tsx BEFORE this module loads). Default agent = ~/.coen.
export const CONFIG_DIR = process.env.COEN_HOME ?? join(homedir(), ".coen");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
// The DEFAULT agent's config — always ~/.coen/config.json, independent of COEN_HOME.
// Named agents inherit its model provider/keys (see loadConfig).
export const DEFAULT_CONFIG_PATH = join(homedir(), ".coen", "config.json");
// Per-server OAuth credential storage: <CONFIG_DIR>/mcp-auth/<server>/{tokens,client,verifier}.json
export const MCP_AUTH_DIR = join(CONFIG_DIR, "mcp-auth");
export function mcpAuthDir(server: string): string {
  return join(MCP_AUTH_DIR, server);
}

// Profiles (named agents) live under ~/.coen/profiles/<name>/ (the default stays at ~/.coen).
export const ACTIVE_PROFILE = process.env.COEN_PROFILE_NAME ?? "default";
export const PROFILES_DIR = join(homedir(), ".coen", "profiles");

// Archived profiles (moved aside by `coen agent <name> --archive`).
export const ARCHIVE_DIR = join(homedir(), ".coen", "archive");

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** Names of existing named profiles (sorted); [] if none. */
export function listProfiles(): string[] {
  return listDirs(PROFILES_DIR);
}

/** Names of archived profiles (sorted); [] if none. */
export function listArchived(): string[] {
  return listDirs(ARCHIVE_DIR);
}

/** Create ~/.coen and an empty config.json on first run (best-effort perms). */
export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, "{}\n", { mode: 0o600 });
  }
}

/** Read the default agent's config (~/.coen/config.json) directly; {} if missing/corrupt. */
function loadDefaultConfig(): CoenConfig {
  try {
    const raw = readFileSync(DEFAULT_CONFIG_PATH, "utf8").trim();
    return raw ? (JSON.parse(raw) as CoenConfig) : {};
  } catch {
    return {};
  }
}

export function loadConfig(): CoenConfig {
  let cfg: CoenConfig;
  try {
    ensureConfigDir();
    const raw = readFileSync(CONFIG_PATH, "utf8").trim();
    cfg = raw ? (JSON.parse(raw) as CoenConfig) : {};
  } catch {
    cfg = {}; // tolerate a missing/corrupt file rather than crash on startup
  }
  // Named agents inherit the default's MODEL provider/keys (so you don't re-enter
  // them), with the agent's own values taking precedence. Coen key, MCP servers,
  // theme, and disabled tools stay per-agent.
  if (ACTIVE_PROFILE !== "default") {
    const def = loadDefaultConfig();
    return {
      ...cfg,
      provider: cfg.provider ?? def.provider,
      model: cfg.model ?? def.model,
      models: { ...def.models, ...cfg.models },
      apiKeys: { ...def.apiKeys, ...cfg.apiKeys },
    };
  }
  return cfg;
}

export function saveConfig(cfg: CoenConfig): void {
  ensureConfigDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(CONFIG_PATH, 0o600); // tighten if the file already existed (no-op on Windows)
  } catch {
    /* ignore */
  }
}

export const ENV_KEY: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

export const DEFAULT_MODEL: Record<ProviderId, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
  // 3.8 Flash: Google's agent model, built for long tool-using sessions. The old note here chose
  // 2.5 Pro because 2.5 Flash stopped mid-tool-call with 20+ tools; 2.5 retires on 2026-10-16.
  google: "gemini-3.8-flash",
};

/** Optional Gemini endpoint override — e.g. the Vertex AI Express base the Coen 1 backend uses
 *  (`https://aiplatform.googleapis.com/v1`) for keys minted there. Env → config → SDK default. */
export function googleBaseUrl(cfg?: CoenConfig): string | undefined {
  const v = process.env.COEN_GOOGLE_BASE_URL ?? (cfg ?? loadConfig()).googleBaseUrl;
  return v ? v.replace(/\/$/, "") : undefined;
}

export const DEFAULT_WEB_URL = "https://stack.adamnlynn.com";

/** The record: env → config → production. Local dev is http://localhost:3100. */
export function webUrl(cfg: CoenConfig): string {
  return (process.env.COEN_WEB_URL ?? cfg.webUrl ?? DEFAULT_WEB_URL).replace(/\/$/, "");
}

/** Effective value: explicit env var wins, then stored config. */
export function apiKeyFor(provider: ProviderId, cfg: CoenConfig): string | undefined {
  return process.env[ENV_KEY[provider]] ?? cfg.apiKeys?.[provider];
}

/** Whether to confirm before running write tools: env override → config → default true. */
export function confirmWrites(cfg: CoenConfig): boolean {
  const env = process.env.COEN_CONFIRM_WRITES;
  if (env !== undefined) return !/^(0|false|no|off)$/i.test(env.trim());
  return cfg.confirmWrites !== false; // default ON
}

export function redact(value: string | undefined): string {
  if (!value) return "not set";
  return value.length <= 8 ? "set" : `…${value.slice(-4)}`;
}
