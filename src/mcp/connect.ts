import type { ToolSet } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type McpServerConfig } from "../config.js";
import { FileOAuthProvider, hasStoredTokens } from "./oauth.js";
import { DEFAULT_OAUTH_PORT } from "./loopback.js";
import { sanitize } from "./spec.js";

export interface ServerConnection {
  name: string;
  connected: boolean;
  tools: ToolSet; // already namespaced
  toolCount: number;
  close: () => Promise<void>;
  note?: string; // surfaced to the user (auth needed / connect failed)
  authNeeded?: boolean; // failure was an auth error (probe → trigger login)
}

/** Namespace a server's tools as `<server>_<tool>` so multiple servers can't collide. */
export function prefixTools(name: string, tools: ToolSet): ToolSet {
  const p = sanitize(name);
  const out: ToolSet = {};
  for (const [tool, def] of Object.entries(tools)) {
    out[`${p}_${sanitize(tool)}`.slice(0, 64)] = def;
  }
  return out;
}

/** Build the right transport for a server config (stdio if `command`, else HTTP). */
export function buildTransport(name: string, cfg: McpServerConfig): Transport {
  if (cfg.command) {
    return new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
    });
  }
  if (!cfg.url) {
    throw new Error("server config needs either a `url` (remote) or a `command` (local)");
  }
  // Attach the OAuth provider if the server is flagged oauth OR we already have
  // tokens stored for it (so a prior `mcp login` works even without the flag).
  const useOAuth = cfg.oauth || hasStoredTokens(name);
  return new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
    authProvider: useOAuth
      ? new FileOAuthProvider(name, DEFAULT_OAUTH_PORT, {
          clientId: cfg.clientId,
          clientSecret: cfg.clientSecret,
          scope: cfg.scope,
        })
      : undefined,
  });
}

const noop = async () => {};

/** Reject if a promise doesn't settle in time, so a hung connect can't freeze startup. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
      if (typeof t.unref === "function") t.unref();
    }),
  ]);
}

/**
 * Connect one external server and return its namespaced tools + a close handle.
 * Never throws: a failed/unauth/slow server resolves with connected:false + a note
 * so one bad server can't take down the chat. Self-limits with a timeout and tears
 * down the transport on failure so a slow stdio server can't orphan a child process.
 */
export async function connectServer(
  name: string,
  cfg: McpServerConfig,
  timeoutMs = 15_000,
): Promise<ServerConnection> {
  let transport: Transport | undefined;
  let client: Awaited<ReturnType<typeof createMCPClient>> | undefined;
  try {
    transport = buildTransport(name, cfg);
    const t = transport;
    client = await withTimeout(createMCPClient({ transport: t }), timeoutMs, `MCP ${name} connect`);
    const c = client;
    const raw = await withTimeout(c.tools(), timeoutMs, `MCP ${name} tools`);
    const tools = prefixTools(name, raw as ToolSet);
    return { name, connected: true, tools, toolCount: Object.keys(tools).length, close: () => c.close() };
  } catch (e) {
    // Kill any spawned child / open socket so a timeout doesn't leave an orphan.
    try {
      await client?.close();
    } catch {
      /* ignore */
    }
    try {
      await transport?.close();
    } catch {
      /* ignore */
    }
    const authNeeded =
      e instanceof UnauthorizedError || /unauthor/i.test(e instanceof Error ? e.message : String(e));
    const note = authNeeded
      ? `${name}: needs auth — run \`coen mcp login ${name}\``
      : `${name}: ${e instanceof Error ? e.message : String(e)}`;
    return { name, connected: false, tools: {}, toolCount: 0, close: noop, note, authNeeded };
  }
}
