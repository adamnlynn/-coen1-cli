/**
 * Home draws terminal rows, styled with ANSI, the way the chat transcript does — so the same
 * scroll pane shows them. Everything here mirrors what the dashboard shows for the same data:
 * the neutral band, the intensity words and the lifting / weighing split are the web's numbers
 * (coen1-web/src/lib/emotional-read.ts), and the marker lists are generated from the same taxonomy.
 */
import chalk from "chalk";
import type { Palette } from "../theme.js";
import { wrapLines } from "../transcript.js";
import type { DailyReport, DayEvent, DayRead, Decision, TimerSession, EmotionalReport, HomeData, HomeHabit, JournalEntry, LatestRead, LifeModelEntity, Realization, Reminder } from "../api.js";
import { NEUTRAL_BAND, intensityWord, natureOf, markerLabel, type Nature } from "../markers.js";
import { dayOf } from "../day.js";

// The marker vocabulary lives in ../markers.ts — Home, the tool registry and the life
// snapshot all read scores the same way. Re-exported here because Home imports them from
// this module, which is where they used to live.
export { NEUTRAL_BAND, intensityWord, natureOf, markerLabel, type Nature };
export { dayOf };

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}


function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function rule(label: string, p: Palette, width: number): string {
  const head = `── ${label} `;
  return chalk.hex(p.dim)(head + "─".repeat(Math.max(0, width - head.length - 2)));
}

/** One marker as a chip: arrow by nature, label, intensity word. `muted` for below the band. */
function chip(k: string, v: number, p: Palette, muted = false): string {
  const n = natureOf(k);
  const mark = n === "lifting" ? "↑" : n === "weighing" ? "↓" : "·";
  const col = muted ? p.dim : n === "lifting" ? p.success : n === "weighing" ? p.warning : p.dim;
  return chalk.hex(col)(`${mark} ${markerLabel(k)}`) + chalk.hex(p.dim)(` ${intensityWord(v)}`);
}

/** The notable chips of a read, strongest first. Empty when nothing is above the band. */
export function notableChips(signals: Record<string, number>, p: Palette, max: number): string[] {
  return Object.entries(signals)
    .filter(([, v]) => v > NEUTRAL_BAND)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([k, v]) => chip(k, v, p));
}

/**
 * The strongest chips of a read whether or not they cleared the band — what the dashboard's
 * lifting / weighing lists show. Above the band in colour; below it dim, and the intensity
 * word ("Subtle", "Present") says how much weight to give it. A day of moderate scores is a
 * read, not silence; only a day with nothing scored at all is quiet.
 */
export function topChips(signals: Record<string, number>, p: Palette, max: number): string[] {
  const scored = scoredEntries(signals);
  const chips = scored.slice(0, max).map(([k, v]) => chip(k, v, p, v <= NEUTRAL_BAND));
  // Scores are banded, so ties at 50 are the norm: say how many more there are, or three
  // chips look like the whole read.
  if (scored.length > max) chips.push(chalk.hex(p.dim)(`+${scored.length - max} more`));
  return chips;
}

const NATURE_ORDER: Record<Nature, number> = { lifting: 0, weighing: 1, neither: 2 };

/** Every scored marker, strongest first; ties by nature (lifting, weighing, neither), then name,
 *  so the same read always lists the same way. */
function scoredEntries(signals: Record<string, number>): [string, number][] {
  return Object.entries(signals)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || NATURE_ORDER[natureOf(a[0])] - NATURE_ORDER[natureOf(b[0])] || a[0].localeCompare(b[0]));
}

/** The notable signals of a read, strongest first, coloured by nature. */
export function signalLines(read: LatestRead | null, p: Palette): string[] {
  if (!read) return [chalk.hex(p.dim)("  nothing read yet — write something below and Coen will read it")];
  const notable = notableChips(read.signals, p, 4);
  const chips = notable.length ? notable : topChips(read.signals, p, 4);
  if (!chips.length) return [chalk.hex(p.dim)("  read, but nothing scored")];
  const tag = notable.length ? "" : chalk.hex(p.dim)("  (nothing above the band)");
  return ["  " + chips.join("    ") + tag + chalk.hex(p.dim)("    /signals for all")];
}

