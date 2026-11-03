import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import assert from "node:assert/strict";
import { access, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteWorkspaceFixture } from "./test-support/sqlite-workspace-fixture.ts";
import { createCompositeSecretResolver, createSqliteRunStore, projectConversationItemToChannelMessage } from "../../core/dist/index.js";
import { createRequiredParticipantManifestV1, createWorkflowParticipantAuthorityV1 } from "../../contracts/dist/index.js";
import { routeChannelMessageReply } from "../dist/features/channels/channel-message-router.js";
import { resolveWorkflowParticipantRunProfile } from "../dist/features/channels/workflow-participant-run-profile.js";
import { preflightWorkflowParticipantProvider } from "../dist/features/channels/workflow-participant-provider.js";
import { prepareWorkflowStepStart } from "../dist/features/channels/workflows.js";
import { selectChannelWorkflowIntent } from "../dist/features/channels/channel-intent-selector.js";
import { confirmChannelExecutionProposalWorkflow } from "../dist/features/channels/proposal-workflows.js";
import { prepareChannelCreateBody } from "./conversation-model-test-fixture.mjs";
import { ensureEmptyGitRepo, ensureGitRepoForChannelPost } from "./git-test-helpers.mjs";
import { commandOperationCandidate, fileOperationCandidate } from "./support/channel-operation-candidate-fixture.mjs";
import { messageText, startRealPiChannelFixture, systemText } from "./support/channel-operation-real-pi-fixture.mjs";
import {
  withRestrictedCommandReadiness,
  projectionFor,
  RecordingRunner,
  WorkflowEvidenceRunner,
  DelayedCommandEvidenceRunner,
  MismatchedExactCommandRunner,
  DelayedFileCommandRunner,
  escapeRegExp,
  ScriptedRunner,
  DelayedRunner,
  testDaemonConfig,
  unusedRunnerRegistry,
  assertInvalidModelPlan,
  startDaemonForTest,
  publishHostOpenAvailability,
  createStoreChannelAndMessage,
  createChannel,
  setWorkspaceDefaultProvider,
  createAutoRouteTestChannel,
  createStaticChatProvider,
  simulateLegacyChannelWithoutModel,
  parseSseEvents,
  getJson,
  assertCoordinatorWorkflowStartReply,
  assertIntentDecisionInspectPayloadIsSafe,
  assertSingleReplyIntentDecision,
  waitForChannelMessageStatus,
  waitForCondition,
  postJson,
  putJson,
  patchJson,
} from "./support/channel-workspace-fixture.mjs";

