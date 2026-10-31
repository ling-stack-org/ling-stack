import assert from "node:assert/strict";
import test from "node:test";
import { createRequiredQuestionChannelFixture } from "./support/required-question-channel-e2e-fixture.mjs";

// U03 uses an explicitly accepted fork graph, not the intent selector's serial
// Engineer -> QA graph. Only the Provider transport is scripted; dispatch,
// question ownership, answer delivery, Pi tools and SQLite facts are real.
test("an explicitly parallel QA sibling can finish while Engineer waits for its required answer", { timeout: 45_000 }, async (t) => {
  const fixture = await createRequiredQuestionChannelFixture(t, { parallelWorkflow: true });
  const created = await fixture.postParallelWorkflow();
  assert.equal(created.workflow.metadata.workflowGraph.maxParallelSteps, 2);
  assert.equal(created.workflow.metadata.workflowGraph.termination.success, "all_required_succeeded");
  assert.equal(created.workflowSteps.length, 3);
  const entry = created.workflowSteps.find((step) => step.toParticipantId === "ling_agent");
  const engineer = created.workflowSteps.find((step) => step.toParticipantId === "teammate_builtin_engineer");
  const qa = created.workflowSteps.find((step) => step.toParticipantId === "teammate_builtin_qa");
  assert.ok(entry && engineer && qa);
  for (const sibling of [engineer, qa]) {
    assert.equal(sibling.metadata.maxParallelSiblings, 2);
    assert.deepEqual(sibling.metadata.dependsOnStepIds, [entry.id],
      "the accepted graph must not serialize one required sibling behind the other");
    assert.deepEqual(sibling.metadata.requiredTools, ["read"]);
  }

  const question = await fixture.waitForQuestion();
  assert.equal(question.sourceStep.id, engineer.id);
  assert.equal(question.request.status, "pending");
  assert.equal(question.sourceRun.status, "yielded");
  assert.equal(question.sourceStep.status, "waiting_for_input");
  assert.equal(question.request.source.participantId, engineer.toParticipantId);
  assert.equal(fixture.store.getChannelWorkflowStep(entry.id).status, "succeeded");
  const entryActions = fixture.actionsForRun(fixture.store.getChannelWorkflowStep(entry.id).runId);
  assert.equal(entryActions.length, 1);
  assert.equal(entryActions[0].actionType, "read");
  assert.equal(entryActions[0].status, "succeeded");

  await fixture.waitForCondition(() => {
    const step = fixture.store.getChannelWorkflowStep(qa.id);
    return fixture.transport.barrierReached && step?.status === "running"
      && fixture.actionsForRun(step.runId).some((action) => action.actionType === "read" && action.status === "succeeded");
  }, "QA atomic read evidence while Engineer's required question is still unanswered");
  assert.equal(fixture.store.getUserInputRequest(question.sourceThread.id, question.request.requestId).status, "pending");
  assert.equal(fixture.store.getRun(question.sourceRun.id).status, "yielded");
  assert.equal(fixture.store.getChannelWorkflowStep(engineer.id).status, "waiting_for_input");
  const qaRunId = fixture.store.getChannelWorkflowStep(qa.id).runId;
  const qaActionsBefore = fixture.actionsForRun(qaRunId);
  assert.equal(qaActionsBefore.length, 1);
  assert.equal(qaActionsBefore[0].status, "succeeded");
  fixture.releaseParticipant(qa.toParticipantId);
  await fixture.waitForCondition(() => fixture.store.getChannelWorkflowStep(qa.id)?.status === "succeeded",
    "independent QA completion without answering Engineer");
  assert.equal(fixture.store.getRun(qaRunId).status, "succeeded");
  assert.equal(fixture.store.getUserInputRequest(question.sourceThread.id, question.request.requestId).status, "pending");
  assert.equal(fixture.store.getChannelWorkflowStep(engineer.id).runId, question.sourceRun.id);
  assert.equal(fixture.store.listRuns({ workflowStepId: engineer.id, limit: 100 }).length, 1,
    "an unanswered required question must not create an eager successor");
  assert.notEqual(fixture.store.getChannelWorkflow(created.workflow.id).status, "succeeded");
  assert.equal(fixture.store.listTerminalReports({ sourceKind: "workflow", sourceId: created.workflow.id, limit: 20 }).length, 0,
    "the successful sibling alone is not a completed required workflow");

  const accepted = await fixture.answerQuestion();
  assert.equal(accepted.accepted, true);
  await fixture.waitForCondition(() => {
    const delivery = fixture.store.getUserInputDelivery(question.sourceThread.id, accepted.receipt.deliveryId);
    const workflow = fixture.store.getChannelWorkflow(created.workflow.id);
    const steps = created.workflowSteps.map((seed) => fixture.store.getChannelWorkflowStep(seed.id));
    return delivery?.status === "applied" && workflow.status === "succeeded"
      && steps.every((step) => step.status === "succeeded");
  }, "Engineer answer delivery and all explicitly parallel required steps to finish");
  const binding = fixture.store.getUserInputContinuationBinding(question.sourceThread.id, accepted.receipt.deliveryId);
  const receipt = fixture.store.getUserInputContinuationReceipt(question.sourceThread.id, accepted.receipt.deliveryId);
  assert.ok(binding && receipt);
  assert.equal(receipt.acceptance.runId, binding.runId);
  assert.equal(receipt.acceptance.boundary, "pi-session-ready");
  const successors = fixture.store.listRuns({ workflowStepId: engineer.id, limit: 100 })
    .filter((run) => run.parentRunId === question.sourceRun.id && run.continuationReason === "user_input_answer");
  assert.equal(successors.length, 1);
  assert.equal(binding.runId, successors[0].id);
  assert.equal(fixture.store.getChannelWorkflowStep(engineer.id).runId, successors[0].id);
  // A source-less graph has no parent channel projection to stamp. Its Host
  // context is the frozen step pack plus its own canonical child Turn/segment;
  // a typed channel-source stamp is tested separately by the Q1 scenario.
  assert.equal(created.workflow.metadata.sourceMessageId, undefined);
  const sourcePack = question.sourceRun.requestSnapshot.contextPack;
  assert.ok(sourcePack);
  assert.equal(sourcePack.kind, "workflow_step");
  assert.equal(sourcePack.agentContext, undefined);
  assert.ok(sourcePack.sourceRefs.some((ref) => ref.type === "workflow_step" && ref.id === engineer.id));
  assert.ok(sourcePack.sourceRefs.some((ref) => ref.type === "workflow_step" && ref.id === entry.id));
  assert.equal(sourcePack.sourceRefs.some((ref) => ref.type === "workflow_step" && ref.id === qa.id), false,
    "QA is an independent sibling, not Engineer's input dependency");
  assert.deepEqual(successors[0].requestSnapshot.contextPack, sourcePack,
    "the parallel sibling must not replace any part of Engineer's frozen context pack");
  assert.equal(successors[0].threadId, question.sourceThread.id);
  assert.equal(successors[0].taskId, question.sourceRun.taskId);
  assert.equal(successors[0].workflowStepId, engineer.id);
  assert.equal(successors[0].teammateId, engineer.toParticipantId);
  assert.equal(fixture.store.getLingTurnForRun(successors[0].id).id, question.sourceTurn.id);
  const assignment = fixture.store.getEffectiveTurnContextAssignment(question.sourceTurn.id);
  assert.ok(assignment);
  assert.equal(fixture.store.getContextSegment(assignment.segmentId).threadId, question.sourceThread.id);
  const engineerActions = fixture.actionsForRun(successors[0].id);
  assert.equal(engineerActions.length, 1);
  assert.equal(engineerActions[0].actionType, "read");
  assert.equal(engineerActions[0].status, "succeeded");
  assert.deepEqual(fixture.actionsForRun(qaRunId), qaActionsBefore,
    "Engineer continuation must not execute QA's tool again or rewrite its atomic evidence");
  assert.equal(fixture.store.listRuns({ workflowStepId: qa.id, limit: 100 }).length, 1);
  const questionItems = fixture.store.listConversationItemsForTurn({ turnId: question.sourceTurn.id });
  assert.equal(questionItems.filter((item) => item.kind === "user_input_request").length, 1);
  assert.equal(questionItems.filter((item) => item.kind === "user_input_answer").length, 1);
  const qaTurn = fixture.store.getLingTurnForRun(qaRunId);
  assert.notEqual(qaTurn.threadId, question.sourceThread.id);
  assert.notEqual(qaTurn.id, question.sourceTurn.id);
  const qaItems = fixture.store.listConversationItemsForTurn({ turnId: qaTurn.id });
  assert.equal(qaItems.filter((item) => item.kind === "user_input_request" || item.kind === "user_input_answer").length, 0,
    "Engineer question and answer must not leak into QA's canonical Turn");
});
