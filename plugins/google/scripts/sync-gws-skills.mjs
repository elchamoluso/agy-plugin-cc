#!/usr/bin/env node
// Regenerate the vendored Workspace skills from the gws CLI itself.
//
// `gws generate-skills` is the source of truth — nothing here is hand-written, so a new
// gws release is picked up by re-running this. Two traps in the CLI, both worked around:
//   * --output-dir REJECTS absolute paths and resolves under the cwd, so we chdir instead.
//   * `gws generate-skills --help` does not print help, it WRITES FILES. Never probe it.
//
// Generation goes to a temp dir first and only replaces the real tree once it looks sane;
// generating in place would leave a half-written plugin if the CLI died midway.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "..", "..");
// Where each generated skill belongs. gws-* are capabilities and live in the hub; the
// recipe-*/persona-* templates are half the skill count and go in their own plugin so the
// hub's always-on cost stays small.
const TARGETS = [
  { id: "gws", dir: path.join(PLUGINS_DIR, "google", "skills"), match: (n) => n.startsWith("gws-") },
  {
    id: "recipes",
    dir: path.join(PLUGINS_DIR, "google-workspace-recipes", "skills"),
    match: (n) => n.startsWith("recipe-") || n.startsWith("persona-")
  }
];
// A generation run that collapses to a handful of skills means the CLI changed shape.
// Fail loudly rather than silently gutting the plugins.
const MIN_EXPECTED_SKILLS = 60;

function fail(message) {
  process.stderr.write(`sync-gws-skills: ${message}\n`);
  process.exit(1);
}

function gwsVersion() {
  const result = spawnSync("gws", ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || `exit ${result.status}`;
    fail(`could not run \`gws --version\` (${detail}). Install the Workspace CLI first: npm install -g @googleworkspace/cli`);
  }
  return (result.stdout.trim().split("\n")[0] ?? "").replace(/^gws\s+/, "").trim();
}

function vendoredVersion() {
  for (const target of TARGETS) {
    const probe = path.join(target.dir, "gws-shared", "SKILL.md");
    const alt = fs.existsSync(target.dir) ? fs.readdirSync(target.dir)[0] : null;
    const file = fs.existsSync(probe) ? probe : alt ? path.join(target.dir, alt, "SKILL.md") : null;
    if (!file || !fs.existsSync(file)) continue;
    const match = fs.readFileSync(file, "utf8").match(/^\s*version:\s*(.+)$/m);
    if (match) return match[1].trim();
  }
  return null;
}

function listSkills(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const only = [...args].find((a) => a.startsWith("--only="))?.slice("--only=".length) ?? null;
const targets = only ? TARGETS.filter((t) => t.id === only) : TARGETS;
if (!targets.length) {
  fail(`--only must be one of: ${TARGETS.map((t) => t.id).join(", ")}`);
}

const current = gwsVersion();
const vendored = vendoredVersion();
process.stdout.write(`gws CLI: ${current}\nvendored: ${vendored ?? "(none yet)"}\n`);
if (vendored === current && !force) {
  process.stdout.write("Already in sync. Pass --force to regenerate anyway.\n");
  process.exit(0);
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "gws-skills-"));
try {
  // chdir + relative --output-dir: the CLI validates the path against the cwd.
  const result = spawnSync("gws", ["generate-skills", "--output-dir", "skills"], {
    cwd: stage,
    encoding: "utf8"
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || `exit ${result.status}`;
    fail(`\`gws generate-skills\` failed: ${detail}`);
  }

  const generatedDir = path.join(stage, "skills");
  const generated = listSkills(generatedDir);
  if (generated.length < MIN_EXPECTED_SKILLS) {
    fail(`only ${generated.length} skills generated (expected at least ${MIN_EXPECTED_SKILLS}). The CLI's output format may have changed — refusing to overwrite the vendored copies.`);
  }

  const unclaimed = generated.filter((name) => !TARGETS.some((t) => t.match(name)));
  if (unclaimed.length) {
    process.stdout.write(`\nWARNING: ${unclaimed.length} skill(s) match no target and were NOT vendored: ${unclaimed.join(", ")}\n`);
  }

  for (const target of targets) {
    const wanted = generated.filter(target.match);
    const before = new Set(listSkills(target.dir));
    fs.rmSync(target.dir, { recursive: true, force: true });
    fs.mkdirSync(target.dir, { recursive: true });
    for (const name of wanted) {
      fs.cpSync(path.join(generatedDir, name), path.join(target.dir, name), { recursive: true });
    }
    const after = new Set(wanted);
    const added = wanted.filter((n) => !before.has(n));
    const removed = [...before].filter((n) => !after.has(n));
    process.stdout.write(`\n${target.id}: ${wanted.length} skills → ${path.relative(PLUGINS_DIR, target.dir)}\n`);
    if (added.length) process.stdout.write(`  added:   ${added.join(", ")}\n`);
    if (removed.length) process.stdout.write(`  removed: ${removed.join(", ")}\n`);
  }
  process.stdout.write("\nReview the result with `git diff --stat` before committing.\n");
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
