#!/usr/bin/env node
// Read-only diagnosis of everything the Google plugins depend on: toolchain, gcloud
// credentials, gws login, and whether each catalogued MCP server would actually work.
//
// Nothing here mutates state — no logins, no installs, no writes. /google:setup does that.
//
// The interesting output is the middle state for remote servers. Google's *.googleapis.com/mcp
// endpoints answer initialize and tools/list with NO credentials, so "the server connects" says
// nothing about whether you can use it. This reports that case as REACHABLE, NOT AUTHORISED
// rather than letting it read as healthy.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const CATALOG = path.resolve(import.meta.dirname, "..", "mcp", "catalog.json");
const ADC_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS
  || path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json");
const PROBE_TIMEOUT_MS = 12000;

const OK = "OK";
const MISSING = "MISSING";
const PARTIAL = "PARTIAL";

const args = new Set(process.argv.slice(2));
const skipNetwork = args.has("--offline");
const probeAll = args.has("--probe-all");
const probeOne = [...args].find((a) => a.startsWith("--probe="))?.slice("--probe=".length) ?? null;
// Concurrency cap: the catalogue is well past the point where Promise.all over every
// remote would mean a burst of dozens of requests on each run.
const PROBE_CONCURRENCY = 6;

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

// Which servers this run cares about: the ones enabled in the project, unless told
// otherwise. Probing the whole catalogue by default would be slow and mostly irrelevant.
function projectServerIds() {
  const file = path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), ".mcp.json");
  try {
    return new Set(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers ?? {}));
  } catch {
    return new Set();
  }
}

function run(command, cmdArgs, options = {}) {
  return spawnSync(command, cmdArgs, { encoding: "utf8", timeout: 20000, ...options });
}

function which(binary) {
  const result = run(process.platform === "win32" ? "where" : "which", [binary]);
  return !result.error && result.status === 0 ? result.stdout.trim().split("\n")[0] : null;
}

function version(binary, versionArgs = ["--version"]) {
  const result = run(binary, versionArgs);
  if (result.error || result.status !== 0) return null;
  return (result.stdout || result.stderr).trim().split("\n")[0];
}

const rows = [];
function report(status, subject, detail) {
  rows.push({ status, subject, detail });
}

// --- toolchain ------------------------------------------------------------
// `requires` in the catalogue drives this: a binary is only worth flagging if some
// server actually needs it.
const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
const servers = catalog.servers;
const enabledHere = projectServerIds();
// Scope checking and probing both follow this set. With nothing enabled yet, fall back to
// the servers bundled into a plugin, so a fresh project still gets a useful answer.
const relevantServerIds = probeAll
  ? new Set(Object.keys(servers))
  : probeOne
    ? new Set([probeOne])
    : enabledHere.size
      ? enabledHere
      : new Set(Object.entries(servers).filter(([, s]) => s.bundledIn).map(([id]) => id));
const neededBinaries = new Set(["gcloud"]);
for (const server of Object.values(servers)) {
  for (const binary of server.requires ?? []) neededBinaries.add(binary);
}

for (const binary of [...neededBinaries].sort()) {
  const found = which(binary);
  if (!found) {
    const users = Object.entries(servers)
      .filter(([, s]) => (s.requires ?? []).includes(binary))
      .map(([id]) => id);
    report(MISSING, `binary ${binary}`, users.length ? `needed by: ${users.join(", ")}` : "not on PATH");
  } else {
    report(OK, `binary ${binary}`, version(binary) ?? found);
  }
}

// --- gcloud account and ADC ----------------------------------------------
if (which("gcloud")) {
  const account = run("gcloud", ["config", "get-value", "account"]);
  const active = account.status === 0 ? account.stdout.trim() : "";
  report(active && active !== "(unset)" ? OK : MISSING, "gcloud account", active || "no active account — run `gcloud auth login`");

  const project = run("gcloud", ["config", "get-value", "project"]);
  const projectId = project.status === 0 ? project.stdout.trim() : "";
  report(projectId && projectId !== "(unset)" ? OK : MISSING, "gcloud project", projectId || "unset — run `gcloud config set project <id>`");
}

