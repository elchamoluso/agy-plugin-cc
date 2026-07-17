#!/usr/bin/env node
// agy-companion — headless bridge between Claude Code and Google's Antigravity CLI (agy).
// Pattern adapted from openai/codex-plugin-cc (Apache-2.0), with the codex app-server
// transport replaced by one-shot `agy --print=…` spawns (agy has no persistent runtime,
// no JSON output, no event stream — plain text on stdout is the whole contract).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import { binaryAvailable, runCommand, terminateProcessTree, killProcessTree } from "./lib/process.mjs";
import { collectReviewContext, truncateToBudget, DIFF_BUDGET_BYTES } from "./lib/git.mjs";

const DEFAULT_MODEL = "Gemini 3.1 Pro (High)";
// agy model names contain spaces and parens, and the `!`-backtick + "$ARGUMENTS" plumbing
// eats embedded double quotes, so space-free aliases are the reliable way to pick a model.
const MODEL_ALIASES = new Map([
  ["pro", "Gemini 3.1 Pro (High)"],
  ["pro-high", "Gemini 3.1 Pro (High)"],
  ["pro-low", "Gemini 3.1 Pro (Low)"],
  ["flash", "Gemini 3.5 Flash (Medium)"],
  ["flash-medium", "Gemini 3.5 Flash (Medium)"],
  ["flash-high", "Gemini 3.5 Flash (High)"],
  ["flash-low", "Gemini 3.5 Flash (Low)"],
  ["sonnet", "Claude Sonnet 4.6 (Thinking)"],
  ["opus", "Claude Opus 4.6 (Thinking)"],
  ["gpt-oss", "GPT-OSS 120B (Medium)"]
]);

function resolveModel(value) {
  if (!value) {
    return DEFAULT_MODEL;
  }
  return MODEL_ALIASES.get(value.toLowerCase()) ?? value;
}
const DEFAULT_TIMEOUT_SECONDS = 420;
const WATCHDOG_GRACE_SECONDS = 30;
// Linux caps a single argv string at 128 KiB (MAX_ARG_STRLEN); the prompt is one token.
const MAX_PROMPT_BYTES = 120 * 1024;
const CONVERSATIONS_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations");
const TOKEN_FILE = path.join(os.homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");

// ---------------------------------------------------------------------------
// Argument handling. Flags are only recognized at the START of the raw
// argument string; everything after the first non-flag token is the prompt,
// preserved verbatim (apostrophes and quotes in natural language survive).
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Map([
  ["--model", "model"],
  ["-m", "model"],
  ["--timeout", "timeout"],
  ["--conversation", "conversation"],
  ["--base", "base"]
]);

function extractLeadingFlags(raw) {
  const options = {};
  let rest = (raw ?? "").trim();

  while (rest.startsWith("-")) {
    const tokenMatch = rest.match(/^(--?[A-Za-z][A-Za-z0-9-]*)(=)?/);
    if (!tokenMatch) {
      break;
    }
    const [, flag, hasEquals] = tokenMatch;
    const key = VALUE_FLAGS.get(flag);
    if (!key) {
      break; // unknown leading dash-token: treat it (and the rest) as prompt text
    }

    rest = rest.slice(tokenMatch[0].length);
    if (!hasEquals) {
      rest = rest.replace(/^\s+/, "");
    }

    let value;
    const quote = rest[0] === "\"" || rest[0] === "'" ? rest[0] : null;
    if (quote) {
      const end = rest.indexOf(quote, 1);
      if (end === -1) {
        throw new Error(`Unterminated quote in value for ${flag}`);
      }
      value = rest.slice(1, end);
      rest = rest.slice(end + 1);
    } else {
      const spaceMatch = rest.match(/^\S+/);
      value = spaceMatch ? spaceMatch[0] : "";
      rest = rest.slice(value.length);
    }
    if (!value) {
      throw new Error(`Missing value for ${flag}`);
    }
    options[key] = value;
    rest = rest.replace(/^\s+/, "");
  }

  return { options, prompt: rest.trim() };
}

function parseTimeout(options) {
  if (options.timeout === undefined) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  const seconds = Number(options.timeout);
  if (!Number.isFinite(seconds) || seconds < 10 || seconds > 3600) {
    throw new Error(`--timeout must be a number of seconds between 10 and 3600 (got "${options.timeout}")`);
  }
  return Math.floor(seconds);
}

// ---------------------------------------------------------------------------
// Conversation tracking. agy persists each conversation as <uuid>.db under
// CONVERSATIONS_DIR; a fresh run creates a new UUID. Snapshotting the dir
// before/after the run identifies THIS run's conversation even if other agy
// sessions exist. State is keyed by cwd so each project continues its own.
// ---------------------------------------------------------------------------

function conversationSnapshot() {
  try {
    return new Set(
      fs.readdirSync(CONVERSATIONS_DIR)
        .filter((name) => name.includes(".db"))
        .map((name) => name.replace(/\.db(-wal|-shm)?$/, ""))
    );
  } catch {
    return new Set();
  }
}

function stateFilePath() {
  const dir = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".cache", "agy-plugin");
  return path.join(dir, "conversations.json");
}

