import { stdout } from "node:process";
import gradient from "gradient-string";

// "coen" in the figlet "Small" font.
const WORDMARK = [
  " ___ ___  ___ _ _ ",
  "/ __/ _ \\/ -_) ' \\",
  "\\__\\___/\\___|_||_|",
];

const TAGLINE = "  \x1b[2mpersonal intelligence in your terminal — grounded in your Coen 1 context\x1b[0m";

/** The gradient wordmark as terminal rows — the chat pane shows these at the top. */
export function bannerLines(): string[] {
  const paint = gradient(["#67e8f9", "#a78bfa", "#f0abfc"]); // cyan → violet → pink
  return ["", ...WORDMARK.map((line) => "  " + paint(line)), TAGLINE, ""];
}

/** Print the wordmark once (used by the plain-console screens such as `coen login`). */
export function printBanner(): void {
  stdout.write(bannerLines().join("\n") + "\n");
}
