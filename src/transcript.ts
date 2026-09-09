import chalk from "chalk";
import wrapAnsi from "wrap-ansi";
import type { Palette } from "./theme.js";

/** One item of the on-screen transcript. */
export interface Turn {
  role: "user" | "assistant" | "note";
  text: string;
}

/** Wrap to `width` columns, hard-breaking anything longer, keeping existing newlines.
 *  Returns terminal rows, one string each. */
export function wrapLines(text: string, width: number): string[] {
  return wrapAnsi(text, Math.max(20, width), { hard: true, trim: false }).split("\n");
}

/** Render one turn to terminal rows, styled with ANSI so the pane can show a slice of rows
 *  without re-laying-out the whole history. `md` renders assistant markdown (already reflowed
 *  to the terminal width by marked-terminal). Each turn ends with a blank row. */
export function turnLines(turn: Turn, palette: Palette, width: number, md: (s: string) => string): string[] {
  const w = width - 1; // never touch the last column — some terminals wrap on it
  if (turn.role === "user") {
    return [...wrapLines(chalk.hex(palette.accent).bold("❯ ") + chalk.hex(palette.text)(turn.text), w), ""];
  }
  if (turn.role === "note") {
    return [...wrapLines(chalk.hex(palette.accentDim)("· " + turn.text), w), ""];
  }
  const body = md(turn.text)
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");
  return [chalk.hex(palette.accent).bold("◆ coen"), ...wrapLines(body, w), ""];
}

/** The reply as it streams: header plus the raw partial text (rendered as markdown once done). */
export function liveLines(partial: string, palette: Palette, width: number): string[] {
  const head = chalk.hex(palette.accent).bold("◆ coen");
  if (!partial) return [head];
  const body = partial
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");
  return [head, ...wrapLines(body, width - 1)];
}
