import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadDaemonTestPlatforms, validateDaemonTestPlatforms } from "./daemon-test-platforms.mjs";
import { createTestPlan, discoverTestFiles, testSuites } from "./test-shard-plan.mjs";

test("platform assignments reject omissions, duplicates, stale files and invalid paths", () => {
  const files = ["test/business.test.ts", "test/native.test.mjs"];
  const manifest = { version: 1, linux: [files[0]], darwin: [files[1]] };
  assert.deepEqual(validateDaemonTestPlatforms(manifest, files), {
    linux: [files[0]], darwin: [files[1]],
  });
  for (const invalid of [null, {}, { ...manifest, version: 2 }, { ...manifest, linux: null },
    { ...manifest, darwin: [] }, { ...manifest, linux: files },
    { ...manifest, linux: [files[0], files[0]] },
    { ...manifest, darwin: [files[1], "test/stale.test.mjs"] },
    { ...manifest, linux: ["../outside.test.ts"] }]) {
    assert.throws(() => validateDaemonTestPlatforms(invalid, files));
  }
  assert.throws(() => validateDaemonTestPlatforms(manifest, [...files, "test/new.test.ts"]), /coverage_mismatch/u);
});

test("both daemon plans conserve full discovery and publish their actual platform and worker limits", async () => {
  const discovered = await discoverTestFiles(testSuites.daemon.cwd, testSuites.daemon.excluded);
  const groups = await loadDaemonTestPlatforms(discovered);
  const plan = await createTestPlan(["@ling-stack/daemon"]);
  assert.deepEqual(plan.suites.daemon.files, groups.darwin);
  assert.deepEqual(plan.suites["daemon-linux"].files, groups.linux);
  const assigned = [...groups.darwin, ...groups.linux];
  assert.equal(new Set(assigned).size, discovered.length);
  assert.deepEqual(assigned.sort(), discovered);
  for (const [suite, runner, count, concurrency] of [
    ["daemon", "macos-26", 4, 3], ["daemon-linux", "ubuntu-latest", 5, 4],
  ] as const) {
    assert.deepEqual(plan.daemonMatrix.include.filter(entry => entry.suite === suite),
      Array.from({ length: count }, (_, shard) => ({ suite, runner, shard, shardCount: count, concurrency })));
  }
  assert.deepEqual(plan.unitMatrix.include, []);
  assert.deepEqual((await createTestPlan(["@ling-stack/web"])).daemonMatrix.include, []);
});

test("real Darwin positive contracts retain their Host while portable Git transactions use Linux", async () => {
  const discovered = await discoverTestFiles(testSuites.daemon.cwd, testSuites.daemon.excluded);
  const groups = await loadDaemonTestPlatforms(discovered);
  for (const name of ["platform-native-sandbox", "macos-native-command", "acp-kimi-host-read",
    "acp-kimi-host-terminal", "protected-host-staging", "workflow-conflict-recovery",
    "host-text-write-runtime", "computer-use-producer", "channel-intents",
    "external-workflow-request-worker-source"]) {
    assert.ok(groups.darwin.includes(`test/${name}.test.mjs`), name);
  }
  for (const name of ["workflow-merge-apply", "workflow-candidate-validation", "workflow-merge-approval",
    "workflow-integration-candidate", "workflow-worktree-cleanup-store"]) {
    assert.ok(groups.linux.includes(`test/${name}.test.mjs`), name);
  }
});

// Source inspection protects platform coverage when a portable file or a shared
// test fixture gains a Darwin-specific positive case. Runtime acceptance is separate.
test("portable tests and their shared fixtures do not acquire native platform contracts", async () => {
  const discovered = await discoverTestFiles(testSuites.daemon.cwd, testSuites.daemon.excluded);
  const groups = await loadDaemonTestPlatforms(discovered);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const inspected = new Set<string>();
  const native = /darwin|macOS|macos|Seatbelt|seatbelt|sandbox-exec|osascript|protected[- ]host|office.local|computer.use|cua|NativeHost|native.host/u;
  const imports = /(?:from\s*|import\s*\(\s*|import\s*)["']([^"']+)["']/gu;
  async function inspect(path: string): Promise<void> {
    if (inspected.has(path)) return;
    inspected.add(path);
    const source = await readFile(path, "utf8");
    const portable = source.replace(
      /export const nativeGit = \{ skip: !\["darwin", "linux"\]\.includes\(process\.platform\) \};/gu, "");
    assert.doesNotMatch(portable, native, path);
    for (const match of source.matchAll(imports)) {
      if (!match[1].startsWith(".")) continue;
      const dependency = resolve(dirname(path), match[1]);
      if (/\/test\/(?:support|test-support)\//u.test(dependency)) await inspect(dependency);
    }
  }
  for (const file of groups.linux) await inspect(resolve(root, "packages/daemon", file));
});
