import { exec } from "node:child_process";
import { type CoenConfig } from "./config.js";

/**
 * Shell commands the CLI runs on an event, so something that happens while you are not looking
 * at the terminal can still reach you — `notify-send`, `terminal-notifier`, a webhook, anything.
 *
 * Two things fire these now: Home, while it is open, and the daemon, which is running when Home
 * is not. Both go through here so a hook behaves the same either way. Output is discarded; a
 * failure is reported to the caller and is never fatal.
 */

export type HookName = "onRead" | "onNudge";

/** How long a hook gets before it is killed. Long enough for a notification, short enough that a
 *  wedged command can't pile up behind the next event. */
const HOOK_TIMEOUT_MS = 15_000;

/**
 * Run one hook. Resolves with null when it ran (or there was nothing to run) and with the error
 * message when it failed.
 */
export function runHook(
  cfg: CoenConfig,
  name: HookName,
  env: Record<string, string>,
): Promise<string | null> {
  const cmd = cfg.hooks?.[name]?.trim();
  if (!cmd) return Promise.resolve(null);
  return new Promise((resolve) => {
    exec(cmd, { env: { ...process.env, ...env }, timeout: HOOK_TIMEOUT_MS }, (err) => {
      resolve(err ? err.message : null);
    });
  });
}

/** The environment a read hook gets. Named here so Home and the daemon can't drift. */
export const readHookEnv = (event: "read" | "read_failed", extractionId: string, summary: string) => ({
  COEN_EVENT: event,
  COEN_EXTRACTION_ID: extractionId,
  COEN_SUMMARY: summary,
});

/** The environment a nudge hook gets: today's reminder, and what is still open. */
export const nudgeHookEnv = (reminder: string, habitsLeft: string[]) => ({
  COEN_EVENT: "nudge",
  COEN_REMINDER: reminder,
  COEN_HABITS_LEFT: habitsLeft.join(", "),
  COEN_HABITS_LEFT_COUNT: String(habitsLeft.length),
});