/**
 * /signals — the whole latest read, not the chips the header has room for. Every marker Coen
 * scored, grouped lifting / weighing / neither, strongest first; the ones above the band in
 * colour, the rest dim so the shape of the read stays visible without shouting.
 */
export function fullReadLines(read: LatestRead | null, p: Palette, width: number): string[] {
  const w = width - 1;
  const out = [rule(`latest read${read ? ` · ${timeAgo(read.created_at)}${read.source ? ` · ${read.source}` : ""}` : ""}`, p, w)];
  if (!read) return [...out, chalk.hex(p.dim)("  nothing read yet"), ""];
  // A stored read carries the whole taxonomy, most of it at 0. Zero is "not mentioned" — the
  // absence of a signal, not a signal — so it is left out here, the same as everywhere else.
  const scored = Object.entries(read.signals).filter(([, v]) => v > 0);
  if (!scored.length) return [...out, chalk.hex(p.dim)("  nothing came through in this one"), ""];
  const groups: [string, Nature][] = [["lifting", "lifting"], ["weighing", "weighing"], ["neither", "neither"]];
  for (const [label, nature] of groups) {
    const rows = scored
      .filter(([k]) => natureOf(k) === nature)
      .sort((a, b) => b[1] - a[1]);
    if (!rows.length) continue;
    out.push(chalk.hex(p.dim)(`  ${label}`));
    for (const [k, v] of rows) out.push("    " + chip(k, v, p, v <= NEUTRAL_BAND) + chalk.hex(p.dim)(`  ${v}`));
  }
  if (read.journal?.entry_text) {
    out.push("", chalk.hex(p.dim)("  what you wrote"));
    out.push(...wrapLines(chalk.hex(p.dim)("    " + read.journal.entry_text.trim().replace(/\n+/g, "\n    ")), w));
  }
  return [...out, ""];
}

/** /signals YYYY-MM-DD — each check-in that day with what came through in it. */
export function daySignalsLines(day: string, events: DayEvent[], p: Palette, width: number): string[] {
  const w = width - 1;
  const out = [rule(`signals · ${day}`, p, w)];
  if (!events.length) return [...out, chalk.hex(p.dim)("  no reads that day"), ""];
  for (const e of events) {
    const t = new Date(e.timestamp);
    const hhmm = Number.isNaN(t.getTime()) ? "" : new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(t);
    out.push(chalk.hex(p.accent)(`  ${hhmm}`) + chalk.hex(p.dim)(`  ${e.source} · ${e.marker_count} marker${e.marker_count === 1 ? "" : "s"} scored`));
    // Everything the route sent back (its top three each way, scored above 0). Below the band
    // they are dim and say "Present" or "Subtle" — a read, not silence.
    const up = e.top_positive.filter((m) => m.value > 0).map((m) => chip(m.marker, m.value, p, m.value <= NEUTRAL_BAND));
    const down = e.top_negative.filter((m) => m.value > 0).map((m) => chip(m.marker, m.value, p, m.value <= NEUTRAL_BAND));
    if (!up.length && !down.length) out.push(chalk.hex(p.dim)("    nothing scored"));
    if (up.length) out.push("    " + up.join("   "));
    if (down.length) out.push("    " + down.join("   "));
  }
  return [...out, ""];
}

/**
 * The habits as the screen numbers them: due today first, then the off-schedule ones, routines
 * left out. `/habit 2` means the second line of this list, so Home and the picker both use it.
 */
export function orderedHabits(habits: HomeHabit[]): HomeHabit[] {
  const shown = habits.filter((h) => !h.is_routine);
  return [...shown.filter((h) => h.scheduled_today !== false), ...shown.filter((h) => h.scheduled_today === false)];
}

