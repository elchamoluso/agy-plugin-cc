---
description: Bootstrap everything the Google plugins need — toolchain, ADC scopes, gws login, OAuth client.
argument-hint: '[--only <toolchain|adc|gws|oauth>]'
allowed-tools: Bash(node:*), Bash(gcloud:*), Bash(gws:*), Bash(which:*), Bash(uname:*), AskUserQuestion
disable-model-invocation: true
---

Walk the user through setting up Google access. Every step installs software or opens a browser
login, so **confirm before each one** and never batch them silently.

Raw slash-command arguments:
`$ARGUMENTS`

Start by running the doctor to see what is actually missing — skip whatever is already fine:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/google-doctor.mjs" --offline
```

## 1. Toolchain

Only install what some catalogued server needs. On Debian/Ubuntu:

- `pipx` (needed by google-ads and analytics): `sudo apt install pipx` — needs the user's password,
  so ask them to run it themselves with `! sudo apt install pipx`.
- `uv`/`uvx` (needed by gsc): `curl -LsSf https://astral.sh/uv/install.sh | sh`. Confirm first —
  it pipes a remote script into a shell.
- `gws` (needed by every gws-* skill): `npm install -g @googleworkspace/cli`.

Check the architecture with `uname -m` first. On aarch64, warn that `pipx run --spec git+…` for
google-ads may have to compile `grpcio` from source on first launch, which can take minutes and
trip the MCP server's startup timeout. If that happens, `pipx install` it once instead of using
`pipx run`.

## 2. Application Default Credentials

The local MCP servers all authenticate through ADC. One login grants every scope the catalogue
needs, so do it in a single pass:

```bash
gcloud auth application-default login \
  --scopes=openid,\
https://www.googleapis.com/auth/cloud-platform,\
https://www.googleapis.com/auth/analytics.readonly,\
https://www.googleapis.com/auth/adwords,\
https://www.googleapis.com/auth/webmasters.readonly,\
https://www.googleapis.com/auth/bigquery
```

This needs a browser. Inside Crostini or any container, add `--no-launch-browser` and have the
user paste the URL into their own browser. Then set the quota project:

```bash
gcloud auth application-default set-quota-project <project-id>
```

Use the plugin's configured project if there is one, otherwise `gcloud config get-value project`.

## 3. gws login

`gws auth login` — OAuth, token stored in the system keyring. Skip if the doctor already reports
gws as authenticated.

## 4. OAuth client for the remote MCP servers

This step is unavoidable and worth explaining, because the failure it prevents is confusing:

Google's remote endpoints (`https://<api>.googleapis.com/mcp`) publish OAuth metadata, but
`accounts.google.com` exposes **no `registration_endpoint`** — it does not support Dynamic Client
Registration, which is how Claude Code would normally register itself. So the servers connect,
serve their whole tool list unauthenticated, and then 401 on every actual call. The user must
bring their own OAuth client.

1. In `console.cloud.google.com/apis/credentials`, create an OAuth 2.0 Client ID of type
   **Desktop app** (or Web application with a redirect URI of `http://localhost:8765/callback`).
2. Register the server with the client attached:

```bash
claude mcp add --transport http resource-manager \
  https://cloudresourcemanager.googleapis.com/mcp \
  --client-id <client-id> --client-secret --callback-port 8765
```

**Test with `resource-manager` first.** It is the cheapest server in the catalogue (1 tool, 7 KB),
so if the OAuth flow does not work, the user finds out having paid almost nothing. Only once a
real tool call succeeds should they enable anything bigger.

## 5. Finish

Re-run `/google:doctor` (with network probes this time) and show the result. Explain any remaining
`REACHABLE, NOT AUTHORISED` lines: they are expected for servers whose OAuth client is not attached
yet, and those servers should stay disabled until it is.
