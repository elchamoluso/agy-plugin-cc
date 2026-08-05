---
description: List, enable or disable Google MCP servers in this project's .mcp.json.
argument-hint: '[list | add <id>... | remove <id>... | status]'
allowed-tools: Bash(node:*)
---

Manage which Google MCP servers are active **in this project**.

Raw slash-command arguments:
`$ARGUMENTS`

Run this with the Bash tool, forwarding the arguments as separate plain tokens (they are only
subcommands and server ids — no free text, so no quoting hazard). With no arguments, run `list`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/google-mcp.mjs" <subcommand> <ids...>
```

Present the output verbatim.

Why this exists: Claude Code can only enable or disable a plugin as a whole, so a plugin that
bundled every Google MCP server would force all of them on at once. A project's `.mcp.json` does
have per-server control, so this command writes there — never to the global config, always with a
`.bak` first.

Guidance when the user asks for a server:

- **Cost is the deciding factor.** `list` prints the measured tool count and schema size of each
  server. Enabling `cloudsql` alone adds ~465 KB of JSON schema to every session in this project.
  Say the number before adding something expensive.
- `add` refuses a server whose prerequisites are missing, and refuses to duplicate one already
  configured globally. Relay those refusals rather than working around them.
- Remote servers need an OAuth client attached before any call succeeds — `add` prints the
  warning. Point at `/google:setup` for that.
- After a successful `add`, tell the user to restart Claude Code and approve the new servers.
