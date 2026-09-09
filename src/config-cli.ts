import { stdout } from "node:process";
import { TOOL_NAMES } from "./coen-tools/registry.js";
import {
  type CoenConfig,
  type ProviderId,
  CONFIG_PATH,
  DEFAULT_MODEL,
  ENV_KEY,
  apiKeyFor,
  redact,
  saveConfig,
  confirmWrites,
  webUrl,
} from "./config.js";

const dim = (s: string) => stdout.write(`\x1b[2m${s}\x1b[0m\n`);
const red = (s: string) => stdout.write(`\x1b[31m${s}\x1b[0m\n`);
const ok = (s: string) => stdout.write(`\x1b[32m${s}\x1b[0m\n`);
const plain = (s: string) => stdout.write(`${s}\n`);

const PROVIDERS = Object.keys(ENV_KEY) as ProviderId[];
const isProvider = (x: string | undefined): x is ProviderId => !!x && PROVIDERS.includes(x as ProviderId);

const USAGE =
  "coen config — view/update model settings\n" +
  "  coen config                        show current settings\n" +
  "  coen config set-key <provider> <key>\n" +
  "  coen config set-model <modelId> [provider]\n" +
  "  coen config use <provider> [model]   switch the active provider (+ model)\n" +
  "  coen config set-web <url>            the record everything reads (default production)\n" +
  "                                       e.g. http://localhost:3100  ·  --clear to reset\n" +
  "  coen config confirm <on|off>         confirm before the agent runs write tools\n" +
  `  providers: ${PROVIDERS.join(", ")}\n`;

export function runConfigCommand(args: string[], cfg: CoenConfig): void {
  const sub = args[0];
  switch (sub) {
    case undefined:
    case "show":
      return show(cfg);
    case "set-key":
      return setKey(args[1], args[2], cfg);
    case "set-model":
      return setModel(args[1], args[2], cfg);
    case "use":
      return use(args[1], args[2], cfg);
    case "set-web":
      return setWeb(args[1], cfg);
    case "confirm":
      return setConfirm(args[1], cfg);
    default:
      dim(USAGE);
  }
}

function keyState(p: ProviderId, cfg: CoenConfig): string {
  if (process.env[ENV_KEY[p]]) return "set (env — overrides config)";
  return cfg.apiKeys?.[p] ? `set (${redact(cfg.apiKeys[p])})` : "not set";
}

function show(cfg: CoenConfig): void {
  plain(`config: ${CONFIG_PATH}`);
  plain(`active: ${cfg.provider ?? "(auto)"} / ${cfg.model ?? "(default)"}`);
  for (const p of PROVIDERS) {
    const model = cfg.models?.[p] ? `  model ${cfg.models[p]}` : "";
    plain(`  ${p.padEnd(10)} ${keyState(p, cfg)}${model}`);
  }
  // One host now. Home, the chat's tools and the tools served to other agents on this machine
  // all read the same record with the same sign-in — there is no second URL and no second key.
  plain(`record: ${webUrl(cfg)}${process.env.COEN_WEB_URL ? " (env)" : ""} — ${cfg.auth ? `signed in as ${cfg.auth.email}${cfg.auth.expiresAt > Date.now() ? "" : " (expired)"}` : "not signed in"}`);
  plain(`tools:  ${TOOL_NAMES.length} · coen mcp serve (stdio) · coen daemon status (http)`);
  plain(`theme:  ${cfg.theme?.colorScheme ?? "signal"}`);
  plain(`confirm writes: ${confirmWrites(cfg) ? "on" : "off"}${process.env.COEN_CONFIRM_WRITES !== undefined ? " (env)" : ""}`);
}

function setConfirm(value: string | undefined, cfg: CoenConfig): void {
  const v = value?.toLowerCase();
  if (v !== "on" && v !== "off") {
    red("usage: coen config confirm <on|off>");
    return;
  }
  saveConfig({ ...cfg, confirmWrites: v === "on" });
  ok(`confirm writes → ${v}`);
  if (process.env.COEN_CONFIRM_WRITES !== undefined) {
    dim("note: COEN_CONFIRM_WRITES is set in your environment and overrides the stored value.");
  }
}

function setKey(provider: string | undefined, key: string | undefined, cfg: CoenConfig): void {
  if (!isProvider(provider) || !key) {
    red("usage: coen config set-key <provider> <key>");
    return;
  }
  saveConfig({ ...cfg, apiKeys: { ...cfg.apiKeys, [provider]: key } });
  ok(`saved ${provider} key.`);
  if (process.env[ENV_KEY[provider]]) {
    dim(`note: ${ENV_KEY[provider]} is set in your environment and overrides the stored key.`);
  }
}

function setModel(modelId: string | undefined, provider: string | undefined, cfg: CoenConfig): void {
  if (!modelId) {
    red("usage: coen config set-model <modelId> [provider]");
    return;
  }
  if (provider && !isProvider(provider)) {
    red(`unknown provider "${provider}". one of: ${PROVIDERS.join(", ")}`);
    return;
  }
  const target = (provider as ProviderId | undefined) ?? cfg.provider;
  const next: CoenConfig = { ...cfg, model: modelId };
  if (target) {
    next.provider = target;
    next.models = { ...cfg.models, [target]: modelId };
  }
  saveConfig(next);
  ok(`model → ${[target, modelId].filter(Boolean).join("/")}`);
}

function setWeb(url: string | undefined, cfg: CoenConfig): void {
  if (!url || url === "--clear" || url === "clear") {
    const { webUrl: _drop, ...rest } = cfg;
    saveConfig(rest);
    ok(`cleared web override — using ${webUrl(rest)}.`);
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    red("usage: coen config set-web <url>   e.g. http://localhost:3100  (or --clear to reset)");
    return;
  }
  const clean = url.replace(/\/$/, "");
  saveConfig({ ...cfg, webUrl: clean });
  ok(`web → ${clean}`);
  if (cfg.auth) dim("note: your sign-in was for the previous host — run `coen login` again.");
  if (process.env.COEN_WEB_URL) dim("note: COEN_WEB_URL is set in your environment and overrides the stored value.");
}

function use(provider: string | undefined, model: string | undefined, cfg: CoenConfig): void {
  if (!isProvider(provider)) {
    red(`usage: coen config use <provider> [model]   (providers: ${PROVIDERS.join(", ")})`);
    return;
  }
  if (!apiKeyFor(provider, cfg)) {
    red(`no ${provider} key. add one: coen config set-key ${provider} <key>`);
    return;
  }
  const modelId = model || cfg.models?.[provider] || DEFAULT_MODEL[provider];
  saveConfig({ ...cfg, provider, model: modelId, models: { ...cfg.models, [provider]: modelId } });
  ok(`now using ${provider}/${modelId}`);
}
