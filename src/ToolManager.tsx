import { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ToolSet } from "ai";
import { useTheme } from "./theme.js";
import { toolPrefix } from "./mcp/spec.js";

type Row = { kind: "header"; group: string } | { kind: "tool"; group: string; key: string };

const VIEWPORT = 12;

/**
 * Windowed, grouped checklist to enable/disable tools (a disable-list — everything
 * not in the set stays enabled). ↑/↓ move, space toggles (a tool, or a whole server
 * on its header), Enter saves, Esc cancels.
 */
export function ToolManager({
  allTools,
  serverNames,
  disabled,
  onApply,
  onCancel,
}: {
  allTools: ToolSet;
  serverNames: string[]; // external server names, in order; the rest is built-in "coen"
  disabled: Set<string>;
  onApply: (next: Set<string>) => void;
  onCancel: () => void;
}) {
  const { palette } = useTheme();
  const [off, setOff] = useState<Set<string>>(new Set(disabled));
  const [cursor, setCursor] = useState(0);

  const groups = useMemo(() => {
    const keys = Object.keys(allTools);
    const assigned = new Set<string>();
    const ext: { name: string; keys: string[] }[] = [];
    // Longer prefixes first so "todoist_" wins over a hypothetical "todo_".
    for (const name of [...serverNames].sort((a, b) => toolPrefix(b).length - toolPrefix(a).length)) {
      const pre = toolPrefix(name);
      const gkeys = keys.filter((k) => k.startsWith(pre) && !assigned.has(k));
      gkeys.forEach((k) => assigned.add(k));
      ext.push({ name, keys: gkeys });
    }
    const coen = keys.filter((k) => !assigned.has(k));
    return [{ name: "coen", keys: coen }, ...ext].filter((g) => g.keys.length);
  }, [allTools, serverNames]);

  const rows = useMemo<Row[]>(() => {
    const r: Row[] = [];
    for (const g of groups) {
      r.push({ kind: "header", group: g.name });
      for (const k of g.keys) r.push({ kind: "tool", group: g.name, key: k });
    }
    return r;
  }, [groups]);

  const keysOf = (group: string) => groups.find((g) => g.name === group)?.keys ?? [];

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.return) return onApply(off);
    if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) return setCursor((c) => Math.min(rows.length - 1, c + 1));
    if (input === " ") {
      const row = rows[cursor];
      if (!row) return;
      setOff((prev) => {
        const next = new Set(prev);
        if (row.kind === "tool") {
          next.has(row.key) ? next.delete(row.key) : next.add(row.key);
        } else {
          const gk = keysOf(row.group);
          const allOn = gk.every((k) => !next.has(k));
          if (allOn) gk.forEach((k) => next.add(k));
          else gk.forEach((k) => next.delete(k));
        }
        return next;
      });
    }
  });

  const total = Object.keys(allTools).length;
  const enabled = total - [...off].filter((k) => k in allTools).length;
  const top = Math.max(0, Math.min(cursor - 5, Math.max(0, rows.length - VIEWPORT)));
  const slice = rows.slice(top, top + VIEWPORT);

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor={palette.accent} paddingX={2} paddingY={1}>
      <Text color={palette.accent} bold>◆ tools — {enabled}/{total} enabled</Text>
      <Text color={palette.dim}>↑/↓ move · space toggle (server header toggles all) · Enter save · Esc cancel</Text>
      <Box flexDirection="column" marginTop={1}>
        {top > 0 && <Text color={palette.dim}>  ▲ {top} more</Text>}
        {slice.map((row, i) => {
          const idx = top + i;
          const active = idx === cursor;
          const pointer = active ? "❯ " : "  ";
          if (row.kind === "header") {
            const gk = keysOf(row.group);
            const on = gk.filter((k) => !off.has(k)).length;
            return (
              <Text key={`h-${row.group}`} color={palette.accent} bold>
                {pointer}{row.group}  <Text color={palette.dim}>({on}/{gk.length})</Text>
              </Text>
            );
          }
          const isOff = off.has(row.key);
          return (
            <Text key={row.key} color={active ? palette.accent : isOff ? palette.dim : undefined}>
              {pointer}{isOff ? "[ ] " : "[x] "}{row.key}
            </Text>
          );
        })}
        {top + VIEWPORT < rows.length && <Text color={palette.dim}>  ▼ {rows.length - (top + VIEWPORT)} more</Text>}
      </Box>
    </Box>
  );
}
