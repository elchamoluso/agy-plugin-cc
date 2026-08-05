#!/usr/bin/env node
// Remove the hand-made ~/.claude/skills/ symlinks that pointed at a googleworkspace/cli
// checkout, now that the same skills ship inside this plugin.
//
// DRY RUN BY DEFAULT. Pass --apply to actually delete.
//
// Every guard here exists because this deletes things in the user's config directory:
//   * only entries that are symlinks — a real directory is someone's own work;
//   * only symlinks resolving INSIDE the gws checkout — ~/.claude/skills also holds
//     links to other projects (vercel-labs/agent-skills among them) that must survive;
//   * only when the plugin actually provides a skill of the same name, so nothing is
//     removed before its replacement exists;
//   * broken symlinks are reported, never deleted silently.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SKILLS_DIR = path.join(os.homedir(), ".claude", "skills");
const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..", "..");
const PROVIDERS = [
  path.join(PLUGIN_ROOT, "google", "skills"),
  path.join(PLUGIN_ROOT, "google-workspace-recipes", "skills")
];

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const sourceArg = [...args].find((a) => a.startsWith("--source="))?.slice("--source=".length);
const SOURCE = path.resolve(sourceArg ?? path.join(os.homedir(), "dev", "googleworkspace", "cli", "skills"));

function provided() {
  const names = new Set();
  for (const dir of PROVIDERS) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "SKILL.md"))) {
        names.add(entry.name);
      }
    }
  }
  return names;
}

if (!fs.existsSync(SKILLS_DIR)) {
  process.stdout.write(`${SKILLS_DIR} does not exist — nothing to do.\n`);
  process.exit(0);
}

const available = provided();
if (!available.size) {
  process.stderr.write("The plugin provides no skills yet. Run sync-gws-skills.mjs first — refusing to remove anything.\n");
  process.exit(1);
}

const remove = [];
const keep = [];
const broken = [];

for (const name of fs.readdirSync(SKILLS_DIR).sort()) {
  const entry = path.join(SKILLS_DIR, name);
  let stat;
  try {
    stat = fs.lstatSync(entry);
  } catch {
    continue;
  }
  if (!stat.isSymbolicLink()) {
    keep.push([name, "not a symlink"]);
    continue;
  }
  let target;
  try {
    target = fs.realpathSync(entry);
  } catch {
    broken.push([name, `dangling → ${fs.readlinkSync(entry)}`]);
    continue;
  }
  if (!(target === SOURCE || target.startsWith(`${SOURCE}${path.sep}`))) {
    keep.push([name, `points outside the gws checkout → ${target}`]);
    continue;
  }
  if (!available.has(name)) {
    keep.push([name, "the plugin does not provide a replacement"]);
    continue;
  }
  remove.push([name, target]);
}

const pad = Math.max(0, ...[...remove, ...keep, ...broken].map(([n]) => n.length));
process.stdout.write(`Legacy skill symlinks in ${SKILLS_DIR}\nMatching source: ${SOURCE}\n\n`);

if (remove.length) {
  process.stdout.write(`To remove (${remove.length}) — superseded by the plugin:\n`);
  for (const [name] of remove) process.stdout.write(`  - ${name}\n`);
  process.stdout.write("\n");
}
if (keep.length) {
  process.stdout.write(`Keeping (${keep.length}):\n`);
  for (const [name, why] of keep) process.stdout.write(`  ✓ ${name.padEnd(pad)}  ${why}\n`);
  process.stdout.write("\n");
}
if (broken.length) {
  process.stdout.write(`Broken, NOT touched (${broken.length}) — clean these up by hand:\n`);
  for (const [name, why] of broken) process.stdout.write(`  ! ${name.padEnd(pad)}  ${why}\n`);
  process.stdout.write("\n");
}

if (!remove.length) {
  process.stdout.write("Nothing to remove.\n");
  process.exit(0);
}

if (!apply) {
  process.stdout.write(`DRY RUN — nothing was deleted. Re-run with --apply to remove those ${remove.length} symlinks.\n`);
  process.exit(0);
}

let removed = 0;
for (const [name] of remove) {
  const entry = path.join(SKILLS_DIR, name);
  try {
    // unlinkSync on a symlink removes the link, never the target.
    fs.unlinkSync(entry);
    removed += 1;
  } catch (error) {
    process.stderr.write(`  failed to remove ${name}: ${error.message}\n`);
  }
}
process.stdout.write(`Removed ${removed} of ${remove.length} symlinks.\nThe same skills now come from the plugin — restart Claude Code to pick up the change.\n`);
