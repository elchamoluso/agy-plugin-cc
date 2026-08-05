#!/usr/bin/env node
// Drop empty environment variables, then exec the real MCP server.
//
// Claude Code expands an unset optional userConfig to an EMPTY STRING rather than
// omitting the key (verified 2026-08-05 by capturing the env of a spawned server).
// For path-shaped variables that is worse than absent: google-auth checks
// `os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") is not None`, so an empty value
// makes it try to open "" and raise DefaultCredentialsError instead of falling
// through to Application Default Credentials. Same story for an empty
// GOOGLE_ADS_LOGIN_CUSTOMER_ID, which would travel as a blank MCC header.
//
// Usage: node launch.mjs <command> [args...]

import process from "node:process";
import { spawn } from "node:child_process";

// Only prune the variables this plugin injects. Anything inherited from the user's
// shell is left exactly as it is — an empty value there was their choice.
const MANAGED = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  "GOOGLE_PROJECT_ID",
  "GSC_OAUTH_CLIENT_SECRETS_FILE",
  "GSC_CREDENTIALS_PATH"
];

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write("launch.mjs: no command given\n");
  process.exit(2);
}

const env = { ...process.env };
const pruned = [];
for (const name of MANAGED) {
  if (env[name] === "") {
    delete env[name];
    pruned.push(name);
  }
}
if (pruned.length) {
  // stderr only: stdout is the MCP stdio transport and must carry nothing but JSON-RPC.
  process.stderr.write(`[launch] unset (empty): ${pruned.join(", ")}\n`);
}

const child = spawn(command, args, { stdio: "inherit", env });
child.on("error", (error) => {
  process.stderr.write(
    error.code === "ENOENT"
      ? `[launch] ${command} not found on PATH. Run /google:setup to install it.\n`
      : `[launch] could not start ${command}: ${error.message}\n`
  );
  process.exit(127);
});
// Mirror the child's fate so Claude Code sees the real outcome.
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => child.kill(signal));
}
