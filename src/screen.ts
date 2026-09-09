import { stdout } from "node:process";

// The chat runs in the terminal's alternate screen (the buffer vim and htop use) so the
// transcript pane can scroll on its own while the status bar and input stay on the last rows.
// ?1049h/l switch buffers; ?1007h asks the terminal to send cursor keys for mouse-wheel events
// in the alternate screen (xterm "alternateScroll"; most terminals do this by default anyway),
// which is how the wheel scrolls the transcript without mouse tracking getting in the way of
// text selection. Leaving is idempotent and also hooked to process exit, so a crash or a
// process.exit() never strands the terminal in the alternate buffer.

let inAlt = false;

export function enterAltScreen(): void {
  if (inAlt) return;
  inAlt = true;
  stdout.write("\x1b[?1049h\x1b[?1007h\x1b[H");
  process.on("exit", leaveAltScreen);
}

export function leaveAltScreen(): void {
  if (!inAlt) return;
  inAlt = false;
  stdout.write("\x1b[?1007l\x1b[?1049l");
}
