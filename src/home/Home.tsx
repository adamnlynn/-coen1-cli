import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { runHook, readHookEnv } from "../hooks.js";
import { topMarkers } from "../markers.js";
import { habitValues, habitsMoved, movedLine } from "../ticks.js";
import Spinner from "ink-spinner";
import {
  type Client,
  type HomeData,
  type HomeHabit,
  ApiError,
  getHome,
  submitPulse,
  getPulseEvents,
  tickHabit,
  untickHabit,
  createHabit,
  getHabit,
  updateHabit,
  archiveHabit,
  type NewHabit,
  type HabitPatch,
  type HabitDetail,
  type TimerSession,
  type HabitMeasure,
  startTimer,
  timerAction,
  completeTimer,
  discardTimer,
  logTimer,
  createDecision,
  createRealization,
  createReminder,
  listJournal,
  listDayEvents,
  listEmotionalReports,
  listReportsBetween,
  type EmotionalReport,
  listDecisions,
  listReminders,
  listRealizations,
  listLifeModel,
  createLifeModelEntity,
  listDailyReports,
  type DailyReport,
} from "../api.js";
import { type CoenConfig, CONFIG_PATH, ACTIVE_PROFILE, webUrl } from "../config.js";
import { TOOL_NAMES } from "../coen-tools/registry.js";
import { useTheme, SELECTABLE_SCHEMES, type ColorScheme } from "../theme.js";
import { ThemePicker } from "../ThemePicker.js";
import { useScrollPane } from "../useScrollPane.js";
import { useSlashMenu, SlashMenu } from "../SlashMenu.js";
import { TopBar } from "../TopBar.js";
import { HOME_COMMANDS, DECISION_TYPE_ITEMS } from "./commands.js";
import { loadHomeState, saveHomeState, clearHomeState } from "./state.js";
import { Form, type FormStep } from "./Form.js";
import { HabitPick, type HabitPickFor } from "./HabitPick.js";
import {
  headerLines,
  habitsLines,
  timerChip,
  liveElapsed,
  formatDuration,
  orderedHabits,
  noteLines,
  journalLines,
  fullReadLines,
  daySignalsLines,
  weekViewLines,
  weekBounds,
  readLines,
  decisionLines,
  reminderLines,
  realizationLines,
  worldLines,
  reportListLines,
  reportDetailLines,
  dayOf,
} from "./render.js";

type Mode = "input" | "habit" | "form" | "theme";

interface Tab {
  /** What the tab is for — a second /journal focuses this tab rather than opening another. */
  key: string;
  title: string;
  lines: string[];
  /** The command that opened it, so it can be reopened next time. Absent on the Home tab. */
  cmd?: string;
  /** Set on the signals tab: which calendar week it shows (0 = this week). */
  weekOffset?: number;
}

interface PendingForm {
  title: string;
  steps: FormStep[];
  onDone: (values: Record<string, string>) => void | Promise<void>;
}

function useTerminalSize(): { cols: number; rows: number } {
  const read = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const onResize = () => setSize(read());
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);
  return size;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// After a check-in: how often to ask whether the read is in, and for how long. The dashboard's
// LatestSignalsCard fast-polls the same route the same way.
// ── the habit schedule, shared by /habit add and /habit edit ────────────────
// Lifted out of the add flow when edit needed the same three questions. One copy, because two
// would drift and the second one would be the one that quietly disagreed with the server.

const WEEKDAY_SETS: Record<string, number[]> = { all: [0, 1, 2, 3, 4, 5, 6], weekdays: [1, 2, 3, 4, 5], weekends: [0, 6] };
const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const SCHEDULE_ITEMS = [
  { label: "Every day", value: "all" },
  { label: "Weekdays", value: "weekdays" },
  { label: "Weekends", value: "weekends" },
  { label: "Some days — I'll list them", value: "some" },
  { label: "A number of times a week — any days", value: "times_per_week" },
  { label: "A number of times a month — any days", value: "times_per_month" },
];

/** "mon wed fri" → [1, 3, 5]. Null when nothing in it was a day. */
function parseDayList(text: string): number[] | null {
  const days = [...new Set(
    text.toLowerCase().split(/[\s,]+/).map((d) => WEEKDAY_NAMES.indexOf(d.slice(0, 3))).filter((i) => i >= 0),
  )].sort();
  return days.length ? days : null;
}

/** How a habit's cadence reads back, for the hint on an edit prompt. */
function scheduleWords(h: Pick<HomeHabit, "habit_schedule_type" | "habit_period_target" | "habit_days" | "habit_interval_weeks">): string {
  if (h.habit_schedule_type === "times_per_week") return `${h.habit_period_target ?? "?"}× a week`;
  if (h.habit_schedule_type === "times_per_month") return `${h.habit_period_target ?? "?"}× a month`;
  const days = h.habit_days ?? [];
  const which = days.length === 7 ? "every day" : days.map((d) => WEEKDAY_NAMES[d] ?? "?").join(" ");
  return h.habit_interval_weeks > 1 ? `${which}, every ${h.habit_interval_weeks} weeks` : which;
}

const PULSE_POLL_MS = 3_000;
const PULSE_POLL_MAX = 20;
// The read and the habit ticks come back on two different queues: the emotional matrix lands on
// the extraction, the ticks are queued to the save worker as a side effect of the same run. So
// the read being in does not mean the ticks are. Keep looking for a few seconds after it.
const TICK_SETTLE_MS = 2_500;
const TICK_SETTLE_MAX = 4;

/**
 * Home. What the dashboard's landing view shows, in the terminal: greeting and streak, the latest
 * read with the writing behind it, today's habits — and the input. Anything typed that is not a
 * slash command is a check-in, sent down the same path as the web modal.
 */
