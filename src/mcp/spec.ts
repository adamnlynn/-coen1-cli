import { type McpServerConfig } from "../config.js";

/** Sanitize to the providers' tool-name charset (^[A-Za-z0-9_-]). */
export function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** The key prefix a server's tools get, e.g. "todoist_". */
export function toolPrefix(name: string): string {
  return `${sanitize(name)}_`;
}

export type ParsedSpec = { name: string; sc: McpServerConfig } | { error: string };

/**
 * Parse `add` args (`<name> <url|command…> [flags]`) into a server config. Shared by
 * the `coen mcp add` shell command and the in-chat `/mcp add` handler so they agree.
 */
export function parseServerSpec(args: string[]): ParsedSpec {
  const name = args[0];
  if (!name) return { error: "usage: add <name> <url | command [args…]> [flags]" };

  const rest = args.slice(1);
  const headers: Record<string, string> = {};
  const env: Record<string, string> = {};
  const positional: string[] = [];
  let oauth = false;
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  let scope: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--oauth") oauth = true;
    else if (a === "--header") {
      const kv = rest[++i] ?? "";
      const idx = kv.indexOf(":");
      if (idx > 0) headers[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
    } else if (a === "--env") {
      const kv = rest[++i] ?? "";
      const idx = kv.indexOf("=");
      if (idx > 0) env[kv.slice(0, idx)] = kv.slice(idx + 1);
    } else if (a === "--client-id") clientId = rest[++i];
    else if (a === "--client-secret") clientSecret = rest[++i];
    else if (a === "--scope") scope = rest[++i];
    else positional.push(a);
  }

  if (!positional.length) {
    return { error: "provide a url (remote) or a command (local). e.g. add todoist https://… " };
  }

  const sc: McpServerConfig = {};
  if (/^https?:\/\//i.test(positional[0])) {
    sc.url = positional[0];
    if (Object.keys(headers).length) sc.headers = headers;
    if (oauth) sc.oauth = true;
    if (clientId) sc.clientId = clientId;
    if (clientSecret) sc.clientSecret = clientSecret;
    if (scope) sc.scope = scope;
  } else {
    sc.command = positional[0];
    if (positional.length > 1) sc.args = positional.slice(1);
    if (Object.keys(env).length) sc.env = env;
  }
  return { name, sc };
}
