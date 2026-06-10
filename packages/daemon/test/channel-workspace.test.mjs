import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createCompositeSecretResolver, createSqliteRunStore } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";
import { routeChannelMessageReply } from "../dist/features/channels/channel-message-router.js";
import { ensureGitRepoForChannelPost } from "./git-test-helpers.mjs";

test("health exposes channel auto_route capability", async () => {
  const disabledDaemon = await startDaemonForTest();
  try {
    const health = await getJson(`${disabledDaemon.url}/health`);
    assert.equal(health.features.channels.autoRoute, false);
  } finally {
    await disabledDaemon.close();
  }

  const enabledDaemon = await startDaemonForTest(undefined, {}, { channels: { autoRoute: true } });
  try {
    const health = await getJson(`${enabledDaemon.url}/health`);
    assert.equal(health.features.channels.autoRoute, true);
  } finally {
    await enabledDaemon.close();
  }
});

test("channel messages persist and AI blocker replies do not drop the user message", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-messages-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultTeammateId: "engineer",
      allowedTools: ["read"],
      runtimePolicy: {
        maxConcurrentRuns: 1,
        executionMode: "serial",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "请 @Engineer 完善频道需求",
      mentions: [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }],
      requestAiReply: true,
    });
    assert.equal(created.message.body, "请 @Engineer 完善频道需求");
    assert.equal(created.aiReply.status, "pending");

    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "blocked");
    assert.deepEqual(listed.messages.map((message) => message.id), [created.message.id, created.aiReply.id]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel discussion uses the mentioned teammate provider preset", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-mentioned-teammate-provider-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    const check = await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(check.ok, true);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id }],
    });

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Designer 你好",
      mentions: [{ id: "designer", label: "Designer", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    assert.equal(created.aiReply.status, "pending");
    assert.equal(created.aiReply.authorId, teammateId);
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(finalReply.body, "Designer reply");
    assert.equal(runner.runs.length, 1);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("mentions_only records suppressed route evidence without running an AI reply", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-mentions-only-route-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createChannel(daemon.url, cwd);

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个频道自动回复怎么设计？",
    });

    assert.equal(created.aiReply, undefined);
    assert.equal(runner.runs.length, 0);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].mode, "mentions_only");
    assert.equal(decisions.decisions[0].action, "no_reply");
    assert.equal(decisions.decisions[0].status, "suppressed");
    assert.equal(decisions.decisions[0].createdBy, "deterministic");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("default_teammate routes reply-worthy messages to the channel default without proposals", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-default-teammate-route-"));
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个实现边界怎么处理？",
    });

    assert.equal(created.aiReply.status, "pending");
    assert.equal(created.aiReply.authorId, "teammate_builtin_engineer");
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.match(finalReply.body, /ling_task_proposal/);
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].systemPrompt, /Do not include hidden proposal blocks/);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].mode, "default_teammate");
    assert.equal(decisions.decisions[0].action, "reply");
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].createdBy, "deterministic");
    assert.equal(decisions.decisions[0].selectedTeammateId, "teammate_builtin_engineer");
    assert.equal(decisions.decisions[0].replyMessageId, created.aiReply.id);

    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(proposals.proposals, []);
    assert.deepEqual((await getJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`)).tasks, []);
    assert.deepEqual((await getJson(`${daemon.url}/runs?cwd=${encodeURIComponent(cwd)}`)).runs, []);

    const countQuestion = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "现在频道有多少个队友",
    });
    assert.equal(countQuestion.aiReply.status, "pending");
    const countReplyList = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, countQuestion.aiReply.id, "ready");
    const countReply = countReplyList.messages.find((message) => message.id === countQuestion.aiReply.id);
    assert.equal(countReply.body, "这个频道当前有多个 AI 队友，具体数量以频道成员列表为准。");

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

test("channel intent selector creates workflow proposals instead of all-teammate replies", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-intent-workflow-proposal-"));
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
        executionMode: "serial",
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "所有队友都回复我一下：Architect 先拆，Engineer 实现，QA 验证",
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
      ["teammate_builtin_architect", "teammate_builtin_engineer", "teammate_builtin_qa", "teammate_builtin_designer", "teammate_builtin_product-strategist"],
    );
    assert.match(proposals.proposals[0].riskSummary, /instead of visible group chat/i);

    const listedMessages = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listedMessages.messages.filter((message) => message.kind === "ai_reply").length, 0);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].action, "no_reply");
    assert.equal(decisions.decisions[0].status, "suppressed");
    assert.equal(decisions.decisions[0].createdBy, "deterministic");
    assert.match(decisions.decisions[0].reason, /Workflow proposal created from channel intent/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("default_teammate route suppresses duplicate replies for the same source message", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-default-teammate-idempotent-"));
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
    const sourceMessage = store.createChannelMessage(
      {
        channelId: channel.id,
        authorType: "local-user",
        body: "这个问题应该怎么回复？",
      },
      now,
    );
    store.createChannelMessage(
      {
        channelId: channel.id,
        threadId: sourceMessage.id,
        kind: "ai_reply",
        authorType: "ai-teammate",
        authorId: "teammate_builtin_engineer",
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

test("default_teammate answers the first greeting after mode is enabled and suppresses answered repeats", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-default-teammate-greeting-"));
  const runner = new ScriptedRunner([
    "你好，我在。可以继续说你的问题。",
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

    const preConfigGreeting = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "你好？",
    });
    assert.equal(preConfigGreeting.aiReply, undefined);
    await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`, {
      autoReplyMode: "default_teammate",
    });

    const firstGreeting = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "你好？",
    });
    assert.equal(firstGreeting.aiReply.status, "pending");
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, firstGreeting.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === firstGreeting.aiReply.id);
    assert.equal(finalReply.body, "你好，我在。可以继续说你的问题。");

    const repeatedGreeting = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "你好？",
    });
    assert.equal(repeatedGreeting.aiReply, undefined);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(repeatedGreeting.message.id)}`);
    assert.equal(decisions.decisions[0].status, "suppressed");
    assert.equal(decisions.decisions[0].reason, "Repeated short greeting was suppressed.");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("default_teammate suppresses when the channel has no runnable default teammate", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-default-teammate-suppressed-"));
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个问题谁来回复？",
    });

    assert.equal(created.aiReply, undefined);
    assert.equal(runner.runs.length, 0);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].mode, "default_teammate");
    assert.equal(decisions.decisions[0].action, "no_reply");
    assert.equal(decisions.decisions[0].status, "suppressed");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("explicit mentions still reply and keep proposal extraction enabled", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-explicit-route-"));
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Designer 这个明确任务可以处理吗？",
      mentions: [{ id: "designer", label: "Designer", kind: "ai-teammate" }],
      requestAiReply: true,
    });

    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.equal(finalReply.body, "Visible explicit reply");
    assert.match(runner.runs[0].systemPrompt, /include one hidden proposal block/);
    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions[0].createdBy, "explicit_mention");
    assert.equal(decisions.decisions[0].status, "accepted");
    const proposals = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].title, "Explicit proposal");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("auto_route is rejected by channel create and update while the feature flag is disabled", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-auto-route-disabled-"));
  const daemon = await startDaemonForTest();
  try {
    const createResponse = await fetch(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Engineering",
        boundPath: cwd,
        autoReplyMode: "auto_route",
      }),
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
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("auto_route uses the model selector and records accepted route evidence", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-auto-route-model-"));
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
  const daemon = await startDaemonForTest(runner, {}, { channels: { autoRoute: true } });
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个设置文案应该怎么改？",
    });

    assert.equal(created.aiReply.authorId, teammateId);
    const listed = await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    const finalReply = listed.messages.find((message) => message.id === created.aiReply.id);
    assert.match(finalReply.body, /ling_task_proposal/);
    assert.equal(runner.runs.length, 2);
    assert.match(runner.runs[0].systemPrompt, /channel message router/i);
    assert.match(runner.runs[1].systemPrompt, /Do not include hidden proposal blocks/);

    const decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions.length, 1);
    assert.equal(decisions.decisions[0].mode, "auto_route");
    assert.equal(decisions.decisions[0].createdBy, "model");
    assert.equal(decisions.decisions[0].status, "accepted");
    assert.equal(decisions.decisions[0].selectedTeammateId, teammateId);
    assert.equal(decisions.decisions[0].confidence, 0.9);
    assert.equal(decisions.decisions[0].replyMessageId, created.aiReply.id);
    assert.deepEqual((await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/proposals?cwd=${encodeURIComponent(cwd)}`)).proposals, []);
    assert.deepEqual((await getJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`)).tasks, []);
    assert.deepEqual((await getJson(`${daemon.url}/runs?cwd=${encodeURIComponent(cwd)}`)).runs, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("auto_route fails closed on invalid or low-confidence selector output", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-auto-route-fail-closed-"));
  const runner = new ScriptedRunner(["not json"]);
  const daemon = await startDaemonForTest(runner, {}, { channels: { autoRoute: true } });
  try {
    const channel = await createAutoRouteTestChannel(daemon.url, cwd);

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个交给谁回复？",
    });

    assert.equal(created.aiReply, undefined);
    assert.equal(runner.runs.length, 1);
    let decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(created.message.id)}`);
    assert.equal(decisions.decisions[0].status, "failed");
    assert.equal(decisions.decisions[0].createdBy, "model");

    runner.responses.push(JSON.stringify({
      action: "reply",
      teammateId: "teammate_builtin_designer",
      confidence: 0.2,
      reason: "Unsure.",
      alternativesConsidered: [],
    }));
    const lowConfidence = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个 UI 问题可以自动判断吗？",
    });
    assert.equal(lowConfidence.aiReply, undefined);
    decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(lowConfidence.message.id)}`);
    assert.equal(decisions.decisions[0].status, "suppressed");
    assert.equal(decisions.decisions[0].reason, "Route model confidence was below threshold.");

    runner.responses.push(`Here is the decision: ${JSON.stringify({
      action: "reply",
      teammateId: "teammate_builtin_designer",
      confidence: 0.9,
      reason: "Wrapped JSON should fail strict parsing.",
      alternativesConsidered: [],
    })}`);
    const wrappedJson = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个带解释的模型输出应该失败吗？",
    });
    assert.equal(wrappedJson.aiReply, undefined);
    decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(wrappedJson.message.id)}`);
    assert.equal(decisions.decisions[0].status, "failed");
    assert.match(decisions.decisions[0].errorMessage, /strict JSON object/);

    runner.responses.push(JSON.stringify({
      action: "reply",
      teammateId: "teammate_missing",
      confidence: 0.9,
      reason: "Unknown teammate should fail closed.",
      alternativesConsidered: [],
    }));
    const unknownTeammate = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "这个未知 teammate 应该失败吗？",
    });
    assert.equal(unknownTeammate.aiReply, undefined);
    decisions = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/message-route-decisions?cwd=${encodeURIComponent(cwd)}&sourceMessageId=${encodeURIComponent(unknownTeammate.message.id)}`);
    assert.equal(decisions.decisions[0].status, "failed");
    assert.match(decisions.decisions[0].errorMessage, /unknown teammate/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel AI replies return pending message before runner finishes", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-ai-reply-pending-"));
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

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
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
    const pending = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`);
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
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-attachments-"));
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