test("mentions_only creates a blocked Ling Agent reply when the channel has no runnable provider", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-mentions-only-route-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createChannel(daemon.url, cwd);
    simulateLegacyChannelWithoutModel(cwd, channel.id);

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个频道自动回复怎么设计？",
    });

    assert.equal(created.aiReply.status, "blocked");
    assert.equal(created.aiReply.authorId, "ling_agent");
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "blocked");
    const blockedReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(blockedReply.body, "AI teammate is not configured for this channel.");
    assert.equal(blockedReply.errorMessage, "No provider preset is selected for this channel discussion.");
    assert.equal(runner.runs.length, 0);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].mode, "mentions_only");
    assert.equal(decisions.decisions[0].action, "reply");
    assert.equal(decisions.decisions[0].status, "failed");
    assert.equal(decisions.decisions[0].createdBy, "deterministic");
    assert.equal(decisions.decisions[0].replyMessageId, created.aiReply.id);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("default_teammate routes root messages through Ling Agent without proposals", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-default-teammate-route-"));
  const runner = new ScriptedRunner([
    `<ling_task_proposal>{"title":"Should not persist","prompt":"Create a task","acceptanceCriteria":["never"],"requiredTools":["read"],"riskSummary":"blocked by proposalMode"}</ling_task_proposal>Visible default reply`,
    "这个频道当前有多个 AI 队友，具体数量以频道成员列表为准。",
  ]);
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "engineer",
      autoReplyMode: "default_teammate",
      allowedTools: ["read"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个实现边界怎么处理？",
    });
    assert.equal(created.aiReply.status, "pending");
    assert.equal(created.aiReply.authorId, "ling_agent");
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(finalReply.body, "Visible default reply");
    assert.doesNotMatch(finalReply.body, /ling_task_proposal/);
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].systemPrompt, /Do not include hidden proposal blocks/);
    assert.match(runner.runs[0].task.prompt, /Current teammate: Ling Agent \(id: ling_agent, role: custom\)/);
    assert.doesNotMatch(runner.runs[0].task.prompt, /Channel teammates \(configured roster/);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].mode, "default_teammate");
    assert.equal(decisions.decisions[0].action, "reply");
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].createdBy, "deterministic");
    assert.equal(decisions.decisions[0].selectedTeammateId, "ling_agent");
    assert.equal(decisions.decisions[0].replyMessageId, created.aiReply.id);

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(proposals.proposals, []);
    assert.deepEqual((await getJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`)).tasks, []);
    const firstReplyRuns = (await getJson(`${daemon.url}/runs?cwd=${encodeURIComponent(cwd)}`)).runs;
    assert.equal(firstReplyRuns.length, 1);
    assert.equal(firstReplyRuns[0].id, finalReply.linkedRunId);
    assert.equal(firstReplyRuns[0].status, "succeeded");
    assert.equal(firstReplyRuns[0].taskId, created.message.id);

    const countQuestion = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "现在频道有多少个队友",
    });
    assert.equal(countQuestion.aiReply.status, "pending");
    const countReplyList = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, countQuestion.aiReply.id, "ready");
    const countReply = countReplyList.messages.find((message) => message.id === countQuestion.aiReply.id);
    assert.equal(countReply.body, "这个频道当前有多个 AI 队友，具体数量以频道成员列表为准。");
    assert.equal(runner.runs.length, 2);
    assert.match(runner.runs[1].task.prompt, /Channel teammates \(configured roster; not online\/presence\):/);
    assert.match(runner.runs[1].task.prompt, /Engineer \(id: teammate_builtin_engineer, role: engineer\).*default/);
    assert.match(runner.runs[1].task.prompt, /Do not claim online\/presence status/);

    const countDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(countQuestion.message.id)}`);
    assert.equal(countDecisions.decisions.length, 1);
    assert.equal(countDecisions.decisions[0].mode, "default_teammate");
    assert.equal(countDecisions.decisions[0].action, "reply");
    assert.equal(countDecisions.decisions[0].status, "accepted");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel intent selector creates visible multi-replies for discussion-only all-teammate requests", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-intent-visible-multi-reply-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "engineer",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    for (const teammateId of ["teammate_builtin_architect", "teammate_builtin_engineer", "teammate_builtin_qa"]) {
      await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
        providerPresetId: provider.id,
      });
      await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
        memberships: [{ channelId: channel.id }],
      });
    }

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "所有队友都回复我一下",
    });

    assert.equal(created.message.body, "所有队友都回复我一下");
    assert.equal(created.aiReplies.length, 3);
    assert.equal(created.aiReply.id, created.aiReplies[0].id);
    assert.deepEqual(
      created.aiReplies.map((reply) => reply.authorId).sort(),
      ["teammate_builtin_architect", "teammate_builtin_engineer", "teammate_builtin_qa"].sort(),
    );
    assert.deepEqual(created.aiReplies.map((reply) => reply.status), ["pending", "pending", "pending"]);

    await Promise.all(created.aiReplies.map((reply) => waitForChannelMessageStatus(daemon.url, cwd, channel.id, reply.id, "ready")));
    assert.equal(runner.runs.length, 3);
    assert(runner.runs.every((run) => /Do not include hidden proposal blocks/.test(run.systemPrompt)));
    assert(runner.runs.every((run) => /Channel teammates \(configured roster; not online\/presence\):/.test(run.task.prompt)));
    assert(runner.runs.every((run) => /Visible multi-reply participants for this batch:/.test(run.task.prompt)));
    assert(runner.runs.every((run) => /Architect \(id: teammate_builtin_architect, role: architect\)/.test(run.task.prompt)));
    assert(runner.runs.every((run) => /Engineer \(id: teammate_builtin_engineer, role: engineer\)/.test(run.task.prompt)));
    assert(runner.runs.every((run) => /QA \(id: teammate_builtin_qa, role: qa\)/.test(run.task.prompt)));
    assert(runner.runs.every((run) => /Do not claim online\/presence status/.test(run.task.prompt)));
    assert(runner.runs.every((run) => /not-yet-generated peer replies/.test(run.task.prompt)));

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(proposals.proposals, []);

    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(routeDecisions.decisions.length, 0);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assertIntentDecisionInspectPayloadIsSafe(decisions.decisions[0]);
    assert.equal(decisions.decisions[0].action, "visible_multi_reply");
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].createdBy, "deterministic");
    assert.deepEqual(
      [...decisions.decisions[0].selectedTeammateIds].sort(),
      created.aiReplies.map((reply) => reply.authorId).sort(),
    );
    assert.deepEqual(
      [...decisions.decisions[0].resultItemIds].sort(),
      created.aiReplies.map((reply) => reply.id).sort(),
    );
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel intent selector creates workflow proposals for execution-shaped all-teammate requests", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-intent-workflow-proposal-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "teammate_builtin_engineer",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
      runtimePolicy: {
        maxConcurrentRuns: 1,
        schedulingMode: "smart",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;
    for (const teammateId of ["teammate_builtin_architect", "teammate_builtin_engineer", "teammate_builtin_qa"]) {
      await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
        providerPresetId: provider.id,
      });
      await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
        memberships: [{ channelId: channel.id }],
      });
    }

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "所有队友都回复我一下：Architect 先拆，Engineer 实现，QA 验证",
      teammateId: "ling_agent",
      requestAiReply: true,
    });

    assert.equal(created.message.body, "所有队友都回复我一下：Architect 先拆，Engineer 实现，QA 验证");
    assert.equal(created.aiReply, undefined);
    assert.equal(runner.runs.length, 0);

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].sourceMessageId, created.message.id);
    assert.equal(proposals.proposals[0].status, "draft");
    assert.equal(proposals.proposals[0].assigneeTeammateId, "teammate_builtin_engineer");
    assert.deepEqual(
      proposals.proposals[0].collaborationSteps.map((step) => step.teammateId),
      ["teammate_builtin_architect", "teammate_builtin_engineer", "teammate_builtin_qa"],
    );
    assert.equal(proposals.proposals[0].responseLanguage, "follow_user");
    assert.match(proposals.proposals[0].prompt, /需要协作执行的工作流请求/);
    assert.match(proposals.proposals[0].acceptanceCriteria[0], /可审计的提案证据/);
    assert.match(proposals.proposals[0].collaborationSteps[0].summary, /实现边界和步骤顺序/);
    assert.match(proposals.proposals[0].riskSummary, /工作流提案/);

    const listedMessages = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/items?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listedMessages.messages.filter((message) => message.kind === "ai_reply").length, 0);

    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(routeDecisions.decisions.length, 0);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assertIntentDecisionInspectPayloadIsSafe(decisions.decisions[0]);
    assert.equal(decisions.decisions[0].action, "workflow_proposal");
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].createdBy, "deterministic");
    assert.equal(decisions.decisions[0].proposalId, proposals.proposals[0].id);
    assert.match(decisions.decisions[0].reason, /Workflow proposal created from channel intent/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("multi-participant concrete file workflow preserves operation-derived tools", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-multi-participant-file-tools-"));
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
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Concrete multi-agent execution",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    const participants = ["teammate_builtin_engineer", "teammate_builtin_qa"];
    for (const teammateId of participants) {
      await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
        providerPresetId: provider.id,
      });
      await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
        memberships: [{ channelId: channel.id }],
      });
    }

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Engineer @QA 请协作完成一个最小可验证任务：由 Engineer 创建 r5-channel-proof.txt，内容为 continuity-v2-r5-proof；QA 执行命令验证文件内容。Engineer 与 QA 都必须完成并提供真实 evidence 后才报告成功。",
      mentions: [
        { id: "teammate_builtin_engineer", label: "Engineer", kind: "ai-teammate" },
        { id: "teammate_builtin_qa", label: "QA", kind: "ai-teammate" },
      ],
      requestAiReply: true,
    });
    assert.ok(created.autoStartedWorkflow);
    assert.equal(created.aiReply.kind, "ai_reply");
    assert.ok(["pending", "ready"].includes(created.aiReply.status));
    const store = stores.get(cwd);
    assert.ok(store);
    const decision = store.listChannelIntentDecisions({ sourceItemId: created.message.id, limit: 20 })
      .find((candidate) => candidate.workflowId === created.autoStartedWorkflow.workflow.id);
    assert.ok(decision);
    assert.equal(decision.action, "execute");
    assert.deepEqual(decision.participantManifest.participants.map((participant) => participant.participantId), participants);
    assert.deepEqual(decision.participantManifest.participants.map((participant) => participant.requiredOperationIds), [["create_file"], ["verify_target"]]);
    const verificationOperation = decision.execution?.operations.find((operation) => operation.id === "verify_target");
    assert.equal(verificationOperation?.commandMatchPolicy?.kind, "exact_command");
    assert.ok(verificationOperation?.commandMatchPolicy?.kind === "exact_command");
    assert.match(
      verificationOperation.commandMatchPolicy.command,
      new RegExp(`Buffer\\.from\\('${Buffer.from("continuity-v2-r5-proof", "utf8").toString("base64")}\\',\\s*'base64'\\)`),
    );
    assert.doesNotMatch(verificationOperation.commandMatchPolicy.command, /QA/u);

    const proposal = store.listChannelExecutionProposals({
      channelId: channel.id,
      sourceMessageId: created.message.id,
      limit: 20,
    })[0];
    assert.ok(proposal);
    assert.deepEqual(proposal.requiredTools, ["write", "bash"]);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 2);
    assert.deepEqual(created.autoStartedWorkflow.workflowSteps.map((step) => step.toParticipantId), participants);
    assert.deepEqual(created.autoStartedWorkflow.workflowSteps.map((step) => step.metadata.executionOperationIds), [["create_file"], ["verify_target"]]);
    assert.deepEqual(created.autoStartedWorkflow.workflowSteps.map((step) => step.metadata.requiredTools), [["write"], ["bash"]]);
    const [engineerStep, qaStep] = created.autoStartedWorkflow.workflowSteps;
    assert.match(engineerStep.prompt, /create_file: file_create -> r5-channel-proof\.txt/u);
    assert.match(qaStep.prompt, /verify_target: run_command -> verify r5-channel-proof\.txt content/u);
    assert.ok(
      qaStep.prompt.includes(`exact command: ${verificationOperation.commandMatchPolicy.command}`),
      "QA step prompt must carry the exact Host-materialized command used by Completion Gate",
    );
    assert.match(qaStep.prompt, /do not substitute a semantically equivalent command/u);
    assert.deepEqual(runner.runs[0].tools, ["write"]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("review-only participant uses an output packet while execution participant keeps Host evidence", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-review-only-participant-"));
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
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    for (const teammateId of ["teammate_builtin_designer", "teammate_builtin_engineer"]) {
      await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
        providerPresetId: provider.id,
      });
    }
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Review then execute",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "bash", "edit", "write"],
    })).channel;
    for (const teammateId of ["teammate_builtin_designer", "teammate_builtin_engineer"]) {
      await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
        memberships: [{ channelId: channel.id }],
      });
    }

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Designer @Engineer 现在开始执行这个多 Agent 工作流：Designer 先评审文件结构和验收标准，Engineer 创建 review-only-proof.js 并运行 node review-only-proof.js。",
      mentions: [
        { id: "teammate_builtin_designer", label: "Designer", kind: "ai-teammate" },
        { id: "teammate_builtin_engineer", label: "Engineer", kind: "ai-teammate" },
      ],
      requestAiReply: true,
    });

    assert.ok(created.autoStartedWorkflow);
    assert.equal(created.aiReply.kind, "ai_reply");
    assert.ok(["pending", "ready"].includes(created.aiReply.status));
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 2);
    const [designerStep, engineerStep] = created.autoStartedWorkflow.workflowSteps;
    assert.equal(designerStep.toParticipantId, "teammate_builtin_designer");
    assert.equal(designerStep.metadata.delegatedRequirement.expectedOutcome, "synthesis");
    assert.deepEqual(designerStep.metadata.executionOperationIds, []);
    assert.equal(engineerStep.toParticipantId, "teammate_builtin_engineer");
    assert.equal(engineerStep.metadata.delegatedRequirement.expectedOutcome, "execution");
    assert.ok(engineerStep.metadata.executionOperationIds.length > 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow Host binding rejects a semantic substitute before Completion Gate", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-exact-command-boundary-"));
  const runner = new MismatchedExactCommandRunner();
  const daemon = await startDaemonForTest(runner, undefined,
    withRestrictedCommandReadiness({ channels: { intentSelector: true } }));
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Exact command boundary",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "bash"],
    })).channel;
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_qa")}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_qa")}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "@QA 执行 `node app.js` 验证，并且必须提供真实 evidence。",
      mentions: [{ id: "teammate_builtin_qa", label: "QA", kind: "ai-teammate" }],
      requestAiReply: true,
    });
    assertCoordinatorWorkflowStartReply(created);
    await waitForCondition(() => runner.decisions.length === 1, "workflow exact-command binding rejection");
    assert.equal(runner.decisions[0].approved, false);
    assert.match(runner.decisions[0].reason,
      /operation_binding_command_out_of_scope: No unique owned operation authorizes this exact command\./u);
    await waitForCondition(async () => {
      const steps = await getJson(`${daemon.url}/workflows/${encodeURIComponent(created.autoStartedWorkflow.workflow.id)}/steps?cwd=${encodeURIComponent(cwd)}`);
      return steps.workflowSteps.every((step) =>
        step.status === "blocked" && step.metadata?.delegatedOutcome?.kind === "blocked");
    }, "workflow to remain blocked after Host rejection");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel intent selector does not assign specialists outside current channel", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-intent-roster-boundary-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    for (const teammateId of ["teammate_builtin_architect", "teammate_builtin_engineer", "teammate_builtin_qa"]) {
      await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
        providerPresetId: provider.id,
      });
    }

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "Architect 先拆，Engineer 实现，QA 验证",
    });

    assert.equal(created.aiReply, undefined);
    assert.equal(runner.runs.length, 0);

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].assigneeTeammateId, "ling_agent");
    assert.equal(proposals.proposals[0].proposedByTeammateId, "ling_agent");
    assert.deepEqual(proposals.proposals[0].collaborationSteps.map((step) => step.teammateId), ["ling_agent"]);
    assert.match(proposals.proposals[0].riskSummary, /Ling Agent 可以先处理这个有边界的任务/);
    assert.doesNotMatch(proposals.proposals[0].prompt, /Engineer:|QA:|Architect:/);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assertIntentDecisionInspectPayloadIsSafe(decisions.decisions[0]);
    assert.equal(decisions.decisions[0].action, "workflow_proposal");
    assert.equal(decisions.decisions[0].proposalId, proposals.proposals[0].id);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel intent selector uses attached AI council specialists without copying memberships", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-intent-council-specialists-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  const developmentCouncilId = "council_builtin_development";
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Council-backed Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    for (const teammateId of ["teammate_builtin_designer", "teammate_builtin_qa"]) {
      await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
        providerPresetId: provider.id,
      });
    }
    await putJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/council-policy?cwd=${encodeURIComponent(cwd)}`, {
      attachedCouncilIds: [developmentCouncilId],
      preferredCouncilId: developmentCouncilId,
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "Designer 先 review 交互，QA 验证这个频道设置改动",
    });

    assert.equal(created.aiReply, undefined);
    assert.equal(runner.runs.length, 0);

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "draft");
    assert.deepEqual(
      [...proposals.proposals[0].collaborationSteps.map((step) => step.teammateId)].sort(),
      ["teammate_builtin_designer", "teammate_builtin_qa"].sort(),
    );
    assert.equal(proposals.proposals[0].collaborationSteps.some((step) => step.teammateId === "ling_agent"), false);
    const designerStep = proposals.proposals[0].collaborationSteps.find((step) => step.teammateId === "teammate_builtin_designer");
    assert.ok(designerStep);
    assert.ok(designerStep.sources?.some((source) => source.kind === "council" && source.councilDisplayName === "Development Council"));

    const effective = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/effective-council?cwd=${encodeURIComponent(cwd)}`);
    const designerSpecialist = effective.effectiveCouncil.specialists.find((specialist) => specialist.teammateId === "teammate_builtin_designer");
    assert.ok(designerSpecialist);
    assert.ok(designerSpecialist.sources.some((source) => source.kind === "council" && source.councilId === developmentCouncilId));

    const confirmed = await postJson(`${daemon.url}/channel-proposals/${encodeURIComponent(proposals.proposals[0].id)}/confirm-workflow?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(confirmed.proposal.status, "accepted");
    assert.deepEqual(
      [...confirmed.workflowSteps.map((step) => step.toParticipantId)].sort(),
      ["teammate_builtin_designer", "teammate_builtin_qa"].sort(),
    );
    const designerWorkflowStep = confirmed.workflowSteps.find((step) => step.toParticipantId === "teammate_builtin_designer");
    assert.ok(designerWorkflowStep);
    assert.ok(designerWorkflowStep.metadata?.proposalStepSources?.some((source) =>
      source.kind === "council" &&
      source.councilId === developmentCouncilId &&
      source.councilDisplayName === "Development Council"
    ));
    const designerChannels = await getJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_designer")}/channels?cwd=${encodeURIComponent(cwd)}`);
    const qaChannels = await getJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_qa")}/channels?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(designerChannels.memberships.some((membership) => membership.channelId === channel.id), false);
    assert.equal(qaChannels.memberships.some((membership) => membership.channelId === channel.id), false);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assertIntentDecisionInspectPayloadIsSafe(decisions.decisions[0]);
    assert.equal(decisions.decisions[0].action, "workflow_proposal");
    assert.equal(decisions.decisions[0].proposalId, proposals.proposals[0].id);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel intent selector asks one clarify question for underspecified work requests", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-intent-clarify-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "teammate_builtin_engineer",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep"],
    })).channel;
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_engineer")}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_engineer")}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "做一下吧",
    });

    assert.equal(created.message.body, "做一下吧");
    assert.equal(created.aiReply.kind, "ai_reply");
    assert.equal(created.aiReply.status, "ready");
    assert.equal(created.aiReply.threadId, created.message.threadId);
    assert.equal(created.aiReply.authorId, "ling_agent");
    assert.match(created.aiReply.body, /需要先确认范围/);
    assert.equal(runner.runs.length, 0);

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(proposals.proposals, []);

    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(routeDecisions.decisions.length, 0);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assertIntentDecisionInspectPayloadIsSafe(decisions.decisions[0]);
    assert.equal(decisions.decisions[0].action, "clarify");
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].createdBy, "deterministic");
    assert.deepEqual(decisions.decisions[0].selectedTeammateIds, ["ling_agent"]);
    assert.deepEqual(decisions.decisions[0].resultItemIds, [created.aiReply.id]);
    assert.deepEqual(decisions.decisions[0].clarification.missingFields, ["acceptance_criteria"]);
    assert.equal(decisions.decisions[0].clarification.question, created.aiReply.body);
    assert.match(decisions.decisions[0].reason, /Clarify question created from channel intent/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel intent selector auto-starts explicit direct workflow proposals", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-intent-direct-workflow-"));
  const runner = new WorkflowEvidenceRunner();
  const daemon = await startDaemonForTest(runner, {}, { channels: { terminalReports: true } });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "teammate_builtin_engineer",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    for (const teammateId of ["teammate_builtin_architect", "teammate_builtin_engineer", "teammate_builtin_qa"]) {
      await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
        providerPresetId: provider.id,
      });
      await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
        memberships: [{ channelId: channel.id }],
      });
    }

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "开始跑 Architect -> Engineer -> QA",
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 3);
    await waitForCondition(
      () => runner.runs.filter((run) => !/terminal report synthesizer/i.test(run.systemPrompt ?? "")).length === 3,
      "direct workflow proposal runner sequence",
    );
    let listedMessages;
    await waitForCondition(async () => {
      listedMessages = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/items?cwd=${encodeURIComponent(cwd)}`);
      return listedMessages.items.some((item) =>
        item.kind === "terminal_report" && item.payload?.outcomeStatus === "succeeded");
    }, "direct workflow terminal publication");
    const terminalItem = listedMessages.items.find((item) =>
      item.kind === "terminal_report" && item.payload?.outcomeStatus === "succeeded");
    assert.ok(terminalItem);
    const terminalReport = await getJson(`${daemon.url}/terminal-reports/${encodeURIComponent(terminalItem.payload.reportId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(terminalReport.report.outcome.status, "succeeded");
    assert.match(terminalReport.report.outcome.summary, /任务已完成/u);
    assert.equal(terminalReport.report.participants.length, 3);

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.equal(proposals.proposals[0].linkedWorkflowId, created.autoStartedWorkflow.workflow.id);
    assert.equal(proposals.proposals[0].responseLanguage, "follow_user");
    assert.deepEqual(
      proposals.proposals[0].collaborationSteps.map((step) => step.teammateId),
      ["teammate_builtin_architect", "teammate_builtin_engineer", "teammate_builtin_qa"],
    );
    assert.match(proposals.proposals[0].riskSummary, /运行时审批策略/);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 2);
    assertIntentDecisionInspectPayloadIsSafe(decisions.decisions[0]);
    assert.equal(decisions.decisions[0].action, "execute");
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].proposalId, proposals.proposals[0].id);
    assert.equal(decisions.decisions.some((decision) => decision.workflowId === created.autoStartedWorkflow.workflow.id && /proposal .*: (?:started|queued)\./u.test(decision.reason)), true);

    assert.equal(created.autoStartedWorkflow.workflow.metadata.responseLanguage, "follow_user");
    assert.match(created.autoStartedWorkflow.workflowSteps[0].prompt, /Match the language of the most recent user message/);
    assert.match(created.autoStartedWorkflow.workflowSteps[0].prompt, /API fields, and evidence excerpts in their original language/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("explicit response language overrides workspace default for workflow proposals", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-intent-language-override-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    await patchJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
      responseLanguage: "zh-CN",
    });
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "teammate_builtin_engineer",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    for (const teammateId of ["teammate_builtin_architect", "teammate_builtin_engineer", "teammate_builtin_qa"]) {
      await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
        memberships: [{ channelId: channel.id }],
      });
    }

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "Architect 先拆，Engineer 实现，QA 验证。Please respond in English.",
    });
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].responseLanguage, "en-US");
    assert.match(proposals.proposals[0].prompt, /Proposed collaboration/);
    assert.match(proposals.proposals[0].acceptanceCriteria[0], /Create auditable proposal evidence/);
    assert.match(proposals.proposals[0].riskSummary, /Multi-agent work starts after confirmation/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel response language overrides follow-user inference for workflow proposals", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-intent-language-channel-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultTeammateId: "teammate_builtin_engineer",
      autoReplyMode: "default_teammate",
      responseLanguage: "en-US",
      allowedTools: ["read", "grep"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "Architect 先拆，Engineer 实现，QA 验证",
    });
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].responseLanguage, "en-US");
    assert.match(proposals.proposals[0].prompt, /Proposed collaboration/);
    assert.match(proposals.proposals[0].riskSummary, /Multi-agent work starts after confirmation/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("single-step file creation becomes direct workflow with bounded write tools", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-single-step-file-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Docs execution",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "teammate_builtin_docs",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;
    await setWorkspaceDefaultProvider(daemon.url, cwd, channel.defaultProviderPresetId);

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: `在 ${cwd} 下创建 README.md`,
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.equal(proposals.proposals[0].linkedWorkflowId, created.autoStartedWorkflow.workflow.id);
    assert.equal(proposals.proposals[0].assigneeTeammateId, "teammate_builtin_docs");
    assert.deepEqual(proposals.proposals[0].requiredTools, ["write"]);
    assert.match(proposals.proposals[0].riskSummary, /write/);
    assert.match(proposals.proposals[0].prompt, /权限边界/);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 2);
    assert.equal(decisions.decisions[0].action, "execute");
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions.some((decision) => decision.workflowId === created.autoStartedWorkflow.workflow.id && /proposal .*: (?:started|queued)\./u.test(decision.reason)), true);

    assert.deepEqual(created.autoStartedWorkflow.workflowSteps[0].metadata.requiredTools, ["write"]);
    assert.equal(runner.runs.length, 1);
    assert.deepEqual(runner.runs[0].tools, ["write"]);
    assert.match(runner.runs[0].task.prompt, /Confirmed task-scoped tools:\nwrite/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("explicit command request becomes execute with bounded bash tools", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-single-command-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Command execution",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "teammate_builtin_qa",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "bash"],
    })).channel;
    await setWorkspaceDefaultProvider(daemon.url, cwd, channel.defaultProviderPresetId);

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "运行 `pnpm test` 并报告结果。",
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.deepEqual(proposals.proposals[0].requiredTools, ["bash"]);
    assert.match(proposals.proposals[0].prompt, /pnpm test/);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 2);
    assert(decisions.decisions.every((decision) => decision.action === "execute"));
    assert(decisions.decisions.every((decision) => decision.execution.operations[0].kind === "run_command"));
    assert(decisions.decisions.every((decision) => decision.execution.operations[0].targetKind === "command"));
    assert.equal(runner.runs.length, 1);
    assert.deepEqual(runner.runs[0].tools, ["bash"]);
    assert.match(runner.runs[0].task.prompt, /pnpm test/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("explicit Ling Agent file request becomes direct workflow instead of discussion reply", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-mentioned-ling-file-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Mentioned Ling Agent execution",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: `@Ling Agent 在 ${cwd} 下创建 login.html`,
      mentions: [{ id: "ling_agent", label: "Ling Agent", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    assert.doesNotMatch(created.aiReply.body, /不能直接修改工作区|cannot directly modify/i);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.equal(proposals.proposals[0].linkedWorkflowId, created.autoStartedWorkflow.workflow.id);
    assert.deepEqual(proposals.proposals[0].requiredTools, ["write"]);
    assert.match(proposals.proposals[0].prompt, /login\.html/);
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(routeDecisions.decisions, []);
    const intentDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(intentDecisions.decisions.some((decision) => decision.action === "execute" && /Bounded executable request/.test(decision.reason)), true);
    assert.equal(runner.runs.length, 1);
    assert.deepEqual(runner.runs[0].tools, ["write"]);
    assert.match(runner.runs[0].task.prompt, /login\.html/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace follow-up can create the single file named by the previous Ling Agent reply", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-followup-file-"));
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
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Follow-up execution",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const previousUser = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        kind: "message",
        intent: "discuss",
        authorType: "local-user",
        body: "帮我写一个登录页面",
      },
      "2026-06-12T09:00:00.000Z",
    );
    appendChannelItemFixture(store,
      {
        channelId: channel.id,
        threadId: previousUser.threadId,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: "你可以先在工作区新建一个文件：`login.html`，然后把代码粘进去。",
        status: "ready",
      },
      "2026-06-12T09:01:00.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "可以直接在工作区帮我做好吗？",
      mentions: [{ id: "ling_agent", label: "Ling Agent", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    assert.doesNotMatch(created.aiReply.body, /不能直接修改工作区|没有被授权执行工作区写入/i);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.deepEqual(proposals.proposals[0].requiredTools, ["write"]);
    assert.match(proposals.proposals[0].prompt, /Target: login\.html/);
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].task.prompt, /login\.html/);
    assert.match(runner.runs[0].task.prompt, /Requested objective from recent same-thread\/channel objective/);
    assert.match(runner.runs[0].task.prompt, /帮我写一个登录页面/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("thread follow-up can create the single file named by the previous Ling Agent reply", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-thread-followup-file-"));
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
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Thread follow-up execution",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const previousUser = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        kind: "message",
        intent: "discuss",
        authorType: "local-user",
        body: "帮我做一个打飞机小游戏",
      },
      "2026-06-12T09:00:00.000Z",
    );
    appendChannelItemFixture(store,
      {
        channelId: channel.id,
        threadId: previousUser.threadId,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: [
          "如果确认，可以在工作区创建 `index.html`。",
          "",
          "```html",
          "<!doctype html>",
          "<html><body><canvas id=\"game\"></canvas><script>const gameReady = true;</script></body></html>",
          "```",
        ].join("\n"),
        status: "ready",
      },
      "2026-06-12T09:01:00.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      surface: { kind: "topic", anchorItemId: previousUser.id },
      body: "你不可以直接帮我写到里面吗？",
      mentions: [{ id: "ling_agent", label: "Ling Agent", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    assertCoordinatorWorkflowStartReply(created, previousUser.id);
    assert.notEqual(created.message.threadId, previousUser.id);
    assert.equal(store.getLingThread(created.message.threadId)?.anchorItemId, previousUser.id);
    assert.equal(created.aiReply.threadId, created.message.threadId);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    assert.doesNotMatch(created.aiReply.body, /不能直接修改工作区|cannot directly modify|没有被授权执行工作区写入/i);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.deepEqual(proposals.proposals[0].requiredTools, ["write"]);
    assert.match(proposals.proposals[0].prompt, /Target: index\.html/);
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(routeDecisions.decisions, []);
    const intentDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(intentDecisions.decisions.some((decision) => decision.action === "execute" && /Bounded executable request/.test(decision.reason)), true);
    assert.equal(runner.runs.length, 1);
    assert.deepEqual(runner.runs[0].tools, ["write"]);
    assert.match(runner.runs[0].task.prompt, /Target: index\.html/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("thread follow-up opens the recent HTML target with the dedicated Host capability", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-thread-followup-browser-open-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    desktopBridgeToken: "deterministic-open-host-token",
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  }, withRestrictedCommandReadiness({ defaultWorkspaceCwd: cwd }));
  try {
    await publishHostOpenAvailability(daemon.url, "deterministic-open-host-token");
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Thread browser open execution",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "bash", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const previousUser = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        kind: "message",
        intent: "discuss",
        authorType: "local-user",
        body: "帮我做一个打飞机小游戏",
      },
      "2026-06-12T09:00:00.000Z",
    );
    appendChannelItemFixture(store,
      {
        channelId: channel.id,
        threadId: previousUser.threadId,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: "已创建文件：`index.html`。",
        status: "ready",
      },
      "2026-06-12T09:01:00.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      surface: { kind: "topic", anchorItemId: previousUser.id },
      body: "可以直接帮我浏览器打开吗？",
      mentions: [{ id: "ling_agent", label: "Ling Agent", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    assertCoordinatorWorkflowStartReply(created, previousUser.id);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.deepEqual(proposals.proposals[0].requiredTools, []);
    assert.match(proposals.proposals[0].prompt, /dedicated Ling Host preview capability/);
    assert.doesNotMatch(proposals.proposals[0].prompt, /Create index\.html|declared file tool scope/);
    assert.equal(runner.runs.length, 1);
    assert.deepEqual(runner.runs[0].tools, []);
    assert.deepEqual(runner.runs[0].hostCapabilityTools?.map((tool) => tool.name), ["host_open_local_target"]);
    assert.match(runner.runs[0].task.prompt, /Target: index\.html/);
    assert.match(runner.runs[0].task.prompt, /Do not recreate or edit the file/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("model-assisted thread follow-up opens recent target from typed operation kind", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-thread-model-followup-open-"));
  let previousReply;
  const runner = new ScriptedRunner([
    () => JSON.stringify({
      action: "execute",
      reason: "User wants to preview the recent local artifact.",
      execution: { schemaVersion: 2, operations: [fileOperationCandidate({ id: "open_target", kind: "open_local_target",
        sourceQuote: "可以直接帮我展示一下这个成果吗？", path: "index.html", targetSourceItemId: previousReply.id })] },
    }),
    "Opened local target.",
  ]);
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    desktopBridgeToken: "typed-open-host-token",
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  }, withRestrictedCommandReadiness({ defaultWorkspaceCwd: cwd, channels: { intentSelector: true } }));
  try {
    await publishHostOpenAvailability(daemon.url, "typed-open-host-token");
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Model typed local target open",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "bash", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const previousUser = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        kind: "message",
        intent: "discuss",
        authorType: "local-user",
        body: "帮我做一个打飞机小游戏",
      },
      "2026-06-12T09:00:00.000Z",
    );
    previousReply = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        threadId: previousUser.threadId,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: "已创建文件：`index.html`。",
        status: "ready",
      },
      "2026-06-12T09:01:00.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      surface: { kind: "topic", anchorItemId: previousUser.id },
      body: "可以直接帮我展示一下这个成果吗？",
    });

    assertCoordinatorWorkflowStartReply(created, previousUser.id);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.deepEqual(proposals.proposals[0].requiredTools, []);
    assert.match(proposals.proposals[0].prompt, /open_target: open_local_target \(index\.html\)/);
    assert.doesNotMatch(proposals.proposals[0].prompt, /file_create|file_edit/);
    const intentDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(intentDecisions.decisions.some((decision) =>
      decision.action === "execute" &&
      decision.createdBy === "model_policy" &&
      decision.execution?.operations[0]?.kind === "open_local_target"
    ), true);
    assert.equal(runner.runs.length, 2);
    assert.match(runner.runs[0].systemPrompt, /channel intent selector/i);
    assert.deepEqual(runner.runs[1].tools, []);
    assert.deepEqual(runner.runs[1].hostCapabilityTools?.map((tool) => tool.name), ["host_open_local_target"]);
    assert.match(runner.runs[1].task.prompt, /open_target: open_local_target -> index\.html/);
    assert.match(runner.runs[1].task.prompt, /Execute only the operations owned by this step/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("model-assisted thread follow-up writes the recent local target without phrase-rule matching", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-thread-model-followup-file-"));
  let previousReply;
  const content = "<!doctype html>\n<html><body><canvas id=\"game\"></canvas><script>const gameReady = true;</script></body></html>";
  const daemon = await startRealPiChannelFixture(cwd, (request) => {
    if (/channel intent selector/i.test(systemText(request))) return { text: JSON.stringify({
      action: "execute",
      reason: "User is asking Ling to write the previously discussed file locally.",
      execution: { schemaVersion: 2, operations: [fileOperationCandidate({ id: "create_file",
        sourceQuote: "你现在可以帮我写在本地里面了吗？", path: "index.html", targetSourceItemId: previousReply.id,
        contentSource: { kind: "literal", text: content, sourceQuote: content, sourceItemId: previousReply.id } })] },
    }) };
    if (!request.messages.some((message) => message.role === "tool")) return { tool: "write", input: { path: "index.html", content } };
    return { text: "Created local file: index.html." };
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, daemon.providerOverrides)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Model thread follow-up execution",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;
    const store = daemon.store;
    assert.ok(store);
    const previousUser = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        kind: "message",
        intent: "discuss",
        authorType: "local-user",
        body: "先记一下以后可能要落地文件",
      },
      "2026-06-12T09:00:00.000Z",
    );
    previousReply = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        threadId: previousUser.threadId,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: [
          "如果确认，可以在工作区创建 `index.html`：",
          "```html",
          "<!doctype html>",
          "<html><body><canvas id=\"game\"></canvas><script>const gameReady = true;</script></body></html>",
          "```",
        ].join("\n"),
        status: "ready",
      },
      "2026-06-12T09:01:00.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      surface: { kind: "topic", anchorItemId: previousUser.id },
      body: "你现在可以帮我写在本地里面了吗？",
    });

    assert.ok(created.aiReply, JSON.stringify({ created, decisions: store.listChannelIntentDecisions({ channelId: channel.id, limit: 10 }) }));
    assertCoordinatorWorkflowStartReply(created, previousUser.id);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    assert.doesNotMatch(created.aiReply.body, /不能直接修改工作区|cannot directly modify|没有被授权执行工作区写入/i);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.equal(proposals.proposals[0].linkedWorkflowId, created.autoStartedWorkflow.workflow.id);
    assert.deepEqual(proposals.proposals[0].requiredTools, ["write"]);
    assert.match(proposals.proposals[0].prompt, /create_file: file_create \(index\.html\)/);
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(routeDecisions.decisions, []);
    const intentDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(intentDecisions.decisions.some((decision) =>
      decision.action === "execute" &&
      decision.createdBy === "model_policy" &&
      decision.execution?.operations[0]?.kind === "file_create"
    ), true);
    const createOperation = intentDecisions.decisions.find((decision) => decision.createdBy === "model_policy").execution.operations[0];
    assert.equal(createOperation.binding.contentSource.kind, "literal");
    assert.equal(createOperation.binding.contentSource.text, content);
    assert.deepEqual(createOperation.binding.contentSource.sourceRefs.map((ref) => ref.itemId), [previousReply.id]);
    const { runs } = await daemon.assertWorkflowCompleted(created, { files: [{ path: "index.html", content }],
      actionTypes: ["write"], participantIds: ["ling_agent"] });
    assert.equal(daemon.selectorRequests.length, 1);
    assert.match(systemText(daemon.selectorRequests[0]), /channel intent selector/i);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].requestSnapshot.tools, ["write"]);
    assert.match(runs[0].taskSnapshot.prompt, /create_file: file_create -> index\.html/);
    assert.match(runs[0].taskSnapshot.prompt, /"kind":"literal"/);
    assert.match(runs[0].taskSnapshot.prompt, /gameReady = true/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("model-assisted create-and-run materializes ordered write and Node operations", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-model-create-run-"));
  const runner = new ScriptedRunner([
    JSON.stringify({
      action: "execute",
      reason: "User explicitly requested a file write followed by a Node verification.",
      execution: {
        schemaVersion: 2,
        operations: [
          fileOperationCandidate({ id: "create_file", sourceQuote: "创建 app.js，内容是 console.log('ok')", path: "app.js",
            contentSource: { kind: "literal", text: "console.log('ok')", sourceQuote: "console.log('ok')" } }),
          commandOperationCandidate({ sourceQuote: "然后运行 node app.js 验证。", command: "node app.js", dependsOn: ["create_file"] }),
        ],
      },
    }),
    "Created and ran app.js.",
  ]);
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  }, withRestrictedCommandReadiness({ channels: { intentSelector: true } }));
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Model create and run",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "write", "bash"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "创建 app.js，内容是 console.log('ok')，然后运行 node app.js 验证。",
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    const store = stores.get(cwd);
    assert.ok(store);
    const sourceItem = store.getConversationItem(created.message.id);
    assert.ok(sourceItem?.turnId);
    assert.equal(created.autoStartedWorkflow.workflow.metadata.sourceTurnId, sourceItem.turnId);
    const [step] = created.autoStartedWorkflow.workflowSteps;
    assert.deepEqual(step.metadata.requiredTools, ["write", "bash"]);
    assert.deepEqual(step.metadata.executionOperationIds, ["create_file", "run_command"]);
    assert.deepEqual(step.metadata.executionPlan.operations.map((operation) => ({
      id: operation.id,
      kind: operation.kind,
      dependsOn: operation.dependsOn,
      label: operation.targetRef?.label,
      commandMatchPolicy: operation.commandMatchPolicy,
    })), [
      { id: "create_file", kind: "file_create", dependsOn: [], label: "app.js", commandMatchPolicy: undefined },
      {
        id: "run_command",
        kind: "run_command",
        dependsOn: ["create_file"],
        label: "node app.js",
        commandMatchPolicy: { kind: "exact_command", command: "node app.js" },
      },
    ]);
    assert.deepEqual(runner.runs[1].tools, ["write", "bash"]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("model-assisted multi-agent file verification binds an actual QA read when no command is supplied", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-model-multi-agent-file-verify-"));
  const daemon = await startRealPiChannelFixture(cwd, (request) => {
    if (/channel intent selector/i.test(systemText(request))) return { text: JSON.stringify({
      action: "execute",
      reason: "Engineer writes the file and QA verifies its literal content.",
      execution: {
        schemaVersion: 2,
        operations: [
          fileOperationCandidate({ id: "create_file", path: "proof.txt",
            sourceQuote: "@Engineer @QA 请协作创建 proof.txt，内容为 model-multi-agent-ok；QA 必须在 Engineer 完成后验证文件内容。",
            owner: { participantId: "teammate_builtin_engineer", sourceQuote: "Engineer" },
            contentSource: { kind: "literal", text: "model-multi-agent-ok", sourceQuote: "model-multi-agent-ok" } }),
          fileOperationCandidate({ id: "verify_target", kind: "file_read", path: "proof.txt", dependsOn: ["create_file"],
            sourceQuote: "@Engineer @QA 请协作创建 proof.txt，内容为 model-multi-agent-ok；QA 必须在 Engineer 完成后验证文件内容。",
            owner: { participantId: "teammate_builtin_qa", sourceQuote: "QA" } }),
        ],
      },
    }) };
    const isWriter = request.tools.some((tool) => tool.function.name === "write");
    const toolResult = request.messages.find((message) => message.role === "tool");
    if (!toolResult) return isWriter
      ? { tool: "write", input: { path: "proof.txt", content: "model-multi-agent-ok" } }
      : { tool: "read", input: { path: "proof.txt" } };
    if (!isWriter) assert.equal(messageText(toolResult), "model-multi-agent-ok", "QA must receive the actual file bytes");
    return { text: isWriter ? "Engineer completed proof.txt." : "QA read proof.txt and verified model-multi-agent-ok." };
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, daemon.providerOverrides)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Model multi-agent file verification",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "write", "bash"],
    })).channel;
    for (const teammateId of ["teammate_builtin_engineer", "teammate_builtin_qa"]) {
      await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
        providerPresetId: provider.id,
      });
      await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
        memberships: [{ channelId: channel.id }],
      });
    }

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Engineer @QA 请协作创建 proof.txt，内容为 model-multi-agent-ok；QA 必须在 Engineer 完成后验证文件内容。",
      mentions: [
        { id: "teammate_builtin_engineer", label: "Engineer", kind: "ai-teammate" },
        { id: "teammate_builtin_qa", label: "QA", kind: "ai-teammate" },
      ],
      requestAiReply: true,
    });

    assertCoordinatorWorkflowStartReply(created);
    const store = daemon.store;
    assert.ok(store);
    const decision = store.listChannelIntentDecisions({ sourceItemId: created.message.id, limit: 20 })
      .find((candidate) => candidate.action === "execute");
    assert.ok(decision);
    const verificationOperation = decision.execution?.operations.find((operation) => operation.id === "verify_target");
    assert.equal(verificationOperation?.kind, "file_read");
    assert.equal(verificationOperation?.commandMatchPolicy, undefined);
    assert.equal(verificationOperation?.binding.ownerParticipantId, "teammate_builtin_qa");
    assert.deepEqual(verificationOperation?.binding.inputRefs.map((ref) => ref.path), ["proof.txt"]);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 2);
    assert.deepEqual(created.autoStartedWorkflow.workflowSteps.map((step) => step.metadata.executionOperationIds), [["create_file"], ["verify_target"]]);
    const { runs, actions } = await daemon.assertWorkflowCompleted(created, {
      files: [{ path: "proof.txt", content: "model-multi-agent-ok" }], actionTypes: ["write", "read"],
      participantIds: ["teammate_builtin_engineer", "teammate_builtin_qa"],
    });
    assert.deepEqual(runs.map((run) => run.requestSnapshot.tools), [["write"], ["read"]]);
    assert.deepEqual(actions.map((action) => action.participantId), ["teammate_builtin_engineer", "teammate_builtin_qa"]);
    assert.equal(store.getAiTeammate("teammate_builtin_qa").allowedTools.includes("write"), false);
    assert.equal(runs[0].requestSnapshot.workflowOperationExecution.plan.fingerprint, runs[1].requestSnapshot.workflowOperationExecution.plan.fingerprint);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("model-assisted natural-language Node work materializes executable evidence policy", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-model-node-executable-"));
  const runner = new ScriptedRunner([
    JSON.stringify({
      action: "execute",
      reason: "User requested a file write followed by a Node invocation.",
      execution: {
        schemaVersion: 2,
        operations: [
          fileOperationCandidate({ id: "create_file", path: "continuity-v2-proof.js",
            sourceQuote: "创建 continuity-v2-proof.js，内容是导出 formatProof",
            contentSource: { kind: "generated_objective", text: "导出 formatProof", sourceQuote: "导出 formatProof", inputOperationIds: [] } }),
          { ...commandOperationCandidate({ sourceQuote: "然后运行 Node 调用 formatProof(\"7319\") 验证。", dependsOn: ["create_file"] }),
            commandGoal: { kind: "node_function", module: { path: "continuity-v2-proof.js", sourceQuote: "continuity-v2-proof.js" },
              invocation: 'formatProof("7319")', sourceQuote: 'formatProof("7319")' } },
        ],
      },
    }),
    "Created and invoked the proof function.",
  ]);
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  }, withRestrictedCommandReadiness({ channels: { intentSelector: true } }));
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Natural Node invocation",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "write", "bash"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "创建 continuity-v2-proof.js，内容是导出 formatProof，然后运行 Node 调用 formatProof(\"7319\") 验证。",
    });

    assertCoordinatorWorkflowStartReply(created);
    const store = stores.get(cwd);
    assert.ok(store);
    const decision = store.listChannelIntentDecisions({ sourceItemId: created.message.id, limit: 10 })
      .find((candidate) => candidate.action === "execute");
    assert.ok(decision?.execution);
    const commandOperation = decision.execution.operations.find((operation) => operation.id === "run_command");
    assert.equal(commandOperation?.commandMatchPolicy?.kind, "exact_command");
    assert.equal(commandOperation?.binding?.commandGoal?.modulePath, "continuity-v2-proof.js");
    assert.equal(commandOperation?.binding?.commandGoal?.invocation, 'formatProof("7319")');
    assert.deepEqual(commandOperation?.binding?.effectScope.readPaths, ["continuity-v2-proof.js"]);
    assert.deepEqual(commandOperation?.dependsOn, ["create_file"]);
    assert.equal(commandOperation?.targetRef?.label, 'continuity-v2-proof.js → formatProof("7319")');
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("partial existing proposal lineage becomes one durable blocker without participant reselection", async () => {
  for (const scenario of [
    {
      name: "single-step",
      body: "创建 orphan-proof.js，内容是 console.log('proof')。",
      requiredTools: ["write"],
    },
    {
      name: "multi-participant",
      body: "请让 Engineer 和 QA 一起实现并测试这个功能。",
      requiredTools: ["read"],
    },
  ]) {
    const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), `ling-stack-channel-partial-proposal-${scenario.name}-`));
    const store = createSqliteRunStore(cwd);
    try {
      const { channel, message } = createStoreChannelAndMessage(store, cwd, scenario.body);
      const proposal = store.createChannelExecutionProposal({
        channelId: channel.id,
        sourceMessageId: message.id,
        proposedByTeammateId: "ling_agent",
        title: `Partial ${scenario.name} proposal`,
        prompt: scenario.body,
        assigneeTeammateId: "ling_agent",
        requiredTools: scenario.requiredTools,
        riskSummary: "Simulated crash after proposal persistence and before decision persistence.",
        status: "draft",
      }, "2026-08-16T11:00:00.000Z");

      const first = await selectChannelWorkflowIntent({
        store,
        channel,
        sourceMessage: message,
        secretResolver: createCompositeSecretResolver({ env: {} }),
      });

      assert.equal(first.action, "blocked");
      assert.equal(first.proposalId, proposal.id);
      assert.equal(first.errorCode, "existing_proposal_participant_lineage_invalid");
      assert.equal(first.aiReply.status, "blocked");
      assert.equal(first.aiReply.errorMessage, `existing_proposal_participant_lineage_invalid:${proposal.id}`);
      assert.equal(store.listChannelIntentDecisions({ sourceItemId: message.id, limit: 20 }).length, 0);
      assert.equal(store.listChannelWorkflows({ channelId: channel.id, limit: 20 }).length, 0);
      assert.equal(store.listRuns({ channelId: channel.id, limit: 20 }).length, 0);

      const repeated = await selectChannelWorkflowIntent({
        store,
        channel,
        sourceMessage: message,
        secretResolver: createCompositeSecretResolver({ env: {} }),
      });
      assert.equal(repeated.action, "blocked");
      assert.equal(repeated.aiReply.id, first.aiReply.id);
      assert.equal(
        store.listConversationItemsForTurn({ turnId: store.getConversationItem(message.id).turnId })
          .filter((item) => item.kind === "assistant_message" && item.payload.deliveryStatus === "blocked").length,
        1,
      );
    } finally {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("partial existing proposal lineage is blocked consistently over JSON and SSE dispatch", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-partial-proposal-transport-"));
  const runner = new RecordingRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      const appendConversationUserTurn = store.appendConversationUserTurn.bind(store);
      store.appendConversationUserTurn = (input, now) => {
        const accepted = appendConversationUserTurn(input, now);
        const existing = store.listChannelExecutionProposals({
          channelId: input.channelId,
          sourceMessageId: accepted.item.id,
          limit: 1,
        })[0];
        if (!existing && input.userInstruction.includes("orphan-transport")) {
          store.createChannelExecutionProposal({
            channelId: input.channelId,
            sourceMessageId: accepted.item.id,
            proposedByTeammateId: "ling_agent",
            title: "Injected partial proposal lineage",
            prompt: input.userInstruction,
            assigneeTeammateId: "ling_agent",
            requiredTools: ["write"],
            riskSummary: "Injected between accepted-turn commit and selector dispatch.",
            status: "draft",
          }, now);
        }
        return accepted;
      };
      stores.set(storeCwd, store);
      return store;
    },
  });
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Partial proposal transport",
      status: "active",
      boundPath: cwd,
      allowedTools: ["read", "write"],
    })).channel;
    const requestBody = {
      body: "创建 orphan-transport-json.js，内容是 console.log('proof')。",
      requestAiReply: true,
      idempotencyKey: "partial-proposal-json",
    };

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, requestBody);
    assert.equal(created.aiReply.status, "blocked");
    assert.match(created.aiReply.errorMessage, /^existing_proposal_participant_lineage_invalid:proposal_/);
    const replay = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, requestBody);
    assert.equal(replay.message.id, created.message.id);
    assert.equal(replay.aiReply.id, created.aiReply.id);

    const sseResponse = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "创建 orphan-transport-sse.js，内容是 console.log('proof')。",
        requestAiReply: true,
        idempotencyKey: "partial-proposal-sse",
      }),
    });
    assert.equal(sseResponse.status, 200);
    const events = parseSseEvents(await sseResponse.text());
    assert.equal(events[0].event, "ready");
    assert.equal(events.at(-1).event, "blocked");
    assert.equal(events.some((event) => event.event === "error"), false);
    assert.match(events.at(-1).data.aiReply.errorMessage, /^existing_proposal_participant_lineage_invalid:proposal_/);

    const store = stores.get(cwd);
    assert.ok(store);
    for (const sourceMessageId of [created.message.id, events[0].data.message.id]) {
      const sourceItem = store.getConversationItem(sourceMessageId);
      assert.ok(sourceItem?.turnId);
      assert.equal(store.getLingTurn(sourceItem.turnId).status, "blocked");
      const dispatch = store.findWorkUnitByIdempotency({
        kind: "channel_turn_dispatch",
        ownerType: "ling_turn",
        ownerId: sourceItem.turnId,
        idempotencyKey: `channel-turn-dispatch:${sourceItem.turnId}`,
      });
      assert.equal(dispatch.status, "succeeded");
      assert.equal(store.listConversationItemsForTurn({ turnId: sourceItem.turnId })
        .filter((item) => item.kind === "assistant_message" && item.payload.deliveryStatus === "blocked").length, 1);
      assert.equal(store.listChannelIntentDecisions({ sourceItemId: sourceMessageId, limit: 20 }).length, 0);
    }
    assert.equal(store.listChannelWorkflows({ channelId: channel.id, limit: 20 }).length, 0);
    assert.equal(store.listRuns({ channelId: channel.id, limit: 20 }).length, 0);
    assert.equal(runner.runs.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("explicit custom executable participant is preserved ahead of same-role fallback", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-explicit-participant-preservation-"));
  const command = `node -e "process.stdout.write('proof:7319')"`;
  const systemPrompt = "PROMISEBOT_BASE_PROFILE_MARKER: return the configured participant behavior.";
  const appendSystemPrompt = "PROMISEBOT_APPEND_PROFILE_MARKER: preserve the delegated participant profile.";
  const approvalProfile = {
    mode: "standard",
    risk: "high",
    requiredForTools: ["bash"],
    requiredForActions: ["git_push"],
  };
  const runner = new DelayedCommandEvidenceRunner(command);
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  }, withRestrictedCommandReadiness({ channels: { intentSelector: true, terminalReports: true } }));
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const builtInEngineerId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(builtInEngineerId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
      allowedTools: ["read", "bash"],
    });
    const customEngineer = (await postJson(`${daemon.url}/teammates?cwd=${encodeURIComponent(cwd)}`, {
      roleKey: "engineer",
      displayName: "PromiseBot",
      description: "Runs the explicitly assigned verification command.",
      providerPresetId: provider.id,
      systemPrompt,
      appendSystemPrompt: [appendSystemPrompt],
      allowedTools: ["read", "bash"],
      approvalProfile,
      status: "active",
    })).teammate;
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Explicit participant preservation",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: builtInEngineerId,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "bash"],
    })).channel;
    for (const teammateId of [builtInEngineerId, customEngineer.id]) {
      await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
        memberships: [{ channelId: channel.id }],
      });
    }

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: `；@PromiseBot 运行 \`${command}\` 并验证输出严格等于 proof:7319。`,
      mentions: [
        { id: customEngineer.id, label: customEngineer.displayName, kind: "ai-teammate" },
        { id: customEngineer.id, label: customEngineer.displayName, kind: "ai-teammate" },
      ],
      requestAiReply: true,
    });

    assertCoordinatorWorkflowStartReply(created);
    const store = stores.get(cwd);
    assert.ok(store);
    const sourceItem = store.getConversationItem(created.message.id);
    assert.deepEqual(sourceItem.payload.mentions.map((mention) => mention.id), [customEngineer.id]);
    const workflowId = created.autoStartedWorkflow.workflow.id;
    const decision = store.listChannelIntentDecisions({ sourceItemId: sourceItem.id, limit: 20 })
      .find((candidate) => candidate.workflowId === workflowId);
    assert.ok(decision);
    assert.deepEqual(decision.participantManifest.participants.map((participant) => participant.participantId), [customEngineer.id]);
    assert.deepEqual(decision.selectedTeammateIds, [customEngineer.id]);
    const proposal = store.listChannelExecutionProposals({
      channelId: channel.id,
      sourceMessageId: sourceItem.id,
      limit: 20,
    })[0];
    assert.ok(proposal);
    assert.equal(proposal.assigneeTeammateId, customEngineer.id);
    assert.deepEqual(proposal.collaborationSteps.map((step) => step.teammateId), [customEngineer.id]);
    assert.deepEqual(
      created.autoStartedWorkflow.workflow.metadata.requiredParticipantManifest.participants
        .map((participant) => participant.participantId),
      [customEngineer.id],
    );
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    const [step] = created.autoStartedWorkflow.workflowSteps;
    assert.equal(step.toParticipantId, customEngineer.id);
    assert.equal(step.participantAuthority.kind, "channel_selection");
    assert.equal(step.participantAuthority.origin, "channel_intent_proposal");
    assert.equal(step.participantAuthority.sourceId, proposal.id);
    assert.equal(step.participantAuthority.participantId, customEngineer.id);
    assert.deepEqual(step.metadata.providerBinding, {
      schemaVersion: 1,
      participantId: customEngineer.id,
      bindingMode: "fixed",
      source: "teammate_fixed",
      providerPresetId: provider.id,
    });
    assert.equal(step.metadata.delegatedRequirement.participantId, customEngineer.id);
    await waitForCondition(() => runner.executionRuns.length === 1, "explicit custom participant execution run to start");
    const executionRun = runner.executionRuns[0];
    assert.equal(executionRun.systemPrompt, systemPrompt);
    assert.equal(executionRun.appendSystemPrompt.includes(appendSystemPrompt), true);
    assert.equal(executionRun.appendSystemPrompt.filter((prompt) => prompt.startsWith("Ling conversation response style v1:")).length, 1);
    assert.deepEqual(executionRun.tools, ["bash"]);
    const run = store.getRun(store.getChannelWorkflowStep(step.id).runId);
    assert.equal(run.teammateId, customEngineer.id);
    assert.equal(run.requestSnapshot.systemPrompt, systemPrompt);
    assert.equal(run.requestSnapshot.appendSystemPrompt.includes(appendSystemPrompt), true);
    assert.deepEqual(run.requestSnapshot.approvalProfile, approvalProfile);
    assert.deepEqual(run.requestSnapshot.tools, ["bash"]);
    assert.deepEqual(run.requestSnapshot.providerBinding, step.metadata.providerBinding);
    assert.equal(JSON.stringify({ decision, proposal, workflow: created.autoStartedWorkflow.workflow, step, run }).includes(builtInEngineerId), false);

    const assigneeOverride = resolveWorkflowParticipantRunProfile({
      store,
      channel: store.getChannel(channel.id),
      step: store.getChannelWorkflowStep(step.id),
      requestedAssigneeTeammateId: builtInEngineerId,
      requiredTools: ["bash"],
    });
    assert.equal(assigneeOverride.kind, "blocked");
    assert.equal(assigneeOverride.code, "workflow_participant_override_forbidden");
    assert.deepEqual(assigneeOverride.missingRequirements, ["assigned_participant"]);

    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(customEngineer.id)}?cwd=${encodeURIComponent(cwd)}`, {
      allowedTools: ["read"],
    });
    const toolShrink = resolveWorkflowParticipantRunProfile({
      store,
      channel: store.getChannel(channel.id),
      step: store.getChannelWorkflowStep(step.id),
      requestedAssigneeTeammateId: customEngineer.id,
      requiredTools: ["bash"],
    });
    assert.equal(toolShrink.kind, "blocked");
    assert.equal(toolShrink.code, "workflow_participant_required_tools_unavailable");
    assert.deepEqual(toolShrink.missingRequirements, ["tool:bash"]);
    assert.equal(runner.executionRuns.length, 1);

    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(customEngineer.id)}?cwd=${encodeURIComponent(cwd)}`, {
      status: "paused",
    });
    const recovered = await selectChannelWorkflowIntent({
      store,
      channel: store.getChannel(channel.id),
      sourceMessage: projectConversationItemToChannelMessage(sourceItem),
      secretResolver: createCompositeSecretResolver({ env: {} }),
    });
    assert.equal(recovered.action, "workflow_proposal");
    assert.equal(recovered.proposal.id, proposal.id);
    assert.equal(recovered.proposal.assigneeTeammateId, customEngineer.id);
    assert.equal(recovered.intentDecisionId, decision.id);
  } finally {
    runner.releaseExecution();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow-definition authority does not require a direct Channel membership row", async (t) => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-workflow-definition-authority-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-08-16T02:00:00.000Z";
    const channel = store.createChannel({
      name: "Workflow authority",
      boundPath: cwd,
      allowedTools: ["read"],
    }, now);
    store.replaceTeammateChannelMemberships("teammate_builtin_engineer", [], now);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Graph-owned participant",
      objective: "Run an assigned graph participant.",
      status: "ready",
      createdBy: "local-user",
    }, now);
    const step = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      title: "Engineer step",
      prompt: "Read the workspace.",
      toParticipantId: "teammate_builtin_engineer",
      toParticipantLabel: "Engineer",
      participantAuthority: createWorkflowParticipantAuthorityV1({
        kind: "workflow_definition",
        origin: "workflow_graph",
        participantId: "teammate_builtin_engineer",
        sourceId: "graph-authority-test",
      }),
      metadata: { requiredTools: ["read"] },
    }, now);
    const resolution = resolveWorkflowParticipantRunProfile({
      store,
      channel,
      step,
      requiredTools: ["read"],
    });
    assert.equal(resolution.kind, "ready");
    assert.equal(resolution.teammateId, "teammate_builtin_engineer");
  } finally {
    store.close();
  }
});

