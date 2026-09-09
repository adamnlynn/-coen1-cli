import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { type McpServerConfig } from "../config.js";
import { FileOAuthProvider } from "./oauth.js";
import { startLoopback } from "./loopback.js";

export type LoginResult =
  | { status: "authorized" }
  | { status: "no-oauth"; error: string } // server isn't OAuth — caller should try a token
  | { status: "error"; error: string };

/**
 * Run the OAuth login dance for a remote server (loopback + browser + finishAuth),
 * returning a discriminated result instead of printing. Shared by the `coen mcp
 * login` shell command and the in-chat `/mcp add`/`/mcp login` auto-auth.
 *
 * Distinguishes a non-OAuth server: the first connect throwing `UnauthorizedError`
 * means OAuth discovery succeeded and the browser was opened; any other throw means
 * discovery failed → the server isn't OAuth.
 */
export async function oauthLogin(name: string, sc: McpServerConfig): Promise<LoginResult> {
  if (!sc.url) return { status: "error", error: "not a remote server" };

  const loop = await startLoopback();
  const provider = new FileOAuthProvider(name, loop.port, {
    clientId: sc.clientId,
    clientSecret: sc.clientSecret,
    scope: sc.scope,
  });
  const makeTransport = () =>
    new StreamableHTTPClientTransport(new URL(sc.url!), {
      authProvider: provider,
      requestInit: sc.headers ? { headers: sc.headers } : undefined,
    });
  const client = new Client({ name: "coen-cli", version: "0.1.0" });

  try {
    const transport = makeTransport();
    try {
      await client.connect(transport);
      await client.close();
      return { status: "authorized" }; // cached/refreshed token still valid
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) {
        return { status: "no-oauth", error: e instanceof Error ? e.message : String(e) };
      }
      // UnauthorizedError ⇒ the provider opened the browser; fall through to wait.
    }
    const { code } = await loop.waitForCode();
    await transport.finishAuth(code); // same transport — has discovery + scope cached
    await client.connect(makeTransport()); // fresh connect with the new tokens
    await client.close();
    return { status: "authorized" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  } finally {
    loop.close();
  }
}
