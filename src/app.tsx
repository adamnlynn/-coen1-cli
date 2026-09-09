import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import type { ModelMessage, ToolSet } from "ai";
import { type Setup, type ModelSel, type McpStatus, type TokenUsage, type Snapshot, CLI_RUN_TOOLS, buildSystemPrompt, collapseOldTurns, messageText, messagesAfterUserTurn, streamReply, summarizeSession, summarizeTitle, userTurnCount } from "./agent.js";
import { estimateTokens, estimateMessages, estimateToolset } from "./tokens.js";
import { type Turn, turnLines, liveLines } from "./transcript.js";
import { bannerLines } from "./banner.js";
import { costOf, fmtPrice, fmtUsd, priceFor } from "./pricing.js";
import {
  type CoenConfig,
  type McpServerConfig,
  CONFIG_PATH,
  ACTIVE_PROFILE,
  webUrl,
  saveConfig,
  confirmWrites,
} from "./config.js";
import { ModelPicker } from "./ModelPicker.js";
import { McpTokenPrompt } from "./McpTokenPrompt.js";
import { ToolManager } from "./ToolManager.js";
import { ToolConfirmPrompt } from "./ToolConfirmPrompt.js";
import { connectServer, type ServerConnection } from "./mcp/connect.js";
import { parseServerSpec, toolPrefix } from "./mcp/spec.js";
import { oauthLogin } from "./mcp/login.js";
import { clearAuth } from "./mcp/oauth.js";
import {
  type Session,
  archiveSession,
  firstUserText,
  listSessions,
  loadSession,
  newSession,
  saveSession,
} from "./sessions.js";
import { SessionPicker } from "./SessionPicker.js";
import { ThemePicker } from "./ThemePicker.js";
import { useTheme, SELECTABLE_SCHEMES, type ColorScheme } from "./theme.js";
import { useScrollPane } from "./useScrollPane.js";
import { useSlashMenu, SlashMenu, type Command } from "./SlashMenu.js";
import { TopBar } from "./TopBar.js";

/** Reflow markdown to (almost) the full terminal width — re-applied on resize. */
function applyMarkdownWidth(cols: number) {
  marked.use(
    markedTerminal({ reflowText: true, width: Math.max(40, cols - 4) }) as Parameters<typeof marked.use>[0],
  );
}
applyMarkdownWidth(process.stdout.columns || 82);

function md(text: string): string {
  try {
    return (marked.parse(text) as string).replace(/\n+$/, "");
  } catch {
    return text;
  }
}

