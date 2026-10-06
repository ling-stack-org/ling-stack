import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

/** Read one top-level job without treating similarly named steps as jobs. */
function jobSource(id) {
  const start = workflow.indexOf(`\n  ${id}:\n`);
  assert.ok(start >= 0, `Missing required CI job: ${id}`);
  const remaining = workflow.slice(start + 1);
  const next = /\n  [a-z][a-z0-9-]*:\n/u.exec(remaining);
  return next ? remaining.slice(0, next.index) : remaining;
}

function runQuality(overrides = {}) {
  const script = jobSource("quality").split("        run: |\n")[1];
  assert.ok(script, "quality must retain an executable aggregation gate");
  return spawnSync("bash", ["-c", script.replace(/^ {10}/gmu, "")], {
    encoding: "utf8",
    env: { ...process.env, SCOPE_RESULT: "success", COMMON_RESULT: "success",
      DEPENDENCY_RESULT: "success", BUILD_RESULT: "success", TYPECHECK_RESULT: "success",
      UNIT_RESULT: "success", DAEMON_RESULT: "success", LINUX_CONTRACT_RESULT: "success",
      MACOS_NATIVE_RESULT: "success", DAEMON_SELECTED: "true", ...overrides },
  });
}

// Value: protects=all original daemon positives execute on a real supported Host;
// fails_when=CI silently restores Linux for Darwin-only positives or removes shards;
// why_new=production platform gates exposed an invalid runner assumption; seam=none
test("complete daemon shards run on the explicit real macOS arm64 image", () => {
  const job = jobSource("daemon-tests");
  assert.match(job, /runs-on: macos-26\n/u);
  assert.match(job, /shard: \[0, 1, 2, 3\]/u);
  assert.match(job, /daemon-test-shard\.mjs --shard=\$\{\{ matrix\.shard \}\} --shard-count=4/u);
  assert.doesNotMatch(job, /continue-on-error|--test-name-pattern|--test-skip-pattern/u);
});

test("Linux rejection and real macOS helper smoke are mandatory separate lanes", () => {
  const linux = jobSource("daemon-linux-contracts");
  const macos = jobSource("restricted-command-macos");
  assert.match(linux, /runs-on: ubuntu-latest\n/u);
  assert.match(linux, /test\/restricted-command-linux\.contract\.mjs/u);
  assert.match(linux, /test\/restricted-command-dispatch\.test\.mjs/u);
  assert.match(macos, /runs-on: macos-26\n/u);
  assert.match(macos, /--target aarch64-apple-darwin/u);
  for (const name of ["host-input-read", "restricted-command-dispatch", "channel-command"]) {
    assert.ok(macos.includes(`native/sandbox/tests/${name}-smoke.mjs`), name);
  }
  assert.ok(macos.includes("packages/daemon/test/restricted-command-launch-unknown.contract.mjs"), "post-entry native uncertainty must retain a mandatory regression");
  const quality = jobSource("quality");
  assert.match(quality, /needs: \[[^\n]*daemon-linux-contracts[^\n]*restricted-command-macos[^\n]*\]/u);
  assert.match(quality, /LINUX_CONTRACT_RESULT: \$\{\{ needs\.daemon-linux-contracts\.result \}\}/u);
  assert.match(quality, /MACOS_NATIVE_RESULT: \$\{\{ needs\.restricted-command-macos\.result \}\}/u);
  assert.doesNotMatch(linux + macos, /continue-on-error/u);
});

test("quality passes only when selected platform lanes actually succeed", () => {
  const result = runQuality();
  assert.equal(result.status, 0, result.stderr);
});

for (const lane of ["DAEMON", "LINUX_CONTRACT", "MACOS_NATIVE"]) {
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    test(`quality rejects selected ${lane}=${result}`, () => {
      const check = runQuality({ [`${lane}_RESULT`]: result });
      assert.equal(check.status, 1, check.stderr);
      assert.ok(check.stdout.includes(`${lane}=${result}`), check.stdout);
    });
  }
}

test("out-of-scope platform skips do not block documentation or Web-only changes", () => {
  const result = runQuality({ DAEMON_SELECTED: "false", DAEMON_RESULT: "skipped",
    LINUX_CONTRACT_RESULT: "skipped", MACOS_NATIVE_RESULT: "skipped" });
  assert.equal(result.status, 0, result.stderr);
});
