---
description: List the models available to agy (Antigravity CLI) and the plugin's default.
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" models`

Present the list verbatim, including the alias table. Remind the user that any `/agy:*` command
accepts `--model <alias>` (e.g. `--model flash-low`); full model names contain spaces and only
survive single-quoted (`--model 'Gemini 3.1 Pro (High)'`) — never double-quoted.
