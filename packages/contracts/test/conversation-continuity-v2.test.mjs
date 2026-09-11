import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  channelIntentDecisionV2Actions,
  conversationItemKindsV1,
  isChannelIntentDecisionV2,
  createRequiredParticipantManifestV1,
  isRequiredParticipantManifestV1,
  isDelegatedOutcomeV1,
  isDelegatedStepRequirementV1,
  delegatedStepRequirementFingerprintV1,
  isWorkflowCompletionGateV1,
  isWorkflowParticipantProviderBindingV1,
  isWorkflowParticipantProviderBlockerV1,
  isContextSegment,
  isConversationContextProjectionMetadata,
  isConversationContextSnapshot,
  isConversationContextSummary,
  isConversationContinuityGoldenFixtureV1,
  isConversationItemV1,
  isLingThreadContinuityV2,
  isTurnContextAssignment,
  serializeConversationContinuityGoldenFixtureV1,
} from "../dist/index.js";

const now = "2026-08-09T00:00:00.000Z";
const later = "2026-08-09T00:01:00.000Z";
const fixturePath = new URL("../fixtures/channel-conversation-continuity-v2.json", import.meta.url);
const goldenFixture = JSON.parse(await readFile(fixturePath, "utf8"));
const exportedGoldenFixture = (
  await import("@ling-stack/contracts/fixtures/channel-conversation-continuity-v2.json", {
    with: { type: "json" },
  })
).default;

function delegatedLineage(workflowId, workflowStepId, participantId, runId = "run-1", attemptId = "attempt-1", evidenceRefs = []) {
  return {
    workflowId,
    workflowStepId,
    participantId,
    runId,
    attemptId,
    sourceRefs: [
      { type: "workflow", id: workflowId },
      { type: "workflow_step", id: workflowStepId },
      ...(runId ? [{ type: "run", id: runId }] : []),
      ...(attemptId ? [{ type: "attempt", id: attemptId }] : []),
      ...evidenceRefs,
    ],
  };
}

test("Continuity v2 golden fixture is consumable through the public package export", () => {
  assert.deepEqual(exportedGoldenFixture, goldenFixture);
});

test("delegated step requirements are deterministic, immutable, and fail closed", () => {
  const source = {
    schemaVersion: 1,
    workflowId: "workflow-1",
    workflowStepId: "step-1",
    participantId: "teammate_builtin_qa",
    participantManifestFingerprint: "rpmv1_manifest",
    expectedOutcome: "verification",
    requiredOperationIds: ["run-command", "inspect-output"],
    requiredDependencyStepIds: ["step-engineer"],
    acceptedEvidenceKinds: ["execution_action"],
  };
  const requirement = {
    ...source,
    fingerprint: delegatedStepRequirementFingerprintV1(source),
  };
  assert.equal(isDelegatedStepRequirementV1(requirement), true);
  assert.equal(
    delegatedStepRequirementFingerprintV1({
      ...source,
      requiredOperationIds: [...source.requiredOperationIds].reverse(),
    }),
    requirement.fingerprint,
  );
  assert.equal(isDelegatedStepRequirementV1({ ...requirement, participantId: "teammate_builtin_engineer" }), false);
  assert.equal(isDelegatedStepRequirementV1({ ...requirement, acceptedEvidenceKinds: [] }), false);
  assert.equal(isDelegatedStepRequirementV1({ ...requirement, requiredOperationIds: ["run-command", "run-command"] }), false);
});

test("Continuity v2 golden fixture freezes the ten approved scenarios", () => {
  assert.equal(isConversationContinuityGoldenFixtureV1(goldenFixture), true);
  assert.deepEqual(goldenFixture.scenarios.map((scenario) => scenario.id), [
    "article-continuation-remains-reply",
    "explicit-readme-write-executes",
    "local-write-without-target-clarifies",
    "unrelated-request-escapes-clarification",
    "explicit-architecture-decision-switches-segment",
    "explicit-reply-inherits-segment",
    "formal-topic-versus-natural-shift",
    "branch-uses-snapshot-without-copying-items",
    "private-memory-never-enters-public-projection",
    "stale-agent-result-is-rejected",
  ]);

  const expectedActions = goldenFixture.scenarios
    .flatMap((scenario) => scenario.turns)
    .map((turn) => turn.expected.intentAction)
    .filter(Boolean);
  assert.equal(expectedActions.includes("single_reply"), false);
  assert.equal(expectedActions.includes("direct_workflow"), false);
  assert.equal(expectedActions.every((action) => channelIntentDecisionV2Actions.includes(action)), true);
});