test("channel asset references must stay within the same channel", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-reference-"));
  const daemon = await startDaemonForTest();
  try {
    const first = await createChannel(daemon.url, cwd);
    const second = await createChannel(daemon.url, cwd);
    const message = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
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

    const crossMessage = await fetch(`${daemon.url}/channels/${encodeURIComponent(second.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
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

test("channel collaboration protocol endpoints persist state and reject cross-channel sources", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-protocol-api-"));
  const daemon = await startDaemonForTest();
  try {
    const first = await createChannel(daemon.url, cwd);
    const second = await createChannel(daemon.url, cwd);
    const message = await postJson(`${daemon.url}/channels/${encodeURIComponent(first.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Use manual handoffs for v1.1.",
    });
    const otherMessage = await postJson(`${daemon.url}/channels/${encodeURIComponent(second.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
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

    const createdWorkflow = await postJson(`${daemon.url}/handoffs/${encodeURIComponent(handoff.handoff.id)}/workflow?cwd=${encodeURIComponent(cwd)}`, {
      createdBy: "local-user",
    });
    assert.equal(createdWorkflow.workflow.status, "draft");
    assert.equal(createdWorkflow.workflowStep.status, "queued");

    const started = await postJson(`${daemon.url}/workflow-steps/${encodeURIComponent(createdWorkflow.workflowStep.id)}/start?cwd=${encodeURIComponent(cwd)}`, {
      mode: "create_task",
      taskTitle: "Workflow generated task",
    });
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
    const blockedWorkflow = await postJson(`${daemon.url}/handoffs/${encodeURIComponent(secondHandoff.handoff.id)}/workflow?cwd=${encodeURIComponent(cwd)}`, {
      createdBy: "local-user",
    });
    const blocked = await postJson(`${daemon.url}/workflow-steps/${encodeURIComponent(blockedWorkflow.workflowStep.id)}/start?cwd=${encodeURIComponent(cwd)}`, {
      mode: "create_and_run_task",
    });
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
        executionMode: "serial",
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
    assert.ok(firstStepAfterFirstTick.runId);
    const firstRun = await getJson(`${daemon.url}/runs/${encodeURIComponent(firstStepAfterFirstTick.runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(firstRun.workflowStepId, firstStepAfterFirstTick.id);
    assert.equal(firstRun.requestSnapshot.workflowStepId, firstStepAfterFirstTick.id);
    assert.equal(firstRun.requestSnapshot.runnerResolution.requestSource, "workflow_step");
    const runsForStep = await getJson(`${daemon.url}/runs?cwd=${encodeURIComponent(cwd)}&workflowStepId=${encodeURIComponent(firstStepAfterFirstTick.id)}`);
    assert.deepEqual(runsForStep.runs.map((run) => run.id), [firstRun.id]);
    const threadsForStep = await getJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&workflowStepId=${encodeURIComponent(firstStepAfterFirstTick.id)}`);
    assert.equal(threadsForStep.threads.length, 1);
    assert.equal(threadsForStep.threads[0].kind, "workflow_step");
    assert.equal(threadsForStep.threads[0].workflowStepId, firstStepAfterFirstTick.id);
    assert.equal(threadsForStep.threads[0].lastRunId, firstRun.id);

    await waitForCondition(() => runner.runs.length === 4, "autoplan-lite planning runner sequence");
    const implementationTick = await approveWorkflowStepGate(daemon.url, cwd, compiled.workflow.id, "implementation");
    assert.equal(implementationTick.status, "started");
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
    assert.match(runner.runs[0].task.prompt, /Workflow context packet: pending until run starts/);
    assert.match(runner.runs[0].task.prompt, /Dependencies:\n- none/);
    assert.match(runner.runs[0].task.prompt, /Approval gates:\n- none/);
    const implementationRun = runner.runs.find((run) => run.task.title === "Implementation");
    assert.ok(implementationRun);
    assert.match(implementationRun.task.prompt, /Workflow context packet: pending until run starts/);
    assert.match(implementationRun.task.prompt, /Dependencies:/);
    assert.match(implementationRun.task.prompt, /Approval gates:\n- pre-run: mode=standard; risk=medium/);
    assert.match(implementationRun.task.prompt, /Design Review \(succeeded\)/);
    assert.match(implementationRun.task.prompt, /Engineering Review \(succeeded\)/);
    assert.ok(implementationRun.task.prompt.includes(designStep.metadata.outputArtifactId));
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
    assert.equal(implementationTick.status, "started");
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
    const nextTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(nextTick.status, "started");
    assert.equal(nextTick.workflowStep.metadata.templateStepId, "product-review");
    const discoveryAfterApproval = await waitForWorkflowStepStatus(daemon.url, cwd, compiled.workflow.id, discoveryStep.id, "succeeded");
    assert.equal(discoveryAfterApproval.metadata.activeGateStage, undefined);
    assert.ok(discoveryAfterApproval.metadata.outputArtifactId);
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
    const deniedTick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(deniedTick.status, "blocked");
    assert.equal(deniedTick.workflowStep.id, implementationStep.id);
    assert.match(deniedTick.blocker, /revision/);
    const blockedStep = await waitForWorkflowTemplateStepStatus(daemon.url, cwd, compiled.workflow.id, "implementation", "blocked");
    assert.equal(blockedStep.metadata.policy.onApprovalDenied, "block_for_user");
    const workflow = await getJson(`${daemon.url}/workflows/${encodeURIComponent(compiled.workflow.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(workflow.workflow.status, "blocked");
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
        executionMode: "parallel",
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

    const tick = await postJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(tick.status, "started");
    assert.equal(tick.startedSteps.length, 2);
    assert.deepEqual(tick.startedSteps.map((item) => item.workflowStep.id).sort(), [firstStep.id, secondStep.id].sort());
    await runner.waitUntilStarted(2);
    const steps = await getJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/steps?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(steps.workflowSteps.map((step) => step.status).sort(), ["running", "running"]);
  } finally {
    runner.resolveAll("parallel cleanup");
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
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
        executionMode: "parallel",
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
        executionMode: "parallel",
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
    await runner.waitUntilStarted(2);
    assert.deepEqual(runner.runs.map((run) => run.task.title).sort(), ["Branch A", "Branch B"]);
  } finally {
    runner.resolveAll("custom parallel cleanup");
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow orchestrator keeps serial behavior without parallel runtime policy", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workflow-serial-budget-"));
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
    const channel = await createWorkflowTestChannel(daemon.url, cwd, "Serial budget workflow");
    await patchJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}?cwd=${encodeURIComponent(cwd)}`, {
      name: channel.name,
      status: channel.status,
      boundPath: channel.boundPath,
      defaultProviderPresetId: provider.id,
      defaultTeammateId: channel.defaultTeammateId,
      allowedTools: ["read"],
      runtimePolicy: channel.runtimePolicy,
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
    await runner.waitUntilStarted(1);
    const steps = await getJson(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/steps?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(steps.workflowSteps.map((step) => step.status).sort(), ["queued", "running"]);
  } finally {
    runner.resolveAll("serial cleanup");
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
        executionMode: "parallel",
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
        executionMode: "parallel",
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
    assert.match(preview.linkPreview.errorMessage, /localhost/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("AI teammate private workspace endpoints persist roster, setup, private messages, and activity", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ai-teammate-api-"));
  let daemon = await startDaemonForTest();
  try {
    const seeded = await getJson(`${daemon.url}/teammates?cwd=${encodeURIComponent(cwd)}&includeHidden=true&includeDisabled=true`);
    assert.ok(seeded.teammates.some((item) => item.id === "teammate_builtin_engineer"));

    const channel = await createChannel(daemon.url, cwd);
    const created = await postJson(`${daemon.url}/teammates?cwd=${encodeURIComponent(cwd)}`, {
      roleKey: "custom",
      displayName: "Private Reviewer",
      description: "Reviews private workspace notes.",
      allowedTools: ["read"],
      approvalProfile: { mode: "none" },
      status: "active",
    });
    const teammateId = created.teammate.id;

    const memberships = await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id, isDefault: true }],
    });
    assert.deepEqual(memberships.memberships.map((item) => [item.channelId, item.isDefault]), [[channel.id, true]]);

    const skills = await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/skills?cwd=${encodeURIComponent(cwd)}`, {
      bindings: [{ skillId: "review", source: "user", enabled: true }],
    });
    assert.deepEqual(skills.bindings.map((item) => item.skillId), ["review"]);

    const memory = await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/memory-scopes?cwd=${encodeURIComponent(cwd)}`, {
      scopes: [
        { kind: "private-chat-summary", enabled: true },
        { kind: "channel-brief", channelId: channel.id, enabled: true },
      ],
    });
    assert.deepEqual(memory.scopes.map((item) => item.kind), ["private-chat-summary", "channel-brief"]);

    const task = (await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      title: "Review private workspace",
      prompt: "Verify private chat state.",
      assigneeTeammateId: teammateId,
    })).task;
    const teammateTasks = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/tasks?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(teammateTasks.tasks.map((item) => item.id), [task.id]);

    const message = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Please review this private workspace.",
      requestAiReply: true,
    });
    assert.equal(message.message.status, "ready");
    assert.equal(message.aiReply.status, "blocked");
    assert.match(message.aiReply.errorMessage, /provider preset/i);

    const listedMessages = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(listedMessages.messages.map((item) => item.id), [message.message.id, message.aiReply.id]);

    const activity = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/activity?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(activity.items.some((item) => item.kind === "direct-message" && item.sourceId === message.message.id));
    assert.ok(activity.items.some((item) => item.kind === "task" && item.sourceId === task.id));

    await daemon.close();
    daemon = await startDaemonForTest();

    const restartedRoster = await getJson(`${daemon.url}/teammates?cwd=${encodeURIComponent(cwd)}&includeHidden=true&includeDisabled=true`);
    assert.ok(restartedRoster.teammates.some((item) => item.id === teammateId && item.displayName === "Private Reviewer"));
    const restartedChannels = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(restartedChannels.memberships.map((item) => [item.channelId, item.isDefault]), [[channel.id, true]]);
    const restartedMessages = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(restartedMessages.messages.map((item) => item.id), [message.message.id, message.aiReply.id]);
    const restartedTasks = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/tasks?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(restartedTasks.tasks.map((item) => item.id), [task.id]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("AI teammate private reply waits for startup provider refresh instead of using stale timeout", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-direct-provider-startup-refresh-"));
  const relay = await startMockOpenAICompatibleServer();
  const runner = new RecordingRunner();
  let daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd, {
      kind: "openai-compatible",
      displayName: "中转站",
      providerId: "relay",
      model: "relay-chat",
      api: "openai-completions",
      baseUrl: `${relay.url}/v1`,
      authHeader: true,
      apiKey: "local-relay-secret",
    })).provider;
    const teammateId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    await daemon.close();

    const store = createSqliteRunStore(cwd);
    try {
      store.recordProviderCheckResult(provider.id, {
        ok: false,
        code: "network_failed",
        message: "Provider network check failed: The operation was aborted due to timeout",
        checkedAt: "2026-05-01T00:00:00.000Z",
      });
    } finally {
      store.close();
    }

    daemon = await startDaemonForTest(runner);
    const created = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "重启后直接发一条私聊。",
      requestAiReply: true,
    });

    assert.equal(created.aiReply.status, "ready");
    assert.equal(created.aiReply.body, "Designer reply");
    assert.equal(runner.runs.length, 1);
    assert.equal(relay.requests.some((request) => request.method === "POST" && request.path === "/v1/chat/completions"), true);

    const refreshed = await getJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(refreshed.provider.lastCheck.ok, true);
    assert.equal(refreshed.provider.lastCheck.code, "ready");
  } finally {
    await daemon.close();
    await relay.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace settings API persists UI preferences in .ling-stack state", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workspace-settings-api-"));
  const daemon = await startDaemonForTest();
  try {
    const initial = await getJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(initial.settings.schemaVersion, 1);
    assert.equal(initial.settings.workspaceCwd, undefined);

    const patched = await patchJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`, {
      workspaceCwd: cwd,
      theme: "dark",
      locale: "zh-CN",
      channelNotifications: { channel_one: "mentions" },
      channelActivityViews: { channel_one: [{ id: "custom:review", name: "Review" }] },
    });
    assert.equal(patched.settings.workspaceCwd, cwd);
    assert.equal(patched.settings.theme, "dark");
    assert.equal(patched.settings.locale, "zh-CN");
    assert.equal(patched.settings.channelNotifications.channel_one, "mentions");

    const reopened = await getJson(`${daemon.url}/workspace-settings?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(reopened.settings.theme, "dark");
    assert.equal(reopened.settings.channelActivityViews.channel_one[0].id, "custom:review");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel workspace API supports local and external path handoff", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-workspace-api-"));
  const externalPath = resolve(cwd, "external-workspace");
  const daemon = await startDaemonForTest();
  try {
    await mkdir(externalPath, { recursive: true });
    const channel = await createChannel(daemon.url, cwd);
    const initial = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(initial.binding.mode, "managed_worktree");
    assert.equal(initial.binding.status, "ready");
    assert.equal(initial.binding.branchName, `ling/channel-${channel.id}`);
    assert.equal(initial.snapshot.workspaceCwd, cwd);
    assert.match(initial.snapshot.executionCwd, /\.ling-stack\/worktrees\/channels\//);
    await access(initial.snapshot.executionCwd);

    const external = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace/handoff?cwd=${encodeURIComponent(cwd)}`, {
      mode: "external_path",
      executionPath: externalPath,
    });
    assert.equal(external.binding.mode, "external_path");
    assert.equal(external.binding.status, "ready");
    assert.equal(external.snapshot.executionCwd, externalPath);

    await rm(externalPath, { recursive: true, force: true });
    const refreshed = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace/refresh?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(refreshed.binding.status, "missing");

    const local = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/workspace/handoff?cwd=${encodeURIComponent(cwd)}`, {
      mode: "local",
    });
    assert.equal(local.binding.mode, "local");
    assert.equal(local.binding.status, "ready");
    assert.equal(local.snapshot.executionCwd, cwd);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel creation creates an isolated managed worktree by default", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-auto-worktree-"));
  const daemon = await startDaemonForTest();
  try {
    const first = await createChannel(daemon.url, cwd);
    const second = await createChannel(daemon.url, cwd);

    assert.equal(first.workspaceBinding?.mode, "managed_worktree");
    assert.equal(second.workspaceBinding?.mode, "managed_worktree");
    assert.equal(first.workspaceBinding?.status, "ready");
    assert.equal(second.workspaceBinding?.status, "ready");
    assert.equal(first.workspaceBinding?.branchName, `ling/channel-${first.id}`);
    assert.equal(second.workspaceBinding?.branchName, `ling/channel-${second.id}`);
    assert.notEqual(first.workspaceBinding?.worktreePath, second.workspaceBinding?.worktreePath);
    assert.match(first.workspaceBinding?.worktreePath ?? "", /\.ling-stack\/worktrees\/channels\//);
    await access(first.workspaceBinding?.worktreePath ?? "");
    await access(second.workspaceBinding?.worktreePath ?? "");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel creation fails without persisting when cwd is not a Git repository", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-worktree-nongit-"));
  const daemon = await startDaemonForTest();
  try {
    const response = await fetch(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Engineering",
        boundPath: cwd,
        allowedTools: ["read"],
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "not_git_repository");
    assert.match(body.message, /无法创建独立频道工作区/);

    const listed = await getJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(listed.channels, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("memory API scopes lexical recall and channel replies audit used memory", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-memory-api-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const otherChannel = await createChannel(daemon.url, cwd);
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    const check = await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(check.ok, true);
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_designer")}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    const channelMemory = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Model Workbench width",
      body: "Model Workbench should use the same horizontal width as other pages.",
      tags: ["model-workbench"],
    })).memory;
    const teammateMemory = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "teammate",
      ownerId: "teammate_builtin_designer",
      title: "Designer private width preference",
      body: "Designer private memory says Model Workbench width should stay aligned.",
      sensitivity: "private",
    })).memory;
    await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "teammate",
      ownerId: "teammate_builtin_engineer",
      title: "Engineer private width preference",
      body: "Engineer private memory also mentions Model Workbench width.",
      sensitivity: "private",
    });
    await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: otherChannel.id,
      title: "Other channel width",
      body: "Other channel also mentions Model Workbench width.",
    });
    await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "workspace",
      ownerId: "workspace_default",
      title: "Secret memory",
      body: "Secret-adjacent Model Workbench token.",
      sensitivity: "secret-adjacent",
    });

    const listed = await getJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.vectorRetrieval.status, "not_installed");
    assert.equal(listed.vectorRetrieval.optional, true);

    const recall = await postJson(`${daemon.url}/memory/recall?cwd=${encodeURIComponent(cwd)}`, {
      teammateId: "teammate_builtin_designer",
      channelId: channel.id,
      intent: "channel-reply",
      query: "model workbench width",
    });
    assert.ok(recall.memories.some((item) => item.memory.id === channelMemory.id));
    assert.ok(recall.memories.some((item) => item.memory.id === teammateMemory.id));
    assert.equal(recall.memories.some((item) => item.memory.ownerId === otherChannel.id), false);
    assert.equal(recall.memories.some((item) => item.memory.ownerId === "teammate_builtin_engineer"), false);
    assert.equal(recall.memories.some((item) => item.memory.sensitivity === "secret-adjacent"), false);

    const created = await postJson(`${daemon.url}/channels/${encodeURIComponent(channel.id)}/messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "@Designer fix Model Workbench width",
      mentions: [{ id: "designer", label: "Designer", kind: "ai-teammate" }],
      requestAiReply: true,
    });
    assert.equal(created.aiReply.status, "pending");
    await waitForChannelMessageStatus(daemon.url, cwd, channel.id, created.aiReply.id, "ready");
    assert.match(runner.runs[0].systemPrompt, /Used memory:/);
    assert.match(runner.runs[0].systemPrompt, /Model Workbench width/);

    const used = await getJson(`${daemon.url}/memory/used?cwd=${encodeURIComponent(cwd)}&responseId=${encodeURIComponent(created.aiReply.id)}`);
    assert.ok(used.events[0].memoryIds.includes(channelMemory.id));
    assert.ok(used.events[0].memoryIds.includes(teammateMemory.id));
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("memory review policy exposes promotion inbox and gates candidate recall", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-memory-review-policy-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);

    const defaultPolicy = await getJson(`${daemon.url}/memory/review-policy?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(defaultPolicy.policy.mode, "balanced");
    assert.equal(defaultPolicy.policy.requireManualForWorkspace, true);

    const patchedPolicy = await patchJson(`${daemon.url}/memory/review-policy?cwd=${encodeURIComponent(cwd)}`, {
      mode: "conservative",
      autoActiveSameScope: false,
    });
    assert.equal(patchedPolicy.policy.mode, "conservative");
    assert.equal(patchedPolicy.policy.autoActiveSameScope, false);

    const candidate = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Review gated memory",
      body: "Review gated memory should only be recalled after approval.",
      reviewState: "candidate",
      sourceRefs: [{ type: "run-event", id: "run_event_1", label: "Reflection job" }],
    })).memory;

    const blockedRecall = await postJson(`${daemon.url}/memory/recall?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      intent: "channel-reply",
      query: "review gated memory",
    });
    assert.equal(blockedRecall.memories.some((item) => item.memory.id === candidate.id), false);

    const inbox = await getJson(`${daemon.url}/memory/promotion-inbox?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(inbox.items.some((item) => item.memory.id === candidate.id), true);
    const inboxItem = inbox.items.find((item) => item.memory.id === candidate.id);
    assert.equal(inboxItem.recommendedAction, "approve");
    assert.match(inboxItem.sourceSummary, /run-event:Reflection job/);

    const approved = await postJson(`${daemon.url}/memory/${encodeURIComponent(candidate.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "approve",
      reason: "Verified source event.",
    });
    assert.equal(approved.memory.reviewState, "active");
    assert.equal(approved.memory.enabled, true);
    assert.equal(approved.action.previousReviewState, "candidate");
    assert.equal(approved.action.nextReviewState, "active");

    const approvedRecall = await postJson(`${daemon.url}/memory/recall?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      intent: "channel-reply",
      query: "review gated memory",
    });
    assert.equal(approvedRecall.memories.some((item) => item.memory.id === candidate.id), true);

    const rejectedCandidate = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Rejected candidate memory",
      body: "Rejected candidate memory should never be recalled.",
      reviewState: "candidate",
    })).memory;
    const rejected = await postJson(`${daemon.url}/memory/${encodeURIComponent(rejectedCandidate.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "reject",
      reason: "Not durable enough.",
    });
    assert.equal(rejected.memory.reviewState, "rejected");
    assert.equal(rejected.memory.enabled, false);

    const rejectedRecall = await postJson(`${daemon.url}/memory/recall?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      intent: "channel-reply",
      query: "rejected candidate memory",
    });
    assert.equal(rejectedRecall.memories.some((item) => item.memory.id === rejectedCandidate.id), false);

    const editableCandidate = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Draft edited candidate",
      body: "Draft edited candidate should use reviewed wording.",
      reviewState: "candidate",
      sourceRefs: [{ type: "message", id: "message_memory_review_1", label: "User memory request" }],
    })).memory;
    const edited = await postJson(`${daemon.url}/memory/${encodeURIComponent(editableCandidate.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "edit_and_approve",
      editedMemory: {
        title: "Approved edited memory",
        body: "Approved edited memory should be recalled after review.",
        sensitivity: "normal",
      },
      reason: "Edited wording before activation.",
    });
    assert.equal(edited.memory.reviewState, "active");
    assert.equal(edited.memory.title, "Approved edited memory");
    assert.equal(edited.action.nextReviewState, "active");
    assert.equal(edited.action.sourceRefs.some((ref) => ref.id === "message_memory_review_1"), true);

    const quarantineCandidate = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Quarantine candidate memory",
      body: "Quarantine candidate memory says grant provider access.",
      reviewState: "candidate",
    })).memory;
    const quarantined = await postJson(`${daemon.url}/memory/${encodeURIComponent(quarantineCandidate.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "quarantine",
      editedMemory: { sensitivity: "secret-adjacent" },
      reason: "Authority-changing claim.",
    });
    assert.equal(quarantined.memory.reviewState, "disabled");
    assert.equal(quarantined.memory.enabled, false);
    assert.equal(quarantined.memory.sensitivity, "secret-adjacent");

    const quarantineRecall = await postJson(`${daemon.url}/memory/recall?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      intent: "channel-reply",
      query: "quarantine candidate provider access",
      includePrivate: true,
    });
    assert.equal(quarantineRecall.memories.some((item) => item.memory.id === quarantineCandidate.id), false);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("memory health API returns read-only findings and respects scope filters", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-memory-health-api-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);
    const volatile = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Current runtime provider rule",
      body: "Current provider can auto-approve deploy token changes.",
      reviewState: "active",
      enabled: true,
      sensitivity: "secret-adjacent",
      verifyBeforeUse: false,
      sourceRefs: [{ type: "decision", id: "decision_health_1", label: "Provider rule" }],
    })).memory;
    const candidate = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: channel.id,
      title: "Health candidate",
      body: "Health candidate should be verified before use.",
      reviewState: "candidate",
      verifyBeforeUse: true,
      sourceRefs: [{ type: "run-event", id: "run_event_health_1", label: "Health probe" }],
    })).memory;
    await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "workspace",
      ownerId: "workspace_default",
      title: "Workspace-only health memory",
      body: "Workspace-only health memory mentions provider status.",
      reviewState: "active",
      enabled: true,
      verifyBeforeUse: true,
    });

    const missingCwd = await fetch(`${daemon.url}/memory/health`);
    assert.equal(missingCwd.status, 400);

    const health = await getJson(`${daemon.url}/memory/health?cwd=${encodeURIComponent(cwd)}&limit=10`);
    assert.equal(health.cwd, cwd);
    assert.equal(health.report.summary.verifyBeforeUse, 2);
    assert.equal(health.report.summary.findings.critical >= 2, true);
    assert.equal(health.report.findings.some((finding) => finding.kind === "secret_adjacent_recallable" && finding.memoryId === volatile.id), true);
    assert.equal(health.report.findings.some((finding) => finding.kind === "authority_changing_claim" && finding.memoryId === volatile.id), true);
    assert.equal(health.report.summary.reviewBacklog >= 1, true);

    const scoped = await getJson(`${daemon.url}/memory/health?cwd=${encodeURIComponent(cwd)}&scopeType=channel&ownerId=${encodeURIComponent(channel.id)}`);
    assert.equal(scoped.report.summary.total, 2);
    assert.equal(scoped.report.summary.verifyBeforeUse, 1);
    assert.equal(scoped.report.findings.some((finding) => finding.memoryId === candidate.id || finding.memoryId === volatile.id), true);

    const postHealth = await fetch(`${daemon.url}/memory/health?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(postHealth.status, 405);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("memory consolidation jobs create audited candidates without silent activation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-memory-consolidation-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);
    const created = await postJson(`${daemon.url}/memory/consolidation-jobs?cwd=${encodeURIComponent(cwd)}`, {
      kind: "task_run_lesson",
      sourceScopeType: "channel",
      userExplicitRemember: true,
      confidence: "high",
      candidate: {
        scopeType: "channel",
        ownerId: channel.id,
        title: "Consolidated run lesson",
        body: "When Model Workbench width regresses, check the workspace frame before editing cards.",
        tags: ["model-workbench"],
        sourceRefs: [{ type: "run-event", id: "run_event_consolidation_1", label: "Run succeeded" }],
      },
    });
    assert.equal(created.job.status, "succeeded");
    assert.equal(created.candidates.length, 1);
    assert.equal(created.decisions.length, 1);
    assert.deepEqual(created.job.createdCandidateIds, [created.candidates[0].id]);
    assert.equal(created.candidates[0].reviewState, "candidate");
    assert.equal(created.candidates[0].enabled, true);
    assert.equal(created.decisions[0].outcome, "auto-candidate");
    assert.equal(created.decisions[0].reasonCode, "consolidation_candidate_only");

    const recall = await postJson(`${daemon.url}/memory/recall?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      intent: "channel-reply",
      query: "consolidated run lesson model workbench width",
    });
    assert.equal(recall.memories.some((item) => item.memory.id === created.candidates[0].id), false);

    const inbox = await getJson(`${daemon.url}/memory/promotion-inbox?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(inbox.items.some((item) => item.memory.id === created.candidates[0].id), true);

    const listed = await getJson(`${daemon.url}/memory/consolidation-jobs?cwd=${encodeURIComponent(cwd)}&status=succeeded`);
    assert.equal(listed.jobs.some((job) => job.id === created.job.id), true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("task run validates requestedSkillId and records the selected skill", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-aware-run-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const channel = (await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Engineering",
      status: "active",
      boundPath: cwd,
      defaultTeammateId: "teammate_builtin_engineer",
      allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
      runtimePolicy: {
        maxConcurrentRuns: 1,
        executionMode: "serial",
        writeLockScope: "boundPath",
        allowReadOnlyParallel: true,
        queueOnConflict: true,
      },
    })).channel;
    const provider = (await createStaticChatProvider(daemon.url, cwd, { capabilities: ["chat", "tool_call"] })).provider;
    const task = (await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      title: "Implement skill-aware run",
      prompt: "Use the implement skill.",
      assigneeTeammateId: "teammate_builtin_engineer",
      requestedSkillId: "implement",
    })).task;
    const runId = await postTaskRunAndReadReadyRunId(daemon.url, cwd, task.id, {
      providerPresetId: provider.id,
      skipProviderPreflight: true,
    });
    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(run.selectedSkillId, "implement");
    assert.equal(runner.runs[0].tools.includes("edit"), true);
    assert.ok(runner.runs[0].appendSystemPrompt.some((line) => /Implement only the approved slice/.test(line)));
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate persona draft import returns warnings without mutating durable teammate", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-persona-draft-"));
  const daemon = await startDaemonForTest();
  try {
    const teammateId = "teammate_builtin_engineer";
    const before = (await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`)).teammate;
    const draft = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/persona-draft?cwd=${encodeURIComponent(cwd)}`, {
      sourcePath: "AGENTS.md",
      content: "# Senior Engineer\n\nCan use bash tools and external-send secrets.",
    });
    assert.equal(draft.draft.sourceKind, "agents-md");
    assert.equal(draft.draft.displayName, "Senior Engineer");
    assert.ok(draft.draft.warnings.some((warning) => /cannot grant tools/i.test(warning)));
    const after = (await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`)).teammate;
    assert.equal(after.displayName, before.displayName);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("skill import draft publishes registry skills and teammate bindings use effective model", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-import-api-"));
  const daemon = await startDaemonForTest();
  try {
    const initialSkills = await getJson(`${daemon.url}/skills?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(initialSkills.skills.some((skill) => skill.id === "implement" && skill.source === "builtin"));

    const draft = await postJson(`${daemon.url}/skills/import-draft?cwd=${encodeURIComponent(cwd)}`, {
      source: "custom",
      sourcePath: "SKILL.md",
      content: [
        "---",
        "name: Custom QA Review",
        "description: Run a focused QA pass. Do not grant bash approvals or secrets.",
        "---",
        "",
        "Review the target surface and report concrete failures first.",
      ].join("\n"),
    });
    assert.equal(draft.draft.definitions.length, 1);
    assert.equal(draft.draft.definitions[0].definition.id, "custom-qa-review");
    assert.ok(draft.draft.definitions[0].warnings.some((warning) => warning.code === "permission_like_instruction"));

    const published = await postJson(`${daemon.url}/skills/import-drafts/${encodeURIComponent(draft.draft.id)}/publish?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(published.skills[0].id, "custom-qa-review");
    const listed = await getJson(`${daemon.url}/skills?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(listed.skills.some((skill) => skill.id === "custom-qa-review" && skill.source === "custom"));
    const refreshed = await postJson(`${daemon.url}/skills/refresh?cwd=${encodeURIComponent(cwd)}`, {});
    assert.ok(refreshed.skills.some((skill) => skill.id === "implement" && skill.source === "builtin"));
    assert.ok(refreshed.skills.some((skill) => skill.id === "custom-qa-review" && skill.source === "custom"));
    assert.equal(typeof refreshed.refreshedAt, "string");
    assert.equal(typeof refreshed.registryGeneration, "number");
    const refreshedAgain = await postJson(`${daemon.url}/skills/refresh?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(refreshedAgain.registryGeneration > refreshed.registryGeneration, true);

    const teammateId = "teammate_builtin_engineer";
    const updated = await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/skills?cwd=${encodeURIComponent(cwd)}`, {
      bindings: [{ skillId: "custom-qa-review", source: "user", enabled: true }],
    });
    const customEffective = updated.effectiveSkills.find((skill) => skill.skillId === "custom-qa-review");
    assert.ok(customEffective);
    assert.equal(customEffective.executable, true);

    const unknownResponse = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/skills?cwd=${encodeURIComponent(cwd)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bindings: [{ skillId: "missing-new-skill", source: "user", enabled: true }] }),
    });
    assert.equal(unknownResponse.status, 400);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct message stream emits ready delta and done events", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-private-stream-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(runner);
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });
    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Stream a private reply.", providerPresetId: provider.id }),
    });
    assert.equal(response.status, 200);
    const events = parseSseEvents(await response.text());
    assert.deepEqual(events.map((event) => event.event), ["ready", "delta", "done"]);
    assert.equal(events[1].data.delta, "Designer reply");
    assert.equal(events[2].data.aiReply.body, "Designer reply");
    const listed = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.messages.at(-1).body, "Designer reply");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct reply cancel aborts active reply and marks pending message cancelled", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-private-cancel-"));
  const runner = new AbortableDelayedRunner();
  const daemon = await startDaemonForTest(runner);
  const streamController = new AbortController();
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_designer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });

    const response = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Start a cancellable private reply.", providerPresetId: provider.id }),
      signal: streamController.signal,
    });
    assert.equal(response.status, 200);
    await waitForCondition(() => runner.runs.length === 1, "private reply runner to start");

    const runtime = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-runtime?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(runtime.activeReply.status, "running");
    assert.ok(runtime.activeReply.workUnitId);
    assert.ok(runtime.activeReply.messageId);

    const cancelled = await postJson(`${daemon.url}/teammate-direct-replies/${encodeURIComponent(runtime.activeReply.workUnitId)}/cancel?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(cancelled.workUnit.status, "cancelled");
    assert.equal(cancelled.message.status, "cancelled");
    assert.equal(cancelled.message.body, "回复已停止");
    assert.equal(runner.abortCount, 1);

    runner.resolve("Late private reply");
    await response.text().catch(() => "");
    const listed = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    const aiReply = listed.messages.find((message) => message.id === runtime.activeReply.messageId);
    assert.equal(aiReply.status, "cancelled");
    assert.equal(aiReply.body, "回复已停止");
  } finally {
    streamController.abort();
    runner.resolve("cleanup");
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct queued guidance can promote to immediate continuation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-private-promote-guidance-"));
  const runner = new AbortableDelayedRunner();
  const daemon = await startDaemonForTest(runner);
  const streamController = new AbortController();
  try {
    const provider = (await createStaticChatProvider(daemon.url, cwd)).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
    const teammateId = "teammate_builtin_engineer";
    await patchJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: provider.id,
    });

    const streamResponse = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Start thinking.", providerPresetId: provider.id }),
      signal: streamController.signal,
    });
    assert.equal(streamResponse.status, 200);
    await waitForCondition(() => runner.runs.length === 1, "direct reply to start");

    const runtime = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-runtime?cwd=${encodeURIComponent(cwd)}`);
    assert.ok(runtime.activeReply?.workUnitId);
    const queued = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-interventions?cwd=${encodeURIComponent(cwd)}`, {
      mode: "queue_followup",
      instruction: "Use this queued guidance immediately.",
      idempotencyKey: "test-promote-queued-guidance",
    });
    assert.equal(queued.intervention.status, "queued");

    const promoted = await postJson(`${daemon.url}/teammate-direct-interventions/${encodeURIComponent(queued.intervention.id)}/promote?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(promoted.intervention.id, queued.intervention.id);
    assert.equal(promoted.intervention.status, "cancelling_source");
    assert.equal(runner.abortCount, 1);
    await waitForCondition(() => runner.runs.length === 2, "promoted continuation to start");
    assert.equal(runner.runs[1].task.prompt.includes("Use this queued guidance immediately."), true);
    assert.equal(runner.runs[1].task.prompt.includes("排队引导"), true);

    const listed = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-interventions?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.interventions.filter((item) => item.id === queued.intervention.id).length, 1);
    assert.equal(listed.interventions.some((item) => item.status === "queued"), false);

    runner.resolve("Promoted continuation reply");
    await streamResponse.text().catch(() => "");
    const messages = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    const cancelledReply = messages.messages.find((message) => message.id === runtime.activeReply.messageId);
    assert.equal(cancelledReply.status, "cancelled");
  } finally {
    streamController.abort();
    runner.resolve("cleanup");
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("private attachments avatar and hard delete stay scoped to teammate private data", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-private-attachments-hard-delete-"));
  const daemon = await startDaemonForTest();
  try {
    const channel = await createChannel(daemon.url, cwd);
    const teammateId = "teammate_builtin_engineer";
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
      memberships: [{ channelId: channel.id, isDefault: true }],
    });
    const attachment = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-attachments?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "private-note.txt",
      contentBase64: Buffer.from("private note", "utf8").toString("base64"),
    });
    const content = await fetch(`${daemon.url}/attachments/${encodeURIComponent(attachment.attachment.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(await content.text(), "private note");
    const message = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "See the private note.",
      attachmentIds: [attachment.attachment.id],
    });
    assert.deepEqual(message.message.attachmentIds, [attachment.attachment.id]);
    const avatar = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/avatar?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "avatar.png",
      contentBase64: Buffer.from("png", "utf8").toString("base64"),
    });
    assert.equal(avatar.teammate.avatarImageAttachmentId, avatar.attachment.id);
    const crossScope = await fetch(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_designer")}/direct-messages?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "bad", attachmentIds: [attachment.attachment.id] }),
    });
    assert.equal(crossScope.status, 400);
    assert.match((await crossScope.json()).message, /does not belong/i);

    const memory = await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "teammate",
      ownerId: teammateId,
      title: "Hard delete private memory",
      body: "This memory should disappear.",
      sensitivity: "private",
    });
    const task = (await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.id,
      title: "Assigned before delete",
      prompt: "Keep task history.",
      assigneeTeammateId: teammateId,
    })).task;

    const deleted = await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/hard-delete?cwd=${encodeURIComponent(cwd)}`, {
      reason: "test delete",
    });
    assert.equal(deleted.tombstone.entityId, teammateId);
    assert.equal(deleted.tombstone.deletedCounts.privateAttachments, 2);
    const missingMessages = await fetch(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(missingMessages.status, 404);
    const missingContent = await fetch(`${daemon.url}/attachments/${encodeURIComponent(attachment.attachment.id)}/content?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(missingContent.status, 404);
    const updatedTask = (await getJson(`${daemon.url}/tasks/${encodeURIComponent(task.id)}?cwd=${encodeURIComponent(cwd)}`)).task;
    assert.equal(updatedTask.assigneeTeammateId, undefined);
    const recall = await postJson(`${daemon.url}/memory/recall?cwd=${encodeURIComponent(cwd)}`, {
      teammateId,
      intent: "private-chat",
      query: "Hard delete private memory",
      includePrivate: true,
    });
    assert.equal(recall.memories.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

class RecordingRunner {
  constructor() {
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push(options);
    options.onEvent?.({ type: "assistant_text_delta", text: "Designer reply" });
    return {
      taskId: options.task.id,
      messages: ["Designer reply"],
      events: [],
    };
  }
}

class ScriptedRunner {
  constructor(responses) {
    this.responses = responses.slice();
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push(options);
    const response = this.responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    const text = response ?? "";
    options.onEvent?.({ type: "assistant_text_delta", text });
    return {
      taskId: options.task.id,
      messages: [text],
      events: [],
    };
  }
}

class SelectiveFailingRunner {
  constructor(failingTitles) {
    this.failingTitles = new Set(failingTitles);
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push(options);
    if (this.failingTitles.has(options.task.title)) {
      throw new Error(`${options.task.title} failed by test runner`);
    }
    options.onEvent?.({ type: "assistant_text_delta", text: `${options.task.title} complete` });
    return {
      taskId: options.task.id,
      messages: [`${options.task.title} complete`],
      events: [],
    };
  }
}

class DelayedRunner {
  constructor() {
    this.runs = [];
    this.completed = false;
    this.pending = undefined;
  }

  async runTask(options) {
    this.runs.push(options);
    const text = await new Promise((resolve) => {
      this.pending = resolve;
    });
    this.completed = true;
    options.onEvent?.({ type: "assistant_text_delta", text });
    return {
      taskId: options.task.id,
      messages: [text],
      events: [],
    };
  }

  resolve(text) {
    this.pending?.(text);
    this.pending = undefined;
  }
}

class AbortableDelayedRunner {
  constructor() {
    this.runs = [];
    this.abortCount = 0;
    this.pending = undefined;
  }

  async runTask(options) {
    this.runs.push(options);
    const text = await new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      options.signal?.addEventListener("abort", () => {
        this.abortCount += 1;
        reject(new Error("aborted by test"));
      }, { once: true });
    });
    options.onEvent?.({ type: "assistant_text_delta", text });
    return {
      taskId: options.task.id,
      messages: [text],
      events: [],
    };
  }

  resolve(text) {
    this.pending?.resolve(text);
    this.pending = undefined;
  }
}

