import { type CoenConfig, webUrl } from "./config.js";
import { currentToken } from "./auth.js";

/**
 * Home's HTTP client: the web app's own /api routes, with the signed-in person's Bearer token.
 * Same shape as coen1-mobile/src/lib/api.ts. Two routes are the CLI's own (/api/cli/home and
 * /api/cli/thought-dump, see coen1-web/src/app/api/cli); everything else is what the dashboard
 * calls.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown = null,
  ) {
    super(message);
  }
}

export interface Client {
  cfg: CoenConfig;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string, body?: unknown): Promise<T>;
}

const SIGNED_OUT = "not signed in — run `coen login`";

export function createClient(cfg: CoenConfig, onAuthChange?: (auth: NonNullable<CoenConfig["auth"]>) => void): Client {
  const client: Client = {
    cfg,
    get: (p) => request("GET", p),
    post: (p, b) => request("POST", p, b),
    put: (p, b) => request("PUT", p, b),
    patch: (p, b) => request("PATCH", p, b),
    del: (p, b) => request("DELETE", p, b),
  };

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await currentToken(client.cfg, (auth) => {
      client.cfg = { ...client.cfg, auth };
      onAuthChange?.(auth);
    });
    if (!token) throw new ApiError(401, SIGNED_OUT);
    let res: Response;
    try {
      res = await fetch(`${webUrl(client.cfg)}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      const msg = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
        ? `no answer from ${webUrl(client.cfg)} after 20s`
        : `couldn't reach ${webUrl(client.cfg)} — ${e instanceof Error ? e.message : String(e)}`;
      throw new ApiError(0, msg);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      if (res.status === 401) throw new ApiError(401, "session expired — run `coen login`", data);
      // A 404 on one of the CLI's own routes means the server is older than this CLI — the
      // routes live in coen1-web (src/app/api/cli). Say so, rather than showing a bare 404 that
      // looks like a bug in the terminal.
      if (res.status === 404 && path.startsWith("/api/cli/")) {
        throw new ApiError(
          404,
          `${webUrl(client.cfg)} doesn't have the CLI routes (404 ${path}).\n` +
            "  Point at a server that does:\n" +
            "    coen config set-web <url>    (or COEN_WEB_URL=…)",
          data,
        );
      }
      const err = (data as { error?: string } | null)?.error;
      throw new ApiError(res.status, err || `${method} ${path} failed (${res.status})`, data);
    }
    return data as T;
  }

  return client;
}

// ─── shapes (the fields Home reads; the routes return more) ─────────────────

export interface HomeHabit {
  metric_key: string;
  metric_name: string;
  group_name: string | null;
  aggregation_type: "max" | "sum";
  habit_target: number;
  /** In play today. False = still tickable, as a bonus that never extends a streak. */
  scheduled_today: boolean;
  today_value: number;
  done_today: boolean;
  /** Non-null: this habit asks a question, and the answer IS the completion. */
  habit_prompt: string | null;
  /** Numbers the habit asks for on tick. Empty for almost every habit. */
  habit_measures: HabitMeasure[];
  is_routine: boolean;
  streak: number;
  /** Non-null means this habit runs a clock: a `sum` habit of minutes with a session length.
   *  Ticking it starts the timer rather than crediting the whole target in one go. */
  habit_timer_minutes: number | null;
  habit_pomodoro: unknown | null;
  description: string | null;
  unit?: string | null;
  /** Weekdays, 0 = Sunday … 6 = Saturday, repeating every habit_interval_weeks. */
  habit_days: number[];
  habit_interval_weeks: number;
  habit_schedule_type: "days" | "times_per_week" | "times_per_month";
  habit_period_target: number | null;
  period_done?: number;
}

export interface LatestRead {
  signals: Record<string, number>;
  created_at: string;
  type: string;
  source: string | null;
  extraction_id: string | null;
  journal: { id: string; entry_text: string } | null;
}

/** One day's read in the past-week block: the daily report's markers, cleaned. */
export interface DayRead {
  /** The report's period start, an ISO timestamp — the local date is derived in the CLI. */
  day: string;
  sample_size: number;
  signals: Record<string, number>;
}

