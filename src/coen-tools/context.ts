import { type Client, type HomeData, getHome } from "../api.js";
import { type CoenConfig } from "../config.js";

/**
 * What a tool handler is given. The client carries the signed-in person's token, so a tool never
 * asks who it is acting for — it is always the person at this terminal.
 *
 * `home()` is cached because almost every tool wants the account's timezone and several want the
 * habit list, and a chat turn can call four tools in a row. The TTL is short so a long-running
 * stdio or daemon server doesn't answer from a stale picture.
 */

const HOME_TTL_MS = 30_000;

export interface ToolContext {
  client: Client;
  cfg: CoenConfig;
  /** GET /api/cli/home, at most once per TTL. */
  home(): Promise<HomeData>;
  /** The account's timezone, from the same call. */
  timezone(): Promise<string>;
}

export function makeContext(client: Client, cfg: CoenConfig): ToolContext {
  let cached: { at: number; data: Promise<HomeData> } | null = null;
  const home = () => {
    if (!cached || Date.now() - cached.at > HOME_TTL_MS) {
      cached = { at: Date.now(), data: getHome(client) };
      // A rejected promise must not be cached, or every later call replays the same failure.
      cached.data.catch(() => {
        cached = null;
      });
    }
    return cached.data;
  };
  return {
    client,
    cfg,
    home,
    timezone: async () => (await home()).timezone,
  };
}

/**
 * A failure the calling model should read and react to — a habit that doesn't exist, a date in
 * the wrong shape. It comes back as a tool result with isError set, not a protocol error, so the
 * model can try again with a better argument. Anything else that throws is a real fault.
 */
export class ToolFailure extends Error {}

export const fail = (message: string): never => {
  throw new ToolFailure(message);
};
