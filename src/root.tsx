import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, useApp } from "ink";
import Spinner from "ink-spinner";
import App from "./app.js";
import { Home } from "./home/Home.js";
import { ChatSetup } from "./setup.js";
import { hasAnyKey, resolveSetup, type Setup } from "./agent.js";
import { type CoenConfig, saveConfig } from "./config.js";
import { signedIn } from "./auth.js";
import { createClient, getTheme, putThemeScheme } from "./api.js";
import { type Session, latestSession, newSession } from "./sessions.js";
import {
  ThemeContext,
  type ColorScheme,
  DEFAULT_SCHEME,
  paletteFor,
} from "./theme.js";

export type Surface = "home" | "chat";
type ChatPhase = "setup" | "connecting" | "ready";

// Chat needs two things: a model provider key of its own, and the sign-in. Home needs only the
// sign-in (see auth.ts).
//
// There used to be a third — a separate long-lived API key that the chat's tools authenticated
// with against a remote MCP endpoint. That whole path has been retired on both sides, and the CLI
// mints nothing. Its tools are local now (src/coen-tools) and read the record with the signed-in
// session, the same credential Home uses.
const chatConfigured = (cfg: CoenConfig) => hasAnyKey(cfg) && signedIn(cfg);

/**
 * The two surfaces. `startIn` is where the command line put us: bare `coen` starts in Home and
 * can open the chat with /chat (and come back with /home); `coen chat` starts in the chat with no
 * Home to return to.
 */
