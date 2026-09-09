import type { CoenConfig } from "./config.js";
import type { TokenUsage } from "./agent.js";

/** USD per 1M tokens. `cachedInput` is what a cached (prefix-cache read) input token costs. */
export interface Price {
  input: number;
  output: number;
  cachedInput?: number;
}

// Google bills implicit-cache reads at a quarter of the input rate (the "75% saving" in its
// caching announcement). Anthropic bills cache reads at a tenth. OpenAI at half.
const CACHED_FRACTION: Record<string, number> = { gemini: 0.25, claude: 0.1, gpt: 0.5 };

/** List prices on file, USD per 1M tokens. The Gemini and OpenAI rows are the same numbers as
 *  coen1-brain/lib/platform_usage.js (MODEL_TOKEN_COSTS, per-token there) — keep the two in step.
 *  Gemini 3.6/3.7/3.8-flash are introductory prices through 2026-12-31 and double on 2027-01-01.
 *  Anthropic rows are the first-party API list prices as of 2026-06. Anything not listed can be
 *  added or overridden with `"pricing": { "<model id>": { "input": …, "output": … } }` in
 *  ~/.coen/config.json. */
export const PRICES: Record<string, Price> = {
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "gemini-3.7-flash": { input: 0.75, output: 3.75 },
  "gemini-3.6-flash": { input: 0.75, output: 3.75 },
  "gemini-3.5-flash": { input: 1.5, output: 9 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-3-flash-preview": { input: 0.5, output: 3 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-3.1-pro-preview": { input: 2, output: 12 },
  "gpt-5.2-chat": { input: 3, output: 15 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
};

/** The price row for a model: config override first, then the table. Null if nothing is on file. */
export function priceFor(modelId: string, cfg?: CoenConfig): Price | null {
  const id = modelId.toLowerCase().trim();
  const p = cfg?.pricing?.[id] ?? cfg?.pricing?.[modelId] ?? PRICES[id];
  if (!p) return null;
  const family = Object.keys(CACHED_FRACTION).find((f) => id.includes(f));
  const cachedInput = p.cachedInput ?? (family ? p.input * CACHED_FRACTION[family] : p.input);
  return { input: p.input, output: p.output, cachedInput };
}

/** Estimated USD for one reply's usage on a model. Cached input tokens are a subset of
 *  promptTokens and billed at the cached rate. Null if the model has no price on file. */
export function costOf(modelId: string, u: TokenUsage, cfg?: CoenConfig): number | null {
  const p = priceFor(modelId, cfg);
  if (!p) return null;
  const cached = Math.min(u.cachedTokens ?? 0, u.promptTokens);
  const fresh = u.promptTokens - cached;
  return (fresh * p.input + cached * (p.cachedInput ?? p.input) + u.completionTokens * p.output) / 1_000_000;
}

/** "$0.0042" below a cent, "$0.04" above, "$1.23" above a dollar. */
export function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** "$1.50 in / $9.00 out per 1M, cached in $0.38" for the usage readout. */
export function fmtPrice(p: Price): string {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  return `${usd(p.input)} in / ${usd(p.output)} out per 1M` + (p.cachedInput != null && p.cachedInput !== p.input ? `, cached in ${usd(p.cachedInput)}` : "");
}
