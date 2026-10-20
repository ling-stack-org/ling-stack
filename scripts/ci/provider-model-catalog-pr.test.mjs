import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(resolve(repositoryRoot, ".github/workflows/sync-provider-model-catalog.yml"), "utf8");
const branch = "automation/provider-model-catalog";

function shellStep(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `workflow must contain ${name}`);
  const next = workflow.indexOf("\n      - name:", start + 1);
  const step = workflow.slice(start, next === -1 ? undefined : next);
  const runStart = step.indexOf("        run: |\n");
  assert.notEqual(runStart, -1, `${name} must have a shell command`);
  return step.slice(runStart + "        run: |\n".length).replace(/^ {10}/gmu, "");
}

function temporaryDirectory(t) {
  const directory = mkdtempSync(resolve(tmpdir(), "ling-catalog-pr-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function executable(directory, name, script) {
  writeFileSync(resolve(directory, name), `#!${process.execPath}\n${script}`, { mode: 0o700 });
}

const refreshStep = shellStep("Refresh reviewed catalog data");

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

test("App credentials stay on main and use a repository-scoped token with read-only built-in permissions", () => {
  assert.match(workflow, /permissions:\n  contents: read\n/u);
  assert.doesNotMatch(workflow, /^  pull-requests:/mu);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /cron: "23 2 \* \* \*"/u);
  assert.ok(workflow.indexOf("name: Validate catalog App configuration") < workflow.indexOf("id: catalog-app"));
  assert.match(workflow, /uses: actions\/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510/u);
  for (const binding of [
    "client-id: ${{ vars.MODEL_CATALOG_APP_CLIENT_ID }}",
    "private-key: ${{ secrets.MODEL_CATALOG_APP_PRIVATE_KEY }}",
    "owner: ${{ github.repository_owner }}",
    "repositories: ${{ github.event.repository.name }}",
    "permission-contents: write", "permission-pull-requests: write",
    "GH_TOKEN: ${{ steps.catalog-app.outputs.token }}",
    "APP_SLUG: ${{ steps.catalog-app.outputs.app-slug }}",
  ]) assert.ok(workflow.includes(binding), `workflow must bind ${binding}`);
  assert.doesNotMatch(workflow, /github\.token|secrets\.GITHUB_TOKEN|skip-token-revoke|gh pr merge/u);
});

test("configuration validation accepts the App RSA key and rejects missing or invalid credentials without echoing them", () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  const validationStep = shellStep("Validate catalog App configuration");
  for (const [clientId, key, expectedError] of [
    ["Iv23valid", privateKey, undefined],
    ["", privateKey, "MODEL_CATALOG_APP_CLIENT_ID"],
    ["invalid client id", privateKey, "MODEL_CATALOG_APP_CLIENT_ID"],
    ["Iv23valid", "", "MODEL_CATALOG_APP_PRIVATE_KEY"],
    ["Iv23valid", "invalid-private-key-do-not-log", "MODEL_CATALOG_APP_PRIVATE_KEY"],
  ]) {
    const result = spawnSync("bash", ["-c", validationStep], {
      cwd: repositoryRoot,
      env: { ...process.env, MODEL_CATALOG_APP_CLIENT_ID: clientId, MODEL_CATALOG_APP_PRIVATE_KEY: key },
      encoding: "utf8",
    });
    assert.equal(result.status, expectedError ? 1 : 0, result.stderr);
    if (expectedError) assert.ok(result.stderr.includes(expectedError), result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /BEGIN PRIVATE KEY|invalid-private-key-do-not-log/u);
  }
});

