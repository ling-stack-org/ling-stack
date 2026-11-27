import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, resolveUserConfigPaths } from "../../core/dist/index.js";
import { prepareBundledSkillStartup } from "../dist/features/skills/bundled-startup.js";
import { changeOptionalSkillPack } from "../dist/features/skills/optional-pack-installation.js";
import { retainPackagedSkillGeneration } from "../dist/features/skills/packaged-history.js";
import { listEffectiveSkillRegistryEntries } from "../dist/features/skills/registry.js";
import { prepareRunSkillSource } from "../dist/features/runs/skill-source-context.js";

const now = "2026-11-27T00:00:00Z";
const checksum = (contents: string) => `sha256:${createHash("sha256").update(contents).digest("hex")}`;

async function smallRetainedGstack(root: string, version: number) {
  const rootPath = join(root, `gstack-${version}`);
  const body = `---\nname: qa\ndescription: Review the workspace\n---\n\nVersion ${version} workflow.\n`;
  const license = "MIT\n";
  await mkdir(rootPath);
  const { platform, arch } = process;
  assert.ok(platform === "darwin" || platform === "win32");
  assert.ok(arch === "arm64" || arch === "x64");
  const target = { platform, arch };
  const manifest = { schemaVersion: 1, packId: "gstack-default", deliveryStage: "executable",
    upstream: { repository: "https://github.com/garrytan/gstack", revision: String(version).repeat(40), version: `1.0.${version}.0` },
    adaptationRevision: `ling-${version}`, target, licensePath: "LICENSE", skills: [{ id: "qa", entryPath: "SKILL.md", resourcePaths: [] }],
    files: [{ path: "SKILL.md", checksum: checksum(body), sizeBytes: Buffer.byteLength(body) },
      { path: "LICENSE", checksum: checksum(license), sizeBytes: Buffer.byteLength(license) }] };
  const bytes = JSON.stringify(manifest);
  await Promise.all([writeFile(join(rootPath, "SKILL.md"), body), writeFile(join(rootPath, "LICENSE"), license),
    writeFile(join(rootPath, "manifest.json"), bytes)]);
  const selection = { rootPath, expectedManifestChecksum: checksum(bytes), expectedUpstreamRevision: manifest.upstream.revision,
    expectedAdaptationRevision: manifest.adaptationRevision, expectedTarget: target,
    expectedSkillIds: ["qa"] };
  await retainPackagedSkillGeneration(join(resolveUserConfigPaths().sourcesDir, "bundled-gstack"), selection);
  return selection;
}

test("a workspace reuses only known gstack resources and enables the selected rollback generation", {
  skip: !["darwin", "win32"].includes(process.platform),
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-optional-gstack-")));
  const previousHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(root, "home");
  t.after(async () => {
    if (previousHome === undefined) delete process.env.LING_STACK_HOME;
    else process.env.LING_STACK_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const store = createSqliteRunStore(cwd);
  try {
    const set = (action: "install" | "enable" | "disable" | "rollback") => changeOptionalSkillPack(store, "gstack", { action }, now);
    const first = await smallRetainedGstack(root, 1);
    await assert.rejects(set("install"), { code: "skill_pack_runtime_required" });
    (await prepareBundledSkillStartup(first))(store);
    await set("install");
    await set("enable");
    const second = await smallRetainedGstack(root, 2);
    (await prepareBundledSkillStartup(second))(store);
    await set("install");
    const active = () => listEffectiveSkillRegistryEntries(store).find(skill => skill.id === "qa" && skill.source === "gstack");
    assert.equal(active()?.version, "1.0.2.0");
    await set("disable");
    await set("rollback");
    assert.equal(active(), undefined);
    await set("enable");
    assert.equal(active()?.version, "1.0.1.0");
    assert.match((await prepareRunSkillSource(store, "qa", "no_operation")).promptFragment ?? "", /Version 1 workflow/u);
  } finally {
    store.close();
  }
});
