import {
  streamText,
  generateText,
  stepCountIs,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  type CoenConfig,
  type ProviderId,
  DEFAULT_MODEL,
  ENV_KEY,
  apiKeyFor,
  googleBaseUrl,
} from "./config.js";
import { connectServer } from "./mcp/connect.js";
import { type Client } from "./api.js";
import { coenToolSet } from "./coen-tools/ai-tools.js";

export const PROVIDERS: ProviderId[] = ["anthropic", "openai", "google"];

// Deliberately does NOT list tools by name — the tool descriptions carry that, and a hand-written
// list here went stale the last time the server changed. What belongs here is who the agent is
// and the rules it keeps, in the same voice as COEN_PURPOSE (src/coen-tools/registry.ts).
export const SYSTEM_PROMPT =
  "You are Coen, running in the person's terminal. Coen 1 is personal intelligence for a better " +
  "life: it reads what shapes how someone feels from what they already write, do and track, so " +
  "they don't have to know how they feel before they can talk about it.\n\n" +
  "You are connected to their Coen 1 record. A snapshot of where they are right now may already " +
  "be in this prompt — start from it. Tools give you the detail behind each part (the daily " +
  "emotional read, habits and numbers, their journal, the people and things in their life, " +
  "decisions, realizations, reminders) and let you log things for them.\n\n" +
  "Rules.\n" +
  "- Ground what you say in the record. Call a read tool rather than guessing; say plainly when " +
  "the record is empty or still forming — that is a real answer, never fill the gap.\n" +
  "- Reflect, don't judge. Say what came through in their own words and patterns, without " +
  "flattering or alarming them. No scores, no streak guilt, no nagging.\n" +
  "- Only claim you did something (logged, ticked, saved) if the tool returned success, and word " +
  "it from what the tool returned. Only log what the person actually said or asked for.\n" +
  "- If no tool fits, say so.\n" +
  "- Be concise and direct. Plain language, short sentences. Light markdown is fine.";

export interface Snapshot {
  text: string;
  /** Unix ms when the snapshot was taken — shown to the model so it knows how fresh it is. */
  at: number;
}

/** The terminal's timezone — the person is sitting at it, so this is their local time. */
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** "Saturday 2026-09-05" or, with `withTime`, "Saturday 2026-09-05 23:11" in LOCAL_TZ. Dates in the
 *  prompt must be local: a UTC timestamp after a US evening reads as tomorrow, and the model then
 *  calls today "yesterday" (seen 2026-09-05). Time is only added for the fixed snapshot stamp so the
 *  prompt prefix stays byte-stable between turns (a live clock would defeat the provider cache). */
export function localDate(at: number, withTime = false): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LOCAL_TZ,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  }).formatToParts(at);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  const day = `${p("weekday")} ${p("year")}-${p("month")}-${p("day")}`;
  return withTime ? `${day} ${p("hour")}:${p("minute")}` : day;
}

/** Assemble the system prompt sent to the model — base prompt, today's local date, the session's
 *  orientation (whoami), and the dated life snapshot when present. Exported so the
 *  CLI can estimate prompt tokens from the exact same string that's sent (keeps the live "in"
 *  counter honest). `now` is injectable for tests. */
export function buildSystemPrompt(context?: string, snapshot?: Snapshot, now = Date.now()): string {
  let out = SYSTEM_PROMPT;
  out += `\n\nToday is ${localDate(now)} in the person's timezone (${LOCAL_TZ}). Every date you say or read is in that timezone; "yesterday" means the day before this one.`;
  if (context) {
    out += `\n\n## Who you are on this connection\n${context}`;
  }
  if (snapshot?.text) {
    const taken = localDate(snapshot.at, true);
    out +=
      `\n\n## Where they are right now (snapshot taken ${taken} local; the detail tools go deeper; the person can refresh it with /snapshot)\n` +
      snapshot.text;
  }
  return out;
}