class ParallelDelayedRunner {
  constructor() {
    this.runs = [];
    this.pendingResolvers = [];
    this.startedResolvers = [];
  }

  async runTask(options) {
    this.runs.push(options);
    this.startedResolvers.splice(0).forEach((resolveStarted) => resolveStarted());
    const text = await new Promise((resolve) => {
      this.pendingResolvers.push(resolve);
    });
    options.onEvent?.({ type: "assistant_text_delta", text });
    return {
      taskId: options.task.id,
      messages: [text],
      events: [],
    };
  }

  async waitUntilStarted(count) {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (this.runs.length >= count) {
        return;
      }
      await new Promise((resolve) => {
        this.startedResolvers.push(resolve);
        setTimeout(resolve, 20);
      });
    }
    assert.fail(`Timed out waiting for ${count} parallel runs. Started: ${this.runs.length}`);
  }

  resolveAll(text) {
    this.pendingResolvers.splice(0).forEach((resolvePending) => resolvePending(text));
  }
}

function testDaemonConfig(cwd) {
  return {
    host: "127.0.0.1",
    port: 0,
    maxBodyBytes: 1024 * 1024,
    defaultWorkspaceCwd: cwd,
    runners: {},
    runtimeTools: {},
    channels: { autoRoute: false },
  };
}

