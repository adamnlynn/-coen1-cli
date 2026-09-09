import { useRef } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import { SELECTABLE_SCHEMES, useTheme, type ColorScheme } from "./theme.js";

/**
 * Arrow-key theme picker. Previews each scheme live as you move (applies it
 * without syncing), commits + syncs to the dashboard on Enter, and reverts to the
 * scheme you started on if you Esc.
 */
export function ThemePicker({
  onDone,
  onCancel,
}: {
  onDone: (synced: boolean) => void;
  onCancel: () => void;
}) {
  const { scheme, palette, applyScheme } = useTheme();
  const startRef = useRef<ColorScheme>(scheme);

  useInput((_input, key) => {
    if (key.escape) {
      void applyScheme(startRef.current, false); // revert the live preview
      onCancel();
    }
  });

  const items = SELECTABLE_SCHEMES.map((s) => ({ label: s.label, value: s.scheme }));
  const initialIndex = Math.max(
    0,
    SELECTABLE_SCHEMES.findIndex((s) => s.scheme === startRef.current),
  );

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor={palette.accent} paddingX={2} paddingY={1}>
      <Text color={palette.accent} bold>◆ theme</Text>
      <Text color={palette.dim}>↑/↓ preview · Enter apply &amp; sync · Esc cancel</Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          initialIndex={initialIndex}
          onHighlight={(item) => void applyScheme(item.value as ColorScheme, false)}
          onSelect={(item) => void applyScheme(item.value as ColorScheme, true).then(onDone)}
        />
      </Box>
    </Box>
  );
}
