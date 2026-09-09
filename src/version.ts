import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** This CLI's version, read from its own package.json — one source, not a copy that goes stale.
 *  Shown by `coen daemon status` and sent with the heartbeat so the dashboard can say which
 *  version a machine is on. */
function read(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/version.js → dist → the package root.
    return (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = read();
