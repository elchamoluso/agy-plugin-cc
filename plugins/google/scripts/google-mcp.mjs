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

const CATALOG = path.resolve(import.meta.dirname, "..", "mcp", "catalog.json");
const GLOBAL_CONFIG = path.join(os.homedir(), ".claude.json");

const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
const servers = catalog.servers;

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

function cmdList() {
  const enabled = new Set(Object.keys(readProjectConfig().mcpServers));
  const rows = Object.entries(servers).map(([id, s]) => ({
    id,
    on: enabled.has(id),
    kind: s.kind,
    tools: s.toolCount ?? null,
    bytes: s.schemaBytes ?? null,
    title: s.title,
    bundled: s.bundledIn ?? null
  }));
  const width = Math.max(...rows.map((r) => r.id.length));
  process.stdout.write(`Catalogue (measured ${catalog.measuredAt}) — ${MCP_FILE}\n\n`);
  for (const r of rows.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))) {
    const noun = r.tools === 1 ? "tool " : "tools";
    const cost = r.tools ? `${String(r.tools).padStart(3)} ${noun} ${kb(r.bytes).padStart(7)}` : "".padStart(18);
    const where = r.bundled ? `also in ${r.bundled}` : "";
    process.stdout.write(`${r.on ? "●" : "○"} ${r.id.padEnd(width)}  ${r.kind.padEnd(6)} ${cost}  ${r.title}${where ? `  (${where})` : ""}\n`);
  }
  const total = rows.filter((r) => r.on).reduce((s, r) => s + (r.bytes ?? 0), 0);
  process.stdout.write(`\n● enabled in this project  ○ available\nEnabled schema cost: ${kb(total)}\n`);
  if (catalog.unavailable) {
    process.stdout.write("\nNot available:\n");
    for (const [id, why] of Object.entries(catalog.unavailable)) {
      process.stdout.write(`  ${id}: ${why}\n`);
    }
  }
}

function cmdAdd(ids) {
  if (!ids.length) fail("Usage: add <server-id>...  (see `list`)");
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
    const missing = (server.requires ?? []).filter((binary) => !which(binary));
    if (missing.length) {
      process.stdout.write(`✗ ${id} needs ${missing.join(", ")} on PATH — run /google:setup first. Skipped.\n`);
      continue;
    }
    config.mcpServers[id] = server.config;
    added.push(id);
    const cost = server.schemaBytes ? ` (+${kb(server.schemaBytes)} of schema per session)` : "";
    process.stdout.write(`+ ${id}${cost}\n`);
    if (server.warning) process.stdout.write(`  warning: ${server.warning}\n`);
    if (server.env?.length) process.stdout.write(`  needs env: ${server.env.join(", ")}\n`);
    if (server.auth === "oauth-no-dcr") {
      process.stdout.write("  auth: Google does not support Dynamic Client Registration, so this will connect but 401 on every call until you attach your own OAuth client. See /google:setup.\n");
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
    cmdList();
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
