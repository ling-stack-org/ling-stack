import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isCodeqlInput, selectCodeqlScan, verifyCodeqlUpload } from "./codeql-scope.mjs";

const now = Date.parse("2026-11-03T00:00:00Z");
const sha = "a".repeat(40);
const context = { eventName: "schedule", repo: { owner: "ling-stack-org", repo: "ling-stack" },
  ref: "refs/heads/main", sha, runId: 100 };
const run = (overrides = {}) => ({ id: 90, event: "schedule", head_sha: sha, head_branch: "main",
  head_repository: { full_name: "ling-stack-org/ling-stack" }, status: "completed", conclusion: "success", run_attempt: 1, ...overrides });
const job = (overrides = {}) => ({ name: "Analyze JavaScript/TypeScript", head_sha: sha,
  status: "completed", conclusion: "success", completed_at: new Date(now - 60_000).toISOString(), ...overrides });

function fixture({ runs = [run()], jobs = [job()], diff = { status: "ahead", files: [] }, fail } = {}) {
  const calls = [];
  const answer = (name, value) => async (input) => {
    calls.push({ name, input });
    if (fail === name) throw new Error("API unavailable");
    return { data: value };
  };
  const jobsApi = () => {};
  const github = {
    rest: { actions: { listWorkflowRuns: answer("runs", { workflow_runs: runs }), listJobsForWorkflowRunAttempt: jobsApi },
      repos: { compareCommitsWithBasehead: answer("compare", diff) } },
    paginate: async (api, input) => {
      assert.equal(api, jobsApi);
      calls.push({ name: "jobs", input });
      if (fail === "jobs") throw new Error("API unavailable");
      return typeof jobs === "function" ? jobs(input.run_id) : jobs;
    },
  };
  return { calls, select: (overrides = {}) => selectCodeqlScan({ github, context: { ...context, ...overrides }, now }) };
}

// Value: protects=PR input decisions bind event SHAs, and uncertainty scans rather than skips;
// why_new=new scheduling boundary; no_claim=GitHub upload acceptance (verified on live PR separately)
test("manual scans always run without querying history", async () => {
  const check = fixture();
  assert.equal((await check.select({ eventName: "workflow_dispatch" })).scan, true);
  assert.deepEqual(check.calls, []);
});

test("PR input selection uses exact event SHAs and a capped diff always scans", async () => {
  const prContext = { eventName: "pull_request", ref: "refs/pull/42/merge",
    payload: { pull_request: { base: { sha: "base" }, head: { sha: "head" } } } };
  for (const [file, expected] of [["docs/maintenance/ci.md", false], ["packages/core/src/index.ts", true],
    ["apps/web/README.md", true], ["component.svelte", true]]) {
    const check = fixture({ diff: { status: "ahead", files: [{ filename: file }] } });
    assert.equal((await check.select(prContext)).scan, expected, file);
    assert.deepEqual(check.calls.map((call) => call.name), ["compare"]);
    assert.equal(check.calls[0].input.basehead, "base...head");
  }
  for (const diff of [{ status: "ahead", files: Array.from({ length: 300 }, (_, i) => ({ filename: `docs/${i}.md` })) },
    { status: "diverged", files: [] }, { status: "ahead" }]) {
    assert.equal((await fixture({ diff }).select(prContext)).scan, true);
  }
  const renamed = { status: "ahead", files: [{ filename: "docs/archive.md", previous_filename: "source.js" }] };
  assert.equal((await fixture({ diff: renamed }).select(prContext)).scan, true);
  assert.equal((await fixture({ fail: "compare" }).select(prContext)).scan, true);
  assert.equal((await fixture().select({ eventName: "pull_request" })).scan, true);
});

