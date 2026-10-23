import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteRunStore } from "@ling-stack/core";
import { inspectGitSummary, resolveSummaryWorkspace, parseSummaryNumstat } from "../dist/features/work-summary/git-summary.js";
import { parseSummaryPullRequest, readSummaryPullRequest, summarizePullRequestCi } from "../dist/features/work-summary/pull-requests.js";
import { readWorkSummary } from "../dist/features/work-summary/service.js";
import { SummaryCache } from "../dist/features/work-summary/cache.js";
import { inspectWorkspaceChanges } from "../dist/features/previews/workspace-changes.js";

const noSecrets = { resolve: () => ({ configured: false }), status: () => ({ configured: false }) };
async function repository(t, commit = true) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-work-summary-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-b", "main"); git("config", "user.name", "Summary Test"); git("config", "user.email", "summary@example.invalid");
  await writeFile(join(cwd, ".gitignore"), ".ling-stack/\n.ling/\n");
  await writeFile(join(cwd, "file.txt"), "base\n");
  if (commit) { git("add", "."); git("commit", "-m", "Initial summary fixture"); }
  return { cwd, git };
}

test("net summary cancels staged and reverse unstaged edits; details use the same baseline", async (t) => {
  const f = await repository(t);
  await writeFile(join(f.cwd, "file.txt"), "middle\n"); f.git("add", "file.txt");
  await writeFile(join(f.cwd, "file.txt"), "base\n");
  const summary = await inspectGitSummary(f.cwd);
  assert.equal(summary.changedFiles, 0); assert.equal(summary.additions, 0); assert.equal(summary.deletions, 0);
  const details = await inspectWorkspaceChanges(f.cwd, "2026-10-23T00:00:00Z", true);
  assert.equal(details.additions, 0); assert.equal(details.deletions, 0);
  await writeFile(join(f.cwd, "file.txt"), "final\nsecond\n");
  const next = await inspectGitSummary(f.cwd);
  assert.equal(next.additions, 2); assert.equal(next.deletions, 1);
});

test("untracked text, binary, newline in a path, rename, detached and unborn HEAD", async (t) => {
  const f = await repository(t);
  f.git("mv", "file.txt", "renamed\nfile.txt");
  await writeFile(join(f.cwd, "new.txt"), "one\ntwo");
  await writeFile(join(f.cwd, "image.bin"), Buffer.from([0, 1, 2]));
  f.git("checkout", "--detach");
  const summary = await inspectGitSummary(f.cwd);
  assert.equal(summary.state, "ready"); assert.equal(summary.branch, "HEAD");
  assert.equal(summary.additions, 2); assert.equal(summary.deletions, 0);
  assert.equal(summary.changedFiles, 3); assert.equal(summary.binaryFiles, 1);
  assert.equal(summary.commits[0].subject, "Initial summary fixture");
  const unborn = await repository(t, false);
  unborn.git("add", "file.txt");
  const initial = await inspectGitSummary(unborn.cwd);
  assert.equal(initial.state, "ready"); assert.equal(initial.headSha, undefined);
  assert.equal(initial.additions, 3); assert.equal(initial.deletions, 0); assert.equal(initial.commits.length, 0);
});

test("large untracked files produce unknown totals and non-Git directories do not look clean", async (t) => {
  const f = await repository(t);
  await writeFile(join(f.cwd, "large.txt"), "x".repeat(1024 * 1024 + 1));
  const summary = await inspectGitSummary(f.cwd);
  assert.equal(summary.partial, true); assert.equal(summary.additions, undefined);
  const folder = join(f.cwd, "outside"); await mkdir(folder);
  assert.equal(await resolveSummaryWorkspace(folder), f.cwd);
  const missing = await inspectGitSummary(join(f.cwd, "missing"));
  assert.equal(missing.state, "unavailable"); assert.equal(missing.additions, undefined);
});

test("numstat safely parses NUL-separated rename records and rejects partial records", () => {
  assert.deepEqual(parseSummaryNumstat("2\t1\t\0old\nname\0new\tname\0-\t-\tfile.bin\0"), { additions: 2, deletions: 1, changedFiles: 2, binaryFiles: 1 });
  assert.throws(() => parseSummaryNumstat("2\t1\t\0old\0"));
});

