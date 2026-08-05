---
description: List the models available to agy (Antigravity CLI) and the plugin's default.
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" models`

Present the list verbatim, including the alias table. Remind the user that any `/agy:*` command
accepts `--model <alias>` (e.g. `--model flash-low`) and `--effort <low|medium|high>`, which
rewrites the slug's effort suffix. Canonical model ids are slugs with no spaces
(`gemini-3.1-pro-high`), so they need no quoting; the aliases are just shorthand for them.
