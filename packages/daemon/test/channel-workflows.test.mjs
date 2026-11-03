import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import {
  RecordingRunner,
  SelectiveFailingRunner,
  DelayedRunner,
  AbortableDelayedRunner,
  ParallelDelayedRunner,
  startDaemonForTest,
  createParallelWorkflowStep,
  customTemplate,
  createChannel,
  createWorkflowTestChannel,
  createStaticChatProvider,
  simulateLegacyChannelWithoutModel,
  getJson,
  getArtifactJson,
  waitForCondition,
  waitForWorkflowStepStatus,
  settleParallelDelayedWorkflow,
  waitForWorkflowTemplateStepStatus,
  approveWorkflowStepGate,
  postJson,
  putJson,
  patchJson,
} from "./support/channel-workspace-fixture.mjs";

test("channel collaboration protocol resolver API patches existing channel fields and reverts to defaults", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-protocol-settings-"));
  const daemon = await startDaemonForTest(undefined, {}, { channels: { autoRoute: false } });
  try {
    await patchJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
      responseLanguage: "zh-CN",
    });
    const channel = await createChannel(daemon.url, cwd);

    const initial = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(initial.protocol.schemaVersion, 1);
    assert.equal(initial.protocol.channelId, channel.id);
    assert.equal(initial.protocol.responseLanguage, "zh-CN");
    assert.equal(initial.sources.responseLanguage.source, "workspace_setting");
    assert.equal(initial.sources.responseLanguage.channelValue, "workspace");
    assert.equal(initial.sources.responseLanguage.workspaceValue, "zh-CN");
    assert.equal(initial.protocol.autoReplyMode, "mentions_only");
    assert.equal(initial.sources.autoReplyMode.source, "default");
    assert.equal(initial.protocol.defaultTeammateId, undefined);
    assert.equal(initial.sources.defaultTeammateId.source, "default");
    assert.equal(initial.storage.mode, "channel_fields_and_protocol_overrides");
    assert.deepEqual(initial.storage.editableFields, ["responseLanguage", "autoReplyMode", "defaultTeammateId", "defaultWorkflowPreference", "visibleMultiReplyMaxParticipants", "privacyRules", "reviewRules"]);
    assert.equal(initial.storage.unsupportedFields.length, 0);

    const patched = await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol?cwd=${encodeURIComponent(cwd)}`, {
      responseLanguage: "en-US",
      autoReplyMode: "default_teammate",
      defaultTeammateId: "teammate_builtin_engineer",
    });
    assert.equal(patched.protocol.responseLanguage, "en-US");
    assert.equal(patched.sources.responseLanguage.source, "channel_setting");
    assert.equal(patched.protocol.autoReplyMode, "default_teammate");
    assert.equal(patched.sources.autoReplyMode.source, "channel_setting");
    assert.equal(patched.protocol.defaultTeammateId, "teammate_builtin_engineer");
    assert.equal(patched.sources.defaultTeammateId.source, "channel_setting");
    const channelAfterPatch = (await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`)).channel;
    assert.equal(channelAfterPatch.responseLanguage, "en-US");
    assert.equal(channelAfterPatch.autoReplyMode, "default_teammate");
    assert.equal(channelAfterPatch.defaultTeammateId, "teammate_builtin_engineer");

    const unsupported = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol?cwd=${encodeURIComponent(cwd)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ privacyRules: ["Do not expose private teammate chat."] }),
    });
    assert.equal(unsupported.status, 400);
    const unsupportedBody = await unsupported.json();
    assert.equal(unsupportedBody.error, "unsupported_protocol_field");
    assert.equal(unsupportedBody.field, "privacyRules");

    const autoRoute = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol?cwd=${encodeURIComponent(cwd)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoReplyMode: "auto_route" }),
    });
    assert.equal(autoRoute.status, 400);
    assert.equal((await autoRoute.json()).error, "auto_route_disabled");

    const missingTeammate = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol?cwd=${encodeURIComponent(cwd)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultTeammateId: "missing_teammate" }),
    });
    assert.equal(missingTeammate.status, 400);
    assert.equal((await missingTeammate.json()).error, "default_teammate_not_found");

    const reverted = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/protocol/revert?cwd=${encodeURIComponent(cwd)}`, {});
    assert.deepEqual(reverted.revertedFields, ["responseLanguage", "autoReplyMode", "defaultTeammateId", "defaultWorkflowPreference", "visibleMultiReplyMaxParticipants", "privacyRules", "reviewRules"]);
    assert.equal(reverted.protocol.responseLanguage, "zh-CN");
    assert.equal(reverted.sources.responseLanguage.source, "workspace_setting");
    assert.equal(reverted.protocol.autoReplyMode, "mentions_only");
    assert.equal(reverted.sources.autoReplyMode.source, "default");
    assert.equal(reverted.protocol.defaultTeammateId, undefined);
    const channelAfterRevert = (await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`)).channel;
    assert.equal(channelAfterRevert.responseLanguage, undefined);
    assert.equal(channelAfterRevert.autoReplyMode, "mentions_only");
    assert.equal(channelAfterRevert.defaultTeammateId, undefined);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel collaboration protocol drafts apply protocol-only overrides with source refs", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-protocol-drafts-"));
  const daemon = await startDaemonForTest();
  try {
    const first = await createChannel(daemon.url, cwd);
    const second = await createChannel(daemon.url, cwd);
    const message = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "Draft a protocol update.",
    });
    const otherMessage = await postJson(`${daemon.url}/channels/${encodeURIComponent(second.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "Wrong channel source.",
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol/drafts?cwd=${encodeURIComponent(cwd)}`, {
      baseVersion: 0,
      proposedPatch: {
        defaultWorkflowPreference: "architect_engineer_qa",
        visibleMultiReplyMaxParticipants: 2,
        privacyRules: ["Do not expose private teammate chat."],
        reviewRules: ["Require QA evidence before Done."],
      },
      reason: "AI suggested a tighter channel protocol.",
      createdBy: "ai-draft",
      sourceRefs: [{ type: "message", id: message.message.id, label: "Source request" }],
    });
    assert.equal(created.draft.status, "draft");
    assert.equal(created.draft.baseVersion, 0);
    assert.equal(created.protocol.defaultWorkflowPreference, "manual");
    assert.equal(created.sources.defaultWorkflowPreference.source, "default");

    let drafts = await getJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol/drafts?cwd=${encodeURIComponent(cwd)}&status=draft`);
    assert.deepEqual(drafts.drafts.map((draft) => draft.id), [created.draft.id]);

    const applied = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol/drafts/${encodeURIComponent(created.draft.id)}/apply?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(applied.draft.status, "applied");
    assert.equal(applied.draft.appliedProtocolVersion, 1);
    assert.equal(applied.protocol.protocolVersion, 1);
    assert.equal(applied.protocol.defaultWorkflowPreference, "architect_engineer_qa");
    assert.equal(applied.sources.defaultWorkflowPreference.source, "protocol_override");
    assert.equal(applied.protocol.visibleMultiReplyMaxParticipants, 2);
    assert.deepEqual(applied.protocol.privacyRules, ["Do not expose private teammate chat."]);
    assert.deepEqual(applied.protocol.reviewRules, ["Require QA evidence before Done."]);

    const stale = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol/drafts?cwd=${encodeURIComponent(cwd)}`, {
      baseVersion: 0,
      proposedPatch: { visibleMultiReplyMaxParticipants: 3 },
      reason: "Stale update.",
    });
    const staleApply = await fetch(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol/drafts/${encodeURIComponent(stale.draft.id)}/apply?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
    });
    assert.equal(staleApply.status, 409);
    const staleBody = await staleApply.json();
    assert.equal(staleBody.error, "draft_base_version_mismatch");
    assert.equal(staleBody.draft.status, "stale");

    const crossRef = await fetch(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol/drafts?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposedPatch: { visibleMultiReplyMaxParticipants: 4 },
        reason: "Cross-channel source should fail.",
        sourceRefs: [{ type: "message", id: otherMessage.message.id }],
      }),
    });
    assert.equal(crossRef.status, 400);
    assert.match((await crossRef.json()).message, /channel/i);

    const reverted = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol/revert?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(reverted.protocol.protocolVersion, undefined);
    assert.equal(reverted.protocol.defaultWorkflowPreference, "manual");
    assert.equal(reverted.sources.defaultWorkflowPreference.source, "default");
    drafts = await getJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol/drafts?cwd=${encodeURIComponent(cwd)}&status=applied`);
    assert.equal(drafts.drafts.some((draft) => draft.id === created.draft.id), true);

    const candidate = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol-candidates?cwd=${encodeURIComponent(cwd)}`, {
      baseVersion: 0,
      proposedPatch: { reviewRules: ["Keep candidate review separate from skill creation."] },
      reason: "Channel canvas candidate.",
      sourceRefs: [{ type: "message", id: message.message.id, label: "Canvas source" }],
    });
    assert.equal(candidate.draft.status, "draft");
    const candidates = await getJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol-candidates?cwd=${encodeURIComponent(cwd)}&status=draft&limit=5`);
    assert.equal(candidates.drafts.some((draft) => draft.id === candidate.draft.id), true);

    const rejected = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol-candidates/${encodeURIComponent(candidate.draft.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "reject",
      reason: "Not needed now.",
    });
    assert.equal(rejected.draft.status, "cancelled");
    assert.equal(rejected.protocol.protocolVersion, undefined);

    const approvedCandidate = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol-candidates?cwd=${encodeURIComponent(cwd)}`, {
      baseVersion: 0,
      proposedPatch: { privacyRules: ["Do not turn every channel protocol into a skill."] },
      reason: "Approved channel canvas candidate.",
      sourceRefs: [{ type: "message", id: message.message.id, label: "Canvas source" }],
    });
    const reviewed = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/protocol-candidates/${encodeURIComponent(approvedCandidate.draft.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "approve",
      reason: "Matches channel canvas policy.",
    });
    assert.equal(reviewed.draft.status, "applied");
    assert.equal(reviewed.protocol.protocolVersion, 1);
    assert.deepEqual(reviewed.protocol.privacyRules, ["Do not turn every channel protocol into a skill."]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel collaboration protocol endpoints persist state and reject cross-channel sources", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-protocol-api-"));
  const daemon = await startDaemonForTest();
  try {
    const first = await createChannel(daemon.url, cwd);
    const second = await createChannel(daemon.url, cwd);
    const message = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "Use manual handoffs for v1.1.",
    });
    const otherMessage = await postJson(`${daemon.url}/channels/${encodeURIComponent(second.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "Other channel.",
    });
    const task = (await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: first.id,
      title: "Implement protocol",
      prompt: "Build channel protocol state.",
    })).task;

    const emptyBrief = await getJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/brief?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(emptyBrief.brief.objective, "");

    const decision = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/decisions?cwd=${encodeURIComponent(cwd)}`, {
      sourceMessageId: message.message.id,
      title: "Manual handoffs",
      decision: "Handoffs do not change task state.",
      createdBy: "local-user",
    });
    const superseded = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/decisions?cwd=${encodeURIComponent(cwd)}`, {
      title: "Manual handoffs update",
      decision: "Supersede by creating a new active decision.",
      supersedesDecisionId: decision.decision.id,
      createdBy: "local-user",
    });
    assert.equal(superseded.decision.status, "active");
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/decisions?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(decisions.decisions.find((item) => item.id === decision.decision.id).status, "superseded");

    const brief = await patchJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/brief?cwd=${encodeURIComponent(cwd)}`, {
      objective: "Ship channel v1.1",
      scope: "Collaboration protocol",
      acceptanceCriteria: ["Brief persists"],
      decisionIds: [superseded.decision.id],
      updatedBy: "local-user",
    });
    assert.deepEqual(brief.brief.acceptanceCriteria, ["Brief persists"]);

    const handoff = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/handoffs?cwd=${encodeURIComponent(cwd)}`, {
      sourceTaskId: task.id,
      fromParticipantId: "tian",
      fromParticipantLabel: "Tian",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      reason: "Need implementation",
      requiredInput: "Plan",
      expectedOutput: "Patch",
      createdBy: "local-user",
    });
    await patchJson(`${daemon.url}/handoffs/${encodeURIComponent(handoff.handoff.id)}?cwd=${encodeURIComponent(cwd)}`, { status: "completed" });
    const listedTask = (await getJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`)).tasks.find((item) => item.id === task.id);
    assert.equal(listedTask.status, "todo");

    const summary = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/context-summaries?cwd=${encodeURIComponent(cwd)}`, {
      targetType: "task",
      targetId: task.id,
      sourceMessageIds: [message.message.id],
      decisionIds: [superseded.decision.id],
      summary: "Build the protocol layer.",
      authorType: "local-user",
    });
    assert.equal(summary.contextSummary.targetId, task.id);

    const crossSummary = await fetch(`${daemon.url}/channels/${encodeURIComponent(first.id)}/context-summaries?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetType: "thread",
        targetId: otherMessage.message.id,
        sourceMessageIds: [otherMessage.message.id],
        summary: "Should fail.",
        authorType: "local-user",
      }),
    });
    assert.equal(crossSummary.status, 400);
    assert.match((await crossSummary.json()).message, /channel/i);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("concurrent decision supersession accepts one successor, reuses exact retries, and rejects conflicts", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-decision-supersession-api-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);
    const source = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/decisions?cwd=${encodeURIComponent(cwd)}`, {
      title: "Original decision",
      decision: "Use protocol A.",
      createdBy: "local-user",
    });
    const url = `${daemon.url}/channels/${encodeURIComponent(channel.id)}/decisions?cwd=${encodeURIComponent(cwd)}`;
    const replacementA = {
      title: "Replacement decision",
      decision: "Use protocol B.",
      rationale: "B is the verified replacement.",
      supersedesDecisionId: source.decision.id,
      createdBy: "local-user",
    };
    const replacementB = {
      ...replacementA,
      decision: "Use conflicting protocol C.",
    };
    const supersede = (body) => fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    for (const unsupportedStatus of ["active", "superseded"]) {
      const unsupportedPatch = await fetch(`${daemon.url}/decisions/${encodeURIComponent(source.decision.id)}?cwd=${encodeURIComponent(cwd)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: unsupportedStatus }),
      });
      assert.equal(unsupportedPatch.status, 400);
      const unsupportedPatchBody = await unsupportedPatch.json();
      assert.equal(unsupportedPatchBody.error, "bad_request");
      assert.match(unsupportedPatchBody.message, /status must be rejected/u);
    }

    const invalidStatus = await supersede({
      ...replacementA,
      status: "rejected",
    });
    assert.equal(invalidStatus.status, 400);
    const invalidStatusBody = await invalidStatus.json();
    assert.equal(invalidStatusBody.error, "bad_request");
    assert.match(invalidStatusBody.message, /status must be active/u);

    const rejectable = await postJson(url, {
      title: "Decision to reject",
      decision: "Do not keep this decision.",
      createdBy: "local-user",
    });
    const activeReject = await fetch(`${daemon.url}/decisions/${encodeURIComponent(rejectable.decision.id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "rejected" }),
    });
    assert.equal(activeReject.status, 200);
    assert.equal((await activeReject.json()).decision.status, "rejected");

    const attempts = await Promise.all([supersede(replacementA), supersede(replacementB)]);
    assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), [201, 409]);
    const createdResponse = attempts.find((attempt) => attempt.status === 201);
    const conflictResponse = attempts.find((attempt) => attempt.status === 409);
    const created = await createdResponse.json();
    const conflict = await conflictResponse.json();
    assert.equal(conflict.error, "decision_supersession_conflict");

    const retry = await supersede(created.decision.decision === replacementA.decision ? replacementA : replacementB);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).decision.id, created.decision.id);

    const staleReject = await fetch(`${daemon.url}/decisions/${encodeURIComponent(source.decision.id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "rejected" }),
    });
    assert.equal(staleReject.status, 409);
    const staleRejectBody = await staleReject.json();
    assert.equal(staleRejectBody.error, "decision_status_conflict");
    assert.equal(staleRejectBody.decisionId, source.decision.id);
    assert.equal(staleRejectBody.expectedStatus, "active");
    assert.equal(staleRejectBody.actualStatus, "superseded");

    const decisions = await getJson(`${url}&limit=10`);
    assert.equal(decisions.decisions.find((decision) => decision.id === source.decision.id).status, "superseded");
    const successors = decisions.decisions.filter((decision) => decision.supersedesDecisionId === source.decision.id);
    assert.equal(successors.length, 1);
    assert.equal(successors[0].status, "active");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel handoff workflows start steps, create tasks, and expose blockers", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflows-api-"));
  const daemon = await startDaemonForTest();
  try {
    const first = await createChannel(daemon.url, cwd);
    const second = await createChannel(daemon.url, cwd);
    const task = (await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: first.id,
      title: "Implement workflow",
      prompt: "Build v1.2.",
    })).task;
    const handoff = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/handoffs?cwd=${encodeURIComponent(cwd)}`, {
      sourceTaskId: task.id,
      fromParticipantId: "tian",
      fromParticipantLabel: "Tian",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      reason: "Need implementation",
      requiredInput: "v1.2 plan",
      expectedOutput: "Patch",
      createdBy: "local-user",
    });

    const workflowFromHandoffUrl = `${daemon.url}/handoffs/${encodeURIComponent(handoff.handoff.id)}/workflow?cwd=${encodeURIComponent(cwd)}`;
    const createFromHandoff = async () => {
      const response = await fetch(workflowFromHandoffUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ createdBy: "local-user" }),
      });
      if (!response.ok) {
        assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
      }
      return { status: response.status, payload: await response.json() };
    };
    const attempts = await Promise.all([createFromHandoff(), createFromHandoff()]);
    assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), [200, 201]);
    const createdWorkflow = attempts.find((attempt) => attempt.status === 201).payload;
    const retriedWorkflow = attempts.find((attempt) => attempt.status === 200).payload;
    assert.equal(createdWorkflow.workflow.status, "draft");
    assert.equal(createdWorkflow.workflowStep.status, "queued");
    assert.equal(retriedWorkflow.workflow.id, createdWorkflow.workflow.id);
    assert.equal(retriedWorkflow.workflowStep.id, createdWorkflow.workflowStep.id);
    const handoffWorkflows = await getJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/workflows?cwd=${encodeURIComponent(cwd)}&limit=10`);
    assert.deepEqual(handoffWorkflows.workflows.map((workflow) => workflow.id), [createdWorkflow.workflow.id]);

    const started = await postJson(`${daemon.url}/workflow-steps/${encodeURIComponent(createdWorkflow.workflowStep.id)}/start?cwd=${encodeURIComponent(cwd)}`, {
      mode: "create_task",
      taskTitle: "Workflow generated task",
    });
    assert.equal(started.status, "started");
    assert.equal(started.mode, "create_task");
    assert.equal(started.workflow.status, "succeeded");
    assert.equal(started.workflowStep.status, "succeeded");
    assert.equal(started.task.title, "Workflow generated task");
    assert.equal(started.task.assigneeTeammateId, "engineer");

    const workflowEvents = await getJson(`${daemon.url}/state-transitions?cwd=${encodeURIComponent(cwd)}&entityType=workflow&entityId=${encodeURIComponent(createdWorkflow.workflow.id)}`);
    assert.ok(workflowEvents.transitions.some((event) => event.toStatus === "succeeded"));
    const stepEvents = await getJson(`${daemon.url}/state-transitions?cwd=${encodeURIComponent(cwd)}&entityType=workflow_step&entityId=${encodeURIComponent(createdWorkflow.workflowStep.id)}`);
    assert.ok(stepEvents.transitions.some((event) => event.toStatus === "succeeded"));

    const secondHandoff = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/handoffs?cwd=${encodeURIComponent(cwd)}`, {
      sourceTaskId: task.id,
      fromParticipantId: "tian",
      fromParticipantLabel: "Tian",
      toParticipantId: "engineer",
      toParticipantLabel: "Engineer",
      reason: "Need run",
      requiredInput: "v1.2 plan",
      expectedOutput: "Run",
      createdBy: "local-user",
    });
    simulateLegacyChannelWithoutModel(cwd, first.id);
    const blockedWorkflow = await postJson(`${daemon.url}/handoffs/${encodeURIComponent(secondHandoff.handoff.id)}/workflow?cwd=${encodeURIComponent(cwd)}`, {
      createdBy: "local-user",
    });
    const blocked = await postJson(`${daemon.url}/workflow-steps/${encodeURIComponent(blockedWorkflow.workflowStep.id)}/start?cwd=${encodeURIComponent(cwd)}`, {
      mode: "create_and_run_task",
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.mode, "create_and_run_task");
    assert.equal(blocked.workflowStep.status, "blocked");
    assert.match(blocked.blocker, /provider preset/i);

    const crossWorkflow = await fetch(`${daemon.url}/channels/${encodeURIComponent(second.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceHandoffId: handoff.handoff.id,
        title: "Cross channel",
        objective: "Should fail.",
        createdBy: "local-user",
      }),
    });
    assert.equal(crossWorkflow.status, 400);
    assert.match((await crossWorkflow.json()).message, /channel/i);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("manual workflow step start rejects a result after source context changes", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-manual-workflow-stale-context-"));
  const runner = new DelayedRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Manual continuity workflow");
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const store = stores.get(cwd);
    assert.ok(store);
    store.updateChannel(channel.id, { defaultProviderPresetId: provider.id }, "2026-08-10T03:00:00.000Z");
    const rootThread = store.resolveOrCreateConversationThread({
      surfaceKind: "channel_root",
      channelId: channel.id,
      title: "Manual continuity workflow",
      objective: "Implement the original continuity objective.",
    }, "2026-08-10T03:00:00.000Z").thread;
    const sourceItem = store.appendConversationUserTurn({
      channelId: channel.id,
      threadId: rootThread.id,
      title: "Implement the original continuity objective.",
      userInstruction: "Implement the original continuity objective.",
      payload: {
        body: "Implement the original continuity objective.",
        format: "plain_text",
        mentions: [],
        attachmentIds: [],
        linkPreviewIds: [],
        fileRefs: [],
      },
      idempotencyKey: "manual-workflow-stale-context-source",
    }, "2026-08-10T03:00:00.000Z").item;
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Manual continuity workflow",
      objective: "Implement the original continuity objective.",
      status: "ready",
      createdBy: "local-user",
      metadata: { sourceMessageId: sourceItem.id },
    }, "2026-08-10T03:00:01.000Z");
    const step = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      title: "Manual continuity step",
      prompt: "Implement the original continuity objective.",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      metadata: {
        sourceMessageId: sourceItem.id,
        providerPresetId: provider.id,
        requiredTools: ["read"],
      },
    }, "2026-08-10T03:00:02.000Z");

    const response = await fetch(`${daemon.url}/workflow-steps/${encodeURIComponent(step.id)}/start?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "create_and_run_task" }),
    });
    assert.equal(response.ok, true);
    await waitForCondition(() => runner.runs.length === 1, "manual workflow runner start");
    store.appendConversationItem({
      channelId: channel.id,
      threadId: sourceItem.threadId,
      turnId: sourceItem.turnId,
      kind: "user_message",
      status: "committed",
      actorType: "local_user",
      visibility: "channel",
      payload: { ...sourceItem.payload, body: "Replace the objective before the manual result commits." },
      supersedesItemId: sourceItem.id,
      idempotencyKey: "manual-workflow-stale-context-correction",
    }, "2026-08-10T03:00:03.000Z");
    runner.resolve("This result consumed the old objective.");
    await response.text();

    const blockedStep = store.getChannelWorkflowStep(step.id);
    assert.equal(blockedStep.status, "blocked");
    assert.ok(blockedStep.taskId);
    assert.equal(blockedStep.resultSummary, undefined);
    assert.equal(blockedStep.metadata.resultContextReview.status, "rejected_stale");
    assert.equal(store.getChannelWorkflow(workflow.id).status, "blocked");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("queued workflow runs keep private role memory out of durable snapshots", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-queued-workflow-memory-isolation-"));
  const runner = new AbortableDelayedRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Queued continuity workflow");
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const store = stores.get(cwd);
    assert.ok(store);
    store.updateChannel(channel.id, { defaultProviderPresetId: provider.id }, "2026-08-10T03:10:00.000Z");

    await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "Hold the channel runtime slot.",
      requestAiReply: true,
      providerPresetId: provider.id,
    });
    await waitForCondition(() => runner.runs.length === 1, "blocking channel reply start");
    const blockingRun = store.listRuns({ limit: 20 }).find((run) => run.status === "running");
    assert.ok(blockingRun);

    const privateMemory = store.createMemoryObject({
      workspaceId: channel.workspaceId,
      scopeType: "teammate",
      ownerId: "ling_agent",
      title: "Queued continuity objective",
      body: "Queued continuity objective private role evidence must stay owner-scoped.",
      tags: ["queued-continuity"],
      sourceRefs: [],
      reviewState: "active",
      enabled: true,
      sensitivity: "private",
      verifyBeforeUse: false,
      createdBy: "test",
    }, "2026-08-10T03:10:01.000Z");
    const rootThread = store.resolveOrCreateConversationThread({
      surfaceKind: "channel_root",
      channelId: channel.id,
      title: "Queued continuity workflow",
      objective: "Queued continuity objective",
    }, "2026-08-10T03:10:02.000Z").thread;
    const sourceItem = store.appendConversationUserTurn({
      channelId: channel.id,
      threadId: rootThread.id,
      title: "Queued continuity objective",
      userInstruction: "Queued continuity objective",
      payload: {
        body: "Queued continuity objective",
        format: "plain_text",
        mentions: [],
        attachmentIds: [],
        linkPreviewIds: [],
        fileRefs: [],
      },
      idempotencyKey: "queued-workflow-memory-source",
    }, "2026-08-10T03:10:02.000Z").item;
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Queued continuity workflow",
      objective: "Queued continuity objective",
      status: "ready",
      createdBy: "local-user",
      metadata: { sourceMessageId: sourceItem.id },
    }, "2026-08-10T03:10:03.000Z");
    const step = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      title: "Queued continuity objective",
      prompt: "Queued continuity objective",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      metadata: {
        sourceMessageId: sourceItem.id,
        providerPresetId: provider.id,
        requiredTools: ["read"],
      },
    }, "2026-08-10T03:10:04.000Z");

    const response = await fetch(`${daemon.url}/workflow-steps/${encodeURIComponent(step.id)}/start?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "create_and_run_task" }),
      signal: AbortSignal.timeout(10_000),
    });
    const queuedResponse = await response.text();
    assert.equal(response.ok, true, queuedResponse);

    const queuedRun = store.listRuns({ status: "queued", limit: 20 })
      .find((run) => run.workflowStepId === step.id);
    assert.ok(queuedRun);
    assert.equal(queuedRun.requestSnapshot.workflowStepId, step.id);
    const queuedStep = store.getChannelWorkflowStep(step.id);
    assert.equal(queuedStep.status, "running");
    assert.equal(queuedStep.runId, queuedRun.id);
    assert.equal(store.getChannelWorkflow(workflow.id).status, "running");
    assert.doesNotMatch(queuedRun.taskSnapshot.prompt, /private role evidence/u);
    assert.doesNotMatch(queuedRun.requestSnapshot.task.prompt, /private role evidence/u);
    assert.equal(queuedRun.requestSnapshot.preselectedMemoryUse, undefined);
    const workUnit = store.getWorkUnit(queuedRun.workUnitId);
    assert.ok(workUnit);
    assert.doesNotMatch(workUnit.request.task.prompt, /private role evidence/u);
    assert.equal(workUnit.request.preselectedMemoryUse, undefined);
    assert.equal(
      store.listUsedMemoryEvents({ runId: queuedRun.id, limit: 20 }).some((event) => event.memoryIds.includes(privateMemory.id)),
      false,
    );

    runner.resolve("The blocking channel reply is complete.");
    await waitForCondition(() => store.getRun(blockingRun.id).status === "succeeded", "blocking channel reply completion");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow handoff intents validate, accept, and stay visible as workflow evidence", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-handoff-intents-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = await createChannel(daemon.url, cwd);
    const store = stores.get(cwd);
    assert.ok(store);
    const now = new Date().toISOString();
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Handoff intent workflow",
      objective: "Validate workflow handoff intent evidence.",
      status: "ready",
      createdBy: "local-user",
    }, now);
    const sourceStep = createParallelWorkflowStep(store, workflow.id, "Source Step", {
      branchGroupId: "source",
    });

    const created = await postJson(`${daemon.url}/workflow-handoff-intents?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      workflowId: workflow.id,
      sourceWorkflowStepId: sourceStep.id,
      fromParticipantId: "teammate_builtin_architect",
      fromParticipantLabel: "Architect",
      toParticipantId: "teammate_builtin_engineer",
      toParticipantLabel: "Engineer",
      reason: "Engineer should implement the validated boundary.",
      requiredInput: "Design boundary",
      expectedOutput: "Patch",
      riskSummary: "No permission is granted by this packet.",
      sourceRefs: [
        { type: "workflow", id: workflow.id, label: workflow.title },
        { type: "workflow_step", id: sourceStep.id, label: sourceStep.title },
      ],
      createdBy: "orchestrator",
    });
    assert.equal(created.handoffIntent.status, "validated");
    assert.equal(created.handoffIntent.validation.targetTeammateExists, true);
    assert.equal(created.handoffIntent.validation.targetTeammateActive, true);

    const bypassResponse = await fetch(
      `${daemon.url}/workflow-handoff-intents/${encodeURIComponent(created.handoffIntent.id)}?cwd=${encodeURIComponent(cwd)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "accepted" }),
      },
    );
    assert.equal(bypassResponse.status, 400);
    assert.match(await bypassResponse.text(), /status is server-owned/u);
    assert.equal(store.getWorkflowHandoffIntent(created.handoffIntent.id).status, "validated");

    const stepAfterIntent = store.getChannelWorkflowStep(sourceStep.id);
    assert.ok(stepAfterIntent.metadata.handoffIntentIds.includes(created.handoffIntent.id));

    const accepted = await postJson(`${daemon.url}/workflow-handoff-intents/${encodeURIComponent(created.handoffIntent.id)}/accept?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(accepted.intent.status, "accepted");
    assert.ok(accepted.intent.channelHandoffId);

    const listed = await getJson(`${daemon.url}/workflow-handoff-intents?cwd=${encodeURIComponent(cwd)}&workflowId=${encodeURIComponent(workflow.id)}`);
    assert.deepEqual(listed.handoffIntents.map((intent) => intent.id), [created.handoffIntent.id]);

    const evidence = await getJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/evidence?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(evidence.handoffIntents.some((intent) => intent.id === created.handoffIntent.id && intent.status === "accepted"), true);
    assert.equal(evidence.handoffs.some((handoff) => handoff.id === accepted.intent.channelHandoffId && handoff.status === "accepted"), true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow collaboration card endpoints derive compact product cards", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workflow-collaboration-card-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = await createChannel(daemon.url, cwd);
    const store = stores.get(cwd);
    assert.ok(store);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Ship collaboration card read model",
      objective: "Expose a compact collaboration card without raw workflow internals.",
      status: "running",
      createdBy: "ling_agent",
    }, "2026-06-13T00:00:00.000Z");
    const designStep = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      position: 1,
      title: "Design API boundary",
      prompt: "Define the daemon API contract.",
      toParticipantId: "teammate_builtin_architect",
      toParticipantLabel: "Architect",
      status: "succeeded",
      metadata: { branchGroupId: "design" },
    }, "2026-06-13T00:01:00.000Z");
    store.updateChannelWorkflowStep(designStep.id, { resultSummary: "Contract boundary is ready." }, "2026-06-13T00:02:00.000Z");
    const implementationStep = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      position: 2,
      title: "Implement endpoint",
      prompt: "Implement the daemon endpoint and client facade.",
      toParticipantId: "teammate_builtin_engineer",
      toParticipantLabel: "Engineer",
      status: "waiting_for_approval",
      metadata: { branchGroupId: "implementation", maxParallelSiblings: 2 },
    }, "2026-06-13T00:03:00.000Z");
    const run = store.createRun({
      id: "run_collaboration_card_waiting",
      cwd,
      taskId: "task_collaboration_card_waiting",
      channelId: channel.id,
      teammateId: "teammate_builtin_engineer",
      workflowStepId: implementationStep.id,
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_collaboration_card_waiting", title: "Implement endpoint" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: "2026-06-13T00:04:00.000Z",
    });
    store.markRunWaitingForApproval(run.id, "2026-06-13T00:05:00.000Z");
    store.updateChannelWorkflowStep(implementationStep.id, { runId: run.id }, "2026-06-13T00:05:00.000Z");
    store.createApprovalRequest({
      runId: run.id,
      taskId: run.taskId,
      channelId: channel.id,
      actionType: "write",
      risk: "medium",
      title: "Approve endpoint edit",
      description: "Allow editing daemon endpoint files.",
      payload: { type: "file_write", path: `${cwd}/packages/daemon/src/features/channels/collaboration-cards.ts`, bytes: 128 },
      expiresAt: "2999-01-01T00:00:00.000Z",
    }, "2026-06-13T00:06:00.000Z");

    const listed = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/collaboration-cards?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.channelId, channel.id);
    assert.equal(listed.cards.length, 1);
    const card = listed.cards[0];
    assert.equal(card.workflowId, workflow.id);
    assert.equal(card.mode, "waiting");
    assert.equal(card.executionMode, "parallel");
    assert.equal(card.currentOwnerLabel, "Engineer");
    assert.equal(card.pendingApprovalCount, 1);
    assert.equal(card.completedStepCount, 1);
    assert.equal(card.totalStepCount, 2);
    assert.equal(card.branches.length, 2);
    assert.equal(card.branches.some((branch) => branch.ownerLabels.includes("Architect")), true);
    assert.equal(card.branches.some((branch) => branch.ownerLabels.includes("Engineer")), true);
    assert.equal(JSON.stringify(card).includes("selector"), false);
    assert.equal(JSON.stringify(card).includes("contextPack"), false);

    const single = await getJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/collaboration-card?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(single.workflowId, workflow.id);
    assert.deepEqual(single.card, card);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("autoplan-lite workflow compiles durable steps and orchestrates them through the runner", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-orchestrator-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Autoplan",
      status: "active",
      boundPath: cwd,
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
      runtimePolicy: {
        maxConcurrentRuns: 1,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      templateId: "autoplan-lite",
      objective: "Build the orchestrator test slice.",
      providerPresetId: provider.id,
      runnerId: "pi",
      createdBy: "local-user",
    });
    assert.equal(compiled.workflow.status, "ready");
    assert.equal(compiled.workflowSteps.length, 8);
    assert.equal(compiled.workflowSteps[0].metadata.templateStepId, "product-discovery");
    assert.equal(compiled.workflowSteps[0].metadata.requestedRunnerId, "pi");
    assert.equal(compiled.workflowSteps[0].metadata.policy.onRunFailed, "block_for_user");
    assert.equal(compiled.workflowSteps[4].metadata.policy.onRunFailed, "fail_workflow");
    assert.equal(compiled.workflowSteps[1].metadata.dependsOnStepIds.length, 1);
    const firstStepMemory = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "teammate",
      ownerId: compiled.workflowSteps[0].toParticipantId,
      title: "Orchestrator test objective",
      body: "Build the orchestrator test slice with source-linked evidence.",
      sensitivity: "private",
    })).memory;

    const firstTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstTick.status, "started");
    assert.equal(firstTick.workflowStep.metadata.templateStepId, "product-discovery");
    const stepsAfterFirstTick = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/steps?cwd=${encodeURIComponent(cwd)}`);
    const firstStepAfterFirstTick = stepsAfterFirstTick.workflowSteps.find((step) => step.id === firstTick.workflowStep.id);
    assert.ok(firstStepAfterFirstTick);
    assert.ok(firstStepAfterFirstTick.metadata.contextArtifactId);
    const firstContext = await getArtifactJson(daemon.url, cwd, firstStepAfterFirstTick.metadata.contextArtifactId);
    assert.equal(firstContext.schemaVersion, 1);
    assert.equal(firstContext.workflowId, compiled.workflow.id);
    assert.equal(firstContext.workflowStepId, firstStepAfterFirstTick.id);
    assert.equal(firstContext.objective, "Build the orchestrator test slice.");
    assert.deepEqual(firstContext.dependencies, []);
    assert.equal(firstContext.providerPresetId, provider.id);
    assert.equal(firstContext.contextPack.kind, "workflow_step");
    assert.equal(firstContext.contextPack.providerPresetId, provider.id);
    assert.equal(firstContext.contextPack.budget.mode, "model_estimated");
    assert.equal(firstContext.contextPack.budget.capabilitySource, "provider_metadata");
    assert.equal(firstContext.contextPack.budget.capabilityConfidence, "estimated");
    assert.equal(firstContext.contextPack.overBudget, false);
    assert.equal(firstContext.contextPack.sections.some((section) => section.id === "workflow_runtime_boundary"), true);
    assert.equal(firstContext.contextPack.sourceRefs.some((ref) => ref.type === "workflow" && ref.id === compiled.workflow.id), true);
    const workflowEvidenceAfterFirstTick = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/evidence?cwd=${encodeURIComponent(cwd)}`);
    const firstStepEvidence = workflowEvidenceAfterFirstTick.steps.find((item) => item.step.id === firstStepAfterFirstTick.id);
    assert.ok(firstStepEvidence);
    assert.equal(firstStepEvidence.contextInspect.availability, "available");
    assert.equal(firstStepEvidence.contextInspect.contextArtifactId, firstStepAfterFirstTick.metadata.contextArtifactId);
    assert.equal(firstStepEvidence.contextInspect.kind, "workflow_step");
    assert.equal(firstStepEvidence.contextInspect.budget.mode, "model_estimated");
    assert.equal(firstStepEvidence.contextInspect.budget.capabilitySource, "provider_metadata");
    assert.equal(firstStepEvidence.contextInspect.budget.capabilityConfidence, "estimated");
    assert.equal(firstStepEvidence.contextInspect.sections.some((section) => section.id === "workflow_runtime_boundary"), true);
    assert.equal(firstStepEvidence.contextInspect.sourceRefs.some((ref) => ref.type === "workflow" && ref.id === compiled.workflow.id), true);
    assert.equal(firstStepEvidence.contextInspect.safety.rawPromptTextIncluded, false);
    assert.doesNotMatch(JSON.stringify(firstStepEvidence.contextInspect), /Workflow step runtime boundary:/);
    assert.ok(firstStepAfterFirstTick.runId);
    const firstRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(firstStepAfterFirstTick.runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(firstRun.workflowStepId, firstStepAfterFirstTick.id);
    assert.equal(firstRun.requestSnapshot.workflowStepId, firstStepAfterFirstTick.id);
    assert.equal(firstRun.requestSnapshot.runnerResolution.requestSource, "workflow_step");
    assert.match(runner.runs[0].appendSystemPrompt?.join("\n") ?? "", /Build the orchestrator test slice with source-linked evidence/u);
    // Public snapshots intentionally omit the private workflow prompt. Keep
    // this assertion resilient to the field being absent rather than reading
    // the private prompt through an undefined public property.
    assert.doesNotMatch(JSON.stringify(firstRun.taskSnapshot), /source-linked evidence/u);
    assert.doesNotMatch(JSON.stringify(firstRun.requestSnapshot), /source-linked evidence/u);
    assert.equal(firstRun.requestSnapshot.preselectedMemoryUse, undefined);
    const firstWorkUnit = await getJson(`${daemon.url}/work-units/${encodeURIComponent(firstRun.workUnitId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.doesNotMatch(JSON.stringify(firstWorkUnit.workUnit.request), /source-linked evidence/u);
    assert.equal(firstWorkUnit.workUnit.request.preselectedMemoryUse, undefined);
    const firstRunMemoryUse = await getJson(`${daemon.url}/memory/used?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(firstRun.id)}`);
    assert.deepEqual(firstRunMemoryUse.events[0].memoryIds, [firstStepMemory.id]);
    assert.match(firstRunMemoryUse.events[0].policyVersion, /memory_use_isolation_v2/u);
    const runsForStep = await getJson(`${daemon.url}/runs?cwd=${encodeURIComponent(cwd)}&workflowStepId=${encodeURIComponent(firstStepAfterFirstTick.id)}`);
    assert.deepEqual(runsForStep.runs.map((run) => run.id), [firstRun.id]);
    const threadsForStep = await getJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&workflowStepId=${encodeURIComponent(firstStepAfterFirstTick.id)}`);
    assert.equal(threadsForStep.threads.length, 1);
    assert.equal(threadsForStep.threads[0].kind, "workflow_step");
    assert.equal(threadsForStep.threads[0].workflowStepId, firstStepAfterFirstTick.id);
    assert.equal(threadsForStep.threads[0].lastRunId, firstRun.id);

    await waitForCondition(() => runner.runs.length === 4, "autoplan-lite planning runner sequence");
    const implementationTick = await approveWorkflowStepGate(daemon.url, cwd, compiled.workflow.id, "implementation");
    assert.equal(implementationTick.status, "started", JSON.stringify(implementationTick));
    assert.equal(implementationTick.workflowStep.metadata.templateStepId, "implementation");

    await waitForCondition(() => runner.runs.length === 6, "autoplan-lite implementation and review sequence");
    const qaTick = await approveWorkflowStepGate(daemon.url, cwd, compiled.workflow.id, "qa");
    assert.equal(qaTick.status, "started");
    assert.equal(qaTick.workflowStep.metadata.templateStepId, "qa");

    await waitForCondition(() => runner.runs.length === 7, "autoplan-lite qa sequence");
    const shipTick = await approveWorkflowStepGate(daemon.url, cwd, compiled.workflow.id, "ship");
    assert.equal(shipTick.status, "started");
    assert.equal(shipTick.workflowStep.metadata.templateStepId, "ship");

    await waitForCondition(() => runner.runs.length === 8, "autoplan-lite runner sequence");
    const finalWorkflow = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(finalWorkflow.workflow.status, "succeeded");
    const finalSteps = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/steps?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(finalSteps.workflowSteps.map((step) => step.status), Array(8).fill("succeeded"));
    const productStep = finalSteps.workflowSteps.find((step) => step.metadata.templateStepId === "product-discovery");
    assert.ok(productStep);
    assert.ok(productStep.metadata.outputArtifactId);
    assert.ok(productStep.metadata.outputArtifactIds.includes(productStep.metadata.outputArtifactId));
    const productOutput = await getArtifactJson(daemon.url, cwd, productStep.metadata.outputArtifactId);
    assert.equal(productOutput.schemaVersion, 1);
    assert.equal(productOutput.workflowStepId, productStep.id);
    assert.equal(productOutput.runId, productStep.runId);
    assert.equal(productOutput.status, "succeeded");
    assert.ok(productOutput.artifactIds.includes(productStep.metadata.contextArtifactId));
    assert.equal(productOutput.runnerAudit.effectiveRunnerId, "pi");
    const designStep = finalSteps.workflowSteps.find((step) => step.metadata.templateStepId === "design-review");
    assert.ok(designStep);
    assert.ok(designStep.metadata.outputArtifactId);
    const implementationStep = finalSteps.workflowSteps.find((step) => step.metadata.templateStepId === "implementation");
    assert.ok(implementationStep);
    assert.ok(implementationStep.metadata.contextArtifactId);
    const implementationContext = await getArtifactJson(daemon.url, cwd, implementationStep.metadata.contextArtifactId);
    assert.equal(implementationContext.workflowStepId, implementationStep.id);
    assert.equal(implementationContext.dependencies.length, 2);
    assert.equal(implementationContext.dependencies.every((dependency) => dependency.outputArtifactId), true);
    assert.equal(implementationContext.priorOutputArtifactIds.length >= 2, true);
    assert.match(runner.runs[0].task.prompt, /Context Pack: workflow_step/);
    assert.match(runner.runs[0].task.prompt, /Provider budget mode: model_estimated/);
    assert.equal(firstRun.requestSnapshot.contextPack.sections.some((section) => section.id === "workflow_dependencies"), true);
    assert.equal(firstRun.requestSnapshot.contextPack.sections.some((section) => section.id === "workflow_approval_gates"), true);
    const implementationRun = runner.runs.find((run) => run.task.title === "Implementation");
    assert.ok(implementationRun);
    assert.match(implementationRun.task.prompt, /Context Pack: workflow_step/);
    assert.match(implementationRun.task.prompt, /Provider budget mode: model_estimated/);
    const implementationRunSnapshot = await getJson(`${daemon.url}/runs/${encodeURIComponent(implementationStep.runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(implementationRunSnapshot.requestSnapshot.contextPack.sections.some((section) => section.id === "workflow_dependency_1"), true);
    assert.equal(implementationRunSnapshot.requestSnapshot.contextPack.sections.some((section) => section.id === "workflow_dependency_2"), true);
    assert.equal(implementationRunSnapshot.requestSnapshot.contextPack.sections.some((section) => section.id === "workflow_approval_gates"), true);
    assert.deepEqual(runner.runs.map((run) => run.task.title), [
      "Product Discovery",
      "Product Review",
      "Design Review",
      "Engineering Review",
      "Implementation",
      "Code Review",
      "QA",
      "Ship",
    ]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow graph compiles into durable steps and emits standardized packets", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-graph-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Graph workflow");
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      workflowGraph: {
        schemaVersion: 1,
        id: "graph_test",
        name: "Graph Test",
        summary: "Graph compile test",
        entryNodeId: "plan",
        nodes: [
          {
            id: "plan",
            kind: "step",
            name: "Plan",
            prompt: "Draft the implementation boundary.",
            teammateTemplateId: "architect",
            skillId: "spec",
            autoStart: true,
          },
          {
            id: "review",
            kind: "step",
            name: "Review",
            prompt: "Review the implementation boundary.",
            teammateTemplateId: "engineer",
            skillId: "review",
            autoStart: true,
          },
        ],
        edges: [
          {
            id: "plan_to_review",
            fromNodeId: "plan",
            toNodeId: "review",
            condition: { kind: "all_succeeded" },
          },
        ],
        termination: {
          success: "all_required_succeeded",
          onFailedRequiredNode: "fail_workflow",
          onApprovalDenied: "block_for_user",
        },
        maxParallelSteps: 1,
      },
      objective: "Ship graph compile test.",
      providerPresetId: provider.id,
      runnerId: "pi",
      createdBy: "local-user",
    });
    assert.equal(compiled.workflow.status, "ready");
    assert.equal(compiled.workflow.metadata.workflowGraphId, "graph_test");
    assert.equal(compiled.workflow.metadata.workflowGraphSchemaVersion, 1);
    assert.equal(compiled.workflow.metadata.termination.onFailedRequiredNode, "fail_workflow");
    assert.equal(compiled.workflowSteps.length, 2);
    assert.deepEqual(compiled.workflowSteps.map((step) => step.metadata.graphNodeId), ["plan", "review"]);
    for (const step of compiled.workflowSteps) {
      assert.equal(step.participantAuthority.kind, "workflow_definition");
      assert.equal(step.participantAuthority.origin, "workflow_graph");
      assert.equal(step.participantAuthority.sourceId, "graph_test");
      assert.equal(step.participantAuthority.participantId, step.toParticipantId);
    }
    assert.equal(compiled.workflowSteps[1].metadata.dependsOnStepIds.length, 1);
    assert.equal(compiled.workflowSteps[1].metadata.dependsOnStepIds[0], compiled.workflowSteps[0].id);

    const firstTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstTick.status, "started");
    await waitForCondition(() => runner.runs.length === 2, "workflow graph runner sequence");

    const finalWorkflow = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(finalWorkflow.workflow.status, "succeeded");
    const finalSteps = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/steps?cwd=${encodeURIComponent(cwd)}`);
    const planStep = finalSteps.workflowSteps.find((step) => step.metadata.graphNodeId === "plan");
    const reviewStep = finalSteps.workflowSteps.find((step) => step.metadata.graphNodeId === "review");
    assert.ok(planStep);
    assert.ok(reviewStep);
    assert.ok(planStep.metadata.contextArtifactId);
    assert.ok(planStep.metadata.outputArtifactId);
    assert.ok(reviewStep.metadata.contextArtifactId);

    const planContext = await getArtifactJson(daemon.url, cwd, planStep.metadata.contextArtifactId);
    assert.equal(planContext.graphId, "graph_test");
    assert.equal(planContext.graphNodeId, "plan");
    assert.equal(planContext.teammateId, planStep.toParticipantId);
    assert.equal(planContext.skillId, "spec");
    assert.equal(planContext.contextPack.kind, "workflow_step");
    assert.equal(planContext.contextPack.sections.some((section) => section.id === "workflow_current_step"), true);
    assert.equal(planContext.sourceRefs.some((ref) => ref.type === "workflow" && ref.id === compiled.workflow.id), true);

    const planOutput = await getArtifactJson(daemon.url, cwd, planStep.metadata.outputArtifactId);
    assert.equal(planOutput.graphId, "graph_test");
    assert.equal(planOutput.graphNodeId, "plan");
    assert.equal(planOutput.teammateId, planStep.toParticipantId);
    assert.equal(planOutput.skillId, "spec");
    assert.ok(Array.isArray(planOutput.blockers));
    assert.ok(Array.isArray(planOutput.changedPaths));
    assert.equal(planOutput.sourceRefs.some((ref) => ref.type === "run" && ref.id === planStep.runId), true);

    const reviewContext = await getArtifactJson(daemon.url, cwd, reviewStep.metadata.contextArtifactId);
    assert.equal(reviewContext.dependencies.length, 1);
    assert.equal(reviewContext.dependencies[0].workflowStepId, planStep.id);
    assert.equal(reviewContext.dependencies[0].outputArtifactId, planStep.metadata.outputArtifactId);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const contextWindowTokens of [1800, 4096]) {
test(`workflow dependency compaction preserves the SDK budget gate at ${contextWindowTokens} tokens`, async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-context-compaction-"));
  const runner = new class extends RecordingRunner {
    providerRequests = 0;

    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      const streamSimple = runtime.streamSimple.bind(runtime);
      runtime.streamSimple = (...args) => {
        this.providerRequests += 1;
        return streamSimple(...args);
      };
    }
  }();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
      contextWindow: contextWindowTokens,
      maxTokens: 512,
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Context compaction workflow",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      allowedTools: ["read"],
      runtimePolicy: {
        maxConcurrentRuns: 1,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const now = new Date().toISOString();
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Dependency compaction",
      objective: "Verify dependency output compaction before the downstream step starts.",
      status: "ready",
      createdBy: "local-user",
    }, now);
    const hugeDependencySummary = `Important dependency summary. ${"research finding detail ".repeat(80)}`;
    const fullInputBudget = contextWindowTokens - 512 - 512;
    // Measured with the production packer: 20 capped dependencies exceed the
    // 4K model's 3072-token packet budget; the compacted summary still fits.
    const dependencyCount = contextWindowTokens === 1800 ? 7 : 20;
    const upstreamSteps = Array.from({ length: dependencyCount }, (_, index) => {
      const step = createParallelWorkflowStep(store, workflow.id, `Research Findings ${index + 1}`, {
        branchGroupId: `research-${index + 1}`,
        providerPresetId: provider.id,
        status: "succeeded",
      });
      store.updateChannelWorkflowStep(
        step.id,
        { resultSummary: hugeDependencySummary },
        now,
      );
      return step;
    });
    const downstream = createParallelWorkflowStep(store, workflow.id, "Implementation From Research", {
      branchGroupId: "implementation",
      providerPresetId: provider.id,
      dependsOnStepIds: upstreamSteps.map((step) => step.id),
      dependencyMode: "all_succeeded",
    });

    const tick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    if (contextWindowTokens === 1800) {
      // The effective input budget is 776 tokens after output and runtime
      // reservations. The complete workflow packet cannot fit, so the
      // orchestrator must block before creating a run or calling the provider.
      assert.equal(tick.status, "blocked");
      assert.equal(runner.runs.length, 0);
      const blockedStep = store.getChannelWorkflowStep(downstream.id);
      assert.equal(blockedStep?.status, "blocked");
      assert.match(blockedStep?.blocker ?? "", /exceeds provider budget/);
      return;
    }
    assert.equal(tick.status, "started");
    assert.equal(tick.workflowStep.id, downstream.id);
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].task.prompt, /Compacted workflow dependency summary/);
    assert.match(runner.runs[0].task.prompt, /Compaction id: workflow_packet_summary_/);
    assert.doesNotMatch(runner.runs[0].task.prompt, /research finding detail research finding detail research finding detail research finding detail research finding detail research finding detail research finding detail research finding detail research finding detail research finding detail/);

    let startedStep;
    try {
      startedStep = await waitForWorkflowStepStatus(daemon.url, cwd, workflow.id, downstream.id,
        contextWindowTokens === 1800 ? "blocked" : "succeeded");
    } catch {
      const step = store.getChannelWorkflowStep(downstream.id);
      const run = step?.runId ? store.getRun(step.runId) : undefined;
      assert.fail(`Compacted workflow did not settle: ${JSON.stringify({ step: step && { status: step.status,
        error: step.errorMessage, runId: step.runId }, run: run && { status: run.status, error: run.errorMessage },
        errors: run ? store.listEvents(run.id).filter(event => event.type === "run_error").map(event => event.data) : [] })}`);
    }
    const run = store.getRun(startedStep.runId);
    if (contextWindowTokens === 1800) {
      assert.equal(run?.status, "failed");
      assert.match(run.errorMessage, /Pi model context exceeds selected model budget/);
      assert.equal(runner.providerRequests, 0, "packet compaction cannot bypass the SDK's complete-input capacity check");
    } else {
      assert.equal(run?.status, "succeeded");
      assert.equal(runner.providerRequests, 1, "the actual SDK must admit the compacted input before the no-network reply");
    }
    assert.ok(startedStep.metadata.contextArtifactId);
    const contextPacket = await getArtifactJson(daemon.url, cwd, startedStep.metadata.contextArtifactId);
    assert.equal(contextPacket.contextPack.kind, "workflow_step");
    assert.equal(contextPacket.contextPack.budget.mode, "model_known");
    assert.equal(contextPacket.contextPack.budget.contextWindowTokens, contextWindowTokens);
    assert.equal(contextPacket.contextPack.budget.reservedOutputTokens, 512);
    assert.equal(contextPacket.contextPack.budget.reservedRuntimeOverheadTokens, 512);
    assert.equal(contextPacket.contextPack.budget.inputBudgetTokens, fullInputBudget);
    assert.equal(contextPacket.contextPack.budget.tokenizer, "openai-compatible");
    assert.equal(contextPacket.contextPack.budget.capabilitySource, "user_override");
    assert.equal(contextPacket.contextPack.budget.capabilityConfidence, "known");
    assert.equal(typeof contextPacket.contextPack.estimatedInputTokens, "number");
    assert.equal(contextPacket.contextPack.overBudget, false);
    assert.equal(contextPacket.contextPack.sections.some((section) => section.id === "workflow_dependency_summary"), true);
    assert.equal(contextPacket.contextPack.sections.some((section) => section.id === "workflow_dependency_1"), false);
    assert.equal(contextPacket.contextPack.sections.every((section) => typeof section.estimatedTokens === "number"), true);
    const protocolSection = contextPacket.contextPack.sections.find((section) => section.id === "channel_collaboration_protocol");
    assert.ok(protocolSection);
    assert.equal(protocolSection.metadata.autoReplyMode, "mentions_only");
    assert.equal(protocolSection.metadata.autoReplyModeSource, "default");
    assert.equal(contextPacket.contextPack.droppedSectionIds.includes("workflow_dependency_summary"), false);
    assert.equal(contextPacket.contextPack.compactionIds.length, 1);
    const compactionArtifactId = contextPacket.contextPack.compactionIds[0];
    assert.equal(contextPacket.contextPack.sourceRefs.some((ref) => ref.type === "artifact" && ref.id === compactionArtifactId), true);

    const compactionPacket = await getArtifactJson(daemon.url, cwd, compactionArtifactId);
    assert.equal(compactionPacket.schemaVersion, 1);
    assert.equal(compactionPacket.kind, "workflow_packet_summary");
    assert.equal(compactionPacket.workflowId, workflow.id);
    assert.equal(compactionPacket.workflowStepId, downstream.id);
    assert.equal(compactionPacket.dependencyOutputRefs.length, upstreamSteps.length);
    assert.deepEqual(compactionPacket.dependencyOutputRefs.map((ref) => ref.workflowStepId), upstreamSteps.map((step) => step.id));
    assert.equal(compactionPacket.droppedSectionIds.some((id) => id.startsWith("workflow_dependency_")), true);
    assert.equal(compactionPacket.sourceRefs.some((ref) => ref.type === "workflow_step" && ref.id === upstreamSteps[0].id), true);
    assert.ok(compactionPacket.summary.includes(`Dependency count: ${upstreamSteps.length}.`));
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
}

test("workflow planning failure follows policy and blocks for user repair", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-planning-failure-"));
  const runner = new SelectiveFailingRunner(["Product Discovery"]);
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Planning failure workflow");
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      templateId: "autoplan-lite",
      objective: "Block failed planning for repair.",
      providerPresetId: provider.id,
      createdBy: "local-user",
    });
    const firstTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstTick.status, "started");
    const failedStep = await waitForWorkflowStepStatus(daemon.url, cwd, compiled.workflow.id, firstTick.workflowStep.id, "blocked");
    assert.equal(failedStep.metadata.policy.onRunFailed, "block_for_user");
    assert.match(failedStep.blocker, /Product Discovery failed/);
    const workflow = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workflow.workflow.status, "blocked");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow implementation failure follows policy and fails the workflow", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-implementation-failure-"));
  const runner = new SelectiveFailingRunner(["Implementation"]);
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Implementation failure workflow");
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      templateId: "autoplan-lite",
      objective: "Fail implementation when policy requires it.",
      providerPresetId: provider.id,
      createdBy: "local-user",
    });
    await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    await waitForCondition(() => runner.runs.length === 4, "planning and review steps before implementation failure");
    const implementationTick = await approveWorkflowStepGate(daemon.url, cwd, compiled.workflow.id, "implementation");
    assert.equal(implementationTick.status, "started", JSON.stringify(implementationTick));
    const failedStep = await waitForWorkflowTemplateStepStatus(daemon.url, cwd, compiled.workflow.id, "implementation", "failed");
    assert.equal(failedStep.metadata.policy.onRunFailed, "fail_workflow");
    assert.match(failedStep.blocker, /Implementation failed/);
    const workflow = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workflow.workflow.status, "failed");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow post-step gate pauses downstream steps until approval", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-post-gate-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Post gate workflow");
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      templateId: "autoplan-lite",
      objective: "Pause after discovery for review.",
      providerPresetId: provider.id,
      createdBy: "local-user",
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const discoveryStep = store.getChannelWorkflowStep(compiled.workflowSteps[0].id);
    assert.ok(discoveryStep);
    store.updateChannelWorkflowStep(
      discoveryStep.id,
      {
        metadata: {
          ...discoveryStep.metadata,
          gates: [{
            stage: "post",
            approvalProfile: { mode: "standard", risk: "medium" },
            title: "Review discovery output",
            reason: "Review Product Discovery output before downstream planning starts.",
            requiredForStatuses: ["succeeded"],
          }],
        },
      },
      new Date().toISOString(),
    );

    const firstTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstTick.status, "started");
    const gatedStep = await waitForWorkflowStepStatus(daemon.url, cwd, compiled.workflow.id, discoveryStep.id, "waiting_for_approval");
    assert.equal(gatedStep.metadata.activeGateStage, "post");
    assert.ok(gatedStep.metadata.postStepApprovalId);
    assert.equal(runner.runs.length, 1);
    const pending = await getJson(`${daemon.url}/approvals?cwd=${encodeURIComponent(cwd)}&status=pending&workflowStepId=${encodeURIComponent(discoveryStep.id)}`);
    assert.equal(pending.approvals.length, 1);
    assert.equal(pending.approvals[0].payload.gateStage, "post");

    const waitingTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(waitingTick.status, "waiting_for_approval");
    assert.equal(runner.runs.length, 1);
    await postJson(`${daemon.url}/approvals/${encodeURIComponent(pending.approvals[0].id)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "Discovery output reviewed.",
    });
    const discoveryAfterApproval = await waitForWorkflowStepStatus(daemon.url, cwd, compiled.workflow.id, discoveryStep.id, "succeeded");
    assert.equal(discoveryAfterApproval.metadata.activeGateStage, undefined);
    assert.ok(discoveryAfterApproval.metadata.outputArtifactId);
    const workflowAfterApproval = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workflowAfterApproval.workflow.status, "running");
    const nextTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(nextTick.status, "started");
    assert.equal(nextTick.workflowStep.metadata.templateStepId, "product-review");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow post-step gate resumes after daemon restart when approval was granted", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-post-gate-restart-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  let daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Post gate restart workflow");
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      templateId: "autoplan-lite",
      objective: "Resume a granted post gate after daemon restart.",
      providerPresetId: provider.id,
      createdBy: "local-user",
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const discoveryStep = store.getChannelWorkflowStep(compiled.workflowSteps[0].id);
    assert.ok(discoveryStep);
    store.updateChannelWorkflowStep(
      discoveryStep.id,
      {
        metadata: {
          ...discoveryStep.metadata,
          gates: [{
            stage: "post",
            approvalProfile: { mode: "standard", risk: "medium" },
            title: "Restart review discovery output",
            reason: "Review Product Discovery output before restart recovery continues.",
            requiredForStatuses: ["succeeded"],
          }],
        },
      },
      new Date().toISOString(),
    );

    const firstTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstTick.status, "started");
    const gatedStep = await waitForWorkflowStepStatus(daemon.url, cwd, compiled.workflow.id, discoveryStep.id, "waiting_for_approval");
    assert.equal(gatedStep.metadata.activeGateStage, "post");
    assert.ok(gatedStep.metadata.postStepApprovalId);
    const pending = await getJson(`${daemon.url}/approvals?cwd=${encodeURIComponent(cwd)}&status=pending&workflowStepId=${encodeURIComponent(discoveryStep.id)}`);
    assert.equal(pending.approvals.length, 1);
    await postJson(`${daemon.url}/approvals/${encodeURIComponent(pending.approvals[0].id)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "Discovery output approved before daemon restart.",
    });

    await daemon.close();
    daemon = await startDaemonForTest(runner);

    const resumedTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(resumedTick.status, "started");
    assert.equal(resumedTick.workflowStep.metadata.templateStepId, "product-review");
    const discoveryAfterRestart = await waitForWorkflowStepStatus(daemon.url, cwd, compiled.workflow.id, discoveryStep.id, "succeeded");
    assert.equal(discoveryAfterRestart.metadata.activeGateStage, undefined);
    assert.ok(discoveryAfterRestart.metadata.outputArtifactId);
    await waitForCondition(() => runner.runs.length >= 2, "post-gate restart downstream runner start");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow run cancellation follows default policy and blocks for user", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-cancellation-policy-"));
  const runner = new DelayedRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Cancellation policy workflow");
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      templateId: "autoplan-lite",
      objective: "Cancel a running workflow step and block for repair.",
      providerPresetId: provider.id,
      createdBy: "local-user",
    });
    const firstTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstTick.status, "started");
    assert.equal(firstTick.workflowStep.metadata.templateStepId, "product-discovery");
    assert.ok(firstTick.runId);
    await waitForCondition(() => runner.runs.length === 1, "workflow runner start before run cancellation");

    const cancelled = await postJson(`${daemon.url}/runs/${encodeURIComponent(firstTick.runId)}/cancel?cwd=${encodeURIComponent(cwd)}`, {
      reason: "Cancellation policy regression.",
    });
    assert.equal(cancelled.cancelled, true);
    const reconciled = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(reconciled.status, "blocked");
    assert.match(reconciled.blocker, /cancelled/i);
    const blockedStep = await waitForWorkflowStepStatus(daemon.url, cwd, compiled.workflow.id, firstTick.workflowStep.id, "blocked");
    assert.equal(blockedStep.metadata.policy.onRunCancelled, "block_for_user");
    const workflow = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workflow.workflow.status, "blocked");
  } finally {
    runner.resolve("late completion after cancellation");
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow approval denial follows onApprovalDenied policy and blocks", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-approval-denial-policy-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Approval denial policy workflow");
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      templateId: "autoplan-lite",
      objective: "Deny a pre-step approval and block for user decision.",
      providerPresetId: provider.id,
      createdBy: "local-user",
    });
    await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    await waitForCondition(() => runner.runs.length === 4, "planning and review steps before approval denial");
    const implementationStep = await waitForWorkflowTemplateStepStatus(daemon.url, cwd, compiled.workflow.id, "implementation", "waiting_for_approval");
    const pending = await getJson(`${daemon.url}/approvals?cwd=${encodeURIComponent(cwd)}&status=pending&workflowStepId=${encodeURIComponent(implementationStep.id)}`);
    assert.equal(pending.approvals.length, 1);

    await postJson(`${daemon.url}/approvals/${encodeURIComponent(pending.approvals[0].id)}/deny?cwd=${encodeURIComponent(cwd)}`, {
      reason: "Implementation plan needs revision.",
    });
    const blockedStep = await waitForWorkflowTemplateStepStatus(daemon.url, cwd, compiled.workflow.id, "implementation", "blocked");
    assert.equal(blockedStep.metadata.policy.onApprovalDenied, "block_for_user");
    const workflow = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workflow.workflow.status, "blocked");
    assert.equal(workflow.workflow.blocker, undefined);
    const deniedTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(deniedTick.status, "blocked");
    assert.equal(deniedTick.workflowStep.id, implementationStep.id);
    assert.match(deniedTick.blocker, /revision/);
    assert.equal(runner.runs.length, 4);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow skipped optional step allows downstream steps to start", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-skip-optional-"));
  const runner = new SelectiveFailingRunner(["Product Review"]);
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Skip optional workflow");
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      templateId: "autoplan-lite",
      objective: "Skip optional product review and continue downstream.",
      providerPresetId: provider.id,
      createdBy: "local-user",
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const productReview = compiled.workflowSteps.find((step) => step.metadata?.templateStepId === "product-review");
    assert.ok(productReview);
    store.updateChannelWorkflowStep(
      productReview.id,
      {
        metadata: {
          ...productReview.metadata,
          policy: {
            ...productReview.metadata.policy,
            onRunFailed: "skip_if_optional",
          },
        },
      },
      new Date().toISOString(),
    );

    const firstTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstTick.status, "started");
    const skippedStep = await waitForWorkflowTemplateStepStatus(daemon.url, cwd, compiled.workflow.id, "product-review", "skipped");
    assert.equal(skippedStep.metadata.policy.onRunFailed, "skip_if_optional");
    const downstreamTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(downstreamTick.status, "started");
    assert.equal(downstreamTick.workflowStep.metadata.templateStepId, "design-review");
    await waitForWorkflowTemplateStepStatus(daemon.url, cwd, compiled.workflow.id, "design-review", "succeeded");
    await waitForWorkflowTemplateStepStatus(daemon.url, cwd, compiled.workflow.id, "engineering-review", "succeeded");
    assert.equal(runner.runs.some((run) => run.task.title === "Design Review"), true);
    assert.equal(runner.runs.some((run) => run.task.title === "Engineering Review"), true);
    const workflow = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workflow.workflow.status, "waiting_for_approval");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow orchestrator starts independent parallel branches within channel budget", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-parallel-"));
  const runner = new ParallelDelayedRunner();
  let cleanupWorkflowId;
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Parallel workflow",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      allowedTools: ["read"],
      runtimePolicy: {
        maxConcurrentRuns: 2,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Parallel branches",
      objective: "Run independent read-only branch steps.",
      status: "ready",
      createdBy: "local-user",
    }, new Date().toISOString());
    const firstStep = createParallelWorkflowStep(store, workflow.id, "Branch A", {
      branchGroupId: "branch-a",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
    });
    const secondStep = createParallelWorkflowStep(store, workflow.id, "Branch B", {
      branchGroupId: "branch-b",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
    });
    const thirdStep = createParallelWorkflowStep(store, workflow.id, "Branch C", {
      branchGroupId: "branch-c",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
    });
    cleanupWorkflowId = workflow.id;

    const tick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(tick.status, "started");
    assert.equal(tick.startedSteps.length, 2);
    assert.equal(tick.schedulingDecision.effectiveMode, "parallel");
    assert.equal(tick.schedulingDecision.parallelLimit, 2);
    assert.deepEqual(tick.schedulingDecision.reasonCodes, ["smart_scheduling", "read_only_parallel_allowed"]);
    assert.deepEqual(tick.startedSteps.map((item) => item.workflowStep.id).sort(), [firstStep.id, secondStep.id].sort());
    assert.deepEqual(tick.schedulingDecision.queuedStepIds, [thirdStep.id]);
    await runner.waitUntilStarted(2);
    const steps = await getJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/steps?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(steps.workflowSteps.map((step) => step.status).sort(), ["queued", "running", "running"]);
  } finally {
    try {
      runner.resolveAll("parallel cleanup");
      if (cleanupWorkflowId) {
        await settleParallelDelayedWorkflow(daemon.url, cwd, cleanupWorkflowId, runner, "parallel cleanup");
      }
    } finally {
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("custom workflow template compiles deterministic steps and dependencies", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-custom-template-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Custom template",
      status: "active",
      boundPath: cwd,
      allowedTools: ["read", "grep", "find", "ls"],
      runtimePolicy: {
        maxConcurrentRuns: 2,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      objective: "Compile a custom deterministic workflow.",
      providerPresetId: "provider_static",
      runnerId: "pi",
      customTemplate: customTemplate({
        id: "custom-safe-template",
        name: "Custom Safe Template",
        maxParallelSteps: 2,
        steps: [
          {
            id: "research",
            name: "Research",
            prompt: "Research the problem.",
            teammateTemplateId: "architect",
            skillId: "plan-eng-review",
            branchGroupId: "planning",
          },
          {
            id: "qa",
            name: "QA",
            prompt: "Verify the result.",
            teammateTemplateId: "designer",
            skillId: "plan-design-review",
            dependsOn: ["research"],
            joinGroupId: "review",
            dependencyMode: "all_succeeded",
          },
        ],
      }),
    });

    assert.equal(compiled.workflow.status, "ready");
    assert.equal(compiled.workflow.title, "Custom Safe Template");
    assert.equal(compiled.workflowSteps.length, 2);
    assert.equal(compiled.workflowSteps[0].metadata.workflowTemplateId, "custom-safe-template");
    assert.equal(compiled.workflowSteps[0].metadata.templateVersion, "custom:1");
    assert.equal(compiled.workflowSteps[0].metadata.autoStart, false);
    assert.equal(compiled.workflowSteps[0].metadata.maxParallelSiblings, 2);
    assert.equal(compiled.workflowSteps[0].toParticipantId, "teammate_builtin_architect");
    assert.equal(compiled.workflowSteps[1].metadata.dependsOnStepIds[0], compiled.workflowSteps[0].id);
    assert.equal(compiled.workflowSteps[1].metadata.joinGroupId, "review");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow councilSlotKey resolves through attached AI council specialists", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-council-slot-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Council slot workflow");
    const developmentCouncilId = "council_builtin_development";
    await putJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/council-policy?cwd=${encodeURIComponent(cwd)}`, {
      attachedCouncilIds: [developmentCouncilId],
      preferredCouncilId: developmentCouncilId,
    });

    const customCompiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      objective: "Compile a council-backed custom template.",
      customTemplate: customTemplate({
        id: "council-slot-template",
        name: "Council Slot Template",
        steps: [
          {
            id: "implementation",
            name: "Implementation",
            prompt: "Implement the slice.",
            councilSlotKey: "engineer",
            skillId: "implement",
          },
        ],
      }),
    });

    const customStep = customCompiled.workflowSteps[0];
    assert.equal(customStep.toParticipantId, "teammate_builtin_engineer");
    assert.equal(customStep.metadata.councilSlotKey, "engineer");
    assert.equal(customStep.metadata.proposalStepSources[0].kind, "council");
    assert.equal(customStep.metadata.proposalStepSources[0].councilId, developmentCouncilId);
    assert.equal(customStep.metadata.proposalStepSources[0].slotKey, "engineer");

    const graphCompiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      objective: "Compile a council-backed workflow graph.",
      workflowGraph: {
        schemaVersion: 1,
        id: "council_slot_graph",
        name: "Council Slot Graph",
        entryNodeId: "review",
        nodes: [
          {
            id: "review",
            kind: "step",
            name: "Review",
            prompt: "Review the plan.",
            councilSlotKey: "architect",
            skillId: "plan-eng-review",
          },
        ],
        edges: [],
        termination: {
          success: "all_required_succeeded",
          onFailedRequiredNode: "fail_workflow",
          onApprovalDenied: "block_for_user",
        },
        maxParallelSteps: 1,
      },
    });

    const graphStep = graphCompiled.workflowSteps[0];
    assert.equal(graphStep.toParticipantId, "teammate_builtin_architect");
    assert.equal(graphStep.metadata.councilSlotKey, "architect");
    assert.equal(graphStep.metadata.proposalStepSources[0].kind, "council");
    assert.equal(graphStep.metadata.proposalStepSources[0].councilId, developmentCouncilId);
    assert.equal(graphStep.metadata.proposalStepSources[0].slotKey, "architect");

    const missingSlot = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        objective: "Reject missing council slot.",
        customTemplate: customTemplate({
          id: "missing-council-slot-template",
          name: "Missing Council Slot Template",
          steps: [
            {
              id: "missing",
              name: "Missing",
              prompt: "Use a missing slot.",
              councilSlotKey: "missing-slot",
            },
          ],
        }),
      }),
    });
    assert.equal(missingSlot.status, 400);
    assert.match((await missingSlot.json()).message, /No effective AI council member found/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("custom workflow template rejects cycles and unknown runners at compile time", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-custom-template-invalid-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);
    const cyclic = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        objective: "Reject cycles.",
        customTemplate: customTemplate({
          id: "cycle-template",
          name: "Cycle Template",
          steps: [
            { id: "a", name: "A", prompt: "A", teammateTemplateId: "architect", dependsOn: ["b"] },
            { id: "b", name: "B", prompt: "B", teammateTemplateId: "architect", dependsOn: ["a"] },
          ],
        }),
      }),
    });
    assert.equal(cyclic.status, 400);
    assert.equal((await cyclic.json()).error, "bad_request");

    const unknownRunner = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        objective: "Reject unknown runner.",
        customTemplate: customTemplate({
          id: "unknown-runner-template",
          name: "Unknown Runner Template",
          steps: [
            { id: "a", name: "A", prompt: "A", teammateTemplateId: "architect", requestedRunnerId: "missing-runner" },
          ],
        }),
      }),
    });
    assert.equal(unknownRunner.status, 400);
    assert.match((await unknownRunner.json()).message, /not registered|missing-runner/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("custom workflow template unsafe autostart requires explicit confirmation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-custom-template-autostart-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Unsafe custom template");
    const body = {
      objective: "Unsafe autostart.",
      autoStart: true,
      customTemplate: customTemplate({
        id: "unsafe-template",
        name: "Unsafe Template",
        steps: [
          {
            id: "implement",
            name: "Implement",
            prompt: "Implement changes.",
            teammateTemplateId: "engineer",
            skillId: "implement",
          },
        ],
      }),
    };

    const rejected = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).message, /confirmUnsafeAutoStart/);

    const accepted = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      ...body,
      confirmUnsafeAutoStart: true,
    });
    assert.equal(accepted.workflowSteps[0].metadata.autoStart, true);
    assert.equal(accepted.workflowSteps[0].metadata.skillId, "implement");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("custom workflow template parallel branches start within compiled budget", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-custom-template-parallel-"));
  const runner = new ParallelDelayedRunner();
  let cleanupWorkflowId;
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Custom parallel template",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      allowedTools: ["read", "grep", "find", "ls"],
      runtimePolicy: {
        maxConcurrentRuns: 2,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;
    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      objective: "Run custom parallel branches.",
      providerPresetId: provider.id,
      autoStart: true,
      customTemplate: customTemplate({
        id: "custom-parallel",
        name: "Custom Parallel",
        maxParallelSteps: 2,
        steps: [
          {
            id: "branch-a",
            name: "Branch A",
            prompt: "Read branch A.",
            teammateTemplateId: "architect",
            skillId: "plan-eng-review",
            branchGroupId: "a",
          },
          {
            id: "branch-b",
            name: "Branch B",
            prompt: "Read branch B.",
            teammateTemplateId: "architect",
            skillId: "plan-eng-review",
            branchGroupId: "b",
          },
        ],
      }),
    });

    const tick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(tick.status, "started");
    assert.equal(tick.startedSteps.length, 2);
    cleanupWorkflowId = compiled.workflow.id;
    await runner.waitUntilStarted(2);
    assert.deepEqual(runner.runs.map((run) => run.task.title).sort(), ["Branch A", "Branch B"]);
  } finally {
    try {
      runner.resolveAll("custom parallel cleanup");
      if (cleanupWorkflowId) {
        await settleParallelDelayedWorkflow(daemon.url, cwd, cleanupWorkflowId, runner, "custom parallel cleanup");
      }
    } finally {
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("workflow orchestrator keeps serial behavior when smart scheduling max runs is one", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-serial-budget-"));
  const runner = new ParallelDelayedRunner();
  let cleanupWorkflowId;
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Serial budget workflow");
    await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`, {
      name: channel.name,
      status: channel.status,
      boundPath: channel.boundPath,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: channel.defaultTeammateId,
      allowedTools: ["read"],
      runtimePolicy: { ...channel.runtimePolicy, queueOnConflict: false },
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Serial branches",
      objective: "Keep default single-start behavior.",
      status: "ready",
      createdBy: "local-user",
    }, new Date().toISOString());
    createParallelWorkflowStep(store, workflow.id, "Serial A", {
      branchGroupId: "branch-a",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
    });
    createParallelWorkflowStep(store, workflow.id, "Serial B", {
      branchGroupId: "branch-b",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
    });

    const tick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(tick.status, "started");
    assert.equal(tick.startedSteps.length, 1);
    assert.equal(tick.schedulingDecision.effectiveMode, "serial");
    assert.deepEqual(tick.schedulingDecision.reasonCodes, ["smart_scheduling", "max_concurrent_runs_one"]);
    cleanupWorkflowId = workflow.id;
    await runner.waitUntilStarted(1);
    const steps = await getJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/steps?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(steps.workflowSteps.map((step) => step.status).sort(), ["queued", "running"]);
    runner.resolveAll("serial source completed");
    await runner.waitUntilStarted(2);
    await waitForCondition(() => store.getChannelWorkflow(workflow.id)?.status === "succeeded", "serial successor to finish without a manual tick");
  } finally {
    try {
      runner.resolveAll("serial cleanup");
      if (cleanupWorkflowId) {
        await settleParallelDelayedWorkflow(daemon.url, cwd, cleanupWorkflowId, runner, "serial cleanup", { drainQueued: true });
      }
    } finally {
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("workflow smart scheduling keeps side-effectful branches serial", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-smart-write-"));
  const runner = new ParallelDelayedRunner();
  let cleanupWorkflowId;
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Smart write workflow");
    await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`, {
      runtimePolicy: {
        ...channel.runtimePolicy,
        maxConcurrentRuns: 2,
      },
      defaultProviderPresetId: provider.id,
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Write branches",
      objective: "Keep write branches serial.",
      status: "ready",
      createdBy: "local-user",
    }, new Date().toISOString());
    createParallelWorkflowStep(store, workflow.id, "Write A", {
      branchGroupId: "branch-a",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
      requiredTools: ["write"],
    });
    createParallelWorkflowStep(store, workflow.id, "Write B", {
      branchGroupId: "branch-b",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
      requiredTools: ["write"],
    });
    cleanupWorkflowId = workflow.id;

    const tick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(tick.status, "started");
    assert.equal(tick.startedSteps.length, 1);
    assert.equal(tick.schedulingDecision.effectiveMode, "serial");
    assert.deepEqual(tick.schedulingDecision.reasonCodes, ["smart_scheduling", "side_effectful_step_serial"]);
    await runner.waitUntilStarted(1);
  } finally {
    try {
      runner.resolveAll("write cleanup");
      if (cleanupWorkflowId) {
        await settleParallelDelayedWorkflow(daemon.url, cwd, cleanupWorkflowId, runner, "write cleanup", { drainQueued: true });
      }
    } finally {
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("workflow smart scheduling keeps unknown-tool branches serial", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-smart-unknown-"));
  const runner = new ParallelDelayedRunner();
  let cleanupWorkflowId;
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Smart unknown workflow");
    await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`, {
      runtimePolicy: {
        ...channel.runtimePolicy,
        maxConcurrentRuns: 2,
      },
      defaultProviderPresetId: provider.id,
      allowedTools: ["read"],
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Unknown branches",
      objective: "Keep unknown tools serial.",
      status: "ready",
      createdBy: "local-user",
    }, new Date().toISOString());
    createParallelWorkflowStep(store, workflow.id, "Unknown A", {
      branchGroupId: "branch-a",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
      omitRequiredTools: true,
    });
    createParallelWorkflowStep(store, workflow.id, "Unknown B", {
      branchGroupId: "branch-b",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
      omitRequiredTools: true,
    });
    cleanupWorkflowId = workflow.id;

    const tick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(tick.status, "started");
    assert.equal(tick.startedSteps.length, 1);
    assert.equal(tick.schedulingDecision.effectiveMode, "serial");
    assert.equal(tick.schedulingDecision.safetyEvidence, "unknown");
    assert.deepEqual(tick.schedulingDecision.reasonCodes, ["smart_scheduling", "unknown_tools_serial"]);
    await runner.waitUntilStarted(1);
  } finally {
    try {
      runner.resolveAll("unknown cleanup");
      if (cleanupWorkflowId) {
        await settleParallelDelayedWorkflow(daemon.url, cwd, cleanupWorkflowId, runner, "unknown cleanup", { drainQueued: true });
      }
    } finally {
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("workflow smart scheduling does not start sibling branches while approval is pending", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-smart-approval-"));
  const runner = new ParallelDelayedRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Smart approval workflow");
    await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`, {
      runtimePolicy: {
        ...channel.runtimePolicy,
        maxConcurrentRuns: 2,
      },
      defaultProviderPresetId: provider.id,
      allowedTools: ["read"],
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Approval branches",
      objective: "Wait for approval before siblings.",
      status: "ready",
      createdBy: "local-user",
    }, new Date().toISOString());
    createParallelWorkflowStep(store, workflow.id, "Approval A", {
      branchGroupId: "branch-a",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
      approvalGate: { mode: "standard", risk: "medium" },
    });
    createParallelWorkflowStep(store, workflow.id, "Approval B", {
      branchGroupId: "branch-b",
      maxParallelSiblings: 2,
      providerPresetId: provider.id,
    });

    const tick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(tick.status, "waiting_for_approval");
    assert.equal(tick.waitingApprovals.length, 1);
    assert.equal(tick.schedulingDecision.effectiveMode, "serial");
    assert.deepEqual(tick.schedulingDecision.reasonCodes, ["smart_scheduling", "approval_pending"]);
    assert.equal(runner.runs.length, 0);
    const steps = await getJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/steps?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(steps.workflowSteps.filter((step) => step.status === "waiting_for_approval").length, 1);
    assert.equal(steps.workflowSteps.filter((step) => step.status === "queued").length, 1);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow dependencyMode any_succeeded can start a fan-in after mixed terminal branches", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-any-succeeded-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Any succeeded workflow",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      allowedTools: ["read"],
      runtimePolicy: {
        maxConcurrentRuns: 2,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const now = new Date().toISOString();
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Fan-in",
      objective: "Start when one dependency succeeded.",
      status: "ready",
      createdBy: "local-user",
    }, now);
    const succeeded = createParallelWorkflowStep(store, workflow.id, "Succeeded branch", {
      branchGroupId: "branch-a",
      providerPresetId: provider.id,
      status: "succeeded",
    });
    const failed = createParallelWorkflowStep(store, workflow.id, "Failed branch", {
      branchGroupId: "branch-b",
      providerPresetId: provider.id,
      status: "failed",
    });
    const fanIn = createParallelWorkflowStep(store, workflow.id, "Fan-in", {
      branchGroupId: "join",
      joinGroupId: "join-main",
      providerPresetId: provider.id,
      dependsOnStepIds: [succeeded.id, failed.id],
      dependencyMode: "any_succeeded",
      maxParallelSiblings: 2,
    });

    const tick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(tick.status, "started");
    assert.equal(tick.workflowStep.id, fanIn.id);
    assert.equal(tick.startedSteps.length, 1);
    assert.equal(runner.runs.length, 1);
    assert.equal(runner.runs[0].task.title, "Fan-in");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("fan-in requireAllBranchesTerminal is a scheduling barrier even with any_succeeded", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-fanin-barrier-"));
  const runner = new ParallelDelayedRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Fan-in barrier workflow");
    await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`, {
      defaultProviderPresetId: provider.id,
      allowedTools: ["read"],
      runtimePolicy: {
        maxConcurrentRuns: 2,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Fan-in barrier",
      objective: "Do not start synthesis before every branch is terminal.",
      status: "ready",
      createdBy: "local-user",
    }, new Date().toISOString());
    const succeeded = createParallelWorkflowStep(store, workflow.id, "Succeeded branch", {
      branchGroupId: "branch-a",
      providerPresetId: provider.id,
      status: "succeeded",
    });
    const pending = createParallelWorkflowStep(store, workflow.id, "Pending branch", {
      branchGroupId: "branch-b",
      providerPresetId: provider.id,
      status: "queued",
      autoStart: false,
    });
    const fanIn = createParallelWorkflowStep(store, workflow.id, "Barrier fan-in", {
      branchGroupId: "join",
      joinGroupId: "join-barrier",
      providerPresetId: provider.id,
      position: 3,
      dependsOnStepIds: [succeeded.id, pending.id],
      dependencyMode: "any_succeeded",
      maxParallelSiblings: 2,
      fanInPolicy: {
        mode: "memory_candidates",
        requireAllBranchesTerminal: true,
        includeFailedBranches: true,
        createSummaryArtifact: false,
        createMemoryCandidates: false,
        memoryCandidateScope: "channel",
        maxInputArtifacts: 8,
      },
    });
    const independent = createParallelWorkflowStep(store, workflow.id, "Independent queued branch", {
      branchGroupId: "branch-c",
      providerPresetId: provider.id,
      position: 4,
      maxParallelSiblings: 2,
    });

    const before = await postJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(before.status, "started");
    assert.equal(before.startedSteps.length, 1);
    assert.equal(before.workflowStep.id, independent.id);
    assert.equal(runner.runs.length, 1);
    assert.equal(runner.runs[0].task.title, independent.title);
    assert.equal(store.getChannelWorkflowStep(fanIn.id).status, "queued");

    const cancelled = store.transitionChannelWorkflowStepStatus({
      workflowStepId: pending.id,
      expectedStatus: "queued",
      event: "cancel",
      actor: "system",
      reason: "pending branch was cancelled after its predecessor was unavailable",
      now: new Date().toISOString(),
    });
    assert.equal(cancelled.ok, true);

    runner.resolveAll("independent branch complete");
    await waitForCondition(
      () => store.getChannelWorkflowStep(independent.id)?.status === "succeeded",
      "independent branch to finish before fan-in",
    );
    await postJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    await waitForCondition(
      () => runner.runs.filter((run) => run.task.title === fanIn.title).length === 1,
      "fan-in to start after every dependency becomes terminal",
    );
    assert.equal(runner.runs.filter((run) => run.task.title === fanIn.title).length, 1);
  } finally {
    runner.resolveAll("cleanup");
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow fan-in creates summary artifact, memory candidate, selector decision, and evidence drilldown", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-fanin-evidence-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Fan-in evidence workflow",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      allowedTools: ["read"],
      runtimePolicy: {
        maxConcurrentRuns: 2,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const now = new Date().toISOString();
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Fan-in evidence",
      objective: "Create auditable fan-in evidence.",
      status: "ready",
      createdBy: "local-user",
    }, now);
    const succeeded = createParallelWorkflowStep(store, workflow.id, "Succeeded Evidence Branch", {
      branchGroupId: "branch-a",
      providerPresetId: provider.id,
      status: "succeeded",
    });
    const failed = createParallelWorkflowStep(store, workflow.id, "Failed Evidence Branch", {
      branchGroupId: "branch-b",
      providerPresetId: provider.id,
      status: "failed",
    });
    const fanIn = createParallelWorkflowStep(store, workflow.id, "Fan-in Evidence", {
      branchGroupId: "join",
      joinGroupId: "join-evidence",
      providerPresetId: provider.id,
      dependsOnStepIds: [succeeded.id, failed.id],
      dependencyMode: "any_succeeded",
      maxParallelSiblings: 2,
      fanInPolicy: {
        mode: "memory_candidates",
        requireAllBranchesTerminal: true,
        includeFailedBranches: true,
        createSummaryArtifact: true,
        createMemoryCandidates: true,
        memoryCandidateScope: "channel",
        maxInputArtifacts: 8,
      },
    });

    const tick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(tick.status, "started");
    assert.equal(tick.workflowStep.id, fanIn.id);
    const completedFanIn = await waitForWorkflowStepStatus(daemon.url, cwd, workflow.id, fanIn.id, "succeeded");
    assert.ok(completedFanIn.metadata.selectorDecisionIds.length > 0);
    assert.ok(completedFanIn.metadata.outputArtifactId);
    assert.ok(completedFanIn.metadata.fanInSummaryArtifactId);
    assert.equal(completedFanIn.metadata.memoryCandidateIds.length, 1);

    const outputPacket = await getArtifactJson(daemon.url, cwd, completedFanIn.metadata.outputArtifactId);
    assert.equal(outputPacket.sourceRefs.some((ref) => ref.type === "workflow_selector_decision" && ref.id === completedFanIn.metadata.selectorDecisionIds[0]), true);

    const workflowEvidence = await getJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/evidence?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workflowEvidence.selectorDecisions.some((decision) => decision.id === completedFanIn.metadata.selectorDecisionIds[0] && decision.status === "accepted"), true);
    assert.equal(workflowEvidence.memoryCandidates.some((candidate) =>
      candidate.memory.id === completedFanIn.metadata.memoryCandidateIds[0] &&
      candidate.memory.reviewState === "candidate" &&
      candidate.memory.verifyBeforeUse === true &&
      candidate.sourceWorkflowStepIds.includes(completedFanIn.id)
    ), true);

    const stepEvidence = await getJson(`${daemon.url}/workflow-steps/${encodeURIComponent(completedFanIn.id)}/evidence?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(stepEvidence.workflowStep.step.id, completedFanIn.id);
    assert.equal(stepEvidence.selectorDecisions.length, 1);
    assert.equal(stepEvidence.memoryCandidates.length, 1);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow cancel aborts active run, queued steps, and pending workflow approvals", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-cancel-"));
  const runner = new DelayedRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Cancel workflow");
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);

    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      templateId: "autoplan-lite",
      objective: "Cancel the workflow.",
      providerPresetId: provider.id,
      createdBy: "local-user",
    });
    const firstTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(firstTick.status, "started");
    await waitForCondition(() => runner.runs.length === 1, "workflow runner start before cancel");

    const cancelled = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/cancel?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(cancelled.workflow.status, "cancelled");
    assert.equal(cancelled.cancelledRunIds.length, 1);
    assert.deepEqual(cancelled.workflowSteps.map((step) => step.status), Array(8).fill("cancelled"));

    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(cancelled.cancelledRunIds[0])}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(run.status, "cancelled");
  } finally {
    runner.resolve("cleanup");
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow step retry starts a blocked step after configuration is repaired", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-retry-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Retry workflow");
    simulateLegacyChannelWithoutModel(cwd, channel.id);
    const compiled = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`, {
      templateId: "autoplan-lite",
      objective: "Retry a blocked workflow step.",
      createdBy: "local-user",
    });
    const blocked = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.workflowStep.metadata.templateStepId, "product-discovery");
    assert.match(blocked.blocker, /provider preset/i);

    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      capabilities: ["chat", "reasoning", "tool_call"],
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`, {
      defaultProviderPresetId: provider.id,
    });

    const retried = await postJson(`${daemon.url}/workflow-steps/${encodeURIComponent(blocked.workflowStep.id)}/retry?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(retried.status, "started");
    assert.equal(retried.workflowStep.metadata.templateStepId, "product-discovery");
    await waitForCondition(() => runner.runs.length >= 1, "workflow retry runner start");
    assert.equal(runner.runs[0].task.title, "Product Discovery");
    const roster = await getJson(`${daemon.url}/teammates?cwd=${encodeURIComponent(cwd)}&includeHidden=true&includeDisabled=true`);
    const assignedTeammate = roster.teammates.find((teammate) => teammate.id === retried.workflowStep.toParticipantId);
    assert.ok(assignedTeammate);
    assert.equal(runner.runs[0].systemPrompt, assignedTeammate.systemPrompt);
    assert.deepEqual(
      runner.runs[0].appendSystemPrompt.slice(0, assignedTeammate.appendSystemPrompt.length),
      assignedTeammate.appendSystemPrompt,
    );
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel link preview blocks localhost targets instead of fetching them", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-links-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);
    const preview = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/link-previews?cwd=${encodeURIComponent(cwd)}`, {
      url: "http://localhost:12345/private",
    });
    assert.equal(preview.linkPreview.status, "blocked");
    assert.equal(preview.linkPreview.errorMessage, "Public HTTP blocks local or private network targets.");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
