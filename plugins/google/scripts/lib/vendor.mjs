// Shared mechanics for vendoring skills from an upstream source into plugins.
//
// Both sync scripts follow the same shape: acquire into a staging directory, sanity-check
// what came out, then swap it into the real tree and report what moved. Acquisition and
// drift detection differ per source (a local CLI vs a git clone; a stamped version vs a
// commit SHA), so only the middle is shared.
//
// The staging step is the point: generating in place would leave a half-written plugin if
// the source died midway.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function listSkills(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

// Every file under `dir`, relative and sorted, so digests are reproducible.
export function walkFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out.sort();
}

export function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Digest of "what this plugin ships": relpath + content, so an upstream commit that only
// touches another plugin's skills (or a README) is a no-op here instead of dirtying the tree.
export function treeHash(dir) {
  const hash = crypto.createHash("sha256");
  for (const rel of walkFiles(dir)) {
    hash.update(rel).update("\0").update(hashFile(path.join(dir, rel))).update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

// Copy a skill directory, normalising permissions. Upstream ships 9 files with the
// executable bit — including plain .md files — and nothing invokes them as ./script
// (verified: every invocation is `python3 <path>`), so 0644 is safe and keeps third-party
// executables from arriving pre-armed.
export function copySkill(from, to) {
  fs.cpSync(from, to, { recursive: true });
  for (const rel of walkFiles(to)) {
    fs.chmodSync(path.join(to, rel), 0o644);
  }
}

/**
 * Replace each target's skills/ directory with the staged selection.
 *
 * targets: [{ id, dir, names: string[] }]
 * resolve: (name) => absolute path of the staged skill directory
 *
 * Returns [{ id, dir, count, added, removed }] — `changed` is left to callers that can
 * hash their own previous state.
 */
export function swapIn({ targets, resolve, previousHashes = {} }) {
  const report = [];
  for (const target of targets) {
    const before = new Set(listSkills(target.dir));
    const beforeHashes = {};
    for (const name of before) {
      const skillDir = path.join(target.dir, name);
      if (fs.existsSync(skillDir)) beforeHashes[name] = treeHash(skillDir);
    }

    fs.rmSync(target.dir, { recursive: true, force: true });
    fs.mkdirSync(target.dir, { recursive: true });
    for (const name of target.names) {
      copySkill(resolve(name), path.join(target.dir, name));
    }

    const after = new Set(target.names);
    const known = previousHashes[target.id] ?? beforeHashes;
    report.push({
      id: target.id,
      dir: target.dir,
      count: target.names.length,
      added: target.names.filter((n) => !before.has(n)),
      removed: [...before].filter((n) => !after.has(n)),
      changed: target.names.filter(
        (n) => before.has(n) && known[n] && known[n] !== treeHash(path.join(target.dir, n))
      )
    });
  }
  return report;
}

export function printReport(report, rootDir) {
  for (const target of report) {
    process.stdout.write(`\n${target.id}: ${target.count} skills → ${path.relative(rootDir, target.dir)}\n`);
    if (target.added.length) process.stdout.write(`  added:   ${target.added.join(", ")}\n`);
    if (target.removed.length) process.stdout.write(`  removed: ${target.removed.join(", ")}\n`);
    if (target.changed.length) process.stdout.write(`  changed: ${target.changed.join(", ")}\n`);
  }
}
