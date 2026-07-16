import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

const now = "2026-07-15T00:00:00.000Z";

test("sqlite migration repairs published AI evolution skill ownership and candidate state idempotently", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ai-evolution-migration-"));
  const databasePath = resolve(cwd, ".ling-stack", "ling-stack.sqlite");
  let store = createSqliteRunStore(cwd);
  try {
    const candidate = store.createSkillCandidate({
      id: "skill_candidate_migration_fixture",
      origin: "ling-generated",
      proposedAction: "create",
      status: "approved_for_draft",
      title: "AI evolution migration fixture",
      summary: "Repairs a skill that was published before candidate provenance was preserved.",
      definition: {
        positiveTriggers: ["migration fixture"],
        negativeTriggers: ["unrelated work"],
        procedureSteps: [{ title: "Inspect the fixture" }],
        validationSteps: [{ title: "Confirm repaired ownership" }],
        requiredTools: ["read"],
        requiredProviderCapabilities: ["chat"],
      },
      duplicateAnalysis: {
        decision: "no_overlap",
        similarityScore: 0,
        matchedSkillIds: [],
        matchedCandidateIds: [],
        triggerOverlap: [],
        conflictingFields: [],
        rationale: "Migration fixture.",
      },
      sourceRefs: [{ type: "manual", id: "migration_fixture" }],
    }, now);
    const draft = store.createSkillImportDraft({
      source: "custom",
      sourcePath: candidate.id,
      name: candidate.title,
      description: candidate.summary,
      definitions: [{
        definition: {
          id: "ai-evolution-migrated-skill",
          name: "AI evolution migrated skill",
          summary: candidate.summary,
          roleAffinity: ["custom"],
          promptFragments: ["Use this migration fixture."],
          requiredTools: ["read"],
          requiredProviderCapabilities: ["chat"],
          approvalProfile: { mode: "none" },
          stateEffects: [],
        },
      }],
    }, now);
    const [publishedBeforeMigration] = store.publishSkillImportDraft(draft.id, now);
    assert.notEqual(publishedBeforeMigration.packId, "ling-generated");
    assert.equal(publishedBeforeMigration.sourcePath, candidate.id);
    store.close();

    const database = new DatabaseSync(databasePath);
    try {
      database.prepare("DELETE FROM schema_migrations WHERE version = 102").run();
    } finally {
      database.close();
    }

    store = createSqliteRunStore(cwd);
    const repaired = store.getSkillRegistryEntry(publishedBeforeMigration.id);
    assert.equal(repaired.packId, "ling-generated");
    assert.equal(repaired.sourcePath, `skill-candidates/${candidate.id}`);
    assert.equal(store.getSkillCandidate(candidate.id).status, "published");
    assert.equal(store.listSkillUsageEvents({ candidateId: candidate.id, kind: "published", limit: 10 }).length, 1);
    store.close();

    store = createSqliteRunStore(cwd);
    assert.equal(store.getSkillRegistryEntry(publishedBeforeMigration.id).packId, "ling-generated");
    assert.equal(store.listSkillUsageEvents({ candidateId: candidate.id, kind: "published", limit: 10 }).length, 1);
  } finally {
    try {
      store.close();
    } catch {
      // The store may already be closed by the migration checks above.
    }
    await rm(cwd, { recursive: true, force: true });
  }
});
