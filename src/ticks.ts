import { type HomeData, type HomeHabit } from "./api.js";

/**
 * What a check-in did to the habits.
 *
 * A check-in does not only get read. The same worker run that scores it also scans it against
 * every habit's keywords and ticks the ones it matched — on a different queue, so those ticks
 * land a beat after the read does. Nothing on the screen used to say so: the habit went from ○
 * to ✓ quietly, and only if you happened to look again.
 *
 * Take `before` the moment the check-in is sent, compare after, and the difference is what the
 * words did.
 */

/** Where every habit stood at a moment in time. */
export const habitValues = (habits: HomeHabit[]): Map<string, number> =>
  new Map(habits.map((h) => [h.metric_key, h.today_value]));

/**
 * The habits that moved since `before`, in the words the screen uses: done ones by name, ones
 * part-way with the number. A habit that did not exist when `before` was taken is left out — we
 * cannot say the check-in moved it.
 */
export function habitsMoved(before: Map<string, number>, data: HomeData | null): string[] {
  if (!data) return [];
  const out: string[] = [];
  for (const h of data.habits) {
    const was = before.get(h.metric_key);
    if (was === undefined || h.today_value <= was) continue;
    out.push(
      h.done_today
        ? `${h.metric_name} ✓`
        : `${h.metric_name} ${h.today_value}/${h.habit_target}${h.unit ? ` ${h.unit}` : ""}`,
    );
  }
  return out;
}

/** "2 habits: Walk the dog ✓ · Water 5/8 glasses" — or null when it moved nothing. */
export function movedLine(moved: string[]): string | null {
  if (!moved.length) return null;
  return `${moved.length === 1 ? "a habit" : `${moved.length} habits`}: ${moved.join(" · ")}`;
}