/** A number a habit asks for as it is completed — resolved by the server, bounds and all. */
export interface HabitMeasure {
  metric_key: string;
  metric_name: string;
  required: boolean;
  unit: string;
  min: number | null;
  max: number | null;
  decimals: number;
  today_value?: number | null;
}

/**
 * A habit timer that is running or paused. THE SERVER IS THE CLOCK: `elapsed_seconds` is the
 * total of finished segments and `resumed_at` non-null means one is open right now, so live
 * elapsed is elapsed_seconds + (now - resumed_at). Nothing here is a duration the CLI invented —
 * it sends intents (start, pause, resume, complete) and never a time.
 */
export interface TimerSession {
  id: string;
  metric_key: string;
  habit_name: string | null;
  status: "running" | "paused";
  mode: "stopwatch" | "pomodoro";
  started_at: string;
  elapsed_seconds: number;
  resumed_at: string | null;
  target_seconds: number | null;
  phase: string;
  phase_seconds: number | null;
  pomodoros_completed: number;
  unit: string;
}

export interface HomeData {
  checkIn: { firstName: string; lastCheckIn: string | null; streakDays: number; checkedInToday: boolean };
  latest: LatestRead | null;
  /** The last seven days' daily reads, oldest first. Days with no read are absent. */
  week: DayRead[];
  habits: HomeHabit[];
  /** Timers running or paused right now — started here, on the phone or in the browser. */
  timers: TimerSession[];
  timezone: string;
}

export interface PulseEvent {
  id: string;
  /** Derived from the event TYPE, not from any progress the row records: a
   *  thought_dump_submitted event is always "pending" and is the only kind that carries an
   *  extraction_id. Do not use this to decide that a read landed — watch HomeData.latest. */
  status: "pending" | "success" | "extraction_complete" | "error";
  extraction_id?: string;
  error?: string;
  created_at: string;
}

export interface JournalEntry {
  id: string;
  source: string;
  entry_text: string;
  event_date: string;
  created_at: string;
  has_signals: boolean;
  /** This entry's own read (marker → score); present when asked for with signals=1. */
  signals?: Record<string, number>;
}

/** One check-in's read on a given day, from /api/emotional-matrix/day-events. */
export interface DayEvent {
  id: string;
  timestamp: string;
  source: string;
  marker_count: number;
  top_positive: { marker: string; value: number }[];
  top_negative: { marker: string; value: number }[];
}

export interface Decision {
  id: string;
  title: string;
  decision_type: string;
  status: string;
  description: string | null;
  rationale: string | null;
  decision_date: string | null;
  created_at: string;
}

export interface Realization {
  id: string;
  title: string | null;
  content: string;
  tags: string[];
  created_at: string;
}

export interface Reminder {
  id: string;
  content: string;
  attribution: string | null;
  tags: string[];
  is_pinned: boolean;
  is_active: boolean;
  created_at: string;
}

export interface EmotionalReport {
  report_period_start: string;
  sample_size: number;
  emotional_averages: Record<string, unknown>;
}

/** One day's activity report — what the worker wrote up about the day (coen1-web /activity). */
export interface DailyReport {
  id: number;
  report_key: string;
  title: string | null;
  summary: string | null;
  report_text: string | null;
  conclusion: string | null;
  next_steps: string | null;
  metadata: Record<string, unknown> | null;
  original_date: string;
  created_at: string;
}

export interface ThemePref {
  themeMode?: string;
  colorScheme?: string;
  customTheme?: { brandPrimary?: string } | null;
  autoDarkMode?: boolean;
}

// ─── calls ───────────────────────────────────────────────────────────────────

export const getHome = (c: Client) => c.get<HomeData>("/api/cli/home");

export const submitPulse = (c: Client, text: string) =>
  c.post<{ status: string; extractionId: string }>("/api/cli/thought-dump", { text });

export const getPulseEvents = async (c: Client) =>
  (await c.get<{ latestEvents: PulseEvent[] }>("/api/thought-dump/status")).latestEvents ?? [];

export const getHabits = async (c: Client) =>
  (await c.get<{ habits: HomeHabit[] }>("/api/habits?include=habits")).habits ?? [];

