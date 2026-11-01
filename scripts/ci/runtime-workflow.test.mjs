import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
function job(id) {
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

test("quality preserves non-blocking run, job, and shard timing telemetry", () => {
  const quality = job("quality");
  assert.match(quality, /permissions:\n      actions: read\n      contents: read/u);
  assert.match(quality, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(quality, /actions\/runs\/\$\{GITHUB_RUN_ID\}/u);
  assert.match(quality, /actions\/runs\/\$\{GITHUB_RUN_ID\}\/jobs\?per_page=100/u);
  assert.match(quality, /ci-telemetry\.mjs/u);
  assert.match(quality, /--reports-dir=\.codex-artifacts\/ci\/reports/u);
  assert.match(quality, /cat \.codex-artifacts\/ci\/ci-telemetry\.md >> "\$GITHUB_STEP_SUMMARY"/u);
  assert.match(quality, /name: ci-telemetry\n          include-hidden-files: true/u);
  assert.match(quality, /name: Preserve CI timing telemetry\n        if: always\(\)/u);
  assert.match(quality, /exit 0/u);
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
  assert.match(common, /secret-scan\.mjs --event="\$GITHUB_EVENT_NAME" --base="\$BASE_SHA" --head=HEAD/u);
  assert.match(common, /--log-opts="\$log_opts"/u);
  assert.match(common, /gitleaks@sha256:[a-f0-9]{64}/u);
  assert.match(common, /--redact=100/u);
  assert.match(common, /--gitleaks-ignore-path \/repo\/\.gitleaksignore/u);
  assert.doesNotMatch(common, /--log-opts=HEAD/u);
});
