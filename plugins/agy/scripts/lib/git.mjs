// Slim adaptation of openai/codex-plugin-cc (Apache-2.0): plugins/codex/scripts/lib/git.mjs
// Collects git diff context for review prompts. The whole prompt travels as a single
// argv token to `agy --print=…`, and Linux caps one argv string at 128 KiB (MAX_ARG_STRLEN),
// so the diff budget stays well under that.

import { formatCommandFailure, runCommand } from "./process.mjs";

export const DIFF_BUDGET_BYTES = 100 * 1024;

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, ...options });
}

function gitChecked(cwd, args, options = {}) {
  const result = git(cwd, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.error?.code === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  for (const candidate of ["main", "master", "trunk"]) {
    if (git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]).status === 0) {
      return candidate;
    }
    if (git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]).status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref>.");
}

export function truncateToBudget(text, budgetBytes) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= budgetBytes) {
    return { text, truncated: false, originalBytes: bytes };
  }
  let sliced = Buffer.from(text, "utf8").subarray(0, budgetBytes).toString("utf8");
  // Drop a possibly mangled trailing multi-byte char and end on a line boundary.
  const lastNewline = sliced.lastIndexOf("\n");
  if (lastNewline > 0) {
    sliced = sliced.slice(0, lastNewline);
  }
  return { text: sliced, truncated: true, originalBytes: bytes };
}

export function collectReviewContext(cwd, options = {}) {
  const repoRoot = ensureGitRepository(cwd);
  const branch = gitChecked(repoRoot, ["branch", "--show-current"]).stdout.trim() || "HEAD";

  let label;
  let diffArgs;
  let statText;

  if (options.base) {
    const mergeBase = gitChecked(repoRoot, ["merge-base", "HEAD", options.base]).stdout.trim();
    const range = `${mergeBase}..HEAD`;
    label = `branch ${branch} against ${options.base} (merge-base ${mergeBase.slice(0, 12)})`;
    diffArgs = ["diff", "--no-ext-diff", range];
    statText = gitChecked(repoRoot, ["-c", "core.quotePath=false", "diff", "--stat", range]).stdout.trim();
  } else {
    const status = gitChecked(repoRoot, ["-c", "core.quotePath=false", "status", "--short", "--untracked-files=all"]).stdout.trim();
    if (!status) {
      const base = detectDefaultBranch(repoRoot);
      return collectReviewContext(cwd, { ...options, base });
    }
    label = `working tree of ${branch}`;
    diffArgs = null;
    statText = status;
  }

  let rawDiff;
  try {
    if (diffArgs) {
      rawDiff = gitChecked(repoRoot, diffArgs).stdout;
    } else {
      const staged = gitChecked(repoRoot, ["diff", "--cached", "--no-ext-diff"]).stdout;
      const unstaged = gitChecked(repoRoot, ["diff", "--no-ext-diff"]).stdout;
      // -z + quotePath=false: names come back raw and NUL-separated, so files like
      // diseño.md survive; "--" keeps dash-leading names from parsing as switches.
      const untrackedFiles = gitChecked(repoRoot, ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "-z"])
        .stdout.split("\0").filter(Boolean);
      const untrackedDiffs = untrackedFiles
        .map((file) => {
          const result = git(repoRoot, ["diff", "--no-ext-diff", "--no-index", "--", "/dev/null", file]);
          // git diff --no-index exits 1 when files differ; that is the expected case.
          return result.error ? "" : result.stdout;
        })
        .join("");
      rawDiff = [staged, unstaged, untrackedDiffs].filter(Boolean).join("\n");
    }
  } catch (error) {
    if (error?.code === "ENOBUFS" || /ENOBUFS/.test(error?.message ?? "")) {
      throw new Error("The diff exceeds 32 MiB and cannot be captured. Commit or stash generated/vendored files, or pass --base <ref> to narrow the review.");
    }
    throw error;
  }

  const { text: diff, truncated, originalBytes } = truncateToBudget(rawDiff, options.budgetBytes ?? DIFF_BUDGET_BYTES);

  return { repoRoot, branch, label, statText, diff, truncated, originalBytes };
}
