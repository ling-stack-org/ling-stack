import assert from "node:assert/strict";
import test from "node:test";
import { createRequiredQuestionChannelFixture } from "./support/required-question-channel-e2e-fixture.mjs";

test("required channel question resumes one participant without completing fan-in before every required participant is terminal", async (t) => {
  const fixture = await createRequiredQuestionChannelFixture(t);
  const created = await fixture.postChannelTurn();
  const sourceItem = fixture.store.getConversationItem((created.userItem ?? created.message).id);
  assert.ok(sourceItem?.turnId);
  assert.equal(created.autoStartedWorkflow.workflowSteps.length, 2);

  const question = await fixture.waitForQuestion();
  assert.equal(question.request.status, "pending");
  assert.equal(question.request.waitMode, "required");
  assert.equal(question.sourceRun.status, "yielded");
  assert.equal(question.sourceStep.status, "waiting_for_input");
  assert.equal(question.request.source.channelId, fixture.channel.id);
  assert.equal(question.request.source.threadId, question.sourceThread.id);
  assert.equal(question.request.source.turnId, question.sourceTurn.id);
  assert.equal(question.request.source.itemId, question.sourceCanonicalItem.id);
  assert.equal(question.request.source.workflowStepId, question.sourceStep.id);
  assert.equal(question.request.source.participantId, "teammate_builtin_engineer");
  assert.equal(question.sourceThread.kind, "workflow_step");
  assert.equal(question.sourceThread.workflowId, created.autoStartedWorkflow.workflow.id);
  assert.equal(question.sourceThread.workflowStepId, question.sourceStep.id);
  assert.equal(question.sourceTurn.threadId, question.sourceThread.id);
  assert.equal(question.sourceTurn.sourceItemId, question.sourceCanonicalItem.id);
  assert.equal(question.sourceTurn.createdByActor, "system");
  assert.notEqual(question.sourceThread.id, sourceItem.threadId);
  assert.notEqual(question.sourceTurn.id, sourceItem.turnId);
  assert.notEqual(question.sourceCanonicalItem.id, sourceItem.id);
  assert.equal(question.sourceCanonicalItem.actorType, "system");
  assert.equal(question.sourceCanonicalItem.actorId, "workflow-dispatch");
  assert.equal(question.sourceCanonicalItem.threadId, question.sourceThread.id);
  assert.equal(question.sourceCanonicalItem.turnId, question.sourceTurn.id);
  assert.ok(question.sourceCanonicalItem.domainRefs
    .some((ref) => ref.type === "conversation_item" && ref.id === sourceItem.id));
  assert.ok(question.sourceCanonicalItem.domainRefs
    .some((ref) => ref.type === "turn" && ref.id === sourceItem.turnId));
  assert.ok(question.sourceCanonicalItem.domainRefs
    .some((ref) => ref.type === "thread" && ref.id === sourceItem.threadId));
  assert.ok(question.sourceCanonicalItem.domainRefs
    .some((ref) => ref.type === "workflow" && ref.id === created.autoStartedWorkflow.workflow.id));
  assert.ok(question.sourceCanonicalItem.domainRefs
    .some((ref) => ref.type === "workflow_step" && ref.id === question.sourceStep.id));
  assert.ok(question.item.domainRefs
    .some((ref) => ref.type === "conversation_item" && ref.id === question.sourceCanonicalItem.id));
  assert.equal(fixture.store.listConversationItemsForTurn({ turnId: sourceItem.turnId })
    .filter((item) => item.kind === "user_input_request").length, 0);

  const qaStepSeed = created.autoStartedWorkflow.workflowSteps
    .find((step) => step.toParticipantId === "teammate_builtin_qa");
  assert.ok(qaStepSeed);
  const accepted = await fixture.answerQuestion();
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.delivery.status, "pending");
  await fixture.waitForCondition(() => fixture.store.getUserInputContinuationBinding(
    question.sourceThread.id, accepted.receipt.deliveryId,
  ), "durable answer successor binding");
  const binding = fixture.store.getUserInputContinuationBinding(question.sourceThread.id, accepted.receipt.deliveryId);
  const admittedSuccessor = fixture.store.getRun(binding.runId);
  const sourceStamp = question.sourceRun.requestSnapshot.contextPack?.agentContext;
  assert.ok(sourceStamp, "the source Run must have a Host-owned workflow context stamp");
  assert.deepEqual(admittedSuccessor.requestSnapshot.contextPack?.agentContext, sourceStamp,
    "answer continuation must preserve the exact consumed Host context stamp");

  const engineerStepSeed = created.autoStartedWorkflow.workflowSteps
    .find((step) => step.toParticipantId === "teammate_builtin_engineer");
  assert.ok(engineerStepSeed);
  await fixture.waitForCondition(
    () => fixture.store.getChannelWorkflowStep(engineerStepSeed.id)?.status === "succeeded",
    "Engineer answer successor to finish",
  );

  // The publicly accepted graph may serialize QA after Engineer. The fan-in
  // contract does not require the selector to create a parallel graph.
  await fixture.waitForCondition(() => {
    const step = fixture.store.getChannelWorkflowStep(qaStepSeed.id);
    const run = step?.runId ? fixture.store.getRun(step.runId) : undefined;
    return fixture.transport.barrierReached && step?.status === "running" && run?.status === "running"
      && fixture.actionsForRun(run.id).some((action) => action.actionType === "read" && action.status === "succeeded");
  }, "QA atomic read evidence before its terminal response");

  const engineerStep = fixture.store.getChannelWorkflowStep(engineerStepSeed.id);
  const engineerRun = fixture.store.getRun(engineerStep.runId);
  const engineerWorkUnit = fixture.store.getWorkUnit(engineerRun.workUnitId);
  const engineerAttempt = fixture.store.getWorkUnitAttempt(engineerWorkUnit.activeAttemptId);
  const engineerActions = fixture.actionsForRun(engineerRun.id);
  assert.equal(engineerRun.parentRunId, question.sourceRun.id);
  assert.equal(engineerRun.continuationReason, "user_input_answer");
  assert.equal(engineerStep.metadata.delegatedOutcome.kind, "completed");
  assert.equal(engineerStep.metadata.delegatedOutcome.lineage.runId, engineerRun.id);
  assert.equal(engineerStep.metadata.delegatedOutcome.lineage.attemptId, engineerAttempt.id);
  assert.equal(engineerActions.length, 1);
  assert.equal(engineerActions[0].actionType, "read");
  assert.equal(engineerActions[0].status, "succeeded");
  assert.equal(engineerActions[0].attemptId, engineerAttempt.id);
  assert.ok(engineerStep.metadata.delegatedOutcome.lineage.sourceRefs
    .some((ref) => ref.type === "execution_action" && ref.id === engineerActions[0].id));
  assert.ok(engineerStep.metadata.delegatedOutcome.evidenceRefs
    .some((ref) => ref.kind === "execution_action" && ref.id === engineerActions[0].id));

  const qaStepBeforeRelease = fixture.store.getChannelWorkflowStep(qaStepSeed.id);
  const qaRunBeforeRelease = fixture.store.getRun(qaStepBeforeRelease.runId);
  const workflowBeforeRelease = fixture.store.getChannelWorkflow(created.autoStartedWorkflow.workflow.id);
  assert.equal(qaStepBeforeRelease.status, "running");
  assert.equal(qaRunBeforeRelease.status, "running");
  assert.notEqual(workflowBeforeRelease.status, "succeeded");
  assert.notEqual(workflowBeforeRelease.metadata.completionGate?.status, "verified");
  assert.deepEqual(fixture.store.listTerminalReports({
    sourceKind: "workflow",
    sourceId: workflowBeforeRelease.id,
    limit: 20,
  }), []);
  assert.notEqual(fixture.store.getLingTurn(sourceItem.turnId).status, "succeeded");

  fixture.releaseParticipant("teammate_builtin_qa");
  await fixture.waitForCondition(() => {
    const workflow = fixture.store.getChannelWorkflow(created.autoStartedWorkflow.workflow.id);
    const turn = fixture.store.getLingTurn(sourceItem.turnId);
    const reports = fixture.store.listTerminalReports({ sourceKind: "workflow", sourceId: workflow.id, limit: 20 });
    return workflow.status === "succeeded" && workflow.metadata.completionGate?.status === "verified"
      && turn.status === "succeeded" && reports.length === 1 && Boolean(reports[0].resultItemId);
  }, "required fan-in, TerminalReport and source Turn to settle exactly once");

  const finalWorkflow = fixture.store.getChannelWorkflow(created.autoStartedWorkflow.workflow.id);
  const finalSteps = created.autoStartedWorkflow.workflowSteps
    .map((step) => fixture.store.getChannelWorkflowStep(step.id));
  const reports = fixture.store.listTerminalReports({ sourceKind: "workflow", sourceId: finalWorkflow.id, limit: 20 });
  assert.deepEqual(finalSteps.map((step) => step.status), ["succeeded", "succeeded"]);
  assert.deepEqual(finalSteps.map((step) => step.metadata.delegatedOutcome.kind), ["completed", "completed"]);
  assert.equal(finalWorkflow.status, "succeeded");
  assert.equal(finalWorkflow.metadata.completionGate.status, "verified");
  assert.equal(reports.length, 1);
  assert.ok(reports[0].resultItemId);
  assert.equal(fixture.store.listConversationItemsForTurn({ turnId: sourceItem.turnId })
    .filter((item) => item.id === reports[0].resultItemId).length, 1);
  assert.equal(fixture.store.listStateTransitionEvents({ entityType: "turn", entityId: sourceItem.turnId })
    .filter((event) => event.toStatus === "succeeded").length, 1);
});