function habitLine(h: HomeHabit, n: number, p: Palette, running?: TimerSession, now = Date.now()): string {
  const done = h.done_today;
  const num = chalk.hex(p.dim)(String(n).padStart(2) + " ");
  const mark = done
    ? chalk.hex(p.success)("✓")
    : running
      ? chalk.hex(p.accent)(running.status === "running" ? "▶" : "⏸")
      : h.habit_prompt
        ? chalk.hex(p.accent)("?")
        : chalk.hex(p.dim)("○");
  let name = done ? chalk.hex(p.dim)(h.metric_name) : chalk.hex(p.text)(h.metric_name);
  if (h.scheduled_today === false && !done) name = chalk.hex(p.dim)(h.metric_name);
  const bits: string[] = [];
  if (running) bits.push(`${running.status === "running" ? "▶" : "⏸"} ${formatDuration(liveElapsed(running, now))}`);
  else if (h.habit_timer_minutes != null && !done) bits.push(`${h.habit_timer_minutes} min timer`);
  if (h.aggregation_type === "sum" && h.habit_target > 1 && h.habit_timer_minutes == null) bits.push(`${h.today_value}/${h.habit_target}`);
  if (h.habit_prompt && !done) bits.push("asks a question");
  if (h.scheduled_today === false) bits.push("not today");
  if (h.streak > 0) bits.push(`${h.streak}-day streak`);
  return ` ${num}${mark} ${name}` + (bits.length ? chalk.hex(p.dim)(`  · ${bits.join(" · ")}`) : "");
}

/** "Mon 09-01" — weekday and month-day, in the local timezone. */
function shortDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(5, 10);
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "2-digit", day: "2-digit" })
    .format(d)
    .replace(",", "")
    .replace(/(\d\d)\/(\d\d)/, "$1-$2");
}

/**
 * The past week, one line per day that had a read, oldest at the top so the newest sits nearest
 * the input. The rule says how many of the seven days had one — a quiet week is a real answer.
 */
export function weekLines(week: DayRead[], p: Palette, width: number): string[] {
  const w = width - 1;
  const days = new Set(week.map((r) => dayOf(r.day)));
  const out = [rule(`past week · ${days.size} of 7 days read`, p, w)];
  if (!week.length) return [...out, chalk.hex(p.dim)("  nothing read this week yet")];
  for (const r of week) {
    const chips = topChips(r.signals, p, 3);
    out.push(
      chalk.hex(p.dim)(`  ${shortDay(r.day)}  `) +
        (chips.length ? chips.join("   ") : chalk.hex(p.dim)("nothing scored")) +
        chalk.hex(p.dim)(r.sample_size > 1 ? `  · ${r.sample_size} entries` : ""),
    );
  }
  return out;
}

/** The top of the screen: greeting, latest read, the past week, today's habits. Rebuilt whenever Home reloads. */
export function headerLines(home: HomeData | null, p: Palette, width: number, now = Date.now()): string[] {
  const w = width - 1;
  const out: string[] = [""];
  if (!home) {
    out.push(chalk.hex(p.accent).bold("  ◆ coen") + chalk.hex(p.dim)("  loading…"), "");
    return out;
  }
  const c = home.checkIn;
  const streak = c.streakDays > 0 ? `${c.streakDays}-day streak` : "no streak yet";
  const today = c.checkedInToday ? "checked in today" : "not yet today";
  out.push(
    chalk.hex(p.accent).bold("  ◆ coen") +
      chalk.hex(p.text)(`  ${greeting()}${c.firstName ? `, ${c.firstName}` : ""}`) +
      chalk.hex(p.dim)(`  ·  ${streak}  ·  ${today}`),
    "",
  );

  const when = home.latest ? `${timeAgo(home.latest.created_at)}` : "";
  out.push(rule(`latest read${when ? ` · ${when}` : ""}`, p, w));
  out.push(...signalLines(home.latest, p));
  if (home.latest?.journal?.entry_text) {
    const text = home.latest.journal.entry_text.replace(/\s+/g, " ").trim();
    const short = text.length > 240 ? text.slice(0, 237) + "…" : text;
    out.push(...wrapLines(chalk.hex(p.dim)(`  “${short}”`), w));
  }
  out.push("");

  out.push(...weekLines(home.week ?? [], p, width), "");

  const ordered = orderedHabits(home.habits);
  const due = ordered.filter((h) => h.scheduled_today !== false);
  const done = due.filter((h) => h.done_today).length;
  out.push(rule(ordered.length ? `today · ${done} of ${due.length} done · /habit <number> ticks one` : "today", p, w));
  if (!ordered.length) out.push(chalk.hex(p.dim)("  no habits yet — add them on the dashboard"));
  const byKey = new Map((home.timers ?? []).map((t) => [t.metric_key, t]));
  ordered.forEach((h, i) => out.push(habitLine(h, i + 1, p, byKey.get(h.metric_key), now)));
  out.push("");
  out.push(...timerLines(home.timers ?? [], p, width, now));
  return out;
}