function unusedRunnerRegistry() {
  return {
    get() {
      return undefined;
    },
    list() {
      return [];
    },
    resolve() {
      throw new Error("runner registry should not be used by deterministic route test");
    },
  };
}

async function startDaemonForTest(runner, dependencies = {}, config = {}) {
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, ...config }, {
    ...dependencies,
    ...(runner ? { runner } : {}),
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

function createParallelWorkflowStep(store, workflowId, title, metadata = {}) {
  return store.createChannelWorkflowStep(
    {
      workflowId,
      position: metadata.position ?? 1,
      title,
      prompt: `Complete ${title}.`,
      toParticipantId: "teammate_builtin_engineer",
      toParticipantLabel: "Engineer",
      status: metadata.status,
      metadata: {
        templateStepId: title.toLowerCase().replaceAll(" ", "-"),
        branchGroupId: metadata.branchGroupId,
        joinGroupId: metadata.joinGroupId,
        dependsOnStepIds: metadata.dependsOnStepIds,
        dependencyMode: metadata.dependencyMode,
        fanInPolicy: metadata.fanInPolicy,
        maxParallelSiblings: metadata.maxParallelSiblings,
        providerPresetId: metadata.providerPresetId,
      },
    },
    new Date().toISOString(),
  );
}

function customTemplate(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "custom-template",
    name: "Custom Template",
    steps: [],
    ...overrides,
  };
}

