import http from "node:http";
import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type Client } from "../api.js";
import { type SyncStatus } from "../sync/run.js";
import { type CoenConfig } from "../config.js";
import { buildMcpServer } from "../coen-tools/server.js";

/**
 * Coen's tools on a loopback port, for a local agent that would rather have one always-on
 * address than spawn `coen mcp serve` per session.
 *
 * Three things keep this from being a hole in the side of the machine:
 *
 *   - it binds 127.0.0.1 only, so nothing off this box can reach it;
 *   - every request must carry the token from daemon.json, which is 0600 — otherwise any process
 *     on the machine, including a browser, could read the whole record;
 *   - DNS-rebinding protection is on, so a page you visit cannot resolve its own hostname to
 *     127.0.0.1 and POST here with the browser's blessing.
 *
 * Stateless: one MCP server per request, no session id. The tools hold nothing between calls,
 * so a session would only be bookkeeping — and it means a client can reconnect at any time
 * without a handshake it has to remember.
 */

export interface HttpServer {
  port: number;
  close(): Promise<void>;
}

/** Constant-time compare that can't be short-circuited by length. */
function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface HealthReport {
  ok: true;
  pid: number;
  version: string;
  profile: string;
  startedAt: number;
  uptimeSeconds: number;
  port: number;
  signedInAs: string | null;
  record: string;
  tools: number;
  mcpServers: string[];
  autostart: boolean;
  /** The folder the record is mirrored into, if any. Null when sync has never been set up. */
  sync: SyncStatus | null;
  lastError: string | null;
}

export async function startHttpServer(opts: {
  client: Client;
  cfg: CoenConfig;
  token: string;
  /** 0 takes whatever is free. */
  port: number;
  health: () => HealthReport;
  onShutdown: () => void;
}): Promise<HttpServer> {
  const { client, cfg, token, health, onShutdown } = opts;

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((e) => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    const given = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!given || !tokenMatches(given, token)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized — the token is in ~/.coen/daemon/daemon.json (`coen mcp url`)" }));
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(health(), null, 2));
      return;
    }

    if (url.pathname === "/shutdown" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      onShutdown();
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found — the endpoint is /mcp" }));
      return;
    }

    // A fresh server and transport per request. Closing them when the response ends is what
    // keeps a long-lived daemon from accumulating one of each per call.
    const mcp = buildMcpServer(client, cfg);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
    });
    res.on("close", () => {
      void transport.close().catch(() => {});
      void mcp.close().catch(() => {});
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  }

  let port = opts.port;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
