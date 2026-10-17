import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