async function createChannel(baseUrl, cwd) {
  return (await postJson(`${baseUrl}/channels?cwd=${encodeURIComponent(cwd)}`, {
    name: "Engineering",
    status: "active",
    boundPath: cwd,
    allowedTools: ["read"],
    runtimePolicy: {
      maxConcurrentRuns: 1,
      executionMode: "serial",
      writeLockScope: "boundPath",
      allowReadOnlyParallel: true,
      queueOnConflict: true,
    },
  })).channel;
}

async function createWorkflowTestChannel(baseUrl, cwd, name) {
  return (await postJson(`${baseUrl}/channels?cwd=${encodeURIComponent(cwd)}`, {
    name,
    status: "active",
    boundPath: cwd,
    allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    runtimePolicy: {
      maxConcurrentRuns: 1,
      executionMode: "serial",
      writeLockScope: "boundPath",
      allowReadOnlyParallel: true,
      queueOnConflict: true,
    },
  })).channel;
}

async function createAutoRouteTestChannel(baseUrl, cwd) {
  const provider = (await createStaticChatProvider(baseUrl, cwd)).provider;
  await postJson(`${baseUrl}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`);
  const channel = (await postJson(`${baseUrl}/channels?cwd=${encodeURIComponent(cwd)}`, {
    name: "Design",
    status: "active",
    boundPath: cwd,
    defaultProviderPresetId: provider.id,
    autoReplyMode: "auto_route",
    allowedTools: ["read"],
  })).channel;
  const teammateId = "teammate_builtin_designer";
  await patchJson(`${baseUrl}/teammates/${encodeURIComponent(teammateId)}?cwd=${encodeURIComponent(cwd)}`, {
    providerPresetId: provider.id,
  });
  await putJson(`${baseUrl}/teammates/${encodeURIComponent(teammateId)}/channels?cwd=${encodeURIComponent(cwd)}`, {
    memberships: [{ channelId: channel.id }],
  });
  return channel;
}

