import { hostname, platform } from "node:os";
import { type Client } from "../api.js";
import { type CoenConfig, ACTIVE_PROFILE, webUrl } from "../config.js";
import { pickProvider, resolveModel } from "../agent.js";
import { VERSION } from "../version.js";

/**
 * Telling the web app this machine is here.
 *
 * The dashboard used to list agents — rows someone created, each holding a key. There are no
 * keys now, so what is worth showing instead is which machines have a CLI on them, whether the
 * daemon is up, and what each one is pointed at. That is what this sends.
 *
 * What it never sends: the loopback bearer token. That is minted at every daemon start, lives in
 * a 0600 file, and is the one thing on this machine that would let something else read the whole
 * record. The port is fine — it is useless without the token, and it is what a person needs to
 * see to know which endpoint their agent should be on.
 *
 * A failure is a shrug. The daemon's job is the MCP endpoint; the dashboard being out of date by
 * five minutes is not worth a line in the log every time the wifi drops.
 */

export const HEARTBEAT_MS = 5 * 60 * 1000;

export interface DeviceReport {
  machine: string;
  profile: string;
  platform: string;
  cli_version: string;
  node_version: string;
  daemon_running: boolean;
  local_mcp: { listening: boolean; port: number; transports: string[] };
  connected_to: { web_url: string; provider?: string; model?: string; mcp_servers: string[] };
}

/** Which machine this is. A named profile is a separate row on the same machine, the way it is
 *  a separate ~/.coen — `coen agent work` and `coen agent home` are two things. */
export function machineName(): string {
  return hostname() || "unknown";
}

export function buildReport(cfg: CoenConfig, opts: { port: number | null; running: boolean }): DeviceReport {
  let provider: string | undefined;
  let model: string | undefined;
  try {
    const sel = resolveModel(cfg);
    provider = sel.provider;
    model = sel.modelId;
  } catch {
    // No model key yet. The daemon does not need one — only the chat does — so this is a blank
    // field, not a problem.
    provider = pickProvider(cfg);
  }
  return {
    machine: machineName(),
    profile: ACTIVE_PROFILE,
    platform: platform(),
    cli_version: VERSION,
    node_version: process.version,
    daemon_running: opts.running,
    local_mcp: {
      listening: opts.running && opts.port != null,
      port: opts.port ?? 0,
      // stdio is always available — `coen mcp serve` needs no daemon — so it is listed whether
      // or not the loopback endpoint is up.
      transports: opts.running && opts.port != null ? ["stdio", "http"] : ["stdio"],
    },
    connected_to: {
      web_url: webUrl(cfg),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      mcp_servers: Object.keys(cfg.mcpServers ?? {}).filter((n) => !cfg.mcpServers?.[n]?.disabled),
    },
  };
}

/** Send one heartbeat. Resolves with an error message when it didn't land, else null. */
export async function sendHeartbeat(
  client: Client,
  cfg: CoenConfig,
  opts: { port: number | null; running: boolean },
): Promise<string | null> {
  try {
    await client.post("/api/cli/device", buildReport(cfg, opts));
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
