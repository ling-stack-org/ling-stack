import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { planSecretScan } from "./secret-scan.mjs";

const scriptPath = fileURLToPath(new URL("./secret-scan.mjs", import.meta.url));
const fixtureEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: devNull,
  GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
};
const policyFiles = {
  ".gitleaks.toml": "[extend]\nuseDefault = true\n",
  ".gitleaksignore": "# reviewed fixture fingerprints\n",
};

function git(cwd, ...args) {
  return execFileSync("git", [
    "-c", "user.name=Secret scan fixture", "-c", "user.email=secret-scan-fixture@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + devNull,
    "-c", "core.autocrlf=false", "-c", "color.ui=false", ...args,
  ], { cwd, env: fixtureEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), "ling-secret-scan-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, "init", "--quiet", "--initial-branch=main", "--template=");
  function commit(files, message) {
    for (const [path, content] of Object.entries(files)) {
      const target = join(cwd, path);
      if (content === null) {
        rmSync(target);
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
    }
    git(cwd, "add", "--all");
    git(cwd, "commit", "--quiet", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  }
  const root = commit({ ...policyFiles, "baseline.txt": "HISTORICAL_FIXTURE_MARKER\n", "conflict.txt": "shared\n" }, "baseline");
  return { cwd, root, commit };
}

function plan(repo, base = repo.root, extra = {}) {
  return planSecretScan({ cwd: repo.cwd, eventName: "pull_request", base, ...extra });
}

function log(repo, scan) {
  // Match Gitleaks' git log -p -U0 invocation and space-splitting of logOpts.
  return git(repo.cwd, "log", "-p", "-U0", ...scan.logOpts.split(" "));
}

function commits(repo, scan) {
  const output = git(repo.cwd, "log", "--format=%H", ...scan.logOpts.split(" "), "--no-patch");
  return output ? output.split(/\r?\n/u).sort() : [];
}

function assertFull(repo, scan, reason, head = "HEAD") {
  assert.equal(scan.mode, "full");
  assert.match(scan.reason, reason);
  assert.equal(scan.logOpts, `--full-history --diff-merges=first-parent ${git(repo.cwd, "rev-parse", head)}`);
}

test("PR scans both commits of an introduced-then-deleted secret with an empty endpoint diff", (t) => {
  const repo = repository(t);
  const introduced = repo.commit({ "transient.txt": "TRANSIENT_SECRET_MARKER\n" }, "introduce marker");
  const removed = repo.commit({ "transient.txt": null }, "remove marker");
  assert.equal(git(repo.cwd, "diff", repo.root, removed), "");

  const scan = plan(repo);
  assert.equal(scan.mode, "range");
  assert.equal(scan.logOpts, `--full-history --diff-merges=first-parent ${repo.root}..${removed}`);
  assert.deepEqual(commits(repo, scan), [introduced, removed].sort());
  assert.match(log(repo, scan), /^\+TRANSIENT_SECRET_MARKER$/mu);
  assert.doesNotMatch(log(repo, scan), /HISTORICAL_FIXTURE_MARKER/u);
});

test("divergent base and head use their merge-base, not either branch's endpoint tree", (t) => {
  const repo = repository(t);
  git(repo.cwd, "branch", "feature");
  const base = repo.commit({ "base-only.txt": "BASE_ONLY_MARKER\n" }, "base advanced");
  git(repo.cwd, "checkout", "--quiet", "feature");
  const head = repo.commit({ "feature.txt": "FEATURE_MARKER\n" }, "feature advanced");

  const scan = plan(repo, "refs/heads/main");
  assert.equal(scan.logOpts, `--full-history --diff-merges=first-parent ${repo.root}..${head}`);
  assert.deepEqual(commits(repo, scan), [head]);
  assert.ok(!commits(repo, scan).includes(base));
  assert.match(log(repo, scan), /^\+FEATURE_MARKER$/mu);
  assert.doesNotMatch(log(repo, scan), /BASE_ONLY_MARKER/u);
});

test("a tree-same merge retains second-parent commits containing a removed secret", (t) => {
  const repo = repository(t);
  git(repo.cwd, "branch", "side");
  const main = repo.commit({ "main.txt": "main change\n" }, "main change");
  git(repo.cwd, "checkout", "--quiet", "side");
  const introduced = repo.commit({ "side.txt": "SECOND_PARENT_SECRET_MARKER\n" }, "side introduction");
  const removed = repo.commit({ "side.txt": null }, "side removal");
  git(repo.cwd, "checkout", "--quiet", "main");
  git(repo.cwd, "merge", "--quiet", "--no-ff", "side", "-m", "merge side");
  const merge = git(repo.cwd, "rev-parse", "HEAD");
  assert.equal(git(repo.cwd, "diff", main, merge), "");

  const scan = plan(repo);
  assert.equal(scan.mode, "range");
  assert.deepEqual(commits(repo, scan), [main, introduced, removed, merge].sort());
  assert.match(log(repo, scan), /^\+SECOND_PARENT_SECRET_MARKER$/mu);
  assert.ok(!scan.logOpts.split(" ").includes("--first-parent"));
});

test("real conflict-resolution additions survive a later revert and are present in the planned patch stream", (t) => {
  const repo = repository(t);
  git(repo.cwd, "branch", "side");
  const main = repo.commit({ "conflict.txt": "main version\n" }, "main conflict");
  git(repo.cwd, "checkout", "--quiet", "side");
  const side = repo.commit({ "conflict.txt": "side version\n" }, "side conflict");
  git(repo.cwd, "checkout", "--quiet", "main");
  assert.throws(() => git(repo.cwd, "merge", "--no-ff", "side", "-m", "conflicting merge"), (error) => error.status === 1);
  assert.match(readFileSync(join(repo.cwd, "conflict.txt"), "utf8"), /^<<<<<<< /mu);
  const merge = repo.commit({ "conflict.txt": "MERGE_RESOLUTION_SECRET_MARKER\n" }, "resolve conflict");
  const reverted = repo.commit({ "conflict.txt": "shared\n" }, "restore original content");
  assert.equal(git(repo.cwd, "rev-parse", `${merge}^1`), main);
  assert.equal(git(repo.cwd, "rev-parse", `${merge}^2`), side);
  assert.equal(git(repo.cwd, "diff", repo.root, reverted), "");
  assert.doesNotMatch(git(repo.cwd, "log", "-p", "-U0", "--diff-merges=off", `${repo.root}..${reverted}`), /^\+MERGE_RESOLUTION_SECRET_MARKER$/mu);

  const scan = plan(repo);
  assert.equal(scan.mode, "range");
  assert.deepEqual(commits(repo, scan), [main, side, merge, reverted].sort());
  assert.match(log(repo, scan), /^\+MERGE_RESOLUTION_SECRET_MARKER$/mu);
});

test("GitHub-style synthetic merge heads include the PR branch, not already-baselined base commits", (t) => {
  const repo = repository(t);
  git(repo.cwd, "branch", "feature");
  const base = repo.commit({ "base.txt": "BASE_ADVANCE_MARKER\n" }, "base advanced");
  git(repo.cwd, "checkout", "--quiet", "feature");
  const introduced = repo.commit({ "feature.txt": "PR_BRANCH_SECRET_MARKER\n" }, "feature introduction");
  const removed = repo.commit({ "feature.txt": null }, "feature removal");
  git(repo.cwd, "checkout", "--quiet", "main");
  git(repo.cwd, "merge", "--quiet", "--no-ff", "feature", "-m", "synthetic PR merge");
  const merge = git(repo.cwd, "rev-parse", "HEAD");

  const scan = plan(repo, base);
  assert.equal(scan.logOpts, `--full-history --diff-merges=first-parent ${base}..${merge}`);
  assert.deepEqual(commits(repo, scan), [introduced, removed, merge].sort());
  assert.match(log(repo, scan), /^\+PR_BRANCH_SECRET_MARKER$/mu);
  assert.doesNotMatch(log(repo, scan), /BASE_ADVANCE_MARKER/u);
});

test("valid identical base and head produce an empty, explicitly bounded PR range", (t) => {
  const repo = repository(t);
  const scan = plan(repo);
  assert.equal(scan.mode, "range");
  assert.equal(scan.logOpts, `--full-history --diff-merges=first-parent ${repo.root}..${repo.root}`);
  assert.deepEqual(commits(repo, scan), []);
});

test("schedule, manual, missing, and unknown events scan full reachable head history", (t) => {
  const repo = repository(t);
  const head = repo.commit({ "new.txt": "new content\n" }, "new commit");
  for (const eventName of ["schedule", "workflow_dispatch", "push", "pull_request_target", "", undefined]) {
    const scan = plan(repo, repo.root, { eventName });
    assertFull(repo, scan, /Non-PR/u);
    assert.deepEqual(commits(repo, scan), [repo.root, head].sort());
    assert.match(log(repo, scan), /^\+HISTORICAL_FIXTURE_MARKER$/mu);
  }
});

test("missing, unknown, malformed, option-like, and non-commit bases conservatively scan full history", (t) => {
  const repo = repository(t);
  const blob = git(repo.cwd, "rev-parse", "HEAD:baseline.txt");
  for (const base of [undefined, null, "", "unknown-base", "0".repeat(40), "--all", "--not", "HEAD --all", "HEAD\n--all", "HEAD\0", "^HEAD", "HEAD..main", blob, 123]) {
    const scan = planSecretScan({ cwd: repo.cwd, eventName: "pull_request", base });
    assertFull(repo, scan, /base/u);
    assert.deepEqual(commits(repo, scan), [repo.root]);
  }
});

test("unrelated histories cannot supply a safe merge-base", (t) => {
  const repo = repository(t);
  const tree = git(repo.cwd, "rev-parse", "HEAD^{tree}");
  const unrelated = git(repo.cwd, "commit-tree", tree, "-m", "unrelated root");
  const scan = plan(repo, repo.root, { head: unrelated });
  assertFull(repo, scan, /merge-base.*unavailable/u, unrelated);
  assert.deepEqual(commits(repo, scan), [unrelated]);
});

test("criss-cross merges with multiple best merge-bases fall back to full history", (t) => {
  const repo = repository(t);
  const tree = git(repo.cwd, "rev-parse", "HEAD^{tree}");
  const left = git(repo.cwd, "commit-tree", tree, "-p", repo.root, "-m", "left");
  const right = git(repo.cwd, "commit-tree", tree, "-p", repo.root, "-m", "right");
  const base = git(repo.cwd, "commit-tree", tree, "-p", left, "-p", right, "-m", "left merge");
  const head = git(repo.cwd, "commit-tree", tree, "-p", right, "-p", left, "-m", "right merge");
  assert.deepEqual(git(repo.cwd, "merge-base", "--all", base, head).split(/\r?\n/u).sort(), [left, right].sort());

  const scan = plan(repo, base, { head });
  assertFull(repo, scan, /ambiguous/u, head);
  assert.deepEqual(commits(repo, scan), [repo.root, left, right, head].sort());
});

test("a shallow clone falls back even when both commits and a merge-base are available", (t) => {
  const repo = repository(t);
  const base = repo.commit({ "one.txt": "one\n" }, "one");
  repo.commit({ "two.txt": "two\n" }, "two");
  const clone = join(repo.cwd, "shallow-clone");
  git(repo.cwd, "clone", "--quiet", "--depth=2", pathToFileURL(repo.cwd).href, clone);
  assert.equal(git(clone, "rev-parse", "--is-shallow-repository"), "true");
  assert.equal(git(clone, "merge-base", base, "HEAD"), base);

  const scan = planSecretScan({ cwd: clone, eventName: "pull_request", base });
  assertFull({ cwd: clone }, scan, /shallow/u);
});

test("missing history objects never produce a narrow plan", (t) => {
  const repo = repository(t);
  const base = repo.commit({ "new.txt": "new\n" }, "new");
  repo.commit({ "later.txt": "later\n" }, "later");
  rmSync(join(repo.cwd, ".git", "objects", repo.root.slice(0, 2), repo.root.slice(2)));
  assertFull(repo, plan(repo, base), /merge-base.*unavailable/u);
});

test("unreadable policy history falls back when commit resolution and merge-base still succeed", (t) => {
  const repo = repository(t);
  const head = repo.commit({ "new.txt": "new\n" }, "new");
  const tree = git(repo.cwd, "rev-parse", "HEAD^{tree}");
  rmSync(join(repo.cwd, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
  assert.equal(git(repo.cwd, "merge-base", repo.root, head), repo.root);
  assertFull(repo, plan(repo), /policy history/u);
});

test("policy modifications, reverts, deletions, and additions require a full scan", async (t) => {
  for (const [path, original] of Object.entries(policyFiles)) {
    await t.test(path, (t) => {
      const repo = repository(t);
      repo.commit({ [path]: original + "# policy change\n" }, "edit policy");
      assertFull(repo, plan(repo), /policy changed/u);
      const restored = repo.commit({ [path]: original }, "restore policy");
      assert.equal(git(repo.cwd, "diff", repo.root, restored), "");
      assertFull(repo, plan(repo), /policy changed/u);
      const deleted = repo.commit({ [path]: null }, "delete policy");
      assertFull(repo, plan(repo, restored), /policy changed/u);
      repo.commit({ [path]: original }, "add policy");
      assertFull(repo, plan(repo, deleted), /policy changed/u);
    });
  }
});

test("policy edits introduced only by a merge commit trigger a full scan", (t) => {
  const repo = repository(t);
  git(repo.cwd, "branch", "side");
  repo.commit({ "main.txt": "main\n" }, "main");
  git(repo.cwd, "checkout", "--quiet", "side");
  repo.commit({ "side.txt": "side\n" }, "side");
  git(repo.cwd, "checkout", "--quiet", "main");
  git(repo.cwd, "merge", "--quiet", "--no-ff", "--no-commit", "side");
  const merge = repo.commit({ ".gitleaksignore": "# merge-only policy change\n" }, "merge policy edit");
  assert.equal(git(repo.cwd, "log", "--format=%H", "--no-merges", `${repo.root}..${merge}`, "--", ".gitleaksignore"), "");
  assertFull(repo, plan(repo), /policy changed/u);
});

test("root policy paths remain guarded when cwd is a repository subdirectory", (t) => {
  const repo = repository(t);
  repo.commit({ ".gitleaksignore": "# changed\n", "nested/file.txt": "nested\n" }, "policy and nested file");
  assertFull(repo, plan(repo, repo.root, { cwd: join(repo.cwd, "nested") }), /policy changed/u);
});

test("invalid heads throw for PR and non-PR events rather than returning a successful full plan", (t) => {
  const repo = repository(t);
  const blob = git(repo.cwd, "rev-parse", "HEAD:baseline.txt");
  for (const eventName of ["pull_request", "schedule", "workflow_dispatch"]) {
    for (const head of ["", null, 123, "unknown-head", "0".repeat(40), "--all", "--not", "HEAD --all", "HEAD\n--all", "HEAD\0", "^HEAD", "HEAD..main", blob]) {
      assert.throws(() => plan(repo, repo.root, { eventName, head }), /head.*invalid/u);
    }
  }
  git(repo.cwd, "symbolic-ref", "HEAD", "refs/heads/missing");
  assert.throws(() => plan(repo), /head.*invalid/u);
  assert.throws(() => plan(repo, undefined, { eventName: "schedule" }), /head.*invalid/u);
});

test("annotated tags and ordinary refs are resolved to immutable commit IDs before building logOpts", (t) => {
  const repo = repository(t);
  git(repo.cwd, "tag", "--no-sign", "-a", "baseline-tag", "-m", "baseline tag");
  const head = repo.commit({ "head.txt": "head\n" }, "head");
  const scan = plan(repo, "baseline-tag", { head: "refs/heads/main" });
  assert.equal(scan.logOpts, `--full-history --diff-merges=first-parent ${repo.root}..${head}`);
  assert.deepEqual(commits(repo, scan), [head]);
});

test("CLI emits exactly one JSON plan and supports the documented equals-style options", (t) => {
  const repo = repository(t);
  repo.commit({ "new.txt": "new\n" }, "new");
  const result = spawnSync(process.execPath, [scriptPath, "--event=pull_request", `--base=${repo.root}`, "--head=HEAD"], {
    cwd: repo.cwd, env: fixtureEnv, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(result.stdout), plan(repo));

  const full = spawnSync(process.execPath, [scriptPath, "--event=workflow_dispatch"], { cwd: repo.cwd, env: fixtureEnv, encoding: "utf8" });
  assert.equal(full.status, 0, full.stderr);
  assertFull(repo, JSON.parse(full.stdout), /Non-PR/u);
});

test("CLI rejects malformed arguments and invalid heads without emitting a green JSON plan", (t) => {
  const repo = repository(t);
  const injectedFile = join(repo.cwd, "injected-output");
  for (const args of [
    ["--event=pull_request", "--head=unknown-head"],
    ["--event=schedule", "--head="],
    ["--event=workflow_dispatch", "--head=--all"],
    [`--head=--output=${injectedFile}`],
    [`--head=HEAD;touch ${injectedFile}`],
    ["--unknown=option"], ["--event"], ["unexpected-positional"],
  ]) {
    const result = spawnSync(process.execPath, [scriptPath, ...args], { cwd: repo.cwd, env: fixtureEnv, encoding: "utf8" });
    assert.notEqual(result.status, 0, args.join(" "));
    assert.equal(result.stdout, "");
    assert.notEqual(result.stderr, "");
  }
  assert.equal(existsSync(injectedFile), false);

  const fallback = spawnSync(process.execPath, [scriptPath, "--event=pull_request", `--base=--output=${injectedFile}`], {
    cwd: repo.cwd, env: fixtureEnv, encoding: "utf8",
  });
  assert.equal(fallback.status, 0, fallback.stderr);
  assertFull(repo, JSON.parse(fallback.stdout), /base.*invalid/u);
  assert.equal(existsSync(injectedFile), false);
});
