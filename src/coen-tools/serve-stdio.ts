import { readState, pidAlive, STATE_PATH, type DaemonState } from "../daemon/state.js";
import { ACTIVE_PROFILE } from "../config.js";

/**
 * `coen mcp serve` — Coen's tools over stdio, for an agent that spawns this as a subprocess
 * (Claude Code, Claude Desktop, the Gemini CLI).
 *
 * It does not serve them itself. It carries JSON-RPC frames between that agent's stdin/stdout
 * and the daemon's loopback endpoint, and nothing else.
 *
 * That is deliberate. It used to build its own tool set and talk to the record directly, which
 * meant `coen daemon stop` was not an off switch: every stdio child an agent had already spawned
 * carried on reading and writing until that agent happened to close it. Now there is one process
 * holding your record open, and stopping it stops everything at once — which is the whole point
 * of having a switch.
 *
 * What that costs: an agent cannot reach Coen when the daemon is down, and says so rather than
 * quietly working. What it buys: one place that is connected, one token, one sign-in being kept
 * fresh, and one thing to stop.
 *
 * A restart of the daemon changes both its port and its token, so the state file is re-read
 * whenever a request fails. An agent that stays open across `coen daemon restart` keeps working,
 * and one that was spawned BEFORE the daemon came up — which is the ordinary case at login,
 * where nothing orders a desktop app against a user service — starts working when it does.
 *
 * With the daemon down it answers every frame with a JSON-RPC error saying so, rather than
 * closing the pipe. A closed pipe is all an agent can show you ("connection closed"); an error
 * carries the reason and the command that fixes it.
 *
 * Nothing may be written to stdout but MCP frames, so every message here goes to stderr.
 */

/** Ask the daemon if it is there. Null when the state file is missing, stale, or unanswered. */
async function reachDaemon(): Promise<DaemonState | null> {
  const state = readState();
  if (!state || !pidAlive(state.pid)) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/health`, {
      headers: { Authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok ? state : null;
  } catch {
    return null;
  }
}

const notRunning =
  `coen mcp serve: the coen daemon isn't running${ACTIVE_PROFILE === "default" ? "" : ` for agent "${ACTIVE_PROFILE}"`}, ` +
  "so there are no tools to serve.\n" +
  "  start it:  coen daemon start\n" +
  `  it also starts when you log in once you have done that (state: ${STATE_PATH})\n`;

/** A JSON-RPC error the calling agent can read, rather than a dead pipe. */
function rpcError(id: unknown, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code: -32000, message } });
}

export async function runStdioServer(): Promise<void> {
  let state: DaemonState | null = await reachDaemon();

  if (!state) {
    process.stderr.write(notRunning);
    // A person typed this at a prompt: they are not going to speak JSON-RPC at it, so say the
    // one useful thing and stop. An agent (stdin is a pipe) is kept alive instead — see above.
    if (process.stdin.isTTY) process.exit(1);
    process.stderr.write("coen mcp serve: waiting — it will start working the moment the daemon does.\n");
  } else {
    process.stderr.write(
      `coen mcp serve: bridging to the daemon on 127.0.0.1:${state.port} (pid ${state.pid}).\n`,
    );
  }

  /** POST one frame to the daemon. Returns the response frame, or null for a notification. */
  async function forward(frame: string, s: DaemonState): Promise<string | null> {
    const res = await fetch(`http://127.0.0.1:${s.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Streamable HTTP answers a request as one SSE event or as plain JSON; accept both.
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${s.token}`,
      },
      body: frame,
      signal: AbortSignal.timeout(120_000),
    });
    // A notification is answered 202 with no body — there is nothing to hand back.
    if (res.status === 202) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`daemon answered ${res.status}: ${text.slice(0, 200)}`);
    if (!text.trim()) return null;
    // Unwrap the SSE framing when that is what came back.
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return line ? line.slice(5).trim() : text.trim();
  }

  /**
   * One frame, with a single retry through a re-read state file. A daemon restart hands out a
   * new port and a new token, so the first attempt after one fails and the second succeeds.
   */
  async function handle(frame: string): Promise<void> {
    let id: unknown = null;
    try {
      id = (JSON.parse(frame) as { id?: unknown }).id ?? null;
    } catch {
      // Not our problem to validate — hand it on and let the server say so.
    }
    // Look for the daemon again if we have never had one, or lost it. This is what lets an agent
    // spawned before the daemon (or across a restart) pick it up without being restarted itself.
    if (!state) state = await reachDaemon();
    if (!state) {
      const why = "the coen daemon isn't running — run `coen daemon start`";
      if (id !== null) process.stdout.write(rpcError(id, why) + "\n");
      return;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await forward(frame, state);
        if (out) process.stdout.write(out + "\n");
        return;
      } catch (e) {
        const next = await reachDaemon();
        if (next && attempt === 0) {
          state = next; // it restarted — try once more, on the new port with the new token
          continue;
        }
        state = next;
        const why = next
          ? e instanceof Error ? e.message : String(e)
          : "the coen daemon has stopped — run `coen daemon start`";
        if (id !== null) process.stdout.write(rpcError(id, why) + "\n");
        process.stderr.write(`coen mcp serve: ${why}\n`);
        return;
      }
    }
  }

  // Frames arrive newline-delimited. They are handled in order: an agent may pipeline requests,
  // and answering them out of order would be legal JSON-RPC but is a needless surprise.
  let buf = "";
  let queue: Promise<void> = Promise.resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const frame = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (frame) queue = queue.then(() => handle(frame));
    }
  });

  // The parent closing stdin is how an agent says it is done with us.
  await new Promise<void>((resolve) => {
    process.stdin.on("close", () => resolve());
    process.stdin.on("end", () => resolve());
  });
  await queue.catch(() => {});
}
