import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { captureSkillDefinitionSnapshot, capturePreparedRunnerInput, readPreparedRunnerInput,
  restorePreparedRunnerOptions } from "../dist/features/runs/prepared-runner-input.js";

test("prepared executions retain their skill definition revision and text after an edit or undo", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-definition-snapshot-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = "2026-10-29T00:00:00.000Z";
  const definition = { id: "snapshot", name: "Snapshot", summary: "Original", roleAffinity: ["engineer"],
    promptFragments: ["Read and compare both receipt totals."], requiredTools: ["read"],
    requiredProviderCapabilities: ["chat"], approvalProfile: { mode: "none" }, stateEffects: [] };
  const draft = store.createSkillImportDraft({ source: "custom", name: "Snapshot",
    definitions: [{ definition }] }, now);
  const skill = store.publishSkillImportDraft(draft.id, now)[0];
  const snapshot = captureSkillDefinitionSnapshot(store, skill.definition);
  const options = { cwd, agentDir: join(cwd, "agent"), task: { id: "snapshot-task", title: "Compare", prompt: "Compare totals." },
    provider: { provider: "fixture", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", reasoning: false },
    tools: ["read"], appendSystemPrompt: skill.definition.promptFragments };
  const preparedInput = await new PiRunnerAdapter().prepareTaskInput(options);
  const payload = capturePreparedRunnerInput({ runnerId: "pi", options, preparedInput, skillDefinitionSnapshot: snapshot });
  const next = { ...definition, summary: "Edited", promptFragments: ["Compare tax and totals separately."] };
  const editDraft = store.createSkillImportDraft({ source: "custom", packId: skill.packId, name: "Snapshot", definitions: [{ definition: next }] }, now);
  const edited = store.publishSkillRevisionDraft({ draftId: editDraft.id, skillId: skill.id, expectedUpdatedAt: skill.updatedAt }, now);
  const nextSnapshot = captureSkillDefinitionSnapshot(store, edited.definition);
  assert.notEqual(snapshot.revisionId, nextSnapshot.revisionId);
  assert.notEqual(snapshot.definitionHash, nextSnapshot.definitionHash);
  const restored = restorePreparedRunnerOptions(readPreparedRunnerInput(payload, options), { ...options, appendSystemPrompt: next.promptFragments });
  assert.deepEqual(restored.appendSystemPrompt, definition.promptFragments);
  assert.equal(payload.skillDefinitionSnapshot.revisionId, snapshot.revisionId);
  store.undoSkillDefinitionRevision(skill.id, { revisionId: nextSnapshot.revisionId, expectedUpdatedAt: edited.updatedAt }, now);
  assert.deepEqual(readPreparedRunnerInput(payload, options).skillDefinitionSnapshot, snapshot);
  for (const mutate of [
    value => { value.skillDefinitionSnapshot.definitionHash = "forged"; },
    value => { value.skillDefinitionSnapshot.extra = "forged"; },
    value => { value.skillDefinitionSnapshot.revisionId = 1; },
  ]) {
    const forged = structuredClone(payload); mutate(forged);
    assert.throws(() => readPreparedRunnerInput(forged, options), /Invalid prepared skill definition snapshot/);
  }
});