test("golden fixture serialization is deterministic and rejects v1 action names", () => {
  const first = serializeConversationContinuityGoldenFixtureV1(goldenFixture);
  const second = serializeConversationContinuityGoldenFixtureV1(JSON.parse(first));
  assert.equal(first, second);
  assert.deepEqual(JSON.parse(first), goldenFixture);

  const legacy = structuredClone(goldenFixture);
  legacy.scenarios[0].turns[1].expected.intentAction = "single_reply";
  assert.equal(isConversationContinuityGoldenFixtureV1(legacy), false);
  assert.throws(
    () => serializeConversationContinuityGoldenFixtureV1(legacy),
    /Invalid Channel Conversation Continuity v2 golden fixture/,
  );
});

test("ConversationItem v1 validates every typed payload kind", () => {
  const payloads = {
    user_input_request: { requestId: "request-1", requestVersion: 1 },
    user_input_answer: { requestId: "request-1", requestVersion: 1, answerId: "answer-1" },
    user_message: {
      body: "需要，开始吧",
      format: "plain_text",
      mentions: [{ id: "teammate-1", label: "Reviewer", kind: "ai_teammate" }],
      attachmentIds: ["attachment-1"],
      linkPreviewIds: ["link-preview-1"],
      fileRefs: [{ path: "README.md", source: "explicit_text", line: 1 }],
      replyToItemId: "item-source",
      quotedItemIds: ["item-quote"],
    },
    assistant_message: {
      body: "继续完成文章正文。",
      format: "markdown",
      streaming: false,
      deliveryStatus: "ready",
      presentationRole: "narration",
    },
    tool_call: {
      toolCallId: "tool-call-1",
      toolName: "read",
      title: "Read README",
      inputSummary: "README.md",
    },
    tool_result: {
      toolCallId: "tool-call-1",
      status: "succeeded",
      outputSummary: "README loaded.",
    },
    approval_request: {
      approvalRequestId: "approval-1",
      title: "Allow local write",
      summary: "Write README.md",
    },
    approval_decision: {
      approvalRequestId: "approval-1",
      decision: "approved",
      reason: "User confirmed.",
    },
    handoff: {
      handoffId: "handoff-1",
      targetTeammateId: "teammate-1",
      summary: "Review the contract.",
    },
    operation_state: {
      operationId: "operation-1",
      state: "running",
      title: "Writing README",
      summary: "One file is being updated.",
    },
    artifact_ref: {
      artifactId: "artifact-1",
      title: "README.md",
      artifactKind: "file",
    },
    terminal_report: {
      reportId: "terminal-report-1",
      generation: 1,
      sourceKind: "turn",
      sourceId: "turn-1",
      evidenceFingerprint: "sha256:evidence-1",
      outcomeStatus: "succeeded",
    },
    system_event: {
      eventType: "turn_completed",
      summary: "The turn completed without a Run.",
    },
  };

  for (const [index, kind] of conversationItemKindsV1.entries()) {
    const item = buildItem(kind, payloads[kind], index + 1);
    assert.equal(isConversationItemV1(item), true, kind);
  }
});

test("ConversationItem v1 rejects mixed payloads, ambiguous privacy and mutable committed rows", () => {
  const item = buildItem("assistant_message", {
    body: "Done.",
    format: "plain_text",
    streaming: false,
    deliveryStatus: "ready",
    presentationRole: "reply_result",
  });
  assert.equal(isConversationItemV1({ ...item, schemaVersion: 2 }), false);
  assert.equal(isConversationItemV1({ ...item, payload: { body: "Done.", format: "plain_text" } }), false);
  assert.equal(isConversationItemV1({ ...item, futureField: true }), false);
  assert.equal(isConversationItemV1({ ...item, visibility: "agent_private" }), false);
  assert.equal(isConversationItemV1({
    ...item,
    visibility: "agent_private",
    visibilityOwnerId: "teammate-1",
  }), true);
  assert.equal(isConversationItemV1({ ...item, visibilityOwnerId: "teammate-1" }), false);
  assert.equal(isConversationItemV1({ ...item, committedAt: undefined }), false);
  assert.equal(isConversationItemV1({ ...item, status: "pending" }), false);
  assert.equal(isConversationItemV1({ ...item, supersedesItemId: item.id }), false);
});