export function Root({
  initialCfg,
  initialSession,
  openSwitcher,
  startIn,
}: {
  initialCfg: CoenConfig;
  initialSession?: Session;
  openSwitcher?: boolean;
  startIn: Surface;
}) {
  const { exit } = useApp();
  const [session, setSession] = useState<Session>(() => initialSession ?? latestSession() ?? newSession());
  const [cfg, setCfg] = useState(initialCfg);
  const [surface, setSurface] = useState<Surface>(startIn);
  const [chatPhase, setChatPhase] = useState<ChatPhase>(chatConfigured(initialCfg) ? "connecting" : "setup");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState("");
  // Home's tab titles, lifted so the chat tab can draw the same strip with itself lit.
  const [homeTabs, setHomeTabs] = useState<string[]>(["Home"]);
  const onTabsChange = useCallback((titles: string[]) => setHomeTabs(titles), []);
  // Home's "write the screen down", so chat's own Ctrl+C keeps the tabs behind it.
  const saveHomeRef = useRef<(() => void) | null>(null);
  const registerSave = useCallback((fn: () => void) => {
    saveHomeRef.current = fn;
  }, []);
  // Home's "land on this tab", so a Tab out of chat wraps round to Home rather than dropping back
  // on the tab chat was opened from.
  const focusHomeRef = useRef<((edge: "first" | "last") => void) | null>(null);
  const registerFocus = useCallback((fn: (edge: "first" | "last") => void) => {
    focusHomeRef.current = fn;
  }, []);
  // Home's "say this on screen", so the session reconcile — which runs here, because it needs the
  // client — can report what it archived where the person is actually looking.
  const noteHomeRef = useRef<((text: string) => void) | null>(null);
  const registerNote = useCallback((fn: (text: string) => void) => {
    noteHomeRef.current = fn;
  }, []);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  // Home's HTTP client. A refreshed token lands back in the in-memory config so a later save
  // (theme, model) does not write the old one over it.
  const client = useMemo(
    () => createClient(initialCfg, (auth) => setCfg((c) => ({ ...c, auth }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Theme: seed from the cached scheme so colours are right before the network returns, then
  // refresh from the dashboard once a surface is connected.
  const [scheme, setScheme] = useState<ColorScheme>(
    (initialCfg.theme?.colorScheme as ColorScheme) || DEFAULT_SCHEME,
  );
  const [customHsl, setCustomHsl] = useState<string | null>(null);
  const palette = useMemo(() => paletteFor(scheme, customHsl), [scheme, customHsl]);

  // User-initiated theme change: apply locally + cache, and (when sync) write back to the
  // dashboard — through the signed-in person's token when there is one, else the agent key.
  const applyScheme = useCallback(async (next: ColorScheme, sync = true): Promise<boolean> => {
    setScheme(next);
    setCustomHsl(null);
    saveConfig({ ...cfgRef.current, theme: { colorScheme: next } });
    if (!sync) return true;
    // The dashboard is reached with the sign-in and nothing else. There used to be a second
    // path here for a chat that had an agent key but no login; there is no such thing now.
    if (!signedIn(cfgRef.current)) return true;
    return putThemeScheme(client, next).then(() => true).catch(() => false);
  }, [client]);

  const themeValue = useMemo(() => ({ scheme, palette, applyScheme }), [scheme, palette, applyScheme]);

  const applyFetched = useCallback((colorScheme: string | undefined, brand: string | null | undefined) => {
    if (!colorScheme) return;
    setScheme(colorScheme as ColorScheme);
    setCustomHsl(brand ?? null);
    saveConfig({ ...cfgRef.current, theme: { colorScheme } });
  }, []);

  // Home: read the theme with the signed-in token, once.
  useEffect(() => {
    if (startIn !== "home" || !signedIn(initialCfg)) return;
    let cancelled = false;
    void getTheme(client)
      .then((t) => {
        if (cancelled || !t) return;
        applyFetched(t.colorScheme, t.customTheme?.brandPrimary);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Chat: assemble the tools (and the model) when the chat surface is up and configured. Coen's
  // own tools are in this process now, so there is nothing to dial — what they need is the
  // signed-in client, which is the same one Home uses.
  useEffect(() => {
    if (surface !== "chat" || chatPhase !== "connecting" || setup) return;
    let cancelled = false;
    resolveSetup(cfg, signedIn(cfg) ? client : null)
      .then((s) => {
        if (cancelled) return;
        setSetup(s);
        setChatPhase("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setChatPhase("setup");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, chatPhase, setup]);

  const backHome = startIn === "home"
    ? (current?: Session, edge?: "first" | "last") => {
        if (current) setSession(current);
        if (edge) focusHomeRef.current?.(edge);
        setSurface("home");
      }
    : undefined;

  // Home and chat are two tabs of one window, so once opened they both stay MOUNTED and the one
  // that is not in front renders nothing (each returns null when `active` is false). Unmounting
  // Home on the way to chat threw away its tabs, its scroll and anything half-typed, and re-ran
  // its restore-from-disk on the way back — which is why coming back used to jump you to another
  // tab. Drawing both, which is what hiding with display:none amounted to, was worse: two live
  // input boxes, so chat's keystrokes were typed into Home as well.
  const homePane = startIn === "home" && (
    <>
      <Home
        client={client}
        cfg={cfg}
        onChat={() => setSurface("chat")}
        onTabsChange={onTabsChange}
        registerSave={registerSave}
        registerFocus={registerFocus}
        registerNote={registerNote}
        active={surface === "home"}
      />
    </>
  );

  let content: ReactNode = null;
  if (surface === "home") {
    content = null; // homePane below is the whole screen
  } else if (chatPhase === "setup") {
    content = (
      <ChatSetup
        cfg={cfg}
        error={error}
        onDone={(next) => {
          saveConfig(next);
          setCfg(next);
          setError("");
          setChatPhase("connecting");
        }}
        onCancel={backHome ?? (() => exit())}
      />
    );
  } else if (chatPhase === "connecting") {
    content = (
      <Text color={palette.accent}>
        <Spinner type="dots" /> getting ready…
      </Text>
    );
  } else if (setup) {
    content = null; // chatPane below
  }

  // Chat mounts on its first visit and stays: its external MCP connections, its transcript and a
  // reply still streaming all survive a look at Home.
  const chatPane = setup && (
    <>
      <App
        setup={setup}
        cfg={cfg}
        session={session}
        openSwitcher={openSwitcher}
        onLeave={backHome}
        onBeforeExit={() => saveHomeRef.current?.()}
        homeTabs={startIn === "home" ? homeTabs : undefined}
        active={surface === "chat" && chatPhase === "ready"}
      />
    </>
  );

  return (
    <ThemeContext.Provider value={themeValue}>
      {homePane}
      {chatPane}
      {content}
    </ThemeContext.Provider>
  );
}
