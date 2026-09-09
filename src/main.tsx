import { render } from "ink";
import { stdout } from "node:process";
import { Root, type Surface } from "./root.js";
import { LoginApp } from "./login.js";
import { CONFIG_PATH, ACTIVE_PROFILE, loadConfig, listProfiles, listArchived, webUrl } from "./config.js";
import { signedIn, logout, retentionDays } from "./auth.js";
import { type Session, latestSession, loadSession, newSession } from "./sessions.js";
import { printBanner } from "./banner.js";
import { enterAltScreen, leaveAltScreen } from "./screen.js";
import { runMcpCommand } from "./mcp/cli.js";
import { runConfigCommand } from "./config-cli.js";
import { readStdin, runPulse } from "./pipe.js";
import { VERSION } from "./version.js";
import { runSessionsCommand } from "./sessions-cli.js";
import { runDaemonCommand } from "./daemon/cli.js";
import { runSyncCommand, runGitSyncCommand } from "./sync/cli.js";

const dim = (s: string) => stdout.write(`\x1b[2m${s}\x1b[0m\n`);
const red = (s: string) => stdout.write(`\x1b[31m${s}\x1b[0m\n`);
const green = (s: string) => stdout.write(`\x1b[32m${s}\x1b[0m\n`);
const plain = (s: string) => stdout.write(`${s}\n`);

/** Ink's interactive input needs a real TTY. Git Bash/mintty and pipes are not. */
function ensureTTY() {
  if (!process.stdin.isTTY) {
    red("coen needs an interactive terminal, but stdin isn't a TTY.");
    dim(
      "This happens in Git Bash / mintty and piped shells.\n" +
        "Run it in Windows Terminal, PowerShell, or cmd.\n" +
        "If you must use Git Bash, prefix with winpty:  winpty coen"
    );
    process.exit(1);
  }
}

const HELP =
  "Usage:\n" +
  "  coen                Home: today's read, your habits, and the check-in input\n" +
  "  … | coen            check in with whatever is piped in (no screen)\n" +
  "  coen pulse \"text\"   the same, from an argument · --wait prints the read when it lands\n" +
  "  coen login          sign in — opens your browser to approve (--password to type it here)\n" +
  "  coen logout         forget the sign-in\n" +
  "  coen --version      print the version and exit\n" +
  "\n" +
  "  In Home, type to check in. Commands: /habit /decision /insight /reminder /journal /read\n" +
  "  /decisions /reminders /realizations /chat /theme /help /exit\n" +
  "\n" +
  "Chat (your own model key; first use walks you through it):\n" +
  "  coen chat           resume your last chat session (/home goes back when started from Home)\n" +
  "  coen new            start a fresh chat session\n" +
  "  coen --resume [id]  resume the latest session (or a specific id)\n" +
  "  coen sessions       open the session switcher (list · show · prune · rm on the console)\n" +
  "  coen mcp …          add/list/login external MCP servers (coen mcp for help)\n" +
  "  coen config …       view/switch provider, model, keys and hosts (coen config for help)\n" +
  "\n" +
  "Coen's tools, for other agents on this machine:\n" +
  "  coen mcp serve      Coen's tools on stdio · coen mcp install <client> writes the entry\n" +
  "  coen daemon start   run it in the background and at login · status · stop · logs\n" +
  "\n" +
  "Your record as files:\n" +
  "  coen sync <folder>  a folder of markdown kept in step · write into <folder>/new to check in\n" +
  "  coen git-sync       keep that folder in git — committed every pass, pushed on a timer\n" +
  "\n" +
  "Profiles:\n" +
  "  coen agent <name> [command…]   a separate profile (own sign-in, keys, MCP, sessions)\n" +
  "  coen agent <name> --rm | --archive · coen agents";

