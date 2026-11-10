import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyBundledSkillSource } from "../../packages/core/dist/bundled-skill-source.js";
import { buildGstackSourceBundle, sourceBuildEnvironment } from "./build-source-bundle.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await readFile(join(scriptRoot, "upstream-lock.json"), "utf8"));
const sourcePath = process.env.LING_GSTACK_SOURCE;
const previousSource = process.env.LING_GSTACK_PREVIOUS_SOURCE;
const bunCommand = process.env.LING_GSTACK_BUN ?? "bun";

test("source rendering isolates user data and does not inherit provider credentials or runtime hooks", () => {
  const staging = join(tmpdir(), "ling source environment");
  const env = sourceBuildEnvironment({ staging, inherited: {
    PATH: "/usr/bin:/bin", SystemRoot: "C:\\Windows", HOME: "/private-user-data", USERPROFILE: "C:\\private-user-data",
    GSTACK_HOME: "/global-gstack", GSTACK_PLAN_DIR: "/private-plans", ANTHROPIC_API_KEY: "secret-fixture",
    OPENAI_API_KEY: "secret-fixture", NODE_OPTIONS: "--require private-hook", BUN_OPTIONS: "private-hook",
    BUN_INSTALL_CACHE_DIR: "/private-cache", GSTACK_TELEMETRY: "true",
  } });
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.HOME, join(staging, "home"));
  assert.equal(env.USERPROFILE, env.HOME);
  assert.equal(env.GSTACK_HOME, join(staging, "state"));
  assert.equal(env.GSTACK_PLAN_DIR, join(staging, "plans"));
  assert.equal(env.BUN_INSTALL_CACHE_DIR, join(staging, "bun-cache"));
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "NODE_OPTIONS", "BUN_OPTIONS", "GSTACK_TELEMETRY"]) {
    assert.equal(env[key], undefined, key);
  }
});

test("a historical upstream source cannot be relabeled as the current bundle", { skip: !previousSource && "Set LING_GSTACK_PREVIOUS_SOURCE for historical-source rejection" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "ling historical source rejection "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "current");
  await assert.rejects(buildGstackSourceBundle({ sourcePath: previousSource, outputPath: output, bunCommand }), /gstack_source_revision_or_worktree_mismatch/);
  await assert.rejects(lstat(output), { code: "ENOENT" });
});

test("pinned real-source generation is reproducible, complete and does not mutate upstream", { skip: !sourcePath && "Set LING_GSTACK_SOURCE to the immutable upstream checkout" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-gstack-build-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = execFileSync("git", ["status", "--porcelain"], { cwd: sourcePath, encoding: "utf8" });
  const a = await buildGstackSourceBundle({ sourcePath, outputPath: join(root, "a"), bunCommand });
  const b = await buildGstackSourceBundle({ sourcePath, outputPath: join(root, "b"), bunCommand });
  assert.equal(a.skillCount, 57);
  assert.equal(a.deliveryStage, "source");
  assert.equal(a.manifestChecksum, b.manifestChecksum);
  assert.equal(a.upstreamRevision, lock.revision);
  const bundle = await verifyBundledSkillSource({ rootPath: join(root, "a"), expectedUpstreamRevision: lock.revision, expectedSkillIds: lock.skillIds });
  for (const id of lock.skillIds) {
    const { markdown } = await bundle.readSkill(id);
    assert.match(markdown, /^---\nname:/);
    assert.doesNotMatch(markdown, /^allowed-tools:/m);
    assert.doesNotMatch(markdown, /\{\{SECTION(?::|_)/);
  }
  assert.match((await bundle.readSkill("gstack-upgrade")).markdown, /name: gstack-upgrade/);
  assert.equal(await bundle.readResource("runtime/connect-chrome/SKILL.md"), (await bundle.readSkill("open-gstack-browser")).markdown);
  assert.match(await bundle.readResource("runtime/SKILL.md"), /^---\nname: gstack\n/);
  assert.match(await bundle.readResource("runtime/qa/sections/browser-setup.md"), /./);
  assert.ok(bundle.manifest.files.some((file) => file.path.startsWith("runtime/lib/")));
  assert.ok(bundle.manifest.files.some((file) => file.path.startsWith("runtime/bin/")));
  // Upstream benchmark runtime imports helpers stored under test/, not only bin/lib.
  assert.match(await bundle.readResource("runtime/test/helpers/benchmark-runner.ts"), /runBenchmark/);
  assert.match(await bundle.readResource("runtime/test/helpers/providers/claude.ts"), /ClaudeAdapter/);
  for (const path of ["bin/gstack-lease", "bin/gstack-harness-pid.sh", "lib/autoplan-admission.ts", "autoplan/DRIVER.md.tmpl", "test/gstack-lease.test.ts"]) {
    assert.equal(await bundle.readResource(`runtime/${path}`), await readFile(join(sourcePath, path), "utf8"), path);
  }
  assert.match(await bundle.readResource("runtime/autoplan/DRIVER.md.tmpl"), /ANSWER_BY_REQUIRED/);
  assert.match((await bundle.readSkill("review")).markdown, /Then Read QA's `sections\/scope\.md` in full/);
  assert.match(await bundle.readResource("LICENSE"), /MIT/);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: sourcePath, encoding: "utf8" }), before);
  await assert.rejects(buildGstackSourceBundle({ sourcePath, outputPath: join(root, "a"), bunCommand }), /gstack_output_already_exists/);
});