function loadConversationState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath(), "utf8"));
    // JSON.parse("null") / a corrupted array must not crash callers.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

// Best-effort: losing state may break /agy:continue, never a successful answer.
// Returns a warning string instead of throwing.
function rememberConversation(conversationId, model) {
  if (!conversationId) {
    return null;
  }
  try {
    const state = loadConversationState();
    state[process.cwd()] = { conversationId, model, updatedAt: new Date().toISOString() };
    const file = stateFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
    return null;
  } catch (error) {
    return `could not persist conversation state (${error?.message ?? error}); /agy:continue may not find this conversation`;
  }
}

function recallConversation() {
  return loadConversationState()[process.cwd()] ?? null;
}

// ---------------------------------------------------------------------------
// Spawn. Flag order is critical with agy's parser: boolean flags FIRST, and
// --print as --print=<prompt> in a single argv token so nothing can be
// swallowed as its value. Never goes through a shell.
// ---------------------------------------------------------------------------

function buildAgyArgs({ prompt, model, skipPermissions, conversationId, timeoutSeconds }) {
  const args = [];
  if (skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  if (conversationId) {
    args.push(`--conversation=${conversationId}`);
  }
  args.push(`--model=${model}`);
  args.push(`--print-timeout=${timeoutSeconds}s`);
  args.push(`--print=${prompt}`);
  return args;
}

function runAgy(agyArgs, timeoutSeconds) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn("agy", agyArgs, {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    // If Claude Code tears this node process down (SIGTERM/SIGINT), take the detached
    // agy process group with us — especially important for exec runs with permissions.
    const onSignal = () => {
      terminateProcessTree(child.pid);
      setTimeout(() => killProcessTree(child.pid), 5_000).unref();
      process.exit(143);
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);

    const settle = (result) => {
      if (!settled) {
        settled = true;
        clearTimeout(watchdog);
        process.removeListener("SIGTERM", onSignal);
        process.removeListener("SIGINT", onSignal);
        resolve({ ...result, stdout, stderr, timedOut, elapsedSeconds: (Date.now() - startedAt) / 1000 });
      }
    };

    const watchdog = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid);
      setTimeout(() => killProcessTree(child.pid), 10_000).unref();
    }, (timeoutSeconds + WATCHDOG_GRACE_SECONDS) * 1000);

    // setEncoding matters: without it, a multi-byte UTF-8 char split across pipe
    // chunks decodes to U+FFFD (real risk — reviews are written in Spanish).
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => settle({ error, code: null, signal: null }));
    child.on("close", (code, signal) => settle({ error: null, code, signal }));
  });
}

