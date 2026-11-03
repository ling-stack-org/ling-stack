import assert from "node:assert/strict";
import test from "node:test";
import "./support/workflow-isolation-evidence-fixture.mjs";

const { selectWorkflowTimelineItems } = await import("../src/lib/workflow-timeline-content.ts");

const summary = { id: "protocol:workflow:one", kind: "protocolEvent", protocolKind: "workflow",
  availableActions: ["advance_workflow", "cancel_workflow"] };
const execution = { id: "write:one", kind: "fileChange", files: [] };

test("workflow lifecycle controls remain beside retained execution facts", () => {
  assert.deepEqual(selectWorkflowTimelineItems([execution], summary, true), [summary, execution]);
  const busy = { ...summary, availableActions: ["open_details"] };
  assert.deepEqual(selectWorkflowTimelineItems([execution], busy, true), [busy, execution]);
});

test("terminal facts do not acquire lifecycle controls or duplicate the workflow summary", () => {
  assert.deepEqual(selectWorkflowTimelineItems([execution], summary, false), [execution]);
  assert.deepEqual(selectWorkflowTimelineItems([summary, execution], summary, true), [summary, execution]);
});

test("empty plan skeletons retain the ordinary workflow fallback", () => {
  assert.deepEqual(selectWorkflowTimelineItems([{ id: "plan", kind: "plan" }], summary, true), [summary]);
  assert.deepEqual(selectWorkflowTimelineItems([], summary, false), [summary]);
});
