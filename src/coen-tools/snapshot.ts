import * as api from "../api.js";
import { readMatrix } from "../markers.js";
import { dayOf } from "../day.js";
import { type ToolContext } from "./context.js";

/**
 * The life snapshot: where the person is right now, in one call.
 *
 * The MCP server built this from a dozen queries in one process. The CLI builds it from the web
 * app's own routes, in parallel — nine requests, once per session, against the same host Home
 * already talks to. Nothing here is derived that the dashboard doesn't already derive.
 *
 * It renders to compact text, not JSON, and that is deliberate: measured on the server in August
 * 2026, the JSON form cost ~6.5k tokens per turn, 60% of the fixed prompt, most of it field names
 * repeated per habit and full decision bodies. The model needs one line per thing; the detail
 * tools exist for more.
 */

const trim = (t: string | null | undefined, n: number): string =>
  t && t.length > n ? `${t.slice(0, n).replace(/\s+\S*$/, "")}…` : t || "";

const fmtMarkers = (list: { marker: string; intensity: string }[]) =>
  list.slice(0, 4).map((m) => `${m.marker.replace(/_/g, " ")} (${m.intensity})`).join(", ");

/** Everything the snapshot needs, fetched at once. A section that fails is empty, not fatal. */
async function gather(ctx: ToolContext) {
  const c = ctx.client;
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [home, profile, status, reports, journal, lifeModel, decisions, realizations, reminders] =
    await Promise.all([
      ctx.home(),
      api.getAccountProfile(c).catch(() => null),
      api.getPersonalStatus(c).catch(() => null),
      api.listReportsBetween(c, weekAgo, new Date().toISOString()).catch(() => []),
      api.listJournal(c, { limit: 3 }).catch(() => []),
      api.listLifeModel(c).catch(() => []),
      api.listDecisions(c, 5).catch(() => []),
      api.listRealizations(c, 5).catch(() => []),
      api.listReminders(c).catch(() => []),
    ]);
  return { home, profile, status, reports, journal, lifeModel, decisions, realizations, reminders };
}

export async function buildSnapshot(ctx: ToolContext): Promise<string> {
  const g = await gather(ctx);
  const L: string[] = [];

  L.push(`As of ${dayOf(new Date().toISOString())} (${g.home.timezone}).`);
  if (g.profile) L.push(`\nProfile, in their words: ${trim(g.profile, 600)}`);

  L.push("\nEmotional read, last 7 days (what came through above the neutral band):");
  const byDay = new Map<string, api.EmotionalReport>();
  for (const r of g.reports) byDay.set(dayOf(r.report_period_start), r);
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  if (!days.length) L.push("  still forming — no daily reads yet");
  for (const [day, r] of days) {
    const m = readMatrix(r.emotional_averages as Record<string, unknown>);
    const bits: string[] = [];
    if (m.lifting.length) bits.push(`lifting: ${fmtMarkers(m.lifting)}`);
    if (m.weighing.length) bits.push(`weighing: ${fmtMarkers(m.weighing)}`);
    if (m.worth_noticing.length) bits.push(`noticing: ${fmtMarkers(m.worth_noticing)}`);
    L.push(`  ${day}: ${bits.length ? bits.join(" · ") : "quiet"}`);
  }
  if (g.status?.you) {
    const y = g.status.you;
    const parts: string[] = [];
    if (y.status) parts.push(`status ${y.status}`);
    if (y.drivers?.length) parts.push(y.drivers.join("; "));
    if (y.coverage?.dataSpanDays != null) parts.push(`${y.coverage.dataSpanDays} days of signal`);
    if (parts.length) L.push(`  baseline: ${parts.join(" · ")}`);
  }

  L.push("\nHabits today:");
  if (!g.home.habits.length) L.push("  none set up");
  for (const h of g.home.habits) {
    const state = h.done_today ? "done" : h.scheduled_today ? "not yet" : "not scheduled today";
    const count = h.habit_period_target
      ? ` · ${h.period_done ?? 0}/${h.habit_period_target} this ${h.habit_schedule_type.includes("month") ? "month" : "week"}`
      : "";
    const streak = h.streak ? ` · streak ${h.streak}` : "";
    const grp = h.group_name ? ` [${h.group_name}]` : "";
    L.push(
      `  ${h.metric_name}${grp} (${h.metric_key}): ${state}${count}${streak}` +
        `${h.is_routine ? " · routine" : ""}${h.habit_prompt ? " · asks a question" : ""}`,
    );
  }

  L.push("\nRecent journal:");
  if (!g.journal.length) L.push("  nothing stored yet");
  for (const j of g.journal) {
    L.push(`  ${dayOf(j.event_date ?? j.created_at)}: "${trim(j.entry_text.replace(/\s+/g, " "), 280)}"`);
  }

  L.push('\nPeople and things they write about (most-mentioned first; "inferred" = Coen\'s guess):');
  const entities = g.lifeModel.filter((e) => e.status !== "hidden").slice(0, 10);
  if (!entities.length) L.push("  none recognised yet");
  for (const e of entities) {
    const rel = e.relation ? `, ${e.relation}` : "";
    const note = e.user_note ? ` — "${trim(e.user_note, 80)}"` : "";
    L.push(`  ${e.label} (${e.entity_type}${rel}; ${e.status}; ${e.mention_days} days; slug ${e.slug})${note}`);
  }

  L.push("\nRecent decisions (get_decisions for the why):");
  if (!g.decisions.length) L.push("  none logged");
  for (const d of g.decisions) {
    L.push(`  ${dayOf(d.decision_date ?? d.created_at)}: ${d.title} · ${d.decision_type} · ${d.status}`);
  }

  L.push("\nRecent realizations:");
  if (!g.realizations.length) L.push("  none logged");
  for (const r of g.realizations) {
    L.push(`  ${dayOf(r.created_at)}: ${r.title || trim(r.content, 100)}`);
  }

  const active = g.reminders.filter((r) => r.is_active !== false);
  if (active.length) {
    L.push("\nTheir reminders to themselves:");
    for (const r of active.slice(0, 10)) {
      L.push(`  "${r.content}"${r.attribution ? ` — ${r.attribution}` : ""}`);
    }
    const pick = active.find((r) => r.is_pinned) ?? active[0];
    if (pick) L.push(`\nShowing today on the dashboard: "${pick.content}"`);
  }

  return L.join("\n");
}