if (!fs.existsSync(ADC_PATH)) {
  report(MISSING, "Application Default Credentials", `${ADC_PATH} does not exist — every local MCP server that talks to a Google API needs it. Run /google:setup.`);
} else {
  // The ADC file records the scopes it was granted. A login without the marketing
  // scopes is the usual cause of a 403 that looks like a broken server.
  let granted = [];
  let quotaProject = null;
  try {
    const adc = JSON.parse(fs.readFileSync(ADC_PATH, "utf8"));
    granted = adc.scopes ?? [];
    quotaProject = adc.quota_project_id ?? null;
  } catch {
    report(PARTIAL, "Application Default Credentials", `${ADC_PATH} exists but is not readable JSON`);
  }
  // Only the scopes you actually need. Unioning every catalogued server would keep this
  // line permanently red once the catalogue holds dozens of entries, at which point it
  // stops carrying information.
  const wanted = new Set();
  for (const [id, server] of Object.entries(servers)) {
    if (!relevantServerIds.has(id)) continue;
    for (const scope of server.scopes ?? []) wanted.add(scope);
  }
  const missing = [...wanted].filter((scope) => !granted.includes(scope));
  const short = (s) => s.replace("https://www.googleapis.com/auth/", "");
  if (!granted.length) {
    report(PARTIAL, "ADC scopes", "the credential records no scopes — it was probably created without --scopes");
  } else if (!wanted.size) {
    report(OK, "ADC scopes", `${granted.length} granted; no server enabled in this project needs any of them yet`);
  } else if (missing.length) {
    report(PARTIAL, "ADC scopes", `missing ${missing.map(short).join(", ")} for the servers enabled here — run /google:scopes`);
  } else {
    report(OK, "ADC scopes", `all ${wanted.size} scope(s) needed by this project's servers are granted`);
  }
  report(quotaProject ? OK : PARTIAL, "ADC quota project", quotaProject ?? "unset — run `gcloud auth application-default set-quota-project <id>`");
}

// --- gws ------------------------------------------------------------------
if (which("gws")) {
  const status = run("gws", ["auth", "status"]);
  if (status.status !== 0) {
    report(MISSING, "gws auth", "not logged in — run `gws auth login`");
  } else {
    // stdout carries a keyring banner before the JSON body; slice from the first brace.
    const brace = status.stdout.indexOf("{");
    let detail = status.stdout.trim().split("\n")[0];
    if (brace !== -1) {
      try {
        const info = JSON.parse(status.stdout.slice(brace));
        detail = `${info.auth_method ?? "authenticated"} · ${info.enabled_api_count ?? "?"} APIs enabled`;
      } catch {
        /* keep the first line */
      }
    }
    report(OK, "gws auth", detail);
  }
} else {
  report(MISSING, "binary gws", "the gws-* skills call this CLI — npm install -g @googleworkspace/cli");
}

// --- user config for the marketing servers --------------------------------
// Supplied through the plugin's userConfig prompt at install time, surfaced here as env.
for (const [name, hint] of [
  ["GOOGLE_ADS_DEVELOPER_TOKEN", "google-ads cannot start without it (Google Ads → Tools → API Center)"],
  ["GSC_OAUTH_CLIENT_SECRETS_FILE", "gsc falls back to service-account auth without it"]
]) {
  report(process.env[name] ? OK : MISSING, `env ${name}`, process.env[name] ? "set" : hint);
}

// --- remote MCP reachability ---------------------------------------------
function extractJson(text) {
  if (text.trimStart().startsWith("{")) return JSON.parse(text);
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return line ? JSON.parse(line.slice(5).trim()) : null;
}

// Resolve ${VAR} / ${VAR:-default} the way Claude Code would, so the probe sees what the
// real server would see. Returns null when something required is missing.
function expand(text) {
  let missing = null;
  const out = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
    const value = process.env[name] ?? fallback;
    if (value === undefined) missing = name;
    return value ?? "";
  });
  return missing ? { missing } : { value: out };
}

