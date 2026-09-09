import { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import { type CoenConfig, type ProviderId, ACTIVE_PROFILE, redact } from "./config.js";
import { useTheme } from "./theme.js";

const PROVIDER_ITEMS: { label: string; value: ProviderId }[] = [
  { label: "Anthropic  (Claude)", value: "anthropic" },
  { label: "OpenAI     (GPT)", value: "openai" },
  { label: "Google     (Gemini)", value: "google" },
];

type Step = "provider" | "modelKey";

/**
 * The chat's first-run setup (reached from /chat or `coen chat`). Arrow-key provider menu, then
 * masked key entry. A model key is the only thing it asks for: Coen's own tools run in this
 * process against the record your `coen login` already reaches, so there is no second key any
 * more. Collects into a config draft and hands it back via onDone. Esc cancels.
 */
export function ChatSetup({
  cfg,
  error,
  onDone,
  onCancel,
}: {
  cfg: CoenConfig;
  error?: string;
  onDone: (next: CoenConfig) => void;
  onCancel?: () => void;
}) {
  const { palette } = useTheme();
  useInput((_ch, key) => {
    if (key.escape) onCancel?.();
  });
  const [step, setStep] = useState<Step>("provider");
  const [draft, setDraft] = useState<CoenConfig>(cfg);
  const [provider, setProvider] = useState<ProviderId>(cfg.provider ?? "anthropic");
  const [field, setField] = useState("");
  const [fieldError, setFieldError] = useState("");

  const initialIndex = Math.max(
    0,
    PROVIDER_ITEMS.findIndex((i) => i.value === (cfg.provider ?? "anthropic"))
  );
  const msg = error || fieldError;

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor={palette.accent} paddingX={2} paddingY={1}>
      <Text color={palette.accent} bold>
        {ACTIVE_PROFILE === "default" ? "◆ chat setup" : `◆ chat setup · agent: ${ACTIVE_PROFILE}`}
      </Text>
      <Text color={palette.dim}>
        {ACTIVE_PROFILE === "default"
          ? "The chat needs a model key. Your record comes from `coen login`. Esc goes back."
          : `Agent "${ACTIVE_PROFILE}" — model keys inherited from default (blank = keep). Esc goes back.`}
      </Text>
      {msg ? <Text color={palette.error}>{msg}</Text> : null}

      {step === "provider" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>  Which model provider do you want to use?</Text>
          <Box marginTop={1}>
            <SelectInput
              items={PROVIDER_ITEMS}
              initialIndex={initialIndex}
              onSelect={(item) => {
                setProvider(item.value);
                setField("");
                setFieldError("");
                setStep("modelKey");
              }}
            />
          </Box>
        </Box>
      )}

      {step === "modelKey" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            Paste your <Text color={palette.accent}>{provider}</Text> API key{" "}
            <Text color={palette.dim}>(current: {redact(draft.apiKeys?.[provider])}; pay-per-token, no subscription)</Text>
          </Text>
          <Box marginTop={1}>
            <Text color={palette.accent}>› </Text>
            <TextInput
              value={field}
              onChange={(v) => { setField(v); if (fieldError) setFieldError(""); }}
              mask="•"
              placeholder={draft.apiKeys?.[provider] ? "blank = keep current" : "required"}
              onSubmit={(v) => {
                const key = v.trim();
                const effective = key || draft.apiKeys?.[provider];
                if (!effective) { setFieldError(`A ${provider} API key is required.`); return; }
                setFieldError("");
                const next: CoenConfig = {
                  ...draft,
                  provider,
                  apiKeys: key ? { ...draft.apiKeys, [provider]: key } : draft.apiKeys,
                };
                setDraft(next);
                setField("");
                onDone(next);
              }}
            />
          </Box>
        </Box>
      )}

    </Box>
  );
}
