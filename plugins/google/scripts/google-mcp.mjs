#!/usr/bin/env node
// Enable catalogued Google MCP servers in THIS project's .mcp.json.
//
// Why the project file and not a plugin: Claude Code can only toggle a plugin as a whole,
// but a project's .mcp.json has native per-server control (enabledMcpjsonServers /
// disabledMcpjsonServers). So the finest granularity available runs through here.
//
// Never touches the global config, always backs up before writing, and refuses to add a
// server whose prerequisites are absent — a server that fails to start is noise in every
// session, and a remote one that "starts" without auth is worse: it silently costs its
// whole schema.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { applyMeasurements } from "./lib/measurements.mjs";

const CATALOG = path.resolve(import.meta.dirname, "..", "mcp", "catalog.json");
const GLOBAL_CONFIG = path.join(os.homedir(), ".claude.json");

const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
// Servers you probed yourself count as verified here too — otherwise `add` would keep
// refusing the server it just told you to measure.
const servers = applyMeasurements(catalog.servers);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function projectRoot() {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (!result.error && result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

const ROOT = projectRoot();
const MCP_FILE = path.join(ROOT, ".mcp.json");

function readProjectConfig() {
  if (!fs.existsSync(MCP_FILE)) return { mcpServers: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(MCP_FILE, "utf8"));
    return { ...parsed, mcpServers: parsed.mcpServers ?? {} };
  } catch (error) {
    fail(`${MCP_FILE} is not valid JSON (${error.message}). Fix or remove it first.`);
  }
}

function writeProjectConfig(config) {
  if (fs.existsSync(MCP_FILE)) {
    fs.copyFileSync(MCP_FILE, `${MCP_FILE}.bak`);
  }
  fs.writeFileSync(MCP_FILE, `${JSON.stringify(config, null, 2)}\n`);
}

// A server already configured globally would be shadowed or duplicated; the
// workspace-developer remote is commonly there already.
function globallyConfigured() {
  try {
    const parsed = JSON.parse(fs.readFileSync(GLOBAL_CONFIG, "utf8"));
    return new Set(Object.keys(parsed.mcpServers ?? {}));
  } catch {
    return new Set();
  }
}

function which(binary) {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [binary], { encoding: "utf8" });
  return !result.error && result.status === 0;
}

function kb(bytes) {
  return bytes ? `${Math.round(bytes / 1024)} KB` : "—";
}

// Claude Code expands ${VAR} and ${VAR:-default} in url, args, env AND headers, leaving
// anything undefined as a literal. Scanning the whole serialised config catches all four
// in one place — the previous check only looked at projectEnv, so a server whose only
// variable lives in a header (maps-grounding-lite) was added with no warning at all and
// then 401'd, which reads exactly like the OAuth problem it actually avoids.
function unsetVariables(config) {
  const found = new Map();
  for (const [, name, fallback] of JSON.stringify(config).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g)) {
    if (!process.env[name]) found.set(name, fallback ?? null);
  }
  return found;
}

function cmdList(showAll) {
  const enabled = new Set(Object.keys(readProjectConfig().mcpServers));
  const visible = Object.entries(servers).filter(([, s]) => showAll || s.status !== "listed");
  const hidden = Object.keys(servers).length - visible.length;
  const rows = visible.map(([id, s]) => ({
    id,
    on: enabled.has(id),
    kind: s.kind,
    status: s.status,
    tools: s.toolCount ?? null,
    bytes: s.schemaBytes ?? null,
    title: s.title,
    bundled: s.bundledIn ?? null,
    local: Boolean(s.measuredLocally)
  }));
  const width = Math.max(...rows.map((r) => r.id.length));
  process.stdout.write(`Catalogue (measured ${catalog.measuredAt}) — ${MCP_FILE}\n\n`);
  for (const r of rows.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))) {
    const noun = r.tools === 1 ? "tool " : "tools";
    const cost = r.tools ? `${String(r.tools).padStart(3)} ${noun} ${kb(r.bytes).padStart(7)}` : "".padStart(18);
    const notes = [r.bundled ? `also in ${r.bundled}` : null, r.local ? "measured here" : null].filter(Boolean);
    process.stdout.write(`${r.on ? "●" : "○"} ${r.id.padEnd(width)}  ${r.kind.padEnd(6)} ${cost}  ${r.title}${notes.length ? `  (${notes.join(", ")})` : ""}\n`);
  }
  const total = rows.filter((r) => r.on).reduce((s, r) => s + (r.bytes ?? 0), 0);
  process.stdout.write(`\n● enabled in this project  ○ available\nEnabled schema cost: ${kb(total)}\n`);
  if (hidden) {
    process.stdout.write(`\n${hidden} more server(s) are catalogued but never probed — \`list --all\` shows them. \`add\` refuses them until someone measures them.\n`);
  }
}