// ─── the read-only views ─────────────────────────────────────────────────────

export function journalLines(entries: JournalEntry[], p: Palette, width: number, day?: string): string[] {
  const w = width - 1;
  const out = [rule(day ? `journal · ${day}` : "journal · recent", p, w)];
  if (!entries.length) return [...out, chalk.hex(p.dim)("  nothing here yet"), ""];
  // Oldest first, newest last. The pane sits at the bottom, so the latest entry is what you see
  // and older ones are a scroll up — the same direction as the transcript.
  const ordered = [...entries].sort((a, b) =>
    a.event_date === b.event_date ? a.created_at.localeCompare(b.created_at) : a.event_date.localeCompare(b.event_date),
  );
  for (const e of ordered) {
    out.push(chalk.hex(p.accent)(`  ${dayOf(e.event_date)}`) + chalk.hex(p.dim)(`  ${e.source}${e.has_signals ? "" : "  · not read yet"}`));
    const text = (e.entry_text ?? "").trim();
    const body = text.length > 600 ? text.slice(0, 597) + "…" : text;
    out.push(...wrapLines("    " + body.replace(/\n+/g, "\n    "), w));
    // What came through in this entry, when it has been read and anything rose above the band.
    if (e.signals && Object.keys(e.signals).length) {
      const chips = topChips(e.signals, p, 4);
      out.push("    " + (chips.length ? chips.join("   ") : chalk.hex(p.dim)("read, nothing scored")));
    }
    out.push("");
  }
  return out;
}

export function readLines(reports: EmotionalReport[], p: Palette, width: number): string[] {
  const w = width - 1;
  const out = [rule("emotional read · last 7 days", p, w)];
  if (!reports.length) return [...out, chalk.hex(p.dim)("  still forming — nothing read in the last week"), ""];
  const byDay = [...reports].sort((a, b) => a.report_period_start.localeCompare(b.report_period_start));
  for (const r of byDay) {
    const scores = Object.entries(r.emotional_averages)
      .filter((e): e is [string, number] => typeof e[1] === "number" && !e[0].startsWith("_"))
      .sort((a, b) => b[1] - a[1]);
    const lifting = scores.filter(([k, v]) => v > 0 && natureOf(k) === "lifting").slice(0, 3);
    const weighing = scores.filter(([k, v]) => v > 0 && natureOf(k) === "weighing").slice(0, 3);
    out.push(chalk.hex(p.accent)(`  ${dayOf(r.report_period_start)}`) + chalk.hex(p.dim)(`  ${r.sample_size} entr${r.sample_size === 1 ? "y" : "ies"}`));
    if (!lifting.length && !weighing.length) out.push(chalk.hex(p.dim)("    nothing scored that day"));
    const word = (k: string, v: number) => (v > NEUTRAL_BAND ? chalk.hex(p.text)(markerLabel(k)) : chalk.hex(p.dim)(markerLabel(k))) + " " + chalk.hex(p.dim)(intensityWord(v));
    if (lifting.length) out.push("    " + chalk.hex(p.success)("↑ ") + lifting.map(([k, v]) => word(k, v)).join("   "));
    if (weighing.length) out.push("    " + chalk.hex(p.warning)("↓ ") + weighing.map(([k, v]) => word(k, v)).join("   "));
  }
  return [...out, ""];
}

export function decisionLines(list: Decision[], p: Palette, width: number): string[] {
  const w = width - 1;
  const out = [rule("decisions · recent", p, w)];
  if (!list.length) return [...out, chalk.hex(p.dim)("  none recorded yet — /decision"), ""];
  const key = (d: Decision) => d.decision_date ?? d.created_at;
  for (const d of [...list].sort((a, b) => key(a).localeCompare(key(b)))) {
    out.push(
      chalk.hex(p.accent)(`  ${dayOf(d.decision_date ?? d.created_at)}`) +
        chalk.hex(p.text)(`  ${d.title}`) +
        chalk.hex(p.dim)(`  · ${d.decision_type.replace(/_/g, " ")} · ${d.status}`),
    );
    const why = (d.rationale || d.description || "").trim();
    if (why) out.push(...wrapLines(chalk.hex(p.dim)("    " + (why.length > 300 ? why.slice(0, 297) + "…" : why)), w));
  }
  return [...out, ""];
}

