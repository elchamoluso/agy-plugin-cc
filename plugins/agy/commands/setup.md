---
description: Check that the agy CLI is installed and authenticated, and run a smoke test.
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup`

Present the full output to the user.

If the check reports the binary as missing, explain that the Antigravity CLI must be installed separately (it is Google's agent CLI; this plugin only wraps an existing installation) and that it usually lives at `~/.local/bin/agy`.

If the check reports authentication problems, tell the user to open a separate terminal (outside Claude Code — agy's login needs a real TTY that the `!` bash-mode cannot provide), run `agy` once, complete the Google login, and then re-run `/agy:setup`. On macOS you can open that terminal for them with `open -a Terminal "$(command -v agy)"`.

Note: the "Auth token file" line is informational — on macOS agy stores auth state outside that file, so "not found" there is normal; only the smoke test result decides whether auth works.