function cmdAdd(ids) {
  const anyway = ids.includes("--anyway");
  ids = ids.filter((id) => id !== "--anyway");
  if (!ids.length) fail("Usage: add [--anyway] <server-id>...  (see `list`)");
  const config = readProjectConfig();
  const global = globallyConfigured();
  const added = [];

  for (const id of ids) {
    const server = servers[id];
    if (!server) {
      fail(`Unknown server "${id}". Run \`list\` to see the catalogue.`);
    }
    if (config.mcpServers[id]) {
      process.stdout.write(`= ${id} already enabled in this project\n`);
      continue;
    }
    if (global.has(id)) {
      process.stdout.write(`! ${id} is already configured globally in ~/.claude.json — skipping to avoid a duplicate\n`);
      continue;
    }
    // The catalogue's whole claim is that its numbers were measured. Adding a server
    // nobody has probed would enable something of unknown cost and unknown liveness.
    if (server.status === "listed") {
      process.stdout.write(
        `✗ ${id} is catalogued from Google's supported-products page but has never been probed, so its tool count and schema cost are unknown.\n` +
          `  Measure it first: /google:doctor --probe=${id}\n`
      );
      continue;
    }
    if (server.status === "unavailable") {
      process.stdout.write(`✗ ${id}: ${server.notes ?? "probed and found not to exist"}\n`);
      continue;
    }
    // Checked before the binary requirements: a missing binary is a detour, but copying
    // a credential-bearing server into a project file is the wrong road entirely, and
    // the user should hear that first rather than after installing pipx for nothing.
    // Servers whose credentials live in a plugin's userConfig cannot be copied here
    // as-is: ${user_config.*} only resolves inside the plugin that declares it, and a
    // project .mcp.json has no access to secure storage. Writing the bare config would
    // produce a server that starts with no credentials and fails with a confusing auth
    // error, while also bypassing the plugin's empty-env launcher.
    if (server.preferPlugin && !anyway) {
      process.stdout.write(
        `✗ ${id} keeps its credentials in the ${server.preferPlugin} plugin, which stores them securely.\n` +
          `  Install that instead:  /plugin install ${server.preferPlugin}@agy-marketplace\n` +
          `  To add it here anyway, re-run with --anyway; you will then have to export ` +
          `${Object.keys(server.projectEnv ?? {}).join(", ")} yourself, in plain text.\n`
      );
      continue;
    }
    const missing = (server.requires ?? []).filter((binary) => !which(binary));
    if (missing.length) {
      process.stdout.write(`✗ ${id} needs ${missing.join(", ")} on PATH — run /google:setup first. Skipped.\n`);
      continue;
    }
    config.mcpServers[id] = server.projectEnv
      ? { ...server.config, env: { ...(server.config.env ?? {}), ...server.projectEnv } }
      : server.config;
    added.push(id);
    const cost = server.schemaBytes ? ` (+${kb(server.schemaBytes)} of schema per session)` : "";
    process.stdout.write(`+ ${id}${cost}\n`);
    if (server.warning) process.stdout.write(`  warning: ${server.warning}\n`);
    const unset = unsetVariables(config.mcpServers[id]);
    if (unset.size) {
      const described = [...unset].map(([name, fallback]) => (fallback === null ? name : `${name} (falls back to "${fallback}")`));
      const blocking = [...unset].filter(([, fallback]) => fallback === null);
      process.stdout.write(`  reads from your shell environment: ${described.join(", ")}\n`);
      if (blocking.length) {
        process.stdout.write(`  NOT SET right now: ${blocking.map(([n]) => n).join(", ")} — export them before starting Claude Code, or the value stays a literal \${…} and the server fails to authenticate.\n`);
      }
    }
    if (server.auth === "oauth-no-dcr") {
      process.stdout.write("  auth: Google does not support Dynamic Client Registration, so this will connect but 401 on every call until you attach your own OAuth client. See /google:setup.\n");
    }
    if (server.auth === "api-key") {
      process.stdout.write("  auth: API key in a header — the one remote server here that works without an OAuth client. That key is a bearer credential; restrict it in the console.\n");
    }
  }

  if (!added.length) {
    process.stdout.write("\nNothing to do.\n");
    return;
  }
  writeProjectConfig(config);
  process.stdout.write(`\nWrote ${MCP_FILE}. Restart Claude Code, then approve the servers when prompted.\n`);
}

function cmdRemove(ids) {
  if (!ids.length) fail("Usage: remove <server-id>...");
  const config = readProjectConfig();
  const removed = ids.filter((id) => {
    if (!config.mcpServers[id]) {
      process.stdout.write(`= ${id} was not enabled here\n`);
      return false;
    }
    delete config.mcpServers[id];
    process.stdout.write(`- ${id}\n`);
    return true;
  });
  if (!removed.length) {
    process.stdout.write("\nNothing to do.\n");
    return;
  }
  writeProjectConfig(config);
  process.stdout.write(`\nWrote ${MCP_FILE}.\n`);
}

function cmdStatus() {
  const config = readProjectConfig();
  const entries = Object.entries(config.mcpServers);
  process.stdout.write(`${MCP_FILE}\n\n`);
  if (!entries.length) {
    process.stdout.write("No MCP servers enabled in this project.\n");
    return;
  }
  let total = 0;
  for (const [id, cfg] of entries) {
    const known = servers[id];
    if (known?.schemaBytes) total += known.schemaBytes;
    const how = cfg.type === "http" ? cfg.url : `${cfg.command} ${(cfg.args ?? []).join(" ")}`;
    process.stdout.write(`● ${id}${known ? "" : " (not in catalogue)"}\n    ${how}\n`);
  }
  process.stdout.write(`\nSchema cost of catalogued servers: ${kb(total)}\n`);
}

const [, , subcommand, ...rest] = process.argv;
switch (subcommand) {
  case "list":
  case undefined:
    cmdList(rest.includes("--all"));
    break;
  case "add":
    cmdAdd(rest);
    break;
  case "remove":
    cmdRemove(rest);
    break;
  case "status":
    cmdStatus();
    break;
  default:
    fail(`Unknown subcommand "${subcommand}". Use: list | add <id>... | remove <id>... | status`);
}
