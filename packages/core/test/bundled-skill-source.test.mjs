import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { verifyBundledSkillSource } from "../dist/bundled-skill-source.js";

const revision = "15ebd85cdde6c9a1b2fb707e8573aec18e8f7438";
const checksum = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ling-bundled-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = new Map([
    ["LICENSE", "MIT fixture license\n"],
    ["skills/office-hours/SKILL.md", `# Office Hours\n${"Full rule.\n".repeat(10_000)}END_REQUIRED_RULE\n`],
    ["skills/office-hours/sections/questions.md", "# Questions\nRead the complete chapter.\n"],
    ["runtime/bin/helper.mjs", "export const helper = true;\n"],
  ]);
  for (const [path, value] of content) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), value);
  }
  const manifest = {
    schemaVersion: 1,
    packId: "gstack-default",
    deliveryStage: "source",
    upstream: { repository: "https://github.com/garrytan/gstack", revision, version: "1.91.100.0" },
    adaptationRevision: "ling-host-1",
    licensePath: "LICENSE",
    skills: [{ id: "office-hours", entryPath: "skills/office-hours/SKILL.md", resourcePaths: ["skills/office-hours/sections/questions.md", "runtime/bin/helper.mjs"] }],
    files: [...content].map(([path, value]) => ({ path, checksum: checksum(value), sizeBytes: Buffer.byteLength(value) })),
  };
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { root, manifest, content };
}

async function manyFileFixture(t) {
  const input = await fixture(t);
  for (let index = 0; index < 24; index++) {
    const path = `runtime/bin/dependency-${index}.txt`;
    const bytes = `Authenticated resource ${index}.\n`;
    await writeFile(join(input.root, path), bytes);
    input.manifest.files.push({ path, checksum: checksum(bytes), sizeBytes: Buffer.byteLength(bytes) });
  }
  await writeFile(join(input.root, "manifest.json"), JSON.stringify(input.manifest));
  return input;
}

