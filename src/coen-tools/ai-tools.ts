import { tool, type ToolSet } from "ai";
import { type Client } from "../api.js";
import { type CoenConfig } from "../config.js";
import { TOOLS, WRITE_TOOLS } from "./registry.js";
import { makeContext, ToolFailure } from "./context.js";

/**
 * The registry as the AI SDK wants it, for chat.
 *
 * This replaces the MCP round trip chat used to make for its own tools: it connected to a remote
 * endpoint over Streamable HTTP with a separate long-lived API key, listed the tools, and called
 * them back over the wire. That path is retired. The tools are in this process now, so a tool call
 * is a REST request and nothing else. `writeToolNames` comes from the registry's own `scope` rather than a /catalog
 * fetch that could fail and silently downgrade the confirm gate to a name heuristic.
 */

export interface CoenToolSet {
  tools: ToolSet;
  toolNames: string[];
  writeToolNames: Set<string>;
  /** Call one tool directly, outside a chat turn (/summarize and /compact use this). */
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

/** A tool result as text — a string passes through, anything else is JSON. */
const asText = (out: unknown): string => (typeof out === "string" ? out : JSON.stringify(out, null, 2));

export function coenToolSet(client: Client, cfg: CoenConfig): CoenToolSet {
  const ctx = makeContext(client, cfg);
  const tools: ToolSet = {};

  for (const [name, def] of Object.entries(TOOLS)) {
    tools[name] = tool({
      description: def.description,
      inputSchema: def.input,
      async execute(args: unknown) {
        try {
          return asText(await def.handler((args ?? {}) as Record<string, unknown>, ctx));
        } catch (e) {
          // A ToolFailure is something the model should read and act on — a habit that doesn't
          // exist, a date in the wrong shape. It comes back as the tool's answer, not a throw,
          // so the model can correct itself instead of the turn dying.
          if (e instanceof ToolFailure) return `Error: ${e.message}`;
          throw e;
        }
      },
    });
  }

  const callTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const def = TOOLS[name];
    if (!def) throw new Error(`Tool '${name}' isn't one of Coen's tools.`);
    return asText(await def.handler(args, ctx));
  };

  return { tools, toolNames: Object.keys(tools), writeToolNames: new Set(WRITE_TOOLS), callTool };
}
