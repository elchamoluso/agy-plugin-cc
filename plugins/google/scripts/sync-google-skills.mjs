#!/usr/bin/env node
// Vendor Google's official Agent Skills from github.com/google/skills.
//
// Google publishes ~100 SKILL.md files under Apache-2.0, but its own
// .claude-plugin/marketplace.json serves only 16 database plugins — the skills themselves
// have no plugin channel. The alternative, `npx skills add google/skills`, drops them
// loose into ~/.claude/skills, which is the pattern this repo deliberately moved away
// from. So they get vendored, split across four plugins by cost.
//
// Files are copied BYTE-FOR-BYTE. Apache-2.0 §4(d) only demands a modification notice if
// you modify, and the per-file digests in .source.json are what make "unmodified"
// verifiable. Do not rewrite frontmatter here.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { listSkills, swapIn, printReport, treeHash, hashFile, walkFiles } from "./lib/vendor.mjs";

const REPO = "https://github.com/google/skills.git";
const PLUGINS_DIR = path.resolve(import.meta.dirname, "..", "..");
const SOURCE_FILE = ".source.json";

// Ordered; first match wins. The last is an explicit catch-all so a category Google adds
// later can never vanish silently.
//
// `gke-` is matched by NAME before category on purpose: Google files 12 of its 28 gke-*
// skills outside Containers (under Observability, Security, Networking, Storage), and 17
// of the 28 cross-reference each other by name in their own descriptions — gke-basics
// points at gke-networking, gke-platform-security and gke-workload-security, all three
// outside Containers. Splitting by category alone would leave those references dangling.
const TARGETS = [
  {
    id: "gke",
    plugin: "google-cloud-gke-skills",
    match: (s) => s.name.startsWith("gke-") || s.category === "Containers",
    min: 24
  },
  {
    id: "ai",
    plugin: "google-cloud-ai-skills",
    match: (s) => s.category === "AiAndMachineLearning",
    min: 18
  },
  {
    id: "ads",
    plugin: "google-ads-skills",
    match: (s) => s.category === "GoogleAds" || s.category === "GoogleAnalytics",
    min: 12
  },
  {
    id: "core",
    plugin: "google-cloud-skills",
    match: () => true,
    min: 30,
    catchAll: true
  }
];

// Categories deliberately not routed anywhere. Empty today; entries here are skipped with
// a notice instead of falling into core.
const KNOWN_UNROUTED = new Set();

// Categories we have looked at and decided belong in the catch-all. The catch-all would
// otherwise absorb anything Google invents without anyone noticing, so this list is what
// turns "landed in core" into a decision that was actually made. A category outside it
// stops the run.
const CORE_CATEGORIES = new Set([
  "BigDataAndAnalytics",
  "CloudInfrastructure",
  "CloudInfrastructureAndServices",
  "CloudObservabilityAndMonitoring",
  "Compute",
  "Databases",
  "DevOps",
  "GettingStarted",
  "Networking",
  "Security",
  "Serverless",
  "Storage",
  "WellArchitectedFramework"
]);

// Plugins whose skills must not collide with the vendored ones.
const NEIGHBOURS = ["google", "google-workspace-recipes", "agy"];

const EXIT_NEW_CATEGORY = 2;

