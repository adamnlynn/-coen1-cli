import { randomBytes, createHash } from "node:crypto";
import open from "open";
import { type CoenConfig, loadConfig, saveConfig, webUrl } from "./config.js";
import { startLoopback } from "./mcp/loopback.js";

/**
 * Signing in. The same email + password as the web app, against the same route, so the token is
 * the same 7-day JWT the dashboard and the mobile app carry. It is the only credential the CLI
 * has: Home reads with it, the chat's tools read and write with it, and so do the tools the CLI
 * serves to other agents on this machine.
 */

export class LoginError extends Error {}

/** The `exp` claim of a JWT as unix ms, without verifying it — the server does that. */
export function tokenExpiry(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
/** Refresh when this close to expiry, so a daily user never sees the token lapse. */
const REFRESH_WITHIN_MS = 2 * 24 * 60 * 60 * 1000;

export interface LoginResult {
  cfg: CoenConfig;
  name: string | null;
}

/** POST /api/auth/login. Saves the token into the config and returns the updated config. */
export async function login(cfg: CoenConfig, email: string, password: string): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch(`${webUrl(cfg)}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch (e) {
    throw new LoginError(`couldn't reach ${webUrl(cfg)} — ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string; user?: { full_name?: string | null } };
  if (!res.ok) throw new LoginError(body.error ?? `login failed (${res.status})`);
  if (!body.token) throw new LoginError("login returned no token");
  const next: CoenConfig = {
    ...cfg,
    auth: { email, token: body.token, expiresAt: tokenExpiry(body.token) ?? Date.now() + SEVEN_DAYS },
  };
  saveConfig(next);
  return { cfg: next, name: body.user?.full_name ?? null };
}

/** How long `coen login` waits for the browser before giving up. */
const BROWSER_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Sign in through the browser. Opens /connect/cli on the web app with a PKCE challenge and a
 * loopback redirect; the page (already signed in, or after signing in) hands a one-time code to
 * the loopback listener; we redeem it at /api/cli/token for the same session the web app has.
 * The token never travels in a URL — only the code does, and only the holder of the verifier
 * can redeem it. `onUrl` gets the page URL so the screen can show it in case the browser did not
 * open. Resolves like `login`.
 */
export async function browserLogin(cfg: CoenConfig, onUrl?: (url: string) => void): Promise<LoginResult> {
  const verifier = randomBytes(48).toString("base64url"); // 64 chars, within PKCE's 43..128
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  const loop = await startLoopback(0);
  try {
    const redirect = `http://127.0.0.1:${loop.port}/callback`;
    const url =
      `${webUrl(cfg)}/connect/cli?redirect_uri=${encodeURIComponent(redirect)}` +
      `&state=${state}&code_challenge=${challenge}`;
    onUrl?.(url);
    await open(url).catch(() => {}); // a headless box just shows the URL
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new LoginError("gave up waiting for the browser — run `coen login` again, or `coen login --password`")), BROWSER_LOGIN_TIMEOUT_MS);
      t.unref();
    });
    const got = await Promise.race([loop.waitForCode(), timeout]);
    if (got.state !== state) throw new LoginError("the browser answered a different sign-in attempt — run `coen login` again");

    let res: Response;
    try {
      res = await fetch(`${webUrl(cfg)}/api/cli/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: got.code, code_verifier: verifier }),
      });
    } catch (e) {
      throw new LoginError(`couldn't reach ${webUrl(cfg)} — ${e instanceof Error ? e.message : String(e)}`);
    }
    const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string; user?: { email?: string; full_name?: string | null } };
    if (res.status === 404) {
      throw new LoginError(
        `${webUrl(cfg)} doesn't have the browser sign-in.\n` +
          "  Point at a server that does (coen config set-web <url>),\n" +
          "  or sign in here instead: coen login --password",
      );
    }
    if (!res.ok) throw new LoginError(body.error ?? `sign-in failed (${res.status})`);
    if (!body.token) throw new LoginError("sign-in returned no token");
    const email = body.user?.email ?? cfg.auth?.email ?? "";
    const next: CoenConfig = {
      ...cfg,
      auth: { email, token: body.token, expiresAt: tokenExpiry(body.token) ?? Date.now() + SEVEN_DAYS },
    };
    saveConfig(next);
    return { cfg: next, name: body.user?.full_name ?? null };
  } finally {
    loop.close();
  }
}

/** True when a token is stored and has not expired. Does not check it with the server. */
export function signedIn(cfg: CoenConfig): boolean {
  return !!cfg.auth?.token && cfg.auth.expiresAt > Date.now();
}

/** Forget the token. Returns the config without it. */
export function logout(cfg: CoenConfig): CoenConfig {
  const { auth: _drop, ...rest } = cfg;
  saveConfig(rest);
  return rest;
}

/**
 * The token to send with a request. Refreshes it through POST /api/auth/refresh when it is
 * within two days of expiry; a failed refresh keeps the current token (still valid) and tries
 * again next time. Null when signed out or already expired. `onChange` receives the new auth
 * block so whoever holds the config in memory can keep it current.
 */
export async function currentToken(
  cfg: CoenConfig,
  onChange?: (auth: NonNullable<CoenConfig["auth"]>) => void,
): Promise<string | null> {
  const a = cfg.auth;
  if (!a?.token) return null;
  if (a.expiresAt <= Date.now()) return null;
  if (a.expiresAt - Date.now() > REFRESH_WITHIN_MS) return a.token;
  try {
    const res = await fetch(`${webUrl(cfg)}/api/auth/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${a.token}` },
    });
    if (!res.ok) return a.token;
    const body = (await res.json()) as { token?: string };
    if (!body.token) return a.token;
    const auth = { email: a.email, token: body.token, expiresAt: tokenExpiry(body.token) ?? Date.now() + SEVEN_DAYS };
    // Read-modify-write: only the auth block changes, whatever else was saved meanwhile stays.
    saveConfig({ ...loadConfig(), auth });
    onChange?.(auth);
    return auth.token;
  } catch {
    return a.token;
  }
}

/**
 * How much history this account keeps: a number of days, or null for everything.
 *
 * Asked once, right after signing in, and printed there. It is the only place a CLI-first person
 * would ever find out — somebody who installed from the landing page and never opened the web app
 * has no billing page to read, and finding out what a plan keeps by noticing something missing
 * later is the bad order.
 *
 * Returns undefined rather than throwing on any failure. A server that has not shipped
 * retention_days yet, an outage, a proxy — none of those are worth turning a successful sign-in
 * into an error message about storage.
 */
export async function retentionDays(cfg: CoenConfig): Promise<number | null | undefined> {
  const token = cfg.auth?.token;
  if (!token) return undefined;
  try {
    const res = await fetch(`${webUrl(cfg)}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { user?: { account?: { retention_days?: number | null } } };
    const days = body.user?.account?.retention_days;
    return days === undefined ? undefined : days;
  } catch {
    return undefined;
  }
}
