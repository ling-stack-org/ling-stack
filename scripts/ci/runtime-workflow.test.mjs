import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
function job(id) {
  const match = new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, "mu").exec(workflow);
  assert.ok(match, id);
  return match[1];
}

function telemetryStep(name) {
  const match = new RegExp(`^      - name: ${name}\\n([\\s\\S]*?)(?=^      - name:|$(?![\\s\\S]))`, "mu")
    .exec(job("timing-telemetry"));
  assert.ok(match, name);
  return match[1];
}

function stepCommand(name) {
  const match = /^ {8}run: \|\n((?: {10}[^\n]*(?:\n|$)|\n)*)/mu.exec(telemetryStep(name));
  assert.ok(match, `Missing executable command: ${name}`);
  return match[1].replace(/^ {10}/gmu, "");
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

test("timing telemetry is independent of the mandatory quality gate", () => {
  const quality = job("quality");
  const telemetry = job("timing-telemetry");
  assert.doesNotMatch(quality, /timing-telemetry|ci-telemetry|continue-on-error/u);
  assert.match(telemetry, /^    needs: \[scope, quality\]$/mu);
  assert.match(telemetry, /^    if: always\(\)$/mu);
  assert.match(telemetry, /^    timeout-minutes: 3$/mu);
  assert.match(telemetry, /^    continue-on-error: true$/mu);
  assert.match(telemetry, /permissions:\n      actions: read\n      contents: read/u);
  assert.match(telemetry, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(telemetry, /actions\/runs\/\$\{GITHUB_RUN_ID\}/u);
  assert.match(telemetry, /\/attempts\/\$\{GITHUB_RUN_ATTEMPT\}\/jobs\?per_page=100/u);
  assert.match(telemetry, /ci-telemetry\.mjs/u);
  assert.match(telemetry, /--reports-dir=\.codex-artifacts\/ci\/reports/u);
  assert.match(telemetry, /cat \.codex-artifacts\/ci\/ci-telemetry\.md >> "\$GITHUB_STEP_SUMMARY"/u);
  assert.match(telemetry, /name: ci-telemetry\n          include-hidden-files: true/u);
  for (const name of ["Collect workflow timing metadata", "Render CI timing telemetry", "Preserve CI timing telemetry"]) {
    assert.match(telemetryStep(name), /^        if: always\(\)\n        continue-on-error: true$/mu, name);
  }
  const download = telemetryStep("Download available shard reports including failures");
  assert.match(download, /if: always\(\) && needs\.scope\.outputs\.execution-tier == 'complete'/u);
  assert.match(download, /continue-on-error: true/u);
  assert.match(download, /pattern: ci-test-report-\*/u);
});

test("workflow collection preserves unavailable observations on API and JSON failures", async t => {
  for (const mode of ["success", "api-failure", "invalid-json", "invalid-pages"]) {
    await t.test(mode, async () => {
      const directory = await mkdtemp(join(tmpdir(), "ci-telemetry-workflow-"));
      try {
        const bin = join(directory, "bin");
        await mkdir(bin);
        await writeFile(join(bin, "gh"), `#!/usr/bin/env node
if (process.env.TELEMETRY_API_MODE === "api-failure") process.exit(1);
if (process.argv.at(-1).includes("/jobs?")) {
  const mode = process.env.TELEMETRY_API_MODE;
  process.stdout.write(mode === "invalid-json" ? "{" : mode === "invalid-pages" ? "[{}]" : '[{"jobs":[{"id":1}]},{"jobs":[{"id":2}]}]');
} else process.stdout.write('{"id":42}');
`, { mode: 0o755 });
        const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", stepCommand("Collect workflow timing metadata")], {
          cwd: directory, encoding: "utf8", timeout: 10000,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TELEMETRY_API_MODE: mode,
            GITHUB_REPOSITORY: "example/repo", GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "2" },
        });
        assert.equal(result.status, 0, result.stderr);
        const jobs = JSON.parse(await readFile(join(directory, ".codex-artifacts/ci/telemetry-jobs.json"), "utf8"));
        if (mode === "success") assert.deepEqual(jobs, { jobs: [{ id: 1 }, { id: 2 }] });
        else assert.deepEqual(jobs, { jobs: [], telemetry_unavailable: true });
        const run = JSON.parse(await readFile(join(directory, ".codex-artifacts/ci/telemetry-run.json"), "utf8"));
        if (mode === "api-failure") assert.equal(run.telemetry_unavailable, true);
        else assert.equal(run.id, 42);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("workflow rendering preserves an unavailable artifact when the telemetry command fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ci-telemetry-render-"));
  try {
    await mkdir(join(directory, ".codex-artifacts/ci"), { recursive: true });
    const summary = join(directory, "summary.md");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", stepCommand("Render CI timing telemetry")], {
      cwd: directory, encoding: "utf8", timeout: 10000,
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(result.status, 0, result.stderr);
    const telemetry = JSON.parse(await readFile(join(directory, ".codex-artifacts/ci/ci-telemetry.json"), "utf8"));
    assert.equal(telemetry.telemetryUnavailable, true);
    assert.match(await readFile(summary, "utf8"), /Telemetry was unavailable/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