async function executePrompt({ prompt, options, skipPermissions, conversationId }) {
  if (!prompt) {
    throw new Error("Empty prompt. Usage: [--model <alias>] [--timeout <s>] <prompt text> — aliases: pro, pro-low, flash, flash-high, flash-low, sonnet, opus, gpt-oss");
  }
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new Error(`Prompt exceeds ${Math.floor(MAX_PROMPT_BYTES / 1024)} KiB (Linux argv limit). Shorten it.`);
  }

  const model = resolveModel(options.model);
  const timeoutSeconds = parseTimeout(options);
  const before = conversationSnapshot();

  const result = await runAgy(
    buildAgyArgs({ prompt, model, skipPermissions, conversationId, timeoutSeconds }),
    timeoutSeconds
  );

  if (result.error) {
    if (result.error.code === "ENOENT") {
      fail("agy CLI not found on PATH. Install the Antigravity CLI and ensure ~/.local/bin is on PATH, then run /agy:setup.");
    }
    fail(`Failed to launch agy: ${result.error.message}`);
  }

  if (result.timedOut) {
    process.stdout.write(result.stdout);
    fail(`agy timed out after ${timeoutSeconds + WATCHDOG_GRACE_SECONDS}s (watchdog) and was terminated. Partial output above, if any. Retry with --timeout <seconds> for longer runs.`, 124);
  }

  // agy silently IGNORES a nonexistent --conversation uuid and starts a fresh one
  // (exit 0, no error — verified against v1.1.3), so trust the filesystem, not the
  // flag: if the requested uuid has no .db after the run, adopt the one agy created.
  const after = conversationSnapshot();
  const created = [...after].filter((id) => !before.has(id));
  let activeConversation = conversationId ?? null;
  let conversationMismatch = false;
  if (activeConversation && !after.has(activeConversation)) {
    conversationMismatch = true;
    activeConversation = created.length === 1 ? created[0] : null;
  } else if (!activeConversation && created.length === 1) {
    activeConversation = created[0];
  }

  // The answer ALWAYS flushes first; state persistence is best-effort and must
  // never destroy a successful (slow, subscription-consuming) agy run.
  process.stdout.write(result.stdout);
  if (result.stdout && !result.stdout.endsWith("\n")) {
    process.stdout.write("\n");
  }

  // agy reports headless permission auto-denials ("jetski: no output produced — a tool
  // required the … permission") on stderr with exit 0; surface stderr whenever stdout
  // came back empty or the run failed, so nothing reads as a silent success.
  const stderrClean = result.stderr
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("Shell cwd was reset"))
    .join("\n");
  if (stderrClean && (!result.stdout.trim() || result.code !== 0)) {
    process.stdout.write(`[agy stderr]\n${stderrClean}\n`);
  }

  // Only remember conversations from successful runs — a failed run (e.g. a bad
  // user-supplied --conversation uuid) must not poison future /agy:continue calls.
  let stateWarning = null;
  if (result.code === 0) {
    stateWarning = rememberConversation(activeConversation, model);
  }

  const trailerParts = [
    `exit ${result.code}`,
    `model "${model}"`,
    `${result.elapsedSeconds.toFixed(1)}s`,
    activeConversation ? `conversation ${activeConversation}` : "conversation unknown"
  ];
  process.stdout.write(`\n[agy-companion] ${trailerParts.join(" · ")}\n`);
  if (conversationMismatch) {
    process.stdout.write(`[agy-companion] warning: requested conversation ${conversationId} does not exist — agy silently started a FRESH conversation instead; previous context was NOT carried over\n`);
  }
  if (stateWarning) {
    process.stdout.write(`[agy-companion] warning: ${stateWarning}\n`);
  }
  if (activeConversation && result.code === 0) {
    const hint = skipPermissions
      ? "follow up with /agy:continue (Q&A only — tool permissions are NOT carried over; use /agy:exec again for more changes)"
      : "follow up in the same agy conversation with /agy:continue <prompt>";
    process.stdout.write(`[agy-companion] ${hint}\n`);
  }

  if (result.code !== 0) {
    process.exit(result.code ?? 1);
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function handleAsk(raw, { skipPermissions } = {}) {
  const { options, prompt } = extractLeadingFlags(raw);
  await executePrompt({ prompt, options, skipPermissions: Boolean(skipPermissions), conversationId: options.conversation ?? null });
}

async function handleContinue(raw) {
  const { options, prompt } = extractLeadingFlags(raw);
  const recalled = recallConversation();
  const conversationId = options.conversation ?? recalled?.conversationId;
  if (!conversationId) {
    fail(`No previous agy conversation recorded for ${process.cwd()}. Start one with /agy:ask first, or pass --conversation <uuid>.`);
  }
  // Stay on the conversation's original model unless the user overrides it —
  // otherwise a Sonnet conversation would silently continue on the default Gemini.
  if (options.model === undefined && recalled?.model && conversationId === recalled.conversationId) {
    options.model = recalled.model;
  }
  await executePrompt({ prompt, options, skipPermissions: false, conversationId });
}

const STAT_BUDGET_BYTES = 8 * 1024;

async function handleReview(raw) {
  const { options, prompt: extraInstructions } = extractLeadingFlags(raw);
  const context = collectReviewContext(process.cwd(), { base: options.base ?? null });

  if (!context.diff.trim()) {
    fail(`Nothing to review: the diff for ${context.label} is empty.`);
  }

  // Everything below travels as ONE argv token, so the whole prompt must stay under
  // MAX_PROMPT_BYTES: cap the stat/status listing, then give the diff whatever
  // headroom remains (huge changesets shrink the diff instead of aborting).
  const stat = truncateToBudget(context.statText || "(none)", STAT_BUDGET_BYTES);
  const statBlock = stat.truncated
    ? `${stat.text}\n… (status listing truncated, ${Math.ceil(stat.originalBytes / 1024)} KiB total)`
    : stat.text;

  const headerParts = [
    "You are a senior software engineer giving a second-opinion code review.",
    "Review ONLY the changes in the diff below. Do not invent issues outside the diff.",
    "For each finding give: severity (P0 blocker / P1 major / P2 minor / P3 nit), file and line from the diff headers, what is wrong, why it matters, and a concrete fix.",
    "Order findings by severity. If the changes look correct, say so explicitly and mention at most the few improvements that are genuinely worth it.",
    "Write the review in Spanish unless the extra instructions below request another language.",
    "",
    `Repository context: reviewing ${context.label}.`,
    "",
    "## Diff stat / status",
    statBlock,
    ""
  ];
  if (extraInstructions) {
    headerParts.push("## Extra instructions from the user", extraInstructions, "");
  }

  const headerBytes = Buffer.byteLength(headerParts.join("\n"), "utf8");
  const diffHeadroom = MAX_PROMPT_BYTES - headerBytes - 2048;
  if (diffHeadroom < 8 * 1024) {
    fail("The review prompt has no room left for the diff — shorten the extra instructions.");
  }
  const diffBudget = Math.min(DIFF_BUDGET_BYTES, diffHeadroom);
  const diffCut = truncateToBudget(context.diff.trim(), diffBudget);
  const truncated = context.truncated || diffCut.truncated;
  const originalKiB = Math.ceil(Math.max(context.originalBytes, diffCut.originalBytes) / 1024);

  const promptParts = [...headerParts];
  if (truncated) {
    promptParts.push(
      `NOTE: the diff was truncated to ~${Math.floor(diffBudget / 1024)} KiB (original ${originalKiB} KiB). Judge only what is present.`,
      ""
    );
  }
  promptParts.push("## Diff", "```diff", diffCut.text, "```");

  if (truncated) {
    process.stdout.write(`[agy-companion] diff truncated to ${Math.floor(diffBudget / 1024)} KiB of ${originalKiB} KiB — findings may be incomplete\n\n`);
  }

  await executePrompt({ prompt: promptParts.join("\n"), options, skipPermissions: false, conversationId: null });
}

function handleModels() {
  const result = runCommand("agy", ["models"]);
  if (result.error?.code === "ENOENT") {
    fail("agy CLI not found on PATH. Install the Antigravity CLI and run /agy:setup.");
  }
  if (result.error) {
    fail(`Failed to run agy models: ${result.error.message}. Run /agy:setup to diagnose.`);
  }
  process.stdout.write(result.stdout);
  if (result.status !== 0) {
    process.stdout.write(result.stderr);
    process.exit(result.status || 1);
  }
  process.stdout.write(`\nDefault model used by this plugin: "${DEFAULT_MODEL}"\n`);
  process.stdout.write("Override per call with --model <alias>. Aliases:\n");
  for (const [alias, full] of MODEL_ALIASES) {
    process.stdout.write(`  ${alias.padEnd(13)} → ${full}\n`);
  }
}

async function handleSetup() {
  const lines = ["# agy plugin setup check", ""];
  let healthy = true;

  const availability = binaryAvailable("agy");
  if (availability.available) {
    lines.push(`- Binary: agy ${availability.detail} — OK`);
  } else {
    healthy = false;
    lines.push(`- Binary: NOT AVAILABLE (${availability.detail})`);
    lines.push("  Install the Antigravity CLI and ensure it is on PATH (usually ~/.local/bin/agy).");
  }

  if (fs.existsSync(TOKEN_FILE)) {
    try {
      const token = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      const expiry = token?.token?.expiry ? new Date(token.token.expiry) : null;
      const fresh = expiry && expiry.getTime() > Date.now();
      lines.push(`- Auth token: present (method: ${token.auth_method ?? "unknown"}, access token ${fresh ? "fresh" : "expired — agy auto-refreshes on next run"})`);
    } catch {
      lines.push("- Auth token: present but unreadable — run agy interactively once to re-login if the smoke test fails");
    }
  } else {
    healthy = false;
    lines.push("- Auth token: MISSING. Run `agy` interactively once and complete the Google login.");
  }

  if (healthy) {
    lines.push("- Smoke test: running…");
    process.stdout.write(`${lines.join("\n")}\n`);
    lines.length = 0;
    const result = await runAgy(
      buildAgyArgs({ prompt: "Reply with exactly: OK", model: DEFAULT_MODEL, skipPermissions: false, conversationId: null, timeoutSeconds: 90 }),
      90
    );
    if (!result.error && !result.timedOut && result.code === 0 && result.stdout.trim().includes("OK")) {
      lines.push(`- Smoke test: PASSED in ${result.elapsedSeconds.toFixed(1)}s (model "${DEFAULT_MODEL}")`);
      lines.push("", "agy plugin is ready. Try /agy:ask, /agy:review or /agy:exec.");
    } else {
      healthy = false;
      const detail = result.error?.message ?? (result.timedOut ? "timed out" : `exit ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 400)}`);
      lines.push(`- Smoke test: FAILED (${detail})`);
      lines.push("  If this mentions an expired or revoked token, run `agy` interactively once to re-authenticate.");
    }
  } else {
    lines.push("", "Fix the items above, then run /agy:setup again.");
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  process.exit(healthy ? 0 : 1);
}

// ---------------------------------------------------------------------------

function fail(message, code = 1) {
  process.stdout.write(`${message}\n`);
  process.exit(code);
}

const [, , subcommand, ...rest] = process.argv;
const raw = rest.join(" ");

try {
  switch (subcommand) {
    case "ask":
      await handleAsk(raw);
      break;
    case "exec":
      await handleAsk(raw, { skipPermissions: true });
      break;
    case "continue":
      await handleContinue(raw);
      break;
    case "review":
      await handleReview(raw);
      break;
    case "models":
      handleModels();
      break;
    case "setup":
      await handleSetup();
      break;
    default:
      fail(`Unknown subcommand "${subcommand ?? ""}". Expected: ask | exec | continue | review | models | setup`);
  }
} catch (error) {
  fail(error?.message ?? String(error));
}