/** Coen tools the CLI calls directly when a session is grounded (whoami,
 *  get_life_snapshot). Their output is folded into the system prompt, so their schemas are
 *  withheld from the model — it cannot re-run them and they cost nothing per turn. */
export const CLI_RUN_TOOLS = new Set(["whoami", "get_life_snapshot"]);

/** Text of a message whose content may be a string or an array of parts. */
export function messageText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("");
}

/** How many of the most recent user turns keep their tool calls and results intact. Older
 *  turns collapse to the assistant's text only, which is what every turn used to keep. */
export const KEEP_TOOL_TURNS = 2;

/** Collapse turns older than the last `keepTurns` user messages: drop their tool messages and
 *  reduce their assistant messages to text. Recent turns keep their evidence so a follow-up
 *  doesn't re-fetch; the collapsed shape is also what gets saved. */
export function collapseOldTurns(messages: ModelMessage[], keepTurns = KEEP_TOOL_TURNS): ModelMessage[] {
  // keepTurns 0 = collapse everything (used on a model switch: tool parts carry provider
  // metadata such as Gemini thought signatures, which another model may not accept).
  let cut = keepTurns <= 0 ? messages.length : 0;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0 && cut === 0; i--) {
    if (messages[i].role !== "user") continue;
    seen++;
    if (seen === keepTurns) {
      cut = i;
      break;
    }
  }
  const out: ModelMessage[] = [];
  messages.forEach((m, i) => {
    if (i >= cut) {
      out.push(m);
      return;
    }
    if (m.role === "tool") return;
    if (m.role === "assistant" && typeof m.content !== "string") {
      const text = messageText(m.content);
      if (text) out.push({ role: "assistant", content: text });
      return;
    }
    out.push(m);
  });
  return out;
}

export interface McpStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  note?: string;
}

/** The active model selection — lifted to app state so it can change without reconnecting MCP. */
export interface ModelSel {
  provider: ProviderId;
  modelId: string;
  apiKey: string;
}

export interface Setup {
  provider: ProviderId;
  modelId: string;
  apiKey: string;
  tools: ToolSet;
  toolNames: string[];
  warning?: string;
  /** Per-server connection status (built-in "coen" + any external mcpServers). */
  mcpStatus: McpStatus[];
  close: () => Promise<void>;
  /** Invoke a Coen MCP tool directly (outside the chat loop). Throws if unavailable. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Coen tools whose scope is not `read` (from /catalog) — these mutate data and are
   *  gated behind a confirmation prompt. Empty if the catalog couldn't be fetched. */
  writeToolNames: Set<string>;
}

// A tool whose bare name carries a mutating verb — the fallback classifier for external
// MCP servers (which don't expose a scope catalog the way Coen's does).
const MUTATING_NAME_RE = /(^|_)(create|update|delete|add|remove|set|edit|put|patch|insert|write)(_|$)/i;

/** True if a tool should require confirmation before it runs: it's a known Coen write
 *  tool (scope != read) or its name looks mutating (covers external servers). */
export function isWriteTool(name: string, writeToolNames: Set<string>): boolean {
  return writeToolNames.has(name) || MUTATING_NAME_RE.test(name);
}

/** Wrap each tool that needs confirmation so its execute awaits the user's decision.
 *  A denial returns a tool result (never throws) so the agent turn continues. The result must be
 *  MCP-shaped — `{ content: [{ type: "text", text }] }` — because the SDK's MCP tools convert
 *  their output with `"content" in result`, which throws on a bare string and killed the whole
 *  turn instead of letting the model move on (seen 2026-09-05 on a declined log_session_summary). */