async function createStaticChatProvider(baseUrl, cwd, overrides = {}) {
  return await postJson(`${baseUrl}/providers?cwd=${encodeURIComponent(cwd)}`, {
    kind: "glm",
    displayName: "Static Chat",
    providerId: "static-chat",
    model: "static-model",
    api: "google-generative-ai",
    capabilities: ["chat"],
    input: ["text"],
    authHeader: false,
    enabled: true,
    ...overrides,
  });
}

async function startMockOpenAICompatibleServer() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body: bodyText ? JSON.parse(bodyText) : {},
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-startup-refresh",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

async function postTaskRunAndReadReadyRunId(baseUrl, cwd, taskId, body) {
  const response = await fetch(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/run?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  const text = await response.text();
  const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data:") && line.includes("runId"));
  assert.ok(dataLine, text);
  return JSON.parse(dataLine.slice("data:".length).trim()).runId;
}

function parseSseEvents(text) {
  return text
    .split(/\n\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const eventLine = lines.find((line) => line.startsWith("event:"));
      const dataLine = lines.find((line) => line.startsWith("data:"));
      if (!eventLine || !dataLine) {
        return undefined;
      }
      return {
        event: eventLine.slice("event:".length).trim(),
        data: JSON.parse(dataLine.slice("data:".length).trim()),
      };
    })
    .filter(Boolean);
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function getArtifactJson(baseUrl, cwd, artifactId) {
  const response = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}/content?cwd=${encodeURIComponent(cwd)}`);
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function waitForChannelMessageStatus(baseUrl, cwd, channelId, messageId, status) {
  const deadline = Date.now() + 2_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await getJson(`${baseUrl}/channels/${encodeURIComponent(channelId)}/messages?cwd=${encodeURIComponent(cwd)}`);
    const message = latest.messages.find((item) => item.id === messageId);
    if (message?.status === status) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for channel message ${messageId} to become ${status}. Latest: ${JSON.stringify(latest)}`);
}