function fail(message, code = 1) {
  process.stderr.write(`sync-google-skills: ${message}\n`);
  process.exit(code);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function targetDir(target) {
  return path.join(PLUGINS_DIR, target.plugin, "skills");
}

function sourcePath(target) {
  return path.join(PLUGINS_DIR, target.plugin, SOURCE_FILE);
}

function readSource(target) {
  try {
    return JSON.parse(fs.readFileSync(sourcePath(target), "utf8"));
  } catch {
    return null;
  }
}

// Frontmatter parsing. Two shapes in the wild, both real:
//   * metadata.category is indented 2 spaces in 100 files and 4 in
//     cloud/google-cloud-storage-basics — a /^  category:/m regex loses that one silently;
//   * description uses `>-` in some files and `|` in others, and `name` is not always first.
// So: match category at ANY indentation, and treat a missing one as a sentinel rather than
// as a reason to guess.
function parseSkill(file) {
  const text = fs.readFileSync(file, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const frontmatter = match[1];
  const name = /^name:[ \t]*(.+)$/m.exec(frontmatter)?.[1].trim().replace(/^["']|["']$/g, "");
  const category = /^[ \t]+category:[ \t]*(.+)$/m.exec(frontmatter)?.[1].trim().replace(/^["']|["']$/g, "");
  return {
    name: name || path.basename(path.dirname(file)),
    category: category || "(none)",
    dir: path.dirname(file),
    frontmatterBytes: Buffer.byteLength(frontmatter, "utf8")
  };
}

function collectSkills(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "SKILL.md") {
        const skill = parseSkill(full);
        if (skill) out.push(skill);
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Google's descriptions are long — up to 1069 chars — so the always-on cost of a target is
// worth printing before anyone installs it.
//
// This is a LOWER BOUND, not the real figure: it counts frontmatter bytes only, while
// Claude Code adds per-skill scaffolding on top. Measured against `claude plugin details`
// it runs ~20-40% low (e.g. 5035 estimated vs 6325 actual). Use it to compare targets
// against each other; use `claude plugin details <name>` for the number that goes in a README.
function estimateTokens(skills) {
  return Math.round(skills.reduce((sum, s) => sum + s.frontmatterBytes, 0) / 4);
}

function neighbourSkillNames() {
  const names = new Map();
  for (const plugin of NEIGHBOURS) {
    for (const name of listSkills(path.join(PLUGINS_DIR, plugin, "skills"))) {
      names.set(name, plugin);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const force = flag("force");
const dryRun = flag("dry-run");
const explain = flag("explain");
const acceptNew = flag("accept-new-categories");
const ref = value("ref") ?? "main";
const only = value("only");
const targets = only ? TARGETS.filter((t) => t.id === only) : TARGETS;
if (!targets.length) {
  fail(`--only must be one of: ${TARGETS.map((t) => t.id).join(", ")}`);
}

// Resolve upstream first: one network round-trip beats cloning 3.8 MB to learn nothing.
const remote = run("git", ["ls-remote", REPO, ref]);
if (remote.error || remote.status !== 0) {
  fail(`could not reach ${REPO} (${remote.error?.message || remote.stderr.trim()})`);
}
const remoteSha = remote.stdout.trim().split(/\s+/)[0];
if (!remoteSha) fail(`ref "${ref}" not found in ${REPO}`);

const recorded = TARGETS.map((t) => readSource(t)?.commit).filter(Boolean);
const distinct = new Set(recorded);
if (distinct.size > 1) {
  process.stdout.write(
    `WARNING: the four plugins record different commits (${[...distinct].map((c) => c.slice(0, 8)).join(", ")}). ` +
      "Someone ran --only=. Re-run without it to bring them back in step.\n"
  );
}

process.stdout.write(`upstream ${REPO}#${ref}\n  remote:   ${remoteSha}\n  vendored: ${recorded.length ? [...distinct].map((c) => c.slice(0, 12)).join(", ") : "(none yet)"}\n`);
if (distinct.size === 1 && distinct.has(remoteSha) && recorded.length === TARGETS.length && !force) {
  process.stdout.write("Already in sync. Pass --force to re-vendor anyway.\n");
  process.exit(0);
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "google-skills-"));
try {
  // --no-recurse-submodules is mandatory: google/skills has a .gitmodules pointing at 16
  // gemini-cli-extensions repos, none of which we want.
  const clone = run("git", [
    "clone", "--depth", "1", "--single-branch", "--no-recurse-submodules",
    "--branch", ref, REPO, stage
  ]);
  if (clone.error || clone.status !== 0) {
    // A SHA cannot be cloned with --branch; fall back to fetching it explicitly.
    const init = run("git", ["init", "-q", stage]);
    if (init.status !== 0) fail(`git init failed: ${init.stderr.trim()}`);
    run("git", ["remote", "add", "origin", REPO], { cwd: stage });
    const fetch = run("git", ["fetch", "-q", "--depth", "1", "origin", remoteSha], { cwd: stage });
    if (fetch.status !== 0) fail(`could not fetch ${remoteSha}: ${fetch.stderr.trim()}`);
    const checkout = run("git", ["checkout", "-q", "FETCH_HEAD"], { cwd: stage });
    if (checkout.status !== 0) fail(`could not check out ${remoteSha}: ${checkout.stderr.trim()}`);
  }

  const head = run("git", ["rev-parse", "HEAD"], { cwd: stage }).stdout.trim();
  const headDate = run("git", ["show", "-s", "--format=%cI", "HEAD"], { cwd: stage }).stdout.trim();

  const skillsRoot = path.join(stage, "skills");
  if (!fs.existsSync(skillsRoot)) fail(`${REPO} has no skills/ directory at ${head} — its layout changed.`);

  const skills = collectSkills(skillsRoot);
  if (!skills.length) fail("no SKILL.md files found upstream — refusing to overwrite anything.");

  // Shape assertion: catches an upstream frontmatter change before it silently reroutes
  // half the catalogue into core.
  const shapeless = skills.filter((s) => !s.name || s.category === "(none)");
  if (shapeless.length) {
    process.stdout.write(
      `\nWARNING: ${shapeless.length} skill(s) have no metadata.category and will fall into the catch-all: ` +
        `${shapeless.map((s) => s.name).join(", ")}\n`
    );
  }

  // Route.
  const routed = new Map(TARGETS.map((t) => [t.id, []]));
  const skipped = [];
  for (const skill of skills) {
    if (KNOWN_UNROUTED.has(skill.category)) {
      skipped.push(skill);
      continue;
    }
    const target = TARGETS.find((t) => t.match(skill));
    routed.get(target.id).push(skill);
    if (explain) {
      const why = target.catchAll ? "catch-all" : skill.name.startsWith("gke-") && target.id === "gke" ? "name gke-*" : `category ${skill.category}`;
      process.stdout.write(`  ${skill.name.padEnd(46)} ${target.id.padEnd(5)} (${why})\n`);
    }
  }
  if (skipped.length) {
    process.stdout.write(`\nSkipped ${skipped.length} skill(s) in unrouted categories: ${skipped.map((s) => s.name).join(", ")}\n`);
  }

  // A category nobody wrote a rule for lands in core AND stops the run, so it becomes a
  // decision instead of a silent default. Exit 2, not 1, so CI can tell "needs a human"
  // from "the sync broke".
  const newCategories = new Map();
  for (const skill of routed.get("core")) {
    if (CORE_CATEGORIES.has(skill.category) || skill.category === "(none)") continue;
    if (!newCategories.has(skill.category)) newCategories.set(skill.category, []);
    newCategories.get(skill.category).push(skill);
  }

  // Per-target minimum, not a global one: a global floor would let `ai` collapse to zero
  // while the total still looked healthy.
  for (const target of targets) {
    const got = routed.get(target.id).length;
    if (got < target.min) {
      fail(`target "${target.id}" matched only ${got} skills (expected at least ${target.min}). Upstream's shape may have changed — refusing to overwrite the vendored copies.`);
    }
  }

  // Collision check, re-asserted every run so it stays true as Google adds skills.
  const neighbours = neighbourSkillNames();
  const collisions = skills.filter((s) => neighbours.has(path.basename(s.dir)));
  if (collisions.length) {
    fail(`${collisions.length} incoming skill(s) collide with existing plugins: ${collisions.map((s) => `${path.basename(s.dir)} (in ${neighbours.get(path.basename(s.dir))})`).join(", ")}`);
  }

  process.stdout.write("\n");
  for (const target of TARGETS) {
    const group = routed.get(target.id);
    const mark = targets.includes(target) ? " " : "-";
    process.stdout.write(`${mark} ${target.plugin.padEnd(26)} ${String(group.length).padStart(3)} skills  ~${estimateTokens(group)} tok always-on\n`);
  }
  process.stdout.write(`  ${"total".padEnd(26)} ${String(skills.length).padStart(3)} skills  ~${estimateTokens(skills)} tok\n`);

  // Printed before the dry-run exit as well: a dry run that hides which category is new is
  // useless precisely when you need it.
  const reportNewCategories = () => {
    if (!newCategories.size) return;
    process.stdout.write("\nNEW CATEGORY — these fell into the catch-all because no rule claims them:\n");
    for (const [category, group] of newCategories) {
      process.stdout.write(`  ${category}: ${group.length} skill(s), ~${estimateTokens(group)} tok — ${group.map((s) => s.name).join(", ")}\n`);
    }
    process.stdout.write("Decide where they belong (edit TARGETS or CORE_CATEGORIES), or re-run with --accept-new-categories.\n");
  };

  if (dryRun) {
    reportNewCategories();
    process.stdout.write("\nDRY RUN — nothing written.\n");
    process.exit(newCategories.size && !acceptNew ? EXIT_NEW_CATEGORY : 0);
  }

  const byName = new Map(skills.map((s) => [path.basename(s.dir), s.dir]));
  const previousHashes = Object.fromEntries(
    targets.map((t) => [t.id, readSource(t)?.skills ?? {}])
  );
  const report = swapIn({
    targets: targets.map((t) => ({
      id: t.id,
      dir: targetDir(t),
      names: routed.get(t.id).map((s) => path.basename(s.dir))
    })),
    resolve: (name) => byName.get(name),
    previousHashes
  });
  printReport(report, PLUGINS_DIR);

  // Provenance. Lives at the plugin root, not inside skills/, so the swap never eats it.
  for (const target of targets) {
    const dir = targetDir(target);
    const perSkill = {};
    for (const name of listSkills(dir)) perSkill[name] = treeHash(path.join(dir, name));
    const executables = {};
    for (const rel of walkFiles(dir)) {
      if (/\.(sh|py|js|tf|Dockerfile)$/.test(rel) || rel.includes("/scripts/")) {
        executables[rel] = hashFile(path.join(dir, rel));
      }
    }
    fs.writeFileSync(
      sourcePath(target),
      `${JSON.stringify({
        repo: REPO,
        ref,
        commit: head,
        commitDate: headDate,
        license: "Apache-2.0",
        verbatim: true,
        syncedBy: "plugins/google/scripts/sync-google-skills.mjs",
        skillCount: listSkills(dir).length,
        treeHash: treeHash(dir),
        skills: perSkill,
        executables
      }, null, 2)}\n`
    );
  }

  reportNewCategories();

  process.stdout.write("\nReview the result with `git diff --stat` before committing.\n");
  if (newCategories.size && !acceptNew) process.exit(EXIT_NEW_CATEGORY);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
