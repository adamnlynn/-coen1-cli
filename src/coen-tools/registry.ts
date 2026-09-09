import { z } from "zod";
import * as api from "../api.js";
import { readMatrix, composites } from "../markers.js";
import { dayOf, today, DATE_RE } from "../day.js";
import { webUrl } from "../config.js";
import { listSessions, loadSession, saveSession } from "../sessions.js";
import { type ToolContext, fail } from "./context.js";
import { buildSnapshot } from "./snapshot.js";

/**
 * Coen's tools, in one place.
 *
 * These used to be served remotely and reached with a separate long-lived API key. That path is
 * retired. They are the CLI's now: each one is a call to the web app's REST API with the signed-in
 * person's token — the same routes the dashboard and the phone use. The descriptions are carried
 * over unchanged, because they are what the calling model reads.
 *
 * Three things consume this registry and nothing else defines a tool:
 *   - chat, through ai-tools.ts
 *   - other local agents over stdio, through serve-stdio.ts
 *   - other local agents over loopback HTTP, through the daemon
 *
 * `scope` is what makes a tool a write. It used to be fetched from a remote /catalog; it is a
 * field here, so the confirm-before-writing gate is exact rather than a guess at the name.
 */

export type ToolScope = "read" | "log";

export interface CoenTool {
  scope: ToolScope;
  description: string;
  /** A ZodObject, not a bare schema: the AI SDK takes the whole thing, the MCP SDK takes its
   *  `.shape`. Both adapters read this one field. */
  input: z.ZodObject<z.ZodRawShape>;
  /** Returns whatever the tool has to say. A string is passed through; anything else is JSON. */
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
  /** This one takes something away. Only archive_habit, and only so the MCP adapter can say so
   *  in its annotations — an external client gets no confirm prompt, just the hint. */
  destructive?: boolean;
}

// What Coen 1 is, in the same words the server uses. This used to be carried by a `define_agent`
// tool, which went when the remote agent-key path was retired — but the paragraph still belongs
// somewhere, so whoami carries it.
export const COEN_PURPOSE =
  "Coen 1 is personal intelligence for a better life — it reads what shapes how someone feels. " +
  "The premise is that you don't have to know how you feel: a slider can only take an answer you " +
  "already have, and not being able to locate the feeling is the exact problem. So Coen reads the " +
  "exhaust of how someone already works and lives — their own words, voice notes, decisions, " +
  "habits, numbers, and the apps and AI tools they already use — and works out the rest. It names " +
  "their emotional and cognitive state from what they actually wrote, and lines it up against their " +
  "behaviour to show what has genuinely been moving their mood, including which of their " +
  "assumptions did not hold up. Your job as an agent connected to Coen is to help with that: log " +
  "their activity and decisions honestly, surface what their state and patterns reveal, and " +
  "reflect it back plainly — without flattering or alarming them. Never invent a pattern to fill a " +
  "space; 'still forming' is a real and preferable answer. No scores, no streak guilt, no nagging.";

// ─── helpers ─────────────────────────────────────────────────────────────────

const clamp = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const checkDate = (d: unknown, field = "date"): string | undefined => {
  if (d == null || d === "") return undefined;
  if (typeof d !== "string" || !DATE_RE.test(d)) fail(`\`${field}\` must be YYYY-MM-DD.`);
  return d as string;
};

const isoDaysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/** A habit by key or exact name, the way the MCP server's findMetric did. */
export async function findHabit(ctx: ToolContext, keyOrName: string): Promise<api.HomeHabit> {
  const habits = await api.getHabits(ctx.client);
  const needle = keyOrName.trim().toLowerCase();
  const hit =
    habits.find((h) => h.metric_key.toLowerCase() === needle) ??
    habits.find((h) => h.metric_name.trim().toLowerCase() === needle);
  if (!hit) fail(`No habit matches "${keyOrName}". Call get_habits with no arguments to see the keys.`);
  return hit!;
}

/** A metric by key or exact name — habits included, since a habit is a metric with is_habit. */
export async function findMetric(ctx: ToolContext, keyOrName: string): Promise<api.Metric> {
  const metrics = await api.listMetrics(ctx.client);
  const needle = keyOrName.trim().toLowerCase();
  const hit =
    metrics.find((m) => m.metric_key.toLowerCase() === needle) ??
    metrics.find((m) => m.metric_name.trim().toLowerCase() === needle);
  if (!hit) fail(`No metric matches "${keyOrName}". Call get_metrics (or get_habits) to see the keys.`);
  return hit!;
}

/**
 * The key the server will derive from a habit's name. A copy of toMetricKey in
 * coen1-web/src/lib/habits.ts, and only used to spot a name that is already taken before
 * POST /api/habits answers 409 — so a drift between the two costs a worse error message and
 * nothing else.
 */
const toMetricKey = (name: string) =>
  name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);

/**
 * Run a habit write and hand the route's own refusal to the model.
 *
 * The habit routes answer in sentences already — "A habit can run a clock or ask a question,
 * not both", "Edit a routine from the Routines page" — so re-wording them here would only make
 * them worse, and re-implementing the rules they enforce would make them wrong.
 */
