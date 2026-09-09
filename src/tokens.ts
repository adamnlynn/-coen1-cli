import type { ModelMessage, ToolSet } from "ai";

// Lightweight, model-agnostic token estimation for the LIVE counter only. The exact
// figure always comes from the API's usage at stream end (see agent.ts onUsage) —
// these are just for the ticking display while a reply is in flight. ~4 chars/token is
// the standard rough heuristic; close enough for a provisional readout.

/** Rough token count for a string: ~chars/4. */
export function estimateTokens(text: string | undefined | null): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

/** Estimate prompt tokens for a transcript. String content is counted directly;
 *  structured content (tool parts) is stringified. ~4 tokens/message role overhead. */
export function estimateMessages(messages: ModelMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += 4; // role + framing overhead
    total += estimateTokens(
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );
  }
  return total;
}

/** Estimate the prompt cost of the tool schemas sent with the request. Tool definitions
 *  are a large share of the prompt, so omitting them makes the live "in" read far too low.
 *  A JSON-length proxy — rough, reconciled to exact at stream end. */
export function estimateToolset(tools: ToolSet): number {
  let total = 0;
  for (const t of Object.values(tools) as Array<{ description?: string; inputSchema?: unknown }>) {
    total += estimateTokens(t.description);
    total += estimateTokens(t.inputSchema ? JSON.stringify(t.inputSchema) : "");
  }
  return total;
}
