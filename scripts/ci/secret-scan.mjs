import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const HISTORY_LOG_OPTIONS = ["--full-history", "--diff-merges=first-parent"];
const COMMIT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
// These are the policy files explicitly passed to Gitleaks by CI.
const SCANNER_POLICY_PATHS = [":(top,literal).gitleaks.toml", ":(top,literal).gitleaksignore"];

function git(cwd, args) {
  return execFileSync("git", ["-c", "color.ui=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    timeout: 30_000,
  }).trim();
}

function resolveCommit(cwd, revision) {
  if (typeof revision !== "string" || revision.length === 0 || revision.startsWith("-") || /[\s\u0000-\u001f\u007f]/u.test(revision)) {
    throw new Error("Expected a single non-option Git revision.");
  }
  const commit = git(cwd, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]);
  if (!COMMIT_ID.test(commit)) throw new Error("Git revision did not resolve to one commit ID.");
  return commit;
}

/**
 * Plan Gitleaks' git-log arguments, never a working-tree or endpoint file diff.
 * Full mode means all history reachable from the validated head, like CI's
 * previous HEAD scan; it cannot restore history missing from a shallow clone.
 * Invalid heads throw even on full-scan events. Uncertain baselines fall back.
 * @param {{eventName?: string, base?: string, head?: string, cwd?: string}} input
 * @returns {{mode: "range"|"full", logOpts: string, reason: string}}
 */
export function planSecretScan({ eventName, base, head = "HEAD", cwd = process.cwd() } = {}) {
  let headCommit;
  try {
    headCommit = resolveCommit(cwd, head);
  } catch (error) {
    throw new Error("Secret scan head is invalid or cannot be resolved to a commit.", { cause: error });
  }

  const full = (reason) => ({
    mode: "full",
    logOpts: [...HISTORY_LOG_OPTIONS, headCommit].join(" "),
    reason,
  });
  if (eventName !== "pull_request") return full("Non-PR event requires full history.");
  if (base === undefined || base === null || base === "") return full("PR base is missing.");

  let baseCommit;
  try {
    baseCommit = resolveCommit(cwd, base);
  } catch {
    return full("PR base is invalid or unavailable.");
  }

  try {
    if (git(cwd, ["rev-parse", "--is-shallow-repository"]) !== "false") {
      return full("Repository is shallow or its history completeness is unknown.");
    }
  } catch {
    return full("Repository history completeness could not be determined.");
  }

  let baselines;
  try {
    baselines = git(cwd, ["merge-base", "--all", baseCommit, headCommit]).split(/\r?\n/u);
  } catch {
    return full("Safe merge-base is unavailable.");
  }
  if (baselines.length !== 1 || !COMMIT_ID.test(baselines[0])) {
    return full("Safe merge-base is missing or ambiguous.");
  }

  const range = `${baselines[0]}..${headCommit}`;
  try {
    // Inspect every commit, including reverted policy edits and merge-only edits.
    // An endpoint diff would miss these and could skip newly unignored history.
    const policyChange = git(cwd, [
      "log", "--format=%H", "--max-count=1", ...HISTORY_LOG_OPTIONS, "--no-patch", range,
      "--", ...SCANNER_POLICY_PATHS,
    ]);
    if (policyChange) return full("Gitleaks configuration or ignore policy changed in PR history.");
  } catch {
    return full("Gitleaks policy history could not be inspected safely.");
  }

  return {
    mode: "range",
    // Diff merge commits against their first parent without restricting traversal
    // to the first-parent chain: merged branches may contain removed secrets.
    logOpts: [...HISTORY_LOG_OPTIONS, range].join(" "),
    reason: "All PR commits after the unique safe merge-base, including merge resolutions.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: { event: { type: "string" }, base: { type: "string" }, head: { type: "string" } },
      allowPositionals: false,
      strict: true,
    });
    console.log(JSON.stringify(planSecretScan({ eventName: values.event, base: values.base, head: values.head })));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Secret scan planning failed.");
    process.exitCode = 1;
  }
}