export function Home({
  client,
  cfg,
  onChat,
  onTabsChange,
  registerSave,
  registerFocus,
  registerNote,
  active: visible = true,
}: {
  client: Client;
  cfg: CoenConfig;
  /** Focus the chat tab. Chat is the last tab in the strip, rendered by Root. */
  onChat: () => void;
  /** Report the strip to Root, so the chat tab can draw the same one. */
  onTabsChange?: (titles: string[], active: number) => void;
  /** Hand Root a way to write this screen down — chat's own Ctrl+C exits the whole app, and the
   *  tabs behind it should still be there next time. */
  registerSave?: (save: () => void) => void;
  /** Hand Root a way to say WHICH tab to land on when chat gives the screen back — the first one
   *  for a Tab (chat is last in the strip, so forward wraps to Home), the last for a Shift+Tab. */
  registerFocus?: (focus: (edge: "first" | "last") => void) => void;
  /** Hand Root a way to say something on this screen — used by the session reconcile, which runs
   *  in Root because it needs the client, but has news that belongs here. */
  registerNote?: (say: (text: string) => void) => void;
  /**
   * Is this the surface on screen? Home stays MOUNTED while the chat tab is up — that is what
   * keeps its tabs, scroll and half-written check-in alive across a visit to chat — so it has to
   * stop taking keys while it is hidden, and so do its overlays.
   */
  active?: boolean;
}) {
  const { exit } = useApp();
  const { palette, applyScheme } = useTheme();
  const { cols, rows } = useTerminalSize();
  const [home, setHome] = useState<HomeData | null>(null);
  const [notes, setNotes] = useState<{ id: number; lines: string[] }[]>([]);
  const noteId = useRef(0);
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null); // spinner label while something runs
  // Check-ins sent and not yet read. They wait in the background: the top bar shows them, and
  // the input stays free for anything else — tabs, habits, another check-in.
  const [reading, setReading] = useState(0);
  // A result shown in the top bar for a few seconds, whatever tab is up.
  const [flash, setFlash] = useState<string | null>(null);
  // Redraws the running clock. Only ticks while something is on it — an idle Home repaints never.
  const [now, setNow] = useState(() => Date.now());
  const flashTimer = useRef<NodeJS.Timeout | null>(null);
  const [mode, setMode] = useState<Mode>("input");
  const [form, setForm] = useState<PendingForm | null>(null);
  /** What the habit picker is opened for — tick, edit or archive. Set with setMode("habit"). */
  const [pickFor, setPickFor] = useState<HabitPickFor>("tick");
  // Tabs. Home is always first; a view (/journal, /decisions, …) opens as a tab, or focuses
  // the one it already has. Tab / Shift+Tab move, Esc closes the active one, /home goes to Home.
  const [tabs, setTabs] = useState<Tab[]>([{ key: "home", title: "Home", lines: [] }]);
  const [active, setActive] = useState(0);
  const tab = tabs[active] ?? tabs[0];
  const screen = active === 0 ? null : tab;
  // The signals tab's weeks, fetched once each.
  const weeksRef = useRef<Map<number, EmotionalReport[]>>(new Map());
  // The daily reports the /reports list is currently showing, in the order it shows them, so
  // "/reports 3" means the third line on screen rather than the third row the server sent.
  const reportsRef = useRef<DailyReport[]>([]);
  // The command being run, so the tab it opens remembers how to reopen itself.
  const lastCommandRef = useRef<string | null>(null);
  // Live copies for the exit save, which runs outside React's render.
  const stateRef = useRef<{ tabs: Tab[]; active: number; draft: string[]; input: string; scroll: { top: number; follow: boolean } }>({
    tabs: [],
    active: 0,
    draft: [],
    input: "",
    scroll: { top: 0, follow: true },
  });
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const push = (lines: string[]) => setNotes((n) => [...n, { id: noteId.current++, lines }]);
  const note = (text: string) => push(noteLines(text, palette, cols));
  const fail = (e: unknown) => note(`⚠ ${e instanceof Error ? e.message : String(e)}`);

  function showFlash(text: string) {
    setFlash(text);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => {
      if (mounted.current) setFlash(null);
    }, 8_000);
    flashTimer.current.unref?.();
  }

  /**
   * The read landed (or failed): ring the bell, flash the top bar, and run the configured hook,
   * so it is noticed even when the terminal is not in front of you.
   */
  function readDone(event: "read" | "read_failed", extractionId: string, summary: string) {
    process.stdout.write("\x07"); // bell — most terminals turn this into a badge or a sound
    showFlash(event === "read" ? "✓ read is in" : "⚠ read failed");
    // The daemon runs the same hook when Home is not open (see hooks.ts and daemon/watch.ts);
    // it stands down for a read this window already handled.
    void runHook(cfg, "onRead", readHookEnv(event, extractionId, summary)).then((err) => {
      if (err && mounted.current) note(`⚠ the onRead hook failed: ${err}`);
    });
  }

  async function load(quiet = false): Promise<HomeData | null> {
    try {
      const data = await getHome(client);
      if (mounted.current) setHome(data);
      return data;
    } catch (e) {
      if (!quiet) fail(e);
      return null;
    }
  }

  const timers = home?.timers ?? [];
  const liveTimer = timers.find((t) => t.status === "running") ?? timers[0];
  useEffect(() => {
    if (!timers.some((t) => t.status === "running")) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timers]);

  /** Put the screen back the way it was left: the same tabs, the same one in front, the same
   *  scroll, the same half-written check-in. Tabs are reopened by re-running their commands, so
   *  what comes back is current data rather than a snapshot. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await load(); // /habits and the rest read from this
      const saved = loadHomeState();
      if (cancelled || !saved) return;
      if (saved.draft?.length) setDraft(saved.draft);
      if (saved.input) setInput(saved.input);
      for (const t of saved.tabs) {
        if (cancelled) return;
        await command(t.cmd).catch(() => {});
      }
      if (cancelled) return;
      setActive((a) => Math.min(saved.active, a));
      if (saved.scroll && !saved.scroll.follow) restoreScrollRef.current = saved.scroll.top;
    })();
    return () => {
      cancelled = true;
    };
    // once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Write the screen down: which tabs are open, which one is in front, where it is scrolled,
   *  and anything typed but not sent. */
  function saveScreen() {
    const { tabs: ts, active: a, draft: d, input: i, scroll } = stateRef.current;
    saveHomeState({
      tabs: ts.filter((t) => t.cmd).map((t) => ({ key: t.key, title: t.title, cmd: t.cmd! })),
      active: a,
      scroll,
      draft: d,
      input: i,
    });
  }

  /** Save and leave. Ctrl+C and /exit both come here, so either way the screen is kept. */
  function quit() {
    saveScreen();
    exit();
  }

  // Chat's Ctrl+C exits the whole app without passing through here, so give Root the same save.
  const saveRef = useRef(saveScreen);
  saveRef.current = saveScreen;
  useEffect(() => {
    registerSave?.(() => saveRef.current());
  }, [registerSave]);


  // ── the pulse ──────────────────────────────────────────────────────────────
  async function pulse(text: string) {
    // Where the habits stand right now, before the words go out. What the detector ticks off
    // the back of them is the difference — see src/ticks.ts.
    const before = habitValues(home?.habits ?? []);
    setBusy("sending");
    let id: string;
    try {
      const r = await submitPulse(client, text);
      id = r.extractionId;
    } catch (e) {
      fail(e);
      return;
    } finally {
      setBusy(null);
    }
    note("✓ check-in sent — Coen is reading it (carry on; the top bar says when it lands)");
    // Nothing is held from here: the poll runs on its own, the top bar shows it, and the screen
    // repaints when the read arrives.
    setReading((n) => n + 1);
    let read: HomeData | null = null;
    try {
      // The read landing IS the signal: /api/cli/home's `latest` becomes the one we just
      // submitted. /api/thought-dump/status cannot tell us — it only ever carries an
      // extraction_id on the submitted event, whose status is hard-coded to "pending". It is
      // still where a failure shows up, so that is all we ask it for.
      for (let i = 0; i < PULSE_POLL_MAX && mounted.current; i++) {
        await sleep(PULSE_POLL_MS);
        const data = await load(true);
        // Every pass, not only the last one: an open habits tab should never be older than the
        // screen behind it.
        refreshHabitsTab(data);
        if (data?.latest?.extraction_id === id) {
          const top = topMarkers(data.latest.signals);
          note("the read is in" + (top.length ? ` — ${top.join(", ")}` : ""));
          readDone("read", id, top.length ? `Read is in: ${top.join(", ")}` : "Read is in");
          read = data;
          break;
        }
        const failed = (await getPulseEvents(client).catch(() => [])).find(
          (e) => e.status === "error" && e.extraction_id === id,
        );
        if (failed) {
          note(`⚠ the read failed${failed.error ? `: ${failed.error}` : ""} — the text is still in your journal`);
          readDone("read_failed", id, failed.error ?? "the read failed");
          return;
        }
      }
      if (!read && mounted.current) {
        refreshHabitsTab(await load(true));
        note("still processing — /refresh in a moment");
      }
    } finally {
      if (mounted.current) setReading((n) => Math.max(0, n - 1));
    }
    // The read is in and the top bar has stood down. The ticks it set off are still landing.
    if (read) await settleTicks(before, read);
  }

  /** After the read: keep watching a few seconds longer for the habits the check-in ticked, and
   *  say which. Silent when it ticked nothing, which is most check-ins. */
  async function settleTicks(before: Map<string, number>, read: HomeData) {
    if (!before.size) return; // no habits to move — do not spend four requests finding that out
    let moved = habitsMoved(before, read);
    for (let i = 0; i < TICK_SETTLE_MAX && mounted.current; i++) {
      await sleep(TICK_SETTLE_MS);
      const data = await load(true);
      refreshHabitsTab(data);
      const now = habitsMoved(before, data);
      if (now.length >= moved.length) moved = now;
    }
    const line = movedLine(moved);
    if (line && mounted.current) note(`✓ that ticked ${line}`);
  }

  // ── habits ─────────────────────────────────────────────────────────────────
  async function doTick(h: HomeHabit, body: { answer?: string; measures?: Record<string, number> } = {}): Promise<void> {
    setBusy("ticking");
    try {
      await tickHabit(client, h.metric_key, body);
      note(`✓ ${h.metric_name}${h.streak > 0 ? ` — ${h.streak + 1}-day streak` : ""}`);
      refreshHabitsTab(await load(true));
    } catch (e) {
      // The server answers a missing prompt or missing numbers with a 400 that CARRIES what it
      // wants — the question, or the resolved measures with their units and bounds. So the CLI
      // never has to know in advance: it asks for exactly what came back and sends it again.
      if (e instanceof ApiError && e.status === 400) {
        const b = e.body as { prompt?: string; measures?: HabitMeasure[] } | null;
        if (b?.prompt) return askAnswer(h);
        if (b?.measures?.length) return askMeasures(h, b.measures, (m) => doTick(h, { ...body, measures: m }));
      }
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  /** One prompt per number the habit asks for, then hand them back to whatever was being done. */
  function askMeasures(
    h: HomeHabit,
    measures: HabitMeasure[],
    done: (values: Record<string, number>) => void | Promise<void>,
  ): void {
    const bounds = (m: HabitMeasure) =>
      [m.unit, m.min !== null || m.max !== null ? `${m.min ?? "…"}–${m.max ?? "…"}` : null].filter(Boolean).join(" · ");
    setForm({
      title: `◆ ${h.metric_name}`,
      steps: measures.map((m) => ({
        key: m.metric_key,
        label: m.metric_name,
        hint: bounds(m) || undefined,
        kind: "text" as const,
        optional: !m.required,
      })),
      onDone: async (v) => {
        const values: Record<string, number> = {};
        for (const m of measures) {
          const raw = (v[m.metric_key] ?? "").trim();
          if (!raw) continue;
          const n = Number(raw);
          if (!Number.isFinite(n)) {
            note(`${m.metric_name} has to be a number — nothing was recorded`);
            return;
          }
          values[m.metric_key] = n;
        }
        await done(values);
      },
    });
    setMode("form");
  }

  function askAnswer(h: HomeHabit) {
    setForm({
      title: `? ${h.metric_name}`,
      steps: [{ key: "answer", label: h.habit_prompt ?? "Your answer", hint: "the answer is the completion; it is kept as a journal entry", kind: "text" }],
      onDone: (v) => doTick(h, { answer: v.answer }),
    });
    setMode("form");
  }

  function pickHabit(h: HomeHabit) {
    setMode("input");
    if (h.habit_prompt) return askAnswer(h);
    // A timed habit is done by doing it, not by claiming it: ticking starts the clock, and
    // finishing the session is what ticks the habit — with the minutes actually run.
    if (h.habit_timer_minutes != null && !h.done_today) return void beginTimer(h);
    void doTick(h);
  }

  /** Put a habit on the clock. */
  async function beginTimer(h: HomeHabit) {
    const already = timers.find((t) => t.metric_key === h.metric_key);
    if (already) {
      note(`${h.metric_name} is already on the clock — /timer done to finish it`);
      return;
    }
    setBusy("starting the clock");
    try {
      const s = await startTimer(client, h.metric_key);
      note(`▶ ${h.metric_name} — ${s.target_seconds ? `${Math.round(s.target_seconds / 60)} minutes` : "stopwatch"}. /timer done when you finish.`);
      refreshHabitsTab(await load(true));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  /**
   * Finish a session. Asks for the habit's numbers if it wants any, then for a recap — and only
   * if something is written does it ask whether to keep it. A reflection you chose to save is a
   * reflection, and it is kept as a journal entry the same way the web keeps one.
   */
  function finishSession(s: TimerSession): void {
    const h = home?.habits.find((x) => x.metric_key === s.metric_key);
    const finish = async (body: { note?: string; journal?: boolean; measures?: Record<string, number> }): Promise<void> => {
      const mins = Math.round(liveElapsed(s) / 60);
      setBusy("finishing");
      try {
        await completeTimer(client, s.metric_key, body);
        note(
          `✓ ${s.habit_name ?? s.metric_key} — ${mins} minute${mins === 1 ? "" : "s"} logged` +
            (body.journal ? ", recap kept in your journal" : ""),
        );
        refreshHabitsTab(await load(true));
      } catch (e) {
        if (e instanceof ApiError && e.status === 400) {
          const b = e.body as { measures?: HabitMeasure[] } | null;
          if (b?.measures?.length && h) {
            setBusy(null);
            return askMeasures(h, b.measures, (m) => finish({ ...body, measures: m }));
          }
        }
        fail(e);
      } finally {
        setBusy(null);
      }
    };

    setForm({
      title: `◆ ${s.habit_name ?? s.metric_key} · ${formatDuration(liveElapsed(s))}`,
      steps: [{ key: "note", label: "How did it go?", hint: "optional — Enter to just log the time", kind: "text", optional: true }],
      onDone: (v) => {
        const text = (v.note ?? "").trim();
        if (!text) return void finish({});
        setForm({
          title: `◆ ${s.habit_name ?? s.metric_key}`,
          steps: [
            {
              key: "journal",
              label: "Keep that as a journal entry?",
              hint: "it counts as a check-in and is read like one",
              kind: "select",
              items: [
                { label: "Yes, keep it", value: "yes" },
                { label: "No, just note it on the session", value: "no" },
              ],
            },
          ],
          onDone: (j) => void finish({ note: text, journal: j.journal === "yes" }),
        });
        setMode("form");
      },
    });
    setMode("form");
  }

  /**
   * Which session a command means. One on the clock: that one. Several: the number shown beside
   * it on Home, or its habit's name — and with nothing to go on, `null`, which means ask rather
   * than guess. Stopping the wrong clock loses real work.
   */
  function resolveSession(args: string[]): TimerSession | null {
    const q = args.join(" ").trim().toLowerCase();
    if (q) {
      if (/^\d+$/.test(q)) return timers[Number(q) - 1] ?? null;
      return (
        timers.find((t) => t.metric_key.toLowerCase() === q) ??
        timers.find((t) => (t.habit_name ?? "").toLowerCase() === q) ??
        timers.find((t) => (t.habit_name ?? "").toLowerCase().includes(q)) ??
        null
      );
    }
    return timers.length === 1 ? timers[0] : null;
  }

  /** Ask which clock, then carry on with what was asked of it. */
  function pickSession(verb: string, then: (s: TimerSession) => void): void {
    setForm({
      title: `◆ which one to ${verb}?`,
      steps: [
        {
          key: "which",
          label: `${timers.length} on the clock`,
          kind: "select",
          items: timers.map((t, i) => ({ label: `${i + 1}  ${timerChip(t, Date.now())}`, value: t.metric_key })),
        },
      ],
      onDone: (v) => {
        const s = timers.find((t) => t.metric_key === v.which);
        if (s) then(s);
      },
    });
    setMode("form");
  }

  /** /timer — the clock: what is on it, and pause · resume · done · discard · log. */
  async function timerCommand(rest: string) {
    const [verb, ...args] = rest.split(/\s+/).filter(Boolean);
    if (!verb || verb === "status") {
      if (!timers.length) {
        note("nothing on the clock — /habit <number> on a timed habit starts one");
        return;
      }
      const many = timers.length > 1;
      note(
        timers.map((t, i) => (many ? `${i + 1}  ` : "") + timerChip(t, Date.now())).join("\n") +
          (many ? "\n/timer done <number> · pause · resume · discard" : "\n/timer done · pause · resume · discard"),
      );
      return;
    }
    if (verb === "log") {
      const minutes = Number(args[0]);
      if (!Number.isFinite(minutes) || minutes < 1) return note("usage: /timer log <minutes> [habit number] — a session you already did");
      const h = args[1] ? findHabit(args.slice(1).join(" ")) : undefined;
      const only = timers.length === 1 ? home?.habits.find((x) => x.metric_key === timers[0].metric_key) : undefined;
      const target = h ?? only;
      if (!target) return note("which habit? /timer log <minutes> <habit number>");
      setBusy("logging");
      try {
        await logTimer(client, target.metric_key, Math.round(minutes));
        note(`✓ ${target.metric_name} — ${Math.round(minutes)} minutes written down`);
        refreshHabitsTab(await load(true));
      } catch (e) {
        fail(e);
      } finally {
        setBusy(null);
      }
      return;
    }
    if (!timers.length) return note("nothing on the clock");
    const s = resolveSession(args);
    if (!s) {
      // Several on the clock and nothing said which. Ask; never pick one on the person's behalf.
      if (args.length) return note(`no clock matches "${args.join(" ")}" — /timer status lists them`);
      return pickSession(verb, (picked) => void runTimerVerb(verb, picked));
    }
    await runTimerVerb(verb, s);
  }

  /** Do one thing to one session. Split out so the picker can call it after the fact. */
  async function runTimerVerb(verb: string, s: TimerSession): Promise<void> {
    setBusy(verb);
    try {
      if (verb === "done" || verb === "finish" || verb === "complete") {
        setBusy(null);
        finishSession(s);
        return;
      } else if (verb === "pause") {
        await timerAction(client, s.metric_key, "pause");
        note(`⏸ ${s.habit_name ?? s.metric_key} at ${formatDuration(liveElapsed(s))}`);
      } else if (verb === "resume" || verb === "start") {
        await timerAction(client, s.metric_key, "resume");
        note(`▶ ${s.habit_name ?? s.metric_key}`);
      } else if (verb === "skip") {
        await timerAction(client, s.metric_key, "skip_phase");
        note("skipped to the next phase");
      } else if (verb === "discard" || verb === "stop" || verb === "cancel") {
        await discardTimer(client, s.metric_key);
        note(`✗ ${s.habit_name ?? s.metric_key} — discarded, nothing logged`);
      } else {
        note("usage: /timer [status | pause | resume | skip | done | discard | log <minutes>]");
        return;
      }
      refreshHabitsTab(await load(true));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  /** By the number on the screen, then by key, then by exact name. */
  function findHabit(q: string): HomeHabit | undefined {
    const s = q.trim().toLowerCase();
    if (/^\d+$/.test(s)) return orderedHabits(home?.habits ?? [])[Number(s) - 1];
    return home?.habits.find((h) => h.metric_key.toLowerCase() === s) ?? home?.habits.find((h) => h.metric_name.toLowerCase() === s);
  }

  async function habitCommand(rest: string) {
    if (!home) return note("still loading — try again in a second");
    if (!rest) {
      setPickFor("tick");
      setMode("habit");
      return;
    }
    const undo = /\s+undo$/i.test(rest);
    const name = rest.replace(/\s+undo$/i, "").trim();
    const h = findHabit(name);
    if (!h) return note(/^\d+$/.test(name) ? `there is no habit ${name} on the screen` : `no habit called "${name}" — use its number from the screen, or /habit alone to pick`);
    if (h.is_routine) return note(`${h.metric_name} is a routine — tick its steps on the dashboard`);
    if (undo) {
      setBusy("unticking");
      try {
        await untickHabit(client, h.metric_key);
        note(`○ ${h.metric_name} — unticked`);
        refreshHabitsTab(await load(true));
      } catch (e) {
        fail(e);
      } finally {
        setBusy(null);
      }
      return;
    }
    pickHabit(h);
  }

  // ── forms ──────────────────────────────────────────────────────────────────
  /**
   * /newhabit — three short forms in a row, because what the second asks depends on the kind
   * picked in the first: a yes/no habit needs nothing more, a count needs a target and unit, a
   * prompt habit needs its question. Then the days, and an optional group.
   */
  /**
   * `/habit add` — the whole habit model, asked one question at a time.
   *
   * Four kinds, and they are four different COMPLETIONS: a thumb, a number that adds up, a
   * question whose answer is the completion, or a clock. The server decides which combinations
   * are legal and its refusals are already sentences ("A habit can run a clock or ask a question,
   * not both"), so nothing here re-implements those rules — it just cannot offer an illegal pair.
   *
   * The common case stays short. Name, kind, schedule, done. Everything else — group, what it is
   * for, the words that auto-tick it, a pomodoro rhythm — sits behind one "anything else?", so
   * adding "Walk" is three questions and adding a tuned deep-work timer is still possible.
   */
  type HabitDraft = {
    name: string;
    kind: "max" | "sum" | "prompt" | "timer";
    target?: string;
    prompt?: string;
    session?: string;
    schedule?: string;
    dayList?: string;
    times?: string;
    group?: string;
    description?: string;
    keywords?: string;
    pomodoro?: string;
  };

  function openNewHabit() {
    setForm({
      title: "◆ add a habit",
      steps: [
        { key: "name", label: "What is the habit called?", hint: "e.g. Morning pages", kind: "text" },
        {
          key: "kind",
          label: "What kind?",
          kind: "select",
          items: [
            { label: "Yes / no — did it or not", value: "max" },
            { label: "A number to reach each day — e.g. 8 glasses, 3 pages", value: "sum" },
            { label: "Asks a question — the answer is the completion", value: "prompt" },
            { label: "Runs a clock — timed sessions", value: "timer" },
          ],
        },
      ],
      onDone: (v) => askHabitDetail({ name: v.name, kind: v.kind as HabitDraft["kind"] }),
    });
    setMode("form");
  }

  /** The kind's own question, then the schedule. */
  function askHabitDetail(draft: HabitDraft) {
    const steps: FormStep[] = [];
    if (draft.kind === "sum") steps.push({ key: "target", label: "How much, and of what?", hint: "e.g. 8 glasses · 3 pages", kind: "text" });
    if (draft.kind === "prompt") steps.push({ key: "prompt", label: "The question it asks", hint: "e.g. What was the best thing about today?", kind: "text" });
    if (draft.kind === "timer") {
      steps.push({ key: "target", label: "How many minutes a day?", hint: "e.g. 30", kind: "text" });
      steps.push({ key: "session", label: "How long is one session?", hint: "Enter to make one session the whole thing", kind: "text", optional: true });
    }
    steps.push({ key: "schedule", label: "When?", kind: "select", items: SCHEDULE_ITEMS });
    setForm({
      title: `◆ add a habit · ${draft.name}`,
      steps,
      onDone: (v) => askHabitSchedule({ ...draft, ...v }),
    });
    setMode("form");
  }

  /** Only asked when the schedule needs a second answer. */
  function askHabitSchedule(draft: HabitDraft) {
    if (draft.schedule === "some") {
      setForm({
        title: `◆ add a habit · ${draft.name}`,
        steps: [{ key: "dayList", label: "Which days?", hint: "e.g. mon wed fri", kind: "text" }],
        onDone: (v) => askHabitExtras({ ...draft, ...v }),
      });
      setMode("form");
      return;
    }
    if (draft.schedule === "times_per_week" || draft.schedule === "times_per_month") {
      const period = draft.schedule === "times_per_week" ? "week" : "month";
      setForm({
        title: `◆ add a habit · ${draft.name}`,
        steps: [{ key: "times", label: `How many times a ${period}?`, hint: "e.g. 3", kind: "text" }],
        onDone: (v) => askHabitExtras({ ...draft, ...v }),
      });
      setMode("form");
      return;
    }
    askHabitExtras(draft);
  }

  /** One gate, so the short path stays short. */
  function askHabitExtras(draft: HabitDraft) {
    setForm({
      title: `◆ add a habit · ${draft.name}`,
      steps: [
        {
          key: "more",
          label: "Anything else?",
          kind: "select",
          items: [
            { label: "No — save it", value: "no" },
            { label: "Yes — group, what it's for, the words that tick it", value: "yes" },
          ],
        },
      ],
      onDone: (v) => {
        if (v.more !== "yes") return void saveHabit(draft);
        const steps: FormStep[] = [
          { key: "group", label: "Group", hint: "e.g. Mind, Body — matches an existing group's spelling", kind: "text", optional: true },
          { key: "description", label: "What is it for?", hint: "Coen reads this when deciding whether a check-in mentions it", kind: "text", optional: true },
          // The one that actually changes behaviour: without these it never ticks itself.
          { key: "keywords", label: "Words that mean you did it", hint: "e.g. walked, went for a walk — Coen ticks this when it sees them", kind: "text", optional: true },
        ];
        if (draft.kind === "timer") {
          steps.push({ key: "pomodoro", label: "Pomodoro rhythm?", hint: "e.g. 25/5, or Enter for none", kind: "text", optional: true });
        }
        setForm({ title: `◆ add a habit · ${draft.name}`, steps, onDone: (x) => void saveHabit({ ...draft, ...x }) });
        setMode("form");
      },
    });
    setMode("form");
  }

  async function saveHabit(draft: HabitDraft) {
    const body: NewHabit = {
      metric_name: draft.name,
      aggregation_type: draft.kind === "sum" || draft.kind === "timer" ? "sum" : "max",
    };

    if (draft.kind === "sum") {
      const m = /^\s*(\d+(?:\.\d+)?)\s*(.*)$/.exec(draft.target ?? "");
      if (!m) return note("the target needs a number first, like “8 glasses” — /habit add to try again");
      body.habit_target = Number(m[1]);
      if (m[2].trim()) body.unit = m[2].trim();
    }
    if (draft.kind === "prompt") body.habit_prompt = draft.prompt;
    if (draft.kind === "timer") {
      // A timed habit is a `sum` of MINUTES: the daily target and the length of one sitting.
      const minutes = Number((draft.target ?? "").replace(/[^\d.]/g, ""));
      if (!Number.isFinite(minutes) || minutes <= 0) return note("how many minutes a day? — /habit add to try again");
      body.habit_target = Math.round(minutes);
      body.unit = "minutes";
      const session = draft.session?.trim() ? Number(draft.session.replace(/[^\d.]/g, "")) : minutes;
      if (!Number.isFinite(session) || session < 1 || session > 1440) {
        return note("a session is a whole number of minutes, 1 to 1440 — /habit add to try again");
      }
      body.habit_timer_minutes = Math.round(session);
      if (draft.pomodoro?.trim()) {
        // "25/5" — anything left out takes the server's default.
        const [work, brk] = draft.pomodoro.split(/[^\d]+/).filter(Boolean).map(Number);
        body.habit_pomodoro = {
          ...(Number.isFinite(work) && work > 0 ? { work_minutes: work } : {}),
          ...(Number.isFinite(brk) && brk > 0 ? { break_minutes: brk } : {}),
        };
      }
    }

    if (draft.schedule === "times_per_week" || draft.schedule === "times_per_month") {
      const times = Number((draft.times ?? "").replace(/[^\d]/g, ""));
      if (!Number.isFinite(times) || times < 1) return note("how many times? — /habit add to try again");
      body.habit_schedule_type = draft.schedule;
      body.habit_period_target = times;
    } else if (draft.dayList !== undefined) {
      const days = parseDayList(draft.dayList);
      if (!days) return note("no days I recognised in that — use names like mon wed fri. /habit add to try again");
      body.habit_days = days;
    } else {
      body.habit_days = WEEKDAY_SETS[draft.schedule ?? "all"] ?? WEEKDAY_SETS.all;
    }

    if (draft.group) body.group_name = draft.group;
    if (draft.description) body.description = draft.description;
    if (draft.keywords) {
      const words = draft.keywords.split(",").map((k) => k.trim()).filter(Boolean);
      if (words.length) body.keywords = words;
    }

    setBusy("saving");
    try {
      await createHabit(client, body);
      note(
        `✓ habit added — ${draft.name}` +
          (body.keywords?.length ? "" : "\n  no words to tick it by, so you'll tick this one yourself"),
      );
      refreshHabitsTab(await load(true));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  /**
   * `/habit edit` — one thing at a time.
   *
   * A habit has a dozen editable fields and asking about all of them to change a target would
   * be worse than not offering the edit at all. So: pick what to change, answer that, done.
   * Two questions for the common case, and `/habit edit 3` again changes the next thing.
   *
   * Every prompt starts on the current value, so a keyword list is corrected rather than
   * retyped. That is the reason FormStep grew `initial`.
   *
   * The rules about which combinations are legal are the server's — a habit cannot both run a
   * clock and ask a question, a timed habit has to add up its minutes — and its refusals are
   * already sentences, so nothing here re-checks them. This only avoids offering an illegal
   * pair in the first place.
   */
  const EDIT_ITEMS = [
    { label: "Its name", value: "metric_name" },
    { label: "What it's for", value: "description" },
    { label: "Its group", value: "group_name" },
    { label: "The target", value: "target" },
    { label: "When it's due", value: "schedule" },
    { label: "The words that tick it", value: "keywords" },
    { label: "The question it asks", value: "prompt" },
    { label: "The clock", value: "timer" },
  ];

  async function openEditHabit(h: HomeHabit) {
    if (h.is_routine) return note(`${h.metric_name} is a routine — edit it on the dashboard's Routines page`);
    // Keywords and the unit are not in the home payload; only the single-habit route carries
    // them. Fetched up front so every prompt below can open on the current value.
    setBusy("loading");
    let d: HabitDetail;
    try {
      d = await getHabit(client, h.metric_key);
    } catch (e) {
      return fail(e);
    } finally {
      setBusy(null);
    }
    setForm({
      title: `◆ edit · ${d.metric_name}`,
      steps: [{ key: "what", label: "What do you want to change?", kind: "select", items: EDIT_ITEMS }],
      onDone: (v) => askHabitEdit(d, v.what),
    });
    setMode("form");
  }

  function askHabitEdit(d: HabitDetail, what: string) {
    const title = `◆ edit · ${d.metric_name}`;
    const unit = d.display_config?.unit && d.display_config.unit !== "count" ? d.display_config.unit : "";
    const keywords = d.calculation_config?.keywords ?? [];
    const done = (steps: FormStep[], build: (v: Record<string, string>) => HabitPatch | string) =>
      setForm({ title, steps, onDone: (v) => {
        const patch = build(v);
        if (typeof patch === "string") return note(patch);
        void saveHabitEdit(d, patch);
      } });

    switch (what) {
      case "metric_name":
        done([{ key: "v", label: "What should it be called?", kind: "text", initial: d.metric_name }],
          (v) => ({ metric_name: v.v }));
        break;
      case "description":
        done([{ key: "v", label: "What is it for?", hint: "Coen reads this when deciding whether a check-in mentions it", kind: "text", optional: true, initial: d.description ?? "" }],
          (v) => ({ description: v.v || null }));
        break;
      case "group_name":
        done([{ key: "v", label: "Group", hint: "e.g. Mind, Body — matches an existing group's spelling", kind: "text", optional: true, initial: d.group_name ?? "" }],
          (v) => ({ group_name: v.v }));
        break;
      case "target":
        if (d.habit_prompt) return note("a habit that asks a question is done when you answer it — its target is always 1");
        done([{ key: "v", label: d.habit_timer_minutes ? "How many minutes a day?" : "How much, and of what?", hint: d.habit_timer_minutes ? "e.g. 30" : "e.g. 8 glasses · 3 pages", kind: "text", initial: `${d.habit_target}${unit && !d.habit_timer_minutes ? ` ${unit}` : ""}` }],
          (v) => {
            const m = /^\s*(\d+(?:\.\d+)?)\s*(.*)$/.exec(v.v);
            if (!m) return "the target needs a number first, like “8 glasses”";
            const patch: HabitPatch = { habit_target: Number(m[1]) };
            if (d.habit_timer_minutes) patch.unit = "minutes";
            else if (m[2].trim()) patch.unit = m[2].trim();
            return patch;
          });
        break;
      case "schedule":
        if (d.routine_key) return note("this is a step of a routine — it follows the routine's schedule");
        setForm({
          title,
          steps: [{ key: "schedule", label: `When? (now: ${scheduleWords(d as unknown as HomeHabit)})`, kind: "select", items: SCHEDULE_ITEMS }],
          onDone: (v) => askEditSchedule(d, v.schedule),
        });
        setMode("form");
        return;
      case "keywords":
        done([{ key: "v", label: "Words that mean you did it", hint: "comma separated — Coen ticks this when it sees them. Empty means you tick it yourself", kind: "text", optional: true, initial: keywords.join(", ") }],
          (v) => ({ keywords: v.v.split(",").map((k) => k.trim()).filter(Boolean) }));
        break;
      case "prompt":
        if (d.habit_timer_minutes) return note("this habit runs a clock — a habit can run a clock or ask a question, not both");
        done([{ key: "v", label: "The question it asks", hint: "empty turns the question off", kind: "text", optional: true, initial: d.habit_prompt ?? "" }],
          (v) => (v.v ? { habit_prompt: v.v } : { habit_prompt: null }));
        break;
      case "timer":
        if (d.habit_prompt) return note("this habit asks a question — a habit can run a clock or ask a question, not both");
        done([{ key: "v", label: "How long is one session, in minutes?", hint: "1–1440, or empty to stop the clock", kind: "text", optional: true, initial: d.habit_timer_minutes ? String(d.habit_timer_minutes) : "" }],
          (v) => {
            if (!v.v.trim()) return { habit_timer_minutes: null };
            const mins = Number(v.v.replace(/[^\d.]/g, ""));
            if (!Number.isFinite(mins) || mins < 1 || mins > 1440) return "a session is a whole number of minutes, 1 to 1440";
            // A clock logs minutes and minutes have to add up, so turning one on turns the
            // habit into a daily goal at the same time. The server would refuse otherwise.
            return { habit_timer_minutes: Math.round(mins), aggregation_type: "sum", unit: "minutes" };
          });
        break;
      default:
        return note("nothing to change");
    }
    setMode("form");
  }

  /** The schedule's second question, when it needs one. Same two the add flow asks. */
  function askEditSchedule(d: HabitDetail, schedule: string) {
    const title = `◆ edit · ${d.metric_name}`;
    if (schedule === "some") {
      setForm({
        title,
        steps: [{ key: "dayList", label: "Which days?", hint: "e.g. mon wed fri", kind: "text", initial: (d.habit_days ?? []).map((n) => WEEKDAY_NAMES[n]).join(" ") }],
        onDone: (v) => {
          const days = parseDayList(v.dayList);
          if (!days) return note("no days I recognised in that — use names like mon wed fri");
          void saveHabitEdit(d, { habit_days: days, habit_schedule_type: "days" });
        },
      });
      setMode("form");
      return;
    }
    if (schedule === "times_per_week" || schedule === "times_per_month") {
      const period = schedule === "times_per_week" ? "week" : "month";
      setForm({
        title,
        steps: [{ key: "times", label: `How many times a ${period}?`, hint: "e.g. 3", kind: "text", initial: d.habit_period_target ? String(d.habit_period_target) : "" }],
        onDone: (v) => {
          const times = Number(v.times.replace(/[^\d]/g, ""));
          if (!Number.isFinite(times) || times < 1) return note("how many times? — /habit edit to try again");
          void saveHabitEdit(d, { habit_schedule_type: schedule, habit_period_target: times });
        },
      });
      setMode("form");
      return;
    }
    void saveHabitEdit(d, { habit_days: WEEKDAY_SETS[schedule] ?? WEEKDAY_SETS.all, habit_schedule_type: "days" });
  }

  async function saveHabitEdit(d: HabitDetail, patch: HabitPatch) {
    setBusy("saving");
    try {
      const { habit } = await updateHabit(client, d.metric_key, patch);
      const changedSchedule = patch.habit_days !== undefined || patch.habit_schedule_type !== undefined;
      note(
        `✓ ${habit?.metric_name ?? d.metric_name} updated` +
          (changedSchedule
            ? `\n  now ${scheduleWords((habit ?? d) as unknown as HomeHabit)} — the whole history is re-scored through the new schedule, so a streak can change`
            : ""),
      );
      refreshHabitsTab(await load(true));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  /** `/habit remove` — archive, and say plainly that it is not a delete. */
  function openRemoveHabit(h: HomeHabit) {
    setForm({
      title: `◆ archive · ${h.metric_name}`,
      steps: [
        {
          key: "sure",
          label: h.is_routine
            ? "Archive this routine and all of its steps?"
            : "Archive this habit?",
          kind: "select",
          items: [
            { label: "No — keep it", value: "no" },
            { label: "Yes — archive it (its history stays)", value: "yes" },
          ],
        },
      ],
      onDone: async (v) => {
        if (v.sure !== "yes") return note("kept");
        setBusy("archiving");
        try {
          const res = await archiveHabit(client, h.metric_key);
          const steps = (res.archived_keys ?? []).filter((k) => k !== h.metric_key).length;
          note(
            `✓ ${h.metric_name} archived` +
              (steps ? ` with its ${steps} step${steps === 1 ? "" : "s"}` : "") +
              `\n  its history is kept — /habit add with the same name brings it back`,
          );
          refreshHabitsTab(await load(true));
        } catch (e) {
          fail(e);
        } finally {
          setBusy(null);
        }
      },
    });
    setMode("form");
  }

  function openDecision() {
    setForm({
      title: "◆ record a decision",
      steps: [
        { key: "title", label: "What did you decide?", hint: "short — the title", kind: "text" },
        { key: "decision_type", label: "What kind of decision?", kind: "select", items: DECISION_TYPE_ITEMS },
        { key: "description", label: "What was decided, in a sentence or two", kind: "text", optional: true },
        { key: "rationale", label: "Why this choice?", kind: "text", optional: true },
      ],
      onDone: async (v) => {
        setBusy("saving");
        try {
          await createDecision(client, {
            title: v.title,
            decision_type: v.decision_type || "other",
            description: v.description || undefined,
            rationale: v.rationale || undefined,
          });
          note(`✓ decision recorded — ${v.title}`);
        } catch (e) {
          fail(e);
        } finally {
          setBusy(null);
        }
      },
    });
    setMode("form");
  }

  function openInsight() {
    setForm({
      title: "◆ log a realization",
      steps: [
        { key: "title", label: "In a few words", kind: "text" },
        { key: "content", label: "The realization, with what led to it", kind: "text" },
      ],
      onDone: async (v) => {
        setBusy("saving");
        try {
          await createRealization(client, { title: v.title, content: v.content });
          note(`✓ realization logged — ${v.title}`);
        } catch (e) {
          fail(e);
        } finally {
          setBusy(null);
        }
      },
    });
    setMode("form");
  }

  /**
   * Name something in your world yourself.
   *
   * Everything on this list normally arrives the other way round: Coen reads your writing, works
   * out who and what keeps coming up, and asks you to check it. This is the other direction —
   * telling it about someone before it has met them, so the context is there from the start rather
   * than after enough entries mention them. What you write here outranks anything the engine
   * later decides to call them.
   */
  function openWorldAdd() {
    setForm({
      title: "◆ add to your world",
      steps: [
        { key: "label", label: "Who or what?", hint: "e.g. Sarah · the commute · the Tuesday standup", kind: "text" },
        {
          key: "entity_type",
          label: "What kind of thing is it?",
          kind: "select",
          items: [
            { label: "A person", value: "person" },
            { label: "Something you do", value: "activity" },
            { label: "A situation", value: "situation" },
            { label: "A place", value: "place" },
          ],
        },
        { key: "relation", label: "What is it to you?", hint: "e.g. my sister · every weekday morning", kind: "text", optional: true },
        { key: "user_note", label: "Anything Coen should know", kind: "text", optional: true },
      ],
      onDone: async (v) => {
        setBusy("saving");
        try {
          const entity = await createLifeModelEntity(client, {
            label: v.label,
            entity_type: v.entity_type,
            ...(v.relation ? { relation: v.relation } : {}),
            ...(v.user_note ? { user_note: v.user_note } : {}),
          });
          // Say when it merged with something already there rather than silently correcting a row
          // the person thought they were creating.
          note(
            entity.mention_days > 0
              ? `✓ ${entity.label} was already in your world (${entity.mention_days} days) — your words now`
              : `✓ ${entity.label} added to your world`,
          );
        } catch (e) {
          fail(e);
        } finally {
          setBusy(null);
        }
      },
    });
    setMode("form");
  }

  function openReminder() {
    setForm({
      title: "◆ save a reminder",
      steps: [
        { key: "content", label: "The line you want to be reminded of", hint: "up to 500 characters", kind: "text" },
        { key: "attribution", label: "Who said it, if it is a quote", kind: "text", optional: true },
      ],
      onDone: async (v) => {
        setBusy("saving");
        try {
          await createReminder(client, { content: v.content, attribution: v.attribution || undefined });
          note(`✓ reminder saved — “${v.content}”`);
        } catch (e) {
          fail(e);
        } finally {
          setBusy(null);
        }
      },
    });
    setMode("form");
  }

  // ── tabs ───────────────────────────────────────────────────────────────────
  /** Open a tab for `key`, or refresh and focus the one that exists. */
  function openView(key: string, title: string, lines: string[], extra: Partial<Tab> = {}) {
    if (!extra.cmd && lastCommandRef.current) extra = { ...extra, cmd: lastCommandRef.current };
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.key === key);
      const next: Tab = { key, title, lines, ...extra };
      if (i === -1) {
        setActive(ts.length);
        return [...ts, next];
      }
      setActive(i);
      return ts.map((t, j) => (j === i ? next : t));
    });
    pane.setFollow(true); // every list runs oldest → newest, so open at the bottom
  }
  function closeTab() {
    if (active === 0) return;
    setTabs((ts) => ts.filter((_, i) => i !== active));
    setActive((a) => Math.max(0, a - 1));
    pane.setFollow(true);
  }
  /** Move along the strip. Chat is one past the last Home tab; stepping onto it focuses chat. */
  function switchTab(delta: number) {
    const total = tabs.length + 1; // + chat
    const next = (active + delta + total) % total;
    if (next === tabs.length) {
      onChat();
      return;
    }
    setActive(next);
    pane.setFollow(true);
  }
  function goHome() {
    setActive(0);
    pane.setFollow(true);
  }
  /** Redraw an open habits tab in place after a tick, so it never shows a stale ○. */
  function refreshHabitsTab(data: HomeData | null) {
    if (!data) return;
    setTabs((ts) => ts.map((t) => (t.key === "habits" ? { ...t, lines: habitsLines(data.habits, palette, cols) } : t)));
  }
  async function view(key: string, title: string, run: () => Promise<string[]>) {
    const cmd = lastCommandRef.current;
    setBusy(`loading ${title}`);
    try {
      const lines = await run();
      openView(key, title, lines, cmd ? { cmd } : {});
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  /** The signals tab at a week. Fetched once per week, then paged with ← → or /signals last|next. */
  async function openWeek(offset: number) {
    if (offset < 0) return note("that is next week — nothing there yet");
    let reports = weeksRef.current.get(offset);
    if (!reports) {
      setBusy("loading signals");
      try {
        const { start, end } = weekBounds(offset);
        reports = await listReportsBetween(client, start.toISOString(), end.toISOString());
        weeksRef.current.set(offset, reports);
      } catch (e) {
        fail(e);
        return;
      } finally {
        setBusy(null);
      }
    }
    openView("signals", "signals", weekViewLines(offset, reports, palette, cols), { weekOffset: offset, cmd: `/signals ${offset}` });
  }

  // ── commands ───────────────────────────────────────────────────────────────
  async function command(text: string) {
    lastCommandRef.current = text;
    const [name, ...restParts] = text.split(/\s+/);
    const rest = restParts.join(" ").trim();
    switch (name) {
      case "/exit":
      case "/quit":
        quit();
        return;
      case "/fresh":
        clearHomeState();
        setTabs((ts) => ts.slice(0, 1));
        setActive(0);
        note("this screen won't be restored next time — tabs closed");
        return;
      case "/chat":
        onChat();
        return;
      case "/home":
        goHome();
        return;
      case "/close":
        closeTab();
        return;
      case "/clear":
        // The screen, and only the screen. Deliberately NOT /fresh, which also forgets the
        // layout so it isn't restored next launch — clearing what is in front of you should not
        // decide anything about next time.
        setTabs((ts) => ts.slice(0, 1));
        setActive(0);
        setNotes([]);
        pane.setFollow(true);
        return;
      case "/refresh":
        setBusy("refreshing");
        refreshHabitsTab(await load());
        setBusy(null);
        return;
      case "/help":
        note(HOME_COMMANDS.map((c) => `${c.name.padEnd(16)} ${c.hint}`).join("\n") + "\n\nanything else you type is a check-in. end a line with \\ to keep writing on the next one.");
        return;
      case "/config":
        note(
          `${CONFIG_PATH}${ACTIVE_PROFILE !== "default" ? `  (agent: ${ACTIVE_PROFILE})` : ""}` +
            `\nsigned in as ${cfg.auth?.email ?? "(nobody)"} · ${webUrl(cfg)}` +
            `\ntools: ${TOOL_NAMES.length} — the chat's, and any agent on this machine's (coen mcp serve)`,
        );
        return;
      case "/theme":
        if (!rest) {
          setMode("theme");
          return;
        }
        if (!SELECTABLE_SCHEMES.some((s) => s.scheme === rest.toLowerCase())) {
          note(`unknown theme "${rest}". options: ${SELECTABLE_SCHEMES.map((s) => s.scheme).join(", ")}`);
          return;
        }
        void applyScheme(rest.toLowerCase() as ColorScheme, true).then((ok) =>
          note(ok ? `theme → ${rest} (synced to dashboard)` : `theme → ${rest} (saved locally; sync unavailable)`),
        );
        return;
      case "/habit": {
        // "add" is the name; "new" stays because it is in people's fingers.
        if (rest === "add" || rest === "new") return openNewHabit();
        // edit / remove take the same argument /habit does — a number from the screen or a
        // name — and open the picker without one.
        const verb = /^(edit|change|remove|delete|archive)\b/i.exec(rest);
        if (verb) {
          if (!home) return note("still loading — try again in a second");
          const which = rest.slice(verb[0].length).trim();
          const editing = /^(edit|change)$/i.test(verb[1]);
          if (!which) {
            setPickFor(editing ? "edit" : "remove");
            setMode("habit");
            return;
          }
          const h = findHabit(which);
          if (!h) {
            return note(/^\d+$/.test(which)
              ? `there is no habit ${which} on the screen`
              : `no habit called "${which}" — use its number from the screen, or /habit ${editing ? "edit" : "remove"} alone to pick`);
          }
          if (editing) return void openEditHabit(h);
          return openRemoveHabit(h);
        }
        await habitCommand(rest);
        return;
      }
      case "/timer":
        await timerCommand(rest);
        return;
      case "/habits":
        if (!home) return note("still loading — try again in a second");
        openView("habits", "habits", habitsLines(home.habits, palette, cols));
        return;
      case "/newhabit":
        openNewHabit();
        return;
      case "/decision":
        openDecision();
        return;
      case "/insight":
        openInsight();
        return;
      case "/reminder":
        openReminder();
        return;
      case "/journal": {
        const day = /^\d{4}-\d{2}-\d{2}$/.test(rest) ? rest : undefined;
        if (rest && !day) return note("usage: /journal [YYYY-MM-DD]");
        await view(day ? `journal:${day}` : "journal", day ? `journal · ${day}` : "journal", async () => journalLines(await listJournal(client, day ? { day } : { limit: 10 }), palette, cols, day));
        return;
      }
      case "/reports": {
        // No argument: the list. A date: that day in full. A number: that line of the list.
        if (!rest) {
          await view("reports", "reports", async () => {
            const { reports, pending } = await listDailyReports(client, 20);
            reportsRef.current = [...reports].sort((x, y) =>
              (x.original_date ?? "").localeCompare(y.original_date ?? ""),
            );
            return reportListLines(reports, pending, palette, cols);
          });
          return;
        }
        if (/^\d{4}-\d{2}-\d{2}$/.test(rest)) {
          await view(`reports:${rest}`, `report · ${rest}`, async () => {
            const { reports } = await listDailyReports(client, 60);
            const hit = reports.find((r) => dayOf(r.original_date) === rest);
            if (!hit) throw new Error(`no report for ${rest}`);
            return reportDetailLines(hit, palette, cols);
          });
          return;
        }
        if (/^\d+$/.test(rest)) {
          const n = Number(rest);
          const list = reportsRef.current;
          if (!list.length) return note("open /reports first, then pick a number");
          const hit = list[n - 1];
          if (!hit) return note(`there ${list.length === 1 ? "is" : "are"} ${list.length} in the list`);
          const day = dayOf(hit.original_date);
          openView(`reports:${day}`, `report · ${day}`, reportDetailLines(hit, palette, cols), {
            cmd: `/reports ${day}`,
          });
          return;
        }
        return note("usage: /reports [YYYY-MM-DD | <number from the list>]");
      }
      case "/signals": {
        const cur = tab.key === "signals" ? (tab.weekOffset ?? 0) : 0;
        if (!rest) return openWeek(tab.key === "signals" ? cur : 0);
        if (rest === "latest") {
          openView("signals:latest", "latest read", fullReadLines(home?.latest ?? null, palette, cols));
          return;
        }
        if (rest === "last" || rest === "prev" || rest === "older") return openWeek(cur + 1);
        if (rest === "next" || rest === "newer") return openWeek(cur - 1);
        if (/^\d+$/.test(rest)) return openWeek(Number(rest));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(rest)) return note("usage: /signals [last | next | <weeks ago> | YYYY-MM-DD | latest]");
        await view(`signals:${rest}`, `signals · ${rest}`, async () => daySignalsLines(rest, await listDayEvents(client, rest), palette, cols));
        return;
      }
      case "/read":
        await view("read", "read · last 7 days", async () => readLines(await listEmotionalReports(client, 7), palette, cols));
        return;
      case "/decisions":
        await view("decisions", "decisions", async () => decisionLines(await listDecisions(client, 15), palette, cols));
        return;
      case "/reminders":
        await view("reminders", "reminders", async () => reminderLines(await listReminders(client), palette, cols));
        return;
      case "/insights":
      case "/realizations":
        await view("realizations", "realizations", async () => realizationLines(await listRealizations(client, 15), palette, cols));
        return;
      case "/world":
        if (rest === "add" || rest === "new") return openWorldAdd();
        if (rest) return note("usage: /world [add]");
        await view("world", "your world", async () => worldLines(await listLifeModel(client), palette, cols));
        return;
      default:
        note(`unknown command ${name} — /help lists them`);
    }
  }

  // ── input ──────────────────────────────────────────────────────────────────
  const slash = useSlashMenu(HOME_COMMANDS, input, setInput, mode === "input" && !busy && draft.length === 0);

  function submit(value: string) {
    if (!visible) return; // not the surface in front — nothing typed here is meant for it
    setInput("");
    if (busy) {
      note("one moment — still working on the last thing");
      return;
    }
    // A trailing backslash keeps writing on the next line: terminals have no reliable
    // Shift+Enter, and a check-in is often more than one line.
    if (value.endsWith("\\")) {
      setDraft((d) => [...d, value.slice(0, -1)]);
      return;
    }
    const text = [...draft, value].join("\n").trim();
    setDraft([]);
    if (!text) return;
    if (text.startsWith("/") && draft.length === 0) {
      void command(text);
      return;
    }
    if (screen) goHome(); // a check-in belongs on Home, where its read will appear
    void pulse(text);
  }

  // ── the pane ───────────────────────────────────────────────────────────────
  const lines = useMemo(() => {
    if (screen) return screen.lines;
    const out = headerLines(home, palette, cols, now);
    for (const n of notes) out.push(...n.lines);
    return out;
  }, [screen, home, notes, palette, cols, now]);
  const pane = useScrollPane(lines, rows);
  const restoreScrollRef = useRef<number | null>(null);
  useEffect(() => {
    if (restoreScrollRef.current === null || !lines.length) return;
    pane.scrollTo(restoreScrollRef.current);
    restoreScrollRef.current = null;
  }, [lines, pane]);
  stateRef.current = { tabs, active, draft, input, scroll: { top: pane.start, follow: pane.follow } };
  // Keep Root's copy of the strip current, so the chat tab draws the same one.
  const titles = useMemo(() => tabs.map((t) => t.title), [tabs]);
  useEffect(() => {
    onTabsChange?.(titles, active);
  }, [titles, active, onTabsChange]);

  // Same trick as registerSave: register once, and read the tab count off the ref at call time so
  // the callback Root holds does not go stale as tabs open and close.
  const focusRef = useRef<(edge: "first" | "last") => void>(() => {});
  focusRef.current = (edge) => {
    setActive(edge === "last" ? Math.max(0, tabs.length - 1) : 0);
    pane.setFollow(true);
  };
  useEffect(() => {
    registerFocus?.((edge) => focusRef.current(edge));
  }, [registerFocus]);

  const noteRef = useRef<(text: string) => void>(() => {});
  noteRef.current = note;
  useEffect(() => {
    registerNote?.((text) => noteRef.current(text));
  }, [registerNote]);

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") {
      quit();
      return;
    }
    if (mode !== "input") return;
    if (slash.onKey(key)) return; // Tab completes while the menu is open
    if (key.tab) return switchTab(key.shift ? -1 : 1);
    if (key.escape && screen) return closeTab();
    // ← → page the signals tab's weeks — only with the input empty, where the cursor has
    // nowhere to go anyway.
    if (input === "" && tab.key === "signals" && (key.leftArrow || key.rightArrow)) {
      void openWeek((tab.weekOffset ?? 0) + (key.leftArrow ? 1 : -1));
      return;
    }
    if (key.upArrow) return pane.scrollBy(-1);
    if (key.downArrow) return pane.scrollBy(1);
    if (key.pageUp) return pane.scrollBy(-(pane.paneH - 1));
    if (key.pageDown) return pane.scrollBy(pane.paneH - 1);
  }, { isActive: visible });

  const closeOverlay = () => {
    setForm(null);
    setMode("input");
  };

  // Hidden means RENDER NOTHING, not "render off-screen". Home stays mounted while the chat tab
  // is up — that is what keeps its tabs, scroll and half-written check-in — but a mounted input
  // box is a live input box: with both surfaces drawn, every key typed in chat also landed in
  // Home's field, and Enter sent it as a check-in. The component keeps its state either way.
  if (!visible) return null;

  return (
    <Box flexDirection="column" width={cols} height={Math.max(4, rows - 1)}>
      <TopBar
        title="Home"
        tabs={[...titles, "chat"]}
        active={active}
        above={pane.above}
        palette={palette}
        subtitle="Tab switches · Esc closes"
        working={reading > 0 ? (reading === 1 ? "reading your check-in" : `reading ${reading} check-ins`) : undefined}
        flash={flash ?? undefined}
        timer={liveTimer ? timerChip(liveTimer, now) + (timers.length > 1 ? ` +${timers.length - 1}` : "") : undefined}
        timerRunning={liveTimer?.status === "running"}
      />
      <Box ref={pane.paneRef} flexDirection="column" flexGrow={1} overflow="hidden">
        {pane.visible.map((l, i) => (
          <Text key={pane.start + i} wrap="truncate-end">{l || " "}</Text>
        ))}
      </Box>

      {visible && mode === "habit" && home && (
        <HabitPick
          habits={home.habits}
          pickFor={pickFor}
          onPick={(h) => {
            if (pickFor === "tick") return pickHabit(h);
            setMode("input");
            if (pickFor === "edit") void openEditHabit(h);
            else openRemoveHabit(h);
          }}
          onCancel={closeOverlay}
        />
      )}
      {visible && mode === "form" && form && (
        <Form
          title={form.title}
          steps={form.steps}
          onDone={(v) => {
            closeOverlay();
            void form.onDone(v);
          }}
          onCancel={() => {
            closeOverlay();
            note("cancelled");
          }}
        />
      )}
      {visible && mode === "theme" && (
        <ThemePicker
          onDone={(synced) => {
            setMode("input");
            note(synced ? "theme synced to dashboard" : "theme saved locally — sync unavailable");
          }}
          onCancel={() => setMode("input")}
        />
      )}

      {visible && mode === "input" && (
        <Box flexDirection="column">
          {pane.hidden > 0 && (
            <Text color={palette.dim}>{`  ▼ ${pane.hidden} more row${pane.hidden === 1 ? "" : "s"} below · ↓ or PgDn to scroll`}</Text>
          )}
          {draft.map((d, i) => (
            <Text key={i} color={palette.dim}>{`  │ ${d}`}</Text>
          ))}
          <Text>
            <Text color={home ? palette.success : palette.warning}>{"● "}</Text>
            {ACTIVE_PROFILE !== "default" && <Text color={palette.accent} bold>{`[${ACTIVE_PROFILE}] `}</Text>}
            <Text color={palette.accent}>{cfg.auth?.email ?? "not signed in"}</Text>
            <Text color={palette.dim}>{screen ? `  ·  ${screen.title}  ·  Tab switches · Esc closes · /home` : `  ·  ${webUrl(cfg).replace(/^https?:\/\//, "")}  ·  /chat opens the chat  ·  /help`}</Text>
            {busy && (
              <Text color={palette.dim}>
                {"   "}
                <Text color={palette.accent}><Spinner type="dots" /></Text>
                {` ${busy}…`}
              </Text>
            )}
          </Text>
          <Box borderStyle="round" borderColor={palette.accent} paddingX={1} width="100%">
            <Text color={palette.accent}>{"❯ "}</Text>
            <TextInput
              value={input}
              onChange={(v) => {
                setInput(v);
                slash.onEdit();
              }}
              onSubmit={submit}
              placeholder={draft.length ? "keep writing — Enter on its own sends" : "what's on your mind…   (end a line with \\ to keep writing · /help)"}
            />
          </Box>
          {slash.show && <SlashMenu suggestions={slash.suggestions} active={slash.active} palette={palette} />}
        </Box>
      )}
    </Box>
  );
}
