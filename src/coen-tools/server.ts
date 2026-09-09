import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Client } from "../api.js";
import { type CoenConfig } from "../config.js";
import { TOOLS } from "./registry.js";
import { makeContext, ToolFailure } from "./context.js";

/**
 * The registry as an MCP server. One builder, two transports: `coen mcp serve` runs it on stdio,
 * the daemon runs it on loopback HTTP. Whatever a local agent connects with, it sees the same
 * tools the chat sees.
 */

export const SERVER_NAME = "coen";
export const SERVER_VERSION = "1.0.0";

const INSTRUCTIONS =
  "Coen 1 is this person's own record — what they write, the habits and numbers they keep, the " +
  "emotional read taken from their words, the people and things that recur, their decisions, " +
  "realizations and reminders. Read tools return what the record holds; write tools capture " +
  "things for them. Ground what you say in it, say plainly when it is empty or still forming, " +
  "and only claim you logged something if the tool said so.";

export function buildMcpServer(client: Client, cfg: CoenConfig): McpServer {
  const ctx = makeContext(client, cfg);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  for (const [name, def] of Object.entries(TOOLS)) {
    server.registerTool(
      name,
      {
        description: def.description,
        inputSchema: def.input.shape,
        annotations: {
          readOnlyHint: def.scope === "read",
          // An external client gets no confirm prompt — these hints are all it has to go on.
          ...(def.destructive ? { destructiveHint: true } : {}),
        },
      },
      async (args: unknown) => {
        try {
          const out = await def.handler((args ?? {}) as Record<string, unknown>, ctx);
          const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
          return { content: [{ type: "text" as const, text }] };
        } catch (e) {
          // A ToolFailure is the tool's own answer — something the caller can fix and retry.
          // Anything else is a fault, and still comes back as a tool error rather than killing
          // the connection, because one bad call should not take the server down.
          const text = e instanceof ToolFailure ? e.message : `${e instanceof Error ? e.message : String(e)}`;
          return { content: [{ type: "text" as const, text }], isError: true };
        }
      },
    );
  }

  return server;
}