/** Track the terminal size, updating live on resize so the UI fills the window. */
function useTerminalSize(): { cols: number; rows: number } {
  const [size, setSize] = useState({
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  });
  useEffect(() => {
    const onResize = () =>
      setSize({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);
  return size;
}

/** Rebuild the on-screen transcript from saved messages (notes aren't persisted). Tool
 *  messages and tool-call parts stay out of view; only the text of each turn is shown. */
function turnsFromMessages(messages: ModelMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = messageText(m.content);
    if (text) turns.push({ role: m.role, text });
  }
  return turns;
}

type Mode = "chat" | "switcher" | "theme" | "models" | "mcp-auth" | "tools" | "confirm-tool";

/** Compact token formatter: 950 → "950", 4200 → "4.2k", 1_300_000 → "1.3M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Replace a server's status entry by name, or append it. */
function upsertStatus(list: McpStatus[], entry: McpStatus): McpStatus[] {
  const i = list.findIndex((x) => x.name === entry.name);
  if (i === -1) return [...list, entry];
  const next = [...list];
  next[i] = entry;
  return next;
}

// Slash-command registry — single source of truth for the autocomplete menu.
// Aliases (/quit, /reset) still work in submit() but stay out of the menu.
const COMMANDS: Command[] = [
  { name: "/home", hint: "back to Home (when started from it)" },
  { name: "/summarize", hint: "summarize this session to Coen" },
  { name: "/compact", hint: "summarize + trim context" },
  { name: "/switch", hint: "switch session (^O)" },
  { name: "/new", hint: "start a fresh session" },
  { name: "/clear", hint: "clear the screen (Coen still remembers — /new starts fresh)" },
  { name: "/sessions", hint: "list recent sessions" },
  { name: "/rename", hint: "rename this session", arg: true },
  { name: "/archive", hint: "archive this session (recoverable)" },
  { name: "/tools", hint: "enable/disable tools" },
  { name: "/mcp", hint: "manage MCP servers (add/login/list)", arg: true },
  { name: "/snapshot", hint: "refresh the life snapshot (where you are right now)" },
  { name: "/reground", hint: "reload everything: agent context + snapshot" },
  { name: "/model", hint: "switch provider/model (or /model <id>)", arg: true },
  { name: "/config", hint: "show config + connection" },
  { name: "/usage", hint: "tokens, cost and model price (this session + all)" },
  { name: "/theme", hint: "change theme — syncs to dashboard", arg: true },
  { name: "/help", hint: "list commands" },
  { name: "/exit", hint: "save & quit" },
];

export default function App({
  setup,
  cfg,
  session,
  openSwitcher,
  onLeave,
  onBeforeExit,
  homeTabs,
  active: visible = true,
}: {
  setup: Setup;
  cfg: CoenConfig;
  session: Session;
  openSwitcher?: boolean;
  /** Run on the way out — Home writing down its tabs, when chat was opened from Home. */
  onBeforeExit?: () => void;
  /** Home's tab titles, so chat draws the same strip with itself lit at the end. */
  homeTabs?: string[];
  /** Set when the CLI made its own Coen 1 agent key on the way in here. Said once, so the new row
   *  in the dashboard is never a surprise. */
  /** Is chat the surface on screen? It stays mounted behind Home once opened, so its MCP
   *  connection and streaming reply survive a look at Home — hidden, it must not take keys. */
  active?: boolean;
  /** Set when the chat was opened from Home: /home saves the session and hands it back, so a
   *  later /chat reopens the one that was active (not the one the chat started with). */
  onLeave?: (current: Session, edge?: "first" | "last") => void;
}) {
  const { exit } = useApp();
  const { palette, applyScheme } = useTheme();
  const [history, setHistory] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [sel, setSel] = useState<ModelSel>({
    provider: setup.provider,
    modelId: setup.modelId,
    apiKey: setup.apiKey,
  });
  // Live MCP state — servers can be added/removed mid-session without reconnecting.
  const [allTools, setAllTools] = useState<ToolSet>(setup.tools);
  const [serverStatus, setServerStatus] = useState<McpStatus[]>(setup.mcpStatus);
  const [pendingToken, setPendingToken] = useState<{ name: string; sc: McpServerConfig } | null>(null);
  const [disabled, setDisabled] = useState<Set<string>>(new Set(cfg.disabledTools));
  // Cumulative token usage for this chat session — seeded from the stored session so
  // it reflects lifetime usage across resumes (see usageRef for the persisted source).
  const [usage, setUsage] = useState<TokenUsage>(
    session.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );
  // Current context-window size (exact after each reply; persisted so a resume is accurate).
  const [contextTokens, setContextTokens] = useState<number>(
    session.contextTokens ?? estimateMessages(session.messages),
  );
  // Estimated spend this session (USD), accumulated per reply at the model that produced it.
  const [costUsd, setCostUsd] = useState<number>(session.costUsd ?? 0);
  const costRef = useRef<number>(costUsd);
  // Estimated prompt tokens for the in-flight turn — drives the live "↑ in" ticker (0 = idle).
  const [livePrompt, setLivePrompt] = useState(0);
  // Tools the model may be offered: everything connected minus the trio the CLI runs itself at
  // session start (their output is already in the system prompt; see CLI_RUN_TOOLS).
  const modelTools = useMemo(
    () => Object.fromEntries(Object.entries(allTools).filter(([k]) => !CLI_RUN_TOOLS.has(k))),
    [allTools],
  );
  const toolNames = useMemo(() => Object.keys(modelTools), [modelTools]);
  // What the model actually sees: modelTools minus the disabled set.
  const enabledTools = useMemo(
    () => Object.fromEntries(Object.entries(modelTools).filter(([k]) => !disabled.has(k))),
    [modelTools, disabled],
  );
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [mode, setMode] = useState<Mode>(openSwitcher ? "switcher" : "chat");
  // A write tool awaiting the user's approval (mid agent turn); resolve(true/false)
  // unblocks the gated execute in agent.ts. `autoApprove` remembers "always" choices for
  // the session so an approved tool stops prompting.
  const [pendingTool, setPendingTool] = useState<{ name: string; args: unknown; resolve: (ok: boolean) => void } | null>(null);
  const autoApprove = useRef<Set<string>>(new Set());
  // Lines submitted while a reply is streaming; sent one at a time once it finishes.
  const queuedRef = useRef<string[]>([]);
  // Set once shutdown() starts; a second /exit or Ctrl+C then leaves immediately.
  const exitingRef = useRef(false);
  // Replies completed since this session was opened in this run. Exit only summarizes when
  // this is > 0: opening a session to read it and leaving must not cost a model call.
  const turnsThisRunRef = useRef(0);
  const [activeTitle, setActiveTitle] = useState(session.title || "new session");
  const messagesRef = useRef<ModelMessage[]>([...session.messages]);
  const sessionRef = useRef<Session>(session);
  // Single source of truth for in-session config edits (model + MCP) so concurrent
  // writes don't clobber each other; closers for servers added this session.
  const cfgRef = useRef(cfg);
  const serversRef = useRef<Map<string, () => Promise<void>>>(new Map());
  // Agent self-orientation, loaded once at session start (whoami) and
  // folded into the system prompt so the agent is grounded from the first reply.
  const orientationRef = useRef("");
  // The life snapshot (get_life_snapshot) — a dozen queries, so it's cached per session and
  // reused while fresh. Folded into the system prompt with its timestamp.
  const snapshotRef = useRef<Snapshot | undefined>(undefined);
  const primeRef = useRef<Promise<void> | null>(null);
  // Live source of truth for token usage (avoids stale state when stamping onto the
  // session before saveSession). Kept in sync with the `usage` display state.
  const usageRef = useRef<TokenUsage>(usage);
  // Cache hits on the most recent reply — shown next to ctx so you can see whether the
  // provider's prefix cache is actually covering the fixed prompt.
  const lastCachedRef = useRef(0);

  /** Add a reply's usage to the session total, persist it onto the session, and display it. */
  function addUsage(u: TokenUsage): void {
    const next: TokenUsage = {
      promptTokens: usageRef.current.promptTokens + u.promptTokens,
      completionTokens: usageRef.current.completionTokens + u.completionTokens,
      totalTokens: usageRef.current.totalTokens + u.totalTokens,
      cachedTokens: (usageRef.current.cachedTokens ?? 0) + (u.cachedTokens ?? 0),
    };
    lastCachedRef.current = u.cachedTokens ?? 0;
    usageRef.current = next;
    setUsage(next);
    sessionRef.current.usage = next; // so the next saveSession() persists it
    const turnCost = costOf(sel.modelId, u, cfgRef.current);
    if (turnCost != null) {
      costRef.current += turnCost;
      setCostUsd(costRef.current);
      sessionRef.current.costUsd = costRef.current;
    }
    // Exact window size after this turn (last step only) — snaps the live estimate to truth.
    const window = u.windowTokens ?? u.promptTokens;
    setContextTokens(window);
    sessionRef.current.contextTokens = window;
  }

  const note = (text: string) => setHistory((h) => [...h, { role: "note", text }]);

  /** Call one Coen tool directly and unwrap the MCP {content:[{text}]} envelope. Null if the
   *  tool isn't on this connection or errors. Uses setup.callTool (unfiltered by /tools). */
  async function callCoen(name: string, args: Record<string, unknown> = {}): Promise<string | null> {
    if (!(name in setup.tools)) return null;
    try {
      const out = await setup.callTool(name, args);
      try {
        const j = JSON.parse(out) as { content?: { text?: string }[] };
        if (Array.isArray(j?.content)) return j.content.map((c) => c.text ?? "").join("\n");
      } catch {
        /* not an envelope — use the raw string */
      }
      return out;
    } catch {
      return null; // the tool refused, or the server errored
    }
  }

  // whoami: who the agent is on this connection. Cheap; cached per session.
  //
  // This used to run `define_agent` first. That tool went with the remote agent-key path, and
  // nothing has defined it since — callCoen simply returned null for it on every session start.
  // Harmless, but it read as if the tool were still there.
  async function loadOrientation(): Promise<{ text: string; ran: string[] }> {
    const parts: string[] = [];
    const ran: string[] = [];
    for (const name of ["whoami"]) {
      const text = await callCoen(name);
      if (text === null) continue;
      parts.push(`### ${name}\n${text}`);
      ran.push(name);
    }
    return { text: parts.join("\n\n"), ran };
  }

  // A snapshot older than this is re-taken on session start; /snapshot forces it any time.
  const SNAPSHOT_FRESH_MS = 6 * 60 * 60 * 1000;

  /** get_life_snapshot — where the person is right now. Persisted on the session with its time. */
  async function loadSnapshot(s: Session): Promise<boolean> {
    const text = await callCoen("get_life_snapshot");
    if (text === null) return false;
    const snap: Snapshot = { text, at: Date.now() };
    snapshotRef.current = snap;
    s.snapshot = snap;
    saveSession(s); // no-op until the session has messages
    return true;
  }

  // Ground a session: orientation (reused from the session if present) + life snapshot (reused
  // while fresh). `force` re-fetches both.
  async function ensureGrounded(s: Session, force = false): Promise<void> {
    const loaded: string[] = [];
    if (!force && s.orientation) {
      orientationRef.current = s.orientation;
    } else {
      const { text, ran } = await loadOrientation();
      if (text) {
        orientationRef.current = text;
        s.orientation = text;
        saveSession(s);
        loaded.push(...ran);
      }
    }
    if (!force && s.snapshot && Date.now() - s.snapshot.at < SNAPSHOT_FRESH_MS) {
      snapshotRef.current = s.snapshot;
    } else if (await loadSnapshot(s)) {
      loaded.push("get_life_snapshot");
    }
    if (loaded.length) note(`oriented — ${force ? "reloaded" : "loaded"} ${loaded.join(" + ")}`);
  }

  function persistCfg(next: CoenConfig): void {
    cfgRef.current = next;
    saveConfig(next);
  }

  // Switch the active model/provider/key live (no MCP reconnect — tools are
  // model-independent) and persist it, remembering a model per provider.
  function applySel(next: ModelSel): void {
    // Tool parts in recent turns carry provider metadata (Gemini thought signatures); a
    // different model may reject them, so a switch collapses the history to text.
    if (next.provider !== sel.provider || next.modelId !== sel.modelId) {
      messagesRef.current = collapseOldTurns(messagesRef.current, 0);
    }
    setSel(next);
    persistCfg({
      ...cfgRef.current,
      provider: next.provider,
      model: next.modelId,
      models: { ...cfgRef.current.models, [next.provider]: next.modelId },
      apiKeys: { ...cfgRef.current.apiKeys, [next.provider]: next.apiKey },
    });
  }

  // ── live MCP management ────────────────────────────────────────────────────
  /** Connect a server and merge its tools into the running agent. */
  async function attachServer(name: string, sc: McpServerConfig): Promise<ServerConnection> {
    const conn = await connectServer(name, sc);
    if (conn.connected) {
      setAllTools((t) => ({ ...t, ...conn.tools }));
      setServerStatus((s) => upsertStatus(s, { name, connected: true, toolCount: conn.toolCount }));
      serversRef.current.set(name, conn.close);
    }
    return conn;
  }
  async function attachAndNote(name: string, sc: McpServerConfig): Promise<void> {
    note(`connecting to ${name}…`);
    const conn = await attachServer(name, sc);
    note(conn.connected ? `✓ ${name} — ${conn.toolCount} tools` : `${name}: ${conn.note ?? "connect failed"}`);
  }

  /** `/mcp add <name> <url|cmd…>` — write config, then auto-detect & handle auth. */
  async function doAdd(name: string, sc: McpServerConfig): Promise<void> {
    persistCfg({ ...cfgRef.current, mcpServers: { ...cfgRef.current.mcpServers, [name]: sc } });
    if (sc.command || sc.headers) return attachAndNote(name, sc); // local, or explicit token
    if (sc.oauth) return doLogin(name); // explicit oauth
    // Remote, no auth flags → probe; the probe IS the no-auth connection attempt.
    note(`connecting to ${name}…`);
    const probe = await attachServer(name, sc);
    if (probe.connected) {
      note(`✓ ${name} — ${probe.toolCount} tools`);
      return;
    }
    if (!probe.authNeeded) {
      note(`${name}: ${probe.note ?? "connect failed"}`);
      return;
    }
    note(`${name} needs auth — trying OAuth…`);
    const res = await oauthLogin(name, sc);
    if (res.status === "authorized") {
      const next = { ...sc, oauth: true };
      persistCfg({ ...cfgRef.current, mcpServers: { ...cfgRef.current.mcpServers, [name]: next } });
      await attachAndNote(name, next);
    } else if (res.status === "no-oauth") {
      setPendingToken({ name, sc }); // not OAuth → ask for a token
      setMode("mcp-auth");
    } else {
      note(`${name}: auth failed — ${res.error}. retry: /mcp login ${name}`);
    }
  }

  /** `/mcp login <name>` — (re)authorize an OAuth server and load its tools. */
  async function doLogin(name: string): Promise<void> {
    const sc = cfgRef.current.mcpServers?.[name];
    if (!sc) return note(`no MCP server "${name}".`);
    if (!sc.url) return note(`"${name}" is local — no login needed.`);
    note(`opening browser to authorize ${name}…`);
    const res = await oauthLogin(name, sc);
    if (res.status === "authorized") {
      const next = sc.oauth ? sc : { ...sc, oauth: true };
      persistCfg({ ...cfgRef.current, mcpServers: { ...cfgRef.current.mcpServers, [name]: next } });
      await attachAndNote(name, next);
    } else if (res.status === "no-oauth") {
      note(`${name} isn't OAuth — add a token: /mcp add ${name} ${sc.url} --header "Authorization: Bearer <token>"`);
    } else {
      note(`${name}: auth failed — ${res.error}`);
    }
  }

  function removeServer(name: string | undefined): void {
    if (!name) return note("usage: /mcp remove <name>");
    if (!cfgRef.current.mcpServers?.[name]) return note(`no MCP server "${name}".`);
    const servers = { ...cfgRef.current.mcpServers };
    delete servers[name];
    persistCfg({ ...cfgRef.current, mcpServers: servers });
    const pre = toolPrefix(name);
    setAllTools((t) => Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith(pre))));
    setServerStatus((s) => s.filter((x) => x.name !== name));
    const close = serversRef.current.get(name);
    if (close) {
      void close().catch(() => {});
      serversRef.current.delete(name);
      note(`removed ${name}.`);
    } else {
      note(`removed ${name} (its connection fully closes on next launch).`);
    }
  }

  function listServers(): void {
    note(
      serverStatus.length
        ? serverStatus
            .map((s) => `${s.connected ? "✓" : "○"} ${s.name} — ${s.toolCount} tools${s.note ? `  (${s.note})` : ""}`)
            .join("\n")
        : "no MCP servers — /mcp add <name> <url|command…>",
    );
  }

  async function handleMcp(rest: string): Promise<void> {
    if (!rest || rest === "list") return listServers();
    const parts = rest.split(/\s+/);
    const sub = parts[0];
    if (sub === "add") {
      const parsed = parseServerSpec(parts.slice(1));
      if ("error" in parsed) return note(`/mcp ${parsed.error}`);
      void doAdd(parsed.name, parsed.sc);
      return;
    }
    if (sub === "login") {
      if (!parts[1]) return note("usage: /mcp login <name>");
      void doLogin(parts[1]);
      return;
    }
    if (sub === "remove" || sub === "rm") return removeServer(parts[1]);
    if (sub === "logout") {
      if (!parts[1]) return note("usage: /mcp logout <name>");
      clearAuth(parts[1]);
      return note(`cleared stored credentials for "${parts[1]}".`);
    }
    note("usage: /mcp [list | add <name> <url|cmd…> | login <name> | remove <name> | logout <name>]");
  }

  function onTokenSubmit(token: string): void {
    const p = pendingToken;
    setPendingToken(null);
    setMode("chat");
    if (!p) return;
    const next: McpServerConfig = { ...p.sc, headers: { ...p.sc.headers, Authorization: `Bearer ${token}` } };
    persistCfg({ ...cfgRef.current, mcpServers: { ...cfgRef.current.mcpServers, [p.name]: next } });
    void attachAndNote(p.name, next);
  }
  function onTokenCancel(): void {
    const p = pendingToken;
    setPendingToken(null);
    setMode("chat");
    if (p) note(`added ${p.name} but not authorized — run /mcp login ${p.name} or re-add with a token`);
  }

  // Slash-command autocomplete (shared with Home; see SlashMenu.tsx).
  const slash = useSlashMenu(COMMANDS, input, setInput, !busy && mode === "chat");
  function onChangeInput(v: string) {
    setInput(v);
    slash.onEdit();
  }

  useEffect(() => {
    if (session.messages.length) setHistory(turnsFromMessages(session.messages));
    if (setup.warning) note(setup.warning);
    primeRef.current = ensureGrounded(sessionRef.current); // ground from cache or load once
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A switched-in session starts at its bottom, following new output. */
  function clearScreen() {
    setFollow(true);
  }

  /** Persist the active session and, on its first exchange, derive a title. */
  function persistTurn(userText: string, assistantText: string) {
    const s = sessionRef.current;
    s.messages = [...messagesRef.current];
    s.updatedAt = Date.now();
    saveSession(s);
    if (!s.title) {
      const seed = firstUserText(s) ?? userText;
      const fallback = seed.slice(0, 40).trim() || "untitled";
      s.title = fallback; // immediate fallback (also guards against re-titling)
      if (sessionRef.current === s) setActiveTitle(fallback);
      saveSession(s);
      void summarizeTitle(sel, `User: ${seed.slice(0, 500)}\nAssistant: ${assistantText.slice(0, 500)}`).then((t) => {
        if (!t) return;
        s.title = t;
        saveSession(s);
        if (sessionRef.current === s) setActiveTitle(t);
      });
    }
  }

  /** Save the current session and swap in another (or a fresh one). Screen-style.
   *  `save: false` skips persisting the outgoing session (e.g. it was just archived). */
  function switchTo(id: string | null, opts?: { save?: boolean }) {
    const cur = sessionRef.current;
    if (opts?.save !== false) {
      cur.messages = [...messagesRef.current];
      cur.updatedAt = Date.now();
      saveSession(cur);
    }

    const next = id ? loadSession(id) ?? newSession() : newSession();
    sessionRef.current = next;
    messagesRef.current = [...next.messages];
    clearScreen();
    setHistory(turnsFromMessages(next.messages));
    setActiveTitle(next.title || "new session");
    const u = next.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    usageRef.current = u;
    setUsage(u);
    costRef.current = next.costUsd ?? 0;
    setCostUsd(costRef.current);
    setContextTokens(next.contextTokens ?? estimateMessages(next.messages));
    setMode("chat");
    note(next.messages.length ? `↪ switched to "${next.title || "untitled"}"` : "↪ new session");
    // Ground the switched-in session from its saved orientation (or load once if new).
    orientationRef.current = "";
    snapshotRef.current = undefined;
    turnsThisRunRef.current = 0;
    primeRef.current = ensureGrounded(next);
  }

  function openSwitch() {
    if (busy) {
      note("finish the current reply first");
      return;
    }
    setMode("switcher");
  }

  /** The session's user turns not yet covered by its stored summary. */
  function unsummarizedTurns(): number {
    return userTurnCount(messagesRef.current) - (sessionRef.current.summarizedUserTurns ?? 0);
  }

  /** Bring the session summary up to date. One evolving record per session: the first call
   *  summarizes the transcript, later calls rewrite the stored summary with only the turns
   *  since. It is written to the session file and nowhere else — sessions live on this machine.
   *  Returns the summary, or null when there was nothing new (or nothing at all). Shared by
   *  /summarize, /compact, /exit and Ctrl+C. `quiet` skips the "nothing to do" notes for the
   *  automatic exit path. Throws on a model failure. */
  async function updateSummary(opts: { quiet?: boolean } = {}): Promise<string | null> {
    const s = sessionRef.current;
    const msgs = messagesRef.current;
    if (msgs.length === 0) {
      if (!opts.quiet) note("nothing to summarize yet");
      return null;
    }
    const covered = s.summarizedUserTurns ?? 0;
    const total = userTurnCount(msgs);
    if (s.summary && total <= covered) {
      if (!opts.quiet) note("nothing new since the last summary");
      return null;
    }
    note(s.summary ? "updating the session summary…" : "summarizing…");
    const summary = await summarizeSession(sel, {
      previous: s.summary,
      messages: s.summary ? messagesAfterUserTurn(msgs, covered) : msgs,
    });
    s.summary = summary;
    s.summarizedUserTurns = total;
    s.messages = [...msgs];
    s.updatedAt = Date.now();
    saveSession(s);

    // A session still wearing its first-message fallback title gets a real one from the summary.
    const fallback = (firstUserText(s) ?? "").slice(0, 40).trim();
    if (!s.title || s.title === fallback) {
      const t = await summarizeTitle(sel, summary);
      if (t) {
        s.title = t;
        saveSession(s);
        if (sessionRef.current === s) setActiveTitle(t);
      }
    }

    return summary;
  }

  /** /summarize and /compact: update the summary, show it; compact also trims the context. */
  async function runSummarize(compact: boolean) {
    if (busy) {
      note("finish the current reply first");
      return;
    }
    setBusy(true);
    try {
      const fresh = await updateSummary();
      const s = sessionRef.current;
      const summary = fresh ?? s.summary;
      if (!summary) return; // nothing to summarize yet — already said so
      if (fresh) setHistory((h) => [...h, { role: "assistant", text: fresh }]);
      if (compact) {
        // The summary becomes the whole history; it counts as the one user turn it now covers.
        messagesRef.current = [
          { role: "user", content: `Summary of earlier conversation in this session:\n\n${summary}` },
        ];
        s.summarizedUserTurns = 1;
        s.messages = [...messagesRef.current];
        saveSession(s);
        note("context compacted — earlier turns summarized for the model");
      }
    } catch (err) {
      note(`⚠ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  /** Leave: save, bring the summary up to date if there are new turns, close connections, exit.
   *  A second call (another /exit or Ctrl+C) skips the rest and exits at once. */
  async function shutdown() {
    onBeforeExit?.(); // first, so a second Ctrl+C can't skip it
    if (exitingRef.current) {
      exit();
      process.exit(0);
    }
    exitingRef.current = true;
    const s = sessionRef.current;
    // A reply still streaming means the last user line has no answer yet; don't save it.
    const last = messagesRef.current[messagesRef.current.length - 1];
    if (busy && last?.role === "user") messagesRef.current.pop();
    s.messages = [...messagesRef.current];
    s.updatedAt = Date.now();
    saveSession(s);
    // Only if something was said in this run and the summary doesn't cover it yet. An old
    // session opened just to read stays as it is; /summarize covers it on purpose.
    if (turnsThisRunRef.current > 0 && unsummarizedTurns() > 0) {
      note("summarizing before exit… (Ctrl+C again to skip)");
      try {
        await updateSummary({ quiet: true });
      } catch (err) {
        note(`⚠ ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await setup.close();
    await Promise.all([...serversRef.current.values()].map((c) => c().catch(() => {})));
    exit();
    // A reply or tool call still in flight would keep the event loop alive after Ink unmounts.
    setTimeout(() => process.exit(0), 200).unref();
  }

  // screen-style hotkey: Ctrl+O opens the live session switcher.
  // Also drives the slash-command autocomplete menu (↑/↓/Tab/Esc). Enter is left
  // to TextInput.onSubmit so the current line runs — don't intercept it here.
  useInput((inputCh, key) => {
    if (key.ctrl && inputCh === "c") {
      void shutdown();
      return;
    }
    if (mode !== "chat") return;
    if (key.ctrl && inputCh === "o") {
      openSwitch();
      return;
    }
    if (slash.onKey(key)) return; // Tab completes while the menu is open
    // Chat is the LAST tab in the strip, so Tab wraps round to the first Home tab and Shift+Tab
    // steps back to the last one. Handing Home back with no edge left it on whichever tab it
    // opened chat from, which — if that was the last one — meant Tab bounced between that tab and
    // chat forever and Home itself was never reached.
    if (key.tab && onLeave) {
      const s = sessionRef.current;
      s.messages = [...messagesRef.current];
      s.updatedAt = Date.now();
      saveSession(s);
      onLeave(s, key.shift ? "last" : "first");
      return;
    }
    // With no menu open the arrows and PgUp/PgDn scroll the transcript (the mouse wheel
    // arrives as arrow keys in the alternate screen).
    if (key.upArrow) return pane.scrollBy(-1);
    if (key.downArrow) return pane.scrollBy(1);
    if (key.pageUp) return pane.scrollBy(-(pane.paneH - 1));
    if (key.pageDown) return pane.scrollBy(pane.paneH - 1);
  }, { isActive: visible });

  // Gate handler passed to streamReply: pause the agent and ask the user to approve a
  // write tool. Resolves true (run) / false (decline). "Always" choices skip the prompt.
  function handleConfirm(name: string, args: unknown): Promise<boolean> {
    if (autoApprove.current.has(name)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      setPendingTool({ name, args, resolve });
      setMode("confirm-tool");
    });
  }

  function resolvePendingTool(decision: boolean, always: boolean) {
    const p = pendingTool;
    if (always && p) autoApprove.current.add(p.name);
    setPendingTool(null);
    setMode("chat");
    p?.resolve(decision);
  }

  async function submit(value: string) {
    if (!visible) return; // not the surface in front
    const text = value.trim();
    setInput("");
    if (!text) return;

    if (text === "/exit" || text === "/quit") {
      void shutdown();
      return;
    }
    if (text === "/home") {
      if (!onLeave) {
        note("no Home to go back to — start with `coen` instead of `coen chat`");
        return;
      }
      if (busy) {
        note("finish the current reply first");
        return;
      }
      const s = sessionRef.current;
      s.messages = [...messagesRef.current];
      s.updatedAt = Date.now();
      saveSession(s);
      onLeave(s);
      return;
    }
    if (busy) {
      if (text.startsWith("/")) {
        note("finish the current reply first");
        return;
      }
      queuedRef.current.push(text);
      note("queued — sends when this reply finishes");
      return;
    }
    if (text === "/switch") {
      openSwitch();
      return;
    }
    if (text === "/summarize") {
      void runSummarize(false);
      return;
    }
    if (text === "/compact") {
      void runSummarize(true);
      return;
    }
    if (text === "/clear") {
      // The SCREEN, not the conversation. `history` is only the rendered transcript — it is
      // rebuilt from session.messages, which is what the model is actually given — so clearing it
      // scrolls the room clean and changes nothing about what Coen knows. Saying so matters: a
      // /clear that looked like forgetting but wasn't would be the worst of both.
      setHistory([]);
      note("screen cleared — Coen still has this conversation. /new starts a fresh one.");
      return;
    }
    if (text === "/reset" || text === "/new") {
      switchTo(null);
      return;
    }
    if (text === "/archive") {
      const cur = sessionRef.current;
      if (!cur.messages.length) {
        note("nothing to archive — this session is empty");
        return;
      }
      cur.messages = [...messagesRef.current];
      cur.updatedAt = Date.now();
      saveSession(cur); // ensure the disk copy is current before moving it
      if (!archiveSession(cur.id)) {
        note("⚠ couldn't archive this session");
        return;
      }
      const title = cur.title || "untitled";
      const nextId = listSessions()[0]?.id ?? null; // archived one is already excluded
      switchTo(nextId, { save: false }); // don't recreate the file we just archived
      note(`📦 archived "${title}" — recover from ~/.coen/sessions/archive/`);
      return;
    }
    if (text === "/rename" || text === "/rename ") {
      note("usage: /rename <new title>");
      return;
    }
    if (text.startsWith("/rename ")) {
      const title = text.slice(8).trim();
      if (!title) {
        note("usage: /rename <new title>");
        return;
      }
      sessionRef.current.title = title;
      setActiveTitle(title);
      saveSession(sessionRef.current); // no-op until the session has messages
      note(`renamed → ${title}`);
      return;
    }
    if (text === "/sessions") {
      const list = listSessions().slice(0, 8);
      note(
        list.length
          ? list.map((s) => `• ${s.title}  (${s.messageCount} msgs)`).join("\n")
          : "no saved sessions yet"
      );
      return;
    }
    if (text === "/tools") {
      if (!toolNames.length) {
        note("no tools connected");
        return;
      }
      const ran = [...CLI_RUN_TOOLS].filter((k) => k in allTools);
      if (ran.length) note(`${ran.join(", ")} run at session start and aren't offered to the model`);
      setMode("tools");
      return;
    }
    if (text === "/mcp" || text.startsWith("/mcp ")) {
      await handleMcp(text.slice(4).trim());
      return;
    }
    if (text === "/config") {
      note(
        `${CONFIG_PATH}\n${sel.provider}/${sel.modelId} · record ${webUrl(cfg)}${cfg.auth ? ` (${cfg.auth.email})` : " (not signed in)"}`
      );
      return;
    }
    if (text === "/usage" || text === "/tokens") {
      const price = priceFor(sel.modelId, cfgRef.current);
      const all = listSessions();
      const allTok = all.reduce((n, s) => n + (s.totalTokens ?? 0), 0);
      const allCost = all.reduce((n, s) => n + (s.costUsd ?? 0), 0);
      const unpriced = all.filter((s) => (s.totalTokens ?? 0) > 0 && s.costUsd == null).length;
      note(
        `usage — this session on ${sel.provider}/${sel.modelId}` +
          `\n  ${fmtTokens(usage.promptTokens)} in (${fmtTokens(usage.cachedTokens ?? 0)} from cache) · ${fmtTokens(usage.completionTokens)} out · ${fmtTokens(usage.totalTokens)} total · ≈ ${fmtUsd(costUsd)}` +
          `\n  window now ~${fmtTokens(contextTokens)} tokens, sent with every step of the next turn (last reply: ${fmtTokens(lastCachedRef.current)} cached)` +
          (usage.promptTokens > 0 && !(usage.cachedTokens ?? 0)
            ? "\n  no cache hits yet — the provider may not cache this model, or the prefix is changing between turns"
            : "") +
          `\nprice — ${price ? fmtPrice(price) : `no price on file for ${sel.modelId}; add "pricing" to ${CONFIG_PATH}`}` +
          `\nall sessions — ${all.length} saved · ${fmtTokens(allTok)} tokens · ≈ ${fmtUsd(allCost)}` +
          (unpriced ? ` (${unpriced} older session${unpriced === 1 ? "" : "s"} predate cost tracking and count as ${fmtUsd(0)})` : "")
      );
      return;
    }
    if (text === "/reground") {
      primeRef.current = ensureGrounded(sessionRef.current, true);
      return;
    }
    if (text === "/snapshot") {
      if (!("get_life_snapshot" in setup.tools)) {
        note("get_life_snapshot isn't enabled for this agent key — turn it on in Coen → Settings → Agents");
        return;
      }
      note("taking a fresh snapshot…");
      primeRef.current = loadSnapshot(sessionRef.current).then((ok) =>
        note(ok ? "snapshot refreshed" : "⚠ couldn't take a snapshot (server error)"),
      );
      return;
    }
    if (text === "/model") {
      setMode("models");
      return;
    }
    if (text.startsWith("/model ")) {
      const id = text.slice(7).trim();
      applySel({ ...sel, modelId: id });
      note(`model → ${sel.provider}/${id}`);
      return;
    }
    if (text === "/theme") {
      setMode("theme");
      return;
    }
    if (text.startsWith("/theme ")) {
      const name = text.slice(7).trim().toLowerCase();
      if (!SELECTABLE_SCHEMES.some((s) => s.scheme === name)) {
        note(`unknown theme "${name}". options: ${SELECTABLE_SCHEMES.map((s) => s.scheme).join(", ")}`);
        return;
      }
      void applyScheme(name as ColorScheme, true).then((ok) =>
        note(ok ? `theme → ${name} (synced to dashboard)` : `theme → ${name} (saved locally; sync unavailable)`),
      );
      return;
    }
    if (text === "/help") {
      note(COMMANDS.map((c) => `${c.name.padEnd(12)} ${c.hint}`).join("\n"));
      return;
    }

    setHistory((h) => [...h, { role: "user", text }]);
    messagesRef.current.push({ role: "user", content: text });
    setFollow(true);
    setBusy(true);
    setPartial("");
    setTools([]);

    try {
      // Make sure the agent's orientation is loaded before the first reply.
      if (primeRef.current) await primeRef.current.catch(() => {});
      // Estimate the prompt being sent (system + orientation + transcript + tool schemas)
      // so the live "↑ in" ticker shows immediately, before the API reports exact usage.
      setLivePrompt(
        estimateTokens(buildSystemPrompt(orientationRef.current, snapshotRef.current)) +
          estimateMessages(messagesRef.current) +
          estimateToolset(enabledTools),
      );
      const reply = await streamReply({
        setup: { ...setup, tools: enabledTools },
        sel,
        messages: messagesRef.current,
        context: orientationRef.current,
        snapshot: snapshotRef.current,
        onUsage: addUsage,
        onDelta: (d) => setPartial((p) => p + d),
        onTool: (name) => setTools((t) => [...t, name]),
        onConfirm: confirmWrites(cfgRef.current) ? handleConfirm : undefined,
      });
      // Keep this turn's tool calls + results so a follow-up doesn't re-fetch; turns older
      // than KEEP_TOOL_TURNS collapse to their text (see collapseOldTurns).
      messagesRef.current = collapseOldTurns([...messagesRef.current, ...reply.messages]);
      turnsThisRunRef.current++;
      setHistory((h) => [...h, { role: "assistant", text: reply.text }]);
      persistTurn(text, reply.text);
    } catch (err) {
      messagesRef.current.pop();
      note(`⚠ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      setPartial("");
      setTools([]);
      setLivePrompt(0);
      const next = queuedRef.current.shift();
      if (next && !exitingRef.current) void submit(next);
    }
  }

  // Fill the terminal width and re-reflow markdown when the window resizes.
  const { cols, rows } = useTerminalSize();
  useEffect(() => { applyMarkdownWidth(cols); }, [cols]);

  // ── the transcript pane ────────────────────────────────────────────────────
  // Every turn is rendered to terminal rows once (cached by turn object; the cache is keyed
  // by width + palette so a resize or theme change re-renders everything). The pane shows a
  // window of those rows; the rest of the screen is the overlays and the input area.
  const linesCache = useRef<{ key: string; map: WeakMap<Turn, string[]> }>({ key: "", map: new WeakMap() });
  const lines = useMemo(() => {
    const key = `${cols}|${palette.accent}`;
    if (linesCache.current.key !== key) linesCache.current = { key, map: new WeakMap() };
    const out: string[] = [...bannerLines()];
    for (const t of history) {
      let l = linesCache.current.map.get(t);
      if (!l) {
        l = turnLines(t, palette, cols, md);
        linesCache.current.map.set(t, l);
      }
      out.push(...l);
    }
    if (busy) out.push(...liveLines(partial, palette, cols));
    return out;
  }, [history, busy, partial, cols, palette]);

  // The window onto those rows (shared with Home; see useScrollPane.ts).
  const pane = useScrollPane(lines, rows);
  const { setFollow, hidden } = pane;

  // Hidden means render nothing (see the same note in Home): chat stays mounted behind Home so
  // its connection and transcript survive, but its input must not compete for keystrokes.
  if (!visible) return null;

  return (
    // One row short of the terminal: Ink clears and repaints the whole screen every frame
    // when a frame is as tall as the terminal, and that flickers.
    <Box flexDirection="column" width={cols} height={Math.max(4, rows - 1)}>
      <TopBar
        title="chat"
        tabs={homeTabs ? [...homeTabs, "chat"] : undefined}
        active={homeTabs?.length}
        above={pane.above}
        palette={palette}
        subtitle={onLeave ? `${activeTitle} · Tab back to Home` : activeTitle}
      />
      <Box ref={pane.paneRef} flexDirection="column" flexGrow={1} overflow="hidden">
        {pane.visible.map((l, i) => (
          <Text key={pane.start + i} wrap="truncate-end">{l || " "}</Text>
        ))}
      </Box>

      {/* Session switcher overlay (screen-style) */}
      {visible && mode === "switcher" && (
        <SessionPicker onPick={(id) => switchTo(id)} onCancel={() => setMode("chat")} />
      )}

      {/* Theme picker overlay — live preview, syncs to dashboard on select */}
      {visible && mode === "theme" && (
        <ThemePicker
          onDone={(synced) => {
            setMode("chat");
            note(synced ? "theme synced to dashboard" : "theme saved locally — sync unavailable");
          }}
          onCancel={() => setMode("chat")}
        />
      )}

      {/* Model/provider settings overlay — provider → key → model */}
      {visible && mode === "models" && (
        <ModelPicker
          current={sel}
          cfg={cfg}
          onApply={(next) => {
            applySel(next);
            setMode("chat");
            note(`model → ${next.provider}/${next.modelId}`);
          }}
          onCancel={() => setMode("chat")}
        />
      )}

      {/* MCP token prompt — shown when an added server needs a token (not OAuth) */}
      {visible && mode === "mcp-auth" && pendingToken && (
        <McpTokenPrompt name={pendingToken.name} onSubmit={onTokenSubmit} onCancel={onTokenCancel} />
      )}

      {/* Write-tool confirmation — pauses the agent until the user approves/denies */}
      {visible && mode === "confirm-tool" && pendingTool && (
        <ToolConfirmPrompt
          name={pendingTool.name}
          args={pendingTool.args}
          onApprove={() => resolvePendingTool(true, false)}
          onDeny={() => resolvePendingTool(false, false)}
          onAlways={() => resolvePendingTool(true, true)}
        />
      )}

      {/* Tool enable/disable manager */}
      {visible && mode === "tools" && (
        <ToolManager
          allTools={modelTools}
          serverNames={serverStatus.map((s) => s.name).filter((n) => n !== "coen")}
          disabled={disabled}
          onApply={(next) => {
            setDisabled(next);
            persistCfg({ ...cfgRef.current, disabledTools: [...next] });
            setMode("chat");
            note(`tools: ${toolNames.length - [...next].filter((k) => modelTools[k]).length}/${toolNames.length} enabled`);
          }}
          onCancel={() => setMode("chat")}
        />
      )}

      {/* Status bar + rounded input — pinned to the bottom rows while the pane scrolls */}
      {visible && mode === "chat" && (
        <Box flexDirection="column">
          {hidden > 0 && (
            <Text color={palette.dim}>{`  ▼ ${hidden} more row${hidden === 1 ? "" : "s"} below · ↓ or PgDn to scroll`}</Text>
          )}
          {busy && (
            <Text>
              <Text color={palette.accent}><Spinner type="dots" /></Text>
              <Text color={palette.dim}>{partial ? " writing" : " thinking"}</Text>
              {tools.length > 0 && <Text color={palette.accent}>{"   " + tools.map((t) => `⚙ ${t}`).join("   ")}</Text>}
              <Text color={palette.dim}>{`   ↑ ${fmtTokens(livePrompt)} in · ↓ ${fmtTokens(estimateTokens(partial))} out`}</Text>
            </Text>
          )}
          <Text>
            <Text color={toolNames.length ? palette.success : palette.warning}>{"● "}</Text>
            {ACTIVE_PROFILE !== "default" && <Text color={palette.accent} bold>{`[${ACTIVE_PROFILE}] `}</Text>}
            <Text color={palette.accent}>{activeTitle}</Text>
            <Text color={palette.dim}>
              {"  ·  "}
              {sel.provider}/{sel.modelId} · {Object.keys(enabledTools).length}/{toolNames.length} tools · {serverStatus.filter((s) => s.connected).length} MCP · {fmtTokens(contextTokens)} ctx{lastCachedRef.current ? ` (${fmtTokens(lastCachedRef.current)} cached)` : ""} · {fmtTokens(usage.totalTokens)} tok{costUsd ? ` · ${fmtUsd(costUsd)}` : ""} · ^O switch
            </Text>
          </Text>
          <Box borderStyle="round" borderColor={palette.accent} paddingX={1} width="100%">
            <Text color={palette.accent}>{"❯ "}</Text>
            <TextInput
              value={input}
              onChange={onChangeInput}
              onSubmit={submit}
              placeholder={busy ? "type the next message — it sends when this reply finishes" : "what's on your mind…  (/help)"}
            />
          </Box>
          {slash.show && <SlashMenu suggestions={slash.suggestions} active={slash.active} palette={palette} />}
        </Box>
      )}
    </Box>
  );
}
