import { readMatrix, composites, markerLabel } from "../markers.js";

/**
 * Records to markdown.
 *
 * The vocabulary is not invented here. A read is rendered with `readMatrix` and `markerLabel`
 * from ../markers.js — the same functions Home prints with — so the folder and the screen say the
 * same words about the same day. Anything this file decides on its own is layout.
 */

const PLAIN = /^[A-Za-z0-9][A-Za-z0-9 ._/@+-]*$/;
/** An ISO timestamp. Left unquoted — it is what a front-matter reader expects to see, and the
 *  colons in it are the only reason the plain test above would reject it. */
const ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** A YAML scalar. Quoted unless it is plainly safe, because titles come off the network. */
function scalar(v: unknown): string {
  if (v === null || v === undefined) return '""';
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return `[${v.map(scalar).join(", ")}]`;
  const s = String(v);
  return PLAIN.test(s) || ISO.test(s) ? s : JSON.stringify(s);
}

/**
 * The block at the top of every mirror file. Fields that are null or undefined are left out
 * rather than written as empty — an absent field and a field that is blank are different things.
 */
export function frontMatter(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}: ${scalar(v)}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

/** Join sections, collapse the runs of blank lines a builder leaves behind, end with one newline. */
export const doc = (...parts: (string | null | undefined | false)[]): string =>
  parts.filter(Boolean).join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "\n");

export const heading = (level: number, text: string): string => `\n${"#".repeat(level)} ${text}\n`;

/** A markdown table. Cells are escaped so a pipe in someone's writing can't break the row. */
export function table(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ");
  const out = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const r of rows) out.push(`| ${r.map(cell).join(" | ")} |`);
  return out.join("\n") + "\n";
}

/** "Relief (present), Calm (subtle)" */
const markerList = (list: { marker: string; intensity: string }[]): string =>
  list.map((m) => `${markerLabel(m.marker)} (${m.intensity})`).join(", ");

/**
 * One read as its own section. Empty string when nothing came through above the neutral band —
 * a heading with nothing under it reads as a failure, and a quiet day is not one.
 */
export function readSection(avgs: Record<string, unknown> | null | undefined, level = 2): string {
  const m = readMatrix(avgs);
  const lines: string[] = [];
  if (m.lifting.length) lines.push(`Lifting: ${markerList(m.lifting)}`);
  if (m.weighing.length) lines.push(`Weighing: ${markerList(m.weighing)}`);
  if (m.worth_noticing.length) lines.push(`Worth noticing: ${markerList(m.worth_noticing)}`);
  const c = composites(avgs);
  const bits = [
    c.positive_signal != null && `positive ${c.positive_signal}`,
    c.negative_signal != null && `negative ${c.negative_signal}`,
    c.burnout_risk != null && `burnout risk ${c.burnout_risk}`,
  ].filter(Boolean);
  if (bits.length) lines.push(`Signals: ${bits.join(" · ")}`);
  if (!lines.length) return "";
  return `${heading(level, "Read")}\n${lines.join("  \n")}\n`;
}

/** The same read on one line, for a table cell or a monthly roll-up. */
export function readLine(avgs: Record<string, unknown> | null | undefined): string {
  const m = readMatrix(avgs);
  const bits = [
    m.lifting.length && `lifting: ${markerList(m.lifting)}`,
    m.weighing.length && `weighing: ${markerList(m.weighing)}`,
    m.worth_noticing.length && `noticing: ${markerList(m.worth_noticing)}`,
  ].filter(Boolean);
  return bits.length ? bits.join(" · ") : "quiet";
}

/** Body text, as written, with the trailing whitespace an editor left. */
export const body = (text: string | null | undefined): string =>
  text ? `\n${text.replace(/\r\n/g, "\n").replace(/\s+$/, "")}\n` : "";
