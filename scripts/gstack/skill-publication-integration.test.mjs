import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../../packages/core/dist/index.js";
import { prepareRunSkillSource } from "../../packages/daemon/dist/features/runs/skill-source-context.js";

const stage = process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE;
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const lock = JSON.parse(await readFile(new URL("./upstream-lock.json", import.meta.url)));
const reviewed = JSON.parse(await readFile(new URL("./reviewed-source-bundle.json", import.meta.url)));

test("all frozen 57 real skill bodies survive atomic source publication and complete context loading", {
  skip: !stage && "Set LING_GSTACK_PLATFORM_RESOURCE_STAGE under managed supervision",
}, async t => {
  const root = await realpath(stage);
  const bytes = await readFile(join(root, "source-manifest.json"));
  assert.equal(hash(bytes), reviewed.manifestChecksum);
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.upstream.revision, lock.revision);
  assert.equal(manifest.upstream.version, lock.version);
  assert.deepEqual(manifest.skills.map(skill => skill.id).sort(), [...lock.skillIds].sort());
  const files = new Map(manifest.files.map(file => [file.path, file]));
  const records = [];
  for (const skill of manifest.skills) {
    const expected = files.get(skill.entryPath);
    assert.ok(expected);
    const path = resolve(root, skill.entryPath);
    assert.ok(path.startsWith(`${root}/`));
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    assert.equal(await realpath(path), path);
    assert.equal(info.size, expected.sizeBytes);
    assert.ok(info.size <= 256 * 1024);
    const body = await readFile(path);
    assert.equal(hash(body), expected.checksum);
    records.push({ snapshot: { id: `frozen-${skill.id}`, skillId: skill.id, sourceKind: "gstack-skill-directory",
      upstreamName: "gstack", upstreamVersion: lock.version, upstreamSkillPath: skill.entryPath,
      sourceChecksum: expected.checksum, rawSkillMarkdown: body.toString("utf8") } });
  }
  // Disposable source-context fixtures do not activate a real client or execute any skill body.
  const cwd = await mkdtemp(join(tmpdir(), "ling-frozen-skill-publication-"));
  let store = createSqliteRunStore(cwd);
  try {
    const published = store.publishSkillSourceBatch({ records }, "2026-10-15T12:00:00.000Z");
    assert.equal(published.snapshots.length, 57);
    store.close();
    store = createSqliteRunStore(cwd);
    let longest = 0, total = 0;
    for (const record of records) {
      const expected = record.snapshot;
      const prompt = prepareRunSkillSource(store, expected.skillId, "no_operation");
      assert.equal(prompt.context.loaded, true, expected.skillId);
      assert.equal(prompt.context.truncated, false, expected.skillId);
      assert.equal(prompt.context.loadedChars, expected.rawSkillMarkdown.length, expected.skillId);
      assert.ok(prompt.promptFragment.includes(expected.rawSkillMarkdown), expected.skillId);
      longest = Math.max(longest, expected.rawSkillMarkdown.length);
      total += expected.rawSkillMarkdown.length;
    }
    assert.deepEqual(store.publishSkillSourceBatch({ records }, "2026-10-15T13:00:00.000Z"), published);
    assert.equal(store.listSkillSourceSnapshots({ includeArchived: true }).length, 57);
    t.diagnostic(JSON.stringify({ skills: 57, longestChars: longest, totalChars: total,
      sourceManifestChecksum: hash(bytes), installedClientAcceptance: false }));
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