export const tickHabit = (
  c: Client,
  key: string,
  body: { answer?: string; value?: number; measures?: Record<string, number> } = {},
) => c.post<{ habit?: HomeHabit }>(`/api/habits/${encodeURIComponent(key)}/tick`, body);

/** A number a habit collects while it is being completed, however it is completed. */
export interface NewHabitMeasure {
  /** An existing metric to write into. Derived from metric_name when absent. */
  metric_key?: string;
  /** Naming it creates it; naming nothing links to metric_key as it stands. */
  metric_name?: string;
  unit?: string;
  min?: number | null;
  max?: number | null;
  decimals?: number;
  required?: boolean;
  aggregation_type?: "average" | "sum" | "min" | "max";
}

/**
 * Everything POST /api/habits accepts.
 *
 * The route has taken all of this for a while; the CLI only ever sent the first eight fields, so
 * a habit added from the terminal could not run a clock, could not be scheduled by the week, and
 * — the one that actually costs something — arrived with no `keywords`, which is what the
 * detector matches a check-in against to tick it for you. Names here are the route's own.
 */
export interface NewHabit {
  metric_name: string;
  description?: string;
  aggregation_type: "max" | "sum";
  habit_target?: number;
  unit?: string;
  habit_prompt?: string;
  group_name?: string;
  /** Weekdays, 0 = Sunday. Read only when habit_schedule_type is "days". */
  habit_days?: number[];
  habit_interval_weeks?: number;
  habit_schedule_type?: "days" | "times_per_week" | "times_per_month";
  /** How many times in the period, for the two times_per_* schedules. */
  habit_period_target?: number;
  /** A timed habit: the same `sum` row with a session length, in minutes (1–1440). */
  habit_timer_minutes?: number;
  /** Any field left out takes its default (25 / 5 / 15 / 4). */
  habit_pomodoro?: { work_minutes?: number; break_minutes?: number; long_break_minutes?: number; cycle?: number };
  habit_measures?: NewHabitMeasure[];
  /** What the AI detector matches a thought dump against to auto-tick this. Not decoration. */
  keywords?: string[];
  extraction_hint?: string;
}

/**
 * Everything PATCH /api/habits/[key] accepts, minus `habit_measures`.
 *
 * Names are the route's own, the same rule NewHabit follows. Every field is optional and the
 * route validates the MERGED result rather than the fields it was sent, so changing one thing
 * is a one-field body — it will not trip a rule about a field the caller never mentioned.
 *
 * `null` is meaningful on three of these: it clears the description, the question and the
 * clock. Anything left out is left alone.
 */
export interface HabitPatch {
  metric_name?: string;
  description?: string | null;
  group_name?: string;
  habit_target?: number;
  unit?: string;
  aggregation_type?: "max" | "sum";
  /** null turns the question off. */
  habit_prompt?: string | null;
  /** null stops the clock; clearing it clears the pomodoro rhythm too. */
  habit_timer_minutes?: number | null;
  habit_pomodoro?: { work_minutes?: number; break_minutes?: number; long_break_minutes?: number; cycle?: number } | null;
  habit_days?: number[];
  habit_interval_weeks?: number;
  habit_anchor_date?: string | null;
  habit_schedule_type?: "days" | "times_per_week" | "times_per_month";
  habit_period_target?: number;
  /** What the AI detector matches a check-in against to tick this. [] means nothing auto-ticks it. */
  keywords?: string[];
  extraction_hint?: string | null;
}

/**
 * One habit as GET /api/habits/[key] returns it.
 *
 * The reason to call this rather than read the habit off /api/habits: `calculation_config`
 * carries the keywords, and `display_config` carries the unit. Neither is in the list route's
 * rows, so anything that edits or reports on a habit's DEFINITION has to come here.
 */
