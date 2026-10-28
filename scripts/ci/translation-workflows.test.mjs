import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const prWorkflow = readFileSync(resolve(repositoryRoot, ".github/workflows/translate-pr-catalogs.yml"), "utf8");
const syncWorkflow = readFileSync(resolve(repositoryRoot, ".github/workflows/sync-translation-catalogs.yml"), "utf8");
const branch = "automation/translation-catalogs";
const appSlug = "catalog-sync";

function shellStep(workflow, name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `workflow must contain ${name}`);
  const next = workflow.indexOf("\n      - name:", start + 1);
  const step = workflow.slice(start, next === -1 ? undefined : next);
  const runStart = step.indexOf("        run: |\n");
  assert.notEqual(runStart, -1, `${name} must have a shell command`);
  return step.slice(runStart + "        run: |\n".length).replace(/^ {10}/gmu, "");
}

function pullRequest(overrides = {}) {
  return {
    number: 123, state: "OPEN", headRefName: branch, baseRefName: "main", isCrossRepository: false,
    author: { login: `app/${appSlug}`, is_bot: true }, ...overrides,
  };
}

test("PR workflow triggers only on true source files and never on its own output", () => {
  assert.match(prWorkflow, /pull_request:\n    types: \[opened, synchronize, reopened, ready_for_review\]\n    paths:/u);
  for (const source of [
    "apps/web/src/i18n/locales/en-US.ts",
    "apps/web/src/i18n/locales/zh-CN.ts",
    "packages/localization/catalogs/additional-source.json",
    "packages/localization/catalogs/additional-zh-CN.json",
  ]) assert.ok(prWorkflow.includes(`- "${source}"`), `workflow must watch ${source}`);
  // The bot commits only packages/localization/catalogs/*.json and drafted
  // zh-CN sources. Catalog JSON stays unwatched; a drafted zh-CN.ts does
  // retrigger one synchronize run, which must converge through the no-diff exit.
  assert.doesNotMatch(prWorkflow, /- "packages\/localization\/catalogs\/[^a]/u);
  assert.match(prWorkflow, /git add apps\/web\/src\/i18n\/locales\/zh-CN\.ts packages\/localization\/catalogs\n/u);
});

test("PR workflow reports drafted zh-CN keys without failing when commenting is unavailable", () => {
  assert.match(prWorkflow, /gh pr comment "\$HEAD_REF"/u);
  assert.match(prWorkflow, /if ! gh pr comment/u);
  assert.match(prWorkflow, /::warning::Could not post the zh-CN draft review comment/u);
});

test("PR workflow is guarded to same-repository heads and re-checks the head before pushing", () => {
  assert.match(prWorkflow, /if: github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u);
  assert.match(prWorkflow, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
  assert.match(prWorkflow, /git rev-parse HEAD.*!=.*HEAD_SHA/u);
  assert.match(prWorkflow, /git push origin "HEAD:\$\{HEAD_REF\}"/u);
  assert.doesNotMatch(prWorkflow, /pull_request_target/u);
  assert.match(prWorkflow, /group: translate-pr-catalogs-\$\{\{ github\.event\.pull_request\.number \}\}/u);
});

test("sync workflow mirrors the model catalog automation contract", () => {
  assert.match(syncWorkflow, /cron: "41 3 \* \* \*"/u);
  assert.match(syncWorkflow, /if: github\.ref == 'refs\/heads\/main'/u);
  assert.match(syncWorkflow, /git push --force-with-lease origin "HEAD:\$branch"/u);
  assert.match(syncWorkflow, /gh pr list --state open --head "\$branch" --base main --limit 2 --json number,state,headRefName,baseRefName,isCrossRepository,author/u);
  assert.match(syncWorkflow, /node scripts\/ci\/automation-pr\.mjs "\$branch" "\$APP_SLUG"/u);
  assert.match(syncWorkflow, /gh pr merge "\$pull_request" --auto --squash --match-head-commit "\$head_commit"/u);
  assert.match(syncWorkflow, /run: node --test scripts\/ci\/automation-pr\.test\.mjs/u);
  assert.doesNotMatch(syncWorkflow, /--admin/u);
});

test("both workflows keep built-in permissions read-only and scope the App token to this repository", () => {
  for (const [name, workflow] of [["pr", prWorkflow], ["sync", syncWorkflow]]) {
    assert.match(workflow, /permissions:\n  contents: read\n/u, name);
    assert.match(workflow, /persist-credentials: false/u, name);
    assert.match(workflow, /uses: actions\/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510/u, name);
    for (const binding of [
      "client-id: ${{ vars.MODEL_CATALOG_APP_CLIENT_ID }}",
      "private-key: ${{ secrets.MODEL_CATALOG_APP_PRIVATE_KEY }}",
      "owner: ${{ github.repository_owner }}",
      "repositories: ${{ github.event.repository.name }}",
      "permission-contents: write", "permission-pull-requests: write",
    ]) assert.ok(workflow.includes(binding), `${name} workflow must bind ${binding}`);
    assert.ok(workflow.indexOf("name: Validate catalog App configuration") < workflow.indexOf("id: catalog-app"), name);
    assert.doesNotMatch(workflow, /github\.token|secrets\.GITHUB_TOKEN|skip-token-revoke/u, name);
  }
});

test("translation runs before staging, staging before the no-diff exit, push only after a diff", () => {
  for (const [name, workflow] of [["pr", prWorkflow], ["sync", syncWorkflow]]) {
    // Chinese drafts are filled before the import so catalogs never fall back
    // to English source text for missing zh-CN keys.
    const draftAt = workflow.indexOf("node packages/localization/scripts/draft-missing-chinese.mjs");
    const importPos = workflow.indexOf("import-legacy-web-catalogs.mjs");
    assert.ok(draftAt !== -1 && draftAt < importPos, `${name}: draft missing Chinese before importing sources`);
    // The importer resolves the workspace typescript dependency; fresh runners
    // must install locked dependencies before it can run. pnpm/action-setup must
    // precede setup-node's pnpm cache resolution, and lifecycle scripts stay
    // disabled so checked-out code cannot persist shims via the install.
    const pnpmSetupAt = workflow.indexOf("uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413");
    const nodeSetupAt = workflow.indexOf("uses: actions/setup-node@");
    const installAt = workflow.indexOf("corepack pnpm install --frozen-lockfile --prefer-offline --ignore-scripts");
    const importAt = workflow.indexOf("import-legacy-web-catalogs.mjs");
    assert.ok(pnpmSetupAt !== -1 && pnpmSetupAt < nodeSetupAt, `${name}: set up pnpm before the setup-node cache`);
    assert.ok(installAt !== -1 && installAt < importAt, `${name}: install locked dependencies before importing sources`);
    const translateAt = workflow.indexOf("node packages/localization/scripts/translate-catalogs.mjs");
    const addAt = workflow.indexOf("git add apps/web/src/i18n/locales/zh-CN.ts packages/localization/catalogs");
    const quietAt = workflow.indexOf("git diff --cached --quiet");
    const pushAt = workflow.indexOf("git push");
    assert.ok(importAt !== -1 && translateAt > importAt, `${name}: translate after import`);
    assert.ok(addAt > translateAt && quietAt > addAt, `${name}: stage then check`);
    assert.ok(pushAt > quietAt, `${name}: push only after the diff check`);
  }
});

test("App configuration validation accepts RSA keys and rejects bad credentials without echoing them", () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  for (const [name, workflow] of [["pr", prWorkflow], ["sync", syncWorkflow]]) {
    const validationStep = shellStep(workflow, "Validate catalog App configuration");
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
      assert.equal(result.status, expectedError ? 1 : 0, `${name}: ${result.stderr}`);
      if (expectedError) assert.ok(result.stderr.includes(expectedError), `${name}: ${result.stderr}`);
      assert.doesNotMatch(result.stdout + result.stderr, /BEGIN PRIVATE KEY|invalid-private-key-do-not-log/u, name);
    }
  }
});