test("canonical worktree keys do not merge sibling worktrees", async (t) => {
  const f = await repository(t);
  const sibling = `${f.cwd}-sibling`; t.after(() => rm(sibling, { recursive: true, force: true }));
  f.git("worktree", "add", "-b", "sibling", sibling);
  assert.notEqual(await resolveSummaryWorkspace(f.cwd), await resolveSummaryWorkspace(sibling));
});

test("PR URL validation rejects arbitrary hosts, credentials, path injection and invalid numbers", () => {
  assert.equal(parseSummaryPullRequest("https://github.com/Owner/Repo/pull/12/files".replace("/files", "?x=1#top")).url, "https://github.com/owner/repo/pull/12");
  for (const url of ["https://example.com/a/b/pull/1", "https://user@github.com/a/b/pull/1", "http://github.com/a/b/pull/1", "https://github.com/a/b/pull/0", "https://github.com/a/b/pull/999999999999999999999999", "https://github.com/a/b/issues/1"]) assert.throws(() => parseSummaryPullRequest(url));
});

test("PR attachments survive store restart, deduplicate, detach and stay usable without authentication", async (t) => {
  const f = await repository(t); let store = createSqliteRunStore(f.cwd);
  t.after(() => store.close());
  const url = "https://github.com/ling-stack-org/ling-stack/pull/1";
  store.attachWorkSummaryPullRequest(url, "2026-10-23T00:00:00Z"); store.attachWorkSummaryPullRequest(url, "2026-10-24T00:00:00Z");
  store.close(); store = createSqliteRunStore(f.cwd);
  assert.equal(store.listWorkSummaryPullRequests().length, 1);
  const pull = await readSummaryPullRequest(store.listWorkSummaryPullRequests()[0], noSecrets);
  assert.equal(pull.url, url); assert.equal(pull.connection, "unconnected"); assert.equal(pull.state, "unknown");
  store.detachWorkSummaryPullRequest(url); assert.deepEqual(store.listWorkSummaryPullRequests(), []);
});

test("CI is evaluated for the current head and missing or paginated checks cannot become success", () => {
  const sha = "a".repeat(40); const statuses = { sha, state: "success", total_count: 1 };
  const check = { head_sha: sha, status: "completed", conclusion: "success" };
  assert.equal(summarizePullRequestCi(sha, statuses, { total_count: 1, check_runs: [check] }), "success");
  assert.equal(summarizePullRequestCi(sha, statuses, { total_count: 2, check_runs: [check] }), "unknown");
  assert.equal(summarizePullRequestCi(sha, { ...statuses, sha: "b".repeat(40) }, { total_count: 0, check_runs: [] }), "unknown");
  assert.equal(summarizePullRequestCi(sha, statuses, { total_count: 1, check_runs: [{ ...check, conclusion: "failure" }] }), "failure");
  assert.equal(summarizePullRequestCi(sha, statuses, { total_count: 1, check_runs: [{ ...check, status: "in_progress", conclusion: null }] }), "pending");
});

test("project aggregation shares a canonical workspace once and does not initialize another store", async (t) => {
  const f = await repository(t);
  const store = { paths: { cwd: f.cwd }, listLingThreads: () => [
    { id: "one", kind: "conversation", title: "One", status: "running" },
    { id: "two", kind: "conversation", title: "Two", status: "waiting_for_approval" }],
    listChannels: () => [], listTeammateDirectThreads: () => [], getRun: () => undefined, listWorkSummaryPullRequests: () => [] };
  const summary = await readWorkSummary(store, noSecrets);
  assert.equal(summary.sessions.length, 2); assert.equal(summary.workspaces.length, 1);
  assert.equal(summary.sessions[0].workspaceKey, summary.sessions[1].workspaceKey);
});

test("single-flight cache coalesces concurrent requests and retries after a rejected read", async () => {
  const cache = new SummaryCache(0); let calls = 0;
  const read = async () => { calls++; return 42; };
  assert.deepEqual(await Promise.all([cache.get("a", read), cache.get("a", read)]), [42, 42]); assert.equal(calls, 1);
  await assert.rejects(cache.get("error", async () => { throw new Error("offline"); }));
  assert.equal(await cache.get("error", read), 42);
});

