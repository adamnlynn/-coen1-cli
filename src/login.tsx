import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { type CoenConfig, ACTIVE_PROFILE, webUrl } from "./config.js";
import { login, browserLogin } from "./auth.js";
import { useTheme } from "./theme.js";

type Step = "browser" | "email" | "password" | "busy";

/**
 * `coen login`. By default it opens the browser: approve there, and the terminal is signed in.
 * `--password` (or pressing p while waiting) asks for email and password here instead — for a
 * box with no browser. Both end with the same session saved and the app exiting.
 *
 * The signup line is shown always, not only on failure, and that is deliberate. The server
 * answers "Invalid email or password" whether the account is missing or the password is wrong —
 * correct, and it means this screen genuinely cannot tell someone with no account from someone
 * who mistyped. Guessing would be worse than offering.
 *
 * It used to add "Coen is paid, there's no free tier", on the grounds that finding that out after
 * making an account is the bad order. That is no longer true in either direction: there is a free
 * tier, and the browser page the line points at now offers to make the account rather than only
 * taking a sign-in. What it says instead is what free actually costs you — thirty days — because
 * that is the fact somebody choosing between the two needs, and it is the same fact whether they
 * read it here or on the site.
 */
export function LoginApp({
  cfg,
  password: startWithPassword,
  onDone,
}: {
  cfg: CoenConfig;
  password?: boolean;
  onDone: (next: CoenConfig, name: string | null) => void;
}) {
  const { exit } = useApp();
  const { palette } = useTheme();
  const [step, setStep] = useState<Step>(startWithPassword ? "email" : "browser");
  const [url, setUrl] = useState("");
  const [email, setEmail] = useState(cfg.auth?.email ?? "");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");

  // The browser flow runs once on mount. Falling back to the password prompt lets it keep
  // waiting in the background; whichever finishes first wins, the other is ignored.
  useEffect(() => {
    if (startWithPassword) return;
    let done = false;
    browserLogin(cfg, setUrl)
      .then((r) => {
        if (done) return;
        done = true;
        onDone(r.cfg, r.name);
        exit();
      })
      .catch((e) => {
        if (done) return;
        setErr(e instanceof Error ? e.message : String(e));
        setStep((s) => (s === "browser" ? "email" : s));
      });
    return () => {
      done = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") exit();
    if (step === "browser" && (ch === "p" || key.escape)) {
      setErr("");
      setStep("email");
    }
  });

  async function go() {
    setStep("busy");
    setErr("");
    try {
      const r = await login(cfg, email.trim(), pw);
      onDone(r.cfg, r.name);
      exit();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPw("");
      setStep("password");
    }
  }

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor={palette.accent} paddingX={2} paddingY={1}>
      <Text color={palette.accent} bold>
        {ACTIVE_PROFILE === "default" ? "◆ sign in to Coen 1" : `◆ sign in to Coen 1 · agent: ${ACTIVE_PROFILE}`}
      </Text>
      <Text color={palette.dim}>{webUrl(cfg)}</Text>
      {err ? <Text color={palette.error}>{err}</Text> : null}
      <Text color={palette.dim}>{"no account yet? the browser will offer to make one — free, and Coen keeps your last 30 days"}</Text>

      {step === "browser" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={palette.accent}><Spinner type="dots" /></Text> approve the sign-in in your browser…
          </Text>
          {url ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={palette.dim}>if it didn't open, visit:</Text>
              <Text color={palette.text}>{url}</Text>
            </Box>
          ) : null}
          <Text color={palette.dim}>{"\n"}p — sign in with a password here instead · Ctrl+C to quit</Text>
        </Box>
      )}

      {step !== "browser" && (
        <>
          <Box marginTop={1}>
            <Text>email     </Text>
            {step === "email" ? (
              <>
                <Text color={palette.accent}>› </Text>
                <TextInput value={email} onChange={setEmail} onSubmit={(v) => { if (v.trim()) setStep("password"); }} />
              </>
            ) : (
              <Text color={palette.dim}>{email}</Text>
            )}
          </Box>
          {step !== "email" && (
            <Box>
              <Text>password  </Text>
              {step === "password" ? (
                <>
                  <Text color={palette.accent}>› </Text>
                  <TextInput value={pw} onChange={setPw} mask="•" onSubmit={(v) => { if (v) void go(); }} />
                </>
              ) : (
                <Text color={palette.accent}><Spinner type="dots" /> signing in…</Text>
              )}
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
