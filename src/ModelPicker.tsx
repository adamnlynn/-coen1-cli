import { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import {
  type CoenConfig,
  type ProviderId,
  DEFAULT_MODEL,
  apiKeyFor,
  redact,
} from "./config.js";
import type { ModelSel } from "./agent.js";
import { useTheme } from "./theme.js";

const PROVS: { id: ProviderId; name: string }[] = [
  { id: "anthropic", name: "Anthropic (Claude)" },
  { id: "openai", name: "OpenAI (GPT)" },
  { id: "google", name: "Google (Gemini)" },
];

type Step = "provider" | "key" | "model";

/**
 * In-chat model/provider switcher: pick a provider, update its API key if needed
 * (masked), then set the model. Mirrors the onboarding flow but applies live.
 */
export function ModelPicker({
  current,
  cfg,
  onApply,
  onCancel,
}: {
  current: ModelSel;
  cfg: CoenConfig;
  onApply: (next: ModelSel) => void;
  onCancel: () => void;
}) {
  const { palette } = useTheme();
  const [step, setStep] = useState<Step>("provider");
  const [provider, setProvider] = useState<ProviderId>(current.provider);
  const [keyDraft, setKeyDraft] = useState<string>("");
  const [field, setField] = useState("");
  const [error, setError] = useState("");

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  const modelPrefill = (p: ProviderId): string =>
    cfg.models?.[p] ?? (p === current.provider ? current.modelId : DEFAULT_MODEL[p]);

  const providerItems = PROVS.map((p) => ({
    label: `${p.name}${apiKeyFor(p.id, cfg) ? "  ✓" : "  —"}${p.id === current.provider ? "  (current)" : ""}`,
    value: p.id,
  }));
  const initialIndex = Math.max(0, PROVS.findIndex((p) => p.id === current.provider));
  const existingKey = apiKeyFor(provider, cfg);

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor={palette.accent} paddingX={2} paddingY={1}>
      <Text color={palette.accent} bold>◆ model settings</Text>
      <Text color={palette.dim}>Esc to cancel</Text>
      {error ? <Text color={palette.error}>{error}</Text> : null}

      {step === "provider" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>  Which provider?</Text>
          <Box marginTop={1}>
            <SelectInput
              items={providerItems}
              initialIndex={initialIndex}
              onSelect={(item) => {
                setProvider(item.value);
                setField("");
                setError("");
                setStep("key");
              }}
            />
          </Box>
        </Box>
      )}

      {step === "key" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={palette.accent}>{provider}</Text> API key{" "}
            <Text color={palette.dim}>(current: {redact(existingKey)})</Text>
          </Text>
          <Box marginTop={1}>
            <Text color={palette.accent}>› </Text>
            <TextInput
              value={field}
              onChange={(v) => {
                setField(v);
                if (error) setError("");
              }}
              mask="•"
              placeholder={existingKey ? "blank = keep current" : "required"}
              onSubmit={(v) => {
                const entered = v.trim();
                const effective = entered || existingKey;
                if (!effective) {
                  setError(`A ${provider} API key is required.`);
                  return;
                }
                setKeyDraft(effective);
                setField(modelPrefill(provider));
                setError("");
                setStep("model");
              }}
            />
          </Box>
        </Box>
      )}

      {step === "model" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            Model for <Text color={palette.accent}>{provider}</Text>{" "}
            <Text color={palette.dim}>(blank = keep shown)</Text>
          </Text>
          <Box marginTop={1}>
            <Text color={palette.accent}>› </Text>
            <TextInput
              value={field}
              onChange={setField}
              placeholder={modelPrefill(provider)}
              onSubmit={(v) => {
                const modelId = v.trim() || modelPrefill(provider);
                onApply({ provider, modelId, apiKey: keyDraft });
              }}
            />
          </Box>
        </Box>
      )}
    </Box>
  );
}
