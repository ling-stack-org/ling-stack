import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { PackagedSkillRuntime, PackagedSkillRuntimeCatalog, preparePackagedSkillState,
  installPackagedSkillRuntime, restorePackagedSkillContext } from "../dist/features/skills/packaged-runtime.js";

const hash = text => `sha256:${createHash("sha256").update(text).digest("hex")}`;
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-runtime-binding-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "runtime"));
  const path = "runtime/SKILL.md", text = "# Authenticated skill\n";
  await mkdir(join(root, "state"));
  const manifest = { deliveryStage: "executable", upstream: { revision: "1".repeat(40) }, adaptationRevision: "ling-test",
    skills: [{ id: "qa", entryPath: path }], files: [{ path, checksum: hash(text), sizeBytes: text.length }] };
  await writeFile(join(root, path), text);
  const bytes = JSON.stringify(manifest);
  await writeFile(join(root, "manifest.json"), bytes);
  const source = { manifest, manifestChecksum: hash(bytes) };
  const context = { loaded: true, runtimeViewKind: "original_source", sourceKind: "gstack-skill-directory",
    skillId: "qa", sourceChecksum: hash(text), truncated: false,
    referencedFiles: [{ path: "manifest.json", checksum: source.manifestChecksum, kind: "other", includedInSnapshot: false }] };
  return { root, source, context, runtime: new PackagedSkillRuntime(root, source) };
}
test("new runs bind authenticated versions and frozen runs cannot silently upgrade", async t => {
  const { runtime, context } = await fixture(t);
  const bound = runtime.bind(context);
  assert.equal(bound.resourceBinding.sourceChecksum, context.sourceChecksum);
  assert.deepEqual(runtime.restore(bound, "qa"), bound);
  assert.throws(() => runtime.restore(context, "qa"), /binding_missing/);
  assert.throws(() => runtime.restore(undefined, "qa"), /binding_missing/);
  assert.throws(() => runtime.restore({ ...bound, skillId: "other" }, "qa"), /resource_mismatch/);
  for (const key of Object.keys(bound.resourceBinding)) {
    assert.throws(() => runtime.restore({ ...bound, resourceBinding: { ...bound.resourceBinding, [key]: "different" } }), /version_unavailable/);
  }
  assert.throws(() => runtime.bind({ ...context, sourceChecksum: hash("different") }), /resource_mismatch/);
  assert.throws(() => runtime.bind({ ...context, truncated: true }), /resource_mismatch/);
  assert.throws(() => runtime.bind({ ...bound, sourceKind: "manual-markdown" }), /resource_mismatch/);
  assert.throws(() => runtime.restore(bound, "implement"), /resource_mismatch/);
  assert.throws(() => runtime.bind({ ...context, referencedFiles: [] }), /identity_missing/);
});
test("package mutations before admission and before launch fail closed", async t => {
  const { runtime, root, source, context } = await fixture(t);
  await writeFile(join(root, "runtime/SKILL.md"), "# Modified skill\n");
  assert.throws(() => runtime.bind(context), /runtime_changed/);
  assert.throws(() => new PackagedSkillRuntime(root, source), /runtime_changed/);
});
test("trusted paths are package-owned; state aliases are rejected", async t => {
  const { runtime, root, context } = await fixture(t);
  const state = join(root, "state");
  const env = runtime.environment(runtime.bind(context), state, "/usr/bin");
  assert.equal(env.GSTACK_ROOT, join(root, "runtime"));
  assert.equal(env.BROWSE_STATE_FILE, join(state, "browse.json"));
  assert.equal(env.CHROMIUM_PROFILE, join(state, "chromium-profile"));
  assert.equal(env.LING_GSTACK_PATH_PREFIX, [join(root, "runtime/tools"), join(root, "runtime/node_modules/.bin")].join(delimiter));
  assert.ok(env.PATH.startsWith(join(root, "runtime/tools")));
  const alias = `${root}-alias`; await symlink(state, alias);
  t.after(() => rm(alias, { force: true }));
  assert.throws(() => runtime.environment(runtime.bind(context), alias), /state_path_invalid/);
});
test("new near-layer dependency packages reject before admission and before launch", async t => {
  const { runtime, root, source, context } = await fixture(t);
  const dependency = join(root, "runtime/node_modules/playwright");
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, "package.json"), JSON.stringify({ main: "index.js" }));
  await writeFile(join(dependency, "index.js"), "throw new Error('must never execute');\n");
  assert.throws(() => runtime.bind(context), /runtime_path_changed/);
  assert.throws(() => new PackagedSkillRuntime(root, source), /runtime_changed/);
});
test("pre-existing state ancestor aliases are rejected before writing any child", async t => {
  const { root } = await fixture(t);
  const workspace = join(root, "workspace"), outside = join(root, "outside");
  await mkdir(workspace); await mkdir(outside);
  await symlink(outside, join(workspace, "gstack-runs"));
  assert.throws(() => preparePackagedSkillState(workspace, "a".repeat(64)), /state_path_invalid/);
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(outside), []);
});

