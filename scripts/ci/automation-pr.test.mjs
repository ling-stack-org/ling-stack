import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./automation-pr.mjs", import.meta.url));
const branch = "automation/translation-catalogs";
const appSlug = "catalog-sync";

function pullRequest(overrides = {}) {
  return {
    number: 123, state: "OPEN", headRefName: branch, baseRefName: "main", isCrossRepository: false,
    author: { login: `app/${appSlug}`, is_bot: true }, ...overrides,
  };
}

async function select(records) {
  const { selectOpenAutomationPullRequest } = await import("./automation-pr.mjs");
  return selectOpenAutomationPullRequest(JSON.stringify(records), branch, appSlug);
}

test("selects the sole App-authored same-repository automation PR", async () => {
  assert.equal(await select([pullRequest()]), 123);
});

test("returns undefined only for an empty result set", async () => {
  assert.equal(await select([]), undefined);
});

test("fails closed on ambiguous, foreign, or wrong-author matches", async () => {
  await assert.rejects(() => select([pullRequest(), pullRequest({ number: 456 })]), /Multiple open/);
  await assert.rejects(() => select([pullRequest({ state: "CLOSED" })]), /Unexpected automation/);
  await assert.rejects(() => select([pullRequest({ headRefName: "automation/other" })]), /Unexpected automation/);
  await assert.rejects(() => select([pullRequest({ baseRefName: "release" })]), /Unexpected automation/);
  await assert.rejects(() => select([pullRequest({ isCrossRepository: true })]), /Unexpected automation/);
  await assert.rejects(() => select([pullRequest({ author: { login: "app/other", is_bot: true } })]), /Unexpected automation/);
  await assert.rejects(() => select([pullRequest({ author: { login: `app/${appSlug}`, is_bot: false } })]), /Unexpected automation/);
  await assert.rejects(() => select([pullRequest({ number: 0 })]), /Unexpected automation/);
});

test("fails closed on malformed input and invalid identifiers", async () => {
  const { selectOpenAutomationPullRequest } = await import("./automation-pr.mjs");
  assert.throws(() => selectOpenAutomationPullRequest("not json", branch, appSlug), /valid JSON/);
  assert.throws(() => selectOpenAutomationPullRequest("{}", branch, appSlug), /must be an array/);
  assert.throws(() => selectOpenAutomationPullRequest("[]", branch, ""), /slug is missing/);
  assert.throws(() => selectOpenAutomationPullRequest("[]", "bad branch!", appSlug), /branch is missing/);
});

test("CLI prints the selected number and exits nonzero on rejection", () => {
  const ok = spawnSync(process.execPath, [scriptPath, branch, appSlug], { input: JSON.stringify([pullRequest({ number: 789 })]) });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.toString().trim(), "789");

  const none = spawnSync(process.execPath, [scriptPath, branch, appSlug], { input: "[]" });
  assert.equal(none.status, 0);
  assert.equal(none.stdout.toString().trim(), "");

  const bad = spawnSync(process.execPath, [scriptPath, branch, appSlug], { input: JSON.stringify([pullRequest({ isCrossRepository: true })]) });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr.toString(), /Unexpected automation pull request/);
});