test("ConversationItem v1 preserves attachment-only inputs and assistant delivery states", () => {
  const attachmentOnly = buildItem("user_message", {
    body: "",
    format: "plain_text",
    mentions: [],
    attachmentIds: ["attachment-1"],
    linkPreviewIds: [],
    fileRefs: [],
  });
  assert.equal(isConversationItemV1(attachmentOnly), true);
  assert.equal(isConversationItemV1({
    ...attachmentOnly,
    payload: { ...attachmentOnly.payload, attachmentIds: [] },
  }), false);
  assert.equal(isConversationItemV1({
    ...attachmentOnly,
    payload: { ...attachmentOnly.payload, attachmentIds: ["attachment-1", "attachment-1"] },
  }), false);
  assert.equal(isConversationItemV1({
    ...attachmentOnly,
    payload: {
      ...attachmentOnly.payload,
      mentions: [{ id: "teammate-1", label: "Reviewer", kind: "ai-teammate" }],
    },
  }), false);
  assert.equal(isConversationItemV1({
    ...attachmentOnly,
    payload: {
      ...attachmentOnly.payload,
      attachmentIds: [],
      fileRefs: [{ path: "README.md", line: 0 }],
    },
  }), false);

  const ready = buildItem("assistant_message", {
    body: "Done.",
    format: "plain_text",
    streaming: false,
    deliveryStatus: "ready",
    presentationRole: "reply_result",
  });
  assert.equal(isConversationItemV1({
    ...ready,
    status: "pending",
    committedAt: undefined,
    payload: { ...ready.payload, streaming: true, deliveryStatus: "pending" },
  }), true);
  assert.equal(isConversationItemV1({
    ...ready,
    payload: { ...ready.payload, deliveryStatus: "blocked", errorMessage: "Provider unavailable." },
  }), true);
  assert.equal(isConversationItemV1({
    ...ready,
    status: "failed",
    committedAt: undefined,
    payload: { ...ready.payload, deliveryStatus: "failed", errorMessage: "Stream failed." },
  }), true);
  assert.equal(isConversationItemV1({
    ...ready,
    payload: { ...ready.payload, streaming: true },
  }), false);
});

test("thread continuity requires explicit root, topic and branch lineage", () => {
  assert.equal(isLingThreadContinuityV2({
    surfaceKind: "channel_root",
    relationKind: "root",
  }), true);
  assert.equal(isLingThreadContinuityV2({
    surfaceKind: "topic",
    relationKind: "topic",
    parentThreadId: "thread-root",
    parentTurnId: "turn-anchor",
    anchorItemId: "item-anchor",
  }), true);
  assert.equal(isLingThreadContinuityV2({
    surfaceKind: "branch",
    relationKind: "branch",
    parentThreadId: "thread-root",
    parentTurnId: "turn-fork",
    forkContextSnapshotId: "snapshot-1",
  }), true);
  assert.equal(isLingThreadContinuityV2({
    surfaceKind: "topic",
    relationKind: "topic",
    parentThreadId: "thread-root",
    parentTurnId: "turn-anchor",
  }), false);
  assert.equal(isLingThreadContinuityV2({
    surfaceKind: "channel_root",
    relationKind: "root",
    parentThreadId: "thread-parent",
  }), false);
});

