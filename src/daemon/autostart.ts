import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ACTIVE_PROFILE, CONFIG_DIR } from "../config.js";
import { DAEMON_DIR, ensureDaemonDir, daemonLabel } from "./state.js";

/**
 * Starting the daemon when you log in.
 *
 * Per-user on every platform, and no administrator anywhere: a Windows service or a systemd
 * system unit would both need elevation, and neither buys anything — the daemon acts as one
 * person, with that person's sign-in, and has nothing to do before they log in.
 *
 * Each platform gets `enable`, `disable`, `isEnabled` and `describe` behind one interface, so
 * `coen daemon start` and `coen daemon stop` say the same thing everywhere.
 */

export interface Autostart {
  /** Where the entry lives, for `coen daemon status` to name. */
  describe(): string;
  isEnabled(): boolean;
  /** Returns a note to show the person, or null. Throws only if it genuinely could not write. */
  enable(): string | null;
  disable(): void;
}

/** The daemon's own entry point: this node, this dist/index.js, `daemon run`. */
export function daemonCommand(): { exe: string; args: string[] } {
  const entry = join(dirname(dirname(fileURLToPath(import.meta.url))), "index.js");
  return { exe: process.execPath, args: [entry, "daemon", "run"] };
}

/** A named profile's daemon needs COEN_PROFILE set, or it would start the default one. */
const profileEnv = (): Record<string, string> =>
  ACTIVE_PROFILE === "default" ? {} : { COEN_PROFILE: ACTIVE_PROFILE };

const run = (cmd: string, args: string[]): string =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const tryRun = (cmd: string, args: string[]): boolean => {
  try {
    run(cmd, args);
    return true;
  } catch {
    return false;
  }
};

// ── Linux: a systemd user unit, or an XDG autostart entry where there is no systemd ─────────

const systemdUnitPath = () => join(homedir(), ".config", "systemd", "user", `${daemonLabel()}.service`);
const desktopPath = () => join(homedir(), ".config", "autostart", `${daemonLabel()}.desktop`);

const hasSystemd = (): boolean => {
  try {
    run("systemctl", ["--user", "--version"]);
    return true;
  } catch {
    return false;
  }
};

const linux: Autostart = {
  describe: () => (hasSystemd() ? systemdUnitPath() : desktopPath()),
  isEnabled() {
    if (hasSystemd()) {
      try {
        return run("systemctl", ["--user", "is-enabled", daemonLabel()]).trim() === "enabled";
      } catch {
        return false;
      }
    }
    return existsSync(desktopPath());
  },
  enable() {
    const { exe, args } = daemonCommand();
    const env = Object.entries(profileEnv())
      .map(([k, v]) => `Environment=${k}=${v}\n`)
      .join("");
    if (hasSystemd()) {
      const unit =
        "[Unit]\n" +
        `Description=Coen 1 — local MCP endpoint and background watch (${ACTIVE_PROFILE})\n` +
        "After=network-online.target\n\n" +
        "[Service]\n" +
        "Type=simple\n" +
        `ExecStart=${exe} ${args.join(" ")}\n` +
        env +
        // The daemon is a client of a web app; a network blip should not end it.
        "Restart=on-failure\nRestartSec=10\n\n" +
        "[Install]\nWantedBy=default.target\n";
      const path = systemdUnitPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, unit);
      run("systemctl", ["--user", "daemon-reload"]);
      run("systemctl", ["--user", "enable", daemonLabel()]);
      // Lingering is a system-level change (it lets the unit run with nobody logged in), so it
      // is the person's to make, not ours.
      return `enabled ${daemonLabel()}.service.\nTo keep it running when you are logged out:  loginctl enable-linger ${process.env.USER ?? "$USER"}`;
    }
    const path = desktopPath();
    mkdirSync(dirname(path), { recursive: true });
    const envPrefix = Object.entries(profileEnv())
      .map(([k, v]) => `${k}=${v} `)
      .join("");
    writeFileSync(
      path,
      "[Desktop Entry]\nType=Application\n" +
        `Name=Coen 1 daemon (${ACTIVE_PROFILE})\n` +
        `Exec=env ${envPrefix}${exe} ${args.join(" ")}\n` +
        "X-GNOME-Autostart-enabled=true\nNoDisplay=true\nTerminal=false\n",
    );
    return "no systemd here, so it starts with your desktop session instead.";
  },
  disable() {
    if (hasSystemd()) {
      tryRun("systemctl", ["--user", "disable", daemonLabel()]);
      rmSync(systemdUnitPath(), { force: true });
      tryRun("systemctl", ["--user", "daemon-reload"]);
    }
    rmSync(desktopPath(), { force: true });
  },
};