async function passThrough<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof api.ApiError && e.status >= 400 && e.status < 500) fail(e.message);
    throw e;
  }
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A habit's cadence in words. Same three cases the sync sections render. */
function scheduleWords(h: {
  habit_schedule_type?: string | null;
  habit_period_target?: number | null;
  habit_days?: number[] | null;
  habit_interval_weeks?: number | null;
}): string {
  if (h.habit_schedule_type === "times_per_week") return `${h.habit_period_target ?? "?"}× a week, any days`;
  if (h.habit_schedule_type === "times_per_month") return `${h.habit_period_target ?? "?"}× a month, any days`;
  const days = h.habit_days ?? [];
  const which = days.length === 7 ? "every day" : days.map((d) => DAY_NAMES[d] ?? "?").join(" ") || "no days";
  return (h.habit_interval_weeks ?? 1) > 1 ? `${which}, every ${h.habit_interval_weeks} weeks` : which;
}

/** The definition, as a conversation would describe it. Used by get_habits and the write tools. */
function definitionOf(d: api.HabitDetail) {
  return {
    key: d.metric_key,
    name: d.metric_name,
    description: d.description,
    group: d.group_name,
    kind: d.habit_prompt ? "asks a question" : d.habit_timer_minutes ? "runs a clock" : d.aggregation_type === "sum" ? "an amount a day" : "yes / no",
    target: d.habit_target,
    unit: d.display_config?.unit && d.display_config.unit !== "count" ? d.display_config.unit : null,
    aggregation: d.aggregation_type,
    prompt: d.habit_prompt,
    timer_minutes: d.habit_timer_minutes,
    schedule: scheduleWords(d),
    keywords: d.calculation_config?.keywords ?? [],
    extraction_hint: d.calculation_config?.extraction_hint ?? null,
    is_routine: d.is_routine,
    routine_key: d.routine_key,
  };
}

/**
 * The habit fields a conversation needs, in the shape the MCP server handed back.
 *
 * `unit` is passed in rather than read off the habit: /api/cli/home builds its habit rows from
 * lib/habits.ts listHabits, which resolves a unit for a habit's *measures* but not for the habit
 * itself — that one lives in the metric's display_config. Without it a 120-minute target reads
 * as a bare 120.
 */
function habitLine(h: api.HomeHabit, unit: string | null) {
  return {
    key: h.metric_key,
    name: h.metric_name,
    group: h.group_name,
    scheduled_today: h.scheduled_today,
    done_today: h.done_today,
    today_value: h.today_value,
    target: h.habit_target,
    unit: h.unit ?? unit,
    aggregation: h.aggregation_type,
    streak: h.streak,
    is_routine: h.is_routine,
    prompt: h.habit_prompt,
    schedule: h.habit_schedule_type,
    period_target: h.habit_period_target,
    period_done: h.period_done ?? null,
    description: h.description,
  };
}

// ─── the tools ───────────────────────────────────────────────────────────────

