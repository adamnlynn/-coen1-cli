import { Box, Text, useInput } from "ink";
import { useTheme } from "./theme.js";

/** Render a tool's arguments compactly for the confirm prompt (one line per field,
 *  long values truncated). Falls back to JSON for non-object args. */
function previewArgs(args: unknown): string[] {
  if (args == null) return [];
  if (typeof args !== "object") return [String(args)];
  const entries = Object.entries(args as Record<string, unknown>);
  return entries.map(([k, v]) => {
    let val = typeof v === "string" ? v : JSON.stringify(v);
    if (val.length > 80) val = val.slice(0, 77) + "…";
    return `${k}: ${val}`;
  });
}

/**
 * Confirmation gate shown before the agent runs a write/mutating MCP tool. The user
 * approves (y), denies (n / Esc), or auto-approves this tool for the rest of the session (a).
 * Owns the keyboard while open (the main input is paused when mode != "chat").
 */
export function ToolConfirmPrompt({
  name,
  args,
  onApprove,
  onDeny,
  onAlways,
}: {
  name: string;
  args: unknown;
  onApprove: () => void;
  onDeny: () => void;
  onAlways: () => void;
}) {
  const { palette } = useTheme();
  const lines = previewArgs(args);

  useInput((input, key) => {
    if (key.escape) return onDeny();
    const ch = input.toLowerCase();
    if (ch === "y") return onApprove();
    if (ch === "n") return onDeny();
    if (ch === "a") return onAlways();
  });

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor={palette.warning} paddingX={2} paddingY={1}>
      <Text color={palette.warning} bold>⚠ Coen wants to run a write tool</Text>
      <Box marginTop={1}>
        <Text color={palette.accent} bold>{name}</Text>
      </Box>
      {lines.length > 0 && (
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          {lines.map((l, i) => (
            <Text key={i} color={palette.dim}>{l}</Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={palette.dim}>
          <Text color={palette.success}>y</Text> approve · <Text color={palette.warning}>n</Text>/Esc deny · <Text color={palette.accent}>a</Text> always allow this tool this session
        </Text>
      </Box>
    </Box>
  );
}