test("SARIF proof requires the exact upload to finish processing without errors", async () => {
  const uploads = [];
  const verify = (data, sarifId = "upload-42") => verifyCodeqlUpload({ context, sarifId,
    github: { rest: { codeScanning: { getSarif: async (input) => { uploads.push(input); return { data }; } } } } });
  await verify({ processing_status: "complete" });
  assert.deepEqual(uploads[0], { ...context.repo, sarif_id: "upload-42" });
  for (const data of [{ processing_status: "pending" }, { processing_status: "failed", errors: ["invalid SARIF"] },
    {}, { processing_status: "complete", errors: ["analysis failed"] }]) {
    await assert.rejects(verify(data), /processing is not confirmed/u);
  }
  await assert.rejects(verify({ processing_status: "complete" }, ""), /upload ID/u);
  await assert.rejects(verifyCodeqlUpload({ context, sarifId: "upload-42",
    github: { rest: { codeScanning: { getSarif: async () => { throw new Error("API unavailable"); } } } } }), /API unavailable/u);
});

test("recent actual main success skips an identical SHA and binds the exact attempt", async () => {
  const check = fixture({ runs: [run({ id: 100 }), run({ run_attempt: 2 })] });
  assert.equal((await check.select()).scan, false);
  assert.deepEqual(check.calls.map((call) => call.name), ["runs", "jobs"]);
  assert.equal(check.calls[0].input.branch, "main");
  assert.equal(check.calls[0].input.workflow_id, "codeql.yml");
  assert.equal(check.calls[1].input.attempt_number, 2);
});

test("PRs, forks, other branches and skip-only runs cannot supply scan proof", async () => {
  const ignored = [run({ event: "pull_request" }), run({ head_branch: "feature" }),
    run({ head_repository: { full_name: "fork/ling-stack" } })];
  const check = fixture({ runs: [...ignored, run({ id: 91 }), run()],
    jobs: (id) => id === 91 ? [job({ conclusion: "skipped" })] : [job()] });
  assert.equal((await check.select()).scan, false);
  assert.deepEqual(check.calls.filter((call) => call.name === "jobs").map((call) => call.input.run_id), [91, 90]);
  assert.equal((await fixture({ runs: ignored }).select()).scan, true);
  assert.equal((await fixture().select({ ref: "refs/heads/feature" })).scan, true);
});

test("manual main success can seed scheduled proof, but missing or mismatched jobs cannot", async () => {
  assert.equal((await fixture({ runs: [run({ event: "workflow_dispatch" })] }).select()).scan, false);
  for (const jobs of [[], [job({ head_sha: "b".repeat(40) })], [job({ status: "in_progress" })],
    [job({ name: "Determine CodeQL scope" })], [job({ conclusion: "failure" })]]) {
    assert.equal((await fixture({ jobs }).select()).scan, true);
  }
});

test("a failed, cancelled or unfinished latest attempt cannot hide behind older success", async () => {
  for (const overrides of [{ conclusion: "failure" }, { conclusion: "cancelled" }, { status: "in_progress", conclusion: null }]) {
    const check = fixture({ runs: [run({ id: 91, ...overrides }), run()] });
    assert.equal((await check.select()).scan, true);
    assert.deepEqual(check.calls.map((call) => call.name), ["runs"]);
  }
});

test("proof expires after 24 hours even when hourly skip-only runs keep succeeding", async () => {
  for (const completed_at of [new Date(now - 86_400_000).toISOString(), "invalid", new Date(now + 1).toISOString()]) {
    const check = fixture({ runs: [run({ id: 91 }), run()],
      jobs: (id) => id === 91 ? [job({ conclusion: "skipped" })] : [job({ completed_at })] });
    assert.equal((await check.select()).scan, true);
  }
  assert.equal((await fixture({ jobs: [job({ completed_at: new Date(now - 86_399_999).toISOString() })] }).select()).scan, false);
});

test("only a complete input diff against the actual scanned SHA permits reuse", async () => {
  for (const files of [[{ filename: "README.md" }], [{ filename: "docs/maintenance/ci.md" }]]) {
    const check = fixture({ runs: [run({ head_sha: "b".repeat(40) })], jobs: [job({ head_sha: "b".repeat(40) })],
      diff: { status: "ahead", files } });
    assert.equal((await check.select()).scan, false);
    assert.equal(check.calls.at(-1).input.basehead, "b".repeat(40) + "..." + sha);
  }
  for (const file of ["packages/core/src/index.ts", "pnpm-lock.yaml", ".github/workflows/codeql.yml", "scripts/ci/codeql-scope.mjs"]) {
    assert.equal((await fixture({ runs: [run({ head_sha: "old" })], jobs: [job({ head_sha: "old" })],
      diff: { status: "ahead", files: [{ filename: file }] } }).select()).scan, true, file);
  }
});

