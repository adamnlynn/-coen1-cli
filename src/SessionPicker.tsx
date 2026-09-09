import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import { listSessions } from "./sessions.js";
import { useTheme } from "./theme.js";

const NEW = "__new__";

function relTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Arrow-key session switcher. Lists recent sessions newest-first with a
 * "+ new session" item on top. Used both as the `coen sessions` entrypoint and
 * as the in-chat live-switch overlay. Esc cancels.
 */
export function SessionPicker({
  onPick,
  onCancel,
}: {
  onPick: (id: string | null) => void;
  onCancel: () => void;
}) {
  const { palette } = useTheme();
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  const sessions = listSessions();
  const items = [
    { label: "+ new session", value: NEW },
    ...sessions.map((s) => ({
      label: `${relTime(s.updatedAt).padEnd(8)} · ${s.title}`,
      value: s.id,
    })),
  ];

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor={palette.accent} paddingX={2} paddingY={1}>
      <Text color={palette.accent} bold>↪ switch session</Text>
      <Text color={palette.dim}>{sessions.length ? "pick a session — Esc to cancel" : "no saved sessions yet — Esc to cancel"}</Text>
      <Box marginTop={1}>
        <SelectInput items={items} onSelect={(item) => onPick(item.value === NEW ? null : item.value)} />
      </Box>
    </Box>
  );
}