export interface HabitDetail {
  metric_key: string;
  metric_name: string;
  description: string | null;
  group_name: string | null;
  aggregation_type: "max" | "sum";
  habit_target: number;
  habit_days: number[];
  habit_interval_weeks: number;
  habit_schedule_type: "days" | "times_per_week" | "times_per_month";
  habit_period_target: number | null;
  habit_anchor_date: string | null;
  habit_timer_minutes: number | null;
  habit_pomodoro: unknown | null;
  habit_prompt: string | null;
  is_routine: boolean;
  routine_key: string | null;
  calculation_config: { keywords?: string[]; extraction_hint?: string } | null;
  display_config: { unit?: string } | null;
}

export const createHabit = (c: Client, body: NewHabit) => c.post<{ habit?: HomeHabit }>("/api/habits", body);

/** One habit in full, definition included. `days` only changes how much series comes back. */
export const getHabit = async (c: Client, key: string, days?: number) =>
  (await c.get<{ habit: HabitDetail }>(
    `/api/habits/${encodeURIComponent(key)}${days ? `?days=${days}` : ""}`,
  )).habit;

/** Change a habit's definition. The route's refusals are already sentences — pass them through. */
export const updateHabit = (c: Client, key: string, body: HabitPatch) =>
  c.patch<{ habit: HabitDetail }>(`/api/habits/${encodeURIComponent(key)}`, body);

/**
 * Archive a habit. Not destroy: the event history stays, and creating the habit again with the
 * same name un-archives it with that history intact — which is the only restore path there is.
 *
 * `archived_keys` is every row that went: a routine takes its steps with it.
 */
export const archiveHabit = (c: Client, key: string) =>
  c.del<{ archived: boolean; metric_key: string; archived_keys: string[] }>(
    `/api/habits/${encodeURIComponent(key)}`,
  );

// ── habit timers ─────────────────────────────────────────────────────────────
const timerPath = (key: string) => `/api/habits/${encodeURIComponent(key)}/timer`;

export const listTimers = async (c: Client) =>
  (await c.get<{ sessions: TimerSession[] }>("/api/habits/timer")).sessions ?? [];

/** Start the clock. Length and rhythm default to the habit's own. */
export const startTimer = async (c: Client, key: string, body: { minutes?: number } = {}) =>
  (await c.post<{ session: TimerSession }>(timerPath(key), body)).session;

/** pause · resume · skip_phase — intents only, never a duration. */
export const timerAction = async (c: Client, key: string, action: "pause" | "resume" | "skip_phase") =>
  (await c.patch<{ session: TimerSession }>(timerPath(key), { action })).session;

/** Finish: ticks the habit with the minutes actually run. */
export const completeTimer = async (
  c: Client,
  key: string,
  body: { note?: string; journal?: boolean; measures?: Record<string, number> } = {},
) =>
  (await c.post<{ session: TimerSession }>(`${timerPath(key)}/complete`, body)).session;

/** Throw the session away — nothing is logged. */
export const discardTimer = (c: Client, key: string) => c.del<unknown>(timerPath(key));

/** Write down a session you already did, with no clock involved. */
export const logTimer = (c: Client, key: string, minutes: number, note?: string) =>
  c.post<unknown>(`${timerPath(key)}/log`, { minutes, ...(note ? { note } : {}) });

export const untickHabit = (c: Client, key: string) =>
  c.del<unknown>(`/api/habits/${encodeURIComponent(key)}/tick`, {});

export const listDecisions = async (c: Client, limit = 20, page = 1) =>
  (await c.get<{ decisions: Decision[] }>(
    `/api/decisions?page=${page}&page_size=${limit}&sort=decision_date&order=desc`,
  )).decisions ?? [];

export const createDecision = (
  c: Client,
  body: { title: string; decision_type: string; description?: string; rationale?: string; context?: string },
) => c.post<{ decision?: Decision }>("/api/decisions", { ...body, source: "cli" });

export const listRealizations = async (c: Client, limit = 20, offset = 0) =>
  (await c.get<{ posts: Realization[] }>(
    `/api/pattern-log/posts?post_type=realization&limit=${limit}&offset=${offset}`,
  )).posts ?? [];

export const createRealization = (c: Client, body: { title: string; content: string; tags?: string[] }) =>
  c.post<{ post?: Realization }>("/api/pattern-log/posts", { ...body, post_type: "realization", source: "cli" });

