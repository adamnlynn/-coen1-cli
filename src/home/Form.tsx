import { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import { useTheme } from "../theme.js";

export interface FormStep {
  key: string;
  label: string;
  hint?: string;
  kind: "text" | "select";
  items?: { label: string; value: string }[];
  /** Enter on an empty field skips it. */
  optional?: boolean;
  /** What the field starts with, for a text step. Editing a keyword list or a description is
   *  a correction, not a re-typing, so /habit edit seeds the current value here. */
  initial?: string;
}

/**
 * A short run of prompts, one at a time: /decision, /insight, /reminder, and the answer to a
 * prompt habit. Text steps take a line; select steps take an arrow-key pick. Esc cancels the
 * whole form. Answers come back keyed by step.
 */
export function Form({
  title,
  steps,
  onDone,
  onCancel,
}: {
  title: string;
  steps: FormStep[];
  onDone: (values: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const { palette } = useTheme();
  const [i, setI] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [field, setField] = useState(steps[0]?.initial ?? "");
  const [err, setErr] = useState("");
  useInput((_ch, key) => {
    if (key.escape) onCancel();
  });

  // Several commands hand this component a SECOND run of steps without unmounting it — the
  // habit forms chain three of them, each asking what the last answer made relevant. Home sets
  // form to null and straight back again, so the element never leaves the tree and none of the
  // state below would reset on its own: the new form would open on step 2 of 1 and draw nothing.
  // Set during render rather than in an effect, so there is no frame where that is what shows.
  const [shown, setShown] = useState(steps);
  if (shown !== steps) {
    setShown(steps);
    setI(0);
    setValues({});
    setField(steps[0]?.initial ?? "");
    setErr("");
  }

  const step = steps[i];
  if (!step) return null;

  function advance(value: string) {
    const next = { ...values, [step.key]: value };
    setValues(next);
    setErr("");
    if (i + 1 >= steps.length) onDone(next);
    else {
      setI(i + 1);
      setField(steps[i + 1]?.initial ?? "");
    }
  }

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor={palette.accent} paddingX={2} paddingY={1}>
      <Text color={palette.accent} bold>{title}</Text>
      <Text color={palette.dim}>{`step ${i + 1} of ${steps.length} — Esc to cancel`}</Text>
      {Object.entries(values).map(([k, v]) => {
        const s = steps.find((x) => x.key === k);
        return (
          <Text key={k} color={palette.dim}>
            {`  ${s?.label ?? k}: `}
            <Text color={palette.text}>{v || "—"}</Text>
          </Text>
        );
      })}
      <Box flexDirection="column" marginTop={1}>
        <Text>
          {step.label}
          {step.hint ? <Text color={palette.dim}>{`  (${step.hint})`}</Text> : null}
        </Text>
        {err ? <Text color={palette.error}>{err}</Text> : null}
        {step.kind === "select" ? (
          <Box marginTop={1}>
            <SelectInput items={step.items ?? []} onSelect={(item) => advance(item.value)} />
          </Box>
        ) : (
          <Box marginTop={1}>
            <Text color={palette.accent}>› </Text>
            <TextInput
              value={field}
              onChange={(v) => { setField(v); if (err) setErr(""); }}
              placeholder={step.optional ? "optional — Enter to skip" : ""}
              onSubmit={(v) => {
                const val = v.trim();
                if (!val && !step.optional) { setErr("this one is needed"); return; }
                advance(val);
              }}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}
