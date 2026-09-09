import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { Palette } from "./theme.js";

/**
 * The one-line bar above the pane, on both surfaces. The left says where you are — on Home, the
 * open tabs with the active one lit; on chat, the session. The right says whether there is
 * anything above the view and how to get to it — the mirror of the "more rows below" line the
 * bottom already shows. Above zero it is a plain "top", so the bar is always there and the eye
 * learns where to look.
 */
export function TopBar({
  title,
  tabs,
  active,
  above,
  palette,
  subtitle,
  working,
  flash,
  timer,
  timerRunning,
}: {
  title: string;
  /** When given, the left side is a tab strip instead of the title. */
  tabs?: string[];
  active?: number;
  above: number;
  palette: Palette;
  subtitle?: string;
  /** Something running in the background — a check-in being read. Shown with a spinner on the
   *  right, so the input stays free and the eye still knows work is in flight. */
  working?: string;
  /** A short-lived result in the same spot — "read is in" — so it is seen whatever tab is up. */
  flash?: string;
  /** A habit timer on the clock, already formatted. Sits on the bar wherever you are, because a
   *  clock you cannot see is a clock you forget to stop. */
  timer?: string;
  timerRunning?: boolean;
}) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text>
        <Text color={palette.accent} bold>{"◆ coen"}</Text>
        {tabs ? (
          tabs.map((t, i) => (
            <Text key={`${t}-${i}`}>
              <Text color={palette.dim}>{"  "}</Text>
              {i === active ? (
                <Text color={palette.accent} bold>{`[${t}]`}</Text>
              ) : (
                <Text color={palette.dim}>{` ${t} `}</Text>
              )}
            </Text>
          ))
        ) : (
          <Text color={palette.accent} bold>{` · ${title}`}</Text>
        )}
        {subtitle ? <Text color={palette.dim}>{`  ·  ${subtitle}`}</Text> : null}
      </Text>
      <Text>
        {timer ? (
          <Text color={timerRunning ? palette.accent : palette.warning} bold>
            {timer}
            <Text color={palette.dim}>{"   ·   "}</Text>
          </Text>
        ) : null}
        {flash ? (
          <Text color={palette.success} bold>
            {flash}
            <Text color={palette.dim}>{"   ·   "}</Text>
          </Text>
        ) : null}
        {working ? (
          <Text color={palette.accent}>
            <Spinner type="dots" />
            {` ${working}`}
            <Text color={palette.dim}>{"   ·   "}</Text>
          </Text>
        ) : null}
        <Text color={above > 0 ? palette.accent : palette.dim}>
          {above > 0 ? `▲ ${above} row${above === 1 ? "" : "s"} above · ↑ or PgUp` : "top"}
        </Text>
      </Text>
    </Box>
  );
}
