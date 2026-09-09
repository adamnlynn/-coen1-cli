import { useMemo, useState } from "react";
import { Box, Text, type Key } from "ink";
import type { Palette } from "./theme.js";

/** One slash command: the name, a hint for the menu, and whether it takes an argument. */
export interface Command {
  name: string;
  hint: string;
  arg?: boolean;
}

/**
 * Slash-command autocomplete, shared by chat and Home. Matches only while the command name is
 * being typed (no space yet). ↑/↓ move, Tab completes, Esc dismisses until the next edit. Enter
 * is left to the input's onSubmit so the current line runs.
 */
export function useSlashMenu(commands: Command[], input: string, setInput: (v: string) => void, enabled: boolean) {
  const [idx, setIdx] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const suggestions = useMemo(() => {
    if (!input.startsWith("/") || input.includes(" ")) return [];
    const q = input.toLowerCase();
    return commands.filter((c) => c.name.startsWith(q));
  }, [commands, input]);
  const show = enabled && suggestions.length > 0 && !dismissed;
  const active = Math.min(idx, Math.max(0, suggestions.length - 1));

  /** Call from the input's onChange so an edit re-opens the menu. */
  function onEdit() {
    setDismissed(false);
    setIdx(0);
  }

  /** Handle a key while the menu is open. Returns true when it consumed the key. */
  function onKey(key: Key): boolean {
    if (!show) return false;
    if (key.upArrow) {
      setIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
      return true;
    }
    if (key.downArrow) {
      setIdx((i) => (i + 1) % suggestions.length);
      return true;
    }
    if (key.tab) {
      const c = suggestions[active] ?? suggestions[0];
      setInput(c.arg ? c.name + " " : c.name); // arg commands get a trailing space to type the value
      setDismissed(true); // collapse; Enter then runs it
      return true;
    }
    if (key.escape) {
      setDismissed(true);
      return true;
    }
    return false;
  }

  return { suggestions, show, active, onEdit, onKey };
}

export function SlashMenu({ suggestions, active, palette }: { suggestions: Command[]; active: number; palette: Palette }) {
  return (
    <Box flexDirection="column" marginLeft={2}>
      {suggestions.slice(0, 8).map((c, i) => {
        const on = i === active;
        return (
          <Text key={c.name} color={on ? palette.accent : undefined}>
            {on ? "▸ " : "  "}
            {c.name.padEnd(14)}
            <Text color={palette.dim}>{c.hint}</Text>
          </Text>
        );
      })}
      <Text color={palette.dim}>↑/↓ select · Tab complete · Enter run · Esc dismiss</Text>
    </Box>
  );
}