async function probeRemote(id, server) {
  const raw = server.config.url;
  // A URL still carrying a placeholder cannot be probed. Without this the doctor would
  // request a literal <REGION> and report a perfectly good server as MISSING.
  if (/<[A-Z_]+>/.test(raw)) {
    return report(PARTIAL, `mcp ${id}`, `needs a region — set ${Object.keys(server.variables ?? {}).join(", ") || "the endpoint variable"} and retry`);
  }
  const resolvedUrl = expand(raw);
  if (resolvedUrl.missing) {
    return report(PARTIAL, `mcp ${id}`, `SKIPPED — ${resolvedUrl.missing} is not set`);
  }
  const url = resolvedUrl.value;

  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  // An api-key server without its key is not "reachable but unauthorised", it is simply
  // not configured — reporting the former would be plainly false.
  for (const [name, template] of Object.entries(server.config.headers ?? {})) {
    const resolved = expand(template);
    if (resolved.missing || resolved.value === "") {
      return report(MISSING, `mcp ${id}`, `SKIPPED — header ${name} needs ${resolved.missing ?? "a value"}, which is not set`);
    }
    headers[name] = resolved.value;
  }
  const payload = (method, id2, params = {}) => JSON.stringify({ jsonrpc: "2.0", id: id2, method, params });
  try {
    const init = await fetch(url, {
      method: "POST",
      headers,
      body: payload("initialize", 1, { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "google-doctor", version: "0" } }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    if (init.status === 401 || init.status === 403) {
      return report(PARTIAL, `mcp ${id}`, `endpoint requires auth (HTTP ${init.status}) — complete the OAuth client step in /google:setup`);
    }
    if (!init.ok) {
      return report(MISSING, `mcp ${id}`, `HTTP ${init.status} from ${url}`);
    }
    const session = init.headers.get("mcp-session-id");
    await init.text();
    const listHeaders = session ? { ...headers, "mcp-session-id": session } : headers;
    const list = await fetch(url, { method: "POST", headers: listHeaders, body: payload("tools/list", 2), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const tools = extractJson(await list.text())?.result?.tools;
    if (Array.isArray(tools)) {
      // This is the dangerous state: it looks healthy and is not.
      const kb = Math.round(Buffer.byteLength(JSON.stringify(tools), "utf8") / 1024);
      const plural = tools.length === 1 ? "tool" : "tools";
      // tools/list answers without credentials on every one of these endpoints, so a
      // successful listing says nothing about whether calls will work. The remedy differs
      // by auth type, and telling an api-key server to attach an OAuth client is just wrong.
      const remedy =
        server.auth === "api-key"
          ? "Its API key is set, so calls should work — try one to confirm."
          : "Calls will 401 until you attach an OAuth client.";
      report(PARTIAL, `mcp ${id}`, `REACHABLE — serves ${tools.length} ${plural} unauthenticated (${kb} KB of schema). ${remedy}`);
    } else {
      report(PARTIAL, `mcp ${id}`, `connected but tools/list failed — likely needs auth`);
    }
  } catch (error) {
    report(MISSING, `mcp ${id}`, String(error?.message ?? error).slice(0, 120));
  }
}

if (!skipNetwork) {
  const remotes = Object.entries(servers).filter(
    ([id, s]) => s.kind === "remote" && s.auth !== "none" && s.status !== "unavailable" && relevantServerIds.has(id)
  );
  if (remotes.length) {
    await mapLimit(remotes, PROBE_CONCURRENCY, ([id, s]) => probeRemote(id, s));
  }
  const skippedCount = Object.values(servers).filter((s) => s.kind === "remote").length - remotes.length;
  if (skippedCount > 0 && !probeAll) {
    report(OK, "mcp probes", `${remotes.length} probed (enabled here); ${skippedCount} catalogued but not enabled — use --probe-all to sweep them`);
  }
}

// --- output ---------------------------------------------------------------
const ICON = { [OK]: "✓", [PARTIAL]: "!", [MISSING]: "✗" };
const order = { [MISSING]: 0, [PARTIAL]: 1, [OK]: 2 };
rows.sort((a, b) => order[a.status] - order[b.status] || a.subject.localeCompare(b.subject));

const width = Math.max(...rows.map((r) => r.subject.length));
process.stdout.write("# google plugin doctor\n\n");
for (const row of rows) {
  process.stdout.write(`${ICON[row.status]} ${row.subject.padEnd(width)}  ${row.detail}\n`);
}

const counts = rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
process.stdout.write(`\n${counts[OK] ?? 0} ok · ${counts[PARTIAL] ?? 0} partial · ${counts[MISSING] ?? 0} missing\n`);
if (counts[MISSING]) {
  process.stdout.write("\nRun /google:setup to fix the missing pieces.\n");
}
if (!skipNetwork) {
  process.stdout.write("\nNote: 'REACHABLE, NOT AUTHORISED' is the normal state before you attach an OAuth client.\nThose servers still cost their full schema in every session they are enabled in.\n");
}
process.exit(counts[MISSING] ? 1 : 0);
