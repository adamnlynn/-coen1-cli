# Security

## Reporting

Email **support@adamnlynn.com**. Please do not open a public issue for a vulnerability — an issue
is world-readable the moment it is filed, and that is exactly the wrong first move.

Include what you did, what happened, and what you expected. A proof of concept helps. You do not
need to have a fix.

## What is in scope

This repository is the **client** — the `coen` command, the local tools it serves to other agents,
and the loopback daemon. The hosted service it talks to (`stack.adamnlynn.com`) is a separate,
closed codebase; findings against it are still welcome at the same address, but they are not fixed
by a pull request here.

## What this program holds on your machine

Worth knowing whether you are auditing it or just running it. Everything lives under `~/.coen`
(override with `COEN_HOME`). It talks to three kinds of place and no others: the Coen 1 API; the
model provider whose key you supplied, if you use `coen chat`; and any external MCP server you
attached yourself with `coen mcp add`. That last one is arbitrary by design — it is whatever URL or
command you gave it — so treat adding one as the trust decision it is.

| What | Where | Protection |
| --- | --- | --- |
| Your Coen 1 session (a 7-day JWT) | `~/.coen/config.json` | file `0600`, directory `0700` |
| Your own model provider key, if you store one rather than passing it by env | `~/.coen/config.json` | same file |
| The daemon's loopback token, regenerated on every start | `~/.coen/daemon/daemon.json` | file `0600` |

The daemon binds `127.0.0.1` only. Every request to it must carry that token as a Bearer header,
compared in constant time, and it rejects requests whose `Host` is not loopback so that a web page
you visit cannot reach it by resolving its own hostname to `127.0.0.1`.

Keys and tokens are masked as you type them and are redacted wherever the CLI prints configuration.

## Known limits, stated plainly

- **A session cannot be revoked once issued.** `coen logout` forgets the token on that machine, and
  that is all it does. The token is a stateless JWT: nothing on the server tracks it, so it stays
  valid until it expires — **up to seven days** — and neither signing out nor changing your password
  shortens that. If a machine holding one is lost or shared, assume the session is live for the
  remainder of its week. This is a limitation of the current design, not an oversight in this
  client, and it is the thing to know before approving a terminal on a computer you do not control.
- **`COEN_CONFIRM_WRITES=false` removes the confirmation prompt before any tool that writes to your
  record.** That is what it is for. An unattended agent running with it set can log, tick and
  archive without asking. Set it only where you have already decided to trust what is driving it.
