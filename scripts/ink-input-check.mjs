// Does Ink keyboard input work in THIS terminal?
//
// Run directly:  node scripts/ink-input-check.mjs
//
// If "keysSeen" climbs and text appears as you type, input works and a bug is ours. If it does
// not, the terminal is the problem — Git Bash/mintty on Windows is the usual culprit, and the
// answer there is Windows Terminal or PowerShell. Worth asking anyone reporting "the CLI won't
// take my typing" to run this first; it needs no sign-in and touches nothing.
//
// Ctrl+C to quit.
import React, { useState } from "react";
import { render, Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

const e = React.createElement;

function App() {
  const [value, setValue] = useState("");
  const [keys, setKeys] = useState(0);
  const [last, setLast] = useState("");
  useInput((input, key) => {
    setKeys((k) => k + 1);
    setLast(JSON.stringify({ input, ...key }).slice(0, 60));
  });
  return e(
    Box,
    { flexDirection: "column" },
    e(Text, { color: "magenta" }, "Ink input test — type something. Ctrl+C to quit."),
    e(Text, { dimColor: true }, `isTTY=${process.stdin.isTTY} keysSeen=${keys} last=${last}`),
    e(
      Box,
      null,
      e(Text, { color: "cyan" }, "> "),
      e(TextInput, { value, onChange: setValue, placeholder: "type here…" })
    )
  );
}

render(e(App));