test("retained admitted generations restore old tasks and pinned new runs without switching resources", async t => {
  const old = await fixture(t), current = await fixture(t);
  // A distinct authenticated adaptation has a different manifest identity.
  const manifest = { ...current.source.manifest, adaptationRevision: "ling-test-v2" };
  const bytes = JSON.stringify(manifest);
  await writeFile(join(current.root, "manifest.json"), bytes);
  const source = { manifest, manifestChecksum: hash(bytes) };
  const latest = new PackagedSkillRuntime(current.root, source);
  const currentContext = { ...current.context, referencedFiles: [
    { path: "manifest.json", checksum: source.manifestChecksum, kind: "other", includedInSnapshot: false },
  ] };
  const frozen = old.runtime.bind(old.context);
  const catalog = new PackagedSkillRuntimeCatalog(latest, [old.runtime]);
  assert.deepEqual(catalog.restore(structuredClone(frozen), "qa"), frozen);
  assert.equal(catalog.bind(old.context).resourceBinding.manifestChecksum, old.source.manifestChecksum);
  assert.equal(catalog.bind(currentContext).resourceBinding.manifestChecksum, source.manifestChecksum);
  assert.equal(catalog.environment(frozen, join(old.root, "state")).GSTACK_ROOT, join(old.root, "runtime"));
  assert.throws(() => new PackagedSkillRuntimeCatalog(latest).restore(frozen, "qa"), /version_unavailable/);
  assert.throws(() => catalog.restore({ ...frozen, resourceBinding: { ...frozen.resourceBinding, sourceChecksum: "wrong" } }, "qa"), /version_unavailable/);
  await writeFile(join(old.root, "runtime/SKILL.md"), "tampered");
  assert.throws(() => catalog.restore(frozen, "qa"), /runtime_changed/);
});

test("resource-boundary restoration normalizes missing files, directories and browser failures to 409", async t => {
  const { root, source, context } = await fixture(t);
  let browserError;
  const runtime = new PackagedSkillRuntime(root, source, { assertCurrent() { if (browserError) throw browserError; } });
  const frozen = runtime.bind(context); installPackagedSkillRuntime(runtime);
  const rejected = (code = "packaged_skill_resource_version_unavailable") => assert.throws(() => restorePackagedSkillContext(frozen, "qa"), error => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, code);
    return true;
  });
  browserError = new Error("bundled_browser_component_invalid"); rejected();
  browserError = Object.assign(new Error("missing browser link"), { code: "ENOENT" }); rejected();
  browserError = undefined;
  await rm(join(root, "runtime/SKILL.md")); rejected("packaged_skill_runtime_path_changed");
  await rm(root, { recursive: true }); rejected();
});
