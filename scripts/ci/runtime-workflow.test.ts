import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
function job(id: string) {
  const match = new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, "mu").exec(workflow);
  assert.ok(match, id);
  return match[1];
}

test("all core matrix jobs are part of the existing mandatory unit gate", () => {
  const source = job("unit-tests");
  assert.match(source, /matrix: \$\{\{ fromJSON\(needs\.scope\.outputs\.unit-matrix\) \}\}/u);
  assert.match(source, /fail-fast: false/u);
  assert.match(source, /node-test-shard\.mjs --suite=core/u);
  assert.match(source, /--shard=\$\{\{ matrix\.shard \}\} --shard-count=4 --concurrency=2/u);
  assert.match(source, /--shard-timeout-ms=1200000/u);
  assert.match(source, /--exclude='\["@ling-stack\/daemon","@ling-stack\/core"\]'/u);
  assert.match(source, /if: matrix\.suite == 'packages' && env\.WEB_SELECTED == 'true'/u);
  assert.match(job("quality"), /UNIT_RESULT: \$\{\{ needs\.unit-tests\.result \}\}/u);
  assert.doesNotMatch(source, /continue-on-error|--test-skip-pattern|--test-name-pattern/u);
});

test("timings are restored once and every shard consumes one immutable plan", () => {
  const scope = job("scope");
  assert.match(scope, /actions\/cache\/restore@[a-f0-9]{40}/u);
  assert.match(scope, /unit-matrix: \$\{\{ steps\.test-plan\.outputs\.unit-matrix \}\}/u);
  assert.match(scope, /test-shard-plan\.mjs/u);
  assert.match(scope, /name: ci-test-plan\n          include-hidden-files: true/u);
  for (const name of ["unit-tests", "daemon-tests"]) {
    const source = job(name);
    assert.match(source, /name: ci-test-plan/u);
    assert.match(source, /--plan=\.codex-artifacts\/ci\/test-plan\.json/u);
    assert.doesNotMatch(source, /actions\/cache\/restore/u);
    assert.match(source, /name: ci-test-report-(?:core|daemon)-\$\{\{ matrix\.shard \}\}\n          include-hidden-files: true/u);
    assert.match(source, /if-no-files-found: error/u);
  }
});

test("the aggregate verifies reports before caching only default-branch successful timings", () => {
  const quality = job("quality");
  const policy = quality.indexOf("node scripts/ci/execution-policy.mjs --check-quality");
  const coverage = quality.indexOf("node scripts/ci/test-shard-plan.mjs");
  const cache = quality.indexOf("uses: actions/cache/save@");
  assert.ok(policy >= 0 && coverage > policy && cache > coverage);
  assert.match(quality, /pattern: ci-test-report-\*\n          merge-multiple: true/u);
  assert.match(quality, /--plan=\.codex-artifacts\/ci\/test-plan\.json --reports=\.codex-artifacts\/ci\/reports/u);
  assert.match(quality, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/u);
  assert.doesNotMatch(quality, /continue-on-error/u);
});

test("test-complete timing evidence survives unrelated gate failures without weakening the gate", () => {
  const quality = job("quality");
  for (const name of [
    "Download the shared test plan for coverage verification",
    "Download all shard reports",
    "Verify every planned file passed exactly once and collect timings",
  ]) {
    const start = quality.indexOf(`      - name: ${name}\n`);
    assert.ok(start >= 0, name);
    const end = quality.indexOf("\n      - name:", start + 1);
    const step = quality.slice(start, end < 0 ? undefined : end);
    assert.match(step, /if: \$\{\{ !cancelled\(\) && needs\.scope\.result == 'success'/u, name);
    assert.match(step, /needs\.scope\.outputs\.execution-tier == 'complete'/u, name);
    assert.match(step, /needs\.scope\.outputs\.daemon == 'true' \|\| contains\(needs\.scope\.outputs\.test-packages, '"@ling-stack\/core"'\)/u, name);
  }
  assert.match(quality, /name: Verify every planned file passed exactly once and collect timings\n        id: test-timings/u);
  const save = quality.slice(quality.indexOf("      - name: Save trusted default-branch test timings\n"));
  assert.match(save, /if: \$\{\{ !cancelled\(\) && steps\.test-timings\.outcome == 'success'/u);
  assert.match(save, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/u);
  assert.doesNotMatch(quality, /continue-on-error/u);
});

test("CI tools' TypeScript tests are discovered and typechecked in the required lanes", () => {
  assert.match(job("common-fast"), /node --test[^\n]*scripts\/ci\/\*\.test\.ts/u);
  assert.match(job("typecheck"), /run: corepack pnpm typecheck:ci-tests/u);
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.match(manifest.scripts["typecheck:ci-tests"], /tsc -p scripts\/ci\/tsconfig\.test\.json/u);
  assert.match(manifest.scripts.typecheck, /typecheck:ci-tests/u);
  const config = JSON.parse(readFileSync(new URL("./tsconfig.test.json", import.meta.url), "utf8"));
  assert.deepEqual(config.include, ["*.test.ts"]);
  assert.equal(config.compilerOptions.strict, true);
  assert.equal(config.compilerOptions.noEmit, true);
  assert.equal(config.compilerOptions.module, "NodeNext");
  const daemon = JSON.parse(readFileSync(new URL("../../packages/daemon/package.json", import.meta.url), "utf8"));
  assert.match(daemon.scripts["test:ci"], /test\/\*\.test\.ts/u);
  assert.match(daemon.scripts["typecheck:ci"], /tsc -p tsconfig\.test\.json/u);
  assert.match(daemon.scripts.typecheck, /pnpm typecheck:ci/u);
  assert.match(daemon.scripts.test, /pnpm test:ci/u);
});

test("complete PR history scans ignore docs-only final diffs while Draft previews stay deferred", () => {
  const common = job("common-fast");
  assert.doesNotMatch(common, /^    if:/mu, "the common job must not bypass history scans based on file scope");
  assert.doesNotMatch(workflow, /^\s+paths(?:-ignore)?:/mu, "docs-only final diffs must still trigger validation");
  assert.match(common, /^      - name: Scan Git history for secrets\n        if: needs\.scope\.outputs\.execution-tier == 'complete'$/mu);
});

test("secret scans use commit history planning and retain full checkout and pinned scanner", () => {
  const common = job("common-fast");
  assert.match(common, /fetch-depth: 0/u);
  assert.match(common, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/u);
  assert.match(common, /secret-scan\.mjs --event="\$GITHUB_EVENT_NAME" --base="\$BASE_SHA" --head="\$HEAD_SHA"/u);
  assert.match(common, /--log-opts="\$log_opts"/u);
  assert.match(common, /gitleaks@sha256:[a-f0-9]{64}/u);
  assert.match(common, /--redact=100/u);
  assert.match(common, /--gitleaks-ignore-path \/repo\/\.gitleaksignore/u);
  assert.doesNotMatch(common, /--log-opts=HEAD/u);
});
