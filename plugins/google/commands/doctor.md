---
description: Diagnose the Google plugins — toolchain, gcloud credentials, gws login and MCP reachability.
argument-hint: '[--offline]'
allowed-tools: Bash(node:*)
---

Run this with the Bash tool and present the output to the user:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/google-doctor.mjs"
```

Pass `--offline` if the user asks to skip the network probes (they take a few seconds and
contact Google's remote MCP endpoints).

The check is entirely read-only — it logs nothing in, installs nothing and writes nothing.

Reading the output:

- `✓` fine, `!` partial, `✗` missing.
- **`REACHABLE, NOT AUTHORISED` is the line that matters most.** Google's remote MCP endpoints
  answer `initialize` and `tools/list` without any credentials, so a server can look perfectly
  connected while every real call 401s — and it still costs its full tool schema in the context
  window of every session it is enabled in. Do not read it as healthy.
- Missing pieces are fixable with `/google:setup`; a scope mismatch with `/google:scopes`.

Summarise what is broken and what it blocks, then offer to run `/google:setup`. Do not run
setup on your own — it installs packages and opens browser logins.