function observeVerificationHandles({ afterOpen, beforeStat, afterClose } = {}) {
  const original = fsPromises.open;
  const state = { active: 0, maximum: 0, paths: [] };
  fsPromises.open = async (...args) => {
    const handle = await original(...args);
    state.paths.push(args[0]);
    state.maximum = Math.max(state.maximum, ++state.active);
    afterOpen?.(state.paths.length);
    return new Proxy(handle, { get(target, key) {
      if (key === "close") return async () => {
        try { return await target.close(); }
        finally { state.active--; afterClose?.(args[0]); }
      };
      if (key === "stat" && beforeStat) return async () => {
        await beforeStat(args[0]);
        return target.stat();
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  syncBuiltinESMExports();
  return { state, restore() { fsPromises.open = original; syncBuiltinESMExports(); } };
}

test("cold bundle preflight bounds parallel file handles and still verifies every manifest entry", async (t) => {
  // Regression: packaged cold startup exhausted Desktop's 20s deadline while
  // serially hashing the full dependency inventory; no timeout/hash guard is relaxed.
  const { root, manifest } = await manyFileFixture(t);
  const observation = observeVerificationHandles();
  try {
    const bundle = await verifyBundledSkillSource({ rootPath: root,
      expectedUpstreamRevision: revision, expectedSkillIds: ["office-hours"] });
    assert.equal(bundle.manifest.files.length, manifest.files.length);
    assert.ok(observation.state.maximum > 1, "independent resources must not be preflighted serially");
    assert.ok(observation.state.maximum <= 8, "preflight must keep a fixed descriptor/buffer budget");
    assert.equal(observation.state.active, 0);
    const canonicalRoot = await realpath(root);
    assert.deepEqual(observation.state.paths.sort(), manifest.files.map(file => join(canonicalRoot, file.path)).sort());
  } finally { observation.restore(); }
});

test("a parallel preflight failure drains opened resources before rejecting and publishes no source", async (t) => {
  const { root } = await manyFileFixture(t);
  const bytes = await readFile(join(root, "LICENSE"));
  bytes[0] ^= 1; // Same length: fail checksum after the first handle has actually opened.
  await writeFile(join(root, "LICENSE"), bytes);
  let releaseSiblings;
  const siblings = new Promise(resolve => { releaseSiblings = resolve; });
  let firstClosed;
  const failedHandleClosed = new Promise(resolve => { firstClosed = resolve; });
  let allOpened;
  const firstWaveOpened = new Promise(resolve => { allOpened = resolve; });
  const observation = observeVerificationHandles({
    afterOpen: count => { if (count === 8) allOpened(); },
    beforeStat: path => path.endsWith("/LICENSE") ? firstWaveOpened : siblings,
    afterClose: path => { if (path.endsWith("/LICENSE")) firstClosed(); },
  });
  let source;
  let settled = false;
  try {
    const pending = assert.rejects(async () => {
      source = await verifyBundledSkillSource({ rootPath: root,
        expectedUpstreamRevision: revision, expectedSkillIds: ["office-hours"] });
    }, { code: "bundle_resource_checksum_mismatch" }).finally(() => { settled = true; });
    await failedHandleClosed;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(observation.state.paths.length, 8, "failure must stop admission before opening a ninth file");
    assert.equal(observation.state.active, 7);
    assert.equal(settled, false, "failure must wait for the gated sibling handles to drain");
    releaseSiblings();
    await pending;
    assert.equal(observation.state.paths.length, 8, "draining siblings must not resume admission after failure");
    assert.equal(source, undefined);
    assert.ok(observation.state.maximum <= 8);
    assert.equal(observation.state.active, 0, "failure must not return while sibling handles are still open");
  } finally { releaseSiblings(); observation.restore(); }
});

test("verified bundled sources retain complete long instructions and lazily readable chapters", async (t) => {
  const { root, content } = await fixture(t);
  const bundle = await verifyBundledSkillSource({ rootPath: root, expectedUpstreamRevision: revision, expectedSkillIds: ["office-hours"] });
  assert.equal(bundle.manifest.upstream.version, "1.91.100.0");
  assert.equal(bundle.manifest.deliveryStage, "source");
  const skill = await bundle.readSkill("office-hours");
  assert.equal(skill.markdown, content.get("skills/office-hours/SKILL.md"));
  assert.match(skill.markdown, /END_REQUIRED_RULE\n$/);
  assert.equal(await bundle.readResource("skills/office-hours/sections/questions.md"), content.get("skills/office-hours/sections/questions.md"));
  assert.equal(bundle.manifestChecksum, checksum(await readFile(join(root, "manifest.json"))));
});

test("complete dependency manifests larger than the legacy two-MiB cap remain verifiable", async (t) => {
  const { root, manifest } = await fixture(t);
  const folder = "runtime/resources/dependency-inventory";
  await mkdir(join(root, folder), { recursive: true });
  const bytes = Buffer.from("Reviewed dependency resource.\n");
  for (let index = 0; index < 10_000; index++) {
    const path = `${folder}/resource-${String(index).padStart(5, "0")}-${"reviewed-".repeat(8)}.txt`;
    await writeFile(join(root, path), bytes);
    manifest.files.push({ path, checksum: checksum(bytes), sizeBytes: bytes.length });
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  assert.ok(manifestBytes.length > 2 * 1024 * 1024);
  await writeFile(join(root, "manifest.json"), manifestBytes);
  const bundle = await verifyBundledSkillSource({ rootPath: root, expectedUpstreamRevision: revision,
    expectedManifestChecksum: checksum(manifestBytes), expectedSkillIds: ["office-hours"] });
  assert.equal(bundle.manifest.files.length, manifest.files.length);
  assert.equal(await bundle.readResource(manifest.files.at(-1).path), bytes.toString());
});

test("dependency manifest byte and file-count limits still reject before inventory traversal", async (t) => {
  const { root, manifest } = await fixture(t);
  await writeFile(join(root, "manifest.json"), Buffer.alloc(16 * 1024 * 1024 + 1, 32));
  await assert.rejects(verifyBundledSkillSource({ rootPath: root, expectedUpstreamRevision: revision,
    expectedSkillIds: ["office-hours"] }), { code: "bundle_manifest_invalid" });
  manifest.files = Array.from({ length: 100_001 }, () => manifest.files[0]);
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(verifyBundledSkillSource({ rootPath: root, expectedUpstreamRevision: revision,
    expectedSkillIds: ["office-hours"] }), { code: "bundle_manifest_invalid" });
});

test("bundled resources reject Windows reserved names even when built on Mac", async (t) => {
  const { root, manifest } = await fixture(t);
  const path = "runtime/AUX.txt";
  await writeFile(join(root, path), "reserved fixture");
  manifest.files.push({ path, checksum: checksum("reserved fixture"), sizeBytes: 16 });
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(verifyBundledSkillSource({ rootPath: root, expectedUpstreamRevision: revision, expectedSkillIds: ["office-hours"] }), { code: "bundle_resource_path_invalid" });
});

for (const [name, mutate, code] of [
  ["wrong source revision", (_, manifest) => { manifest.upstream.revision = "0".repeat(40); }, "bundle_revision_mismatch"],
  ["incomplete skill inventory", (_, manifest) => { manifest.skills = []; }, "bundle_manifest_invalid"],
  ["duplicate skill identities", (_, manifest) => { manifest.skills.push(manifest.skills[0]); }, "bundle_skill_inventory_mismatch"],
  ["resource traversal", (_, manifest) => { manifest.files[0].path = "../outside"; }, "bundle_resource_path_invalid"],
  ["nonportable trailing path", (_, manifest) => { manifest.files[0].path = "runtime/bad. "; }, "bundle_resource_path_invalid"],
  ["missing dependency inventory", (_, manifest) => { manifest.skills[0].resourcePaths.push("runtime/bin/missing.mjs"); }, "bundle_resource_not_in_manifest"],
  ["tampered resource", async (root) => { await writeFile(join(root, "runtime/bin/helper.mjs"), "export const helper = false;\n"); }, "bundle_resource_checksum_mismatch"],
  ["missing resource", async (root) => { await rm(join(root, "runtime/bin/helper.mjs")); }, "bundle_file_inventory_mismatch"],
  ["unexpected unverified resource", async (root) => { await writeFile(join(root, "runtime/bin/extra.mjs"), "extra"); }, "bundle_file_inventory_mismatch"],
  ["symlink resource", async (root) => { await rm(join(root, "runtime/bin/helper.mjs")); await symlink(join(root, "LICENSE"), join(root, "runtime/bin/helper.mjs")); }, "bundle_resource_path_invalid"],
]) {
  test(`bundled source verification rejects ${name}`, async (t) => {
    const { root, manifest } = await fixture(t);
    await mutate(root, manifest);
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
    await assert.rejects(verifyBundledSkillSource({ rootPath: root, expectedUpstreamRevision: revision, expectedSkillIds: ["office-hours"] }), { code });
  });
}

test("source-only bundles cannot pass executable-client validation", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(verifyBundledSkillSource({ rootPath: root, expectedUpstreamRevision: revision, expectedSkillIds: ["office-hours"], requireExecutable: true }), { code: "bundle_not_executable" });
});

test("lazy chapter loads detect corruption after initial verification", async (t) => {
  const { root } = await fixture(t);
  const bundle = await verifyBundledSkillSource({ rootPath: root, expectedUpstreamRevision: revision, expectedSkillIds: ["office-hours"] });
  await writeFile(join(root, "skills/office-hours/sections/questions.md"), "changed");
  await assert.rejects(bundle.readResource("skills/office-hours/sections/questions.md"), { code: "bundle_resource_checksum_mismatch" });
  await assert.rejects(bundle.readResource("../LICENSE"), { code: "bundle_resource_not_in_manifest" });
});

test("streamed preflight accepts empty resources and lazy reads reject equal-length changes", async (t) => {
  const { root, manifest, content } = await fixture(t);
  const path = "runtime/bin/empty.txt";
  await writeFile(join(root, path), "");
  manifest.files.push({ path, checksum: checksum(""), sizeBytes: 0 });
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  const bundle = await verifyBundledSkillSource({ rootPath: root, expectedUpstreamRevision: revision,
    expectedSkillIds: ["office-hours"] });
  assert.equal(await bundle.readResource(path), "");
  const chapter = "skills/office-hours/sections/questions.md";
  const changed = content.get(chapter).replace("Read", "Skip");
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(content.get(chapter)));
  await writeFile(join(root, chapter), changed);
  for (let repeat = 0; repeat < 3; repeat++) {
    await assert.rejects(bundle.readResource(chapter), { code: "bundle_resource_checksum_mismatch" });
  }
  await writeFile(join(root, chapter), content.get(chapter));
  assert.equal(await bundle.readResource(chapter), content.get(chapter));
});

test("manifest identity is immutable and independently pinned", async (t) => {
  const { root } = await fixture(t);
  const bundle = await verifyBundledSkillSource({ rootPath: root, expectedUpstreamRevision: revision, expectedSkillIds: ["office-hours"] });
  assert.throws(() => { bundle.manifest.files[0].path = "elsewhere"; }, TypeError);
  await assert.rejects(verifyBundledSkillSource({ rootPath: root, expectedUpstreamRevision: revision, expectedSkillIds: ["office-hours"], expectedManifestChecksum: "sha256:bad" }), { code: "bundle_manifest_checksum_mismatch" });
  await assert.rejects(verifyBundledSkillSource({ rootPath: root, expectedUpstreamRevision: revision, expectedSkillIds: ["office-hours"], expectedAdaptationRevision: "different" }), { code: "bundle_adaptation_mismatch" });
});

test("bundled manifests reject case-colliding Windows resource identities", async (t) => {
  const { root, manifest } = await fixture(t);
  const file = manifest.files.find((file) => file.path === "runtime/bin/helper.mjs");
  manifest.files.push({ ...file, path: "RUNTIME/bin/helper.mjs" });
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(verifyBundledSkillSource({ rootPath: root, expectedUpstreamRevision: revision, expectedSkillIds: ["office-hours"] }), { code: "bundle_duplicate_identity" });
});

test("changing a manifest stage is not authority to publish executable resources", async (t) => {
  const { root, manifest } = await fixture(t);
  manifest.deliveryStage = "executable";
  manifest.target = { platform: "darwin", arch: "arm64" };
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(verifyBundledSkillSource({ rootPath: root, expectedUpstreamRevision: revision, expectedSkillIds: ["office-hours"], requireExecutable: true }), { code: "bundle_runtime_identity_unpinned" });
});
