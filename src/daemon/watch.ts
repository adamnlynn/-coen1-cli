import { type Client } from "../api.js";
import { type CoenConfig } from "../config.js";
import { getHome, getPulseEvents, listReminders } from "../api.js";
import { runHook, readHookEnv, nudgeHookEnv } from "../hooks.js";
import { topMarkers } from "../markers.js";
import { readWatchState, writeWatchState } from "./state.js";

/**
 * What the daemon watches for.
 *
 * A read landing is the event worth knowing about, and until now only an open Home window
 * noticed it — check in from the phone and the terminal hook never fired. The daemon polls the
 * same route Home polls and runs the same hook (see ../hooks.ts), so the notification happens
 * whether or not anything is on screen.
 *
 * Everything it has acted on is written down (daemon/state.json), so a restart does not re-fire
 * yesterday's read or send today's nudge twice.
 */

/** How often to ask whether a read landed. Reads usually take under ten seconds, but this is a
 *  background poll, not the one Home runs while you watch it — half a minute is plenty. */
export const READ_POLL_MS = 30_000;

/** How often to check whether the nudge is due. A minute's granularity on an HH:MM setting. */
export const NUDGE_TICK_MS = 60_000;

/** HH:MM in the machine's timezone — the person is at this machine, so it is their clock. */
const nowHHMM = (): string =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());

const todayLocal = (): string =>
  new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export interface WatchDeps {
  client: Client;
  cfg: CoenConfig;
  log: (line: string) => void;
}

/**
 * One read poll.
 *
 * The signal is the read itself — `latest.extraction_id` from /api/cli/home — not an event on
 * /api/thought-dump/status. That route only ever carries an extraction_id on the *submitted*
 * event, whose status is hard-coded to "pending"; the "processed" event is whatever the brain
 * worker put in it, and in practice has no extraction_id at all. So "the newest read is not the
 * one I last saw" is the only honest way to know one landed. It is also one request rather than
 * two, and it hands back the markers in the same answer.
 *
 * The failure case still comes from the events route, which does mark thought_dump_error.
 *
 * The very first poll of a run only records where we are: a daemon started an hour after a
 * check-in should not announce it as if it just landed.
 */
export async function pollRead({ client, cfg, log }: WatchDeps): Promise<void> {
  const state = readWatchState();
  const first = state.lastExtractionId === undefined && state.lastErrorEventId === undefined;

  const home = await getHome(client).catch(() => null);
  const latest = home?.latest ?? null;

  // A read that failed leaves no new `latest`, so the error events are the only trace of it.
  const events = await getPulseEvents(client).catch(() => []);
  const failure = events.find((e) => e.status === "error");

  if (first) {
    writeWatchState({
      ...state,
      lastExtractionId: latest?.extraction_id ?? "",
      lastErrorEventId: failure?.id ?? "",
    });
    return;
  }

  if (failure?.id && failure.id !== state.lastErrorEventId) {
    writeWatchState({ ...state, lastErrorEventId: failure.id });
    const why = failure.error ?? "the read failed";
    const err = await runHook(cfg, "onRead", readHookEnv("read_failed", failure.extraction_id ?? "", why));
    log(err ? `onRead hook failed: ${err}` : `onRead fired — read failed: ${why}`);
    return;
  }

  if (!latest?.extraction_id || latest.extraction_id === state.lastExtractionId) return;

  writeWatchState({ ...state, lastExtractionId: latest.extraction_id });
  const markers = topMarkers(latest.signals);
  const summary = markers.length ? `Read is in: ${markers.join(", ")}` : "Read is in";
  const err = await runHook(cfg, "onRead", readHookEnv("read", latest.extraction_id, summary));
  log(err ? `onRead hook failed: ${err}` : `onRead fired (${latest.extraction_id}) — ${summary}`);
}

/**
 * One nudge tick. Runs the onNudge hook once on the day the clock passes `daemon.nudgeAt`, with
 * today's reminder and the habits still scheduled and unticked.
 *
 * Past the time rather than at it, deliberately: a machine asleep at 09:00 and woken at 11:00
 * should still get the day's nudge, not skip it.
 */
export async function pollNudge({ client, cfg, log }: WatchDeps): Promise<void> {
  const at = cfg.daemon?.nudgeAt?.trim();
  if (!at || !/^\d{2}:\d{2}$/.test(at)) return;
  if (!cfg.hooks?.onNudge?.trim()) return;

  const day = todayLocal();
  const state = readWatchState();
  if (state.lastNudgeDay === day) return;
  if (nowHHMM() < at) return;

  const home = await getHome(client).catch(() => null);
  if (!home) return; // offline — try again next tick rather than burning the day's nudge

  const left = home.habits.filter((h) => h.scheduled_today && !h.done_today).map((h) => h.metric_name);
  // The dashboard's pick is the pinned reminder, else the most recent; reading it changes nothing.
  const active = (await listReminders(client).catch(() => [])).filter((r) => r.is_active !== false);
  const pick = active.find((r) => r.is_pinned) ?? active[0];

  writeWatchState({ ...state, lastNudgeDay: day });
  const err = await runHook(cfg, "onNudge", nudgeHookEnv(pick?.content ?? "", left));
  log(err ? `onNudge hook failed: ${err}` : `onNudge fired — ${left.length} habit(s) open`);
}
