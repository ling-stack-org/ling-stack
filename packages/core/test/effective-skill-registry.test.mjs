import assert from "node:assert/strict";
import test from "node:test";
import { resolveEffectiveSkillRegistryEntries } from "../dist/index.js";

function entry(id = "review", extra = {}) {
  return {
    id, workspaceId: "workspace_default", packId: "gstack-default", source: "builtin", version: "1.58.3.0",
    definition: { id, name: id, summary: "Old summary", promptFragments: ["Old rules"], roleAffinity: ["engineer"],
      requiredTools: ["read"], requiredProviderCapabilities: ["chat"], approvalProfile: { mode: "none" }, stateEffects: [] },
    visibility: { workspaceVisible: true, promotableToWorkspace: false }, reviewStatus: "builtin",
    createdAt: "2026-10-14T01:00:00.000Z", updatedAt: "2026-10-14T01:00:00.000Z", ...extra,
  };
}

function snapshot(id, extra = {}) {
  return {
    id, workspaceId: "workspace_default", skillId: "review", sourceKind: "gstack-skill-directory",
    upstreamVersion: "1.91.100.0", sourceChecksum: `sha256:${"a".repeat(64)}`,
    rawSkillMarkdown: `---\nname: review\ndescription: ${id} summary\n---\n# Body\n`,
    referencedFiles: [], warnings: [], reviewStatus: "published",
    createdAt: "2026-10-14T01:00:00.000Z", updatedAt: "2026-10-14T01:00:00.000Z", ...extra,
  };
}

function resolve(extra = {}) {
  return resolveEffectiveSkillRegistryEntries({ builtinEntries: [entry()], persistedEntries: [], sourceSnapshots: [], ...extra });
}

for (const status of ["disabled", "archived"]) {
  test(`managed ${status} records suppress their builtin fallback`, () => {
    assert.deepEqual(resolve({ persistedEntries: [entry("review", { source: "gstack", reviewStatus: status })] }), []);
  });
}

test("a registry draft cannot replace the approved builtin or grant capabilities", () => {
  const draft = entry("review", { source: "gstack", reviewStatus: "draft" });
  draft.definition.requiredTools = ["bash", "write"];
  assert.deepEqual(resolve({ persistedEntries: [draft] }), [entry()]);
});

test("same-id custom collisions fail explicitly instead of silently losing one identity", () => {
  assert.throws(() => resolve({ persistedEntries: [entry("review", { source: "custom", reviewStatus: "published" })] }), /skill_registry_identity_collision/);
});

test("source projection uses the active snapshot order, not input order or highest version", () => {
  const first = snapshot("a", { upstreamVersion: "1.58.3.0" });
  const second = snapshot("b", { upstreamVersion: "99.0.0" });
  const before = structuredClone([first, second]);
  for (const sourceSnapshots of [[first, second], [second, first]]) {
    const effective = resolve({ sourceSnapshots })[0];
    assert.equal(effective.definition.summary, "a summary");
    assert.equal(effective.version, "1.58.3.0");
  }
  assert.deepEqual([first, second], before);
});

test("foreign workspace snapshots, drafts and archived versions cannot replace metadata", () => {
  assert.deepEqual(resolve({ sourceSnapshots: [
    snapshot("foreign", { workspaceId: "another-workspace" }),
    snapshot("draft", { reviewStatus: "draft" }),
    snapshot("archived", { reviewStatus: "archived" }),
  ] }), [entry()]);
});

test("an active non-gstack source cannot cause a historical official snapshot to be selected", () => {
  assert.deepEqual(resolve({ sourceSnapshots: [
    snapshot("current-manual", { sourceKind: "manual-markdown", updatedAt: "2026-10-14T02:00:00.000Z" }),
    snapshot("old-official"),
  ] }), [entry()]);
});

test("an unversioned source does not inherit a misleading builtin version", () => {
  const effective = resolve({ sourceSnapshots: [snapshot("unversioned", { upstreamVersion: undefined })] })[0];
  assert.equal(effective.version, undefined);
  assert.equal(effective.definition.summary, "unversioned summary");
});

for (const id of ["implement", "checkpoint"]) {
  test(`Ling-native ${id} is not rewritten by a gstack source snapshot`, () => {
    const native = entry(id);
    assert.deepEqual(resolve({ builtinEntries: [native], sourceSnapshots: [snapshot("upstream", { skillId: id })] }), [native]);
    assert.throws(() => resolve({ builtinEntries: [native], persistedEntries: [entry(id, { source: "gstack", reviewStatus: "published" })] }), /skill_registry_identity_collision/);
  });
}