export function reminderLines(list: Reminder[], p: Palette, width: number): string[] {
  const w = width - 1;
  const out = [rule("reminders", p, w)];
  const active = list.filter((r) => r.is_active !== false);
  if (!active.length) return [...out, chalk.hex(p.dim)("  none yet — /reminder"), ""];
  for (const r of active) {
    const pin = r.is_pinned ? chalk.hex(p.accent)("📌 ") : "   ";
    out.push(...wrapLines(pin + chalk.hex(p.text)(r.content) + (r.attribution ? chalk.hex(p.dim)(` — ${r.attribution}`) : ""), w));
  }
  return [...out, ""];
}

/**
 * Your world: the people and things that keep coming up, and what each one is.
 *
 * Hidden ones are listed last and dimmed rather than left out — the person hid them from Coen's
 * surfaces, not from themselves, and they must be able to see what they hid to undo it.
 */
export function worldLines(list: LifeModelEntity[], p: Palette, width: number): string[] {
  const w = width - 1;
  const out = [rule("your world", p, w)];
  if (!list.length) return [...out, chalk.hex(p.dim)("  nothing yet — /world add names one yourself"), ""];

  const rank = (e: LifeModelEntity) => (e.status === "hidden" ? 2 : e.status === "inferred" ? 0 : 1);
  const sorted = [...list].sort((a, b) => rank(a) - rank(b) || b.mention_days - a.mention_days || a.label.localeCompare(b.label));
  const unchecked = list.filter((e) => e.status === "inferred").length;
  if (unchecked) out.push(chalk.hex(p.dim)(`  ${unchecked} Coen worked out on its own — check them, they may be wrong`), "");

  for (const e of sorted) {
    // "inferred" is a guess and says so; anything else is the person's own word about it.
    const state =
      e.status === "inferred" ? chalk.hex(p.warning)("inferred")
      : e.status === "hidden" ? chalk.hex(p.dim)("hidden")
      : e.status === "confirmed" ? chalk.hex(p.success)("confirmed")
      : chalk.hex(p.success)("your words");
    const label = e.status === "hidden" ? chalk.hex(p.dim)(e.label) : chalk.hex(p.text)(e.label);
    const kind = [e.entity_type, e.relation].filter(Boolean).join(" · ");
    const days = e.mention_days ? `${e.mention_days} day${e.mention_days === 1 ? "" : "s"}` : "not seen yet";
    out.push(...wrapLines(`  ${label}${kind ? chalk.hex(p.dim)(`  ${kind}`) : ""}  ${state} ${chalk.hex(p.dim)(days)}`, w));
    if (e.user_note) out.push(...wrapLines(chalk.hex(p.dim)(`    "${e.user_note}"`), w));
  }
  return [...out, ""];
}

export function realizationLines(list: Realization[], p: Palette, width: number): string[] {
  const w = width - 1;
  const out = [rule("realizations · recent", p, w)];
  if (!list.length) return [...out, chalk.hex(p.dim)("  none yet — /insight"), ""];
  for (const r of [...list].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    out.push(chalk.hex(p.accent)(`  ${dayOf(r.created_at)}`) + chalk.hex(p.text)(`  ${r.title ?? ""}`) + (r.tags?.length ? chalk.hex(p.dim)(`  [${r.tags.join(", ")}]`) : ""));
    const body = (r.content ?? "").trim();
    out.push(...wrapLines(chalk.hex(p.dim)("    " + (body.length > 400 ? body.slice(0, 397) + "…" : body)), w));
  }
  return [...out, ""];
}

/**
 * Daily activity reports.
 *
 * The worker writes one of these per day from the evidence it has — what was done, what it
 * concluded, what is next. The fields it fills live in `metadata`; the names below are the ones
 * coen1-web's reports panel reads, so a report reads the same in both places.
 */