function gateTools(
  tools: ToolSet,
  needsConfirm: (name: string) => boolean,
  onConfirm: (name: string, args: unknown) => Promise<boolean>
): ToolSet {
  const out: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const exec = (tool as { execute?: (a: unknown, o: unknown) => Promise<unknown> }).execute;
    if (!needsConfirm(name) || typeof exec !== "function") {
      out[name] = tool;
      continue;
    }
    const orig = exec.bind(tool);
    const gated = async (args: unknown, o: unknown) => {
      const ok = await onConfirm(name, args);
      if (!ok) {
        return {
          content: [
            { type: "text", text: `✋ The user declined to run "${name}". Do not retry it; ask what they'd prefer instead.` },
          ],
        };
      }
      return orig(args, o);
    };
    out[name] = { ...tool, execute: gated } as unknown as ToolSet[string];
  }
  return out;
}

/** True if any provider has a usable key (env or stored config). */
export function hasAnyKey(cfg: CoenConfig): boolean {
  return PROVIDERS.some((p) => !!apiKeyFor(p, cfg));
}

/** Resolve the active provider; throw a helpful error if nothing is configured. */
export function pickProvider(cfg: CoenConfig): ProviderId {
  const forced = (process.env.COEN_PROVIDER?.toLowerCase() ?? cfg.provider) as
    | ProviderId
    | undefined;
  if (forced && PROVIDERS.includes(forced)) {
    if (!apiKeyFor(forced, cfg)) {
      throw new Error(
        `Provider "${forced}" selected but no ${ENV_KEY[forced]} (env or ~/.coen/config.json).`
      );
    }
    return forced;
  }
  for (const id of PROVIDERS) if (apiKeyFor(id, cfg)) return id;
  throw new Error(
    "No model API key found. Run `coen login`, or set one of:\n" +
      PROVIDERS.map((p) => `  export ${ENV_KEY[p]}=...`).join("\n")
  );
}

/** Per-provider request options. Gemini 3.x thinks aggressively by default and, with 20+ tool
 *  schemas in the prompt, can sit a long time before the first token; the Coen 1 backend learned
 *  the same (coen1-brain ai_client.js: "NEVER omit thinkingConfig"). `COEN_GEMINI_THINKING`
 *  overrides (minimal | low | medium | high). Gemini 2.x ignores thinkingLevel, so it's gated. */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high";
const THINKING_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high"];

/** `level` forces a thinking level (the title and summary calls use "minimal": their output is
 *  short and Gemini counts thinking tokens against maxOutputTokens, so a thinking model at "low"
 *  can spend the whole budget before writing a word — that is how a session summary came back as
 *  57 characters on 2026-09-05). Without it: env override, then "low". */
export function providerOptionsFor(sel: ModelSel, level?: ThinkingLevel) {
  if (sel.provider === "google" && /gemini-3/.test(sel.modelId)) {
    const lvl = process.env.COEN_GEMINI_THINKING;
    const thinkingLevel = level ?? THINKING_LEVELS.find((l) => l === lvl) ?? "low";
    return { google: { thinkingConfig: { thinkingLevel } } };
  }
  return undefined;
}

export function makeModel(provider: ProviderId, modelId: string, apiKey: string) {
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(modelId);
    case "openai":
      return createOpenAI({ apiKey })(modelId);
    case "google":
      // baseURL only when configured — undefined keeps the SDK's default Gemini host.
      return createGoogleGenerativeAI({ apiKey, baseURL: googleBaseUrl() })(modelId);
  }
}

/** The model the chat will talk to. Throws (via pickProvider) when no provider key is configured. */
export function resolveModel(cfg: CoenConfig): ModelSel {
  const provider = pickProvider(cfg);
  const modelId = process.env.COEN_MODEL ?? cfg.model ?? DEFAULT_MODEL[provider];
  const apiKey = apiKeyFor(provider, cfg)!;
  return { provider, modelId, apiKey };
}

/** Everything the chat needs: the model, plus the Coen MCP connection and any external servers.
 *  Split so the model check fails on its own ("no model key") rather than looking like a
 *  connection problem. */
export async function resolveSetup(cfg: CoenConfig, client: Client | null): Promise<Setup> {
  const model = resolveModel(cfg);
  const conn = await connectCoen(cfg, client);
  return { ...model, ...conn };
}

