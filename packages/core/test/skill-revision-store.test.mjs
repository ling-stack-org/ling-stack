import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, SkillRevisionStoreError } from "../dist/index.js";

const createdAt = "2026-07-16T00:00:00.000Z";
const revisedAt = "2026-07-16T01:00:00.000Z";

function definition(id, name = id) {
  return {
    id,
    name,
    summary: `${name} summary`,
    roleAffinity: ["engineer"],
    promptFragments: [`Run ${name}.`],
    requiredTools: ["read"],
    requiredProviderCapabilities: ["chat"],
    approvalProfile: { mode: "none" },
    stateEffects: [],
  };
}

test("skill revision updates only the target definition and preserves registry metadata", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-revision-store-"));
  const store = createSqliteRunStore(cwd);
  try {
    const initialDraft = store.createSkillImportDraft({
      source: "custom",
      sourcePath: "skills.json",
      packId: "shared-skill-pack",
      name: "Original pack",
      version: "1.0.0",
      description: "Original pack description",
      definitions: [
        { definition: definition("editable-skill", "Editable skill") },
        { definition: definition("sibling-skill", "Sibling skill") },
      ],
    }, createdAt);
    const [original, sibling] = store.publishSkillImportDraft(initialDraft.id, createdAt);
    assert.ok(original);
    assert.ok(sibling);

    const revisionDraft = store.createSkillImportDraft({
      source: original.source,
      sourcePath: original.sourcePath,
      packId: original.packId,
      name: "This must not replace pack metadata",
      version: original.version,
      description: "Revision input",
      definitions: [{
        definition: {
          ...original.definition,
          name: "Edited skill",
          summary: "Edited summary",
          promptFragments: ["Use the revised instructions."],
        },
        visibility: original.visibility,
      }],
    }, revisedAt);
    const updated = store.publishSkillRevisionDraft({
      draftId: revisionDraft.id,
      skillId: original.id,
      expectedUpdatedAt: original.updatedAt,
    }, revisedAt);

    assert.equal(updated.definition.name, "Edited skill");
    assert.equal(updated.definition.summary, "Edited summary");
    assert.equal(updated.packId, original.packId);
    assert.equal(updated.source, original.source);
    assert.equal(updated.sourcePath, original.sourcePath);
    assert.equal(updated.version, original.version);
    assert.equal(updated.reviewStatus, original.reviewStatus);
    assert.deepEqual(updated.visibility, original.visibility);
    assert.equal(updated.createdAt, original.createdAt);
    assert.equal(updated.updatedAt, revisedAt);
    assert.deepEqual(store.getSkillRegistryEntry(sibling.id), sibling);

    const database = new DatabaseSync(resolve(cwd, ".ling-stack", "ling-stack.sqlite"));
    try {
      const pack = database.prepare("SELECT name, description FROM skill_packs WHERE id = ?").get(original.packId);
      assert.equal(pack.name, "Original pack");
      assert.equal(pack.description, "Original pack description");
    } finally {
      database.close();
    }
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("skill revision rejects stale updates and invalid drafts", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-revision-conflict-"));
  const store = createSqliteRunStore(cwd);
  try {
    const initialDraft = store.createSkillImportDraft({
      source: "custom",
      name: "Revision conflict pack",
      description: "Revision conflict pack",
      definitions: [{ definition: definition("revision-conflict") }],
    }, createdAt);
    const original = store.publishSkillImportDraft(initialDraft.id, createdAt)[0];
    const revisionDraft = store.createSkillImportDraft({
      source: original.source,
      packId: original.packId,
      name: original.definition.name,
      description: original.definition.summary,
      definitions: [{ definition: { ...original.definition, summary: "New summary" } }],
    }, revisedAt);

    assert.throws(
      () => store.publishSkillRevisionDraft({
        draftId: revisionDraft.id,
        skillId: original.id,
        expectedUpdatedAt: "2026-07-15T00:00:00.000Z",
      }, revisedAt),
      (error) => error instanceof SkillRevisionStoreError && error.code === "skill_revision_conflict",
    );
    assert.equal(store.getSkillRegistryEntry(original.id).definition.summary, original.definition.summary);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
