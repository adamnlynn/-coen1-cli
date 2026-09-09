import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import type { HomeHabit } from "../api.js";
import { useTheme } from "../theme.js";
import { orderedHabits } from "./render.js";

/**
 * Arrow-key list of habits, numbered as on the screen. Esc cancels.
 *
 * Three commands open it and they do not want the same list: ticking offers only what is not
 * done yet, while editing and archiving are about the habit itself and have to offer all of
 * them — including the one already ticked this morning.
 */
export type HabitPickFor = "tick" | "edit" | "remove";

const HEADINGS: Record<HabitPickFor, { title: string; verb: string }> = {
  tick: { title: "✓ tick a habit", verb: "tick" },
  edit: { title: "◆ edit a habit", verb: "edit" },
  remove: { title: "◆ archive a habit", verb: "remove" },
};

export function HabitPick({
  habits,
  onPick,
  onCancel,
  pickFor = "tick",
}: {
  habits: HomeHabit[];
  onPick: (habit: HomeHabit) => void;
  onCancel: () => void;
  pickFor?: HabitPickFor;
}) {
  const { palette } = useTheme();
  useInput((_ch, key) => {
    if (key.escape) onCancel();
  });
  const heading = HEADINGS[pickFor];
  const ordered = orderedHabits(habits);
  const items = ordered.map((h, i) => ({ h, n: i + 1 })).filter(({ h }) => pickFor !== "tick" || !h.done_today).map(({ h, n }) => ({
    label:
      `${String(n).padStart(2)}  ${h.metric_name}` +
      (h.habit_prompt ? "  · asks a question" : "") +
      (h.scheduled_today === false ? "  · not today (bonus)" : "") +
      (h.streak > 0 ? `  · ${h.streak}-day streak` : ""),
    value: h.metric_key,
  }));
  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor={palette.accent} paddingX={2} paddingY={1}>
      <Text color={palette.accent} bold>{heading.title}</Text>
      <Text color={palette.dim}>
        {items.length
          ? `pick one — Esc to cancel · next time: /habit ${pickFor === "tick" ? "" : `${heading.verb} `}<number>`
          : pickFor === "tick"
            ? "everything is done today — Esc to close"
            : "no habits yet — /habit add makes one. Esc to close"}
      </Text>
      {items.length > 0 && (
        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={(item) => {
              const h = habits.find((x) => x.metric_key === item.value);
              if (h) onPick(h);
            }}
          />
        </Box>
      )}
    </Box>
  );
}