export type CoenConnection = Omit<Setup, keyof ModelSel>;

/**
 * Assemble the chat's tools: Coen's own (in this process, over the REST API with the signed-in
 * person's token) plus whatever external MCP servers are attached.
 *
 * Coen's tools used to be fetched from a remote MCP endpoint using a separate long-lived API key.
 * They are local now — see src/coen-tools — so there is nothing to connect to and nothing that can
 * fail. What chat needs instead is a sign-in, and without one it runs with the external servers
 * only.
 */
export async function connectCoen(cfg: CoenConfig, client: Client | null): Promise<CoenConnection> {
  const tools: ToolSet = {};
  const closers: Array<() => Promise<void>> = [];
  const mcpStatus: McpStatus[] = [];
  const notes: string[] = [];

  // ── Coen's own tools (UNPREFIXED — callTool and the model both name them bare) ──
  let coen: ReturnType<typeof coenToolSet> | null = null;
  if (client) {
    coen = coenToolSet(client, cfg);
    Object.assign(tools, coen.tools);
    mcpStatus.push({ name: "coen", connected: true, toolCount: coen.toolNames.length });
  } else {
    const msg = "Not signed in, so your record isn't attached. Run `coen login`.";
    notes.push(msg);
    mcpStatus.push({ name: "coen", connected: false, toolCount: 0, note: msg });
  }

  // ── External MCP servers (Todoist, filesystem, …) — connected in parallel and
  // namespaced; one failing/unauth server never blocks chat. ──
  const externals = Object.entries(cfg.mcpServers ?? {}).filter(([, c]) => !c.disabled);
  const conns = await Promise.all(externals.map(([name, c]) => connectServer(name, c)));
  for (const conn of conns) {
    Object.assign(tools, conn.tools);
    closers.push(conn.close);
    mcpStatus.push({ name: conn.name, connected: conn.connected, toolCount: conn.toolCount, note: conn.note });
    if (conn.note) notes.push(conn.note);
  }

  // Which Coen tools mutate data. The registry says so outright (see coen-tools/registry.ts);
  // this used to be a /catalog fetch that could fail and quietly leave the confirm gate to a
  // guess at the tool's name.
  const writeToolNames = coen ? coen.writeToolNames : new Set<string>();

  const warning = notes.length ? notes.join("\n") : undefined;
  const close = async () => {
    await Promise.all(closers.map((c) => c().catch(() => {})));
  };

  // Direct (non-chat) tool invocation — used by /summarize and /compact. Coen's own tools go
  // straight to their handler; an external server's tool is called through its MCP client.
  const callTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    if (coen && name in coen.tools) return coen.callTool(name, args);
    const tool = (tools as Record<string, { execute?: (a: unknown, o: unknown) => Promise<unknown> }>)[name];
    if (!tool || typeof tool.execute !== "function") {
      throw new Error(`Tool '${name}' isn't available on this connection.`);
    }
    const out = await tool.execute(args, { toolCallId: `cli-${name}`, messages: [], context: undefined });
    return typeof out === "string" ? out : JSON.stringify(out);
  };

  return { tools, toolNames: Object.keys(tools), warning, mcpStatus, close, callTool, writeToolNames };
}

/** Stream one assistant reply, calling back on text deltas and tool calls. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Prompt tokens the provider served from its prefix cache (a subset of promptTokens).
   *  Gemini 2.5+/3 cache a stable prefix implicitly; this is how we know whether it hit. */
  cachedTokens?: number;
  /** Input tokens of the LAST step only — the real size of the context window. promptTokens
   *  is the sum over every tool step in the turn, so it overstates the window on multi-step turns. */
  windowTokens?: number;
}

/** What one assistant turn produced: the text shown to the person, and the messages (assistant
 *  + tool) to append to the history so the next turn can see what was fetched. */
export interface Reply {
  text: string;
  messages: ModelMessage[];
}