// ── Windows: a Run key entry pointing at a VBScript shim ────────────────────────────────────
//
// The shim is not decoration. A Run key entry that names node.exe pops a console window at every
// logon and leaves it there; WScript.Shell.Run with a window style of 0 starts it with no window
// at all. A Scheduled Task could hide it too, but needs an XML definition and, for some options,
// elevation — the Run key is per-user, needs nothing, and is removed with one command.

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const runValueName = () => (ACTIVE_PROFILE === "default" ? "CoenDaemon" : `CoenDaemon-${ACTIVE_PROFILE}`);
const vbsPath = () => join(DAEMON_DIR, "coen-daemon.vbs");

const windows: Autostart = {
  describe: () => `${RUN_KEY}\\${runValueName()}  →  ${vbsPath()}`,
  isEnabled() {
    try {
      run("reg", ["query", RUN_KEY, "/v", runValueName()]);
      return true;
    } catch {
      return false;
    }
  },
  enable() {
    const { exe, args } = daemonCommand();
    ensureDaemonDir();
    const q = (s: string) => `""${s}""`; // a quote inside a VBScript string literal
    const env = Object.entries(profileEnv())
      .map(([k, v]) => `sh.Environment("PROCESS")("${k}") = "${v}"\n`)
      .join("");
    writeFileSync(
      vbsPath(),
      "' Starts the Coen 1 daemon with no console window. Written by `coen daemon start`.\n" +
        'Set sh = CreateObject("WScript.Shell")\n' +
        env +
        `sh.Run "${q(exe)} ${args.map(q).join(" ")}", 0, False\n`,
    );
    run("reg", [
      "add",
      RUN_KEY,
      "/v",
      runValueName(),
      "/t",
      "REG_SZ",
      "/d",
      `wscript.exe //nologo "${vbsPath()}"`,
      "/f",
    ]);
    return null;
  },
  disable() {
    tryRun("reg", ["delete", RUN_KEY, "/v", runValueName(), "/f"]);
    rmSync(vbsPath(), { force: true });
  },
};

// ── macOS: a LaunchAgent ────────────────────────────────────────────────────────────────────

const plistLabel = () => (ACTIVE_PROFILE === "default" ? "com.coen.daemon" : `com.coen.daemon.${ACTIVE_PROFILE}`);
const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${plistLabel()}.plist`);

const macos: Autostart = {
  describe: plistPath,
  isEnabled: () => existsSync(plistPath()),
  enable() {
    const { exe, args } = daemonCommand();
    const env = Object.entries(profileEnv());
    const path = plistPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
        '<plist version="1.0">\n<dict>\n' +
        `  <key>Label</key><string>${plistLabel()}</string>\n` +
        "  <key>ProgramArguments</key>\n  <array>\n" +
        [exe, ...args].map((a) => `    <string>${a}</string>\n`).join("") +
        "  </array>\n" +
        (env.length
          ? "  <key>EnvironmentVariables</key>\n  <dict>\n" +
            env.map(([k, v]) => `    <key>${k}</key><string>${v}</string>\n`).join("") +
            "  </dict>\n"
          : "") +
        "  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><false/>\n" +
        `  <key>StandardOutPath</key><string>${join(CONFIG_DIR, "daemon", "daemon.log")}</string>\n` +
        `  <key>StandardErrorPath</key><string>${join(CONFIG_DIR, "daemon", "daemon.log")}</string>\n` +
        "</dict>\n</plist>\n",
    );
    tryRun("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, path]);
    return null;
  },
  disable() {
    tryRun("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${plistLabel()}`]);
    rmSync(plistPath(), { force: true });
  },
};

// ── nothing we know how to do ───────────────────────────────────────────────────────────────

const unsupported: Autostart = {
  describe: () => `not supported on ${platform()}`,
  isEnabled: () => false,
  enable() {
    throw new Error(
      `coen doesn't know how to start something at login on ${platform()}. ` +
        "Run `coen daemon run` from whatever your system uses.",
    );
  },
  disable() {
    /* nothing to remove */
  },
};

export function autostart(): Autostart {
  switch (platform()) {
    case "linux":
      return linux;
    case "win32":
      return windows;
    case "darwin":
      return macos;
    default:
      return unsupported;
  }
}