/** The real entry point. The bootstrap (index.tsx) selects the profile first, then calls this. */
export async function runMain() {
  const cmd = process.argv[2];
  const cfg = loadConfig();

  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    dim(HELP);
    return;
  }

  // Before ensureTTY(), and that is the point: `coen --version` has to answer in a pipe, a CI job
  // and a bug report, none of which have a terminal. There was no handler at all until now, so it
  // fell through to the TTY guard and a headless `coen --version` printed an error about mintty.
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    plain(VERSION);
    return;
  }

  // Plain-console management commands — no TTY/banner needed.
  if (cmd === "agents") {
    plain("agents (profiles):");
    plain(`  default${ACTIVE_PROFILE === "default" ? "  (active)" : ""}    ~/.coen`);
    const profiles = listProfiles();
    for (const p of profiles) plain(`  ${p}${ACTIVE_PROFILE === p ? "  (active)" : ""}    ~/.coen/profiles/${p}`);
    if (!profiles.length) dim("  (no named profiles yet — create one: coen agent <name>)");
    const archived = listArchived();
    if (archived.length) {
      plain("\narchived:");
      for (const a of archived) dim(`  ${a}    ~/.coen/archive/${a}`);
    }
    return;
  }
  if (cmd === "mcp") {
    await runMcpCommand(process.argv.slice(3), cfg);
    return;
  }
  if (cmd === "daemon") {
    await runDaemonCommand(process.argv.slice(3), cfg);
    return;
  }
  if (cmd === "config") {
    runConfigCommand(process.argv.slice(3), cfg);
    return;
  }
  if (cmd === "sync") {
    await runSyncCommand(process.argv.slice(3), cfg);
    return;
  }
  if (cmd === "git-sync") {
    await runGitSyncCommand(process.argv.slice(3), cfg);
    return;
  }
  // `coen sessions list|show|prune|rm` answer on the plain console; bare `coen sessions` falls
  // through to the switcher, which needs a terminal.
  if (cmd === "sessions" && process.argv[3]) {
    await runSessionsCommand(process.argv.slice(3));
    return;
  }
  if (cmd === "logout") {
    if (!cfg.auth) {
      dim("not signed in.");
      return;
    }
    logout(cfg);
    green(`signed out ${cfg.auth.email}.`);
    return;
  }
  // A check-in from a pipe or an argument: no screen, no TTY needed.
  //   echo "…" | coen        ·  coen pulse "…"  ·  cat notes.md | coen pulse --wait
  if (cmd === "pulse" || cmd === "journal" || (cmd === undefined && !process.stdin.isTTY)) {
    const args = process.argv.slice(3);
    const wait = args.some((a) => a === "--wait" || a === "-w");
    const inline = args.filter((a) => !a.startsWith("-")).join(" ");
    const text = inline || (await readStdin());
    process.exit(await runPulse(cfg, text, { wait }));
  }

  ensureTTY();

  if (cmd === "login") {
    printBanner();
    if (ACTIVE_PROFILE !== "default") dim(`agent: ${ACTIVE_PROFILE}`);
    let signed: { email: string; name: string | null } | null = null;
    const password = process.argv.slice(3).some((a) => a === "--password" || a === "-p");
    const app = render(
      <LoginApp cfg={cfg} password={password} onDone={(next, name) => { signed = { email: next.auth!.email, name }; }} />,
    );
    await app.waitUntilExit();
    if (signed) {
      const s = signed as { email: string; name: string | null };
      green(`signed in as ${s.name ?? s.email} · ${webUrl(cfg)}`);
      // What this account keeps. Silent when the server does not say — see retentionDays().
      const days = await retentionDays(loadConfig());
      if (typeof days === "number") {
        dim(`free · Coen keeps your last ${days} days. Older entries are set aside, and come back if you upgrade.`);
      } else if (days === null) {
        dim("Coen keeps everything.");
      }
      dim(`Saved → ${CONFIG_PATH}\nRun \`coen\` to open Home.`);
    }
    return;
  }

  // Which surface, and which chat session. Bare `coen` (or `coen agent <name>`) is Home; the chat
  // commands go straight to the chat, with `new` forcing a fresh session, --resume the latest or a
  // specific one, and `sessions` the picker.
  let startIn: Surface = "home";
  let initialSession: Session | undefined;
  let openSwitcher = false;
  if (cmd === "--resume" || cmd === "-r") {
    startIn = "chat";
    const id = process.argv[3];
    initialSession = (id ? loadSession(id) : latestSession()) ?? newSession();
  } else if (cmd === "sessions") {
    startIn = "chat";
    openSwitcher = true;
  } else if (cmd === "new") {
    startIn = "chat";
    initialSession = newSession();
  } else if (cmd === "chat") {
    startIn = "chat";
  } else if (cmd !== undefined && cmd !== "home") {
    red(`unknown command "${cmd}".`);
    dim(HELP);
    process.exit(1);
  }

  if (startIn === "home" && !signedIn(cfg)) {
    red(cfg.auth ? "your sign-in has expired." : "not signed in.");
    dim("run `coen login`.");
    // Someone who has never signed in has nothing to sign in TO. Say where to get one.
    if (!cfg.auth) dim(`no account yet? ${webUrl(cfg)}/signup`);
    process.exit(1);
  }

  // Both surfaces own the screen (alternate buffer; see screen.ts) so their pane can scroll
  // while the input stays put. Ctrl+C is handled inside each surface.
  enterAltScreen();
  try {
    const app = render(
      <Root initialCfg={cfg} initialSession={initialSession} openSwitcher={openSwitcher} startIn={startIn} />,
      { exitOnCtrlC: false },
    );
    await app.waitUntilExit();
  } finally {
    leaveAltScreen();
  }
}