test("proposal provider preflight blocks missing workspace default and freezes configured participant bindings", async (t) => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-workflow-provider-preflight-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-08-17T02:00:00.000Z";
    const channel = store.createChannel({
      name: "Provider preflight",
      boundPath: cwd,
      defaultProviderPresetId: "provider_channel_ling_agent",
      allowedTools: ["read"],
    }, now);
    for (const teammateId of ["teammate_builtin_engineer", "teammate_builtin_qa"]) {
      store.replaceTeammateChannelMemberships(teammateId, [{ channelId: channel.id }], now);
    }
    const thread = store.resolveOrCreateConversationThread({
      surfaceKind: "channel_root",
      channelId: channel.id,
      title: "Engineer and QA",
      objective: "Engineer implements and QA verifies.",
    }, now).thread;
    const accepted = store.appendConversationUserTurn({
      channelId: channel.id,
      threadId: thread.id,
      title: "Engineer and QA",
      userInstruction: "Engineer and QA",
      payload: { body: "Engineer and QA", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
      idempotencyKey: "workflow-provider-preflight",
    }, now);
    const manifest = createRequiredParticipantManifestV1([
      {
        participantId: "teammate_builtin_engineer",
        role: "engineer",
        requirement: "required",
        expectedOutcome: "execution",
        requiredOperationIds: [],
        requestedBy: "structured_mention",
      },
      {
        participantId: "teammate_builtin_qa",
        role: "qa",
        requirement: "required",
        expectedOutcome: "verification",
        requiredOperationIds: [],
        requestedBy: "structured_mention",
      },
    ]);
    const proposal = store.createChannelExecutionProposal({
      channelId: channel.id,
      sourceMessageId: accepted.item.id,
      proposedByTeammateId: "ling_agent",
      title: "Engineer and QA",
      prompt: "Engineer and QA",
      assigneeTeammateId: "teammate_builtin_engineer",
      collaborationSteps: [
        { teammateId: "teammate_builtin_engineer", action: "coordinated", summary: "Implement." },
        { teammateId: "teammate_builtin_qa", action: "reviewed", summary: "Verify." },
      ],
      status: "draft",
    }, now);
    store.createChannelIntentDecision({
      channelId: channel.id,
      sourceItemId: accepted.item.id,
      contextProjection: projectionFor(
        accepted.item,
        store.getEffectiveTurnContextAssignment(accepted.turnId),
      ),
      action: "workflow_proposal",
      selectedTeammateIds: ["teammate_builtin_engineer", "teammate_builtin_qa"],
      participantManifest: manifest,
      proposalId: proposal.id,
      reason: "Engineer implements and QA verifies.",
      status: "accepted",
      createdBy: "deterministic",
    }, now);

    let validationCalls = 0;
    assert.throws(() => confirmChannelExecutionProposalWorkflow({
      store,
      cwd,
      proposalId: proposal.id,
      validateRunRequest: () => { validationCalls += 1; },
      now,
    }), /no workspace default is configured/);
    assert.equal(validationCalls, 0);
    const blocked = store.getChannelExecutionProposal(proposal.id);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blocker.code, "workflow_participant_provider_unavailable");
    assert.equal(blocked.blocker.reasonCode, "workspace_default_provider_missing");
    assert.equal(blocked.blocker.owner, "workspace");
    assert.equal(blocked.blocker.repairTarget, "model_workbench");
    assert.equal(blocked.blocker.providerPresetId, undefined);
    assert.equal(store.listChannelWorkflows({ channelId: channel.id, limit: 20 }).length, 0);

    store.updateWorkspaceSettings({ defaultProviderPresetId: "provider_workspace" }, now);
    const validatedProviderIds = [];
    const confirmed = confirmChannelExecutionProposalWorkflow({
      store,
      cwd,
      proposalId: proposal.id,
      validateRunRequest: (request) => { validatedProviderIds.push(request.providerPresetId); },
      now: "2026-08-17T02:01:00.000Z",
    });
    assert.deepEqual(validatedProviderIds, ["provider_workspace", "provider_workspace"]);
    assert.equal(confirmed.proposal.status, "accepted");
    assert.equal(confirmed.proposal.blocker, undefined);
    assert.equal(confirmed.proposal.errorMessage, undefined);
    assert.deepEqual(confirmed.workflowSteps.map((step) => step.metadata.providerBinding), [
      {
        schemaVersion: 1,
        participantId: "teammate_builtin_engineer",
        bindingMode: "workspace_default",
        source: "workspace_default",
        providerPresetId: "provider_workspace",
      },
      {
        schemaVersion: 1,
        participantId: "teammate_builtin_qa",
        bindingMode: "workspace_default",
        source: "workspace_default",
        providerPresetId: "provider_workspace",
      },
    ]);
    assert.deepEqual(confirmed.workflowSteps.map((step) => step.metadata.providerPresetId), [
      "provider_workspace",
      "provider_workspace",
    ]);

    const engineerStep = confirmed.workflowSteps[0];
    const engineer = store.getAiTeammate(engineerStep.toParticipantId);
    assert.ok(engineer);
    store.updateWorkspaceSettings({ defaultProviderPresetId: "provider_workspace_repaired" }, "2026-08-17T02:02:00.000Z");
    const resumedProviderIds = [];
    const resumed = preflightWorkflowParticipantProvider({
      store,
      channel,
      teammate: engineer,
      cwd,
      validateRunRequest: (request) => { resumedProviderIds.push(request.providerPresetId); },
      frozenBinding: engineerStep.metadata.providerBinding,
    });
    assert.equal(resumed.kind, "ready");
    assert.deepEqual(resumedProviderIds, ["provider_workspace"]);
    assert.equal(resumed.binding.providerPresetId, "provider_workspace");

    const unavailable = preflightWorkflowParticipantProvider({
      store,
      channel,
      teammate: engineer,
      cwd,
      validateRunRequest: () => { throw new Error("Provider disabled after proposal confirmation."); },
      frozenBinding: engineerStep.metadata.providerBinding,
    });
    assert.equal(unavailable.kind, "blocked");
    assert.equal(unavailable.blocker.reasonCode, "provider_unavailable");
    assert.equal(unavailable.blocker.providerPresetId, "provider_workspace");
    assert.equal(unavailable.blocker.owner, "workspace");

    const override = await prepareWorkflowStepStart(
      store,
      engineerStep.id,
      { mode: "create_and_run_task", providerPresetId: "provider_workspace_repaired" },
      cwd,
      () => undefined,
    );
    assert.equal(override.kind, "blocked");
    const blockedStep = store.getChannelWorkflowStep(engineerStep.id);
    assert.equal(blockedStep.metadata.delegatedOutcome.kind, "blocked");
    assert.equal(blockedStep.metadata.delegatedOutcome.code, "workflow_participant_provider_override_forbidden");
    assert.equal(blockedStep.taskId, undefined);
    assert.equal(blockedStep.runId, undefined);

    const qaStep = confirmed.workflowSteps[1];
    const {
      providerBinding: _providerBinding,
      dependsOnStepIds: _dependsOnStepIds,
      ...qaMetadataWithoutBinding
    } = qaStep.metadata;
    store.database.prepare("UPDATE channel_workflow_steps SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify(qaMetadataWithoutBinding), qaStep.id);
    const missingBinding = await prepareWorkflowStepStart(
      store,
      qaStep.id,
      { mode: "create_and_run_task" },
      cwd,
      () => undefined,
    );
    assert.equal(missingBinding.kind, "blocked");
    assert.match(missingBinding.blocker, /no valid frozen provider binding/);
    const missingBindingStep = store.getChannelWorkflowStep(qaStep.id);
    assert.equal(missingBindingStep.taskId, undefined);
    assert.equal(missingBindingStep.runId, undefined);
  } finally {
    store.close();
  }
});

