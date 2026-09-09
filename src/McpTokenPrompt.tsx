import { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useTheme } from "./theme.js";

/**
 * Masked API-token prompt, shown when an added MCP server needs auth but isn't
 * OAuth. The token is stored as an Authorization: Bearer header.
 */
export function McpTokenPrompt({
  name,
  onSubmit,
  onCancel,
}: {
  name: string;
  onSubmit: (token: string) => void;
  onCancel: () => void;
}) {
  const { palette } = useTheme();
  const [field, setField] = useState("");

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor={palette.accent} paddingX={2} paddingY={1}>
      <Text color={palette.accent} bold>◆ {name} — API token</Text>
      <Text color={palette.dim}>This server needs a token (not OAuth). Paste it; Esc to cancel.</Text>
      <Box marginTop={1}>
        <Text color={palette.accent}>› </Text>
        <TextInput
          value={field}
          onChange={setField}
          mask="•"
          placeholder="token"
          onSubmit={(v) => {
            const t = v.trim();
            if (t) onSubmit(t);
          }}
        />
      </Box>
    </Box>
  );
}
