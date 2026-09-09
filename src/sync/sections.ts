import { existsSync, readFileSync } from "node:fs";
import * as api from "../api.js";
import { dayOf } from "../day.js";
import { type ToolContext } from "../coen-tools/context.js";
import { type MirrorFile } from "./write.js";
import { type Manifest, type PendingEntry, hashOf, normaliseText } from "./manifest.js";
import { type SyncPaths, safeJoin, journalPath, datedPath, safeName } from "./paths.js";
import { frontMatter, doc, heading, table, readSection, readLine, body } from "./render.js";

/**
 * What the folder contains, one entry per section.
 *
 * This is a table for the same reason ../coen-tools/registry.ts is a table: adding something to
 * the mirror should be one entry and nothing else. A section says its name — which is also the
 * key the manifest tracks its files under — and builds the complete list of files it owns.
 *
 * A section builds EVERYTHING it owns, every pass. The writer diffs against the manifest and
 * writes only what changed, so building the whole list is cheap and getting it wrong is not
 * possible in the direction that matters: a file a section stops producing is a file that has
 * genuinely gone from the record.
 *
 * The one exception is history outside the window. A 90-day pass does not fetch a decision from
 * last year, so it cannot produce that file — and pruning it would undo a `--all` backfill on the
 * next quarter-hour. `retain` marks the paths a section is not in a position to speak about, and
 * the writer carries those through untouched.
 */

export interface SyncContext {
  ctx: ToolContext;
  paths: SyncPaths;
  manifest: Manifest;
  /** The local day the window starts on, always the 1st of a month. Null means everything. */
  sinceDay: string | null;
  /** Notes for the person, said once at the end of a pass rather than logged per record. */
  notes: string[];
  habits(): Promise<api.HomeHabit[]>;
  metrics(): Promise<api.Metric[]>;
  events(): Promise<api.MetricEvent[]>;
}

export interface SyncSection {
  name: string;
  build(sc: SyncContext): Promise<MirrorFile[]>;
  /** Paths this section cannot speak about on this pass, and must not delete. */
  retain?(sc: SyncContext): ((rel: string) => boolean) | undefined;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** How many rows a page asks for. /api/journal caps at 500; everything else is happy with this. */
const PAGE = 200;
/** A ceiling, so a route that ignores its offset can't loop forever. */
const MAX_PAGES = 200;

/**
 * Walk a paged route back through time and stop at the window.
 *
 * Every one of these routes returns newest first, so the moment a page ends older than the window
 * there is nothing left worth asking for.
 */
async function pageAll<T>(
  fetch: (pageIndex: number, limit: number) => Promise<T[]>,
  dateOf: (row: T) => string | null | undefined,
  sinceDay: string | null,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const rows = await fetch(i, PAGE);
    out.push(...rows);
    if (rows.length < PAGE) break;
    const oldest = dateOf(rows[rows.length - 1]!);
    if (sinceDay && oldest && dayOf(oldest) < sinceDay) break;
  }
  return sinceDay ? out.filter((r) => (dayOf(dateOf(r)) || "9999") >= sinceDay) : out;
}

/** The date any of our dated paths carries, as a day. Month files count as their first day. */
const DATE_IN_PATH = /(\d{4})-(\d{2})(?:-(\d{2}))?/;

/**
 * Retain anything dated before the window. Month-granularity files are treated as their first
 * day, which is safe because the window always starts on the 1st of a month — a month file is
 * either wholly inside the window and rebuilt, or wholly outside it and left alone.
 */