test("segment, assignment, summary, snapshot and projection contracts preserve source linkage", () => {
  const sourceRefs = [{ type: "conversation_item", id: "item-1", label: "User request" }];
  assert.equal(isContextSegment({
    id: "segment-1",
    threadId: "thread-1",
    state: "active",
    label: "Continuity architecture",
    createdFromTurnId: "turn-1",
    lastActiveTurnId: "turn-2",
    revision: 1,
    createdAt: now,
    updatedAt: later,
  }), true);
  assert.equal(isContextSegment({
    id: "segment-old",
    threadId: "thread-1",
    state: "merged",
    createdFromTurnId: "turn-1",
    lastActiveTurnId: "turn-2",
    mergedIntoSegmentId: "segment-1",
    revision: 2,
    createdAt: now,
    updatedAt: later,
  }), true);
  assert.equal(isTurnContextAssignment({
    id: "assignment-1",
    turnId: "turn-2",
    segmentId: "segment-1",
    status: "committed",
    revision: 1,
    decisionSource: "structural",
    confidence: 1,
    antecedentTurnId: "turn-1",
    evidenceRefs: sourceRefs,
    policyVersion: "continuity-v2-s0",
    createdAt: now,
  }), true);
  assert.equal(isConversationContextSummary({
    id: "summary-1",
    threadId: "thread-1",
    segmentId: "segment-1",
    scope: "segment",
    status: "active",
    version: 1,
    coveredFromSequence: 1,
    coveredThroughSequence: 8,
    objective: "Implement continuity v2.",
    decisions: ["Use Thread, Turn and Item."],
    constraints: ["No dual timeline authority."],
    openQuestions: [],
    activeWorkRefs: [{ type: "task", id: "task-s0" }],
    sourceRefs,
    policyVersion: "continuity-v2-s0",
    createdAt: now,
  }), true);
  assert.equal(isConversationContextSnapshot({
    id: "snapshot-1",
    threadId: "thread-branch",
    segmentId: "segment-1",
    projectionVersion: "projection-1",
    throughItemSequence: 8,
    summaryIds: ["summary-1"],
    sourceRefs,
    policyVersion: "continuity-v2-s0",
    createdAt: now,
  }), true);
  assert.equal(isConversationContextProjectionMetadata({
    projectionVersion: "projection-1",
    sourceStateFingerprint: "source-state-1",
    threadId: "thread-1",
    turnId: "turn-2",
    segmentId: "segment-1",
    throughItemSequence: 8,
    summaryIds: ["summary-1"],
    sourceRefs,
    policyVersion: "continuity-v2-s0",
    visibilityFingerprint: "visibility-channel-members-v1",
  }), true);
});