async function waitForCondition(predicate, label) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${label}.`);
}

async function waitForWorkflowStepStatus(baseUrl, cwd, workflowId, workflowStepId, status) {
  const deadline = Date.now() + 2_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await getJson(`${baseUrl}/workflows/${encodeURIComponent(workflowId)}/steps?cwd=${encodeURIComponent(cwd)}`);
    const step = latest.workflowSteps.find((candidate) => candidate.id === workflowStepId);
    if (step?.status === status) {
      return step;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for workflow step ${workflowStepId} to become ${status}. Latest: ${JSON.stringify(latest)}`);
}

async function waitForWorkflowTemplateStepStatus(baseUrl, cwd, workflowId, templateStepId, status) {
  const deadline = Date.now() + 2_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await getJson(`${baseUrl}/workflows/${encodeURIComponent(workflowId)}/steps?cwd=${encodeURIComponent(cwd)}`);
    const step = latest.workflowSteps.find((candidate) => candidate.metadata?.templateStepId === templateStepId);
    if (step?.status === status) {
      return step;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for workflow template step ${templateStepId} to become ${status}. Latest: ${JSON.stringify(latest)}`);
}

async function approveWorkflowStepGate(baseUrl, cwd, workflowId, templateStepId) {
  const deadline = Date.now() + 2_000;
  let approval;
  let step;
  while (Date.now() < deadline) {
    const steps = await getJson(`${baseUrl}/workflows/${encodeURIComponent(workflowId)}/steps?cwd=${encodeURIComponent(cwd)}`);
    step = steps.workflowSteps.find((candidate) => candidate.metadata?.templateStepId === templateStepId);
    assert.ok(step, `Expected workflow step for template step ${templateStepId}`);
    const approvals = await getJson(`${baseUrl}/approvals?cwd=${encodeURIComponent(cwd)}&status=pending&workflowStepId=${encodeURIComponent(step.id)}`);
    approval = approvals.approvals[0];
    if (approval) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(approval, `Expected pending approval for workflow step ${templateStepId}`);
  assert.equal(approval.workflowStepId, step.id);
  assert.equal(approval.actionType, "workflow_step");
  assert.equal(approval.payload.type, "workflow_step");
  assert.equal(approval.payload.workflowStepId, step.id);
  const actions = await getJson(`${baseUrl}/execution-actions?cwd=${encodeURIComponent(cwd)}&status=waiting_for_approval`);
  assert.equal(actions.actions.some((action) => action.approvalId === approval.id && action.targetRefs.some((ref) => ref.type === "workflow_step" && ref.id === step.id)), true);
  await postJson(`${baseUrl}/approvals/${encodeURIComponent(approval.id)}/approve?cwd=${encodeURIComponent(cwd)}`, {
    reason: `approve ${templateStepId}`,
  });
  return await postJson(`${baseUrl}/workflows/${encodeURIComponent(workflowId)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
}

async function postJson(url, body) {
  await ensureGitRepoForChannelPost(url, body);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function putJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}