test("renaming scanned code into documentation still requires a scan", async () => {
  const result = await fixture({ runs: [run({ head_sha: "old" })], jobs: [job({ head_sha: "old" })],
    diff: { status: "ahead", files: [{ filename: "docs/archive.md", previous_filename: "packages/core/src/removed.ts" }] } }).select();
  assert.equal(result.scan, true);
});

test("capped, divergent and unavailable comparisons require fresh scans", async () => {
  for (const diff of [{ status: "diverged", files: [] }, { status: "behind", files: [] }, { status: "ahead" },
    { status: "ahead", files: Array.from({ length: 300 }, (_, i) => ({ filename: "docs/" + i + ".md" })) }]) {
    assert.equal((await fixture({ runs: [run({ head_sha: "old" })], jobs: [job({ head_sha: "old" })], diff }).select()).scan, true);
  }
  for (const fail of ["runs", "jobs", "compare"]) {
    const result = await fixture({ runs: [run({ head_sha: "old" })], jobs: [job({ head_sha: "old" })], fail }).select();
    assert.equal(result.scan, true);
    assert.match(result.reason, /API unavailable/u);
  }
  assert.equal((await fixture({ runs: [] }).select()).scan, true);
});

test("input selection covers every supported source, dependency and policy type", () => {
  const extensions = ["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue", "svelte", "html", "htm"];
  for (const file of [...extensions.flatMap((extension) => [`file.${extension}`, `nested/file.${extension}`]),
    "apps/web/README.md", "packages/core/.hidden/input", "scripts/foo.txt", "patches/dependency.patch",
    "package.json", "nested/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json",
    "nested/tsconfig.build.json", ".gitattributes", "nested/.gitattributes", ".github/workflows/ci.yml",
    ".github/actions/check/action.yml", ".github/codeql/config.yml"]) {
    assert.equal(isCodeqlInput(file), true, file);
  }
  for (const file of ["README.md", "docs/maintenance/ci.md", "docs/image.png", "docs/file.ts.md"]) {
    assert.equal(isCodeqlInput(file), false, file);
  }
});

test("workflow keeps hourly/manual/PR admission and restricts write permission to analysis", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/codeql.yml", import.meta.url), "utf8");
  assert.match(workflow, /cron: "23 \* \* \* \*"/u);
  assert.match(workflow, /^  workflow_dispatch:$/mu);
  assert.doesNotMatch(workflow, /^  (?:push|pull_request_target):|^    paths:/mu);
  assert.match(workflow, /types: \[opened, synchronize, reopened, ready_for_review\]/u);
  const scope = workflow.split("  scope:\n")[1].split("  analyze:\n")[0];
  assert.match(scope, /!github\.event\.pull_request\.draft/u);
  assert.match(scope, /actions: read/u);
  assert.doesNotMatch(scope, /security-events: write/u);
  const analyze = workflow.split("  analyze:\n")[1];
  assert.match(analyze, /if: needs\.scope\.outputs\.scan == 'true'/u);
  assert.match(analyze, /security-events: write/u);
  assert.match(analyze, /languages: javascript-typescript/u);
  assert.match(analyze, /id: analyze/u);
  assert.match(analyze, /CODEQL_SARIF_ID: \$\{\{ steps\.analyze\.outputs\.sarif-id \}\}/u);
  assert.match(analyze, /await verifyCodeqlUpload\(\{ github, context, sarifId: process\.env\.CODEQL_SARIF_ID \}\)/u);
  assert.doesNotMatch(workflow, /continue-on-error|npm install|pnpm install/u);
  for (const match of workflow.matchAll(/uses: ([^\n]+)/gu)) assert.match(match[1], /@[a-f0-9]{40}(?: #.*)?$/u);
});