interface ReportMeta {
  hours_estimated?: number | null;
  categories?: Record<string, number>;
  tasks_completed?: { title?: string }[];
  tasks_progressed?: { title?: string }[];
  decisions_made?: { title?: string }[];
  relationships_engaged?: { name?: string; outcome?: string }[];
  github_summary?: string | null;
  emotional_pattern?: string | null;
}

const meta = (r: DailyReport): ReportMeta => (r.metadata as ReportMeta) ?? {};

/** "4.5h · building 2.5, admin 1" — the shape of a day, when the worker estimated one. */
function shapeOfDay(m: ReportMeta): string {
  const bits: string[] = [];
  if (typeof m.hours_estimated === "number" && m.hours_estimated > 0) bits.push(`${m.hours_estimated}h`);
  const cats = Object.entries(m.categories ?? {})
    .filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`);
  if (cats.length) bits.push(cats.join(", "));
  return bits.join(" · ");
}

/** How many days the worker still owes, said in words rather than as a bare number. */
function pendingLine(pending: number, p: Palette): string {
  return chalk.hex(p.dim)(`  ${pending} more day${pending === 1 ? "" : "s"} still being written`);
}

export function reportListLines(reports: DailyReport[], pending: number, p: Palette, width: number): string[] {
  const w = width - 1;
  const out = [rule("daily reports", p, w)];
  if (!reports.length) {
    out.push(chalk.hex(p.dim)("  no reports yet — they are written from the day's evidence"));
    if (pending > 0) out.push(pendingLine(pending, p));
    return [...out, ""];
  }
  if (pending > 0) out.push(pendingLine(pending, p), "");
  // Oldest first, newest last — the pane sits at the bottom, so the latest day is what you see and
  // older ones are a scroll up. Same direction as /journal.
  const ordered = [...reports].sort((a, b) => dayOf(a.original_date).localeCompare(dayOf(b.original_date)));
  // Numbered by the position in the list as SHOWN, so /reports 1 is the top line you can see.
  ordered.forEach((r, i) => {
    const m = meta(r);
    out.push(
      chalk.hex(p.dim)(`  ${String(i + 1).padStart(2)}. `) +
        chalk.hex(p.accent)(dayOf(r.original_date)) +
        chalk.hex(p.text)(`  ${r.title ?? "untitled"}`),
    );
    const shape = shapeOfDay(m);
    if (shape) out.push(chalk.hex(p.dim)(`      ${shape}`));
    const body = (r.summary ?? "").trim();
    if (body) out.push(...wrapLines(chalk.hex(p.dim)("      " + (body.length > 600 ? body.slice(0, 597) + "…" : body)), w));
    out.push("");
  });
  out.push(chalk.hex(p.dim)("  /reports <number> opens one in full"), "");
  return out;
}

/** A titled block of lines, skipped entirely when there is nothing in it. */
function section(label: string, items: string[], p: Palette, width: number): string[] {
  if (!items.length) return [];
  const out = [chalk.hex(p.accent)(`  ${label}`)];
  for (const it of items) out.push(...wrapLines(chalk.hex(p.text)("    · " + it), width));
  return [...out, ""];
}

export function reportDetailLines(r: DailyReport, p: Palette, width: number): string[] {
  const w = width - 1;
  const m = meta(r);
  const day = dayOf(r.original_date);
  const out = [rule(`report · ${day}`, p, w)];
  out.push(chalk.hex(p.text).bold(`  ${r.title ?? "untitled"}`));
  const shape = shapeOfDay(m);
  if (shape) out.push(chalk.hex(p.dim)(`  ${shape}`));
  out.push("");

  const para = (label: string, text: string | null | undefined) => {
    const t = (text ?? "").trim();
    if (!t) return;
    out.push(chalk.hex(p.accent)(`  ${label}`));
    out.push(...wrapLines(chalk.hex(p.text)("    " + t.replace(/\n+/g, "\n    ")), w));
    out.push("");
  };

  para("Summary", r.summary);
  // report_text is the long form. It repeats the summary when the worker had little to add, so it
  // is only worth printing when it is actually longer.
  const full = (r.report_text ?? "").trim();
  if (full && full !== (r.summary ?? "").trim()) para("The day", full);
  para("Conclusion", r.conclusion);
  para("Next", r.next_steps);

  const titles = (list?: { title?: string }[]) =>
    (list ?? []).map((t) => (t.title ?? "").trim()).filter(Boolean);

  out.push(...section("Finished", titles(m.tasks_completed), p, w));
  out.push(...section("Moved along", titles(m.tasks_progressed), p, w));
  out.push(...section("Decided", titles(m.decisions_made), p, w));
  out.push(
    ...section(
      "People",
      (m.relationships_engaged ?? [])
        .map((x) => [x.name, x.outcome].filter(Boolean).join(" — "))
        .filter(Boolean),
      p,
      w,
    ),
  );

  para("Code", m.github_summary);
  para("How it felt", m.emotional_pattern);

  return out;
}

/**
 * Seconds on the clock right now. The server owns the clock: `elapsed_seconds` is the total of
 * finished segments, and `resumed_at` non-null means one is open, so the live figure is the sum
 * of the two. Identical arithmetic to the web's habit-timer-core, deliberately — a session
 * started on the phone must read the same here.
 */
export function liveElapsed(s: TimerSession, now = Date.now()): number {
  const open = s.resumed_at ? Math.max(0, (now - new Date(s.resumed_at).getTime()) / 1000) : 0;
  return Math.floor(s.elapsed_seconds + open);
}

/** m:ss, or h:mm:ss past an hour. */
export function formatDuration(totalSeconds: number): string {
  const t = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** "▶ Morning pages 12:34 / 20:00" — the one-line form for the top bar. */
export function timerChip(s: TimerSession, now = Date.now()): string {
  const elapsed = formatDuration(liveElapsed(s, now));
  const target = s.target_seconds ? ` / ${formatDuration(s.target_seconds)}` : "";
  const mark = s.status === "running" ? "▶" : "⏸";
  const phase = s.mode === "pomodoro" && s.phase !== "work" ? ` (${s.phase.replace(/_/g, " ")})` : "";
  return `${mark} ${s.habit_name ?? s.metric_key} ${elapsed}${target}${phase}`;
}

/** The running-timer block on Home, under the habits. */
export function timerLines(sessions: TimerSession[], p: Palette, width: number, now = Date.now()): string[] {
  if (!sessions.length) return [];
  const w = width - 1;
  const many = sessions.length > 1;
  const out = [rule(many ? `on the clock · ${sessions.length}` : "on the clock", p, w)];
  sessions.forEach((s, i) => {
    const col = s.status === "running" ? p.accent : p.warning;
    // Numbered when there is more than one, because that number is how you name it to /timer.
    out.push(
      (many ? chalk.hex(p.dim)(`  ${i + 1} `) : "  ") +
        chalk.hex(col)(timerChip(s, now)) +
        chalk.hex(p.dim)(s.mode === "pomodoro" && s.pomodoros_completed > 0 ? `  · ${s.pomodoros_completed} done` : ""),
    );
  });
  out.push(
    chalk.hex(p.dim)(many ? "  /timer done <number> · pause · resume · discard" : "  /timer done to finish · pause · resume · discard"),
    "",
  );
  return out;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "every day", "weekdays", "Mon Wed Fri", "3× a week", "every 2 weeks on Sat" — from the raw schedule fields. */
export function describeSchedule(h: HomeHabit): string {
  if (h.habit_schedule_type === "times_per_week") return `${h.habit_period_target ?? "?"}× a week`;
  if (h.habit_schedule_type === "times_per_month") return `${h.habit_period_target ?? "?"}× a month`;
  const days = [...(h.habit_days ?? [])].sort();
  let when: string;
  if (days.length === 7) when = "every day";
  else if (days.join(",") === "1,2,3,4,5") when = "weekdays";
  else if (days.join(",") === "0,6") when = "weekends";
  else when = days.map((d) => DAY_NAMES[d] ?? String(d)).join(" ");
  const every = (h.habit_interval_weeks ?? 1) > 1 ? `every ${h.habit_interval_weeks} weeks · ` : "";
  return every + when;
}

/** /habits — every habit, numbered as on Home, with its schedule, target and streak. */
export function habitsLines(habits: HomeHabit[], p: Palette, width: number): string[] {
  const w = width - 1;
  const ordered = orderedHabits(habits);
  const out = [rule(`habits · ${ordered.length} · /habit <number> ticks one · /newhabit adds one`, p, w)];
  if (!ordered.length) return [...out, chalk.hex(p.dim)("  none yet — /newhabit"), ""];
  let group: string | null | undefined;
  ordered.forEach((h, i) => {
    if (h.group_name !== group) {
      group = h.group_name;
      out.push("", chalk.hex(p.dim)(`  ${group ?? "ungrouped"}`));
    }
    const done = h.done_today;
    const mark = done ? chalk.hex(p.success)("✓") : h.habit_prompt ? chalk.hex(p.accent)("?") : chalk.hex(p.dim)("○");
    const goal = h.habit_prompt
      ? "asks a question"
      : h.habit_timer_minutes != null
        ? `${h.habit_timer_minutes} min on a clock`
        : h.aggregation_type === "sum"
          ? `${h.habit_target} ${h.unit ?? ""}`.trim()
          : "yes / no";
    out.push(
      chalk.hex(p.dim)(`  ${String(i + 1).padStart(2)} `) + mark + " " +
        chalk.hex(done || h.scheduled_today === false ? p.dim : p.text)(h.metric_name) +
        chalk.hex(p.dim)(`  · ${describeSchedule(h)} · ${goal}${h.streak > 0 ? ` · ${h.streak}-day streak` : ""}${h.scheduled_today === false ? " · not today" : ""}`),
    );
    if (h.habit_prompt) out.push(...wrapLines(chalk.hex(p.dim)(`       “${h.habit_prompt}”`), w));
    else if (h.description) out.push(...wrapLines(chalk.hex(p.dim)(`       ${h.description}`), w));
  });
  return [...out, ""];
}

/** Local midnight at the start of the calendar week (Monday) `offset` weeks ago, and the next Monday. */
export function weekBounds(offset: number): { start: Date; end: Date } {
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - offset * 7);
  const end = new Date(monday);
  end.setDate(end.getDate() + 7);
  return { start: monday, end };
}

export function weekLabel(offset: number): string {
  if (offset === 0) return "this week";
  if (offset === 1) return "last week";
  return `${offset} weeks ago`;
}

/** The markers of a daily report, cleaned the way the dashboard cleans them. */
export function reportSignals(r: EmotionalReport): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.emotional_averages)) {
    if (!k.startsWith("_") && typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100) out[k] = v;
  }
  return out;
}

/**
 * The signals tab: one calendar week, every day listed whether or not it was read, the strongest
 * markers of each. ← and → (with the input empty) page through the weeks; the rule says which.
 */
export function weekViewLines(offset: number, reports: EmotionalReport[], p: Palette, width: number): string[] {
  const w = width - 1;
  const { start } = weekBounds(offset);
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d);
  const last = new Date(start);
  last.setDate(last.getDate() + 6);
  const byDay = new Map<string, EmotionalReport>();
  for (const r of reports) byDay.set(dayOf(r.report_period_start), r);
  const out = [
    rule(`signals · ${weekLabel(offset)} · ${fmt(start)} – ${fmt(last)} · ${byDay.size} of 7 days read`, p, w),
    chalk.hex(p.dim)("  ← older week · newer week →   (with the input empty)   /signals last · /signals next · /signals <weeks ago>"),
    "",
  ];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    const r = byDay.get(key);
    const future = d.getTime() > Date.now();
    const head = chalk.hex(future ? p.dim : p.text)(`  ${shortDay(d.toISOString())}  `);
    if (!r) {
      out.push(head + chalk.hex(p.dim)(future ? "" : "—"));
      continue;
    }
    const chips = topChips(reportSignals(r), p, 4);
    out.push(head + (chips.length ? chips.join("   ") : chalk.hex(p.dim)("nothing scored")) + chalk.hex(p.dim)(r.sample_size > 1 ? `  · ${r.sample_size} entries` : ""));
    out.push(chalk.hex(p.dim)(`             /signals ${key} for that day's check-ins`));
  }
  return [...out, ""];
}

/** A plain note row, the way the chat shows its notes. */
export function noteLines(text: string, p: Palette, width: number): string[] {
  return [...wrapLines(chalk.hex(p.accentDim)("· " + text), width - 1), ""];
}
