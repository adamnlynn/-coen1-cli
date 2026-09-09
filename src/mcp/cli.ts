import { stdout } from "node:process";
import { type CoenConfig, saveConfig } from "../config.js";
import { hasStoredTokens, clearAuth } from "./oauth.js";
import { parseServerSpec } from "./spec.js";
import { oauthLogin } from "./login.js";
import { runInstall, serverName } from "./install.js";
import { runStdioServer } from "../coen-tools/serve-stdio.js";
import { TOOL_NAMES } from "../coen-tools/registry.js";
import { readState, pidAlive, STATE_PATH } from "../daemon/state.js";

const dim = (s: string) => stdout.write(`\x1b[2m${s}\x1b[0m\n`);
const red = (s: string) => stdout.write(`\x1b[31m${s}\x1b[0m\n`);
const ok = (s: string) => stdout.write(`\x1b[32m${s}\x1b[0m\n`);
const plain = (s: string) => stdout.write(`${s}\n`);

const USAGE =
  "coen mcp — Coen's own tools, and the external servers you attach\n" +
  "  coen mcp serve            carry another agent's stdio to the daemon (needs it running)\n" +
  "  coen mcp install <client> write that entry into claude-code | claude-desktop | gemini-cli\n" +
  "                            | antigravity\n" +
  "                            (--print shows it instead of writing)\n" +
  "  coen mcp url              the daemon's endpoint and token, for a client that wants HTTP\n" +
  "  coen mcp list\n" +
  "  coen mcp add <name> <url | command [args…]> [--oauth] [--header k:v] [--env k=v] [--client-id …] [--client-secret …] [--scope …]\n" +
  "  coen mcp login <name>     authorize a remote (OAuth) server in the browser\n" +
  "  coen mcp logout <name>    forget a server's stored credentials\n" +
  "  coen mcp remove <name>\n" +
  "\nExamples:\n" +
  "  coen mcp add todoist https://ai.todoist.net/mcp --oauth\n" +
  "  coen mcp add fs npx -y @modelcontextprotocol/server-filesystem /path  (Windows: use npx.cmd)\n";

export async function runMcpCommand(args: string[], cfg: CoenConfig): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "serve":
      return runStdioServer();
    case "install":
      return runInstall(args.slice(1));
    case "url":
      return url();
    case "list":
      return list(cfg);
    case "add":
      return add(args.slice(1), cfg);
    case "remove":
    case "rm":
      return remove(args[1], cfg);
    case "logout":
      return logout(args[1]);
    case "login":
      return login(args[1], cfg);
    default:
      dim(USAGE);
  }
}

/** The daemon's endpoint and its token — everything a client needs for the HTTP form. */
function url(): void {
  const state = readState();
  if (!state || !pidAlive(state.pid)) {
    red("the daemon isn't running, so there is no HTTP endpoint.");
    dim("start it:  coen daemon start — stdio needs it too, so nothing serves the tools until you do.");
    return;
  }
  plain(`http://127.0.0.1:${state.port}/mcp`);
  plain(`Authorization: Bearer ${state.token}`);
  dim("\nan agent that only speaks stdio uses `coen mcp serve`, which carries frames to this.");
  dim("\nthe token is this machine's — anything holding it can read and write your record.");
  dim(`it lives in ${STATE_PATH} (0600) and is new every time the daemon starts.`);
}

function list(cfg: CoenConfig): void {
  const servers = cfg.mcpServers ?? {};
  const names = Object.keys(servers);
  // Coen's own tools are served by the daemon, over the loopback port and over stdio (which is
  // the same endpoint with `coen mcp serve` carrying the frames). No daemon, no tools.
  const state = readState();
  const up = !!state && pidAlive(state.pid);
  plain(
    `• ${serverName().padEnd(11)} (built-in)  local · ${TOOL_NAMES.length} tools · ` +
      (up ? `daemon on 127.0.0.1:${state!.port}` : "daemon not running — coen daemon start"),
  );
  if (!names.length) {
    dim("no external MCP servers. add one: coen mcp add <name> <url|command…>");
    return;
  }
  for (const name of names) {
    const s = servers[name];
    const where = s.command
      ? `local · ${s.command}${s.args?.length ? " " + s.args.join(" ") : ""}`
      : `remote · ${s.url}`;
    const auth = s.oauth ? (hasStoredTokens(name) ? " · ✓ logged in" : " · needs login") : "";
    const off = s.disabled ? " · disabled" : "";
    plain(`• ${name.padEnd(11)} ${where}${auth}${off}`);
  }
}

function add(args: string[], cfg: CoenConfig): void {
  const parsed = parseServerSpec(args);
  if ("error" in parsed) {
    red(`usage: coen mcp ${parsed.error}`);
    return;
  }
  const { name, sc } = parsed;
  saveConfig({ ...cfg, mcpServers: { ...cfg.mcpServers, [name]: sc } });
  const kind = sc.url ? `remote${sc.oauth ? ", oauth" : ""}` : "local stdio";
  ok(`added "${name}" (${kind}).`);
  if (sc.url && !sc.headers) dim(`next: coen mcp login ${name}  (or it'll auto-prompt for auth in chat)`);
}

function remove(name: string | undefined, cfg: CoenConfig): void {
  if (!name) {
    red("usage: coen mcp remove <name>");
    return;
  }
  if (!cfg.mcpServers?.[name]) {
    red(`no MCP server "${name}".`);
    return;
  }
  const next = { ...cfg, mcpServers: { ...cfg.mcpServers } };
  delete next.mcpServers![name];
  saveConfig(next);
  clearAuth(name);
  ok(`removed "${name}".`);
}

function logout(name: string | undefined): void {
  if (!name) {
    red("usage: coen mcp logout <name>");
    return;
  }
  clearAuth(name);
  ok(`cleared stored credentials for "${name}".`);
}

async function login(name: string | undefined, cfg: CoenConfig): Promise<void> {
  if (!name) {
    red("usage: coen mcp login <name>");
    return;
  }
  const sc = cfg.mcpServers?.[name];
  if (!sc) {
    red(`no MCP server "${name}". add it first: coen mcp add ${name} <url> --oauth`);
    return;
  }
  if (!sc.url) {
    red(`"${name}" is a local (stdio) server — it doesn't use OAuth login.`);
    return;
  }

  dim("Opening your browser to authorize… complete it there, then come back.");
  const res = await oauthLogin(name, sc);
  if (res.status === "authorized") {
    if (!sc.oauth) {
      saveConfig({ ...cfg, mcpServers: { ...cfg.mcpServers, [name]: { ...sc, oauth: true } } });
    }
    ok(`Authorized "${name}".`);
  } else if (res.status === "no-oauth") {
    red(`"${name}" doesn't appear to use OAuth (${res.error}).`);
    dim(`If it needs a token: coen mcp add ${name} ${sc.url} --header "Authorization: Bearer <token>"`);
  } else {
    red(`Login failed for "${name}": ${res.error}`);
    dim("If the server doesn't support dynamic registration, pass --client-id / --client-secret on add.");
  }
}