test("staged deletion restored as untracked is measured against final file content", async (t) => {
  const f = await repository(t); f.git("rm", "file.txt");
  await writeFile(join(f.cwd, "file.txt"), "base\n");
  const restored = await inspectGitSummary(f.cwd);
  const restoredDetails = await inspectWorkspaceChanges(f.cwd, "now", true);
  assert.equal(restoredDetails.totalFileCount, 0); assert.equal(restoredDetails.additions, 0); assert.equal(restoredDetails.deletions, 0);
  assert.equal(restored.changedFiles, 0); assert.equal(restored.additions, 0); assert.equal(restored.deletions, 0);
  await writeFile(join(f.cwd, "file.txt"), "replacement\nextra\n");
  const replaced = await inspectGitSummary(f.cwd);
  assert.equal(replaced.changedFiles, 1); assert.equal(replaced.additions, 2); assert.equal(replaced.deletions, 1);
});

test("GitHub projection distinguishes merged, closed, draft and open; checks match head SHA", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let currentState = "open";
  globalThis.fetch = async (url, options) => {
    assert.equal(options.redirect, "error");
    const sha = "a".repeat(40);
    return { ok: true, json: async () => String(url).includes("/pulls/")
      ? { title: "PR fixture", state: currentState === "merged" ? "closed" : currentState, merged_at: currentState === "merged" ? "2026-10-23" : null, draft: currentState === "draft", head: { sha } }
      : String(url).includes("/check-runs") ? { total_count: 1, check_runs: [{ head_sha: sha, status: "completed", conclusion: "success" }] }
        : { sha, state: "success", total_count: 1 } };
  };
  const secrets = { resolve: () => ({ configured: true, value: "synthetic-test-token" }) };
  for (const [index, state] of ["merged", "closed", "draft", "open"].entries()) {
    currentState = state;
    const pull = await readSummaryPullRequest({ url: `https://github.com/a/b/pull/${index + 1}`, createdAt: "now" }, secrets);
    assert.equal(pull.state, state); assert.equal(pull.ci, "success"); assert.equal(pull.connection, "connected");
  }
});


test("thread kind determines navigation and only direct threads inherit private bindings", async (t) => {
  const f = await repository(t);
  const privateCwd = join(f.cwd, "private"); await mkdir(privateCwd);
  const store = { paths: { cwd: f.cwd }, listLingThreads: () => [
    { id: "conversation", kind: "conversation", teammateId: "ling_agent", title: "Chat", status: "open" },
    { id: "private-thread", kind: "teammate_direct", teammateId: "ling_agent", title: "Private", status: "open" },
    { id: "automation", kind: "automation", teammateId: "ling_agent", title: "Job", status: "open" }],
    listChannels: (options) => { assert.equal(options.limit, 500); return []; },
    listTeammateDirectThreads: (options) => { assert.equal(options.limit, 500); return [{ id: "direct", teammateId: "ling_agent", title: "Private", workspaceBinding: { mode: "local", status: "ready", executionPath: privateCwd } }]; },
    getRun: () => undefined, listWorkSummaryPullRequests: () => [] };
  const result = await readWorkSummary(store, noSecrets);
  assert.deepEqual(result.sessions.map((session) => [session.id, session.surface]), [
    ["conversation", "conversation"], ["private-thread", "teammate"], ["automation", "thread"]]);
  // The normal conversation stays in the project; the direct binding keeps its trusted child path.
  assert.equal(result.workspaces.length, 1);
  assert.equal(result.workspaces[0].cwd, f.cwd);
  const privateOnly = await readWorkSummary({ ...store, listLingThreads: () => [store.listLingThreads()[1]] }, noSecrets);
  assert.equal(privateOnly.workspaces[0].key, f.cwd);
  assert.equal(privateOnly.workspaces[0].cwd, privateCwd);
});

test("net details retain untracked binary changes and cancel a restored identical binary", async (t) => {
  const f = await repository(t);
  const binary = Buffer.from([0, 255, 1]);
  await writeFile(join(f.cwd, "image.bin"), binary);
  let details = await inspectWorkspaceChanges(f.cwd, "now", true);
  assert.equal(details.totalFileCount, 1);
  assert.match(details.files[0].diff, /Binary file changed/);
  f.git("add", "image.bin"); f.git("commit", "-m", "Add binary fixture");
  f.git("rm", "image.bin"); await writeFile(join(f.cwd, "image.bin"), binary);
  details = await inspectWorkspaceChanges(f.cwd, "now", true);
  assert.equal(details.totalFileCount, 0);
  await writeFile(join(f.cwd, "image.bin"), Buffer.from([0, 255, 2]));
  details = await inspectWorkspaceChanges(f.cwd, "now", true);
  assert.equal(details.totalFileCount, 1);
});
