#!/usr/bin/env node
// Bootstrap: pick the profile and point COEN_HOME at it BEFORE anything that reads
// ~/.coen is imported. Keep this file import-light (node builtins only) — statically
// importing config/sessions here would evaluate their path constants too early.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, rmSync, renameSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";

const VALID_PROFILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const red = (s: string) => process.stderr.write(`\x1b[31m${s}\x1b[0m\n`);
const green = (s: string) => process.stdout.write(`\x1b[32m${s}\x1b[0m\n`);

function selectProfile(name: string): void {
  if (!VALID_PROFILE.test(name)) {
    red(`Invalid agent name "${name}" — use letters, digits, _ or -.`);
    process.exit(1);
  }
  process.env.COEN_HOME = join(homedir(), ".coen", "profiles", name);
  process.env.COEN_PROFILE_NAME = name;
}

/** Plain y/N prompt (no Ink). Resolves true only on an explicit yes. */
function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    }),
  );
}

// `coen agent <name> [rest…]` selects an isolated profile, then runs the rest as usual.
// `coen agent <name> --rm` (with confirmation) or `--archive` manage the profile and exit.
if (process.argv[2] === "agent") {
  const name = process.argv[3];
  if (!name) {
    red("usage: coen agent <name> [command…]   (delete: coen agent <name> --rm | archive: --archive)");
    process.exit(1);
  }
  const rest = process.argv.slice(4);
  const wantsRm = rest.some((a) => ["--rm", "--delete", "rm", "delete"].includes(a));
  const wantsArchive = rest.some((a) => ["--archive", "archive"].includes(a));

  if (wantsRm || wantsArchive) {
    if (!VALID_PROFILE.test(name)) {
      red(`Invalid agent name "${name}".`);
      process.exit(1);
    }
    const dir = join(homedir(), ".coen", "profiles", name);
    if (!existsSync(dir)) {
      red(`no agent "${name}" found.`);
      process.exit(1);
    }

    if (wantsArchive) {
      // Non-destructive: move the profile aside so it can be restored later.
      const archiveRoot = join(homedir(), ".coen", "archive");
      mkdirSync(archiveRoot, { recursive: true });
      let dest = join(archiveRoot, name);
      if (existsSync(dest)) dest = join(archiveRoot, `${name}-${Date.now()}`);
      renameSync(dir, dest);
      green(`archived agent "${name}" → ${dest}`);
      process.stdout.write(`\x1b[2mrestore it later with:  move it back to ${dir}\x1b[0m\n`);
      process.exit(0);
    }

    // Destructive delete — always confirm (bypass with --yes/-y/--force; refuse if non-interactive).
    const force = rest.some((a) => ["--yes", "-y", "--force"].includes(a));
    if (!force) {
      if (!process.stdin.isTTY) {
        red("refusing to delete non-interactively. Re-run with --yes, or use --archive.");
        process.exit(1);
      }
      const ok = await confirm(
        `\x1b[31mPermanently delete agent "${name}"\x1b[0m and ALL its keys, sessions, and tokens?\n  ${dir}\nThis cannot be undone. [y/N] `,
      );
      if (!ok) {
        process.stdout.write("aborted.\n");
        process.exit(0);
      }
    }
    rmSync(dir, { recursive: true, force: true });
    green(`removed agent "${name}" (${dir})`);
    process.exit(0);
  }

  selectProfile(name);
  // Strip `agent <name>` so the normal command parser sees the remainder.
  process.argv.splice(2, 2);
} else if (process.env.COEN_PROFILE) {
  selectProfile(process.env.COEN_PROFILE);
}
// else: default profile → COEN_HOME unset → ~/.coen (unchanged behavior).

const { runMain } = await import("./main.js");
await runMain().catch((e: unknown) => {
  process.stderr.write(`\x1b[31m${e instanceof Error ? e.message : String(e)}\x1b[0m\n`);
  process.exit(1);
});