test("ChannelIntentDecision v2 accepts only the clean-break action contract", () => {
  const variants = [
    { action: "no_reply" },
    { action: "reply" },
    { action: "visible_multi_reply", selectedTeammateIds: ["teammate-1", "teammate-2"] },
    {
      action: "clarify",
      clarification: {
        missingFields: ["target"],
        question: "Which local file should receive this content?",
      },
    },
    { action: "workflow_proposal", proposalId: "proposal-1" },
    {
      action: "execute",
      execution: {
        operations: [{
          id: "edit_readme",
          kind: "file_edit",
          targetKind: "file",
          targetRef: { type: "artifact", id: "README.md" },
          required: true,
          dependsOn: [],
        }],
      },
    },
    {
      action: "execute",
      execution: {
        operations: [{
          id: "run_node_exact",
          kind: "run_command",
          targetKind: "command",
          targetRef: { type: "operation", id: "command:node-app", label: "Run Node" },
          commandMatchPolicy: { kind: "exact_command", command: "node app.js" },
          required: true,
          dependsOn: [],
        }],
      },
    },
    {
      action: "execute",
      execution: {
        operations: [{
          id: "run_node_executable",
          kind: "run_command",
          targetKind: "command",
          targetRef: { type: "operation", id: "executable:node", label: "Node" },
          commandMatchPolicy: { kind: "executable", executable: "node" },
          required: true,
          dependsOn: [],
        }],
      },
    },
  ];
  for (const variant of variants) {
    assert.equal(isChannelIntentDecisionV2(buildDecision(variant)), true, variant.action);
  }

  assert.equal(isChannelIntentDecisionV2(buildDecision({ action: "single_reply" })), false);
  assert.equal(isChannelIntentDecisionV2(buildDecision({ action: "direct_workflow" })), false);
  assert.equal(isChannelIntentDecisionV2({ ...buildDecision({ action: "reply" }), schemaVersion: 1 }), false);
  assert.equal(isChannelIntentDecisionV2({ ...buildDecision({ action: "reply" }), createdBy: "model" }), false);
  assert.equal(isChannelIntentDecisionV2({
    ...buildDecision({ action: "reply" }),
    selectedTeammateIds: ["teammate-1"],
    participantManifest: createRequiredParticipantManifestV1([]),
  }), false);
  assert.equal(isChannelIntentDecisionV2({
    ...buildDecision({ action: "reply" }),
    sourceMessageId: "legacy-message-1",
  }), false);
  assert.equal(isChannelIntentDecisionV2(buildDecision({
    action: "clarify",
    clarification: { missingFields: [], question: "What target?" },
  })), false);
  assert.equal(isChannelIntentDecisionV2(buildDecision({ action: "execute" })), false);
  assert.equal(isChannelIntentDecisionV2(buildDecision({
    action: "execute",
    execution: { operations: [] },
  })), false);
  assert.equal(isChannelIntentDecisionV2(buildDecision({
    action: "execute",
    execution: {
      operations: [{
        id: "missing_target_ref",
        kind: "file_create",
        targetKind: "file",
        required: true,
        dependsOn: [],
      }],
    },
  })), false);
  assert.equal(isChannelIntentDecisionV2(buildDecision({
    action: "execute",
    execution: {
      operations: [{
        id: "missing_command_policy",
        kind: "run_command",
        targetKind: "command",
        targetRef: { type: "operation", id: "command:node-app", label: "Run Node" },
        required: true,
        dependsOn: [],
      }],
    },
  })), false);
  assert.equal(isChannelIntentDecisionV2(buildDecision({
    action: "execute",
    execution: {
      operations: [{
        id: "policy_on_file",
        kind: "file_create",
        targetKind: "file",
        targetRef: { type: "operation", id: "file:app", label: "app.js" },
        commandMatchPolicy: { kind: "executable", executable: "node" },
        required: true,
        dependsOn: [],
      }],
    },
  })), false);
  assert.equal(isChannelIntentDecisionV2(buildDecision({
    action: "execute",
    execution: {
      operations: [{
        id: "invalid_executable",
        kind: "run_command",
        targetKind: "command",
        targetRef: { type: "operation", id: "executable:node", label: "Node" },
        commandMatchPolicy: { kind: "executable", executable: "../node" },
        required: true,
        dependsOn: [],
      }],
    },
  })), false);
  assert.equal(isChannelIntentDecisionV2(buildDecision({
    action: "execute",
    execution: {
      operations: [
        { id: "duplicate", kind: "file_create", targetKind: "file", required: true, dependsOn: [] },
        { id: "duplicate", kind: "run_command", targetKind: "command", required: true, dependsOn: [] },
      ],
    },
  })), false);
  assert.equal(isChannelIntentDecisionV2(buildDecision({
    action: "execute",
    execution: {
      operations: [
        { id: "write", kind: "file_create", targetKind: "file", required: true, dependsOn: ["missing"] },
      ],
    },
  })), false);
  assert.equal(isChannelIntentDecisionV2(buildDecision({
    action: "execute",
    execution: {
      operations: [
        { id: "write", kind: "file_create", targetKind: "file", required: true, dependsOn: ["run"] },
        { id: "run", kind: "run_command", targetKind: "command", required: true, dependsOn: ["write"] },
      ],
    },
  })), false);
  assert.equal(isChannelIntentDecisionV2(buildDecision({
    action: "execute",
    execution: { kind: "file_create", targetKind: "file" },
  })), false);
  assert.equal(isChannelIntentDecisionV2(buildDecision({
    action: "reply",
    execution: {
      operations: [{ id: "write", kind: "file_create", targetKind: "file", required: true, dependsOn: [] }],
    },
  })), false);
});

