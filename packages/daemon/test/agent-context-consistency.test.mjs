import { appendChannelItemFixture, getChannelItemViewFixture, listChannelItemViewsFixture, updateChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { createRequiredParticipantManifestV1, workflowGraphFingerprintV1 } from "../../contracts/dist/index.js";
import { reviewWorkflowAgentContextStamp } from "../dist/features/channels/agent-context-consistency.js";
import { reviewWorkflowFanInContext } from "../dist/features/channels/workflow-fanin.js";
import {
  acceptWorkflowHandoffIntent,
  createValidatedWorkflowHandoffIntent,
  resolveWorkflowHandoffExecutionContext,
} from "../dist/features/channels/workflow-handoffs.js";
import {
  buildWorkflowStepContextPack,
} from "../dist/features/channels/context-packs.js";
import {
  createWorkflowStepContextArtifact,
  createWorkflowStepOutputArtifact,
  readWorkflowStepOutputPacketArtifact,
} from "../dist/features/channels/workflow-step-packets.js";
import { prepareWorkflowStepStart } from "../dist/features/channels/workflows.js";
import { finalizeOrchestratedWorkflowStepRun } from "../dist/features/channels/orchestrator.js";
import { materializeWorkflowDelegatedStepRequirements } from "../dist/features/channels/workflow-step-requirement.js";

const now = "2026-08-10T01:00:00.000Z";

test("workflow agents share one projection while private role memory stays owner-scoped", async () => {
  const fixture = await createFixture();
  try {
    const engineer = prepareStep(fixture, fixture.engineerStep.id);
    const designer = prepareStep(fixture, fixture.designerStep.id);

    assert.ok(engineer.runRequest.contextPack.agentContext);
    assert.ok(designer.runRequest.contextPack.agentContext);
    assert.equal(
      engineer.runRequest.contextPack.agentContext.contextProjection.projectionVersion,
      designer.runRequest.contextPack.agentContext.contextProjection.projectionVersion,
    );
    assert.equal(
      engineer.runRequest.contextPack.agentContext.contextProjection.sourceStateFingerprint,
      designer.runRequest.contextPack.agentContext.contextProjection.sourceStateFingerprint,
    );
    assert.equal(engineer.runRequest.contextPack.agentContext.contextProjection.segmentId.length > 0, true);
    assert.equal(engineer.runRequest.contextPack.agentContext.contextProjection.throughItemSequence, fixture.sourceItem.sequence);
    assert.deepEqual(engineer.runRequest.contextPack.agentContext.roleEvidenceRefs, [
      { type: "memory", id: fixture.engineerMemory.id },
    ]);
    assert.deepEqual(designer.runRequest.contextPack.agentContext.roleEvidenceRefs, [
      { type: "memory", id: fixture.designerMemory.id },
    ]);
    assert.doesNotMatch(engineer.task.prompt, /private continuity-agent-memory evidence/u);
    assert.doesNotMatch(designer.task.prompt, /private continuity-agent-memory evidence/u);
    assert.match(engineer.runRequest.task.prompt, /Engineer private continuity-agent-memory evidence/u);
    assert.doesNotMatch(engineer.runRequest.task.prompt, /Designer private continuity-agent-memory evidence/u);
    assert.match(designer.runRequest.task.prompt, /Designer private continuity-agent-memory evidence/u);
    assert.doesNotMatch(designer.runRequest.task.prompt, /Engineer private continuity-agent-memory evidence/u);
    assert.equal(engineer.runRequest.skipMemoryRecall, true);
    assert.deepEqual(engineer.runRequest.preselectedMemoryUse, {
      memoryIds: [fixture.engineerMemory.id],
      recallQuery: `${fixture.workflow.objective}\n${fixture.engineerStep.title}\n${fixture.engineerStep.prompt}`,
      policyVersion: "ling-memory-v1-lexical-v2+memory_use_isolation_v2",
    });
    assert.equal(engineer.runRequest.contextProjection.projectionVersion, engineer.runRequest.contextPack.agentContext.contextProjection.projectionVersion);

    const forgedProjection = {
      ...engineer.runRequest.contextPack.agentContext,
      contextProjection: {
        ...engineer.runRequest.contextPack.agentContext.contextProjection,
        segmentId: "segment_forged_with_reused_version",
      },
    };
    assert.equal(reviewWorkflowAgentContextStamp({
      store: fixture.store,
      dependencyWorkflowStepId: fixture.engineerStep.id,
      consumed: forgedProjection,
    }).review.status, "rejected_stale");

    const unstampedHandoff = createValidatedWorkflowHandoffIntent({
      store: fixture.store,
      intent: {
        channelId: fixture.channel.id,
        workflowId: fixture.workflow.id,
        sourceWorkflowStepId: fixture.designerStep.id,
        sourceMessageId: fixture.sourceItem.id,
        fromParticipantId: "teammate_builtin_designer",
        fromParticipantLabel: "Designer",
        toParticipantId: "teammate_builtin_engineer",
        toParticipantLabel: "Engineer",
        reason: "Attempt an unstamped continuity handoff.",
        requiredInput: "Continuity-backed input.",
        expectedOutput: "Safe result.",
        createdBy: "orchestrator",
      },
      now: "2026-08-10T01:00:30.000Z",
    });
    assert.equal(unstampedHandoff.status, "failed");
    assert.match(unstampedHandoff.validation.blockers.join("\n"), /no source agent context stamp/u);

    const snapshotOnlyOutput = persistWorkflowOutputWithoutContextArtifact({
      ...fixture,
      stepId: fixture.designerStep.id,
      prepared: designer,
      resultSummary: "Snapshot-backed designer result.",
    });
    assert.ok(snapshotOnlyOutput.packet.agentContext);
    assert.equal(
      snapshotOnlyOutput.packet.agentContext.contextProjection.projectionVersion,
      designer.runRequest.contextPack.agentContext.contextProjection.projectionVersion,
    );
    const snapshotBackedHandoff = createValidatedWorkflowHandoffIntent({
      store: fixture.store,
      intent: {
        channelId: fixture.channel.id,
        workflowId: fixture.workflow.id,
        sourceWorkflowStepId: fixture.designerStep.id,
        sourceRunId: snapshotOnlyOutput.run.id,
        sourceMessageId: fixture.sourceItem.id,
        fromParticipantId: "teammate_builtin_designer",
        fromParticipantLabel: "Designer",
        toParticipantId: "teammate_builtin_engineer",
        toParticipantLabel: "Engineer",
        reason: "Recover context from the durable run request.",
        requiredInput: "Snapshot-backed output.",
        expectedOutput: "Safe review.",
        createdBy: "orchestrator",
      },
      now: "2026-08-10T01:00:40.000Z",
    });
    assert.equal(snapshotBackedHandoff.status, "validated");
    assert.ok(snapshotBackedHandoff.agentContext);

    const outputPath = resolve(fixture.store.paths.artifactsDir, snapshotOnlyOutput.outputArtifact.path);
    const corruptPacket = JSON.parse(await readFile(outputPath, "utf8"));
    corruptPacket.agentContext = { schemaVersion: 1 };
    await writeFile(outputPath, `${JSON.stringify(corruptPacket)}\n`, "utf8");
    assert.deepEqual(readWorkflowStepOutputPacketArtifact({
      store: fixture.store,
      artifactId: snapshotOnlyOutput.outputArtifact.id,
    }), snapshotOnlyOutput.packet);
    corruptPacket.agentContext = {
      ...designer.runRequest.contextPack.agentContext,
      roleEvidenceRefs: [{ type: "unknown_ref_type", id: fixture.designerMemory.id }],
    };
    await writeFile(outputPath, `${JSON.stringify(corruptPacket)}\n`, "utf8");
    assert.deepEqual(readWorkflowStepOutputPacketArtifact({
      store: fixture.store,
      artifactId: snapshotOnlyOutput.outputArtifact.id,
    }), snapshotOnlyOutput.packet);

    const oversizedRoleEvidence = buildWorkflowStepContextPack({
      store: fixture.store,
      channel: fixture.channel,
      workflow: fixture.workflow,
      step: fixture.engineerStep,
      prompt: fixture.engineerStep.prompt,
      consumerTeammateId: "teammate_builtin_engineer",
      workflowSteps: [fixture.engineerStep, fixture.designerStep],
      roleEvidence: {
        section: {
          id: "workflow_role_evidence",
          role: "memory",
          priority: "medium",
          title: "workflow_role_evidence",
          text: "private-role-evidence ".repeat(2_000),
          sourceRefIds: [fixture.engineerMemory.id],
          visibility: "prompt",
          quotePolicy: "influence_only",
        },
        sourceRefs: [{ type: "memory", id: fixture.engineerMemory.id }],
        sources: [],
        dropped: [],
      },
    });
    assert.equal(oversizedRoleEvidence.sections.some((section) => section.id === "workflow_role_evidence"), false);
    assert.deepEqual(oversizedRoleEvidence.agentContext.roleEvidenceRefs, []);

    const otherChannel = fixture.store.createChannel({
      name: "Other channel",
      status: "active",
      boundPath: fixture.cwd,
      allowedTools: ["read"],
    }, "2026-08-10T01:00:45.000Z");
    const otherSource = appendChannelItemFixture(fixture.store, {
      channelId: otherChannel.id,
      authorType: "local-user",
      body: "Keep this channel isolated.",
    }, "2026-08-10T01:00:46.000Z");
    const crossChannelHandoff = createValidatedWorkflowHandoffIntent({
      store: fixture.store,
      intent: {
        channelId: otherChannel.id,
        sourceMessageId: otherSource.id,
        fromParticipantId: "teammate_builtin_designer",
        fromParticipantLabel: "Designer",
        toParticipantId: "teammate_builtin_engineer",
        toParticipantLabel: "Engineer",
        reason: "Attempt cross-channel context reuse.",
        requiredInput: "Isolated input.",
        expectedOutput: "Safe result.",
        agentContext: designer.runRequest.contextPack.agentContext,
        createdBy: "orchestrator",
      },
      now: "2026-08-10T01:00:47.000Z",
    });
    assert.equal(crossChannelHandoff.status, "failed");
    assert.match(crossChannelHandoff.validation.blockers.join("\n"), /does not belong to the target channel/u);

    fixture.store.updateMemoryObject(fixture.engineerMemory.id, {
      body: "Engineer private continuity-agent-memory evidence changed at the same timestamp.",
    }, now);
    assert.equal(reviewWorkflowAgentContextStamp({
      store: fixture.store,
      dependencyWorkflowStepId: fixture.engineerStep.id,
      consumed: engineer.runRequest.contextPack.agentContext,
    }).review.status, "rejected_stale");
  } finally {
    fixture.store.close();
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("fan-in rebases metadata-only stamps and rejects private leaks or relevant stale facts", async () => {
  const fixture = await createFixture();
  try {
    const prepared = prepareStep(fixture, fixture.engineerStep.id);
    const currentStamp = prepared.runRequest.contextPack.agentContext;
    assert.ok(currentStamp);
    const metadataOnly = {
      ...currentStamp,
      contextProjection: {
        ...currentStamp.contextProjection,
        projectionVersion: "ctxv2_previous_metadata_only",
      },
    };
    assert.equal(reviewWorkflowAgentContextStamp({
      store: fixture.store,
      dependencyWorkflowStepId: fixture.engineerStep.id,
      consumed: metadataOnly,
    }).review.status, "rebased_metadata");

    const output = persistWorkflowOutput({
      ...fixture,
      stepId: fixture.engineerStep.id,
      prepared,
      resultSummary: "Safe implementation result.",
    });
    const handoff = createValidatedWorkflowHandoffIntent({
      store: fixture.store,
      intent: {
        channelId: fixture.channel.id,
        workflowId: fixture.workflow.id,
        sourceWorkflowStepId: output.step.id,
        sourceRunId: output.run.id,
        sourceMessageId: fixture.sourceItem.id,
        fromParticipantId: "teammate_builtin_engineer",
        fromParticipantLabel: "Engineer",
        toParticipantId: "teammate_builtin_designer",
        toParticipantLabel: "Designer",
        reason: "Review the source-linked result.",
        requiredInput: "Implementation output.",
        expectedOutput: "Review verdict.",
        sourceRefs: [{ type: "workflow_step", id: output.step.id }],
        createdBy: "orchestrator",
      },
      now: "2026-08-10T01:01:40.000Z",
    });
    assert.equal(handoff.agentContext.contextProjection.projectionVersion, currentStamp.contextProjection.projectionVersion);
    assert.equal(handoff.agentContext.sourceItemId, fixture.sourceItem.id);
    assert.equal(handoff.agentContext.consumerTeammateId, "teammate_builtin_designer");
    assert.deepEqual(handoff.agentContext.roleEvidenceRefs, []);
    assert.deepEqual(fixture.store.getWorkflowHandoffIntent(handoff.id).agentContext, handoff.agentContext);
    const acceptedHandoff = acceptWorkflowHandoffIntent({
      store: fixture.store,
      intentId: handoff.id,
      now: "2026-08-10T01:01:45.000Z",
    }).intent;
    assert.equal(acceptedHandoff.status, "accepted");
    assert.ok(acceptedHandoff.channelHandoffId);
    for (const index of [1, 2]) {
      fixture.store.createWorkflowHandoffIntent({
        channelId: fixture.channel.id,
        workflowId: fixture.workflow.id,
        fromParticipantId: "ling_agent",
        fromParticipantLabel: "Ling Agent",
        toParticipantId: "teammate_builtin_designer",
        toParticipantLabel: "Designer",
        reason: `Unrelated newer handoff ${index}.`,
        requiredInput: "Unrelated input.",
        expectedOutput: "Unrelated output.",
        createdBy: "orchestrator",
      }, `2026-08-10T01:01:4${6 + index}.000Z`);
    }
    assert.deepEqual(
      fixture.store.listWorkflowHandoffIntents({ channelHandoffId: acceptedHandoff.channelHandoffId, limit: 2 }).map((intent) => intent.id),
      [acceptedHandoff.id],
    );
    assert.equal(resolveWorkflowHandoffExecutionContext({
      store: fixture.store,
      channelHandoffId: acceptedHandoff.channelHandoffId,
      now: "2026-08-10T01:01:46.000Z",
    }).sourceItemId, fixture.sourceItem.id);
    const leakingHandoff = createValidatedWorkflowHandoffIntent({
      store: fixture.store,
      intent: {
        channelId: fixture.channel.id,
        workflowId: fixture.workflow.id,
        sourceWorkflowStepId: output.step.id,
        sourceRunId: output.run.id,
        sourceMessageId: fixture.sourceItem.id,
        fromParticipantId: "teammate_builtin_engineer",
        fromParticipantLabel: "Engineer",
        toParticipantId: "teammate_builtin_designer",
        toParticipantLabel: "Designer",
        reason: "Attempt to copy private evidence.",
        requiredInput: fixture.engineerMemory.body,
        expectedOutput: "Review verdict.",
        createdBy: "orchestrator",
      },
      now: "2026-08-10T01:01:50.000Z",
    });
    assert.equal(leakingHandoff.status, "failed");
    assert.match(leakingHandoff.validation.blockers.join("\n"), /repeats private role evidence/u);
    const patchedHandoff = createValidatedWorkflowHandoffIntent({
      store: fixture.store,
      intent: {
        channelId: fixture.channel.id,
        workflowId: fixture.workflow.id,
        sourceWorkflowStepId: output.step.id,
        sourceRunId: output.run.id,
        sourceMessageId: fixture.sourceItem.id,
        fromParticipantId: "teammate_builtin_engineer",
        fromParticipantLabel: "Engineer",
        toParticipantId: "teammate_builtin_designer",
        toParticipantLabel: "Designer",
        reason: "Review another source-linked result.",
        requiredInput: "Safe implementation output.",
        expectedOutput: "Review verdict.",
        createdBy: "orchestrator",
      },
      now: "2026-08-10T01:01:55.000Z",
    });
    assert.equal(patchedHandoff.status, "validated");
    fixture.store.updateWorkflowHandoffIntent(patchedHandoff.id, {
      requiredInput: fixture.engineerMemory.body,
    }, "2026-08-10T01:01:56.000Z");
    const patchedHandoffAcceptance = acceptWorkflowHandoffIntent({
      store: fixture.store,
      intentId: patchedHandoff.id,
      now: "2026-08-10T01:01:57.000Z",
    }).intent;
    assert.equal(patchedHandoffAcceptance.status, "failed");
    assert.equal(patchedHandoffAcceptance.channelHandoffId, undefined);
    assert.match(patchedHandoffAcceptance.validation.blockers.join("\n"), /repeats private role evidence/u);
    const fanIn = fixture.store.createChannelWorkflowStep({
      workflowId: fixture.workflow.id,
      position: 3,
      title: "Fan-in",
      prompt: "Combine safe dependency results.",
      toParticipantId: "teammate_builtin_engineer",
      toParticipantLabel: "Engineer",
      metadata: {
        sourceMessageId: fixture.sourceItem.id,
        dependsOnStepIds: [output.step.id],
        dependencyMode: "all_succeeded",
        fanInPolicy: {
          mode: "compare_outputs",
          requireAllBranchesTerminal: true,
          includeFailedBranches: false,
          createSummaryArtifact: true,
          createMemoryCandidates: false,
          memoryCandidateScope: "channel",
          maxInputArtifacts: 8,
        },
      },
    }, now);
    assert.deepEqual(
      reviewWorkflowFanInContext({ store: fixture.store, workflow: fixture.workflow, step: fanIn }).reviews.map((review) => review.status),
      ["accepted_current"],
    );

    fixture.store.updateChannelWorkflowStep(output.step.id, {
      resultSummary: fixture.engineerMemory.body,
    }, "2026-08-10T01:02:00.000Z");
    const leaked = reviewWorkflowFanInContext({ store: fixture.store, workflow: fixture.workflow, step: fanIn });
    assert.equal(leaked.reviews[0].status, "rejected_private_leak");
    assert.match(leaked.blocker, /private role evidence/u);

    fixture.store.updateChannelWorkflowStep(output.step.id, {
      resultSummary: "Safe implementation result.",
    }, "2026-08-10T01:03:00.000Z");
    fixture.store.appendConversationItem({
      channelId: fixture.channel.id,
      threadId: fixture.sourceItem.threadId,
      turnId: fixture.sourceItem.turnId,
      kind: "user_message",
      status: "committed",
      actorType: "local_user",
      visibility: "channel",
      payload: {
        ...fixture.sourceItem.payload,
        body: "Corrected continuity-agent-memory objective.",
      },
      supersedesItemId: fixture.sourceItem.id,
      idempotencyKey: "agent-context-corrected-source",
    }, "2026-08-10T01:04:00.000Z");
    const stale = reviewWorkflowFanInContext({ store: fixture.store, workflow: fixture.workflow, step: fanIn });
    assert.equal(stale.reviews[0].status, "rejected_stale");
    assert.match(stale.blocker, /rejected dependency/u);
    const blockedStart = prepareWorkflowStepStart(
      fixture.store,
      fanIn.id,
      { mode: "create_task" },
      fixture.cwd,
      () => {},
    );
    assert.equal(blockedStart.kind, "blocked");
    assert.equal(fixture.store.getChannelWorkflowStep(fanIn.id).status, "blocked");
    assert.equal(fixture.store.getChannelWorkflowStep(fanIn.id).metadata.fanInContextReviews[0].status, "rejected_stale");

    const staleHandoffAcceptance = acceptWorkflowHandoffIntent({
      store: fixture.store,
      intentId: handoff.id,
      now: "2026-08-10T01:05:00.000Z",
    }).intent;
    assert.equal(staleHandoffAcceptance.status, "failed");
    assert.equal(staleHandoffAcceptance.channelHandoffId, acceptedHandoff.channelHandoffId);
    assert.match(staleHandoffAcceptance.validation.blockers.join("\n"), /context changed before acceptance/u);
    const staleExecution = resolveWorkflowHandoffExecutionContext({
      store: fixture.store,
      channelHandoffId: acceptedHandoff.channelHandoffId,
      now: "2026-08-10T01:05:01.000Z",
    });
    assert.match(staleExecution.blocker, /context changed before acceptance/u);
  } finally {
    fixture.store.close();
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("agent result Items from the consumed source Turn do not invalidate its input context", async () => {
  const fixture = await createFixture();
  try {
    const prepared = prepareStep(fixture, fixture.engineerStep.id);
    const consumed = prepared.runRequest.contextPack.agentContext;
    assert.ok(consumed);

    fixture.store.appendConversationItem({
      channelId: fixture.channel.id,
      threadId: fixture.sourceItem.threadId,
      turnId: fixture.sourceItem.turnId,
      kind: "assistant_message",
      status: "committed",
      actorType: "ling_agent",
      actorId: "ling_agent",
      visibility: "channel",
      payload: {
        body: "The source Turn produced a progress result.",
        format: "markdown",
        streaming: false,
        deliveryStatus: "ready",
      },
    }, "2026-08-10T01:00:30.000Z");

    const review = reviewWorkflowAgentContextStamp({
      store: fixture.store,
      dependencyWorkflowStepId: fixture.engineerStep.id,
      consumed,
    }).review;
    assert.equal(review.status, "accepted_current");
  } finally {
    fixture.store.close();
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("workflow step input excludes pre-existing coordinator Items from its freshness stamp", async () => {
  const fixture = await createFixture();
  try {
    const coordinatorItem = fixture.store.appendConversationItem({
      channelId: fixture.channel.id,
      threadId: fixture.sourceItem.threadId,
      turnId: fixture.sourceItem.turnId,
      kind: "assistant_message",
      status: "committed",
      actorType: "ling_agent",
      actorId: "ling_agent",
      visibility: "channel",
      payload: {
        body: "Confirmed. Starting the workflow now.",
        format: "markdown",
        streaming: false,
        deliveryStatus: "ready",
      },
    }, "2026-08-10T01:00:20.000Z");

    const prepared = prepareStep(fixture, fixture.engineerStep.id);
    const consumed = prepared.runRequest.contextPack.agentContext;
    assert.ok(consumed);
    assert.equal(
      consumed.contextProjection.sourceRefs.some((ref) => ref.type === "conversation_item" && ref.id === coordinatorItem.id),
      false,
    );
    assert.equal(reviewWorkflowAgentContextStamp({
      store: fixture.store,
      dependencyWorkflowStepId: fixture.engineerStep.id,
      consumed,
    }).review.status, "accepted_current");
  } finally {
    fixture.store.close();
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("sequential dependencies reject stale agent context before entering a downstream prompt", async () => {
  const fixture = await createFixture();
  try {
    const prepared = prepareStep(fixture, fixture.engineerStep.id);
    const output = persistWorkflowOutput({
      ...fixture,
      stepId: fixture.engineerStep.id,
      prepared,
      resultSummary: "Safe implementation result.",
    });
    const downstream = fixture.store.createChannelWorkflowStep({
      workflowId: fixture.workflow.id,
      position: 3,
      title: "Sequential review",
      prompt: "Review the implementation result.",
      toParticipantId: "teammate_builtin_designer",
      toParticipantLabel: "Designer",
      metadata: {
        sourceMessageId: fixture.sourceItem.id,
        dependsOnStepIds: [output.step.id],
        dependencyMode: "all_succeeded",
      },
    }, now);

    assert.deepEqual(
      reviewWorkflowFanInContext({
        store: fixture.store,
        workflow: fixture.workflow,
        step: downstream,
      }).reviews.map((review) => review.status),
      ["accepted_current"],
    );

    fixture.store.appendConversationItem({
      channelId: fixture.channel.id,
      threadId: fixture.sourceItem.threadId,
      turnId: fixture.sourceItem.turnId,
      kind: "user_message",
      status: "committed",
      actorType: "local_user",
      visibility: "channel",
      payload: {
        ...fixture.sourceItem.payload,
        body: "Corrected objective before the sequential dependency is consumed.",
      },
      supersedesItemId: fixture.sourceItem.id,
      idempotencyKey: "sequential-dependency-context-correction",
    }, "2026-08-10T01:06:00.000Z");

    const stale = reviewWorkflowFanInContext({
      store: fixture.store,
      workflow: fixture.workflow,
      step: downstream,
    });
    assert.equal(stale.reviews[0].status, "rejected_stale");
    assert.match(stale.blocker, /rejected dependency/u);

    const blockedStart = prepareWorkflowStepStart(
      fixture.store,
      downstream.id,
      { mode: "create_task" },
      fixture.cwd,
      () => {},
    );
    assert.equal(blockedStart.kind, "blocked");
    const blockedStep = fixture.store.getChannelWorkflowStep(downstream.id);
    assert.equal(blockedStep.status, "blocked");
    assert.equal(blockedStep.metadata.fanInContextReviews[0].status, "rejected_stale");
  } finally {
    fixture.store.close();
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("leaf workflow results fail closed when relevant context changes before commit", async () => {
  const fixture = await createFixture();
  try {
    const prepared = prepareStep(fixture, fixture.engineerStep.id);
    const run = fixture.store.createRun({
      id: "run_leaf_stale_context",
      cwd: fixture.cwd,
      taskId: prepared.task.id,
      channelId: fixture.channel.id,
      teammateId: prepared.runRequest.teammateId,
      workflowStepId: fixture.engineerStep.id,
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: prepared.runRequest.task,
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: prepared.runRequest,
      createdAt: "2026-08-10T02:00:00.000Z",
    });
    fixture.store.updateChannelWorkflowStep(fixture.engineerStep.id, {
      taskId: prepared.task.id,
      runId: run.id,
    }, "2026-08-10T02:00:01.000Z");
    assert.equal(fixture.store.transitionRunStatus({
      runId: run.id,
      expectedStatus: "queued",
      event: "runner_started",
      actor: "runner",
      now: "2026-08-10T02:00:02.000Z",
      startedAt: "2026-08-10T02:00:02.000Z",
    }).ok, true);
    assert.equal(fixture.store.transitionRunStatus({
      runId: run.id,
      expectedStatus: "running",
      event: "runner_succeeded",
      actor: "runner",
      now: "2026-08-10T02:00:03.000Z",
      endedAt: "2026-08-10T02:00:03.000Z",
    }).ok, true);
    fixture.store.appendConversationItem({
      channelId: fixture.channel.id,
      threadId: fixture.sourceItem.threadId,
      turnId: fixture.sourceItem.turnId,
      kind: "user_message",
      status: "committed",
      actorType: "local_user",
      visibility: "channel",
      payload: { ...fixture.sourceItem.payload, body: "A corrected objective before the leaf result commits." },
      supersedesItemId: fixture.sourceItem.id,
      idempotencyKey: "leaf-result-context-correction",
    }, "2026-08-10T02:00:04.000Z");

    const finalized = finalizeOrchestratedWorkflowStepRun(
      fixture.store,
      fixture.engineerStep.id,
      prepared.task.id,
      fixture.store.getRun(run.id),
      "2026-08-10T02:00:05.000Z",
    );
    assert.equal(finalized.status, "blocked");
    assert.match(finalized.blocker, /no longer current/u);
    assert.equal(fixture.store.getChannelWorkflow(fixture.workflow.id).status, "blocked");
    assert.equal(finalized.resultSummary, undefined);
    assert.equal(finalized.metadata.resultContextReview.status, "rejected_stale");
    assert.equal(finalized.metadata.delegatedOutcome, undefined);
  } finally {
    fixture.store.close();
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("manifest-backed stale context commits a typed delegated blocker", async () => {
  const fixture = await createFixture();
  try {
    const participantManifest = createRequiredParticipantManifestV1([{
      participantId: "teammate_builtin_engineer",
      role: "engineer",
      requirement: "required",
      expectedOutcome: "execution",
      requiredOperationIds: [],
      requestedBy: "explicit_role",
    }, {
      participantId: "teammate_builtin_designer",
      role: "designer",
      requirement: "optional",
      expectedOutcome: "execution",
      requiredOperationIds: [],
      requestedBy: "selector_policy",
    }]);
    const graph = {
      schemaVersion: 1,
      id: "graph_manifest_context_blocker",
      entryNodeId: "engineer",
      nodes: [
        { id: "engineer", kind: "step", name: "Engineer", prompt: "Work", teammateId: "teammate_builtin_engineer" },
        { id: "designer", kind: "step", name: "Designer", prompt: "Review", teammateId: "teammate_builtin_designer" },
      ],
      edges: [],
    };
    const decision = fixture.store.createChannelIntentDecision({
      channelId: fixture.channel.id,
      sourceItemId: fixture.sourceItem.id,
      contextProjection: projectionFor(fixture.sourceItem, fixture.store.getEffectiveTurnContextAssignment(fixture.sourceItem.turnId)),
      action: "workflow_proposal",
      selectedTeammateIds: ["teammate_builtin_engineer", "teammate_builtin_designer"],
      participantManifest,
      reason: "Manifest context blocker",
      status: "accepted",
      createdBy: "deterministic",
    }, now);
    fixture.store.updateChannelWorkflow(fixture.workflow.id, {
      metadata: {
        ...fixture.workflow.metadata,
        sourceIntentDecisionId: decision.id,
        requiredParticipantManifest: participantManifest,
        workflowGraph: graph,
        workflowGraphFingerprint: workflowGraphFingerprintV1(graph),
      },
    }, now);
    fixture.store.updateChannelWorkflowStep(fixture.designerStep.id, {
      metadata: { ...fixture.designerStep.metadata, graphId: graph.id, graphNodeId: "designer" },
    }, now);
    let step = fixture.store.updateChannelWorkflowStep(fixture.engineerStep.id, {
      metadata: { ...fixture.engineerStep.metadata, graphId: graph.id, graphNodeId: "engineer" },
    }, now);
    [step] = materializeWorkflowDelegatedStepRequirements({
      store: fixture.store,
      workflow: fixture.store.getChannelWorkflow(fixture.workflow.id),
      manifest: participantManifest,
      now,
    });
    const prepared = prepareStep(fixture, step.id);
    const run = fixture.store.createRun({
      id: "run_manifest_stale_context",
      cwd: fixture.cwd,
      taskId: prepared.task.id,
      channelId: fixture.channel.id,
      teammateId: prepared.runRequest.teammateId,
      workflowStepId: step.id,
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: prepared.runRequest.task,
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: prepared.runRequest,
      createdAt: "2026-08-10T03:00:00.000Z",
    });
    fixture.store.updateChannelWorkflowStep(step.id, { taskId: prepared.task.id, runId: run.id }, "2026-08-10T03:00:01.000Z");
    fixture.store.markRunStarted(run.id, "2026-08-10T03:00:02.000Z");
    fixture.store.appendEvent(run.id, "run_created", {
      attemptId: "attempt_manifest_stale_context",
      workUnitId: "work_unit_manifest_stale_context",
    });
    fixture.store.markRunSucceeded(run.id, "2026-08-10T03:00:03.000Z");
    fixture.store.appendConversationItem({
      channelId: fixture.channel.id,
      threadId: fixture.sourceItem.threadId,
      turnId: fixture.sourceItem.turnId,
      kind: "user_message",
      status: "committed",
      actorType: "local_user",
      visibility: "channel",
      payload: { ...fixture.sourceItem.payload, body: "Corrected after manifest-backed work." },
      supersedesItemId: fixture.sourceItem.id,
      idempotencyKey: "manifest-context-correction",
    }, "2026-08-10T03:00:04.000Z");

    const finalized = finalizeOrchestratedWorkflowStepRun(
      fixture.store,
      step.id,
      prepared.task.id,
      fixture.store.getRun(run.id),
      "2026-08-10T03:00:05.000Z",
    );
    assert.equal(finalized.status, "blocked");
    assert.equal(finalized.metadata.delegatedOutcome.kind, "blocked");
    assert.equal(finalized.metadata.delegatedOutcome.code, "agent_context_stale");
    assert.equal(finalized.metadata.resultContextReview.status, "rejected_stale");
    assert.ok(finalized.metadata.delegatedOutcomeBasisFingerprint);
  } finally {
    fixture.store.close();
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

async function createFixture() {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-agent-context-consistency-"));
  const store = createSqliteRunStore(cwd);
  const channel = store.createChannel({
    name: "Agent context consistency",
    status: "active",
    boundPath: cwd,
    allowedTools: ["read"],
  }, now);
  const sourceMessage = appendChannelItemFixture(store, {
    channelId: channel.id,
    authorType: "local-user",
    body: "Use continuity-agent-memory evidence to complete this objective.",
  }, now);
  const sourceItem = store.getConversationItem(sourceMessage.id);
  assert.ok(sourceItem?.turnId);
  const workflow = store.createChannelWorkflow({
    channelId: channel.id,
    title: "Agent consistency workflow",
    objective: "Use continuity-agent-memory evidence without leaking private data.",
    status: "ready",
    createdBy: "local-user",
    metadata: { sourceMessageId: sourceItem.id },
  }, now);
  const engineerStep = createStep(store, workflow.id, sourceItem.id, {
    id: "teammate_builtin_engineer",
    label: "Engineer",
    position: 1,
  });
  const designerStep = createStep(store, workflow.id, sourceItem.id, {
    id: "teammate_builtin_designer",
    label: "Designer",
    position: 2,
  });
  const engineerMemory = createPrivateMemory(store, "teammate_builtin_engineer", "Engineer");
  const designerMemory = createPrivateMemory(store, "teammate_builtin_designer", "Designer");
  return {
    cwd,
    store,
    channel,
    sourceItem,
    workflow,
    engineerStep,
    designerStep,
    engineerMemory,
    designerMemory,
  };
}

function createStep(store, workflowId, sourceMessageId, teammate) {
  return store.createChannelWorkflowStep({
    workflowId,
    position: teammate.position,
    title: `${teammate.label} continuity-agent-memory work`,
    prompt: `Use continuity-agent-memory evidence as ${teammate.label}.`,
    toParticipantId: teammate.id,
    toParticipantLabel: teammate.label,
    metadata: {
      sourceMessageId,
      requiredTools: ["read"],
    },
  }, now);
}

function createPrivateMemory(store, ownerId, label) {
  return store.createMemoryObject({
    scopeType: "teammate",
    ownerId,
    title: `${label} continuity-agent-memory`,
    body: `${label} private continuity-agent-memory evidence must remain influence-only.`,
    tags: ["continuity-agent-memory"],
    sensitivity: "private",
    reviewState: "active",
    enabled: true,
    verifyBeforeUse: false,
    createdBy: "test",
  }, now);
}

function projectionFor(item, assignment) {
  return {
    projectionVersion: `projection:${item.id}:${assignment.revision}`,
    sourceStateFingerprint: `source-state:${item.id}:${assignment.revision}`,
    threadId: item.threadId,
    turnId: item.turnId,
    segmentId: assignment.segmentId,
    throughItemSequence: item.sequence,
    summaryIds: [],
    sourceRefs: [
      { type: "thread", id: item.threadId },
      { type: "turn", id: item.turnId },
      { type: "conversation_item", id: item.id },
    ],
    policyVersion: "test-projector-v1",
    visibilityFingerprint: "channel_shared",
  };
}

function prepareStep(fixture, workflowStepId) {
  const result = prepareWorkflowStepStart(
    fixture.store,
    workflowStepId,
    { mode: "create_task" },
    fixture.cwd,
    () => {},
  );
  assert.equal(result.kind, "ready");
  return result;
}

function persistWorkflowOutput(input) {
  const run = input.store.createRun({
    id: `run_${input.stepId}`,
    cwd: input.cwd,
    taskId: input.prepared.task.id,
    channelId: input.channel.id,
    teammateId: input.prepared.runRequest.teammateId,
    workflowStepId: input.stepId,
    providerName: "test-provider",
    providerModel: "test-model",
    taskSnapshot: input.prepared.runRequest.task,
    providerSnapshot: { provider: "test-provider", model: "test-model" },
    requestSnapshot: input.prepared.runRequest,
    createdAt: "2026-08-10T01:01:00.000Z",
  });
  let step = input.store.getChannelWorkflowStep(input.stepId);
  const contextArtifact = createWorkflowStepContextArtifact({
    store: input.store,
    workflow: input.workflow,
    step,
    run,
    runRequest: input.prepared.runRequest,
    now: "2026-08-10T01:01:00.000Z",
  });
  step = input.store.updateChannelWorkflowStep(input.stepId, {
    runId: run.id,
    status: "succeeded",
    resultSummary: input.resultSummary,
    metadata: { ...step.metadata, contextArtifactId: contextArtifact.id },
  }, "2026-08-10T01:01:10.000Z");
  const outputArtifact = createWorkflowStepOutputArtifact({
    store: input.store,
    workflow: input.workflow,
    step,
    run,
    now: "2026-08-10T01:01:20.000Z",
  });
  step = input.store.updateChannelWorkflowStep(input.stepId, {
    metadata: { ...step.metadata, outputArtifactId: outputArtifact.id },
  }, "2026-08-10T01:01:30.000Z");
  return { run, step, contextArtifact, outputArtifact };
}

function persistWorkflowOutputWithoutContextArtifact(input) {
  const run = input.store.createRun({
    id: `run_snapshot_${input.stepId}`,
    cwd: input.cwd,
    taskId: input.prepared.task.id,
    channelId: input.channel.id,
    teammateId: input.prepared.runRequest.teammateId,
    workflowStepId: input.stepId,
    providerName: "test-provider",
    providerModel: "test-model",
    taskSnapshot: input.prepared.runRequest.task,
    providerSnapshot: { provider: "test-provider", model: "test-model" },
    requestSnapshot: input.prepared.runRequest,
    createdAt: "2026-08-10T01:00:31.000Z",
  });
  let step = input.store.updateChannelWorkflowStep(input.stepId, {
    runId: run.id,
    status: "succeeded",
    resultSummary: input.resultSummary,
  }, "2026-08-10T01:00:32.000Z");
  const outputArtifact = createWorkflowStepOutputArtifact({
    store: input.store,
    workflow: input.workflow,
    step,
    run,
    now: "2026-08-10T01:00:33.000Z",
  });
  step = input.store.updateChannelWorkflowStep(input.stepId, {
    metadata: { ...step.metadata, outputArtifactId: outputArtifact.id },
  }, "2026-08-10T01:00:34.000Z");
  const packet = readWorkflowStepOutputPacketArtifact({ store: input.store, artifactId: outputArtifact.id });
  assert.ok(packet);
  return { run, step, outputArtifact, packet };
}