test("git credential resolution overrides inherited credentials and reads the App token through gh", (t) => {
  const directory = temporaryDirectory(t);
  const configFile = resolve(directory, "gitconfig");
  const configure = spawnSync("git", ["config", "--file", configFile, "credential.helper", "!printf 'username=builtin\\npassword=builtin-token\\n'"], { encoding: "utf8" });
  assert.equal(configure.status, 0, configure.stderr);
  executable(directory, "gh", `
if (process.argv.slice(2).join(" ") !== "auth git-credential get") process.exit(2);
process.stdout.write("username=x-access-token\\npassword=" + process.env.GH_TOKEN + "\\n");
`);
  const gitFunction = refreshStep.match(/^git\(\) \{\n[\s\S]*?^\}/mu)?.[0];
  assert.ok(gitFunction, "the actual refresh step must route git authentication through gh");
  const result = spawnSync("bash", ["-c", `${gitFunction}\ngit credential fill`], {
    cwd: directory,
    env: {
      ...process.env, PATH: `${directory}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: configFile,
      GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GH_TOKEN: "test-app-installation-token",
    },
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /password=test-app-installation-token/u);
  assert.doesNotMatch(result.stdout, /builtin-token/u);
});

function runRefresh(t, { token = "test-app-installation-token", slug = "catalog-sync", botId = "12345", records = [], unchanged = false } = {}) {
  const directory = temporaryDirectory(t);
  const logFile = resolve(directory, "calls.jsonl");
  const common = `
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.CATALOG_CALL_LOG, JSON.stringify({ command: process.argv[1].split("/").at(-1), args, appToken: process.env.GH_TOKEN === "test-app-installation-token" }) + "\\n");
`;
  executable(directory, "git", `${common}
const command = args[4];
if (command === "diff") process.exit(process.env.CATALOG_UNCHANGED === "true" ? 0 : 1);
`);
  executable(directory, "gh", `${common}
if (args[0] === "api") process.stdout.write(process.env.CATALOG_BOT_ID);
if (args[0] === "pr" && args[1] === "list") process.stdout.write(process.env.CATALOG_PR_FIXTURE);
`);
  const result = spawnSync("bash", ["-c", `
node() {
  if [ "$1" = "scripts/sync-provider-model-catalog.mjs" ]; then return 0; fi
  command node "$@"
}
${refreshStep}
`], {
    cwd: repositoryRoot,
    env: {
      ...process.env, PATH: `${directory}:${process.env.PATH}`, GH_TOKEN: token, APP_SLUG: slug,
      CATALOG_CALL_LOG: logFile, CATALOG_BOT_ID: botId, CATALOG_PR_FIXTURE: JSON.stringify(records),
      CATALOG_UNCHANGED: String(unchanged),
    },
    encoding: "utf8",
  });
  let calls = [];
  try { calls = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return { ...result, calls };
}

test("refresh fails before git or gh when the App token or identity is missing", (t) => {
  for (const options of [{ token: "" }, { slug: "" }]) {
    const result = runRefresh(t, options);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /Catalog App token or identity is missing/u);
    assert.deepEqual(result.calls, []);
  }
});

test("refresh pushes the leased automation branch and creates or edits the PR under the same App identity", (t) => {
  for (const records of [[], [pullRequest()]]) {
    const result = runRefresh(t, { records });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.calls.every(call => call.appToken), "every git and gh child must receive the App token");
    const gitCalls = result.calls.filter(call => call.command === "git").map(call => call.args);
    for (const args of gitCalls) assert.deepEqual(args.slice(0, 4), ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]);
    assert.ok(gitCalls.some(args => args.slice(4).join(" ") === `push --force-with-lease origin HEAD:${branch}`));
    assert.ok(gitCalls.some(args => args.slice(4).join(" ") === "config user.name catalog-sync[bot]"));
    assert.ok(gitCalls.some(args => args.slice(4).join(" ") === "config user.email 12345+catalog-sync[bot]@users.noreply.github.com"));
    const mutation = result.calls.find(call => call.command === "gh" && call.args[0] === "pr" && ["create", "edit"].includes(call.args[1]));
    assert.ok(mutation, "a changed catalog must create or edit a PR");
    assert.equal(mutation.args[1], records.length ? "edit" : "create");
    assert.doesNotMatch(result.stdout + result.stderr, /test-app-installation-token/u);
  }
});

test("unchanged catalogs do not push or create PRs, and invalid bot identities never push", (t) => {
  const unchanged = runRefresh(t, { unchanged: true });
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.ok(unchanged.calls.every(call => call.command !== "gh" && call.args[4] !== "push"));
  for (const botId of ["", "not-an-id", "12345\nunexpected"]) {
    const result = runRefresh(t, { botId });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.calls.every(call => call.command === "git" ? !["commit", "push"].includes(call.args[4]) : call.args[0] !== "pr"));
  }
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
