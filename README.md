# Coen 1 CLI

**Emotional tracking for people who hate emotional tracking — in your terminal.**

[![npm](https://img.shields.io/npm/v/@coen1/cli.svg)](https://www.npmjs.com/package/@coen1/cli)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)

```bash
npm install -g @coen1/cli
coen login
echo "today was a lot" | coen
```

Needs a free [Coen 1](https://coen.one) account — `coen login` will make you one if you don't have
one yet.

That last line is a complete entry. You don't have to know how you feel — that's the whole premise.
Most trackers open with a scale of one to ten or a row of faces, and a slider can only take an answer
you already have. Not being able to locate the feeling is usually the exact reason you came. So you
write whatever you've got, in whatever words you've got, and Coen works out the rest: it names the
emotions in what you wrote, ticks the habits you mentioned, pulls out any numbers, and notices who
and what keeps coming up.

`coen` on its own opens Home — your latest read with what you wrote underneath it, today's habits,
your streak, and an input. Type, press Enter, and it goes down the same path as a check-in on the
web. Slash commands tick habits, record decisions, log realizations, save reminders, and show your
journal, the last week's read, your decisions and your reminders.

There's a chat too (`/chat`, or `coen chat`) — a model-agnostic agent that reads your record using
your own pay-per-token API key. And Coen's tools are the CLI's own: it serves them to any other
agent on this machine over MCP, so Claude Code, Claude Desktop and the Gemini CLI can reach your
record without a key of their own.

Built as an [Ink](https://github.com/vadimdemedes/ink) TUI that owns the screen the way vim does —
the pane scrolls on its own while the status line and input stay pinned to the bottom. Your normal
terminal comes back when you leave.

---

## You need a Coen 1 account

**`coen` is a client for [Coen 1](https://coen.one), a hosted service. It does nothing without an
account.** Sign up at **<https://coen.one>** — or just run `coen login`, which offers to make you one
in the browser and brings you straight back to the terminal.

**It's free.** The free plan keeps your last 30 days and is not a trial — it doesn't run out.
Paying keeps your whole record instead of the last month, and that is the only difference: every
feature is on both plans.

This repository is the **client only** — the terminal app, its local tools, and the daemon that
serves them to other agents. The service it talks to is a separate, closed codebase. That's worth
knowing before you clone: you can read, audit, fork and patch everything `coen` does on your
machine, but you cannot self-host the thing it connects to.

## Requirements

- **Node 22 or newer.** Check with `node --version`.
- A Coen 1 account — free, at <https://coen.one>.
- For `coen chat` only: your own API key for Google, Anthropic or OpenAI. Home, habits, the journal
  and the MCP tools need no model key at all.
- On Linux, `xdg-open` for the browser sign-in. Without it, use `coen login --password`.

## Install

**Already have Node 22+?** One line, same on every platform:

```bash
npm install -g @coen1/cli
```

**Don't have Node, or would rather not think about it?** These do the whole thing — no `sudo`, no
administrator, nothing written outside your own home directory:

```bash
# macOS and Linux
curl -fsSL https://raw.githubusercontent.com/adamnlynn/-coen1-cli/main/install.sh | sh
```

```powershell
# Windows
irm https://raw.githubusercontent.com/adamnlynn/-coen1-cli/main/install.ps1 | iex
```

Each installer uses the Node you already have if it's new enough. If it isn't, it downloads an
official build from nodejs.org into its own directory, **verifies its SHA-256 against the checksums
nodejs.org publishes**, and uses that — your system Node is never touched or upgraded. The package
itself comes from npm into a private prefix, and a `coen` launcher goes on your PATH.

| | macOS / Linux | Windows |
| --- | --- | --- |
| Package and private Node | `~/.local/share/coen` | `%LOCALAPPDATA%\coen` |
| Launcher | `~/.local/bin/coen` | `%LOCALAPPDATA%\coen\bin\coen.cmd` |
| Uninstall | `rm -rf ~/.local/share/coen ~/.local/bin/coen` | `Remove-Item -Recurse "$env:LOCALAPPDATA\coen"` |

Pin a version with `COEN_VERSION=0.1.0`; move the target with `COEN_INSTALL_DIR`.

**Read them before you run them.** [install.sh](install.sh) and [install.ps1](install.ps1) are in
this repo, and piping a script into your shell is something you should be able to check first.
Nothing they install is opaque either: the package is on npm, its contents are the `dist/` built
from the `src/` here, and `npm pack` reproduces it.

<details>
<summary>From source (for contributors)</summary>

```bash
git clone https://github.com/adamnlynn/-coen1-cli.git
cd -coen1-cli
npm install
npm run build
npm link          # puts `coen` on your PATH from this checkout
```

`npm run dev` runs it from TypeScript without building. `npm run typecheck` is the fast check.
</details>

## Sign in

```bash
coen login      # opens your browser — approve there, and the terminal is signed in
coen            # Home
```

`coen login` starts a listener on a loopback port, opens `/connect/cli` on the web app with a PKCE
challenge, and waits. Approving on that page hands a one-time code back to the listener, and the CLI
redeems it for the same seven-day session the web app has. **The token never travels in a URL** —
only the one-time code does, and only the holder of the verifier can redeem it.

On a box with no browser, `coen login --password` (or pressing `p` while it waits) asks for your
email and password instead.

That is all Home needs. The token renews itself while you keep using it, and `coen logout` forgets it
on that machine — though it cannot end the session early; see [SECURITY.md](SECURITY.md).

Point it at a local stack with `COEN_WEB_URL=http://localhost:3100` (or
`coen config set-web http://localhost:3100`); the default is production.

## Check in from a pipe

No screen, no TTY needed — the same route as the Home input, so it lands in your journal, feeds
the read and counts for the streak:

```bash
echo "the day got away from me" | coen
coen pulse "shipped the thing"
cat notes.md | coen pulse --wait      # holds until the read lands, then prints what came through
```

## Home

Everything on the first screen — greeting and streak, the latest read with what you wrote, the past
week day by day with how many of the seven days had a read, today's habits — comes from one request
(`GET /api/cli/home`). Anything you type
that does not start with `/` is a check-in (`POST /api/cli/thought-dump`). Coen reads it in the
background: the top bar shows "reading your check-in" while it does, the input stays free for
anything else, and when the read lands, usually within ten seconds, the terminal bell rings, the
top bar flashes "read is in" and the screen repaints. To hear about it outside the terminal, put a
command in `~/.coen/config.json`:

```json
{ "hooks": { "onRead": "notify-send Coen \"$COEN_SUMMARY\"" } }
```

It runs with `COEN_EVENT` (`read` or `read_failed`), `COEN_EXTRACTION_ID` and `COEN_SUMMARY` (the
strongest markers, in words) in its environment.

A check-in does not only get read. The same pass scans it against your habits' keywords and ticks
the ones it matched, on a slower queue — so those ticks land a few seconds behind the read. The
screen keeps watching for them, redraws an open habits tab in place, and says what your words did:

```
· the read is in — Focused
· ✓ that ticked 3 habits: Read ✓ · Walk the dog ✓ · Water 5/8 glasses
```

Nothing is said when a check-in ticked nothing, which is most of them. `coen pulse --wait` prints
the same line.

End a line with `\` to keep writing on the next one; Enter on its own sends.

| Command | What it does |
| --- | --- |
| `/habit` | habits are numbered on the screen: `/habit 2` ticks the second, `/habit 2 undo` unticks it, `/habit` alone opens a picker. A name works too. A habit that asks a question asks it here — the answer is the completion, kept as a journal entry — and one that asks for numbers asks for those, with its own units and bounds. |
| `/habits` | every habit with its schedule, target and streak, grouped |
| `/habit add` | add one: name, kind (yes/no, a number to reach each day, a question, or a clock), which days, and — behind one "anything else?" — group, what it is for, and the words that tick it. `/newhabit` still works. |
| `/habit edit` | change one thing about a habit: its name, what it is for, its group, the target, when it is due, the words that tick it, the question it asks, or the clock. Each prompt opens on the current value. `/habit edit 2`, or `/habit edit` to pick. Changing the schedule re-scores the whole history, so a streak can change. |
| `/habit remove` | archive a habit — it leaves the list and its history stays. A routine takes its steps with it. `/habit add` with the same name brings it back with that history intact. Asks first. |
| `/timer` | the clock: `pause`, `resume`, `done`, `discard`, `log <minutes>`. Ticking a timed habit starts it; finishing logs the minutes actually run and asks how it went — write something and it offers to keep it as a journal entry. A session started on the phone shows here, and vice versa: the clock lives on the server. With more than one running they are numbered on Home — `/timer done 2` — and a bare `/timer done` asks which rather than guessing. |
| `/decision` | title, kind, what was decided, why |
| `/insight` | a realization: a few words, then the substance |
| `/reminder` | a line to be reminded of, optionally who said it |
| `/journal [YYYY-MM-DD]` | recent entries, or one day's — oldest at the top, newest at the bottom, each with what came through in it |
| `/reports [YYYY-MM-DD]` | the daily reports Coen writes about your days: a numbered list, newest at the bottom. `/reports 3` opens the third line in full — what was finished, what moved, what was decided, and what it concluded. A date opens that day directly. |
| `/signals` | your signals week by week: every day of the week with its strongest markers. `←` and `→` (with the input empty) page to older and newer weeks, or `/signals last`, `/signals next`, `/signals 3` for three weeks ago. `/signals YYYY-MM-DD` lists that day's check-ins; `/signals latest` is the last read in full. |
| `/read` | the last seven days: what was lifting and what was weighing, above the neutral band only |
| `/decisions` · `/reminders` · `/realizations` | the lists |

Home picks up where you left it. Ctrl+C (or `/exit`) writes the open tabs, the one you were on,
where you had scrolled and any unsent check-in to `~/.coen/home-state.json`, and the next `coen`
restores them — tabs are reopened by re-running their commands, so the data is current rather than
a snapshot of last time. `/fresh` closes everything and starts clean next run; state older than a
week is ignored.

Each of those opens as a **tab**. The top bar shows the open tabs with the active one lit. **Chat is the last tab**, so `Tab` walks Home → your open views → chat and round again. `Shift+Tab`
goes the other way, `Esc` (or `/close`) closes the active view, `/home` jumps to Home. Running a command whose tab is already open refreshes and focuses it. Lists run oldest to
newest so the latest is at the bottom. Typing a check-in from any tab sends it and returns to
Home, where the read will appear.
| `/refresh` | reload the screen |
| `/chat` | open the chat (`/home` comes back) |
| `/theme` · `/config` · `/help` · `/exit` | |

The lifting / weighing split and the intensity words are the dashboard's own: the marker lists
are generated into `src/marker-valence.generated.ts` from the same taxonomy as the web, mobile and
API copies (`npm run markers:sync` at the repo root — never edit that file by hand).

## Chat

```bash
coen chat            # resume your last chat session
coen new             # a fresh one
coen --resume [id]   # the latest, or a specific one
coen sessions        # the switcher
```

Or `/chat` from Home. The first time, it asks for a model key. That is all it asks for.

**1. Your sign-in is the only credential.** Coen's tools run in this process and read your record
over the same `/api` routes the dashboard uses, with the token `coen login` gave you. There is no
agent key to mint, paste or revoke — signing out cuts every one of them off at once.

`/tools` turns any tool off for the chat and remembers it.

**2. A model.** Set **one** provider key (auto-detected):

```bash
export GOOGLE_GENERATIVE_AI_API_KEY=...   # default provider; default model gemini-3.8-flash
export ANTHROPIC_API_KEY=...              # or
export OPENAI_API_KEY=...                 # or
```

If your Gemini key was minted on **Vertex AI Express** (same as the Coen 1 backend), point the
CLI at that endpoint: `COEN_GOOGLE_BASE_URL=https://aiplatform.googleapis.com/v1` (or
`"googleBaseUrl"` in `~/.coen/config.json`).

Resolution order at startup: **env var → `~/.coen/config.json` → built-in default.** Keys are
written to `~/.coen/config.json` (auto-created, `0600`).

## What it knows

On connect the CLI itself calls `whoami` (who it is on this connection) and `get_life_snapshot`
(where you are right now). Both are folded into the system prompt, so the first reply is already
grounded. Those two tools are then withheld from the model — their output is already in front of
it and their schemas would cost tokens on every step. The snapshot
is dated and cached on the session; it is re-taken when it's more than six hours old, or whenever
you run `/snapshot`.

What the model fetched during a turn (tool calls and results) stays in the history for the next
two turns, so a follow-up like "and the day before?" doesn't re-run the same tool. Older turns
collapse to the assistant's text only.

Read tools behind the snapshot (each mirrors what the dashboard shows):

| Tool | What it returns |
| --- | --- |
| `get_emotional_read` | per day: what was lifting / weighing / worth noticing, above the neutral band only |
| `get_habits` | every habit with today's state + streak; `key` for one habit's history and its definition — target, schedule, the question it asks, and the keywords that auto-tick it |
| `get_metrics` | the numbers you track that aren't habits, with a recent series |
| `get_journal_entries` | your own words, newest first, or everything from one day |
| `get_life_model` | the people and things you write about; inferred vs confirmed |
| `get_stated_links` | patterns you stated yourself, in your own words |
| `get_decisions` / `get_realizations` / `get_reminders` | in full |
| `get_latest_activity_reports` | the daily activity reports |
| `get_recent_session_summaries` | what you worked on in earlier sessions |

Write tools (each asks you to confirm before it runs): `log_daily_pulse`, `log_habit_tick`,
`log_metric_value`, `log_decision`, `log_insight`, `add_reminder`, `confirm_life_model_entity`,
`add_to_my_world`, `log_session_summary`, and the three that manage a habit rather than a day —
`create_habit`, `update_habit`, `archive_habit`.

Archiving is not deleting: the ticks are kept, and `create_habit` with the same name brings the
habit back with its history intact. That is the only way back, so it is what the tool says.

> Every tool is always there — there is no allow-list any more. If the snapshot doesn't load,
> check `coen config`: it is almost always an expired sign-in.

The status bar's `ctx` figure is the size of the window sent with each step of the next turn
(the last step's input tokens). `tok` is the running total across the session, which counts
every tool step. `/tokens` shows both, plus how much of the last reply the provider served
from its prefix cache.

`/usage` adds the money: this session's estimated spend, the price per 1M tokens of the model in
use (cached input billed at the provider's cached rate), and a total across every saved session.
Cost is accumulated turn by turn at the model that ran the turn, so switching models mid-session
is priced correctly. Prices come from `src/pricing.ts`, the same numbers as the Coen 1 backend's
cost table; add or override a model with `"pricing"` in `~/.coen/config.json`:

```json
{ "pricing": { "gemini-4-flash": { "input": 1.0, "output": 5.0, "cachedInput": 0.25 } } }
```

(USD per 1M tokens.) A model with no price on file still counts tokens; `/usage` says so.

## Coen's tools, for your other agents

The tools the chat uses are not the chat's — they are the CLI's, and it will serve them to
anything else on this machine. Claude Code, Claude Desktop and the Gemini CLI then read and write
your record with no credential of their own: the CLI is already signed in as you, and the calls
go from your machine to the same `/api` routes the dashboard uses.

Both ways go through the **daemon**, which is the one process that serves Coen's tools on this
machine. Start it first:

```bash
coen daemon start
```

**stdio — for an agent that spawns a subprocess.**

```bash
coen mcp install claude-code       # writes the entry into ~/.claude.json
coen mcp install claude-desktop    # claude_desktop_config.json, wherever your OS keeps it
coen mcp install gemini-cli        # ~/.gemini/settings.json
coen mcp install antigravity       # ~/.gemini/config/mcp_config.json, via `agy mcp add`
coen mcp install claude-code --print   # show it instead of writing it
```

Each of those adds one server, `coen`, which runs `coen mcp serve`. That command **serves
nothing itself** — it carries JSON-RPC frames between the agent and the daemon, and exits with the
agent. Restart the tool to pick it up.

No token goes into any of those files. `coen mcp serve` reads the daemon's loopback token off
disk itself, so the entry keeps working across a restart even though the token changes each time.

Antigravity needs a second, separate yes: it gates MCP tools behind its own permission system, so
the first Coen tool call prompts inside `agy`. Headless runs (`agy -p`) can't prompt and will tell
you which allow-rule to add. `coen mcp install` deliberately doesn't add it for you — it would
pre-approve the write tools for every unattended run.

That indirection is the point. It used to build its own copy of the tools, which meant
`coen daemon stop` was not an off switch: every stdio child an agent had already spawned carried
on reading and writing your record until that agent happened to close it. Now there is one process
holding your record open and stopping it stops everything at once. A daemon **restart** is
invisible — the bridge notices the new port and token and carries on — but with the daemon down,
an agent gets a plain "the coen daemon has stopped" rather than quietly working.

**HTTP — for an agent that wants the address directly.** The daemon serves the same tools on
`127.0.0.1:7717/mcp`.

```bash
coen daemon start        # start it, and start it at login
coen daemon status       # running? which port? signed in as who? connected to what?
coen daemon logs -f
coen daemon stop         # stop it, and stop it starting at login — every agent loses Coen
```

`coen mcp url` prints the endpoint and the bearer token it requires. Three things guard it: it
binds loopback only, every request must carry that token (regenerated at every start, kept in a
`0600` file, never sent to the server), and DNS-rebinding protection stops a web page you visit
from posting to it.

`--no-autostart` on `start` and `--keep-autostart` on `stop` split those two halves when you want
them split. The login entry is a **systemd user unit** on Linux (`loginctl enable-linger` if you
want it up while logged out), a **Run key** pointing at a hidden VBScript shim on Windows, and a
**LaunchAgent** on macOS — all per-user, none needing administrator.

**What else the daemon does while it is up.** It keeps your seven-day sign-in refreshed, so an
agent attached to it does not break after a quiet week. It watches for a check-in's read landing —
from anywhere, including your phone — and runs the `onRead` hook, which until now only fired while
Home was open on screen. It can nudge you at a set time. And it tells the web app this machine is
here, which is what **Settings → Connections** shows.

```json
{
  "hooks": {
    "onRead": "notify-send \"Coen\" \"$COEN_SUMMARY\"",
    "onNudge": "notify-send \"Coen\" \"$COEN_HABITS_LEFT_COUNT habits left · $COEN_REMINDER\""
  },
  "daemon": { "nudgeAt": "17:30" }
}
```

Each profile (`coen agent <name>`) gets its own daemon, its own login entry and its own port.

## Your record as files

```bash
coen sync ~/journal        # mirror the record into that folder, and keep it there
coen sync                  # one pass now
coen sync --all            # the whole history, not just the last few months
coen sync --status
coen sync --off            # stop (the files stay)
```

Everything Coen knows, as markdown on your disk: `journal/`, `habits/`, `decisions/`,
`insights/`, `reminders.md`, `reports/`, `reads/`, `metrics/`, `life-model.md`, `your-words.md`,
`profile.md`. Grep it, open it in an editor, back it up.

**The files are read-only** (0444), because they are a copy. A mirror you can edit is one that
quietly disagrees with the record. If you edit one anyway, the next pass copies your version into
`.coen-sync/edited/` before putting the record's back — it will not eat what you wrote.

**`new/` is the exception.** Write a markdown file in there and the next pass checks it in, the
same as `coen pulse` or typing into Home:

```bash
nano ~/journal/new/tuesday.md      # save it, and that is a check-in
```

The mirror copy is written before the original is deleted, so there is no moment where the only
copy is in flight. If the check-in fails, nothing is deleted — a `.error` file appears beside it
saying why, and the next pass tries again. One file is one check-in; there is no format to learn.

A pass only writes what changed. The first one covers 90 days (`sync.windowDays`); `--all`
backfills the rest, and a later windowed pass leaves that history alone rather than pruning it.

The daemon runs a pass every 15 minutes (`sync.intervalMinutes`) and looks in `new/` every ten
seconds. Without it, `coen sync` still works — it just only happens when you type it.

### In git

```bash
coen git-sync on                 # commit every pass that changes something
coen git-sync --remote <url>     # set origin and push on a timer — asks first
coen git-sync push               # push now
coen git-sync --off
```

It refuses to `git init` inside a repository that already exists, so pointing it at a folder in
one of your projects can't quietly commit your record into that project's history. Nothing is
pushed until you set a remote, and setting one prints what is about to leave the machine and asks.

Two things worth knowing. This folder is **your copy, outside the account** — erasing your record
on the server does not reach it. And git does not record the read-only bit, so anywhere the
repository is cloned, these files will be writable.

Each profile (`coen agent <name>`) syncs its own folder.

## Sessions

Every conversation is **auto-saved** to `~/.coen/sessions/<id>.json` after each turn (titles are
summarized by the model, with a first-message fallback).

```bash
coen --resume        # reopen the most recent session
coen --resume <id>   # reopen a specific session
coen sessions        # open the switcher to pick one (or start new)
```

**Live switch:** inside the chat press **Ctrl+O** (or type `/switch`) to jump to another session
and come straight back. Each session keeps its own history, orientation and snapshot.

Each session has **one summary**, kept in its own file. It is written in plain prose and kept
current: the first `/summarize`
summarizes the transcript; every later one rewrites the stored summary with only the turns since,
so nothing is repeated and finished threads read as done. `/compact` does the same **and** trims
the in-context messages down to that summary, so a long session stops costing full tokens.
`/exit` and **Ctrl+C** update the summary too, if there are new turns (a second Ctrl+C skips it
and leaves at once). A session whose title is still its first line gets a real title from the
summary.

**Sessions never leave this machine.** They used to be two things: the whole transcript here, and
a summary in the dashboard that a bin icon could delete. The dashboard copy is gone, so the
tidying lives where the sessions do:

```bash
coen sessions list            # every session, newest first
coen sessions show <id>       # one session's summary
coen sessions prune --days 90 # archive anything untouched that long
coen sessions rm <id>         # archive one
```

Nothing is destroyed. Archived sessions move to `~/.coen/sessions/archive/` — they drop out of
`/sessions`, `/switch` and resume-on-launch, and come back if you move the file out again.

The input box stays on the bottom rows while a reply streams above it. A line typed then is
queued and sent as soon as the reply finishes.

**Scrolling:** the mouse wheel, ↑/↓ and PgUp/PgDn scroll the transcript (with the command menu
closed). Scroll to the bottom and the pane follows new output again; sending a message also jumps
to the bottom. The wheel works because terminals send arrow keys for it in the alternate screen
(xterm's "alternateScroll", on by default in most terminals). The terminal's own scrollback isn't
used during a chat.

## Chat commands

- `/home` — back to Home (when the chat was opened from it)
- `/snapshot` — take a fresh life snapshot (cheap; mid-session)
- `/reground` — reload everything: agent context + snapshot
- `/summarize` — bring this session's summary in Coen 1 up to date (keeps full context)
- `/compact` — same, **and** trim local context to the summary
- `/switch` — open the live session switcher (same as Ctrl+O)
- `/new` — start a fresh session (the current one stays saved)
- `/sessions` — list recent saved sessions
- `/rename <title>` · `/archive` — manage the current session
- `/tools` — enable/disable tools for the model (per agent; handy with big external servers)
- `/mcp add|login|remove|list` — attach external MCP servers (OAuth or token)
- `/model` — switch provider/model live (`/model <id>` sets directly)
- `/theme` — change theme (syncs to the dashboard)
- `/usage` — tokens, estimated cost and the model's price, for this session and all saved ones (`/tokens` still works)
- `/config` · `/help` · `/exit`

Named agents with their own keys, servers and sessions: `coen agent <name>`; list with `coen agents`.

## Config

| Env var | Purpose |
| --- | --- |
| `COEN_WEB_URL` | the web app Home signs in to (default `https://stack.adamnlynn.com`) |
| `COEN_HOME` | where config, sessions and the daemon state live (default `~/.coen`) |
| `COEN_PROFILE` | a second, separate account on the same machine |
| `COEN_DAEMON_PORT` | the daemon's loopback port (default 7717; `0` takes whatever is free) |
| `GOOGLE_GENERATIVE_AI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | provider key (set one) |
| `COEN_GOOGLE_BASE_URL` | Gemini endpoint override (Vertex AI Express) |
| `COEN_PROVIDER` | force `google` \| `anthropic` \| `openai` |
| `COEN_MODEL` | override the default model |
| `COEN_CONFIRM_WRITES` | `0` to run write tools without the confirm prompt (default: ask) |
| `COEN_GEMINI_THINKING` | Gemini 3.x thinking level: `minimal`, `low` (default), `medium`, `high` |
| `COEN_REPLY_TIMEOUT_MS` | give up on a silent model call after this long (default 180000) |

Defaults: `gemini-3.8-flash`, `claude-haiku-4-5`, `gpt-4o-mini`. The Google default is an agent
model built for long tool-using sessions — thought signatures are carried through the tool loop and
thinking defaults to `low`. If a reply ever comes back empty with a lot of tools connected, switch
with `/model` or trim the set with `/tools`.

---

## Where your data lives

Everything the CLI keeps is under `~/.coen` (override with `COEN_HOME`):

| What | Where |
| --- | --- |
| Your sign-in, and any model key you chose to store | `~/.coen/config.json` — file `0600`, directory `0700` |
| The daemon's loopback token, regenerated every start | `~/.coen/daemon/daemon.json` — `0600` |
| Chat transcripts | `~/.coen/sessions` — `coen sessions list \| show \| prune` |

It talks to three kinds of place and no others: the Coen 1 API, the model provider whose key you
supplied (only during `coen chat`), and any external MCP server you attached yourself with
`coen mcp add`. There is no telemetry and no analytics.

## Security

Please don't file a public issue for a vulnerability — email **support@adamnlynn.com** instead.
[SECURITY.md](SECURITY.md) has the details, including what's on your disk and the known limits of
the current session model.

## Contributing

Issues and pull requests are welcome on the client. Worth knowing first:

- **The server is not in this repo.** A change that needs an API endpoint to move can't be finished
  here, but it's still worth opening an issue — say what you were trying to do.
- **Comments sometimes cite paths like `coen1-web/src/lib/habits.ts` or `coen1-brain/ai/…`.** Those
  are components of the hosted service, which is closed — you can't open them. They are there to say
  *where a rule actually lives*, so that when this client mirrors a server behaviour you know the
  copy is deliberate and where the original is. Treat them as provenance, not as broken links.
- **`src/marker-valence.generated.ts` is generated.** Edits to it are overwritten. It's synced from
  the hosted service's emotional taxonomy.
- **Run `npm run typecheck` before opening a PR.** The build is `npm run clean && tsc`; `dist/` is
  never committed.
- Match the surrounding code. Comments here explain *why* something is the way it is, not what the
  line does — that convention is deliberate, and it's the thing most worth keeping.

## License

MIT — see [LICENSE](LICENSE). Copyright © 2026 Adam & Lynn Incorporated.

Coen 1™ is a trademark of Adam & Lynn Incorporated. The MIT licence covers this client's source; it
is not a licence to the hosted service or the brand.