export const listReminders = async (c: Client) =>
  (await c.get<{ reminders: Reminder[] }>("/api/reminders")).reminders ?? [];

export const createReminder = (c: Client, body: { content: string; attribution?: string }) =>
  c.post<{ reminder?: Reminder }>("/api/reminders", body);

export const listJournal = async (c: Client, opts: { limit?: number; day?: string; offset?: number } = {}) => {
  // The route pages with limit+offset (capped at 500) and ignores both when `day` is given.
  const q = opts.day ? `day=${opts.day}` : `limit=${opts.limit ?? 20}&offset=${opts.offset ?? 0}`;
  return (await c.get<{ entries: JournalEntry[] }>(`/api/journal?${q}&signals=1`)).entries ?? [];
};

export const listDayEvents = async (c: Client, day: string) =>
  (await c.get<{ events: DayEvent[] }>(`/api/emotional-matrix/day-events?date=${day}`)).events ?? [];

/** Daily reports whose period falls inside [start, end) — the signals tab's week. */
export const listReportsBetween = async (c: Client, startIso: string, endIso: string) =>
  (await c.get<{ reports: EmotionalReport[] }>(
    `/api/emotional-matrix?report_type=daily&start_date=${encodeURIComponent(startIso)}&end_date=${encodeURIComponent(endIso)}&sort=report_period_start&order=asc`,
  )).reports ?? [];

export const listEmotionalReports = async (c: Client, days = 7) => {
  const start = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return (await c.get<{ reports: EmotionalReport[] }>(`/api/emotional-matrix?start_date=${start}`)).reports ?? [];
};

/**
 * Daily activity reports, newest first. `pending` is the number of days that have evidence but no
 * report yet — the same progress count the web's reports page shows, and worth repeating here so
 * an empty-looking list doesn't read as "nothing happened".
 */
export const listDailyReports = (c: Client, limit = 20, offset = 0) =>
  c.get<{ reports: DailyReport[]; total: number; pending: number }>(
    `/api/activity/daily-reports?limit=${limit}&offset=${offset}`,
  );

/** The dashboard's theme row, or null when the person never set one. */
export const getTheme = async (c: Client): Promise<ThemePref | null> => {
  const r = await c.get<{ preference: { preference_value: ThemePref } | null }>("/api/user/preferences?key=theme");
  return r.preference?.preference_value ?? null;
};

/** Write the colour scheme back without disturbing the other theme fields. */
export const putThemeScheme = async (c: Client, colorScheme: string): Promise<void> => {
  const existing = (await getTheme(c).catch(() => null)) ?? {};
  await c.put("/api/user/preferences", { key: "theme", value: { ...existing, colorScheme, customTheme: null } });
};

// ─── the reads the MCP server used to own ────────────────────────────────────
// These five had no call here because only the Coen MCP server ever asked for them. The tool
// registry (src/coen-tools) needs them, so they land where every other route already lives.

/** A number that is tracked but is not a habit — sleep, weight, a reading. */
export interface Metric {
  metric_key: string;
  metric_name: string;
  metric_category: string | null;
  aggregation_type: "max" | "sum" | null;
  description: string | null;
  is_habit: boolean;
  archived: boolean | null;
  /** The unit lives in display_config, not a column of its own — see unitOf. */
  display_config: { unit?: string | null } | null;
  last_report_at?: string | null;
}

/** A metric's unit, from wherever the row happens to carry it. */
export const unitOf = (m: Metric): string | null => m.display_config?.unit ?? null;

/** Someone or something that recurs in the person's writing. `status` "inferred" is Coen's guess. */
export interface LifeModelEntity {
  slug: string;
  label: string;
  entity_type: string;
  relation: string | null;
  theme: string | null;
  aliases: string[] | null;
  status: string;
  user_note: string | null;
  first_seen: string | null;
  last_seen: string | null;
  mention_days: number;
  aspects: unknown;
}

/** A pattern the person stated themselves, with the quote and the day they said it. */
export interface StatedLink {
  stated_key: string;
  said_on: string;
  line: string;
  quote: string | null;
  source: string | null;
  note: string | null;
}

