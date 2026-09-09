#!/usr/bin/env node
/**
 * mcp-smoke.mjs — a dependency-free MCP client for coen's own server.
 *
 * Exercises the transport an agent will actually use, without an agent in the way: initialize,
 * tools/list, then a read tool and (only when asked) a write tool.
 *
 *   node scripts/mcp-smoke.mjs stdio                 # spawns `coen mcp serve` (needs the daemon)
 *   node scripts/mcp-smoke.mjs http                  # talks to the running daemon directly
 *   node scripts/mcp-smoke.mjs stdio --call get_habits '{"key":"maker_mode"}'
 *   node scripts/mcp-smoke.mjs stdio --write         # also runs one write tool (adds a reminder)
 *
 * Exit code 0 means every step passed.
 */
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENTRY = join(ROOT, "dist", "index.js");
const PROTOCOL_VERSION = "2025-06-18";

const argv = process.argv.slice(2);
const mode = argv[0] === "http" ? "http" : "stdio";
const wantWrite = argv.includes("--write");
const callIdx = argv.indexOf("--call");
const callName = callIdx >= 0 ? argv[callIdx + 1] : null;
const callArgs = callIdx >= 0 && argv[callIdx + 2] ? JSON.parse(argv[callIdx + 2]) : {};

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

let failures = 0;
const step = (name, detail) => console.log(`${green("✓")} ${name}${detail ? dim(`  ${detail}`) : ""}`);
const bad = (name, detail) => {
  failures++;
  console.log(`${red("✗")} ${name}${detail ? `  ${detail}` : ""}`);
};

// ── transports ───────────────────────────────────────────────────────────────

/** The daemon's state file, or exit with the reason. Both transports need it: the HTTP one for
 *  the address, the stdio one because `coen mcp serve` is a bridge to it and serves nothing. */
function daemonState() {
  const home = process.env.COEN_HOME ?? join(homedir(), ".coen");
  const path = join(home, "daemon", "daemon.json");
  try {
    const s = JSON.parse(readFileSync(path, "utf8"));
    if (s?.pid) process.kill(s.pid, 0);
    return s;
  } catch {
    console.log(red("the coen daemon isn't running — nothing serves the tools.\n  start it:  coen daemon start"));
    process.exit(1);
  }
}

/** stdio: spawn `coen mcp serve` and speak newline-delimited JSON-RPC to it. */
function stdioTransport() {
  daemonState();
  const child = spawn(process.execPath, [ENTRY, "mcp", "serve"], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (d) => process.stderr.write(dim(`  [server] ${d}`)));
  let buf = "";
  const waiters = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  return {
    send(msg) {
      child.stdin.write(JSON.stringify(msg) + "\n");
      if (msg.id === undefined) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out waiting for id ${msg.id}`)), 30_000);
        waiters.set(msg.id, (m) => { clearTimeout(t); resolve(m); });
      });
    },
    close() { child.stdin.end(); child.kill(); },
  };
}

/** http: POST to the daemon's /mcp with the token from its state file. */
function httpTransport() {
  const state = daemonState();
  const url = `http://127.0.0.1:${state.port}/mcp`;
  return {
    async send(msg) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${state.token}`,
        },
        body: JSON.stringify(msg),
      });
      if (msg.id === undefined) return null;
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
      // Streamable HTTP answers a single request as one SSE event or as plain JSON.
      const line = text.split("\n").find((l) => l.startsWith("data:"));
      return JSON.parse(line ? line.slice(5).trim() : text);
    },
    close() {},
  };
}

// ── the run ──────────────────────────────────────────────────────────────────

const t = mode === "http" ? httpTransport() : stdioTransport();
let id = 0;
const rpc = async (method, params) => {
  const res = await t.send({ jsonrpc: "2.0", id: ++id, method, params });
  if (res?.error) throw new Error(`${method}: ${res.error.message} (${res.error.code})`);
  return res?.result;
};
const textOf = (r) => (r?.content ?? []).map((c) => c.text ?? "").join("");

try {
  console.log(dim(`transport: ${mode}\n`));

  const init = await rpc("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "mcp-smoke", version: "1.0.0" },
  });
  if (!init?.serverInfo?.name) bad("initialize", "no serverInfo");
  else step("initialize", `${init.serverInfo.name} ${init.serverInfo.version} · protocol ${init.protocolVersion}`);
  await t.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = await rpc("tools/list", {});
  const tools = list?.tools ?? [];
  if (!tools.length) bad("tools/list", "no tools");
  else step("tools/list", `${tools.length} tools`);
  const missingDesc = tools.filter((x) => !x.description);
  if (missingDesc.length) bad("tool descriptions", missingDesc.map((x) => x.name).join(", "));
  const missingSchema = tools.filter((x) => !x.inputSchema || x.inputSchema.type !== "object");
  if (missingSchema.length) bad("tool input schemas", missingSchema.map((x) => x.name).join(", "));
  else step("tool schemas", "every tool has an object inputSchema");

  if (callName) {
    const r = await rpc("tools/call", { name: callName, arguments: callArgs });
    console.log(`\n${dim(`--- ${callName} ---`)}\n${textOf(r)}\n`);
    if (r?.isError) bad(callName, "returned isError");
    else step(callName, "ok");
  } else {
    const r = await rpc("tools/call", { name: "whoami", arguments: {} });
    const text = textOf(r);
    if (r?.isError || !text.includes("coen_purpose")) bad("tools/call whoami", text.slice(0, 200));
    else step("tools/call whoami", `${text.length} chars`);

    const h = await rpc("tools/call", { name: "get_habits", arguments: {} });
    if (h?.isError) bad("tools/call get_habits", textOf(h).slice(0, 200));
    else step("tools/call get_habits", `${JSON.parse(textOf(h)).count} habits`);

    // A tool that must fail, and must fail as a readable answer rather than a protocol error.
    const miss = await rpc("tools/call", { name: "get_habits", arguments: { key: "no_such_habit_xyz" } });
    if (!miss?.isError) bad("bad argument", "expected isError");
    else step("bad argument", "came back as a tool error, not a crash");
  }

  if (wantWrite) {
    const stamp = new Date().toISOString();
    const w = await rpc("tools/call", {
      name: "add_reminder",
      arguments: { content: `mcp-smoke test ${stamp}`, attribution: "mcp-smoke" },
    });
    if (w?.isError) bad("tools/call add_reminder", textOf(w).slice(0, 200));
    else step("tools/call add_reminder", textOf(w).slice(0, 120));
    console.log(dim("  (that reminder is real — remove it in the dashboard if you don't want it)"));
  }
} catch (e) {
  bad("run", e.message);
} finally {
  t.close();
}

console.log(failures ? red(`\n${failures} failed`) : green("\nall good"));
process.exit(failures ? 1 : 0);
