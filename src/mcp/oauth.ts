import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import open from "open";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { mcpAuthDir, type McpServerConfig } from "../config.js";

/**
 * File-backed OAuthClientProvider for one MCP server. The MCP SDK's `auth()`
 * drives discovery, dynamic client registration, PKCE, token exchange and
 * refresh — this just persists the bits it hands us under
 * `~/.coen/mcp-auth/<server>/` (0o600) and opens the browser on redirect.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  private dir: string;
  constructor(
    private server: string,
    private redirectPort: number,
    private opts: Pick<McpServerConfig, "clientId" | "clientSecret" | "scope"> = {},
  ) {
    this.dir = mcpAuthDir(server);
  }

  private path(file: string): string {
    return join(this.dir, file);
  }
  private readJson<T>(file: string): T | undefined {
    try {
      const p = this.path(file);
      return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : undefined;
    } catch {
      return undefined;
    }
  }
  private writeJson(file: string, value: unknown): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.path(file), JSON.stringify(value, null, 2), { mode: 0o600 });
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.redirectPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "coen-cli",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.opts.clientSecret ? "client_secret_post" : "none",
      ...(this.opts.scope ? { scope: this.opts.scope } : {}),
    } as unknown as OAuthClientMetadata;
  }

  state(): string {
    let s = this.readJson<{ state: string }>("state.json")?.state;
    if (!s) {
      s = randomBytes(16).toString("hex");
      this.writeJson("state.json", { state: s });
    }
    return s;
  }

  clientInformation(): OAuthClientInformation | OAuthClientInformationFull | undefined {
    if (this.opts.clientId) {
      return { client_id: this.opts.clientId, client_secret: this.opts.clientSecret };
    }
    return this.readJson<OAuthClientInformationFull>("client.json");
  }
  saveClientInformation(info: OAuthClientInformationFull): void {
    this.writeJson("client.json", info);
  }

  tokens(): OAuthTokens | undefined {
    return this.readJson<OAuthTokens>("tokens.json");
  }
  saveTokens(tokens: OAuthTokens): void {
    this.writeJson("tokens.json", tokens);
  }

  saveCodeVerifier(verifier: string): void {
    this.writeJson("verifier.json", { verifier });
  }
  codeVerifier(): string {
    const v = this.readJson<{ verifier: string }>("verifier.json")?.verifier;
    if (!v) throw new Error("No PKCE code verifier saved — restart the login flow.");
    return v;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await open(authorizationUrl.toString());
  }
}

/** True if we have any stored tokens for this server (i.e. previously logged in). */
export function hasStoredTokens(server: string): boolean {
  return existsSync(join(mcpAuthDir(server), "tokens.json"));
}

/** Forget a server's OAuth credentials (logout). */
export function clearAuth(server: string): void {
  const dir = mcpAuthDir(server);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
