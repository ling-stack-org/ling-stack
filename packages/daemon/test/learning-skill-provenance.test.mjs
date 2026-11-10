import assert from "node:assert/strict";
import test from "node:test";
import { learningFixture } from "./support/learning-review-fixture.mjs";
import { captureLearningEvidence, learningEvidenceCurrent } from "../dist/features/learning/evidence.js";
import { commitLearningDraft } from "../dist/features/learning/coordinator.js";

const clock = () => new Date().toISOString();
const definition = { id: "amber", name: "Amber", summary: "Reconcile receipts", roleAffinity: ["engineer"],
  promptFragments: ["Read receipt total."], requiredTools: ["read"], requiredProviderCapabilities: ["chat"],
  approvalProfile: { mode: "none" }, stateEffects: [] };

function editDefinition(f) {
  const current = f.store.getSkillRegistryEntry(definition.id);
  const draft = f.store.createSkillImportDraft({ source: "custom", name: "Amber", definitions: [{
    definition: { ...current.definition, summary: "Later user edit", promptFragments: ["Preserve this later user step."] },
  }] }, clock());
  return f.store.publishSkillRevisionDraft({ draftId: draft.id, skillId: current.id, expectedUpdatedAt: current.updatedAt }, clock());
}

test("learning enrollment preserves the revision used by an older Run and cannot commit it against a newer head", async t => {
  const f = await learningFixture(t, { skillDefinition: definition });
  const usedRevision = f.run.requestSnapshot.skillDefinitionSnapshot.revisionId;
  editDefinition(f);
  const evidence = captureLearningEvidence(f.store, f.run.id, "Also verify the ledger sum.");
  assert.equal(evidence.selectedSkillRevisionId, usedRevision, "the newer head was never used by this Run");
  assert.notEqual(evidence.selectedSkillRevisionId, f.store.getSkillDefinitionRevision(definition.id).id);
  assert.equal(learningEvidenceCurrent(f.store, evidence), false);
  const { job, fence } = f.claim(f.enqueue("explicit", evidence));
  assert.throws(() => commitLearningDraft({ store: f.store, job, fence, draft: f.draft, hub: f.hub }), /learning_source_or_foreground_changed/);
  assert.equal(f.store.listSkillCandidates().length, 0);
  assert.equal(f.store.getSkillRegistryEntry(definition.id).definition.summary, "Later user edit");
});

test("a skill edit after enrollment invalidates the frozen evidence without changing its source revision", async t => {
  const f = await learningFixture(t, { skillDefinition: definition });
  const evidence = captureLearningEvidence(f.store, f.run.id, "Also verify the ledger sum.");
  assert.equal(learningEvidenceCurrent(f.store, evidence), true);
  editDefinition(f);
  assert.equal(learningEvidenceCurrent(f.store, evidence), false);
  assert.equal(captureLearningEvidence(f.store, f.run.id).selectedSkillRevisionId, evidence.selectedSkillRevisionId);
});

test("historical Runs without frozen skill provenance remain inspectable but cannot borrow the current head for corrections", async t => {
  const f = await learningFixture(t, { selectedSkillId: definition.id });
  const imported = f.store.createSkillImportDraft({ source: "custom", name: "Amber", definitions: [{ definition }] }, clock());
  f.store.publishSkillImportDraft(imported.id, clock());
  const evidence = captureLearningEvidence(f.store, f.run.id);
  assert.equal(evidence.selectedSkillId, definition.id);
  assert.equal(evidence.selectedSkillRevisionId, undefined);
  assert.ok(evidence.missing.includes("skill_provenance_unavailable"));
  assert.equal(learningEvidenceCurrent(f.store, evidence), true);
  assert.throws(() => captureLearningEvidence(f.store, f.run.id, "Also verify the ledger sum."), /learning_skill_provenance_unavailable/);
});

test("skill correction enrollment validates the frozen identity, revision and definition hash", async t => {
  const f = await learningFixture(t, { skillDefinition: definition });
  const snapshot = f.run.requestSnapshot.skillDefinitionSnapshot;
  for (const invalid of [
    { ...snapshot, skillId: "other-skill" },
    { ...snapshot, revisionId: "missing-revision" },
    { ...snapshot, definitionHash: `sha256:${"0".repeat(64)}` },
    { ...snapshot, definitionHash: undefined },
    { ...snapshot, revisionId: undefined },
  ]) {
    f.database.prepare("UPDATE run_sessions SET request_snapshot_json = ? WHERE id = ?")
      .run(JSON.stringify({ skillDefinitionSnapshot: invalid }), f.run.id);
    assert.throws(() => captureLearningEvidence(f.store, f.run.id, "Also verify the ledger sum."), /learning_skill_provenance_unavailable/);
    assert.equal(captureLearningEvidence(f.store, f.run.id).selectedSkillRevisionId, undefined);
    assert.equal(learningEvidenceCurrent(f.store, f.evidence), false);
  }
});
