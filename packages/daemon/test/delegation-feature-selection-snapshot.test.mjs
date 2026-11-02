import assert from "node:assert/strict";
import test from "node:test";
import { createHarnessFeatureSnapshot } from "../dist/features/harness/index.js";

const config = selectedWorkflowIds => ({ harness: {
  continuations: { mode: "enforce" }, toolBroker: { mode: "enforce" },
  evaluations: { mode: "off", modelGate: "shadow" },
  delegations: { mode: "enforce", maxDepth: 4, selectedWorkflowIds },
} });

test("Run snapshot freezes exact Host workflow selection rather than a later config reference", () => {
  const selected = ["qa-workflow-1"];
  const snapshot = createHarnessFeatureSnapshot(config(selected));
  assert.deepEqual(snapshot.delegationSelectedWorkflowIds, ["qa-workflow-1"]);
  assert.notEqual(snapshot.delegationSelectedWorkflowIds, selected);
  selected.push("qa-workflow-2");
  assert.deepEqual(snapshot.delegationSelectedWorkflowIds, ["qa-workflow-1"]);
  assert.equal(Object.isFrozen(snapshot.delegationSelectedWorkflowIds), true);
});

test("an absent initial selection freezes empty and cannot retroactively authorize an old Run", () => {
  const snapshot = createHarnessFeatureSnapshot(config(undefined));
  assert.deepEqual(snapshot.delegationSelectedWorkflowIds, []);
  assert.equal(Object.isFrozen(snapshot.delegationSelectedWorkflowIds), true);
});

for (const selected of [["qa-workflow-1", "qa-workflow-1"], ["*"], [""], "qa-workflow-1", Array(101).fill("qa")]) {
  test(`invalid Host selection is not frozen as Run authority: ${JSON.stringify(selected).slice(0, 70)}`, () => {
    assert.throws(() => createHarnessFeatureSnapshot(config(selected)), { code: "delegation.invalid_workflow_selection" });
  });
}