function retainOlderThanWindow(sc: SyncContext): ((rel: string) => boolean) | undefined {
  const since = sc.sinceDay;
  if (!since) return undefined;
  return (rel: string) => {
    const m = DATE_IN_PATH.exec(rel);
    if (!m) return false;
    const d = m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}-01`;
    return d < since;
  };
}

const monthOf = (iso: string | null | undefined): string => dayOf(iso).slice(0, 7) || "undated";

/** Group rows by a key, keeping the order they arrived in. */
function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

// ─── the sections ────────────────────────────────────────────────────────────

const journal: SyncSection = {
  name: "journal",
  retain: retainOlderThanWindow,
  async build(sc) {
    const entries = await pageAll(
      (i, limit) => api.listJournal(sc.ctx.client, { limit, offset: i * limit }),
      (e) => e.event_date ?? e.created_at,
      sc.sinceDay,
    );

    const files: MirrorFile[] = entries.map((e) => {
      const when = e.event_date ?? e.created_at;
      return {
        path: journalPath(when, e.id),
        body: doc(
          frontMatter({ id: e.id, date: when, source: e.source, read: e.has_signals ? "yes" : "no" }),
          body(e.entry_text),
          e.signals ? readSection(e.signals) : "",
        ),
      };
    });

    // Check-ins written into new/ that the server has not handed back yet. Their provisional
    // files are the only copy of that text, so they are re-emitted as they are — never pruned.
    const landed = new Set(entries.map((e) => hashOf(normaliseText(e.entry_text))));
    const stillPending: PendingEntry[] = [];
    for (const p of sc.manifest.pending) {
      if (landed.has(p.textHash)) continue; // the canonical file above covers it now
      const abs = safeJoin(sc.paths.root, p.path);
      if (!existsSync(abs)) continue; // someone deleted it; that is their business
      stillPending.push(p);
      files.push({ path: p.path, body: readFileSync(abs, "utf8") });
    }
    sc.manifest.pending = stillPending;

    // Journal storage is opt-in on the account (see coen1-web/src/app/api/journal/route.ts). With
    // it off, /api/journal is empty forever and these files are the only record of the writing.
    // Worth saying once — an empty journal/ that nobody explained looks like a bug.
    const stuck = stillPending.filter((p) => Date.now() - p.submittedAt > 15 * 60_000);
    if (stuck.length && !sc.manifest.notedStorageOff) {
      sc.manifest.notedStorageOff = true;
      sc.notes.push(
        `${stuck.length} check-in${stuck.length === 1 ? "" : "s"} never came back from the journal — ` +
          "journal storage may be switched off for your account. Your copies are under journal/.",
      );
    }
    if (!stuck.length && sc.manifest.notedStorageOff) sc.manifest.notedStorageOff = false;

    return files;
  },
};

const habits: SyncSection = {
  name: "habits",
  retain: retainOlderThanWindow,
  async build(sc) {
    const [list, metrics, events] = await Promise.all([sc.habits(), sc.metrics(), sc.events()]);
    const unitFor = new Map(metrics.map((m) => [m.metric_key, api.unitOf(m)]));
    const files: MirrorFile[] = [];

    const scheduleOf = (h: api.HomeHabit): string => {
      if (h.habit_schedule_type === "times_per_week") return `${h.habit_period_target ?? "?"}× a week`;
      if (h.habit_schedule_type === "times_per_month") return `${h.habit_period_target ?? "?"}× a month`;
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const which = (h.habit_days ?? []).map((d) => days[d] ?? "?").join(" ");
      const weeks = h.habit_interval_weeks > 1 ? `, every ${h.habit_interval_weeks} weeks` : "";
      return (which || "no days set") + weeks;
    };

    files.push({
      path: "habits/index.md",
      body: doc(
        // No timestamp in here. A field that changes every pass makes every pass a rewrite, and
        // every rewrite a commit — the file would churn daily while saying nothing new.
        frontMatter({ count: list.length }),
        heading(1, "Habits"),
        list.length
          ? table(
              ["Habit", "Key", "Group", "Target", "Schedule", "Streak", "Today"],
              list.map((h) => [
                h.metric_name,
                h.metric_key,
                h.group_name ?? "",
                `${h.habit_target}${h.unit ?? unitFor.get(h.metric_key) ? ` ${h.unit ?? unitFor.get(h.metric_key)}` : ""}`,
                scheduleOf(h),
                h.streak || "",
                h.done_today ? "done" : h.scheduled_today ? "not yet" : "not scheduled",
              ]),
            )
          : "\nNone set up.\n",
        ...list
          .filter((h) => h.description || h.habit_prompt || h.habit_timer_minutes)
          .map((h) =>
            doc(
              heading(2, h.metric_name),
              h.description ? `\n${h.description}\n` : "",
              h.habit_prompt ? `\nAsks: “${h.habit_prompt}”\n` : "",
              h.habit_timer_minutes ? `\nRuns a clock: ${h.habit_timer_minutes} minutes a session.\n` : "",
            ),
          ),
      ),
    });

    // Every tick, by month. A habit's ticks are metric events on its own key.
    const habitKeys = new Map(list.map((h) => [h.metric_key, h]));
    // Every day a habit was scheduled has a row, including the days it was not done — those
    // carry zero_filled. A list of ticks is a list of things that happened.
    const ticks = events.filter((e) => habitKeys.has(e.metric_key) && api.isTick(e));
    for (const [month, rows] of groupBy(ticks, (e) => monthOf(e.event_date))) {
      if (month === "undated") continue;
      const byDay = groupBy(rows, (e) => dayOf(e.event_date));
      const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
      files.push({
        path: `habits/${month}.md`,
        body: doc(
          frontMatter({ month, ticks: rows.length }),
          heading(1, `Habits — ${month}`),
          ...days.map(([d, list2]) =>
            doc(
              heading(2, d),
              list2
                .map((e) => {
                  const unit = e.unit ?? unitFor.get(e.metric_key) ?? "";
                  return `- ${e.metric_name || e.metric_key}: ${e.value}${unit ? ` ${unit}` : ""}${
                    e.source ? ` · ${e.source}` : ""
                  }`;
                })
                .join("\n") + "\n",
            ),
          ),
        ),
      });
    }
    return files;
  },
};

const decisions: SyncSection = {
  name: "decisions",
  retain: retainOlderThanWindow,
  async build(sc) {
    const rows = await pageAll(
      (i, limit) => api.listDecisions(sc.ctx.client, limit, i + 1),
      (d) => d.decision_date ?? d.created_at,
      sc.sinceDay,
    );
    return rows.map((d) => {
      const when = d.decision_date ?? d.created_at;
      return {
        path: datedPath("decisions", when, d.title, d.id),
        body: doc(
          frontMatter({ id: d.id, date: when, type: d.decision_type, status: d.status, title: d.title }),
          heading(1, d.title || "Untitled decision"),
          d.description ? doc(heading(2, "What"), body(d.description)) : "",
          d.rationale ? doc(heading(2, "Why"), body(d.rationale)) : "",
        ),
      };
    });
  },
};

const insights: SyncSection = {
  name: "insights",
  retain: retainOlderThanWindow,
  async build(sc) {
    const rows = await pageAll(
      (i, limit) => api.listRealizations(sc.ctx.client, limit, i * limit),
      (r) => r.created_at,
      sc.sinceDay,
    );
    return rows.map((r) => ({
      path: datedPath("insights", r.created_at, r.title ?? r.content.slice(0, 60), r.id),
      body: doc(
        frontMatter({ id: r.id, date: r.created_at, title: r.title, tags: r.tags ?? [] }),
        r.title ? heading(1, r.title) : "",
        body(r.content),
      ),
    }));
  },
};

const reminders: SyncSection = {
  name: "reminders",
  async build(sc) {
    const rows = await api.listReminders(sc.ctx.client);
    const active = rows.filter((r) => r.is_active !== false);
    const rest = rows.filter((r) => r.is_active === false);
    const line = (r: api.Reminder) =>
      `- ${r.is_pinned ? "📌 " : ""}“${r.content}”${r.attribution ? ` — ${r.attribution}` : ""}`;
    return [
      {
        path: "reminders.md",
        body: doc(
          frontMatter({ count: rows.length, active: active.length }),
          heading(1, "Reminders"),
          active.length ? "\n" + active.map(line).join("\n") + "\n" : "\nNone.\n",
          rest.length ? doc(heading(2, "Not showing any more"), "\n" + rest.map(line).join("\n") + "\n") : "",
        ),
      },
    ];
  },
};

const reports: SyncSection = {
  name: "reports",
  retain: retainOlderThanWindow,
  async build(sc) {
    const rows: api.DailyReport[] = [];
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await api.listDailyReports(sc.ctx.client, 100, i * 100);
      rows.push(...(page.reports ?? []));
      if ((page.reports ?? []).length < 100) break;
      const oldest = rows[rows.length - 1]?.original_date;
      if (sc.sinceDay && oldest && dayOf(oldest) < sc.sinceDay) break;
    }
    const kept = sc.sinceDay ? rows.filter((r) => dayOf(r.original_date) >= sc.sinceDay!) : rows;
    return kept.map((r) => ({
      path: `reports/${dayOf(r.original_date)}.md`,
      body: doc(
        frontMatter({ date: dayOf(r.original_date), key: r.report_key, title: r.title }),
        heading(1, r.title || `Day — ${dayOf(r.original_date)}`),
        r.summary ? body(r.summary) : "",
        r.report_text ? doc(heading(2, "What happened"), body(r.report_text)) : "",
        r.conclusion ? doc(heading(2, "Conclusion"), body(r.conclusion)) : "",
        r.next_steps ? doc(heading(2, "Next"), body(r.next_steps)) : "",
      ),
    }));
  },
};

const reads: SyncSection = {
  name: "reads",
  retain: retainOlderThanWindow,
  async build(sc) {
    const start = sc.sinceDay ? `${sc.sinceDay}T00:00:00.000Z` : "2000-01-01T00:00:00.000Z";
    const rows = await api.listReportsBetween(sc.ctx.client, start, new Date().toISOString());
    const byMonth = groupBy(rows, (r) => monthOf(r.report_period_start));
    const files: MirrorFile[] = [];
    for (const [month, list] of byMonth) {
      if (month === "undated") continue;
      const days = [...list].sort((a, b) => (a.report_period_start < b.report_period_start ? 1 : -1));
      files.push({
        path: `reads/${month}.md`,
        body: doc(
          frontMatter({ month, days: days.length }),
          heading(1, `Emotional read — ${month}`),
          "\nWhat came through above the neutral band, strongest first.\n",
          ...days.map((r) =>
            doc(
              heading(2, dayOf(r.report_period_start)),
              `\n${readLine(r.emotional_averages as Record<string, unknown>)}  \n` +
                `Sample size: ${r.sample_size}\n`,
            ),
          ),
        ),
      });
    }
    return files;
  },
};

const metrics: SyncSection = {
  name: "metrics",
  async build(sc) {
    const [all, events] = await Promise.all([sc.metrics(), sc.events()]);
    const numbers = all.filter((m) => !m.is_habit);
    const byKey = groupBy(events, (e) => e.metric_key);
    return numbers.map((m) => {
      const rows = (byKey.get(m.metric_key) ?? []).filter(api.isTick).slice(0, 500);
      const unit = api.unitOf(m);
      return {
        path: `metrics/${safeName(m.metric_key)}.md`,
        body: doc(
          frontMatter({
            key: m.metric_key,
            name: m.metric_name,
            category: m.metric_category,
            aggregation: m.aggregation_type,
            unit,
            archived: m.archived ?? false,
          }),
          heading(1, m.metric_name || m.metric_key),
          m.description ? body(m.description) : "",
          rows.length
            ? doc(
                heading(2, "Readings"),
                table(
                  ["Day", `Value${unit ? ` (${unit})` : ""}`, "From"],
                  rows.map((e) => [dayOf(e.event_date), e.value, e.source ?? ""]),
                ),
              )
            : "\nNothing recorded in this window.\n",
        ),
      };
    });
  },
};

const lifeModel: SyncSection = {
  name: "life-model",
  async build(sc) {
    const rows = await api.listLifeModel(sc.ctx.client);
    const shown = rows.filter((e) => e.status !== "hidden");
    const hidden = rows.filter((e) => e.status === "hidden");
    return [
      {
        path: "life-model.md",
        body: doc(
          frontMatter({ count: rows.length }),
          heading(1, "People and things you write about"),
          "\nMost-mentioned first. “inferred” is Coen's guess and may be wrong; “confirmed” or\n" +
            "“corrected” is your word.\n",
          shown.length
            ? table(
                ["Who or what", "Type", "Relation", "Days", "Status", "Your note", "Slug"],
                shown.map((e) => [
                  e.label,
                  e.entity_type,
                  e.relation ?? "",
                  e.mention_days,
                  e.status,
                  e.user_note ?? "",
                  e.slug,
                ]),
              )
            : "\nNone recognised yet.\n",
          hidden.length ? doc(heading(2, "Hidden"), "\n" + hidden.map((e) => `- ${e.label}`).join("\n") + "\n") : "",
        ),
      },
    ];
  },
};

const yourWords: SyncSection = {
  name: "your-words",
  async build(sc) {
    const rows = await api.listStatedLinks(sc.ctx.client);
    return [
      {
        path: "your-words.md",
        body: doc(
          frontMatter({ count: rows.length }),
          heading(1, "The links you drew yourself"),
          "\nYour theory, not the engine's.\n",
          rows.length
            ? rows
                .map((r) =>
                  doc(
                    heading(2, `${dayOf(r.said_on)} — ${r.line}`),
                    r.quote ? `\n> ${r.quote.replace(/\n+/g, "\n> ")}\n` : "",
                    r.note ? `\n${r.note}\n` : "",
                  ),
                )
                .join("")
            : "\nNothing yet.\n",
        ),
      },
    ];
  },
};

const profile: SyncSection = {
  name: "profile",
  async build(sc) {
    const [text, status, home] = await Promise.all([
      api.getAccountProfile(sc.ctx.client).catch(() => null),
      api.getPersonalStatus(sc.ctx.client).catch(() => null),
      sc.ctx.home(),
    ]);
    const you = status?.you;
    return [
      {
        path: "profile.md",
        body: doc(
          frontMatter({
            name: home.checkIn.firstName,
            timezone: home.timezone,
            streak_days: home.checkIn.streakDays,
            last_check_in: home.checkIn.lastCheckIn,
          }),
          heading(1, "Profile"),
          text ? doc(heading(2, "In your words"), body(text)) : "",
          you
            ? doc(
                heading(2, "Baseline"),
                `\nStatus: ${you.status}\n` +
                  (you.drivers?.length ? `\n${you.drivers.map((d) => `- ${d}`).join("\n")}\n` : "") +
                  `\nSignal covers ${you.coverage?.dataSpanDays ?? "?"} days · ` +
                  `${you.coverage?.recentReportDays ?? 0} recent daily reads\n`,
              )
            : "",
        ),
      },
    ];
  },
};

/** Everything the folder holds, in the order a pass builds it. */
export const SECTIONS: SyncSection[] = [
  journal,
  habits,
  decisions,
  insights,
  reminders,
  reports,
  reads,
  metrics,
  lifeModel,
  yourWords,
  profile,
];
