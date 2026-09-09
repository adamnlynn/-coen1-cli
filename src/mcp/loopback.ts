import http from "node:http";
import type { AddressInfo } from "node:net";

export const DEFAULT_OAUTH_PORT = Number(process.env.COEN_OAUTH_PORT) || 33418;

export interface Loopback {
  port: number;
  /** Resolves with the authorization code once the browser hits /callback. */
  waitForCode(): Promise<{ code: string; state?: string }>;
  close(): void;
}

/**
 * Start a localhost listener for the OAuth redirect. The redirect_uri registered
 * with the auth server is `http://127.0.0.1:<port>/callback`, so the port must be
 * stable — we fail loudly if it's already in use rather than silently mismatch.
 * `coen login` passes 0 instead: the web app accepts any loopback port, so it takes
 * whatever is free and reads the real port back.
 */
export function startLoopback(port = DEFAULT_OAUTH_PORT): Promise<Loopback> {
  return new Promise((resolve, reject) => {
    let resolveCode: (v: { code: string; state?: string }) => void;
    let rejectCode: (e: Error) => void;
    const codePromise = new Promise<{ code: string; state?: string }>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://127.0.0.1:${(server.address() as AddressInfo | null)?.port ?? port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const state = url.searchParams.get("state") ?? undefined;
      res.writeHead(200, { "Content-Type": "text/html" });
      if (code) {
        res.end("<html><body style='font:16px system-ui;padding:3rem'>✓ Authorized. You can close this tab and return to the terminal.</body></html>");
        resolveCode({ code, state });
      } else {
        res.end(`<html><body style='font:16px system-ui;padding:3rem'>Authorization failed: ${error || "no code returned"}. You can close this tab.</body></html>`);
        rejectCode(new Error(error || "no authorization code returned"));
      }
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`OAuth redirect port ${port} is in use. Free it or set COEN_OAUTH_PORT.`));
      } else {
        reject(err);
      }
    });

    server.listen(port, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        waitForCode: () => codePromise,
        close: () => server.close(),
      });
    });
  });
}