export async function streamReply(opts: {
  setup: Setup;
  sel: ModelSel;
  messages: ModelMessage[];
  onDelta: (text: string) => void;
  onTool: (name: string) => void;
  onUsage?: (usage: TokenUsage) => void;
  /** Pre-loaded orientation (whoami) folded into the system prompt. */
  context?: string;
  /** Pre-loaded life snapshot (get_life_snapshot), folded into the system prompt with its date. */
  snapshot?: Snapshot;
  /** Ask the user to approve a write tool before it runs. Resolve true to proceed,
   *  false to decline. When omitted, tools run without confirmation. */
  onConfirm?: (name: string, args: unknown) => Promise<boolean>;
}): Promise<Reply> {
  const { setup, sel, messages } = opts;
  const system = buildSystemPrompt(opts.context, opts.snapshot);
  // Gate write tools behind the user's confirmation when a handler is provided.
  const tools = opts.onConfirm
    ? gateTools(setup.tools, (n) => isWriteTool(n, setup.writeToolNames), opts.onConfirm)
    : setup.tools;
  // streamText does NOT throw on mid-stream errors (bad model id, auth, a tool the
  // provider rejects) — it routes them here and textStream ends empty. Capture so we
  // can surface the real reason instead of showing a blank reply.
  let streamErr: unknown;
  const MAX_STEPS = 16; // allow multi-tool operations (e.g. add task + many subtasks) to finish
  // A provider call that never answers (wrong endpoint for the key, a model id the endpoint
  // doesn't serve, a thinking model stalled on a big tool set) used to spin on "thinking…"
  // forever. Fail loud instead. Generous, because thinking models can sit a while before the
  // first token.
  const TIMEOUT_MS = Number(process.env.COEN_REPLY_TIMEOUT_MS) || 180_000;
  const result = streamText({
    model: makeModel(sel.provider, sel.modelId, sel.apiKey),
    system,
    messages,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    providerOptions: providerOptionsFor(sel),
    onError: ({ error }) => {
      streamErr = error;
    },
    onStepFinish: ({ toolCalls }) => {
      for (const c of toolCalls ?? []) opts.onTool(c.toolName);
    },
  });

  let full = "";
  try {
    for await (const chunk of result.textStream) {
      full += chunk;
      opts.onDelta(chunk);
    }
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new Error(
        `No reply from ${sel.provider}/${sel.modelId} after ${TIMEOUT_MS / 1000}s. ` +
          `Check the model id exists for your key's endpoint (COEN_GOOGLE_BASE_URL for Vertex keys), ` +
          `or switch with /model.`,
      );
    }
    throw e;
  }
  // Report token usage even on an empty/errored reply — the API call still cost tokens.
  // (totalUsage = every step of the tool loop; `usage` alone is just the last step.)
  if (opts.onUsage) {
    const u = await Promise.resolve(result.totalUsage).catch(() => undefined);
    const last = await Promise.resolve(result.finalStep).catch(() => undefined);
    if (u) {
      const inTok = u.inputTokens ?? 0;
      const outTok = u.outputTokens ?? 0;
      opts.onUsage({
        promptTokens: inTok,
        completionTokens: outTok,
        totalTokens: u.totalTokens ?? inTok + outTok,
        cachedTokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
        windowTokens: last?.usage.inputTokens ?? inTok,
      });
    }
  }
  if (streamErr) {
    throw streamErr instanceof Error ? streamErr : new Error(String(streamErr));
  }
  // Never render a silent blank reply — explain why the model produced no text.
  if (!full.trim()) {
    const reason = await Promise.resolve(result.finishReason).catch(() => "unknown");
    if (reason === "tool-calls") {
      throw new Error(
        `The model used tools but ran out of steps (limit ${MAX_STEPS}) before writing a reply. ` +
          `Say "continue" to let it finish, simplify the request, or switch models with /model.`
      );
    }
    throw new Error(
      `The model returned no text (finishReason: ${reason}). Try again, rephrase, or switch models with /model — a Flash model can struggle with many tools; gemini-3.8-flash, gemini-3.1-pro-preview or a Claude model is steadier.`
    );
  }
  const produced = await Promise.resolve(result.responseMessages).catch(() => undefined);
  // If the SDK couldn't hand back the turn's messages, fall back to the text alone.
  return { text: full, messages: produced?.length ? produced : [{ role: "assistant", content: full }] };
}

