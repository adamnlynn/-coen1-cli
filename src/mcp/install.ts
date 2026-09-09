import { stdout } from "node:process";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { ACTIVE_PROFILE } from "../config.js";
import { readState, pidAlive } from "../daemon/state.js";

/**
 * `coen mcp install <client>` — write the entry that points another agent on this machine at
 * Coen's tools.
 *
 * The stdio form is what gets written, for every client: no token ends up in a config file, and
 * the entry keeps working across a daemon restart even though the port and token change. It does
 * need the daemon running — that command carries frames to it and serves nothing itself, so that
 * `coen daemon stop` is a real off switch. `coen mcp url` gives the HTTP form instead, for an
 * agent that would rather have the address directly.
 *
 * Every write is a read-modify-write of the client's own JSON, so nothing else in the file is
 * disturbed, and the previous file is kept alongside as .bak the first time we touch it.
 */

const dim = (s: string) => stdout.write(`\x1b[2m${s}\x1b[0m\n`);
const red = (s: string) => stdout.write(`\x1b[31m${s}\x1b[0m\n`);
const ok = (s: string) => stdout.write(`\x1b[32m${s}\x1b[0m\n`);
const plain = (s: string) => stdout.write(`${s}\n`);

/** The `coen` entry an agent should run: this exact node and this exact dist/index.js, so a
 *  checkout that is not on PATH still works. */
export function stdioCommand(): { command: string; args: string[] } {
  const entry = join(dirname(dirname(fileURLToPath(import.meta.url))), "index.js");
  return { command: process.execPath, args: [entry, "mcp", "serve"] };
}

/** The server name in the other agent's config — profile-qualified so two profiles can coexist. */
export const serverName = (): string => (ACTIVE_PROFILE === "default" ? "coen" : `coen-${ACTIVE_PROFILE}`);

type ClientId = "claude-code" | "claude-desktop" | "gemini-cli" | "antigravity";

/** Where each client keeps its config, and which key inside it holds the servers. */
function configPath(client: ClientId): string {
  const home = homedir();
  const win = platform() === "win32";
  const mac = platform() === "darwin";
  switch (client) {
    case "claude-code":
      // The user-scoped file `claude mcp add --scope user` writes.
      return join(home, ".claude.json");
    case "claude-desktop":
      if (mac) return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      if (win) return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
      return join(home, ".config", "Claude", "claude_desktop_config.json");
    case "gemini-cli":
      return join(home, ".gemini", "settings.json");
    case "antigravity":
      // Antigravity's CLI (`agy`) keeps its servers here, NOT beside the Gemini CLI's
      // settings.json one directory up, and not under ~/.antigravity — that holds the desktop
      // app's data. There is a stale empty ~/.gemini/antigravity/mcp_config.json on some
      // machines from an older layout; writing to it does nothing.
      return join(home, ".gemini", "config", "mcp_config.json");
  }
}

function readJson(path: string): Record<string, unknown> {
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const CLIENTS: ClientId[] = ["claude-code", "claude-desktop", "gemini-cli", "antigravity"];
const isClient = (s: string | undefined): s is ClientId => !!s && CLIENTS.includes(s as ClientId);

/**
 * Claude Code owns ~/.claude.json and rewrites the whole file whenever its own state changes, so
 * editing it underneath a running session is a race we can lose (and one that would take the rest
 * of that file with it). `claude mcp add-json` goes through its own writer. Falls back to writing
 * the file when the binary isn't on PATH.
 */
function addViaClaudeCli(name: string, entry: object): boolean {
  try {
    execFileSync("claude", ["mcp", "add-json", name, JSON.stringify(entry), "--scope", "user"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Antigravity ships its own writer, and it normalises the file (adds `disabled: false`, sorts the
 * keys) — so go through it rather than hand-writing JSON it will rewrite anyway. `agy mcp add` is
 * an add-or-update, so re-running this replaces a previous entry rather than erroring. Falls back
 * to writing the file when `agy` isn't on PATH.
 */
function addViaAgyCli(name: string, command: string, cmdArgs: string[]): boolean {
  try {
    // Flags must precede <name>; we pass none, and stdio is the default type.
    execFileSync("agy", ["mcp", "add", name, command, ...cmdArgs], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Antigravity gates MCP tools behind its own permission system, which is a second, separate
 * "yes" from the entry this command writes — and the one people trip over, because the entry
 * looks fine and the tools still don't run. Interactively `agy` prompts and you approve. Headless
 * (`agy -p`) can't prompt, so it auto-denies and tells you to add an allow-rule; we don't write
 * that rule, because it would pre-approve Coen's WRITE tools — logging a pulse, ticking a habit —
 * for every unattended run. That is the person's call to make, once, knowingly.
 */
function antigravityNote(): void {
  dim("Antigravity asks its own permission the first time a Coen tool runs — approve it there.");
  dim("  headless (`agy -p`) can't prompt: it will tell you the allow-rule to add, and where.");
}

/** Said after every install: the entry is useless on its own. */
function reminders(): void {
  const state = readState();
  if (state && pidAlive(state.pid)) return;
  dim("\nthe daemon isn't running, and that entry needs it — start it with:  coen daemon start");
}

export function runInstall(args: string[]): void {
  const client = args[0];
  if (!isClient(client)) {
    red(`usage: coen mcp install <${CLIENTS.join(" | ")}>`);
    dim("  --print writes nothing and shows the entry to paste yourself.");
    return;
  }

  const { command, args: cmdArgs } = stdioCommand();
  const name = serverName();
  const entry = { command, args: cmdArgs };
  const path = configPath(client);

  if (args.includes("--print")) {
    plain(`${path}\n`);
    plain(JSON.stringify({ mcpServers: { [name]: entry } }, null, 2));
    return;
  }

  if (client === "claude-code" && addViaClaudeCli(name, entry)) {
    ok(`added "${name}" to Claude Code (claude mcp add-json --scope user).`);
    dim("open a new Claude Code session to pick it up.");
    reminders();
    return;
  }

  if (client === "antigravity" && addViaAgyCli(name, command, cmdArgs)) {
    ok(`added "${name}" to Antigravity (agy mcp add).`);
    antigravityNote();
    reminders();
    return;
  }

  const cfg = readJson(path);
  const key = "mcpServers";
  const servers = (cfg[key] as Record<string, unknown> | undefined) ?? {};
  const replacing = name in servers;
  cfg[key] = { ...servers, [name]: entry };

  try {
    mkdirSync(dirname(path), { recursive: true });
    // Keep whatever was there before the first time we touch it — these are files the person's
    // other tools own, not ours.
    if (existsSync(path) && !existsSync(`${path}.bak`)) copyFileSync(path, `${path}.bak`);
    writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  } catch (e) {
    red(`couldn't write ${path} — ${e instanceof Error ? e.message : String(e)}`);
    dim("try `coen mcp install " + client + " --print` and paste it in yourself.");
    return;
  }

  ok(`${replacing ? "updated" : "added"} "${name}" in ${path}`);
  if (existsSync(`${path}.bak`)) dim(`the file as it was: ${path}.bak`);
  if (client === "claude-desktop") dim("restart Claude Desktop to pick it up.");
  if (client === "claude-code") dim("open a new Claude Code session to pick it up.");
  if (client === "gemini-cli") dim("restart the Gemini CLI to pick it up.");
  if (client === "antigravity") antigravityNote();
  reminders();
}
