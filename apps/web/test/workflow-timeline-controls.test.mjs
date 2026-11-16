import assert from "node:assert/strict";
import test from "node:test";
import "./support/workflow-isolation-evidence-fixture.mjs";

const { hasCollaborativeWorkflowGraph, selectWorkflowTimelineItems, workflowConversationTimelineItems } = await import("../src/lib/workflow-timeline-content.ts");

const summary = { id: "protocol:workflow:one", kind: "protocolEvent", protocolKind: "workflow",
  availableActions: ["advance_workflow", "cancel_workflow"] };
const execution = { id: "write:one", kind: "fileChange", files: [] };
const step = (id, dependencies = [], participant = "ling") => ({ id, workflowId: "one", position: 1,
  title: id, status: "succeeded", toParticipantId: participant, toParticipantLabel: "Same label",
  metadata: { dependsOnStepIds: dependencies } });

test("single steps and single-agent serial chains have no graph, even with redundant dependency edges", () => {
  assert.equal(hasCollaborativeWorkflowGraph("one", []), false);
  assert.equal(hasCollaborativeWorkflowGraph("one", [step("a")]), false);
  assert.equal(hasCollaborativeWorkflowGraph("one", [step("a"), step("b", ["a"]), step("c", ["a", "b"])]), false);
  assert.equal(hasCollaborativeWorkflowGraph("one", [step("a"), { ...step("b", ["a"]), toParticipantLabel: "Other label" }]), false);
});

test("parallel roots, fan-out and multiple durable agent identities qualify independently of current status", () => {
  for (const status of ["queued", "running", "succeeded", "cancelled"]) {
    for (const tasks of [[step("a"), step("b")], [step("a"), step("b", ["a"]), step("c", ["a"])],
      [step("a"), step("b", ["a"], "qa")]]) {
      assert.equal(hasCollaborativeWorkflowGraph("one", tasks.map(task => ({ ...task, status }))), true);
    }
  }
});

test("missing, malformed, cyclic and truncated dependency data never fabricates parallelism", () => {
  for (const metadata of [undefined, {}, { dependsOnStepIds: null }, { dependsOnStepIds: "[]" },
    { dependsOnStepIds: ["missing"] }, { dependsOnStepIds: ["b"] }]) {
    assert.equal(hasCollaborativeWorkflowGraph("one", [step("a"), { ...step("b", ["a"]), metadata }]), false);
  }
  assert.equal(hasCollaborativeWorkflowGraph("one", [step("a", ["b"]), step("b", ["a"])]), false);
  assert.equal(hasCollaborativeWorkflowGraph("one", [step("a"), { ...step("foreign", [], "qa"), workflowId: "other" }]), false);
  assert.equal(hasCollaborativeWorkflowGraph("one", Array.from({ length: 129 }, (_, i) => step(`step-${i}`))), false);
  assert.equal(hasCollaborativeWorkflowGraph("one", [step("a"), { ...step("b", [], "qa"), metadata: undefined }]), true,
    "known different agents do not require guessing dependencies");
});

test("a collaborative graph summary can accompany retained execution facts", () => {
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

test("integration uses one concise status without round details or duplicate lifecycle controls", () => {
  const owner = { ...summary, sourceRefs: [{ kind: "channel_workflow", id: "one" }] };
  const integration = { id: "workflow-isolation:one:observation", kind: "protocolEvent", protocolKind: "workflow",
    status: "succeeded", sourceRefs: [{ kind: "workflow", id: "one" }] };
  const message = { id: "text", kind: "agentMessage", markdown: "The result" };
  const facts = [owner, message, execution, integration];
  assert.deepEqual(workflowConversationTimelineItems(facts, new Set(["one"])), [owner, message, execution]);
  const terminalRound = { ...integration, id: "workflow-isolation:one:round:r1:1", meta: "Applied to target", status: "succeeded" };
  const terminal = workflowConversationTimelineItems([owner, integration, terminalRound], new Set(["one"]));
  assert.deepEqual(terminal.map(item => item.id), [owner.id, terminalRound.id]);
  assert.equal(terminal[1].title, "Applied to target");
  assert.equal(terminal[1].description, undefined);
  assert.deepEqual(terminal[1].availableActions, []);
  assert.equal(workflowConversationTimelineItems(facts, new Set()).some(item => item.id === integration.id), true,
    "a missing graph must retain the status fallback");
  assert.equal(workflowConversationTimelineItems([integration], new Set(["one"])).length, 1,
    "a missing owning row must not swallow evidence");
  for (const status of ["running", "waiting", "blocked", "failed", "cancelled"]) {
    const attention = { ...integration, status, meta: "Actual integration state", description: "Internal journal details" };
    const round = { ...attention, id: "workflow-isolation:one:round:r1:1", availableActions: ["recover_workflow_conflict"] };
    const visible = workflowConversationTimelineItems([owner, attention, round], new Set(["one"]));
    assert.deepEqual(visible.map(item => item.id), [owner.id, attention.id]);
    assert.equal(visible[1].status, status);
    assert.equal(visible[1].description, undefined);
    assert.equal(visible[1].meta, undefined);
    assert.deepEqual(visible[1].availableActions, []);
    assert.equal(visible[1].title.includes("Actual integration state"), true);
  }
  const approval = { ...integration, id: "workflow-isolation:one:round:r1:1", meta: "Awaiting merge approval",
    availableActions: ["open_approval"], approvalId: "approval-one" };
  const visible = workflowConversationTimelineItems([owner, integration, approval], new Set(["one"]));
  assert.deepEqual(visible.map(item => item.id), [owner.id, approval.id]);
  assert.equal(visible[1].title, "Awaiting merge approval");
  assert.equal(visible[1].approvalId, "approval-one");
  assert.deepEqual(visible[1].availableActions, ["open_approval"]);
});