test("sync workflow edits the sole existing automation PR or creates one, failing closed otherwise", () => {
  const marker = "          pull_requests_json=";
  const start = syncWorkflow.indexOf(marker);
  assert.notEqual(start, -1, "workflow must query open pull requests before edit/create");
  const prSegment = syncWorkflow.slice(start).replace(/^ {10}/gmu, "");

  function runSegment(records) {
    return spawnSync("bash", ["-c", `
set -euo pipefail
branch="${branch}"
APP_SLUG="${appSlug}"
created=false
gh() {
  printf 'GH_CALL:%s\\n' "$*" >&2
  if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
    if [ "$created" = "true" ]; then printf '%s' "$CREATED_PR_FIXTURE"; else printf '%s' "$PR_FIXTURE"; fi
  elif [ "$1" = "pr" ] && [ "$2" = "create" ]; then
    created=true
  elif [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
    printf 'MERGED:%s\\n' "$*" >&2
  fi
}
git() { command git "$@"; }
${prSegment}
`], {
      cwd: repositoryRoot,
      env: { ...process.env, PR_FIXTURE: JSON.stringify(records), CREATED_PR_FIXTURE: JSON.stringify([pullRequest()]) },
      encoding: "utf8",
    });
  }

  const edit = runSegment([pullRequest({ number: 55 })]);
  assert.equal(edit.status, 0, edit.stderr);
  assert.match(edit.stderr, /GH_CALL:pr edit 55/u);
  assert.match(edit.stderr, /MERGED:pr merge 55 --auto --squash --match-head-commit/u);

  const create = runSegment([]);
  assert.equal(create.status, 0, create.stderr);
  assert.match(create.stderr, /GH_CALL:pr create/u);
  assert.match(create.stderr, /MERGED:pr merge 123/u);
  assert.doesNotMatch(create.stderr, /GH_CALL:pr edit/u);

  const ambiguous = runSegment([pullRequest(), pullRequest({ number: 456 })]);
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /Multiple open automation pull requests/);

  const foreign = runSegment([pullRequest({ isCrossRepository: true })]);
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.stderr, /Unexpected automation pull request/);
});
