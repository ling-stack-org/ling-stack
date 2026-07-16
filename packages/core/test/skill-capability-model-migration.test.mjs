import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

const now = "2026-07-11T00:00:00.000Z";

function skillDefinition(id) {
  return {
    id,
    name: "Capability migration skill",
    summary: "Verifies that skills remain capabilities without workflow stages.",
    roleAffinity: ["custom"],
    promptFragments: ["Use the capability when its trigger matches."],
    requiredTools: ["read"],
    requiredProviderCapabilities: ["chat"],
    approvalProfile: { mode: "none" },
    stateEffects: [],
  };
}

test("sqlite migration removes legacy skill phases without touching workflow metadata", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-capability-migration-"));
  const databasePath = resolve(cwd, ".ling-stack", "ling-stack.sqlite");
  let store = createSqliteRunStore(cwd);
  try {
    const draft = store.createSkillImportDraft({
      source: "custom",
      name: "Legacy draft",
      description: "Legacy draft fixture.",
      definitions: [{ definition: skillDefinition("legacy-draft-skill") }],
    }, now);
    const publishDraft = store.createSkillImportDraft({
      source: "custom",
      name: "Legacy published",
      description: "Legacy registry fixture.",
      definitions: [{ definition: skillDefinition("legacy-published-skill") }],
    }, now);
    store.publishSkillImportDraft(publishDraft.id, now);
    const candidate = store.createSkillCandidate({
      id: "legacy_skill_candidate",
      origin: "manual-draft",
      proposedAction: "create",
      title: "Legacy candidate",
      summary: "Candidate fixture with a nested complete skill definition.",
      definition: {
        positiveTriggers: ["legacy candidate"],
        negativeTriggers: ["unrelated request"],
        procedureSteps: [{ title: "Read the request" }],
        validationSteps: [{ title: "Confirm the result" }],
        requiredTools: ["read"],
        requiredProviderCapabilities: ["chat"],
        skillDefinition: skillDefinition("legacy-candidate-skill"),
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
      sourceRefs: [{ type: "manual", id: "legacy_fixture" }],
    }, now);
    const channel = store.createChannel({ name: "Workflow fixture", boundPath: cwd }, now);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Workflow phase fixture",
      objective: "Preserve real workflow metadata.",
      status: "ready",
      createdBy: "test",
    }, now);
    store.close();

    const database = new DatabaseSync(databasePath);
    try {
      const registry = JSON.parse(database.prepare("SELECT definition_json FROM skill_definitions WHERE id = ?").get("legacy-published-skill").definition_json);
      database.prepare("UPDATE skill_definitions SET definition_json = ? WHERE id = ?").run(
        JSON.stringify({ ...registry, workflowPhase: "operate" }),
        "legacy-published-skill",
      );

      const draftJson = JSON.parse(database.prepare("SELECT draft_json FROM skill_import_drafts WHERE id = ?").get(draft.id).draft_json);
      draftJson.definitions[0].definition.workflowPhase = "test";
      database.prepare("UPDATE skill_import_drafts SET draft_json = ? WHERE id = ?").run(JSON.stringify(draftJson), draft.id);

      const candidateJson = JSON.parse(database.prepare("SELECT definition_json FROM skill_candidates WHERE id = ?").get(candidate.id).definition_json);
      candidateJson.workflowPhase = "review";
      candidateJson.skillDefinition.workflowPhase = "implement";
      database.prepare("UPDATE skill_candidates SET definition_json = ? WHERE id = ?").run(JSON.stringify(candidateJson), candidate.id);

      database.prepare("UPDATE channel_workflows SET metadata_json = ? WHERE id = ?").run(
        JSON.stringify({ phase: "plan", owner: "workflow" }),
        workflow.id,
      );
      database.prepare("DELETE FROM schema_migrations WHERE version = 100").run();
    } finally {
      database.close();
    }

    store = createSqliteRunStore(cwd);
    assert.equal("workflowPhase" in store.getSkillImportDraft(draft.id).definitions[0].definition, false);
    assert.equal("workflowPhase" in store.getSkillRegistryEntry("legacy-published-skill").definition, false);
    const migratedCandidate = store.getSkillCandidate(candidate.id);
    assert.equal("workflowPhase" in migratedCandidate.definition, false);
    assert.equal("workflowPhase" in migratedCandidate.definition.skillDefinition, false);
    store.close();

    const migratedDatabase = new DatabaseSync(databasePath);
    try {
      const workflowMetadata = JSON.parse(migratedDatabase.prepare("SELECT metadata_json FROM channel_workflows WHERE id = ?").get(workflow.id).metadata_json);
      assert.equal(workflowMetadata.phase, "plan");
      assert.ok(migratedDatabase.prepare("SELECT version FROM schema_migrations WHERE version = 100 AND name = 'remove_skill_workflow_phase_metadata'").get());
      const beforeReopen = migratedDatabase.prepare("SELECT definition_json FROM skill_definitions WHERE id = ?").get("legacy-published-skill").definition_json;
      migratedDatabase.close();

      store = createSqliteRunStore(cwd);
      store.close();
      const idempotentDatabase = new DatabaseSync(databasePath);
      try {
        const afterReopen = idempotentDatabase.prepare("SELECT definition_json FROM skill_definitions WHERE id = ?").get("legacy-published-skill").definition_json;
        assert.equal(afterReopen, beforeReopen);
      } finally {
        idempotentDatabase.close();
      }
    } finally {
      if (migratedDatabase.isOpen) {
        migratedDatabase.close();
      }
    }
  } finally {
    if (store?.close) {
      try {
        store.close();
      } catch {
        // The store may already be closed by the idempotency checks above.
      }
    }
    await rm(cwd, { recursive: true, force: true });
  }
});
