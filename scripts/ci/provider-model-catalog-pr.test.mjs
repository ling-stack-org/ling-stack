import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(resolve(repositoryRoot, ".github/workflows/sync-provider-model-catalog.yml"), "utf8");
const branch = "automation/provider-model-catalog";

function pullRequest(overrides = {}) {
  return { number: 123, state: "OPEN", headRefName: branch, baseRefName: "main", isCrossRepository: false, ...overrides };
}

async function select(records) {
  const { selectOpenCatalogPullRequest } = await import("./provider-model-catalog-pr.mjs");
  return selectOpenCatalogPullRequest(JSON.stringify(records), branch);
}

function runPrStep(records, listExitCode = 0) {
  const marker = "          pull_requests_json=";
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, "workflow must query open pull requests before edit/create");
  const prStep = workflow.slice(start).replace(/^ {10}/gmu, "");
  return spawnSync("bash", ["-c", `
set -euo pipefail
branch="${branch}"
gh() {
  printf 'GH_CALL:%s\\n' "$*" >&2
  if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
    if [ "$CATALOG_LIST_EXIT_CODE" != "0" ]; then return "$CATALOG_LIST_EXIT_CODE"; fi
    printf '%s' "$CATALOG_PR_FIXTURE"
  fi
}
${prStep}
`], {
    cwd: repositoryRoot,
    env: { ...process.env, CATALOG_PR_FIXTURE: JSON.stringify(records), CATALOG_LIST_EXIT_CODE: String(listExitCode) },
    encoding: "utf8",
  });
}

test("workflow queries exact open head/base and preserves the existing leased push", () => {
  assert.match(workflow, /gh pr list --state open --head "\$branch" --base main --limit 2 --json number,state,headRefName,baseRefName,isCrossRepository/u);
  assert.doesNotMatch(workflow, /gh pr view/u);
  assert.match(workflow, /git push --force-with-lease origin "HEAD:\$branch"/u);
  assert.match(workflow, /gh pr edit "\$pull_request"/u);
});

test("selector returns no PR only for an empty successful query", async () => {
  assert.equal(await select([]), undefined);
  assert.equal(await select([pullRequest()]), 123);
});

test("selector rejects closed, merged, mismatched, forked, or malformed records", async () => {
  for (const overrides of [
    { state: "MERGED" }, { state: "CLOSED" }, { headRefName: "another-branch" },
    { baseRefName: "develop" }, { isCrossRepository: true }, { number: 0 }, { number: "123" },
  ]) {
    await assert.rejects(() => select([pullRequest(overrides)]), /Unexpected catalog pull request/u);
  }
  await assert.rejects(() => select({}), /must be an array/u);
  const { selectOpenCatalogPullRequest } = await import("./provider-model-catalog-pr.mjs");
  assert.throws(() => selectOpenCatalogPullRequest("not JSON", branch), /JSON/u);
});

test("selector refuses to choose among multiple open matches", async () => {
  await assert.rejects(() => select([pullRequest(), pullRequest({ number: 124 })]), /Multiple open/u);
});

test("workflow creates a fresh PR after the previous PR is closed or merged", () => {
  // An open-only query excludes the old CLOSED/MERGED PR instead of viewing it.
  const result = runPrStep([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /GH_CALL:pr list --state open --head automation\/provider-model-catalog --base main/u);
  assert.match(result.stderr, /GH_CALL:pr create --base main --head automation\/provider-model-catalog/u);
  assert.doesNotMatch(result.stderr, /GH_CALL:pr edit/u);
});

test("workflow edits the exact single open PR by number", () => {
  const result = runPrStep([pullRequest()]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /GH_CALL:pr edit 123 /u);
  assert.doesNotMatch(result.stderr, /GH_CALL:pr create/u);
});

test("workflow stops on query failures and ambiguity without editing or creating", () => {
  for (const [records, exitCode] of [
    [[], 2], [[pullRequest(), pullRequest({ number: 124 })], 0],
    [[pullRequest({ state: "MERGED" })], 0], [{ message: "unavailable" }, 0],
  ]) {
    const result = runPrStep(records, exitCode);
    assert.notEqual(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /GH_CALL:pr (?:edit|create)/u);
  }
});