test("required participant manifest has deterministic identity and rejects mutation", () => {
  const participants = [{
    participantId: "teammate_builtin_engineer",
    role: "engineer",
    requirement: "required",
    expectedOutcome: "execution",
    requiredOperationIds: ["create_file"],
    requestedBy: "structured_mention",
  }, {
    participantId: "teammate_builtin_qa",
    role: "qa",
    requirement: "required",
    expectedOutcome: "verification",
    requiredOperationIds: ["run_command"],
    requestedBy: "structured_mention",
  }];
  const manifest = createRequiredParticipantManifestV1(participants);
  assert.equal(isRequiredParticipantManifestV1(manifest), true);
  assert.equal(
    createRequiredParticipantManifestV1([...participants].reverse()).fingerprint,
    manifest.fingerprint,
  );
  assert.equal(isRequiredParticipantManifestV1({ ...manifest, fingerprint: "tampered" }), false);
});

test("delegated outcomes require typed durable evidence", () => {
  assert.equal(isDelegatedOutcomeV1({
    kind: "completed",
    workflowId: "workflow-1",
    workflowStepId: "step-engineer",
    participantId: "teammate_builtin_engineer",
    lineage: delegatedLineage("workflow-1", "step-engineer", "teammate_builtin_engineer", "run-1", "attempt-1", [{ type: "execution_action", id: "action-1" }]),
    evidenceRefs: [{ kind: "execution_action", id: "action-1" }],
  }), true);
  assert.equal(isDelegatedOutcomeV1({
    kind: "completed",
    workflowId: "workflow-1",
    workflowStepId: "step-architect",
    participantId: "teammate_builtin_architect",
    lineage: delegatedLineage("workflow-1", "step-architect", "teammate_builtin_architect", "run-1", "attempt-1", [{ type: "artifact", id: "artifact-1" }]),
    evidenceRefs: [{ kind: "workflow_output_packet", id: "artifact-1" }],
  }), true);
  assert.equal(isDelegatedOutcomeV1({
    kind: "completed",
    workflowId: "workflow-1",
    workflowStepId: "step-engineer",
    participantId: "teammate_builtin_engineer",
    lineage: delegatedLineage("workflow-1", "step-engineer", "teammate_builtin_engineer"),
    evidenceRefs: [{ kind: "execution_action", id: "action-1" }],
  }), false);
  assert.equal(isDelegatedOutcomeV1({
    kind: "completed",
    workflowId: "workflow-1",
    workflowStepId: "step-engineer",
    participantId: "teammate_builtin_engineer",
    lineage: delegatedLineage("workflow-1", "step-engineer", "teammate_builtin_engineer", null, null),
    evidenceRefs: [],
  }), false);
  assert.equal(isDelegatedOutcomeV1({
    kind: "blocked",
    workflowId: "workflow-1",
    workflowStepId: "step-engineer",
    participantId: "teammate_builtin_engineer",
    code: "delegated_outcome_missing",
    reason: "No durable evidence was produced.",
    missingRequirements: ["execution_action"],
    lineage: delegatedLineage("workflow-1", "step-engineer", "teammate_builtin_engineer", null, null),
    evidenceRefs: [],
  }), true);
  assert.equal(isDelegatedOutcomeV1({
    kind: "blocked",
    workflowId: "workflow-1",
    workflowStepId: "step-engineer",
    participantId: "teammate_builtin_engineer",
    code: "delegated_outcome_missing",
    reason: "No durable evidence was produced.",
    missingRequirements: ["execution_action"],
    lineage: delegatedLineage("workflow-1", "step-engineer", "teammate_builtin_engineer", "run-1", null),
    evidenceRefs: [],
  }), false);
  assert.equal(isDelegatedOutcomeV1({
    kind: "completed",
    workflowId: "workflow-1",
    workflowStepId: "step-engineer",
    participantId: "teammate_builtin_engineer",
    evidenceActionIds: ["action-1"],
    outputItemIds: [],
  }), false);
});

test("workflow completion gate requires source graph and basis identities", () => {
  const gate = {
    schemaVersion: 1,
    status: "verified",
    sourceIntentDecisionId: "intent-1",
    participantManifestFingerprint: "rpmv1_test",
    graphFingerprint: "wgfv1_test",
    basisFingerprint: "wcbv1_test",
    participantResults: [{
      participantId: "teammate_builtin_qa",
      workflowStepIds: ["step-1"],
      status: "satisfied",
      evidenceRefs: [{ kind: "execution_action", id: "action-1" }],
    }],
    checkedAt: now,
  };
  assert.equal(isWorkflowCompletionGateV1(gate), true);
  const { basisFingerprint: _basisFingerprint, ...withoutBasis } = gate;
  assert.equal(isWorkflowCompletionGateV1(withoutBasis), false);
});