/** A 3–5 word session title from a snippet (the first exchange, or the session summary).
 *  Null on any failure, so the caller keeps whatever title it has. */
export async function summarizeTitle(sel: ModelSel, snippet: string): Promise<string | null> {
  try {
    const { text } = await generateText({
      model: makeModel(sel.provider, sel.modelId, sel.apiKey),
      maxOutputTokens: 64, // thinking counts against this on Gemini 3.x; minimal leaves room
      temperature: 0.2,
      providerOptions: providerOptionsFor(sel, "minimal"),
      prompt:
        "Give this a terse 3-5 word title. No quotes, no trailing punctuation, Title Case.\n\n" +
        `${snippet.slice(0, 1200)}\n\n` +
        "Title:",
    });
    const title = text.trim().split("\n")[0].replace(/^["'`]+|["'`.]+$/g, "").trim();
    return title || null;
  } catch {
    return null;
  }
}

/** How many user turns a transcript holds. Stable under collapseOldTurns, which never removes
 *  user messages — so it is the watermark for "what has the summary already covered". */
export function userTurnCount(messages: ModelMessage[]): number {
  return messages.filter((m) => m.role === "user").length;
}

/** The messages from the (n+1)-th user turn on — what a stored summary covering n turns has
 *  not seen yet. */
export function messagesAfterUserTurn(messages: ModelMessage[], n: number): ModelMessage[] {
  let seen = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "user") continue;
    if (seen === n) return messages.slice(i);
    seen++;
  }
  return [];
}

function renderTranscript(messages: ModelMessage[], maxChars: number): string {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role.toUpperCase()}: ${messageText(m.content)}`)
    .join("\n\n")
    .slice(-maxChars); // keep the most recent end when it's too long
}

const SUMMARY_STYLE =
  "Write plain prose, one to three short paragraphs, 150-250 words. No markdown, no bullets, no " +
  "headings, no bold — it is shown as plain text. Cover what was worked on or talked about, " +
  "what was decided, and what is still open. Be concrete and specific; no preamble.";

/** The session summary for the person's records. With `previous`, rewrite it: fold in the
 *  `messages` since it was written, keep what is still true, mark finished threads done and
 *  don't repeat. Without it, summarize `messages` from scratch. Throws on failure or empty output. */
export async function summarizeSession(
  sel: ModelSel,
  opts: { previous?: string; messages: ModelMessage[] },
): Promise<string> {
  const transcript = renderTranscript(opts.messages, 12000);
  const prompt = opts.previous
    ? "Below is the summary of a session so far, then what happened after it was written. " +
      "Rewrite the summary as one coherent account of the whole session: keep what is still " +
      "true, fold in the new part, note where something that was open is now done, and do not " +
      "repeat a point that is already there. " + SUMMARY_STYLE + "\n\n" +
      `SUMMARY SO FAR:\n${opts.previous}\n\nSINCE THEN:\n${transcript}\n\nUPDATED SUMMARY:`
    : "Summarize this session for the person's records. " + SUMMARY_STYLE + "\n\n" +
      `TRANSCRIPT:\n${transcript}\n\nSUMMARY:`;
  const { text } = await generateText({
    model: makeModel(sel.provider, sel.modelId, sel.apiKey),
    maxOutputTokens: 1500, // thinking counts against this on Gemini 3.x; minimal leaves room
    temperature: 0.3,
    providerOptions: providerOptionsFor(sel, "minimal"),
    prompt,
  });
  const out = text.trim();
  if (!out) throw new Error("the model returned an empty summary — try again or switch models with /model");
  return out;
}