test("explicit executable participant missing a required tool blocks without substitution", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-explicit-participant-tool-block-"));
  const command = `node -e "process.stdout.write('proof:7319')"`;
  const runner = new DelayedCommandEvidenceRunner(command);
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  }, { channels: { intentSelector: true } });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const builtInEngineerId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(builtInEngineerId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
      allowedTools: ["read", "bash"],
    });
    const namedEngineer = (await postJson(`${daemon.url}/teammates?cwd=${encodeURIComponent(cwd)}`, {
      roleKey: "engineer",
      displayName: "ReadOnlyBot",
      description: "Explicitly assigned but intentionally lacks bash.",
      providerPresetId: provider.id,
      allowedTools: ["read"],
      approvalProfile: { mode: "none" },
      status: "active",
    })).teammate;
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Explicit participant tool blocker",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: builtInEngineerId,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "bash"],
    })).channel;
    for (const teammateId of [builtInEngineerId, namedEngineer.id]) {
      await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
        memberships: [{ channelId: channel.id }],
      });
    }

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: `；@ReadOnlyBot 运行 \`${command}\` 并验证输出。`,
      mentions: [{ id: namedEngineer.id, label: namedEngineer.displayName, kind: "ai-teammate" }],
      requestAiReply: true,
    });

    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(runner.executionRuns.length, 0);
    const store = stores.get(cwd);
    assert.ok(store);
    const proposal = store.listChannelExecutionProposals({
      channelId: channel.id,
      sourceMessageId: created.message.id,
      limit: 20,
    })[0];
    assert.ok(proposal);
    assert.equal(proposal.status, "blocked");
    assert.equal(proposal.assigneeTeammateId, namedEngineer.id);
    assert.match(proposal.errorMessage, /缺少所需工具[：:]bash|missing required tools?:? bash/iu);
    const decision = store.listChannelIntentDecisions({ sourceItemId: created.message.id, limit: 20 })
      .find((candidate) => candidate.proposalId === proposal.id);
    assert.ok(decision);
    assert.deepEqual(decision.selectedTeammateIds, [namedEngineer.id]);
    assert.deepEqual(decision.participantManifest.participants.map((participant) => participant.participantId), [namedEngineer.id]);
    assert.equal(decision.errorCode, "participant_required_tools_unavailable");
    assert.equal(JSON.stringify({ decision, proposal }).includes(builtInEngineerId), false);
  } finally {
    runner.releaseExecution();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("distinct explicit same-role participants remain separate workflow requirements", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-explicit-same-role-participants-"));
  const runner = new DelayedFileCommandRunner();
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  }, withRestrictedCommandReadiness({ channels: { intentSelector: true } }));
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const participants = [];
    for (const displayName of ["BuilderOne", "BuilderTwo"]) {
      participants.push((await postJson(`${daemon.url}/teammates?cwd=${encodeURIComponent(cwd)}`, {
        roleKey: "engineer",
        displayName,
        description: `${displayName} owns one explicitly assigned operation.`,
        providerPresetId: provider.id,
        allowedTools: ["read", "write", "bash"],
        approvalProfile: { mode: "none" },
        status: "active",
      })).teammate);
    }
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Explicit same-role participants",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "write", "bash"],
    })).channel;
    for (const participant of participants) {
      await putJson(`${daemon.url}/teammates/${encodeURIComponent(participant.id)}/channels?cwd=${encodeURIComponent(cwd)}`, {
        memberships: [{ channelId: channel.id }],
      });
    }

    const requestBody = "@BuilderOne @BuilderTwo 创建 participant-proof.js，内容是 console.log('proof')，然后运行 node participant-proof.js 验证。";
    runner.selectorExecution = { schemaVersion: 2, operations: [
      fileOperationCandidate({ id: "create_file", path: "participant-proof.js", sourceQuote: requestBody,
        owner: { participantId: participants[0].id, sourceQuote: "BuilderOne" },
        contentSource: { kind: "literal", text: "console.log('proof')", sourceQuote: "console.log('proof')" } }),
      commandOperationCandidate({ command: "node participant-proof.js", sourceQuote: requestBody, dependsOn: ["create_file"],
        owner: { participantId: participants[1].id, sourceQuote: "BuilderTwo" } }),
    ] };
    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: requestBody,
      mentions: participants.map((participant) => ({
        id: participant.id,
        label: participant.displayName,
        kind: "ai-teammate",
      })),
      requestAiReply: true,
    });

    assertCoordinatorWorkflowStartReply(created);
    const participantIds = participants.map((participant) => participant.id);
    const store = stores.get(cwd);
    assert.ok(store);
    const decision = store.listChannelIntentDecisions({ sourceItemId: created.message.id, limit: 20 })
      .find((candidate) => candidate.workflowId === created.autoStartedWorkflow.workflow.id);
    assert.ok(decision);
    assert.deepEqual(decision.selectedTeammateIds, participantIds);
    assert.deepEqual(decision.participantManifest.participants.map((participant) => participant.participantId), participantIds);
    assert.deepEqual(decision.participantManifest.participants.map((participant) => participant.requestedBy), ["structured_mention", "structured_mention"]);
    assert.deepEqual(decision.participantManifest.participants.map((participant) => participant.requiredOperationIds), [["create_file"], ["run_command"]]);
    const proposal = store.listChannelExecutionProposals({
      channelId: channel.id,
      sourceMessageId: created.message.id,
      limit: 20,
    })[0];
    assert.deepEqual(proposal.collaborationSteps.map((step) => step.teammateId), participantIds);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 2);
    assert.deepEqual(created.autoStartedWorkflow.workflowSteps.map((step) => step.toParticipantId), participantIds);
    assert.deepEqual(created.autoStartedWorkflow.workflowSteps.map((step) => step.metadata.executionOperationIds), [["create_file"], ["run_command"]]);
    await waitForCondition(() => runner.executionRuns.length === 1, "first explicit same-role participant run to start");
  } finally {
    runner.releaseAll();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("multi-participant executable request blocks when one explicit participant owns no required operation", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-explicit-operation-assignment-block-"));
  const command = `node -e "process.stdout.write('proof:7319')"`;
  const runner = new DelayedCommandEvidenceRunner(command);
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  }, { channels: { intentSelector: true } });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const participants = [];
    for (const displayName of ["RunnerOne", "RunnerTwo"]) {
      participants.push((await postJson(`${daemon.url}/teammates?cwd=${encodeURIComponent(cwd)}`, {
        roleKey: "engineer",
        displayName,
        description: `${displayName} is explicitly requested for one command.`,
        providerPresetId: provider.id,
        allowedTools: ["read", "bash"],
        approvalProfile: { mode: "none" },
        status: "active",
      })).teammate);
    }
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Explicit operation assignment blocker",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "bash"],
    })).channel;
    for (const participant of participants) {
      await putJson(`${daemon.url}/teammates/${encodeURIComponent(participant.id)}/channels?cwd=${encodeURIComponent(cwd)}`, {
        memberships: [{ channelId: channel.id }],
      });
    }

    runner.selectorExecution = { schemaVersion: 2, operations: [commandOperationCandidate({ command,
      sourceQuote: `@RunnerOne @RunnerTwo 运行 \`${command}\` 并验证输出。`,
      owner: { participantId: participants[0].id, sourceQuote: "RunnerOne" } })] };
    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: `@RunnerOne @RunnerTwo 运行 \`${command}\` 并验证输出。`,
      mentions: participants.map((participant) => ({
        id: participant.id,
        label: participant.displayName,
        kind: "ai-teammate",
      })),
      requestAiReply: true,
    });

    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(runner.selectorRuns.length, 1, "the operation graph must reach the model intent selector");
    assert.equal(runner.executionRuns.length, 0);
    const store = stores.get(cwd);
    assert.ok(store);
    const proposals = store.listChannelExecutionProposals({
      channelId: channel.id,
      sourceMessageId: created.message.id,
      limit: 20,
    });
    assert.deepEqual(proposals, []);
    const decision = store.listChannelIntentDecisions({ sourceItemId: created.message.id, limit: 20 })
      .find((candidate) => candidate.action === "clarify");
    assert.ok(decision);
    assert.deepEqual(decision.clarification.missingFields, ["participant.operations"]);
    assert.equal(store.listRuns({ channelId: channel.id, limit: 20 }).length, 0);
  } finally {
    runner.releaseExecution();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("single-participant execute acknowledgement stays non-terminal until callback publication settles the source turn", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-single-participant-convergence-"));
  const command = `node -e "process.stdout.write('proof:7319')"`;
  const runner = new DelayedCommandEvidenceRunner(command);
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  }, withRestrictedCommandReadiness({ channels: { intentSelector: true, terminalReports: true } }));
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const engineerId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(engineerId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Single participant convergence",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: engineerId,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "bash"],
    })).channel;
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(engineerId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: `；@Engineer 运行 \`${command}\` 并验证输出严格等于 proof:7319。`,
      requestAiReply: true,
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    const store = stores.get(cwd);
    assert.ok(store);
    const sourceItem = store.getConversationItem(created.message.id);
    assert.ok(sourceItem?.turnId);
    const workflowId = created.autoStartedWorkflow.workflow.id;
    const [step] = created.autoStartedWorkflow.workflowSteps;
    const acceptedDecision = store.listChannelIntentDecisions({ sourceItemId: sourceItem.id, limit: 20 })
      .find((decision) => decision.workflowId === workflowId);
    assert.ok(acceptedDecision);
    assert.deepEqual(acceptedDecision.participantManifest.participants.map((participant) => ({
      participantId: participant.participantId,
      requirement: participant.requirement,
      expectedOutcome: participant.expectedOutcome,
    })), [{
      participantId: engineerId,
      requirement: "required",
      expectedOutcome: "execution",
    }]);
    await waitForCondition(() => runner.executionRuns.length === 1, "single participant execution run to start");
    const runningStep = store.getChannelWorkflowStep(step.id);
    const runningRun = store.getRun(runningStep.runId);
    assert.equal(runningRun.status, "running");
    assert.equal(runningRun.workflowStepId, step.id);
    assert.equal(store.getLingTurn(sourceItem.turnId).status, "running");
    assert.equal(store.getConversationItem(created.aiReply.id).payload.deliveryStatus, "ready");
    assert.deepEqual(store.listTerminalReports({ sourceKind: "workflow", sourceId: workflowId, limit: 20 }), []);

    runner.releaseExecution();
    await waitForCondition(
      () => store.getLingTurn(sourceItem.turnId)?.status === "succeeded",
      "single participant callback publication to settle the source turn",
    );

    const finalRun = store.getRun(runningRun.id);
    const finalStep = store.getChannelWorkflowStep(step.id);
    const finalWorkflow = store.getChannelWorkflow(workflowId);
    const reports = store.listTerminalReports({ sourceKind: "workflow", sourceId: workflowId, limit: 20 });
    assert.equal(finalRun.status, "succeeded");
    assert.equal(finalStep.status, "succeeded");
    assert.equal(finalStep.metadata.delegatedOutcome.kind, "completed");
    assert.equal(finalWorkflow.status, "succeeded");
    assert.equal(finalWorkflow.metadata.completionGate.status, "verified");
    assert.equal(reports.length, 1);
    assert.ok(reports[0].resultItemId);
    assert.equal(store.listConversationItemsForTurn({ turnId: sourceItem.turnId })
      .filter((item) => item.id === reports[0].resultItemId).length, 1);
    assert.equal(store.listStateTransitionEvents({ entityType: "turn", entityId: sourceItem.turnId })
      .filter((event) => event.toStatus === "succeeded").length, 1);
    assert.equal(store.listControlPlaneEvents({
      workspaceId: sourceItem.workspaceId,
      domains: ["work_units"],
      entityType: "terminal_report",
      entityId: reports[0].id,
      action: "terminal_report.published",
      limit: 20,
    }).length, 1);
  } finally {
    runner.releaseExecution();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("model-assisted create-and-run blocks an execute candidate missing its required command", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-model-create-run-command-clarify-"));
  const runner = new ScriptedRunner([
    JSON.stringify({
      action: "execute",
      reason: "User requested a file write and a follow-up run, but supplied no exact command.",
      execution: {
        schemaVersion: 2,
        operations: [
          fileOperationCandidate({ id: "create_file", sourceQuote: "创建 app.js，内容是 console.log('ok')", path: "app.js",
            contentSource: { kind: "literal", text: "console.log('ok')", sourceQuote: "console.log('ok')" } }),
          commandOperationCandidate({ sourceQuote: "然后运行验证。", dependsOn: ["create_file"] }),
        ],
      },
    }),
  ]);
  const daemon = await startDaemonForTest(runner, {}, { channels: { intentSelector: true } });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Model create and run command clarify",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "write", "bash"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "创建 app.js，内容是 console.log('ok')，然后运行验证。",
    });

    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(created.aiReply.status, "blocked");
    assert.equal(created.aiReply.errorMessage, "channel_operation_plan_invalid");
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(proposals.proposals, []);
    await assertInvalidModelPlan(daemon.url, cwd, channel.id, created.message.id, "command");
    assert.equal(runner.runs.length, 2, "one bounded repair before a failed planning diagnostic");
    await assert.rejects(access(resolve(cwd, "app.js")));
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("model-assisted thread follow-up blocks an execute candidate instead of creating empty recent target", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-thread-model-followup-empty-file-"));
  let previousReply;
  const runner = new ScriptedRunner([
    () => JSON.stringify({
      action: "execute",
      reason: "User is asking Ling to write the previously discussed file locally.",
      execution: { schemaVersion: 2, operations: [fileOperationCandidate({ id: "create_file",
        sourceQuote: "你现在可以帮我写在本地里面了吗？", path: "index.html", targetSourceItemId: previousReply.id })] },
    }),
  ]);
  const stores = new Map();
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  }, { channels: { intentSelector: true } });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Model thread follow-up empty target",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const previousUser = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        kind: "message",
        intent: "discuss",
        authorType: "local-user",
        body: "先记一下以后可能要落地文件",
      },
      "2026-06-12T09:00:00.000Z",
    );
    previousReply = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        threadId: previousUser.threadId,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: "如果确认，可以在工作区创建 `index.html`。",
        status: "ready",
      },
      "2026-06-12T09:01:00.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      surface: { kind: "topic", anchorItemId: previousUser.id },
      body: "你现在可以帮我写在本地里面了吗？",
    });

    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(created.aiReply.kind, "ai_reply");
    assert.equal(created.aiReply.status, "blocked");
    assert.equal(created.aiReply.errorMessage, "channel_operation_plan_invalid");
    assert.equal(created.aiReply.authorId, "ling_agent");
    assert.match(created.aiReply.body, /未启动/u);
    assert.doesNotMatch(created.aiReply.body, /contentSource/u);
    await assertInvalidModelPlan(daemon.url, cwd, channel.id, created.message.id, "contentSource");
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(proposals.proposals, []);
    assert.equal(runner.runs.length, 2, "one bounded source-binding repair before a failed planning diagnostic");
    await assert.rejects(access(resolve(cwd, "index.html")));
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("model-assisted local write request blocks an execute candidate when no target validates", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-model-followup-missing-target-"));
  const runner = new ScriptedRunner([
    JSON.stringify({
      action: "execute",
      reason: "User is asking Ling to write something locally.",
      execution: { schemaVersion: 2, operations: [fileOperationCandidate({ id: "create_file",
        sourceQuote: "你现在可以帮我写在本地里面了吗？" })] },
    }),
  ]);
  const daemon = await startDaemonForTest(runner, {}, { channels: { intentSelector: true } });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Model local write clarify",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "你现在可以帮我写在本地里面了吗？",
    });

    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(created.aiReply.kind, "ai_reply");
    assert.equal(created.aiReply.status, "blocked");
    assert.equal(created.aiReply.errorMessage, "channel_operation_plan_invalid");
    assert.equal(created.aiReply.authorId, "ling_agent");
    assert.match(created.aiReply.body, /未启动/u);
    assert.doesNotMatch(created.aiReply.body, /\btarget\b/iu);
    assert.doesNotMatch(created.aiReply.body, /不能直接修改工作区|cannot directly modify|没有被授权执行工作区写入/i);
    assert.equal(runner.runs.length, 2, "one bounded source-binding repair before a failed planning diagnostic");
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(proposals.proposals, []);
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(routeDecisions.decisions, []);
    await assertInvalidModelPlan(daemon.url, cwd, channel.id, created.message.id, "target");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace follow-up clarifies when the previous Ling Agent reply names multiple files", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-followup-file-ambiguous-"));
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
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Ambiguous follow-up execution",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const previousUser = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        kind: "message",
        intent: "discuss",
        authorType: "local-user",
        body: "帮我做一个登录页并补 README",
      },
      "2026-06-12T09:00:00.000Z",
    );
    appendChannelItemFixture(store,
      {
        channelId: channel.id,
        threadId: previousUser.threadId,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: "可以新建 `login.html`，也可以把说明补到 `README.md`。",
        status: "ready",
      },
      "2026-06-12T09:01:00.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "可以直接在工作区帮我做好吗？",
      mentions: [{ id: "ling_agent", label: "Ling Agent", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(created.aiReply.status, "ready");
    assert.match(created.aiReply.body, /多个可能的文件目标/);
    assert.match(created.aiReply.body, /login\.html/);
    assert.match(created.aiReply.body, /README\.md/);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(proposals.proposals, []);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].action, "clarify");
    assert.match(decisions.decisions[0].reason, /multiple file targets/i);
    assert.equal(runner.runs.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("thread follow-up clarifies when the previous Ling Agent reply names multiple files", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-thread-followup-file-ambiguous-"));
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
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Ambiguous thread follow-up execution",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const previousUser = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        kind: "message",
        intent: "discuss",
        authorType: "local-user",
        body: "帮我做一个登录页面和说明文档",
      },
      "2026-06-12T09:00:00.000Z",
    );
    appendChannelItemFixture(store,
      {
        channelId: channel.id,
        threadId: previousUser.threadId,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: "可以新建 `login.html`，也可以把说明补到 `README.md`。",
        status: "ready",
      },
      "2026-06-12T09:01:00.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      surface: { kind: "topic", anchorItemId: previousUser.id },
      body: "你直接帮我写到里面",
      mentions: [{ id: "ling_agent", label: "Ling Agent", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(created.aiReply.status, "ready");
    assert.equal(created.aiReply.threadId, created.message.threadId);
    assert.match(created.aiReply.body, /多个可能的文件目标/);
    assert.match(created.aiReply.body, /login\.html/);
    assert.match(created.aiReply.body, /README\.md/);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(proposals.proposals, []);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].action, "clarify");
    assert.match(decisions.decisions[0].reason, /multiple file targets/i);
    assert.equal(runner.runs.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("text attachment preview can feed a direct README write workflow", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-attachment-readme-preview-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Attachment README execution",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;
    const attachment = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "readme-copy.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("README body from attachment", "utf8").toString("base64"),
    })).attachment;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "把附件内容写进 README.md",
      attachmentIds: [attachment.id],
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    assert.equal(runner.runs.length, 1);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.match(proposals.proposals[0].prompt, /Attachment: readme-copy\.txt/);
    assert.match(proposals.proposals[0].prompt, /README body from attachment/);
    assert.match(runner.runs[0].task.prompt, /README body from attachment/);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.some((decision) => decision.workflowId === created.autoStartedWorkflow.workflow.id && /proposal .*: (?:started|queued)\./u.test(decision.reason)), true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("text attachment materialization cache hit avoids rereading attachment file", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-attachment-cache-hit-"));
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
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Attachment materialization cache hit",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;
    const attachment = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "readme-cache.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("Cached attachment body", "utf8").toString("base64"),
    })).attachment;

    const first = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "把附件内容写进 README.md",
      attachmentIds: [attachment.id],
    });
    assert.equal(first.autoStartedWorkflow.workflowSteps.length, 1);
    assert.equal(runner.runs.length, 1);

    const store = stores.get(cwd);
    assert.ok(store);
    const rows = store.listChannelInputMaterializations({
      channelId: channel.id,
      sourceKind: "attachment",
      sourceId: attachment.id,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].extractorId, "text_attachment_v1");
    assert.equal(rows[0].status, "available");
    assert.equal(rows[0].contentText, "Cached attachment body");

    await rm(resolve(store.paths.attachmentsDir, attachment.path), { force: true });

    const second = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "把附件内容写进 SECOND.md",
      attachmentIds: [attachment.id],
    });
    assert.equal(second.autoStartedWorkflow.workflowSteps.length, 1);
    assert.equal(runner.runs.length, 2);
    assert.match(runner.runs[1].task.prompt, /Cached attachment body/);
    const afterCacheHit = store.listChannelInputMaterializations({
      channelId: channel.id,
      sourceKind: "attachment",
      sourceId: attachment.id,
    });
    assert.equal(afterCacheHit.length, 1);
    assert.equal(afterCacheHit[0].status, "available");
    assert.equal(afterCacheHit[0].contentText, "Cached attachment body");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("attachment-dependent README write blocks when attachment content is not materialized", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-attachment-readme-blocked-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Attachment README blocked",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;
    const oversized = "x".repeat(20 * 1024);
    const attachment = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "large-readme-source.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from(oversized, "utf8").toString("base64"),
    })).attachment;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "把附件内容写进 README.md",
      attachmentIds: [attachment.id],
    });

    assert.equal(created.aiReply, undefined);
    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(runner.runs.length, 0);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "blocked");
    assert.match(proposals.proposals[0].errorMessage, /可读的附件内容|readable attachment content/i);
    assert.doesNotMatch(proposals.proposals[0].errorMessage, /附件预览|attachment preview|too large|previewStatus/i);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].action, "execute");
    assert.match(decisions.decisions[0].reason, /no available attachment preview\/extraction/i);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unreadable screenshot task creates Ling materialization clarify reply", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-screenshot-materialization-clarify-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Screenshot materialization clarify",
      status: "active",
      boundPath: cwd,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "edit"],
    })).channel;
    const attachment = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "screenshot.png",
      contentType: "image/png",
      contentBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
    })).attachment;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "根据这个截图修 UI",
      attachmentIds: [attachment.id],
    });

    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(runner.runs.length, 0);
    assert.match(created.aiReply.body, /没能读取 screenshot\.png|could not read image content/i);
    assert.doesNotMatch(created.aiReply.body, /OCR|视觉提取|metadata_only|extractor|SSRF/i);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 0);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].action, "clarify");
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.match(decisions.decisions[0].reason, /Attachment content is not materialized/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("blocked link body request creates Ling materialization clarify reply", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-link-materialization-clarify-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Link materialization clarify",
      status: "active",
      boundPath: cwd,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls"],
    })).channel;
    const linkPreview = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/link-previews?cwd=${encodeURIComponent(cwd)}`, {
      url: "http://127.0.0.1/private",
    })).linkPreview;
    assert.equal(linkPreview.status, "blocked");

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "Please summarize this link",
      linkPreviewIds: [linkPreview.id],
    });

    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(runner.runs.length, 0);
    assert.match(created.aiReply.body, /local\/private links automatically|本机或私有地址/i);
    assert.doesNotMatch(created.aiReply.body, /body extraction is blocked|SSRF|metadata_only|extractor/i);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].action, "clarify");
    assert.match(decisions.decisions[0].reason, /Link body materialization is blocked/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Ling Agent fallback creates file proposal when no Docs teammate can run", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-ling-agent-fallback-docs-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Ling Agent fallback docs",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: `在 ${cwd} 下创建 README.md`,
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.equal(proposals.proposals[0].linkedWorkflowId, created.autoStartedWorkflow.workflow.id);
    assert.equal(proposals.proposals[0].assigneeTeammateId, "ling_agent");
    assert.equal(proposals.proposals[0].proposedByTeammateId, "ling_agent");
    assert.deepEqual(proposals.proposals[0].collaborationSteps.map((step) => step.teammateId), ["ling_agent"]);
    assert.deepEqual(proposals.proposals[0].requiredTools, ["write"]);
    assert.match(proposals.proposals[0].riskSummary, /Ling Agent 可以先处理这个有边界的任务/);

    assert.equal(created.autoStartedWorkflow.proposal.status, "accepted");
    assert.equal(created.autoStartedWorkflow.workflow.createdBy, "ling_agent");
    assert.equal(created.autoStartedWorkflow.workflowSteps[0].toParticipantId, "ling_agent");
    assert.equal(created.autoStartedWorkflow.workflowSteps[0].toParticipantLabel, "Ling Agent");
    assert.deepEqual(created.autoStartedWorkflow.workflowSteps[0].metadata.requiredTools, ["write"]);
    assert.equal(runner.runs.length, 1);
    assert.deepEqual(runner.runs[0].tools, ["write"]);
    assert.match(runner.runs[0].task.prompt, /Assigned teammate: Ling Agent/);
    assert.match(runner.runs[0].task.prompt, /Confirmed task-scoped tools:\nwrite/);
    const runs = await getJson(`${daemon.url}/runs?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(runs.runs.length, 1);
    assert.equal(runs.runs[0].teammateId, "ling_agent");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Ling Agent fallback edits code proposal when no Engineer teammate can run", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-ling-agent-fallback-engineer-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Ling Agent fallback engineer",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "edit"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: `修改 ${cwd}/src/app.ts，把标题改成 Ling`,
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.equal(proposals.proposals[0].linkedWorkflowId, created.autoStartedWorkflow.workflow.id);
    assert.equal(proposals.proposals[0].assigneeTeammateId, "ling_agent");
    assert.deepEqual(proposals.proposals[0].requiredTools, ["edit"]);
    assert.match(proposals.proposals[0].riskSummary, /Ling Agent 可以先处理这个有边界的任务/);
    assert.match(proposals.proposals[0].riskSummary, /工程师/);

    assert.equal(created.autoStartedWorkflow.workflowSteps[0].toParticipantId, "ling_agent");
    assert.deepEqual(created.autoStartedWorkflow.workflowSteps[0].metadata.requiredTools, ["edit"]);
    assert.equal(runner.runs.length, 1);
    assert.deepEqual(runner.runs[0].tools, ["edit"]);
    assert.match(runner.runs[0].task.prompt, /Assigned teammate: Ling Agent/);
    const runs = await getJson(`${daemon.url}/runs?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(runs.runs.length, 1);
    assert.equal(runs.runs[0].teammateId, "ling_agent");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("single-step file creation blocks when channel lacks the required write tool", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-single-step-file-channel-readonly-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Read only docs",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "teammate_builtin_docs",
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls"],
    })).channel;
    await setWorkspaceDefaultProvider(daemon.url, cwd, channel.defaultProviderPresetId);

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: `在 ${cwd} 下创建 README.md`,
    });

    assert.equal(created.aiReply.status, "blocked");
    assert.doesNotMatch(created.aiReply.body, /Starting now|现在开始处理/u);
    assert.match(created.aiReply.body, /blocked|阻塞/u);
    assert.equal(created.autoStartedWorkflow.orchestration.status, "blocked");
    assert.match(created.autoStartedWorkflow.orchestration.blocker, /channel|tools|write/i);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.equal(proposals.proposals[0].linkedWorkflowId, created.autoStartedWorkflow.workflow.id);
    assert.deepEqual(proposals.proposals[0].requiredTools, ["write"]);
    assert.ok(proposals.proposals[0].errorMessage || created.autoStartedWorkflow.orchestration.blocker);
    assert.match(proposals.proposals[0].riskSummary, /write/);
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(routeDecisions.decisions, []);

    assert.deepEqual(created.autoStartedWorkflow.workflowSteps[0].metadata.requiredTools, ["write"]);
    assert.equal(created.autoStartedWorkflow.workflowSteps[0].metadata.sourceProposalId, proposals.proposals[0].id);
    assert.equal(runner.runs.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("single-step file edit inherits target path from recent workflow context", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-single-step-file-continuation-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Docs edit continuation",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "teammate_builtin_docs",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "write", "edit"],
    })).channel;
    await setWorkspaceDefaultProvider(daemon.url, cwd, channel.defaultProviderPresetId);

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: `在 ${cwd} 下创建 README.md`,
    });
    const createProposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(createProposals.proposals.length, 1);
    assert.equal(createProposals.proposals[0].status, "accepted");

    const edited = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "在 README.md 中添加一句测试语句",
    });

    assertCoordinatorWorkflowStartReply(edited);
    assert.equal(edited.autoStartedWorkflow.workflowSteps.length, 1);
    const editProposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(edited.message.id)}`);
    assert.equal(editProposals.proposals.length, 1);
    assert.equal(editProposals.proposals[0].status, "accepted");
    assert.equal(editProposals.proposals[0].linkedWorkflowId, edited.autoStartedWorkflow.workflow.id);
    assert.deepEqual(editProposals.proposals[0].requiredTools, ["edit"]);
    assert.match(editProposals.proposals[0].title, /README\.md|\.\.\./);
    assert.match(editProposals.proposals[0].prompt, new RegExp(`Target: ${escapeRegExp(cwd)}/README\\.md`));
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(edited.message.id)}`);
    assert.deepEqual(routeDecisions.decisions, []);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(edited.message.id)}`);
    assert.equal(decisions.decisions[0].action, "execute");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("single-step file edit normalizes Users path without leading slash", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-single-step-file-users-path-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Docs users path edit",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "teammate_builtin_docs",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "edit"],
    })).channel;
    await setWorkspaceDefaultProvider(daemon.url, cwd, channel.defaultProviderPresetId);

    const edited = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "Users/tianxiao/ling-stack-test 下面，在 README.md 中添加一句测试语句",
    });

    assertCoordinatorWorkflowStartReply(edited);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(edited.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.deepEqual(proposals.proposals[0].requiredTools, ["edit"]);
    assert.match(proposals.proposals[0].title, /\/Users\/tianxiao\/ling-stack-test\/README\.md/);
    assert.match(proposals.proposals[0].prompt, /Target: \/Users\/tianxiao\/ling-stack-test\/README\.md/);
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(edited.message.id)}`);
    assert.deepEqual(routeDecisions.decisions, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("file creation how-to question remains ordinary Ling chat intent", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-single-step-howto-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "How-to docs",
      status: "active",
      boundPath: cwd,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "如何创建 README.md？",
    });

    assert.equal(created.aiReply.status, "pending");
    assert.equal(created.aiReply.authorId, "ling_agent");
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(proposals.proposals, []);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assertSingleReplyIntentDecision(decisions.decisions, created.message.id);

    const whyQuestion = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "为什么不能创建 README.md？",
    });
    assert.equal(whyQuestion.aiReply.status, "pending");
    assert.equal(whyQuestion.replyDispatch.disposition, "reply_requested");
    assert.equal(whyQuestion.replyDispatch.targetTeammateId, "ling_agent");
    const whyProposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(whyQuestion.message.id)}`);
    assert.deepEqual(whyProposals.proposals, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("single-step test request becomes direct workflow with bounded bash tools", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-single-step-test-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "QA execution",
      status: "active",
      boundPath: cwd,
      defaultTeammateId: "teammate_builtin_qa",
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "bash"],
    })).channel;
    await setWorkspaceDefaultProvider(daemon.url, cwd, channel.defaultProviderPresetId);

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "开始执行测试",
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.equal(proposals.proposals[0].linkedWorkflowId, created.autoStartedWorkflow.workflow.id);
    assert.equal(proposals.proposals[0].assigneeTeammateId, "teammate_builtin_qa");
    assert.deepEqual(proposals.proposals[0].requiredTools, ["bash"]);
    assert.match(proposals.proposals[0].riskSummary, /bash/);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions[0].action, "execute");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("high-risk push merge request auto-starts when required tools are not denied", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-high-risk-push-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Release",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "帮我 push 合并代码",
    });

    assertCoordinatorWorkflowStartReply(created);
    assert.equal(created.autoStartedWorkflow.workflowSteps.length, 1);
    assert.equal(runner.runs.length, 1);

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "accepted");
    assert.equal(proposals.proposals[0].linkedWorkflowId, created.autoStartedWorkflow.workflow.id);
    assert.match(proposals.proposals[0].riskSummary, /^本次任务需要 bash 权限处理 Git push\/merge workflow。/u);

    const workflows = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workflows.workflows.length, 1);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.some((decision) => /High-risk side effect is runtime-gated: git_push_or_merge/.test(decision.reason)), true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("high-risk thread follow-up creates a proposal without auto-starting", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-thread-high-risk-push-"));
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
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Release thread",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    const store = stores.get(cwd);
    assert.ok(store);
    const previousUser = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        kind: "message",
        intent: "discuss",
        authorType: "local-user",
        body: "这个分支后面要发版",
      },
      "2026-06-12T09:00:00.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      surface: { kind: "topic", anchorItemId: previousUser.id },
      body: "帮我 push 合并代码",
      mentions: [{ id: "ling_agent", label: "Ling Agent", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    assert.equal(created.aiReply, undefined);
    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(runner.runs.length, 0);

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "draft");
    assert.equal(proposals.proposals[0].linkedWorkflowId, undefined);
    assert.deepEqual(proposals.proposals[0].requiredTools, ["bash"]);

    const workflows = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workflows?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workflows.workflows.length, 0);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.some((decision) => decision.action === "execute" && decision.status === "accepted"), true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("high-risk push merge request blocks before run when required tool is denied", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-high-risk-push-deny-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    await patchJson(`${daemon.url}/approval-policy?cwd=${encodeURIComponent(cwd)}`, {
      toolDecisions: { bash: "deny" },
    });
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Release",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "帮我 push 合并代码",
    });

    assert.equal(created.aiReply, undefined);
    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(runner.runs.length, 0);

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].status, "draft");
    assert.equal(proposals.proposals[0].linkedWorkflowId, undefined);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.some((decision) => decision.status === "failed" && /denies required tools: bash/.test(decision.errorMessage ?? decision.reason)), true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("model-assisted channel intent no_reply falls through to ordinary Ling replies", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-intent-model-no-reply-fallthrough-"));
  const runner = new ScriptedRunner([
    JSON.stringify({ action: "no_reply", reason: "Not an executable task." }),
    "这个问题应该由 Ling Agent 回复。",
  ]);
  const daemon = await startDaemonForTest(runner, {}, { channels: { intentSelector: true } });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "teammate_builtin_engineer",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep"],
    })).channel;
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_engineer")}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_engineer")}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个实现边界怎么处理？",
    });

    assert.equal(created.aiReply.status, "pending");
    assert.equal(created.aiReply.authorId, "ling_agent");
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(finalReply.body, "这个问题应该由 Ling Agent 回复。");
    assert.equal(runner.runs.length, 2);
    assert.match(runner.runs[0].systemPrompt, /channel intent selector/i);
    assert.match(runner.runs[0].task.prompt, /Classify the latest user channel message into exactly one Ling intent/);
    assert.match(runner.runs[0].task.prompt, /Available teammate roles JSON/);
    assert.match(runner.runs[1].systemPrompt, /Do not include hidden proposal blocks/);
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(routeDecisions.decisions.length, 1);
    assert.equal(routeDecisions.decisions[0].mode, "default_teammate");
    assert.equal(routeDecisions.decisions[0].action, "reply");
    assert.equal(routeDecisions.decisions[0].status, "accepted");
    assert.equal(routeDecisions.decisions[0].replyMessageId, created.aiReply.id);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].action, "no_reply");
    assert.equal(decisions.decisions[0].status, "suppressed");
    assert.equal(decisions.decisions[0].createdBy, "model_policy");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("model-assisted channel intent failure cannot become an ordinary reply or confirmable proposal", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-intent-model-fallback-"));
  const runner = new ScriptedRunner([
    "not json",
    `普通频道回复。<ling_task_proposal>{"title":"Unbound proposal","prompt":"Start three agents","acceptanceCriteria":["done"],"requiredTools":["read"]}</ling_task_proposal>`,
  ]);
  const daemon = await startDaemonForTest(runner, {}, { channels: { intentSelector: true } });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "teammate_builtin_engineer",
      autoReplyMode: "default_teammate",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    })).channel;
    for (const teammateId of ["teammate_builtin_architect", "teammate_builtin_engineer", "teammate_builtin_qa"]) {
      await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
        providerPresetId: provider.id,
      });
      await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
        memberships: [{ channelId: channel.id }],
      });
    }

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "Architect 先拆，Engineer 实现，QA 验证",
    });

    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(created.aiReply.kind, "ai_reply");
    assert.equal(created.aiReply.status, "blocked");
    assert.equal(created.aiReply.errorMessage, "channel_intent_selection_failed");
    assert.equal(runner.runs.length, 2, "initial selection and exactly one format repair");
    assert.ok(runner.runs.every(run => /channel intent selector/i.test(run.systemPrompt)));
    assert.doesNotMatch(created.aiReply.body, /普通频道回复|ling_task_proposal/);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(proposals.proposals.length, 0);
    const allProposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(allProposals.proposals.length, 0);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].status, "failed");
    assert.equal(decisions.decisions[0].errorCode, "channel_intent_selection_failed");
    assert.deepEqual(decisions.decisions[0].resultItemIds, [created.aiReply.id]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("model execution proposal cannot declare command evidence authority", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-model-command-authority-"));
  const runner = new ScriptedRunner([
    JSON.stringify({
      action: "execute",
      reason: "Run Node.",
      execution: {
        schemaVersion: 2,
        operations: [{
          ...commandOperationCandidate({ sourceQuote: "运行 node app.js", command: "node app.js" }),
          commandMatchPolicy: { kind: "executable", executable: "node" },
        }],
      },
    }),
    "请确认是否按明确的本地命令执行。",
  ]);
  const daemon = await startDaemonForTest(runner, {}, { channels: { intentSelector: true } });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Model command authority",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "bash"],
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "运行 node app.js",
    });

    assert.equal(created.autoStartedWorkflow, undefined);
    assert.equal(created.aiReply.status, "blocked");
    assert.equal(created.aiReply.errorMessage, "channel_operation_plan_invalid");
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].action, "reply");
    assert.equal(decisions.decisions[0].status, "failed");
    assert.equal(decisions.decisions[0].errorCode, "channel_operation_plan_invalid");
    assert.equal(decisions.decisions[0].execution, undefined);
    assert.equal(runner.runs.length, 2);
    const observations = await getJson(`${daemon.url}/control-plane/events?cwd=${encodeURIComponent(cwd)}&domains=runners&limit=1000`);
    const rejected = observations.events.filter(event => event.entityType === "channel_intent_selection"
      && event.entityId === created.message.id && event.data.outcome === "shape_rejected");
    assert.deepEqual(rejected.map(event => event.data.issue), [{ path: "execution.operations[]", code: "unexpected_fields" }]);
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.deepEqual(proposals.proposals, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("issue #421 article continuation stays reply while an explicit README save executes", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-issue-421-article-"));
  // file_create needs an absent target; the generic channel test helper seeds a
  // README.md for its Git baseline, which a real exclusive create must reject.
  await ensureEmptyGitRepo(cwd);
  let continuedReply;
  let selectorCalls = 0;
  let replies = 0;
  const daemon = await startRealPiChannelFixture(cwd, (request) => {
    if (/channel intent selector/i.test(systemText(request))) {
      selectorCalls += 1;
      if (selectorCalls <= 2) return { text: JSON.stringify({ action: "reply",
        reason: selectorCalls === 1 ? "The user asked for conversational article content." : "The user confirmed that the article should continue in chat." }) };
      return { text: JSON.stringify({
      action: "execute",
      reason: "The user explicitly requested a local README write.",
      execution: { schemaVersion: 2, operations: [fileOperationCandidate({ id: "create_file", path: "README.md",
        sourceQuote: "把刚才的文章保存到 README.md。",
        contentSource: { kind: "literal", text: continuedReply.body, sourceQuote: continuedReply.body, sourceItemId: continuedReply.id } })] },
      }) };
    }
    if (selectorCalls <= 2) {
      replies += 1;
      return { text: replies === 1 ? "提纲：一、可恢复记忆；二、选择性投影；三、多 Agent 一致性。"
        : "正文：可恢复记忆的关键不是无限拼接历史，而是保留可追溯事实并按当前任务投影。" };
    }
    if (!request.messages.some((message) => message.role === "tool")) return { tool: "write", input: { path: "README.md", content: continuedReply.body } };
    return { text: "README.md saved." };
  });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, daemon.providerOverrides)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channelResponse = await fetch(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        name: "Issue 421 article continuity",
        status: "active",
        boundPath: cwd,
        defaultProviderPresetId: provider.id,
        autoReplyMode: "mentions_only",
        allowedTools: ["read", "grep", "find", "ls", "write"],
      }),
    });
    const channelPayload = await channelResponse.json();
    assert.equal(channelResponse.ok, true, JSON.stringify(channelPayload));
    const channel = channelPayload.channel;
    await assert.rejects(readFile(resolve(cwd, "README.md")), /ENOENT/);

    const article = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "帮我写一篇关于可恢复多 Agent 记忆的长文，先给提纲。",
      teammateId: "ling_agent",
      requestAiReply: true,
    });
    await waitForChannelMessageStatus(daemon.url, cwd, channel.id, article.aiReply.id, "ready");

    const continuation = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "需要，开始吧",
      teammateId: "ling_agent",
      requestAiReply: true,
    });
    const continuedMessages = await waitForChannelMessageStatus(
      daemon.url,
      cwd,
      channel.id,
      continuation.aiReply.id,
      "ready",
    );
    continuedReply = continuedMessages.messages.find((message) => message.id === continuation.aiReply.id);
    assert.match(continuedReply.body, /可恢复记忆/);

    const articleDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(article.message.id)}`);
    const continuationDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(continuation.message.id)}`);
    assertSingleReplyIntentDecision(articleDecisions.decisions, article.message.id);
    assertSingleReplyIntentDecision(continuationDecisions.decisions, continuation.message.id);
    assert.equal(articleDecisions.decisions[0].createdBy, "model_policy");
    assert.equal(continuationDecisions.decisions[0].createdBy, "model_policy");
    assert.equal(continuationDecisions.decisions[0].contextSegmentId, articleDecisions.decisions[0].contextSegmentId);
    assert.equal(continuationDecisions.decisions[0].clarification, undefined);
    assert.equal(continuationDecisions.decisions[0].execution, undefined);
    const continuationProposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(continuation.message.id)}`);
    assert.deepEqual(continuationProposals.proposals, []);

    const save = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "把刚才的文章保存到 README.md。",
      teammateId: "ling_agent",
      requestAiReply: true,
    });
    assertCoordinatorWorkflowStartReply(save);
    assert.equal(save.autoStartedWorkflow.workflowSteps.length, 1);
    const saveProposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(save.message.id)}`);
    assert.equal(saveProposals.proposals.length, 1);
    assert.equal(saveProposals.proposals[0].status, "accepted");
    assert.match(saveProposals.proposals[0].prompt, /create_file: file_create \(README\.md\)/);
    const saveDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(save.message.id)}`);
    assert.equal(saveDecisions.decisions.length, 2);
    assert(saveDecisions.decisions.every((decision) => decision.action === "execute"));
    assert(saveDecisions.decisions.every((decision) => decision.execution.operations[0].kind === "file_create"));
    assert(saveDecisions.decisions.every((decision) => decision.execution.operations[0].targetKind === "file"));
    assert(saveDecisions.decisions.every((decision) => decision.proposalId === saveProposals.proposals[0].id));
    assert(saveDecisions.decisions.every((decision) => {
      assertIntentDecisionInspectPayloadIsSafe(decision);
      return true;
    }));
    const classified = saveDecisions.decisions.find((decision) => decision.createdBy === "model_policy");
    const started = saveDecisions.decisions.find((decision) => decision.workflowId === save.autoStartedWorkflow.workflow.id);
    assert.ok(classified);
    assert.ok(started);
    assert.equal(classified.execution.operations[0].binding.contentSource.text, continuedReply.body);
    assert.deepEqual(classified.execution.operations[0].binding.contentSource.sourceRefs.map((ref) => ref.itemId), [continuedReply.id]);
    assert.deepEqual(started.resultItemIds, [save.aiReply.id]);
    assert.equal(replies, 2);
    assert.equal(daemon.selectorRequests.length, 3);
    await daemon.assertWorkflowCompleted(save, { files: [{ path: "README.md", content: continuedReply.body }],
      actionTypes: ["write"], participantIds: ["ling_agent"] });
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("issue #421 unrelated snake-game request escapes an old target clarification", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-issue-421-segment-reset-"));
  const runner = new ScriptedRunner([
    JSON.stringify({
      action: "clarify",
      reason: "A local write needs a concrete destination.",
      clarification: { missingFields: ["target"], question: "要保存到哪个目标文件？" },
    }),
    JSON.stringify({ action: "reply", reason: "The snake-game design is independently answerable in chat." }),
    "贪吃蛇玩法：方向键移动，吃到食物增长，撞墙或撞到自己结束。",
  ]);
  runner.segmentationResponses = [JSON.stringify({
    action: "propose_new",
    confidence: 0.96,
    relatedSegmentIds: [],
    reason: "The snake-game design is unrelated to the unresolved file destination.",
  })];
  const daemon = await startDaemonForTest(runner, {}, { channels: { intentSelector: true } });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Issue 421 clarification isolation",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "grep", "find", "ls", "write"],
    })).channel;

    const oldRequest = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "把这段内容写到本地文件里。",
      teammateId: "ling_agent",
      requestAiReply: true,
    });
    assert.equal(oldRequest.aiReply.status, "ready");
    assert.match(oldRequest.aiReply.body, /目标文件/);
    const oldDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(oldRequest.message.id)}`);
    assert.equal(oldDecisions.decisions.length, 1);
    assert.equal(oldDecisions.decisions[0].action, "clarify");
    assert.deepEqual(oldDecisions.decisions[0].clarification.missingFields, ["target"]);

    const snake = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "再做一个贪吃蛇小游戏的方案，先讲玩法。",
      teammateId: "ling_agent",
      requestAiReply: true,
    });
    const snakeMessages = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, snake.aiReply.id, "ready");
    const snakeReply = snakeMessages.messages.find((message) => message.id === snake.aiReply.id);
    assert.match(snakeReply.body, /贪吃蛇玩法/);
    assert.doesNotMatch(snakeReply.body, /目标文件|target file/i);
    const snakeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(snake.message.id)}`);
    assertSingleReplyIntentDecision(snakeDecisions.decisions, snake.message.id);
    assert.equal(snakeDecisions.decisions[0].createdBy, "model_policy");
    assert.notEqual(snakeDecisions.decisions[0].contextSegmentId, oldDecisions.decisions[0].contextSegmentId);
    assert.equal(runner.segmentationRuns.length, 1);
    const snakeProposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(snake.message.id)}`);
    assert.deepEqual(snakeProposals.proposals, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("default_teammate route suppresses duplicate Ling Agent replies for the same source message", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-default-teammate-idempotent-"));
  const now = "2026-06-09T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const provider = store.createProviderPreset(
      {
        kind: "glm",
        displayName: "Static Chat",
        providerId: "static-chat",
        model: "static-model",
        api: "google-generative-ai",
        capabilities: ["chat"],
        input: ["text"],
        authHeader: false,
        enabled: true,
      },
      now,
    );
    store.recordProviderCheckResult(provider.id, {
      ok: true,
      code: "static_check",
      message: "Provider configuration is valid.",
      checkedAt: now,
    });
    const channel = store.createChannel(
      {
        name: "Engineering",
        boundPath: cwd,
        defaultProviderPresetId: provider.id,
        defaultTeammateId: "engineer",
        autoReplyMode: "default_teammate",
      },
      now,
    );
    const sourceMessage = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        authorType: "local-user",
        body: "这个问题应该怎么回复？",
      },
      now,
    );
    appendChannelItemFixture(store,
      {
        channelId: channel.id,
        replyToItemId: sourceMessage.id,
        kind: "ai_reply",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: "Existing reply.",
      },
      now,
    );

    const route = await routeChannelMessageReply({
      store,
      channel,
      sourceMessage,
      config: testDaemonConfig(cwd),
      secretResolver: createCompositeSecretResolver({ env: {} }),
      runnerRegistry: unusedRunnerRegistry(),
    });

    assert.equal(route.action, "no_reply");
    assert.equal(route.reason, "An AI reply already exists for this source message.");
    const decisions = store.listChannelMessageRouteDecisions({ channelId: channel.id, sourceMessageId: sourceMessage.id });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].status, "suppressed");
    assert.equal(decisions[0].reason, "An AI reply already exists for this source message.");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("default_teammate route treats channel branches and topic replies as separate surfaces", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-surface-route-"));
  const now = "2026-06-25T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const provider = store.createProviderPreset(
      {
        kind: "glm",
        displayName: "Static Chat",
        providerId: "static-chat",
        model: "static-model",
        api: "google-generative-ai",
        capabilities: ["chat"],
        input: ["text"],
        authHeader: false,
        enabled: true,
      },
      now,
    );
    store.recordProviderCheckResult(provider.id, {
      ok: true,
      code: "static_check",
      message: "Provider configuration is valid.",
      checkedAt: now,
    });
    const channel = store.createChannel(
      {
        name: "Engineering",
        boundPath: cwd,
        defaultProviderPresetId: provider.id,
        defaultTeammateId: "engineer",
        autoReplyMode: "default_teammate",
      },
      now,
    );
    const rootThread = store.resolveOrCreateConversationThread({
      surfaceKind: "channel_root",
      channelId: channel.id,
      title: "Root",
      objective: "Root conversation",
    }, now).thread;
    const rootMessage = appendChannelItemFixture(store, {
      channelId: channel.id,
      authorType: "local-user",
      body: "Create a branch",
    }, now);
    const rootItem = store.getConversationItem(rootMessage.id);
    assert.ok(rootItem?.turnId);
    const rootAssignment = store.getEffectiveTurnContextAssignment(rootItem.turnId);
    assert.ok(rootAssignment);
    const branchThread = store.resolveOrCreateConversationThread({
      id: "thread_branch_root",
      surfaceKind: "branch",
      channelId: channel.id,
      parentThreadId: rootThread.id,
      parentTurnId: rootItem.turnId,
      title: "Branch",
      objective: "Branch conversation",
      forkContextSnapshot: {
        id: "snapshot_branch_root",
        segmentId: rootAssignment.segmentId,
        projectionVersion: "ctxv2_branch_root",
        throughItemSequence: rootItem.sequence,
        summaryIds: [],
        sourceRefs: [{ type: "conversation_item", id: rootItem.id }],
        policyVersion: "continuity-v2-snapshot-v1",
      },
    }, now).thread;
    const branch = store.createChannelBranch(
      {
        channelId: channel.id,
        name: "test",
        rootThreadId: branchThread.id,
      },
      now,
    );
    const branchMessage = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        threadId: branch.rootThreadId,
        authorType: "local-user",
        body: "分支里也需要继续回复。",
      },
      now,
    );
    const topicSource = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        authorType: "local-user",
        body: "主频道源消息。",
      },
      now,
    );
    const topicReply = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        topicAnchorItemId: topicSource.id,
        authorType: "local-user",
        body: "这是 topic reply，不应该自动拉起 agent。",
      },
      now,
    );

    const sharedRouteInput = {
      store,
      channel,
      config: testDaemonConfig(cwd),
      secretResolver: createCompositeSecretResolver({ env: {} }),
      runnerRegistry: unusedRunnerRegistry(),
    };
    const branchRoute = await routeChannelMessageReply({
      ...sharedRouteInput,
      sourceMessage: branchMessage,
    });
    const topicRoute = await routeChannelMessageReply({
      ...sharedRouteInput,
      sourceMessage: topicReply,
    });

    assert.equal(branchRoute.action, "reply");
    assert.equal(branchRoute.teammateId, "ling_agent");
    assert.equal(branchRoute.reason, "Ling Agent answered a channel branch message.");
    assert.equal(topicRoute.action, "no_reply");
    assert.equal(topicRoute.reason, "Topic replies are outside the first auto-reply scope.");

    const branchDecisions = store.listChannelMessageRouteDecisions({ channelId: channel.id, sourceMessageId: branchMessage.id });
    assert.equal(branchDecisions.length, 1);
    assert.equal(branchDecisions[0].action, "reply");
    assert.equal(branchDecisions[0].status, "accepted");
    const topicDecisions = store.listChannelMessageRouteDecisions({ channelId: channel.id, sourceMessageId: topicReply.id });
    assert.equal(topicDecisions.length, 1);
    assert.equal(topicDecisions[0].action, "no_reply");
    assert.equal(topicDecisions[0].status, "suppressed");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Ling Agent replies to greetings, repeated greetings, punctuation, and acknowledgements", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-default-teammate-greeting-"));
  const runner = new ScriptedRunner([
    "你好，我在。可以继续说你的问题。",
    "我在，继续说。",
    "晚上好，我在。",
    "看到了，继续说。",
    "收到，继续。",
  ]);
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: "engineer",
      autoReplyMode: "mentions_only",
      allowedTools: ["read"],
    })).channel;

    const preConfigGreeting = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "你好？",
    });
    assert.equal(preConfigGreeting.aiReply.status, "pending");
    const preConfigListed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, preConfigGreeting.aiReply.id, "ready");
    const preConfigReply = preConfigListed.messages.find((message) => message.id === preConfigGreeting.aiReply.id);
    assert.equal(preConfigReply.body, "你好，我在。可以继续说你的问题。");
    await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`, {
      autoReplyMode: "default_teammate",
    });

    const repeatedGreeting = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "你好？",
    });
    assert.equal(repeatedGreeting.aiReply.status, "pending");
    const repeatedListed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, repeatedGreeting.aiReply.id, "ready");
    const repeatedReply = repeatedListed.messages.find((message) => message.id === repeatedGreeting.aiReply.id);
    assert.equal(repeatedReply.body, "我在，继续说。");
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(repeatedGreeting.message.id)}`);
    assert.equal(decisions.decisions[0].action, "reply");
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].replyMessageId, repeatedGreeting.aiReply.id);

    const eveningGreeting = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "晚上好",
    });
    assert.equal(eveningGreeting.aiReply.status, "pending");
    const eveningListed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, eveningGreeting.aiReply.id, "ready");
    const eveningReply = eveningListed.messages.find((message) => message.id === eveningGreeting.aiReply.id);
    assert.equal(eveningReply.body, "晚上好，我在。");

    const punctuation = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "。。",
    });
    assert.equal(punctuation.aiReply.status, "pending");
    const punctuationListed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, punctuation.aiReply.id, "ready");
    const punctuationReply = punctuationListed.messages.find((message) => message.id === punctuation.aiReply.id);
    assert.equal(punctuationReply.body, "看到了，继续说。");

    const acknowledgement = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "好的",
    });
    assert.equal(acknowledgement.aiReply.status, "pending");
    const acknowledgementListed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, acknowledgement.aiReply.id, "ready");
    const acknowledgementReply = acknowledgementListed.messages.find((message) => message.id === acknowledgement.aiReply.id);
    assert.equal(acknowledgementReply.body, "收到，继续。");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("default_teammate creates a blocked Ling Agent reply when the channel has no runnable provider", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-default-teammate-suppressed-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      autoReplyMode: "default_teammate",
      allowedTools: ["read"],
    })).channel;
    simulateLegacyChannelWithoutModel(cwd, channel.id);

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个问题谁来回复？",
    });

    assert.equal(created.aiReply.status, "blocked");
    assert.equal(created.aiReply.authorId, "ling_agent");
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "blocked");
    const blockedReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(blockedReply.body, "AI teammate is not configured for this channel.");
    assert.equal(blockedReply.errorMessage, "No provider preset is selected for this channel discussion.");
    assert.equal(runner.runs.length, 0);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].mode, "default_teammate");
    assert.equal(decisions.decisions[0].action, "reply");
    assert.equal(decisions.decisions[0].status, "failed");
    assert.equal(decisions.decisions[0].replyMessageId, created.aiReply.id);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("explicit mentions keep reply text but cannot create an unbound proposal", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-explicit-route-"));
  const runner = new ScriptedRunner([
    `Visible explicit reply<ling_task_proposal>{"title":"Explicit proposal","prompt":"Create explicit task","acceptanceCriteria":["ok"],"requiredTools":["read"],"riskSummary":"explicit"}</ling_task_proposal>`,
  ]);
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Designer 这个明确任务可以处理吗？",
      mentions: [{ id: "designer", label: "Designer", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(finalReply.body, "Visible explicit reply");
    assert.match(runner.runs[0].systemPrompt, /Do not include hidden proposal blocks/);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions[0].createdBy, "explicit_mention");
    assert.equal(decisions.decisions[0].status, "accepted");
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(proposals.proposals.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("auto_route is rejected by channel create and update while the feature flag is disabled", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-auto-route-disabled-"));
  let channelStore;
  const daemon = await startDaemonForTest(undefined, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      if (storeCwd === cwd) {
        channelStore = store;
      }
      return store;
    },
  }, { channels: { autoRoute: false, intentSelector: false } });
  try {
    const createUrl = `${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`;
    const createBody = {
      name: "Engineering",
      boundPath: cwd,
      autoReplyMode: "auto_route",
    };
    const preparedCreateBody = await prepareChannelCreateBody(createUrl, createBody);
    await ensureGitRepoForChannelPost(createUrl, preparedCreateBody);
    const createResponse = await fetch(createUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(preparedCreateBody),
    });
    assert.equal(createResponse.status, 400);
    assert.equal((await createResponse.json()).error, "auto_route_disabled");

    const channel = await createChannel(daemon.url, cwd);
    const updateResponse = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoReplyMode: "auto_route" }),
    });
    assert.equal(updateResponse.status, 400);
    assert.equal((await updateResponse.json()).error, "auto_route_disabled");

    assert.ok(channelStore);
    channelStore.updateChannel(channel.id, { autoReplyMode: "auto_route" }, new Date().toISOString());
    const renameResponse = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed", autoReplyMode: "auto_route" }),
    });
    assert.equal(renameResponse.status, 200);
    const renamed = (await renameResponse.json()).channel;
    assert.equal(renamed.name, "Renamed");
    assert.equal(renamed.autoReplyMode, "auto_route");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("auto_route uses the model selector and records accepted route evidence", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-auto-route-model-"));
  const stores = new Map();
  const runner = new ScriptedRunner([
    JSON.stringify({
      action: "reply",
      teammateId: "teammate_builtin_designer",
      confidence: 0.9,
      reason: "Designer owns UI wording.",
      alternativesConsidered: [
        {
          teammateId: "teammate_builtin_designer",
          label: "Designer",
          score: 0.9,
          reason: "Best fit.",
        },
      ],
    }),
    `<ling_task_proposal>{"title":"Should not persist","prompt":"Create auto task","acceptanceCriteria":["never"],"requiredTools":["read"],"riskSummary":"blocked by proposalMode"}</ling_task_proposal>Designer auto route reply`,
  ]);
  const daemon = await startDaemonForTest(runner, {
    storeFactory: (storeCwd) => {
      const store = createSqliteRunStore(storeCwd);
      stores.set(storeCwd, store);
      return store;
    },
  }, { channels: { autoRoute: true } });
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Design",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "auto_route",
      allowedTools: ["read"],
    })).channel;
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const oldGuidanceMessage = appendChannelItemFixture(store,
      {
        channelId: channel.id,
        authorType: "local-user",
        body: "排队引导：旧频道引导不应继续影响后续消息。",
      },
      "2026-06-12T08:00:00.000Z",
    );
    const oldRun = store.createRun({
      id: "run_old_channel_guidance",
      cwd,
      taskId: "task_old_channel_guidance",
      channelId: channel.id,
      teammateId: "ling_agent",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_old_channel_guidance", title: "Old active work", prompt: "Old active work." },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd, task: { id: "task_old_channel_guidance", title: "Old active work", prompt: "Old active work.", channelId: channel.id } },
      createdAt: "2026-06-12T08:00:01.000Z",
    });
    store.createRunIntervention(
      {
        sourceRunId: oldRun.id,
        mode: "queue_followup",
        instruction: oldGuidanceMessage.body,
        requestedBy: "local-user",
        idempotencyKey: `channel_message:${oldGuidanceMessage.id}:queue_followup`,
      },
      "2026-06-12T08:00:02.000Z",
    );

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个设置文案应该怎么改？",
    });

    assert.equal(created.aiReply.authorId, "ling_agent");
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(finalReply.body, "Designer auto route reply");
    assert.doesNotMatch(finalReply.body, /ling_task_proposal/);
    assert.equal(runner.runs.length, 2);
    assert.match(runner.runs[0].systemPrompt, /channel message router/i);
    assert.match(runner.runs[0].task.prompt, /Decide whether one AI teammate should reply/);
    assert.match(runner.runs[0].task.prompt, /Root local-user messages should produce a visible Ling outcome/);
    assert.match(runner.runs[0].task.prompt, /Channel collaboration protocol:/);
    assert.match(runner.runs[0].task.prompt, /Auto reply mode: auto_route \(source=channel_setting\)/);
    assert.match(runner.runs[0].task.prompt, /Candidates JSON/);
    assert.doesNotMatch(runner.runs[0].task.prompt, /旧频道引导不应继续影响后续消息/);
    assert.match(runner.runs[1].systemPrompt, /Do not include hidden proposal blocks/);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].mode, "auto_route");
    assert.equal(decisions.decisions[0].createdBy, "model");
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].selectedTeammateId, "ling_agent");
    assert.equal(decisions.decisions[0].confidence, 0.9);
    assert.equal(decisions.decisions[0].replyMessageId, created.aiReply.id);
    assert.equal(decisions.decisions[0].alternativesConsidered[0].teammateId, teammateId);
    assert.equal(decisions.decisions[0].contextPack.kind, "auto_route_selector");
    assert.deepEqual(decisions.decisions[0].contextPack.sectionIds, [
      "auto_route_instructions",
      "channel_collaboration_protocol",
      "auto_route_source_message",
      "auto_route_candidates",
    ]);
    assert.deepEqual(decisions.decisions[0].contextPack.sourceRefCounts, {
      channel: 1,
      message: 1,
      thread: 1,
      turn: 1,
      conversation_item: 1,
    });
    const createdItem = store.getConversationItem(created.message.id);
    assert.ok(createdItem?.turnId);
    assert.equal(decisions.decisions[0].contextPack.contextProjection.threadId, createdItem.threadId);
    assert.equal(decisions.decisions[0].contextPack.contextProjection.turnId, createdItem.turnId);
    assert.equal(typeof decisions.decisions[0].contextPack.contextProjection.projectionVersion, "string");
    assert.equal(decisions.decisions[0].contextPack.providerPresetId, provider.id);
    assert.deepEqual((await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}`)).proposals, []);
    assert.deepEqual((await getJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`)).tasks, []);
    const runs = await getJson(`${daemon.url}/runs?cwd=${encodeURIComponent(cwd)}`);
    const replyRuns = runs.runs.filter((run) => run.id !== oldRun.id);
    assert.equal(replyRuns.length, 1);
    assert.equal(replyRuns[0].id, finalReply.linkedRunId);
    assert.equal(replyRuns[0].status, "succeeded");
    assert.equal(replyRuns[0].taskId, created.message.id);
    const persistedReplyRun = store.getRun(replyRuns[0].id);
    assert.equal(
      persistedReplyRun.requestSnapshot.contextProjection.projectionVersion,
      decisions.decisions[0].contextPack.contextProjection.projectionVersion,
    );
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("auto_route falls back to Ling Agent replies on selector failure", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-auto-route-fallback-"));
  const runner = new ScriptedRunner(["not json", "Ling fallback reply 1"]);
  const daemon = await startDaemonForTest(runner, {}, { channels: { autoRoute: true } });
  try {
    const channel = await createAutoRouteTestChannel(daemon.url, cwd);

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个交给谁回复？",
    });

    assert.equal(created.aiReply.status, "pending");
    assert.equal(created.aiReply.authorId, "ling_agent");
    await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    assert.equal(runner.runs.length, 2);
    let decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].createdBy, "model");
    assert.equal(decisions.decisions[0].reason, "Ling Agent fallback replied after automatic teammate selection failed.");

    runner.responses.push(JSON.stringify({
      action: "reply",
      teammateId: "teammate_builtin_designer",
      confidence: 0.2,
      reason: "Unsure.",
      alternativesConsidered: [],
    }), "Ling fallback reply 2");
    const lowConfidence = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个 UI 问题可以自动判断吗？",
    });
    assert.equal(lowConfidence.aiReply.status, "pending");
    assert.equal(lowConfidence.aiReply.authorId, "ling_agent");
    await waitForChannelMessageStatus(daemon.url, cwd, channel.id, lowConfidence.aiReply.id, "ready");
    decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(lowConfidence.message.id)}`);
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.match(decisions.decisions[0].reason, /Route model confidence was below threshold/);

    runner.responses.push(`Here is the decision: ${JSON.stringify({
      action: "reply",
      teammateId: "teammate_builtin_designer",
      confidence: 0.9,
      reason: "Wrapped JSON should fail strict parsing.",
      alternativesConsidered: [],
    })}`, "Ling fallback reply 3");
    const wrappedJson = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个带解释的模型输出应该失败吗？",
    });
    assert.equal(wrappedJson.aiReply.status, "pending");
    assert.equal(wrappedJson.aiReply.authorId, "ling_agent");
    await waitForChannelMessageStatus(daemon.url, cwd, channel.id, wrappedJson.aiReply.id, "ready");
    decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(wrappedJson.message.id)}`);
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].reason, "Ling Agent fallback replied after automatic teammate selection failed.");

    runner.responses.push(JSON.stringify({
      action: "reply",
      teammateId: "teammate_missing",
      confidence: 0.9,
      reason: "Unknown teammate should fail closed.",
      alternativesConsidered: [],
    }), "Ling fallback reply 4");
    const unknownTeammate = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个未知 teammate 应该失败吗？",
    });
    assert.equal(unknownTeammate.aiReply.status, "pending");
    assert.equal(unknownTeammate.aiReply.authorId, "ling_agent");
    await waitForChannelMessageStatus(daemon.url, cwd, channel.id, unknownTeammate.aiReply.id, "ready");
    decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(unknownTeammate.message.id)}`);
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].reason, "Ling Agent fallback replied after automatic teammate selection failed.");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel AI replies return pending message before runner finishes", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-ai-reply-pending-"));
  const runner = new DelayedRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Designer async please",
      mentions: [{ id: teammateId, label: "Designer", kind: "ai-teammate" }],
      requestAiReply: true,
      providerPresetId: provider.id,
      teammateId,
    });

    assert.equal(created.aiReply.status, "pending");
    await waitForCondition(() => runner.runs.length === 1, "runner to start channel AI reply");
    assert.equal(runner.runs.length, 1);
    assert.equal(runner.completed, false);
    const pending = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/items?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(pending.messages.find((message) => message.id === created.aiReply.id).status, "pending");

    runner.resolve("Delayed reply");
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(finalReply.body, "Delayed reply");
  } finally {
    runner.resolve("cleanup");
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel attachment upload validates file types and serves content safely", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-attachments-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);
    const uploaded = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "brief.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("hello channel", "utf8").toString("base64"),
    });
    assert.equal(uploaded.attachment.kind, "text");
    assert.equal(uploaded.attachment.fileName, "brief.txt");

    const content = await fetch(`${daemon.url}/attachments/${encodeURIComponent(uploaded.attachment.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(content.status, 200);
    assert.equal(await content.text(), "hello channel");

    const typed = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "payload.txt",
      contentType: "text/html",
      contentBase64: Buffer.from("<script>alert(1)</script>", "utf8").toString("base64"),
    });
    const typedContent = await fetch(`${daemon.url}/attachments/${encodeURIComponent(typed.attachment.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.match(typedContent.headers.get("content-type") ?? "", /^text\/plain/);

    const rejected = await fetch(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "archive.zip",
        contentBase64: Buffer.from("zip").toString("base64"),
      }),
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).message, /Unsupported attachment type/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("attachment-only channel turn reaches Ling Agent with metadata and preview", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-attachment-only-turn-"));
  const runner = new ScriptedRunner(["看到了 brief.txt。你要我总结、写入文件，还是作为当前任务上下文？"]);
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Attachment turn",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
      autoReplyMode: "default_teammate",
      allowedTools: ["read"],
    })).channel;
    const attachment = (await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "brief.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("hello channel attachment", "utf8").toString("base64"),
    })).attachment;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "",
      attachmentIds: [attachment.id],
    });

    assert.equal(created.aiReply.status, "pending");
    assert.equal(created.aiReply.authorId, "ling_agent");
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(finalReply.body, "看到了 brief.txt。你要我总结、写入文件，还是作为当前任务上下文？");
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].task.prompt, /Turn envelope/);
    assert.match(runner.runs[0].task.prompt, /brief\.txt/);
    assert.match(runner.runs[0].task.prompt, /hello channel attachment/);
    const routeDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(routeDecisions.decisions.length, 1);
    assert.equal(routeDecisions.decisions[0].action, "reply");
    const intentDecisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/intent-decisions?cwd=${encodeURIComponent(cwd)}&sourceItemId=${encodeURIComponent(created.message.id)}`);
    assertSingleReplyIntentDecision(intentDecisions.decisions, created.message.id);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel asset references must stay within the same channel", async () => {
  const cwd = await createSqliteWorkspaceFixture(resolve(tmpdir(), "ling-stack-channel-reference-"));
  const daemon = await startDaemonForTest();
  try {
    const first = await createChannel(daemon.url, cwd);
    const second = await createChannel(daemon.url, cwd);
    const message = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      body: "source message",
    });
    const attachment = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "brief.txt",
      contentBase64: Buffer.from("brief", "utf8").toString("base64"),
      messageId: message.message.id,
    });
    const preview = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/link-previews?cwd=${encodeURIComponent(cwd)}`, {
      url: "http://localhost:12345/private",
    });

    const crossUpload = await fetch(`${daemon.url}/channels/${encodeURIComponent(second.id)}/attachments?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "other.txt",
        contentBase64: Buffer.from("other", "utf8").toString("base64"),
        messageId: message.message.id,
      }),
    });
    assert.equal(crossUpload.status, 400);
    assert.equal((await crossUpload.json()).error, "message_channel_mismatch");

    const crossMessage = await fetch(`${daemon.url}/channels/${encodeURIComponent(second.id)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "cross channel reference",
        attachmentIds: [attachment.attachment.id],
        linkPreviewIds: [preview.linkPreview.id],
      }),
    });
    assert.equal(crossMessage.status, 400);
    assert.equal((await crossMessage.json()).error, "attachment_channel_mismatch");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