test("workflow participant provider binding and blocker contracts fail closed", () => {
  const binding = {
    schemaVersion: 1,
    participantId: "teammate_builtin_qa",
    bindingMode: "workspace_default",
    source: "workspace_default",
    providerPresetId: "provider_workspace",
  };
  assert.equal(isWorkflowParticipantProviderBindingV1(binding), true);
  assert.equal(isWorkflowParticipantProviderBindingV1({ ...binding, source: "channel_fallback" }), false);
  assert.equal(isWorkflowParticipantProviderBindingV1({ ...binding, source: "teammate_fixed" }), false);
  assert.equal(isWorkflowParticipantProviderBindingV1({ ...binding, source: "private_request_override" }), false);
  assert.equal(isWorkflowParticipantProviderBindingV1({ ...binding, bindingMode: "fixed" }), false);
  assert.equal(isWorkflowParticipantProviderBindingV1({ ...binding, bindingMode: "fixed", source: "teammate_fixed" }), true);
  assert.equal(isWorkflowParticipantProviderBindingV1({ ...binding, source: "channel_ling_agent_model" }), true);
  assert.equal(isWorkflowParticipantProviderBindingV1({ ...binding, extra: true }), false);

  const blocker = {
    schemaVersion: 1,
    code: "workflow_participant_provider_unavailable",
    reasonCode: "workspace_default_provider_missing",
    participantId: "teammate_builtin_qa",
    bindingMode: "workspace_default",
    source: "workspace_default",
    owner: "workspace",
    repairTarget: "model_workbench",
    message: "QA needs a workspace default model.",
  };
  assert.equal(isWorkflowParticipantProviderBlockerV1(blocker), true);
  assert.equal(isWorkflowParticipantProviderBlockerV1({ ...blocker, repairTarget: "channel_fallback" }), false);
  assert.equal(isWorkflowParticipantProviderBlockerV1({ ...blocker, message: "" }), false);
});

function buildItem(kind, payload, sequence = 1) {
  return {
    schemaVersion: 1,
    id: `item-${sequence}`,
    workspaceId: "workspace-1",
    channelId: "channel-1",
    threadId: "thread-1",
    turnId: "turn-1",
    sequence,
    kind,
    status: "committed",
    actorType: kind === "user_message" ? "local_user" : "system",
    visibility: "channel",
    payload,
    domainRefs: [{ type: "turn", id: "turn-1" }],
    idempotencyKey: `continuity-fixture-${sequence}`,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    committedAt: now,
  };
}

function buildDecision(overrides) {
  const action = overrides.action ?? "reply";
  const selectedTeammateIds = overrides.selectedTeammateIds
    ?? (action === "execute" || action === "workflow_proposal" ? ["teammate-1"] : []);
  const operationIds = overrides.execution?.operations?.filter((operation) => operation.required).map((operation) => operation.id) ?? [];
  const participantManifest = overrides.participantManifest ?? createRequiredParticipantManifestV1(
    selectedTeammateIds.map((participantId, index) => ({
      participantId,
      role: "custom",
      requirement: "required",
      expectedOutcome: action === "reply" || action === "visible_multi_reply" || action === "clarify"
        ? "discussion_reply"
        : "execution",
      requiredOperationIds: index === 0 ? operationIds : [],
      requestedBy: "selector_policy",
    })),
  );
  return {
    schemaVersion: 2,
    id: "decision-1",
    workspaceId: "workspace-1",
    channelId: "channel-1",
    sourceTurnId: "turn-1",
    sourceItemId: "item-1",
    contextSegmentId: "segment-1",
    contextProjectionVersion: "projection-1",
    action: "reply",
    selectedTeammateIds,
    participantManifest,
    resultItemIds: [],
    reason: "Golden contract fixture.",
    status: "accepted",
    createdBy: "deterministic",
    createdAt: now,
    updatedAt: now,
    ...overrides,
    selectedTeammateIds,
    participantManifest,
  };
}