/** The rolling status signal — the inputs behind it, not a verdict we recompute. */
export interface PersonalStatus {
  you: {
    status: string;
    drivers: string[];
    coverage: { streakDays?: number; lastCheckIn?: string | null; dataSpanDays: number | null; recentReportDays: number };
    sentiment?: Record<string, unknown> | null;
  };
  calculatedAt: string | null;
}

/** Every metric on the account. `unattached` narrows it to the numbers no habit owns. */
export const listMetrics = async (c: Client, opts: { unattached?: boolean } = {}) =>
  (await c.get<{ metrics: Metric[] }>(`/api/metrics${opts.unattached ? "?unattached=true" : ""}`)).metrics ?? [];

/**
 * One metric's readings, newest first — the series behind a habit or a number.
 *
 * These are the per-period rows the metric-processor writes (account_metric_event), aliased by
 * the route: `value` is calculated_value and `event_date` is report_period_start. A habit's row
 * exists for every day it was SCHEDULED, so a day it was not done is a row with
 * `metadata.zero_filled` — the absence, written down. Anything listing what someone actually did
 * has to skip those; see `isTick`.
 */
export interface MetricEvent {
  metric_key: string;
  metric_name: string;
  value: number;
  event_date: string;
  source: string | null;
  unit: string | null;
  created_at: string;
  sample_size?: number | null;
  metadata?: { habit?: boolean; zero_filled?: boolean; scheduled?: boolean; source?: string } | null;
}

/** Did something actually happen on this row, or is it the record of a day that didn't? */
export const isTick = (e: MetricEvent): boolean => !e.metadata?.zero_filled && Number(e.value) !== 0;

export const listMetricEvents = async (
  c: Client,
  opts: { metric_key?: string; start_date?: string; end_date?: string; limit?: number } = {},
) => {
  const q = new URLSearchParams();
  if (opts.metric_key) q.set("metric_key", opts.metric_key);
  if (opts.start_date) q.set("start_date", opts.start_date);
  if (opts.end_date) q.set("end_date", opts.end_date);
  q.set("limit", String(opts.limit ?? 50));
  return (await c.get<{ events: MetricEvent[] }>(`/api/metrics/events?${q}`)).events ?? [];
};

/** Append a reading. The metric's own aggregation resolves the day. */
export const logMetricEvent = (
  c: Client,
  body: { metric_key: string; value: number; event_date?: string; source?: string },
) => c.post<{ success: boolean }>("/api/metrics/events", { source: "cli", ...body });

/** People and things, hidden ones included — the person must be able to see what they hid. */
export const listLifeModel = async (c: Client) =>
  (await c.get<{ entities: LifeModelEntity[] }>("/api/insights/life-model")).entities ?? [];

/** Correct one entity. Touching label/relation/user_note marks it corrected; status sets it outright. */
export const patchLifeModel = async (
  c: Client,
  body: { slug: string; status?: string; label?: string; relation?: string; user_note?: string },
) => (await c.patch<{ entity: LifeModelEntity }>("/api/insights/life-model", body)).entity;

/**
 * Name something yourself, before Coen has met it.
 *
 * The row lands as the person's own words, so the engine may keep accumulating evidence about it
 * (how many days it shows up, when it was last seen) but may never rewrite what they called it.
 * Adding something that already exists corrects it rather than failing.
 */
export const createLifeModelEntity = async (
  c: Client,
  body: { label: string; entity_type?: string; relation?: string; user_note?: string; aliases?: string[] },
) => (await c.post<{ entity: LifeModelEntity }>("/api/insights/life-model", body)).entity;

/** Links the person drew themselves. Their theory, not the engine's. */
export const listStatedLinks = async (c: Client) =>
  (await c.get<{ reads: StatedLink[] }>("/api/insights/your-words")).reads ?? [];

/** The free-text profile, in their words. */
export const getAccountProfile = async (c: Client) =>
  (await c.get<{ accountProfile: string | null }>("/api/account-profile")).accountProfile ?? null;

/** The rolling baseline behind the status signal. */
export const getPersonalStatus = (c: Client) => c.get<PersonalStatus>("/api/personal-status");