export const TOOLS: Record<string, CoenTool> = {
  // ── READ ───────────────────────────────────────────────────────────────────
  get_life_snapshot: {
    scope: "read",
    description:
      "Where this person is right now, in one call. Call it ONCE per session (a dozen queries). Profile; 7 days of the emotional read (lifting / weighing / worth noticing, above the neutral band); baseline trend; today's habits + streaks; latest journal; people and things they write about; recent decisions, realizations, reminders. Each section has a detail tool. Empty = no record yet, not nothing going on.",
    input: z.object({}),
    handler: (_args, ctx) => buildSnapshot(ctx),
  },

  get_emotional_read: {
    scope: "read",
    description:
      "Daily emotional read, newest first: markers that came through above the neutral band, grouped lifting / weighing / worth noticing with an intensity word, plus composites and burnout risk. What their writing revealed, not a mood they picked. A quiet day is quiet, not bad.",
    input: z.object({
      days: z.number().optional().describe("How many days back (default 14, max 90)."),
    }),
    async handler(args, ctx) {
      const n = clamp(args.days, 14, 1, 90);
      const reports = await api.listReportsBetween(ctx.client, isoDaysAgo(n), new Date().toISOString());
      // Newest first, one row per local day — a day can carry several reports from regenerations
      // and the newest is the one that counts, the same rule the dashboard's overview follows.
      const byDay = new Map<string, api.EmotionalReport>();
      for (const r of reports) byDay.set(dayOf(r.report_period_start), r);
      const days = [...byDay.entries()]
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .map(([day, r]) => ({
          day,
          sample_size: r.sample_size,
          ...composites(r.emotional_averages as Record<string, unknown>),
          ...readMatrix(r.emotional_averages as Record<string, unknown>),
        }));
      return { timezone: await ctx.timezone(), count: days.length, days };
    },
  },

  get_habits: {
    scope: "read",
    description:
      "Active habits with today's state (scheduled, done, target, unit, schedule) and streak. Pass `key` (+ optional `days`) for one habit's day-by-day history instead.",
    input: z.object({
      key: z.string().optional().describe("Optional habit key — returns that habit's history instead of the list."),
      days: z.number().optional().describe("With `key`: days of history (default 30, max 365)."),
    }),
    async handler(args, ctx) {
      const timezone = await ctx.timezone();
      if (args.key) {
        const habit = await findHabit(ctx, String(args.key));
        const n = clamp(args.days, 30, 1, 365);
        const events = await api.listMetricEvents(ctx.client, {
          metric_key: habit.metric_key,
          start_date: dayOf(isoDaysAgo(n)),
          limit: 500,
        });
        // One row per day: `sum` habits add the day's readings up, `max` habits take the largest,
        // which is how the metric's own aggregation resolves a day.
        const byDay = new Map<string, number>();
        for (const e of events) {
          const day = dayOf(e.event_date);
          const prev = byDay.get(day);
          const v = Number(e.value) || 0;
          byDay.set(day, prev == null ? v : habit.aggregation_type === "sum" ? prev + v : Math.max(prev, v));
        }
        const history = [...byDay.entries()]
          .sort((a, b) => (a[0] < b[0] ? 1 : -1))
          .map(([day, value]) => ({ day, value, met_target: value >= habit.habit_target }));
        // The DEFINITION as well as the series. The keywords that auto-tick a habit and its
        // schedule live on the single-habit route, not the list one — and a model asked to
        // change a habit has to be able to read what it is changing from.
        const detail = await api.getHabit(ctx.client, habit.metric_key);
        return {
          ...definitionOf(detail),
          timezone,
          streak: habit.streak,
          history,
        };
      }
      const [rows, metrics] = await Promise.all([
        api.getHabits(ctx.client),
        api.listMetrics(ctx.client).catch(() => [] as api.Metric[]),
      ]);
      const units = new Map(metrics.map((m) => [m.metric_key, api.unitOf(m)]));
      const habits = rows.map((h) => habitLine(h, units.get(h.metric_key) ?? null));
      return { timezone, count: habits.length, habits };
    },
  },

  get_metrics: {
    scope: "read",
    description:
      "Numbers tracked that are not habits (sleep, weight, readings): unit, latest value, recent series.",
    input: z.object({
      days: z.number().optional().describe("Series window in days (default 30, max 365)."),
    }),
    async handler(args, ctx) {
      const n = clamp(args.days, 30, 1, 365);
      const all = await api.listMetrics(ctx.client);
      const plain = all.filter((m) => !m.is_habit && !m.archived);
      const since = dayOf(isoDaysAgo(n));
      const metrics = await Promise.all(
        plain.map(async (m) => {
          const events = await api
            .listMetricEvents(ctx.client, { metric_key: m.metric_key, start_date: since, limit: 200 })
            .catch(() => []);
          return {
            key: m.metric_key,
            name: m.metric_name,
            category: m.metric_category,
            unit: api.unitOf(m),
            aggregation: m.aggregation_type,
            description: m.description,
            latest: events[0] ? { value: Number(events[0].value), day: dayOf(events[0].event_date) } : null,
            series: events.map((e) => ({ day: dayOf(e.event_date), value: Number(e.value) })),
          };
        }),
      );
      return { timezone: await ctx.timezone(), count: metrics.length, metrics };
    },
  },

  get_journal_entries: {
    scope: "read",
    description:
      "Their own words: journal / check-in entries, newest first. Filter by `days`, or `day` (YYYY-MM-DD, local) for everything written that day. Trimmed to `max_chars`. Quote exactly and sparingly.",
    input: z.object({
      limit: z.number().optional().describe("Max entries (default 10, max 50)."),
      days: z.number().optional().describe("Only entries from the last N days."),
      day: z.string().optional().describe("One local day, YYYY-MM-DD (oldest first for that day)."),
      max_chars: z.number().optional().describe("Trim each entry to this many characters (default 1200)."),
    }),
    async handler(args, ctx) {
      const day = checkDate(args.day, "day");
      const limit = clamp(args.limit, 10, 1, 50);
      const maxChars = clamp(args.max_chars, 1200, 100, 20_000);
      let entries = await api.listJournal(ctx.client, day ? { day } : { limit });
      if (!day && args.days != null) {
        const cutoff = isoDaysAgo(clamp(args.days, 7, 1, 365));
        entries = entries.filter((e) => (e.event_date ?? e.created_at) >= cutoff);
      }
      return {
        timezone: await ctx.timezone(),
        count: entries.length,
        entries: entries.slice(0, limit).map((e) => ({
          written_at: e.event_date ?? e.created_at,
          source: e.source,
          text: e.entry_text.length > maxChars ? `${e.entry_text.slice(0, maxChars)}…` : e.entry_text,
          has_read: e.has_signals,
        })),
      };
    },
  },

  get_life_model: {
    scope: "read",
    description:
      'People, places and things that recur in their writing, most-mentioned first: type, relation, mention days, what the writing about it tends to be about. status "inferred" is Coen\'s guess and may be wrong; "confirmed"/"corrected" is the person\'s word. Offer confirm_life_model_entity when an inferred one looks off.',
    input: z.object({
      limit: z.number().optional().describe("Max entities (default 30, max 200)."),
    }),
    async handler(args, ctx) {
      const limit = clamp(args.limit, 30, 1, 200);
      const entities = (await api.listLifeModel(ctx.client)).slice(0, limit).map((e) => ({
        slug: e.slug,
        label: e.label,
        type: e.entity_type,
        relation: e.relation,
        theme: e.theme,
        status: e.status,
        their_note: e.user_note,
        mention_days: e.mention_days,
        first_seen: e.first_seen,
        last_seen: e.last_seen,
      }));
      return { count: entities.length, entities };
    },
  },

  get_stated_links: {
    scope: "read",
    description:
      'Patterns the person stated themselves ("a few days after X, Y is better"), with quote and day. Their own theory, not the engine\'s.',
    input: z.object({
      limit: z.number().optional().describe("Max links (default 20, max 100)."),
    }),
    async handler(args, ctx) {
      const limit = clamp(args.limit, 20, 1, 100);
      const links = (await api.listStatedLinks(ctx.client)).slice(0, limit);
      return { count: links.length, links };
    },
  },

  get_decisions: {
    scope: "read",
    description:
      "Decisions in full, newest first: what, situation, rationale, expected outcome, what happened. Optional `status` filter.",
    input: z.object({
      limit: z.number().optional().describe("Max decisions (default 10, max 50)."),
      status: z.string().optional().describe("Optional status filter."),
    }),
    async handler(args, ctx) {
      const limit = clamp(args.limit, 10, 1, 50);
      let decisions = await api.listDecisions(ctx.client, limit);
      if (args.status) {
        const want = String(args.status).toLowerCase();
        decisions = decisions.filter((d) => (d.status ?? "").toLowerCase() === want);
      }
      return { count: decisions.length, decisions };
    },
  },

  get_realizations: {
    scope: "read",
    description:
      "Realizations they logged about themselves, newest first. Check these before offering an observation — they may have already said it.",
    input: z.object({
      limit: z.number().optional().describe("Max realizations (default 10, max 50)."),
    }),
    async handler(args, ctx) {
      const limit = clamp(args.limit, 10, 1, 50);
      const realizations = await api.listRealizations(ctx.client, limit);
      return { count: realizations.length, realizations };
    },
  },

  get_reminders: {
    scope: "read",
    description:
      "Their reminders to themselves, plus which one the dashboard shows today. Reading does not rotate it.",
    input: z.object({
      include_archived: z.boolean().optional().describe("Also return archived reminders (default false)."),
    }),
    async handler(args, ctx) {
      const all = await api.listReminders(ctx.client);
      const reminders = args.include_archived ? all : all.filter((r) => r.is_active !== false);
      // The dashboard's pick is the pinned one, else the most recent. Reading it changes nothing.
      const today_pick = reminders.find((r) => r.is_pinned) ?? reminders[0] ?? null;
      return { count: reminders.length, reminders, today_pick };
    },
  },

  get_latest_activity_reports: {
    scope: "read",
    description:
      "Recent daily activity reports — what they actually did each day: summary, conclusion, next steps, hours by category, outcome signals.",
    input: z.object({
      limit: z.number().optional().describe("Number of daily reports (default 7, max 30)."),
      days: z.number().optional().describe("Look back this many days (default 30, max 90)."),
    }),
    async handler(args, ctx) {
      const limit = clamp(args.limit, 7, 1, 30);
      const days = clamp(args.days, 30, 1, 90);
      const since = dayOf(isoDaysAgo(days));
      const { reports, pending } = await api.listDailyReports(ctx.client, limit);
      return {
        // `pending` is days with evidence but no report yet — worth repeating so an empty list
        // doesn't read as "nothing happened".
        pending,
        reports: reports
          .filter((r) => dayOf(r.original_date) >= since)
          .map((r) => {
            const m = (r.metadata ?? {}) as Record<string, unknown>;
            return {
              date: dayOf(r.original_date),
              title: r.title,
              summary: r.summary,
              conclusion: r.conclusion,
              next_steps: r.next_steps,
              hours_estimated: m.hours_estimated ?? null,
              categories: m.categories ?? null,
              tasks_completed: m.tasks_completed ?? [],
              tasks_progressed: m.tasks_progressed ?? [],
              decisions_made: m.decisions_made ?? [],
              outcome_signals: m.outcome_signals ?? [],
              emotional_pattern: m.emotional_pattern ?? null,
            };
          }),
      };
    },
  },

  whoami: {
    scope: "read",
    description:
      "Who this connection acts for, and what Coen 1 is. Orient with this first if you have not been told.",
    input: z.object({}),
    async handler(_args, ctx) {
      const home = await ctx.home();
      return {
        coen_purpose: COEN_PURPOSE,
        person: { first_name: home.checkIn.firstName, email: ctx.cfg.auth?.email ?? null },
        timezone: home.timezone,
        check_in: {
          last: home.checkIn.lastCheckIn,
          streak_days: home.checkIn.streakDays,
          checked_in_today: home.checkIn.checkedInToday,
        },
        record: webUrl(ctx.cfg),
        note: "You are acting for the person signed in at this terminal; anything you log is attributed to them.",
      };
    },
  },

  get_recent_session_summaries: {
    scope: "read",
    description:
      "Recall this person's recent session summaries, newest first — what they worked on, decisions, open threads.",
    input: z.object({
      limit: z.number().optional().describe("How many to return (default 10, max 30)."),
      days: z.number().optional().describe("Optional: only summaries updated within this many days."),
    }),
    async handler(args) {
      const limit = clamp(args.limit, 10, 1, 30);
      const cutoff = args.days != null ? Date.now() - clamp(args.days, 7, 1, 3650) * 86_400_000 : 0;
      const summaries = listSessions()
        .filter((m) => m.updatedAt >= cutoff)
        .map((m) => loadSession(m.id))
        .filter((s): s is NonNullable<typeof s> => !!s && !!s.summary)
        .slice(0, limit)
        .map((s) => ({
          session_key: s.id,
          title: s.title || null,
          summary: s.summary ?? null,
          message_count: s.messages.length,
          updated_at: new Date(s.updatedAt).toISOString(),
        }));
      return { count: summaries.length, summaries };
    },
  },

  // ── WRITE ──────────────────────────────────────────────────────────────────
  log_daily_pulse: {
    scope: "log",
    description:
      "Submit a check-in in the person's own words (what's on their mind). Same as the app's Daily Pulse: emotional signals are extracted and the text is kept privately.",
    input: z.object({ text: z.string().describe("The raw thought-dump text.") }),
    async handler(args, ctx) {
      const text = typeof args.text === "string" ? args.text : "";
      if (text.length < 10) fail("`text` must be at least 10 characters.");
      if (text.length > 50_000) fail("`text` must be at most 50000 characters.");
      const { extractionId } = await api.submitPulse(ctx.client, text);
      return `Check-in captured (${extractionId}). Emotional signals will be extracted, and the text is kept as part of their private record.`;
    },
  },

  log_insight: {
    scope: "log",
    description: "Log a realization about themselves: short `title` + `content`. Tags optional.",
    input: z.object({
      title: z.string().describe("Short title for the realization."),
      content: z.string().describe("The realization, with reasoning/context."),
      tags: z.array(z.string()).optional().describe("Optional tags — Coen suggests them if omitted."),
    }),
    async handler(args, ctx) {
      const title = String(args.title ?? "").trim();
      const content = String(args.content ?? "").trim();
      if (!title || !content) fail("`title` and `content` are required.");
      const tags = Array.isArray(args.tags) ? (args.tags as string[]).filter(Boolean) : [];
      await api.createRealization(ctx.client, { title, content, tags });
      return `Realization logged: ${title}${tags.length ? ` [${tags.join(", ")}]` : ""}`;
    },
  },

  log_decision: {
    scope: "log",
    description:
      "Record a decision so the why doesn't decay: `title`, optional `description`, `context`, `rationale`. `decision_type` optional (defaults to other).",
    input: z.object({
      title: z.string().describe("Short decision title."),
      decision_type: z
        .string()
        .optional()
        .describe(
          "Optional. One of the dashboard's types (e.g. personal_growth, work_life_balance, spending, process, tooling, partnership, risk_mitigation, other). Unknown values are stored as `other`.",
        ),
      description: z.string().optional().describe("What was decided."),
      context: z.string().optional().describe("The situation that led to the decision."),
      rationale: z.string().optional().describe("Why this choice."),
    }),
    async handler(args, ctx) {
      const title = String(args.title ?? "").trim();
      if (!title) fail("`title` is required.");
      const type = String(args.decision_type ?? "other");
      await api.createDecision(ctx.client, {
        title,
        decision_type: type,
        description: args.description ? String(args.description) : undefined,
        rationale: args.rationale ? String(args.rationale) : undefined,
        context: args.context ? String(args.context) : undefined,
      });
      return `Decision logged: ${title} (type: ${type})`;
    },
  },

  log_habit_tick: {
    scope: "log",
    description:
      "Mark a habit done today — same as tapping it in the app. `habit` = key or exact name (get_habits). `value` defaults to target. A habit with a question needs `answer` (that IS the completion; kept as a journal entry). Routines: tick their steps.",
    input: z.object({
      habit: z.string().describe("Habit key or exact name."),
      value: z.number().optional().describe("Optional amount (default: the habit's target)."),
      answer: z.string().optional().describe("Required when the habit has a prompt: the person's answer."),
    }),
    async handler(args, ctx) {
      const habit = await findHabit(ctx, String(args.habit ?? ""));
      if (habit.is_routine) {
        fail("That is a routine. Tick its steps (each step is its own habit), or the person can mark it done in the app.");
      }
      const answer = typeof args.answer === "string" ? args.answer.trim() : "";
      if (habit.habit_prompt && !answer) {
        fail(`This habit asks: "${habit.habit_prompt}" — pass the person's answer as \`answer\`; the answer is the completion.`);
      }
      const body: { answer?: string; value?: number } = {};
      if (answer) body.answer = answer;
      if (typeof args.value === "number") body.value = args.value;
      const res = await api.tickHabit(ctx.client, habit.metric_key, body);
      const after = res.habit;
      return `${habit.metric_name}: ticked${after ? ` — ${after.today_value}/${after.habit_target}${after.unit ? ` ${after.unit}` : ""}, streak ${after.streak}` : ""}.`;
    },
  },

  create_habit: {
    scope: "log",
    description:
      "Create a habit. Four kinds, and they are four different COMPLETIONS: yes/no (aggregation_type 'max', target 1); an amount a day ('sum' + habit_target + unit, e.g. 8 glasses); asks a question (habit_prompt — the answer IS the completion, always max/1); runs a clock ('sum', unit 'minutes', habit_target = minutes a day, habit_timer_minutes = one session). A clock and a question are two rival completions and cannot both be set. `keywords` are not decoration: they are what the detector matches a check-in against to tick this by itself, so a habit created without them can only ever be ticked by hand — ask for them. Schedule defaults to every day. Creating a habit whose name matches an ARCHIVED one brings it back with its history intact.",
    input: z.object({
      metric_name: z.string().describe("What they call it — 'Morning pages'."),
      aggregation_type: z.enum(["max", "sum"]).optional().describe("'max' = yes/no (default). 'sum' = an amount that adds up over the day."),
      habit_target: z.number().optional().describe("How much counts as done. Default 1."),
      unit: z.string().optional().describe("What the target is counted in — 'glasses', 'pages', 'minutes'."),
      habit_prompt: z.string().optional().describe("A question it asks; answering it completes the habit."),
      habit_timer_minutes: z.number().optional().describe("Length of one session, 1–1440. Makes this a timed habit."),
      habit_pomodoro: z
        .object({
          work_minutes: z.number().optional(),
          break_minutes: z.number().optional(),
          long_break_minutes: z.number().optional(),
          cycle: z.number().optional(),
        })
        .optional()
        .describe("Rhythm for a timed habit. Anything left out takes 25/5/15/4."),
      description: z.string().optional().describe("What it is for. Read when deciding whether a check-in mentions it."),
      group_name: z.string().optional().describe("Group it sits under — 'Mind', 'Body'. Matches an existing group's spelling."),
      habit_days: z.array(z.number()).optional().describe("Weekdays, 0 = Sunday. Omit for every day."),
      habit_interval_weeks: z.number().optional().describe("Repeat every N weeks, 1–8. Default 1."),
      habit_schedule_type: z
        .enum(["days", "times_per_week", "times_per_month"])
        .optional()
        .describe("'days' (default) = due on set weekdays. The other two = any N days in the period."),
      habit_period_target: z.number().optional().describe("How many times in the period, for the two times_per_* schedules."),
      keywords: z.array(z.string()).optional().describe("Words in their writing that mean they did it — 'walked', 'went for a walk'. This is what auto-ticks it."),
      extraction_hint: z.string().optional().describe("Optional extra steer for the detector."),
    }),
    async handler(args, ctx) {
      const name = String(args.metric_name ?? "").trim();
      if (!name) fail("`metric_name` is required — what do they call it?");
      const key = toMetricKey(name);
      if (!key) fail(`"${name}" has no letters or digits in it, so there is no key to derive from it.`);

      // A live habit with this key makes POST answer 409. The server's wording is fine but says
      // nothing about what to do instead, and the answer is always the same tool.
      const existing = await api.getHabits(ctx.client);
      const clash = existing.find((h) => h.metric_key === key);
      if (clash) {
        fail(`"${clash.metric_name}" already exists (key ${key}). Use update_habit to change it, not create_habit.`);
      }

      const body: api.NewHabit = {
        metric_name: name,
        aggregation_type: args.aggregation_type === "sum" ? "sum" : "max",
      };
      const copy = [
        "habit_target", "unit", "habit_prompt", "habit_timer_minutes", "habit_pomodoro",
        "description", "group_name", "habit_days", "habit_interval_weeks",
        "habit_schedule_type", "habit_period_target", "keywords", "extraction_hint",
      ] as const;
      for (const f of copy) if (args[f] !== undefined) (body as unknown as Record<string, unknown>)[f] = args[f];

      await passThrough(() => api.createHabit(ctx.client, body));
      // Read it back rather than trust the request: the route resolves things it was not told
      // (a prompt habit's target, a schedule's anchor), and an un-archived habit comes back with
      // history the caller never mentioned.
      const made = await api.getHabit(ctx.client, key);
      const keywords = made.calculation_config?.keywords ?? [];
      return (
        `${made.metric_name} added — ${scheduleWords(made)}, ` +
        `${made.habit_prompt ? `asks "${made.habit_prompt}"` : `target ${made.habit_target}${definitionOf(made).unit ? ` ${definitionOf(made).unit}` : ""}`}.` +
        (keywords.length
          ? ` Ticks itself on: ${keywords.join(", ")}.`
          : " No keywords, so nothing will tick it automatically — they will have to tick it themselves.")
      );
    },
  },

  update_habit: {
    scope: "log",
    description:
      "Change a habit's definition — name, description, group, target, unit, kind, question, clock, schedule, or the keywords that auto-tick it. `habit` = key or exact name (get_habits). Only send what changes; everything else is left alone. Pass null to clear a description, question, clock or hint. Changing the SCHEDULE re-scores all history at once (narrowing blanks past off-days, widening can shorten a streak), so say so rather than doing it quietly. Routines are edited on the Routines page, not here.",
    input: z.object({
      habit: z.string().describe("Habit key or exact name."),
      metric_name: z.string().optional().describe("New name. The key does not change."),
      description: z.string().nullable().optional().describe("What it is for. null clears it."),
      group_name: z.string().optional().describe("Group it sits under."),
      habit_target: z.number().optional().describe("How much counts as done."),
      unit: z.string().optional().describe("What the target is counted in."),
      aggregation_type: z.enum(["max", "sum"]).optional().describe("'max' = yes/no. 'sum' = adds up over the day."),
      habit_prompt: z.string().nullable().optional().describe("The question it asks. null turns the question off."),
      habit_timer_minutes: z.number().nullable().optional().describe("Session length, 1–1440. null stops the clock."),
      habit_pomodoro: z
        .object({
          work_minutes: z.number().optional(),
          break_minutes: z.number().optional(),
          long_break_minutes: z.number().optional(),
          cycle: z.number().optional(),
        })
        .nullable()
        .optional()
        .describe("Rhythm for a timed habit. null clears it."),
      habit_days: z.array(z.number()).optional().describe("Weekdays, 0 = Sunday."),
      habit_interval_weeks: z.number().optional().describe("Repeat every N weeks, 1–8."),
      habit_anchor_date: z.string().nullable().optional().describe("YYYY-MM-DD the every-N-weeks cycle counts from."),
      habit_schedule_type: z.enum(["days", "times_per_week", "times_per_month"]).optional().describe("How completion is counted."),
      habit_period_target: z.number().optional().describe("How many times in the period, for the two times_per_* schedules."),
      keywords: z.array(z.string()).optional().describe("Words that auto-tick it. An empty array means nothing does."),
      extraction_hint: z.string().nullable().optional().describe("Extra steer for the detector. null clears it."),
    }),
    async handler(args, ctx) {
      const habit = await findHabit(ctx, String(args.habit ?? ""));
      const fields = [
        "metric_name", "description", "group_name", "habit_target", "unit", "aggregation_type",
        "habit_prompt", "habit_timer_minutes", "habit_pomodoro", "habit_days",
        "habit_interval_weeks", "habit_anchor_date", "habit_schedule_type",
        "habit_period_target", "keywords", "extraction_hint",
      ] as const;
      const body: api.HabitPatch = {};
      for (const f of fields) if (args[f] !== undefined) (body as unknown as Record<string, unknown>)[f] = args[f];
      if (!Object.keys(body).length) {
        fail("Nothing to change — pass at least one field besides `habit`.");
      }

      // Read before and after so the answer says what actually moved, not what was asked for:
      // the route resolves fields it was not sent (a prompt habit's target becomes 1) and
      // canonicalises others (a group's spelling).
      const before = await api.getHabit(ctx.client, habit.metric_key);
      await passThrough(() => api.updateHabit(ctx.client, habit.metric_key, body));
      const after = await api.getHabit(ctx.client, habit.metric_key);

      const b = definitionOf(before);
      const a = definitionOf(after);
      const say = (v: unknown) => (Array.isArray(v) ? (v.length ? v.join(", ") : "nothing") : v == null || v === "" ? "nothing" : String(v));
      const changed = (Object.keys(a) as (keyof typeof a)[])
        .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
        .map((k) => `${k}: ${say(b[k])} → ${say(a[k])}`);
      if (!changed.length) return `${a.name}: nothing changed — it already read that way.`;
      return (
        `${a.name} updated.\n  ${changed.join("\n  ")}` +
        (a.schedule !== b.schedule
          ? "\n  The whole history is re-scored through the new schedule, so an old streak can change."
          : "")
      );
    },
  },

  archive_habit: {
    scope: "log",
    destructive: true,
    description:
      "Archive a habit — it leaves their habit list. `habit` = key or exact name (get_habits). Nothing is destroyed: every tick it ever had is kept, and calling create_habit with the same name brings it back with that history intact. Archiving a ROUTINE archives every one of its steps with it. Any clock still running on it is discarded. Only on their explicit say-so.",
    input: z.object({ habit: z.string().describe("Habit key or exact name.") }),
    async handler(args, ctx) {
      const habit = await findHabit(ctx, String(args.habit ?? ""));
      const res = await passThrough(() => api.archiveHabit(ctx.client, habit.metric_key));
      const alsoWent = (res.archived_keys ?? []).filter((k) => k !== habit.metric_key);
      return (
        `${habit.metric_name} archived` +
        (alsoWent.length ? `, along with its ${alsoWent.length} step${alsoWent.length === 1 ? "" : "s"}` : "") +
        `. Its history is kept — adding "${habit.metric_name}" again brings the habit back with it.`
      );
    },
  },

  log_metric_value: {
    scope: "log",
    description:
      "Record a reading for a tracked metric (`metric` = key or exact name from get_metrics) for today or `date`. Readings append; the metric's own aggregation resolves the day.",
    input: z.object({
      metric: z.string().describe("Metric key or exact name."),
      value: z.number().describe("The reading."),
      date: z.string().optional().describe("Optional YYYY-MM-DD (their local day). Default today."),
    }),
    async handler(args, ctx) {
      const value = Number(args.value);
      if (!Number.isFinite(value)) fail("`value` must be a number.");
      const date = checkDate(args.date);
      const metric = await findMetric(ctx, String(args.metric ?? ""));
      await api.logMetricEvent(ctx.client, { metric_key: metric.metric_key, value, event_date: date ?? today() });
      const unit = api.unitOf(metric);
      return `${metric.metric_name}: recorded ${value}${unit ? ` ${unit}` : ""} on ${date ?? today()}.`;
    },
  },

  add_reminder: {
    scope: "log",
    description: "Save a line the person wants to be reminded of (their words, or a quote with `attribution`).",
    input: z.object({
      content: z.string().describe("The reminder text (max 500 chars)."),
      attribution: z.string().optional().describe("Optional — who said it, if it is a quote."),
    }),
    async handler(args, ctx) {
      const content = String(args.content ?? "").trim();
      if (!content) fail("`content` is required.");
      if (content.length > 500) fail("Reminders are capped at 500 characters.");
      const attribution = typeof args.attribution === "string" && args.attribution.trim()
        ? args.attribution.trim().slice(0, 120)
        : undefined;
      const res = await api.createReminder(ctx.client, { content, ...(attribution ? { attribution } : {}) });
      const r = res.reminder;
      return `Reminder saved: "${r?.content ?? content}"${r?.attribution ? ` — ${r.attribution}` : attribution ? ` — ${attribution}` : ""}`;
    },
  },

  confirm_life_model_entity: {
    scope: "log",
    description:
      "Correct what Coen thinks about someone/something (`slug` from get_life_model). `status`: confirmed | hidden | inferred (undo). Fixing `label`/`relation`/`note` marks it corrected — the person's word then outranks the engine. Only on their explicit say-so.",
    input: z.object({
      slug: z.string().describe("Entity slug from get_life_model."),
      status: z.enum(["confirmed", "hidden", "inferred"]).optional().describe("Optional explicit status."),
      label: z.string().optional().describe("Optional corrected name."),
      relation: z.string().optional().describe("Optional corrected relation to the person."),
      note: z.string().optional().describe("Optional note in the person's words."),
    }),
    async handler(args, ctx) {
      const slug = String(args.slug ?? "").trim();
      if (!slug) fail("`slug` is required.");
      const body: { slug: string; status?: string; label?: string; relation?: string; user_note?: string } = { slug };
      if (args.status) body.status = String(args.status);
      if (typeof args.label === "string" && args.label.trim()) body.label = args.label.trim().slice(0, 120);
      if (typeof args.relation === "string") body.relation = args.relation.trim().slice(0, 300);
      if (typeof args.note === "string") body.user_note = args.note.trim().slice(0, 500);
      if (!body.status && body.label === undefined && body.relation === undefined && body.user_note === undefined) {
        fail("Nothing to change — pass `status`, or one of `label` / `relation` / `note`.");
      }
      let entity: api.LifeModelEntity;
      try {
        entity = await api.patchLifeModel(ctx.client, body);
      } catch (e) {
        if (e instanceof api.ApiError && e.status === 404) {
          return fail(`No entity with slug "${slug}". Call get_life_model to see them.`);
        }
        throw e;
      }
      return `${entity.label}: now ${entity.status}${entity.relation ? ` (${entity.relation})` : ""}.`;
    },
  },

  add_to_my_world: {
    scope: "log",
    description:
      "Tell Coen about a person, activity, situation or place BEFORE it works them out on its own — e.g. 'Sarah is my sister'. Use when the person names someone or something Coen doesn't already have (check get_life_model first). Their words outrank anything the engine later infers, so only add what they actually said, in their words. Adding one that already exists corrects it.",
    input: z.object({
      label: z.string().describe("What they call it — 'Sarah', 'the commute', 'the Tuesday standup'."),
      entity_type: z.enum(["person", "activity", "situation", "place"]).optional().describe("What kind of thing it is."),
      relation: z.string().optional().describe("What it is to them — 'my sister', 'every weekday morning'."),
      note: z.string().optional().describe("Anything else worth knowing, in their words."),
      aliases: z.array(z.string()).optional().describe("Other names they use for it."),
    }),
    async handler(args, ctx) {
      const label = String(args.label ?? "").trim();
      if (!label) fail("`label` is required — what do they call it?");
      const entity = await api.createLifeModelEntity(ctx.client, {
        label: label.slice(0, 120),
        ...(args.entity_type ? { entity_type: String(args.entity_type) } : {}),
        ...(typeof args.relation === "string" && args.relation.trim() ? { relation: args.relation.trim().slice(0, 300) } : {}),
        ...(typeof args.note === "string" && args.note.trim() ? { user_note: args.note.trim().slice(0, 500) } : {}),
        ...(Array.isArray(args.aliases) ? { aliases: args.aliases.map((a) => String(a)) } : {}),
      });
      // Say when it merged, so the model doesn't report "added" about something already known.
      return entity.mention_days > 0
        ? `${entity.label} was already in their world (${entity.mention_days} days of writing) — it now reads as their words.`
        : `Added ${entity.label}${entity.relation ? ` (${entity.relation})` : ""} to their world.`;
    },
  },

  log_session_summary: {
    scope: "log",
    description:
      "Store a summary of this work-session (stable `session_key`; re-running updates it). `title` recommended.",
    input: z.object({
      session_key: z.string().describe("Stable session id (re-running updates the same record)."),
      summary: z.string().describe("The session summary (what was worked on, decisions, open threads)."),
      title: z.string().optional().describe("Short session title."),
    }),
    async handler(args) {
      const key = String(args.session_key ?? "").trim();
      const summary = String(args.summary ?? "").trim();
      if (!key || !summary) fail("`session_key` and `summary` are required.");
      const session = loadSession(key);
      if (!session) fail(`No session "${key}" on this machine. Sessions live in ~/.coen/sessions.`);
      session!.summary = summary;
      if (args.title) session!.title = String(args.title);
      session!.updatedAt = Date.now();
      saveSession(session!);
      return `Session summary saved: "${args.title || key}".`;
    },
  },
};

export const TOOL_NAMES = Object.keys(TOOLS);

/** Tool names that change something. The confirm-before-writing gate reads this. */
export const WRITE_TOOLS = new Set(TOOL_NAMES.filter((n) => TOOLS[n].scope !== "read"));
