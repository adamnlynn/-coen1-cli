import { stdout, stderr } from "node:process";
import { type CoenConfig, webUrl } from "./config.js";
import { signedIn } from "./auth.js";
import { topMarkers } from "./markers.js";
import { createClient, submitPulse, getPulseEvents, getHome, ApiError } from "./api.js";
import { habitValues, habitsMoved, movedLine } from "./ticks.js";

/**
 * Check in without opening the screen:
 *
 *   echo "the day got away from me" | coen
 *   coen pulse "shipped the thing"
 *   pbpaste | coen pulse --wait
 *
 * Same route as the Home input, so a piped check-in is an ordinary check-in: it lands in the
 * journal, it feeds the read, it counts for the streak. Prints one line and exits; --wait holds
 * until the read comes back and prints what came through.
 */

const dim = (s: string) => stdout.write(`\x1b[2m${s}\x1b[0m\n`);
const red = (s: string) => stderr.write(`\x1b[31m${s}\x1b[0m\n`);
const green = (s: string) => stdout.write(`\x1b[32m${s}\x1b[0m\n`);

/** Everything on stdin. Empty when stdin is a terminal or closes with nothing. */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const POLL_MS = 3_000;
const POLL_MAX = 20;
// How long to keep looking for habit ticks after the read is in. They are queued to the save
// worker by the same run that scores the text, so they arrive a beat behind it.
const TICK_SETTLE_MS = 2_500;
const TICK_SETTLE_MAX = 4;

/** Submit `text` as a check-in. Returns the process exit code. */
export async function runPulse(cfg: CoenConfig, text: string, opts: { wait?: boolean } = {}): Promise<number> {
  const body = text.trim();
  if (!body) {
    red("nothing to check in — pipe some text, or `coen pulse \"...\"`.");
    return 1;
  }
  if (!signedIn(cfg)) {
    red(cfg.auth ? "your sign-in has expired." : "not signed in.");
    dim("run `coen login` first.");
    if (!cfg.auth) dim(`no account yet? ${webUrl(cfg)}/signup`);
    return 1;
  }
  const client = createClient(cfg);
  // Only when we are going to wait around: where the habits stand before the words go out, so
  // the read line can also say what they ticked. Skipped on a fire-and-forget check-in — that
  // one is a single request and should stay one.
  const before = opts.wait ? habitValues((await getHome(client).catch(() => null))?.habits ?? []) : new Map<string, number>();
  let id: string;
  try {
    id = (await submitPulse(client, body)).extractionId;
  } catch (e) {
    red(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    return 1;
  }
  const words = body.split(/\s+/).length;
  green(`✓ checked in — ${words} word${words === 1 ? "" : "s"} to ${webUrl(cfg).replace(/^https?:\/\//, "")}`);
  if (!opts.wait) {
    dim("Coen is reading it. `coen` to see the read when it lands.");
    return 0;
  }

  // Wait for the READ, not for an event: /api/thought-dump/status only carries an extraction_id
  // on the submitted event, whose status is always "pending", so it can never say a read landed.
  // It is still the only place a failure shows up.
  for (let i = 0; i < POLL_MAX; i++) {
    await sleep(POLL_MS);
    const home = await getHome(client).catch(() => null);
    if (home?.latest?.extraction_id === id) {
      const top = topMarkers(home.latest.signals, 5);
      dim(top.length ? `read is in — ${top.join(" · ")}` : "read is in — nothing scored");
      // The ticks ride a different queue than the read, so give them a couple of beats to land
      // before saying what the check-in moved. See src/ticks.ts.
      let moved = habitsMoved(before, home);
      for (let j = 0; j < TICK_SETTLE_MAX && before.size; j++) {
        await sleep(TICK_SETTLE_MS);
        const now = habitsMoved(before, await getHome(client).catch(() => null));
        if (now.length >= moved.length) moved = now;
      }
      const line = movedLine(moved);
      if (line) green(`✓ that ticked ${line}`);
      return 0;
    }
    const failed = (await getPulseEvents(client).catch(() => [])).find(
      (e) => e.status === "error" && e.extraction_id === id,
    );
    if (failed) {
      red(`the read failed${failed.error ? `: ${failed.error}` : ""} — the text is still in your journal`);
      return 1;
    }
  }
  dim("still processing — `coen` to see it when it lands.");
  return 0;
}
