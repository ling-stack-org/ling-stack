import assert from "node:assert/strict";
import test from "node:test";
import { runStatusPresentation } from "../src/features/runs/run-status-presentation.ts";
import { channelActiveStatusPresentation } from "../src/features/workspace/channel-active-status-presentation.ts";
import { channelWorkflowRunStatusPresentation, channelWorkflowStatusPresentation, channelWorkflowStepStatusPresentation } from "../src/features/workspace/channel-workflow-status-presentation.ts";
import { workUnitStatusPresentation } from "../src/features/workspace/runtime-status-view-models.ts";

test("normal and channel runs use the same neutral yielded presentation", () => {
  const normal = runStatusPresentation("yielded");
  assert.deepEqual(normal, { labelKey: "Execution yielded", tone: "neutral" });
  assert.deepEqual(channelActiveStatusPresentation({ kind: "run", status: "yielded" }), normal);
  assert.deepEqual(channelWorkflowRunStatusPresentation("yielded"), { id: "yielded", ...normal });
});

test("logical input waiting is not approval, success or failure", () => {
  const waiting = { labelKey: "Waiting for input", tone: "neutral" };
  assert.deepEqual(workUnitStatusPresentation("waiting_for_input"), waiting);
  assert.deepEqual(channelWorkflowStatusPresentation("waiting_for_input"), { id: "waiting_for_input", ...waiting });
  assert.deepEqual(channelWorkflowStepStatusPresentation("waiting_for_input"), { id: "waiting_for_input", ...waiting });
});

test("approval and actual completion retain their distinct status presentations", () => {
  assert.deepEqual(runStatusPresentation("waiting_for_approval"), { labelKey: "Waiting for approval", tone: "warning" });
  assert.equal(runStatusPresentation("succeeded").tone, "success");
  assert.equal(runStatusPresentation("failed").tone, "danger");
});
