import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  createSqliteRunStore,
  DEFAULT_WORKSPACE_ID,
  projectConversationItemToChannelMessage,
} from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
import { prepareFixtureTaskInput } from "./support/prepared-input-fixture.mjs";
import {
  createConversationMediaGenerationToolDefinitions,
  createConversationMediaGenerationToolHandler,
  isConversationMediaGenerationEligible,
} from "../dist/features/media/conversation-tool-handler.js";
import {
  assertMediaGenerationDefaultUpdate,
  listConversationMediaGenerationTargets,
} from "../dist/features/media/conversation-targets.js";
import {
  buildConversationGeneratedMediaProjection,
  conversationMediaFailureCode,
} from "../dist/features/media/conversation-projection.js";
import { parseWorkspaceSettingsUpdate } from "../dist/features/settings/effective-config.js";
import {
  dispatchMediaJobExecution,
  recoverPendingConversationMediaWorkUnits,
  resumePendingMediaJobExecutions,
} from "../dist/features/media/executor.js";
import { runProviderMediaJobExecution } from "../dist/features/media/provider-executor.js";
import { runWorkflowMediaJobExecution } from "../dist/features/media/workflows/workflow-executor.js";
import { publishConversationMediaProjectionChange } from "../dist/features/media/conversation-events.js";
import { ControlPlaneEventHub } from "../dist/features/control-plane/events.js";
import { createChannelReplyContinuationProjection } from "../dist/features/channels/channel-reply-continuation.js";
import { buildChannelReplyContinuationContext } from "../dist/features/channels/channel-reply-continuation-context.js";
import { buildRunInterventionContinuationRequest } from "../dist/features/runs/run-intervention-continuation-request.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { MediaLocalExecutionRegistry } from "../dist/runtime/media-local-executions.js";
import {
  retryRuntimeWorkUnit,
  startRuntimeWorkUnit,
  transitionWorkUnitCancelled,
  transitionWorkUnitTerminal,
} from "../dist/runtime/work-units.js";

const now = "2026-08-11T01:00:00.000Z";

function publishReadyWorkflowConnection(store, connectionId, protocolVariant = "prompt_legacy") {
  const admission = store.beginMediaWorkflowConnectionCheck(connectionId);
  assert.ok(admission);
  const publication = store.commitMediaWorkflowConnectionCheck(admission.ticket, {
    ok: true,
    message: "Test workflow connection is ready.",
    checkedAt: now,
    protocolVariant,
    nodeCount: 2,
  }, now);
  assert.equal(publication.status, "published");
}

test("conversation media maps upstream content policy rejection without exposing provider details", () => {
  assert.equal(conversationMediaFailureCode("content_policy_blocked"), "generation_content_policy_blocked");
  assert.equal(
    conversationMediaFailureCode("invalid_request", '{"code":"moderation_blocked","request_id":"private"}'),
    "generation_content_policy_blocked",
  );
  assert.equal(
    conversationMediaFailureCode("invalid_request", "OpenAI Images response did not include image data."),
    "generation_result_unavailable",
  );
  assert.equal(conversationMediaFailureCode("media_result_unavailable"), "generation_result_unavailable");
  assert.equal(conversationMediaFailureCode("invalid_request"), "generation_configuration_required");
});

test("tool-only media generation is a successful visible result on every conversation path", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-tool-only-media-"));
  const store = createSqliteRunStore(cwd);
  const runner = new ToolOnlyMediaRunner();
  const imageServer = await startMockOpenAIImageServer();
  const continuationLocalExecutions = new MediaLocalExecutionRegistry();
  const continuationStoreRegistry = { getStore: () => store, mediaLocalExecutions: continuationLocalExecutions };
  let daemon;
  try {
    const { chatProvider, imageProvider } = configureToolOnlyMediaFixture(store, imageServer.url);
    daemon = createDaemonServer({
      host: "127.0.0.1",
      port: 0,
      defaultWorkspaceCwd: cwd,
      channels: { autoRoute: false, intentSelector: false, terminalReports: false },
    }, {
      runner,
      storeFactory(requestedCwd) {
        assert.equal(requestedCwd, cwd);
        return store;
      },
    });
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const normalResponse = await fetch(`${baseUrl}/conversations/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "请生成一张安静城市的图片",
        providerPresetId: chatProvider.id,
      }),
    });
    assert.equal(normalResponse.status, 200);
    const normalEvents = parseSseEvents(await normalResponse.text());
    const normalDone = normalEvents.findLast((event) => event.event === "done");
    assert.ok(normalDone);
    assert.equal(normalDone.data.assistantMessage.status, "succeeded");
    assert.equal(normalDone.data.assistantMessage.content, "");
    const normalDetail = await getJson(`${baseUrl}/conversations/${encodeURIComponent(normalDone.data.thread.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(normalDetail.generatedMedia.length, 1);
    assert.equal(normalDetail.messages.at(-1).status, "succeeded");
    assert.equal(normalDetail.messages.at(-1).content, "");

    const channel = store.createChannel({
      name: "Tool-only media",
      status: "active",
      boundPath: cwd,
      defaultProviderPresetId: chatProvider.id,
      responseLanguage: "zh-CN",
      allowedTools: ["read"],
    }, now);
    const channelResponse = await fetch(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/turns/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "请生成一张频道图片",
        requestAiReply: true,
        providerPresetId: chatProvider.id,
        teammateId: "ling_agent",
      }),
    });
    assert.equal(channelResponse.status, 200);
    const channelEvents = parseSseEvents(await channelResponse.text());
    const channelDone = channelEvents.findLast((event) => event.event === "done");
    assert.ok(channelDone);
    const channelReply = projectChannelReply(channelDone.data);
    assert.equal(channelReply.status, "ready");
    assert.equal(channelReply.body, "");
    assert.ok(runner.runs.at(-1).systemPrompt.includes("first-party media tools"));
    const channelDetail = await getJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/items?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(channelDetail.generatedMedia.filter((item) => item.messageId === channelReply.id).length, 1);

    const teammate = store.createAiTeammate({
      id: "teammate_tool_only_media",
      roleKey: "designer",
      displayName: "Media Designer",
      description: "Generates media in private chat.",
      modelBindingMode: "fixed",
      providerPresetId: chatProvider.id,
      allowedTools: ["read"],
      approvalProfile: { mode: "none" },
      status: "active",
    }, now);
    const directResponse = await fetch(`${baseUrl}/teammates/${encodeURIComponent(teammate.id)}/direct-messages/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "请生成一张私聊图片",
        providerPresetId: chatProvider.id,
        permissionPreset: "read_only",
      }),
    });
    assert.equal(directResponse.status, 200);
    const directEvents = parseSseEvents(await directResponse.text());
    const directDone = directEvents.findLast((event) => event.event === "done");
    assert.ok(directDone);
    const directReply = directDone.data.aiReply;
    assert.equal(directReply.status, "ready");
    assert.equal(directReply.body, "");
    const directDetail = await getJson(`${baseUrl}/teammates/${encodeURIComponent(teammate.id)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(directDetail.generatedMedia.filter((item) => item.messageId === directReply.id).length, 1);

    const continuationSource = appendChannelUserMessage(store, channel.id, "请继续生成一张图片", "channel_tool_only_continuation_source");
    const sourceRun = store.getRun(channelReply.linkedRunId);
    assert.ok(sourceRun);
    const intervention = store.createRunIntervention({
      sourceRunId: sourceRun.id,
      mode: "queue_followup",
      instruction: continuationSource.body,
      messagePayload: {
        sourceMessageId: continuationSource.id,
        targetTeammateId: "ling_agent",
        body: continuationSource.body,
        attachmentIds: [],
        linkPreviewIds: [],
      },
      requestedBy: "local-user",
      idempotencyKey: "channel_tool_only_continuation",
    }, now);
    const continuationProjection = createChannelReplyContinuationProjection({ store, sourceRun, intervention });
    assert.ok(continuationProjection);
    const continuationRun = createPersistedToolOnlyContinuationRun({
      store,
      sourceRun,
      intervention,
      replyMessageId: continuationProjection.replyMessageId,
      imageProviderId: imageProvider.id,
    });
    const continuationMedia = createConversationMediaGenerationToolHandler({
      store,
      storeRegistry: continuationStoreRegistry,
      secretResolver: emptySecretResolver,
      runtimeSupervisor: {},
      run: continuationRun,
      linkedMessageId: continuationProjection.replyMessageId,
      launchMediaJob() {},
    })({
      toolCallId: "call_channel_continuation_image",
      toolName: "image_generate",
      runId: continuationRun.id,
      prompt: "A queued channel image",
      task: { id: continuationRun.taskId, title: "Channel continuation", prompt: "Generate" },
      cwd,
    });
    const continuationRuntime = new RuntimeSupervisor(runtimeConfig(cwd));
    try {
      const execution = await runProviderMediaJobExecution({
        cwd,
        storeRegistry: continuationStoreRegistry,
        secretResolver: emptySecretResolver,
        mediaJobId: continuationMedia.details.mediaJobId,
        hooks: mediaRuntimeHooks(continuationRuntime),
      });
      assert.equal(execution.statusCode, 200);
    } finally {
      continuationRuntime.releaseAll();
    }
    store.markRunStarted(continuationRun.id, now);
    store.markRunSucceeded(continuationRun.id, now);
    const continuationRunId = continuationRun.id;
    const continuationReply = continuationProjection.finalize(store.getRun(continuationRunId));
    assert.equal(continuationReply.status, "ready");
    assert.equal(continuationReply.body, "");
    assert.match(buildContinuationSystemPromptForAssertion(store, sourceRun, intervention, continuationSource.id), /first-party media tools/);
    assert.equal(buildConversationGeneratedMediaProjection({ store, runIds: [continuationRunId] }).length, 1);

    assert.equal(store.listMediaJobs({ limit: 20 }).length, 4);
    await waitForCondition(
      () => store.listMediaJobs({ limit: 20 }).every((job) => job.status === "succeeded"),
      "all local media jobs to finish",
    );
    assert.equal(imageServer.requests.length, 4);
    assert.equal(store.listMediaJobs({ limit: 20 }).every((job) => store.listMediaJobArtifacts(job.id).some((artifact) => artifact.type === "image")), true);
    const visibleResults = { normalEvents, channelEvents, directEvents, channelReply, directReply, continuationReply };
    assert.equal(JSON.stringify(visibleResults).includes("completed without text"), false);
    assert.equal(JSON.stringify(visibleResults).includes("没有返回可显示内容"), false);
    assert.equal(imageProvider.id, store.getWorkspaceSettings().mediaGenerationDefaults.image.providerPresetId);
  } finally {
    continuationLocalExecutions.beginShutdown();
    await continuationLocalExecutions.waitForIdle();
    if (daemon) {
      await daemon.stop();
    } else {
      store.close();
    }
    await imageServer.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("conversation generation inventory combines runnable provider and active workflow targets", async () => {
  const fixture = await createFixture();
  try {
    const targets = listConversationMediaGenerationTargets(fixture.store, fixture.secretResolver);
    assert.deepEqual(targets.filter((item) => item.runnable).map((item) => [item.generationKind, item.displayName]), [
      ["image", "Studio Image"],
      ["video", "Storyboard Flow"],
    ]);
    fixture.store.updateProviderPreset(fixture.imageProviderId, { displayName: "Unchecked Image" }, now);
    const unchecked = listConversationMediaGenerationTargets(fixture.store, fixture.secretResolver)
      .find((item) => item.displayName === "Unchecked Image");
    assert.equal(unchecked.runnable, false);
    assert.match(unchecked.unavailableReason, /latest check/);
    assert.deepEqual(createConversationMediaGenerationToolDefinitions(targets).map((tool) => tool.name), [
      "image_generate",
      "video_generate",
    ]);
    const definitions = createConversationMediaGenerationToolDefinitions(targets);
    assert.deepEqual(definitions.find((tool) => tool.name === "image_generate").targets[0], {
      id: `provider:${fixture.imageProviderId}`,
      displayName: "Studio Image",
      aspectRatios: ["1:1", "3:2", "2:3"],
      durationsSeconds: undefined,
      supportsAspectRatio: true,
      supportsDurationSeconds: false,
      supportsCount: true,
    });
    assert.deepEqual(definitions.find((tool) => tool.name === "video_generate").targets[0], {
      id: `workflow:${fixture.workflowId}`,
      displayName: "Storyboard Flow",
      aspectRatios: undefined,
      durationsSeconds: undefined,
      supportsAspectRatio: false,
      supportsDurationSeconds: false,
      supportsCount: false,
    });
  } finally {
    await fixture.close();
  }
});

test("custom compatible generation targets use the model identity instead of the import route name", async () => {
  const fixture = await createFixture();
  try {
    fixture.store.updateProviderPreset(fixture.imageProviderId, {
      providerId: "custom-openai-compatible",
      displayName: "gpt-5.6-luna · gpt-image-1",
    }, now);
    const target = listConversationMediaGenerationTargets(fixture.store, fixture.secretResolver)
      .find((item) => item.ref.kind === "provider" && item.ref.providerPresetId === fixture.imageProviderId);
    assert.equal(target?.displayName, "gpt-image-1");
  } finally {
    await fixture.close();
  }
});

test("generation inventory preserves the name of an existing unavailable default for repair", async () => {
  const fixture = await createFixture();
  try {
    fixture.store.updateWorkspaceSettings({
      mediaGenerationDefaults: {
        image: { kind: "provider", providerPresetId: fixture.imageProviderId },
        video: { kind: "workflow", workflowDefinitionId: fixture.workflowId },
      },
    }, now);
    fixture.store.updateProviderPreset(fixture.imageProviderId, { capabilities: ["chat"] }, now);
    const workflow = fixture.store.getMediaWorkflowDefinition(fixture.workflowId);
    assert.ok(workflow?.currentVersionId);
    const imageOnlyVersion = fixture.store.createMediaWorkflowVersion({
      workflowDefinitionId: workflow.id,
      sourceDigest: "digest-image-only-default-repair",
      graphSnapshot: {},
      inputFields: [{
        id: "prompt",
        label: "Prompt",
        kind: "text",
        semantic: "prompt",
        required: true,
        nodeId: "1",
        inputName: "text",
      }],
      outputRules: [{ nodeId: "2", artifactType: "image", collect: "first" }],
      validation: { ok: true, errors: [], warnings: [], checkedAt: now },
    }, now);
    fixture.store.updateMediaWorkflowDefinition(workflow.id, { currentVersionId: imageOnlyVersion.id }, now);

    const targets = listConversationMediaGenerationTargets(fixture.store, fixture.secretResolver);
    assert.deepEqual(
      targets
        .filter((target) => !target.runnable && (
          target.displayName === "Studio Image" || target.displayName === "Storyboard Flow"
        ))
        .map((target) => [target.generationKind, target.displayName, target.ref.kind]),
      [
        ["image", "Studio Image", "provider"],
        ["video", "Storyboard Flow", "workflow"],
      ],
    );
    assert.equal(createConversationMediaGenerationToolDefinitions(targets).length, 1);
    assert.equal(createConversationMediaGenerationToolDefinitions(targets)[0].name, "image_generate");
    assert.equal(createConversationMediaGenerationToolDefinitions(targets)[0].targets[0].displayName, "Storyboard Flow");
  } finally {
    await fixture.close();
  }
});

test("generation inventory exposes only model-level verified provider parameters", async () => {
  const fixture = await createFixture();
  try {
    const seedream = fixture.store.createProviderPreset({
      kind: "seedream",
      displayName: "Seedream Studio",
      providerId: "seedream",
      model: "doubao-seedream-4-0-250828",
      api: "media-job",
      baseUrl: "https://example.invalid/v1",
      capabilities: ["image_generate"],
      compat: { mediaVendorTransport: { mode: "live" } },
    }, now);
    fixture.store.setProviderSecret(seedream.id, "test-seedream-secret", now);
    fixture.store.updateProviderPreset(seedream.id, { apiKeyRef: `local:${seedream.id}` }, now);
    fixture.store.recordProviderCheckResult(seedream.id, {
      ok: true,
      code: "ready",
      message: "Seedream is ready.",
      checkedAt: now,
    });

    const target = listConversationMediaGenerationTargets(fixture.store, fixture.secretResolver)
      .find((candidate) => candidate.ref.kind === "provider" && candidate.ref.providerPresetId === seedream.id);
    assert.ok(target);
    assert.equal(target.supportsAspectRatio, false);
    assert.equal(target.supportsCount, false);
    assert.equal(target.aspectRatios, undefined);

    const dallE = fixture.store.createProviderPreset({
      kind: "openai",
      displayName: "DALL-E 3",
      providerId: "openai",
      model: "dall-e-3",
      api: "media-job",
      baseUrl: "https://example.invalid/v1",
      capabilities: ["image_generate"],
      compat: { mediaVendorTransport: { mode: "live" } },
    }, now);
    fixture.store.setProviderSecret(dallE.id, "test-dall-e-secret", now);
    fixture.store.updateProviderPreset(dallE.id, { apiKeyRef: `local:${dallE.id}` }, now);
    fixture.store.recordProviderCheckResult(dallE.id, {
      ok: true,
      code: "ready",
      message: "DALL-E 3 is ready.",
      checkedAt: now,
    });
    const dallETarget = listConversationMediaGenerationTargets(fixture.store, fixture.secretResolver)
      .find((candidate) => candidate.ref.kind === "provider" && candidate.ref.providerPresetId === dallE.id);
    assert.ok(dallETarget);
    assert.equal(dallETarget.supportsCount, false);
    assert.deepEqual(dallETarget.aspectRatios, ["1:1", "7:4", "4:7"]);
    assert.deepEqual(dallETarget.sizeByAspectRatio, {
      "1:1": "1024x1024",
      "7:4": "1792x1024",
      "4:7": "1024x1792",
    });
  } finally {
    await fixture.close();
  }
});

test("conversation generation tools are limited to user-authored visible reply work units", () => {
  for (const workUnitKind of ["conversation_run", "channel_ai_reply", "teammate_direct_reply"]) {
    assert.equal(isConversationMediaGenerationEligible({ createdByActor: "local-user", workUnitKind }), true);
  }
  assert.equal(isConversationMediaGenerationEligible({ createdByActor: "system", workUnitKind: "channel_ai_reply" }), false);
  assert.equal(isConversationMediaGenerationEligible({ createdByActor: "local-user", workUnitKind: "task_run" }), false);
  assert.equal(isConversationMediaGenerationEligible({ createdByActor: "local-user", workUnitKind: "channel_terminal_report" }), false);
});

test("continuation media authority follows the intervention requester", async () => {
  const fixture = await createFixture();
  try {
    const sourceRun = createConversationRun(fixture, "run_media_continuation_authority");
    const createIntervention = (requestedBy) => fixture.store.createRunIntervention({
      sourceRunId: sourceRun.id,
      mode: "queue_followup",
      instruction: `Continue as ${requestedBy}`,
      messagePayload: { body: `Continue as ${requestedBy}`, attachmentIds: [], linkPreviewIds: [] },
      requestedBy,
      idempotencyKey: `media-continuation-authority:${requestedBy}`,
    }, now);
    const localRequest = buildRunInterventionContinuationRequest(fixture.store, sourceRun, createIntervention("local-user"));
    const systemRequest = buildRunInterventionContinuationRequest(fixture.store, sourceRun, createIntervention("system"));

    assert.equal(localRequest.createdByActor, "local-user");
    assert.equal(systemRequest.createdByActor, "system");
    assert.equal(isConversationMediaGenerationEligible({ createdByActor: localRequest.createdByActor, workUnitKind: "conversation_run" }), true);
    assert.equal(isConversationMediaGenerationEligible({ createdByActor: systemRequest.createdByActor, workUnitKind: "conversation_run" }), false);
  } finally {
    await fixture.close();
  }
});

test("normal conversation carries local-user authority into Runner media tool registration", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-normal-conversation-media-tools-"));
  const store = createSqliteRunStore(cwd);
  const runner = new MediaToolProbeRunner();
  let daemon;
  try {
    const chatProvider = store.createProviderPreset({
      kind: "glm",
      displayName: "Conversation Chat",
      providerId: "conversation-chat",
      model: "conversation-chat-model",
      api: "google-generative-ai",
      capabilities: ["chat"],
      authHeader: false,
      enabled: true,
    }, now);
    store.recordProviderCheckResult(chatProvider.id, {
      ok: true,
      code: "ready",
      message: "Provider is ready.",
      checkedAt: now,
    });
    const imageProvider = store.createProviderPreset({
      kind: "openai",
      displayName: "Conversation Image",
      providerId: "openai",
      model: "gpt-image-1",
      api: "media-job",
      baseUrl: "https://example.invalid/v1",
      capabilities: ["image_generate"],
      compat: { mediaVendorTransport: { mode: "live" } },
      enabled: true,
    }, now);
    store.setProviderSecret(imageProvider.id, "test-media-secret", now);
    store.updateProviderPreset(imageProvider.id, { apiKeyRef: `local:${imageProvider.id}` }, now);
    store.recordProviderCheckResult(imageProvider.id, {
      ok: true,
      code: "ready",
      message: "Generation provider is ready.",
      checkedAt: now,
    });

    daemon = createDaemonServer({
      host: "127.0.0.1",
      port: 0,
      defaultWorkspaceCwd: cwd,
      channels: { intentSelector: false, terminalReports: false },
    }, {
      runner,
      storeFactory(requestedCwd) {
        assert.equal(requestedCwd, cwd);
        return store;
      },
    });
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/conversations/stream?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Generate an image of a quiet city.",
        providerPresetId: chatProvider.id,
      }),
    });

    assert.equal(response.status, 200);
    await response.text();
    assert.equal(runner.runs.length, 1);
    assert.deepEqual(runner.runs[0].mediaGenerationTools?.map((tool) => tool.name), ["image_generate"]);
    assert.equal(typeof runner.runs[0].onMediaGenerationToolCall, "function");
  } finally {
    if (daemon) {
      await daemon.stop();
    } else {
      store.close();
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("conversation generation handler applies defaults and reuses one durable media job per tool call", async () => {
  const fixture = await createFixture();
  try {
    fixture.store.updateWorkspaceSettings({
      mediaGenerationDefaults: {
        image: { kind: "provider", providerPresetId: fixture.imageProviderId },
      },
    }, now);
    const run = fixture.store.createRun({
      id: "run_conversation_media",
      cwd: fixture.cwd,
      taskId: "conversation_message_media",
      providerName: "chat",
      providerModel: "chat-model",
      taskSnapshot: { id: "conversation_message_media", title: "Generate", prompt: "Draw a city" },
      providerSnapshot: { provider: "chat", model: "chat-model" },
      requestSnapshot: { cwd: fixture.cwd },
      createdAt: now,
    });
    const launched = [];
    const handler = createConversationMediaGenerationToolHandler({
      store: fixture.store,
      storeRegistry: fixture.storeRegistry,
      secretResolver: fixture.secretResolver,
      runtimeSupervisor: {},
      run,
      linkedMessageId: "assistant_media",
      launchMediaJob: (mediaJobId) => launched.push(mediaJobId),
    });
    const request = {
      toolCallId: "call_image_1",
      toolName: "image_generate",
      runId: run.id,
      prompt: "A quiet city at sunrise",
      aspectRatio: "1:1",
      count: 2,
      task: { id: "conversation_message_media", title: "Generate", prompt: "Draw a city" },
      cwd: fixture.cwd,
    };
    const first = handler(request);
    const second = handler(request);
    assert.equal(first.isError, undefined);
    assert.equal(first.details.reused, false);
    assert.equal(second.details.reused, true);
    assert.equal(first.details.mediaJobId, second.details.mediaJobId);
    assert.deepEqual(launched, [first.details.mediaJobId]);
    const job = fixture.store.getMediaJob(first.details.mediaJobId);
    assert.deepEqual(job.input, { size: "1024x1024", n: 2 });
    const child = fixture.store.listWorkUnits({ linkedRunId: run.id, linkedMediaJobId: job.id })[0];
    assert.equal(child.linkedMessageId, "assistant_media");

    fixture.store.updateProviderPreset(fixture.imageProviderId, { displayName: "Renamed Image" }, now);
    const artifact = fixture.store.createArtifact({
      mediaJobId: job.id,
      type: "image",
      path: resolve(fixture.cwd, "generated-image.png"),
      title: "Generated image",
      contentType: "image/png",
      createdAt: "2026-08-11T01:01:00.000Z",
    });
    fixture.store.updateMediaJobStatus(job.id, {
      status: "succeeded",
      artifactIds: [artifact.id],
    }, "2026-08-11T01:01:00.000Z");
    const projection = buildConversationGeneratedMediaProjection({
      store: fixture.store,
      runIds: [run.id],
    });
    assert.equal(projection.length, 1);
    assert.equal(projection[0].target.displayName, "Studio Image");
    assert.equal(projection[0].messageId, "assistant_media");
    assert.equal(projection[0].status, "succeeded");
    assert.deepEqual(projection[0].artifacts.map((item) => item.id), [artifact.id]);
    assert.equal(projection[0].artifacts[0].mediaJobId, job.id);
    assert.equal(projection[0].artifacts[0].runId, undefined);
  } finally {
    await fixture.close();
  }
});

test("conversation generation rejects target options that cannot be represented without creating a media job", async () => {
  const fixture = await createFixture();
  try {
    fixture.store.updateWorkspaceSettings({
      mediaGenerationDefaults: {
        video: { kind: "workflow", workflowDefinitionId: fixture.workflowId },
      },
    }, now);
    const run = createConversationRun(fixture, "run_unsupported_media_options");
    const handler = createConversationMediaGenerationToolHandler({
      store: fixture.store,
      storeRegistry: fixture.storeRegistry,
      secretResolver: fixture.secretResolver,
      runtimeSupervisor: {},
      run,
      launchMediaJob() {},
    });
    const baseRequest = {
      toolName: "video_generate",
      runId: run.id,
      prompt: "A prompt-only workflow",
      task: { id: run.taskId, title: "Generate", prompt: "Animate" },
      cwd: fixture.cwd,
    };
    const before = fixture.store.listMediaJobs({ limit: 100 }).length;
    const failures = [
      handler({ ...baseRequest, toolCallId: "unsupported_ratio", aspectRatio: "16:9" }),
      handler({ ...baseRequest, toolCallId: "unsupported_duration", durationSeconds: 10 }),
      handler({ ...baseRequest, toolCallId: "unsupported_count", count: 2 }),
    ];

    assert.deepEqual(failures.map((result) => result.details.code), [
      "generation_input_invalid",
      "generation_input_invalid",
      "generation_input_invalid",
    ]);
    assert.match(failures[0].content[0].text, /does not support an aspect ratio input/);
    assert.match(failures[1].content[0].text, /does not support a duration input/);
    assert.match(failures[2].content[0].text, /does not support an image count input/);
    assert.equal(fixture.store.listMediaJobs({ limit: 100 }).length, before);
  } finally {
    await fixture.close();
  }
});

test("workspace settings parser accepts typed media defaults and rejects malformed references", () => {
  assert.deepEqual(parseWorkspaceSettingsUpdate({
    mediaGenerationDefaults: {
      image: { kind: "provider", providerPresetId: "provider_image" },
      video: { kind: "workflow", workflowDefinitionId: "workflow_video" },
    },
  }).mediaGenerationDefaults, {
    image: { kind: "provider", providerPresetId: "provider_image" },
    video: { kind: "workflow", workflowDefinitionId: "workflow_video" },
  });
  assert.throws(
    () => parseWorkspaceSettingsUpdate({ mediaGenerationDefaults: { image: { kind: "provider" } } }),
    /providerPresetId must be a non-empty string/,
  );
});

test("media defaults accept only changed runnable targets of the matching kind", async () => {
  const fixture = await createFixture();
  try {
    const targets = listConversationMediaGenerationTargets(fixture.store, fixture.secretResolver);
    const imageRef = { kind: "provider", providerPresetId: fixture.imageProviderId };
    const videoRef = { kind: "workflow", workflowDefinitionId: fixture.workflowId };
    assert.doesNotThrow(() => assertMediaGenerationDefaultUpdate({
      current: undefined,
      next: { image: imageRef, video: videoRef },
      targets,
    }));
    assert.throws(() => assertMediaGenerationDefaultUpdate({
      current: undefined,
      next: { image: videoRef },
      targets,
    }), /does not support image generation/);
    assert.throws(() => assertMediaGenerationDefaultUpdate({
      current: undefined,
      next: { image: { kind: "provider", providerPresetId: "missing" } },
      targets,
    }), /does not exist/);

    const unavailableTargets = targets.map((target) => target.generationKind === "image"
      ? { ...target, runnable: false, unavailableReason: "Image target needs attention." }
      : target);
    assert.doesNotThrow(() => assertMediaGenerationDefaultUpdate({
      current: { image: imageRef },
      next: { image: imageRef, video: videoRef },
      targets: unavailableTargets,
    }));
    assert.throws(() => assertMediaGenerationDefaultUpdate({
      current: undefined,
      next: { image: imageRef },
      targets: unavailableTargets,
    }), /needs attention/);
  } finally {
    await fixture.close();
  }
});

test("conversation media projection covers every status, isolates owners, and never exposes raw diagnostics", async () => {
  const fixture = await createFixture();
  const controlPlaneEvents = new ControlPlaneEventHub();
  try {
    fixture.store.updateWorkspaceSettings({
      mediaGenerationDefaults: {
        image: { kind: "provider", providerPresetId: fixture.imageProviderId },
      },
    }, now);
    const run = createConversationRun(fixture, "run_projection_matrix");
    const handler = createConversationMediaGenerationToolHandler({
      store: fixture.store,
      storeRegistry: fixture.storeRegistry,
      secretResolver: fixture.secretResolver,
      runtimeSupervisor: {},
      run,
      linkedMessageId: "assistant_projection_matrix",
      controlPlaneEvents,
      launchMediaJob() {},
    });
    const statuses = ["queued", "running", "waiting_for_approval", "succeeded", "failed", "cancelled"];
    const mediaJobs = statuses.map((status, index) => {
      const result = handler({
        toolCallId: `call_projection_${index}`,
        toolName: "image_generate",
        runId: run.id,
        prompt: `Projection ${status}`,
        task: { id: run.taskId, title: "Generate", prompt: "Draw" },
        cwd: fixture.cwd,
      });
      const mediaJob = fixture.store.getMediaJob(result.details.mediaJobId);
      assert.ok(mediaJob);
      fixture.store.updateMediaJobStatus(mediaJob.id, {
        status,
        ...(status === "failed" ? {
          errorMessage: "Request to https://secret.example/v1 failed with token test-secret and raw graph node 42",
        } : {}),
      }, `2026-08-11T01:0${index}:00.000Z`);
      if (status === "failed") {
        const child = fixture.store.listWorkUnits({ linkedMediaJobId: mediaJob.id, limit: 10 })[0];
        const transition = fixture.store.transitionWorkUnitStatus({
          workUnitId: child.id,
          expectedStatus: "queued",
          event: "runner_failed",
          actor: "system",
          now: "2026-08-11T01:05:00.000Z",
          errorCode: "auth_failed",
          errorMessage: "raw provider response must stay private",
        });
        assert.equal(transition.ok, true);
      }
      return fixture.store.getMediaJob(mediaJob.id);
    });

    const unrelatedJob = fixture.store.createMediaJob({
      providerPresetId: fixture.imageProviderId,
      operation: "image_generate",
      prompt: "Standalone task must not enter a conversation",
    }, "2026-08-11T01:10:00.000Z");
    fixture.store.createWorkUnit({
      workspaceId: DEFAULT_WORKSPACE_ID,
      kind: "media_job",
      ownerType: "media_job",
      ownerId: unrelatedJob.id,
      idempotencyKey: "standalone_projection_owner",
      createdByActor: "system",
      request: {
        source: "conversation_media_tool",
        target: {
          id: `provider:${fixture.imageProviderId}`,
          ref: { kind: "provider", providerPresetId: fixture.imageProviderId },
          generationKind: "image",
          displayName: "Standalone target",
        },
      },
      linkedRunId: run.id,
      linkedMediaJobId: unrelatedJob.id,
      now: "2026-08-11T01:10:00.000Z",
    });

    const projection = buildConversationGeneratedMediaProjection({ store: fixture.store, runIds: [run.id] });
    assert.deepEqual(projection.map((item) => item.status), statuses);
    assert.equal(projection.some((item) => item.mediaJobId === unrelatedJob.id), false);
    const failed = projection.find((item) => item.status === "failed");
    assert.equal(failed.failureCode, "generation_authorization_required");
    const serializedProjection = JSON.stringify(projection);
    for (const forbidden of ["secret.example", "test-secret", "raw graph", "raw provider response"]) {
      assert.equal(serializedProjection.includes(forbidden), false, `conversation projection leaked ${forbidden}`);
    }

    publishConversationMediaProjectionChange({
      store: fixture.store,
      controlPlaneEvents,
      mediaJobId: mediaJobs[4].id,
      createdArtifactIds: ["artifact_safe_id"],
    });
    const serializedEvents = JSON.stringify(fixture.store.listControlPlaneEvents({
      workspaceId: DEFAULT_WORKSPACE_ID,
      afterSeq: 0,
      limit: 100,
    }));
    for (const forbidden of ["secret.example", "test-secret", "raw graph", "raw provider response"]) {
      assert.equal(serializedEvents.includes(forbidden), false, `control-plane event leaked ${forbidden}`);
    }
  } finally {
    controlPlaneEvents.closeAll();
    await fixture.close();
  }
});

test("executor adopts the single conversation child work unit and closes it when the accepted target becomes unavailable", async () => {
  const fixture = await createFixture();
  const runtimeSupervisor = new RuntimeSupervisor(runtimeConfig(fixture.cwd));
  try {
    fixture.store.updateWorkspaceSettings({
      mediaGenerationDefaults: {
        image: { kind: "provider", providerPresetId: fixture.imageProviderId },
      },
    }, now);
    const run = createConversationRun(fixture, "run_target_invalidated");
    const handler = createConversationMediaGenerationToolHandler({
      store: fixture.store,
      storeRegistry: fixture.storeRegistry,
      secretResolver: fixture.secretResolver,
      runtimeSupervisor,
      run,
      linkedMessageId: "assistant_target_invalidated",
      launchMediaJob() {},
    });
    const accepted = handler({
      toolCallId: "call_target_invalidated",
      toolName: "image_generate",
      runId: run.id,
      prompt: "A target that becomes unavailable",
      task: { id: run.taskId, title: "Generate", prompt: "Draw" },
      cwd: fixture.cwd,
    });
    const mediaJobId = accepted.details.mediaJobId;
    const originalChild = fixture.store.listWorkUnits({ linkedMediaJobId: mediaJobId, limit: 10 })[0];
    assert.equal(originalChild.status, "queued");
    fixture.store.updateProviderPreset(fixture.imageProviderId, { enabled: false }, "2026-08-11T01:01:00.000Z");

    await runProviderMediaJobExecution({
      cwd: fixture.cwd,
      storeRegistry: fixture.storeRegistry,
      secretResolver: fixture.secretResolver,
      mediaJobId,
      hooks: mediaRuntimeHooks(runtimeSupervisor),
    });

    const children = fixture.store.listWorkUnits({ linkedMediaJobId: mediaJobId, limit: 10 });
    assert.equal(children.length, 1);
    assert.equal(children[0].id, originalChild.id);
    assert.equal(children[0].ownerType, "conversation_run");
    assert.equal(children[0].status, "failed");
    assert.equal(children[0].errorCode, "provider_disabled");
    const attempts = fixture.store.listWorkUnitAttempts(originalChild.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, "failed");
    assert.equal(fixture.store.getMediaJob(mediaJobId).status, "failed");
    const projection = buildConversationGeneratedMediaProjection({ store: fixture.store, runIds: [run.id] });
    assert.equal(projection[0].failureCode, "generation_target_unavailable");
  } finally {
    runtimeSupervisor.releaseAll();
    await fixture.close();
  }
});

test("background dispatch preserves cancellation before an execution handle exists", async () => {
  const fixture = await createFixture();
  const runtimeSupervisor = new RuntimeSupervisor(runtimeConfig(fixture.cwd));
  try {
    fixture.store.updateWorkspaceSettings({
      mediaGenerationDefaults: {
        image: { kind: "provider", providerPresetId: fixture.imageProviderId },
      },
    }, now);
    const run = createConversationRun(fixture, "run_cancelled_before_media_dispatch");
    const handler = createConversationMediaGenerationToolHandler({
      store: fixture.store,
      storeRegistry: fixture.storeRegistry,
      secretResolver: fixture.secretResolver,
      runtimeSupervisor,
      run,
      linkedMessageId: "assistant_cancelled_before_media_dispatch",
      launchMediaJob() {},
    });
    const accepted = handler({
      toolCallId: "call_cancelled_before_media_dispatch",
      toolName: "image_generate",
      runId: run.id,
      prompt: "This request is cancelled before submission",
      task: { id: run.taskId, title: "Generate", prompt: "Draw" },
      cwd: fixture.cwd,
    });
    const mediaJobId = accepted.details.mediaJobId;
    const originalChild = fixture.store.listWorkUnits({ linkedMediaJobId: mediaJobId, limit: 10 })[0];
    fixture.store.updateMediaJobStatus(mediaJobId, {
      status: "cancelled",
      errorMessage: "Cancelled before provider submission.",
    }, "2026-08-11T01:01:00.000Z");
    fixture.store.updateProviderPreset(fixture.imageProviderId, { enabled: false }, "2026-08-11T01:01:01.000Z");

    const result = await runProviderMediaJobExecution({
      cwd: fixture.cwd,
      storeRegistry: fixture.storeRegistry,
      secretResolver: fixture.secretResolver,
      mediaJobId,
      hooks: mediaRuntimeHooks(runtimeSupervisor),
    });

    assert.equal(result.statusCode, 200);
    assert.equal(fixture.store.getMediaJob(mediaJobId).status, "cancelled");
    assert.equal(fixture.store.getMediaJobExecutionHandle(mediaJobId), undefined);
    const children = fixture.store.listWorkUnits({ linkedMediaJobId: mediaJobId, limit: 10 });
    assert.equal(children.length, 1);
    assert.equal(children[0].id, originalChild.id);
    assert.equal(children[0].status, "cancelled");
    const attempts = fixture.store.listWorkUnitAttempts(originalChild.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, "cancelled");
  } finally {
    runtimeSupervisor.releaseAll();
    await fixture.close();
  }
});

test("daemon restart redispatches a queued conversation media job created before an execution handle", async () => {
  const fixture = await createFixture();
  let restartedStore;
  let initialStoreClosed = false;
  const restartedLocalExecutions = new MediaLocalExecutionRegistry();
  try {
    fixture.store.updateWorkspaceSettings({
      mediaGenerationDefaults: {
        image: { kind: "provider", providerPresetId: fixture.imageProviderId },
      },
    }, now);
    const run = fixture.store.createRun({
      id: "run_conversation_media_restart",
      cwd: fixture.cwd,
      taskId: "conversation_message_media_restart",
      providerName: "chat",
      providerModel: "chat-model",
      taskSnapshot: { id: "conversation_message_media_restart", title: "Generate", prompt: "Draw" },
      providerSnapshot: { provider: "chat", model: "chat-model" },
      requestSnapshot: { cwd: fixture.cwd },
      createdAt: now,
    });
    const handler = createConversationMediaGenerationToolHandler({
      store: fixture.store,
      storeRegistry: fixture.storeRegistry,
      secretResolver: fixture.secretResolver,
      runtimeSupervisor: {},
      run,
      launchMediaJob() {},
    });
    const accepted = handler({
      toolCallId: "call_before_restart",
      toolName: "image_generate",
      runId: run.id,
      prompt: "A sunrise",
      task: { id: "conversation_message_media_restart", title: "Generate", prompt: "Draw" },
      cwd: fixture.cwd,
    });
    fixture.storeRegistry.mediaLocalExecutions.beginShutdown();
    await fixture.storeRegistry.mediaLocalExecutions.waitForIdle();
    fixture.store.close();
    initialStoreClosed = true;

    restartedStore = createSqliteRunStore(fixture.cwd);
    const dispatched = [];
    resumePendingMediaJobExecutions({
      cwd: fixture.cwd,
      storeRegistry: { getStore: () => restartedStore, mediaLocalExecutions: restartedLocalExecutions },
      secretResolver: fixture.secretResolver,
      hooks: {
        startRuntimeWorkUnit() { throw new Error("unexpected runtime start"); },
        transitionRuntimeWorkUnitTerminal() {},
        transitionRuntimeWorkUnitCancelled() {},
      },
      dispatchInitialConversationMediaJob: (mediaJobId) => dispatched.push(mediaJobId),
    });
    assert.deepEqual(dispatched, [accepted.details.mediaJobId]);
  } finally {
    fixture.storeRegistry.mediaLocalExecutions.beginShutdown();
    restartedLocalExecutions.beginShutdown();
    await Promise.all([fixture.storeRegistry.mediaLocalExecutions.waitForIdle(), restartedLocalExecutions.waitForIdle()]);
    if (!initialStoreClosed) fixture.store.close();
    restartedStore?.close();
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("runtime startup keeps parent completion separate and requeues the same pending media child", async () => {
  const fixture = await createFixture();
  const firstRuntime = new RuntimeSupervisor(runtimeConfig(fixture.cwd));
  let restartedRuntime;
  try {
    fixture.store.updateWorkspaceSettings({
      mediaGenerationDefaults: {
        image: { kind: "provider", providerPresetId: fixture.imageProviderId },
      },
    }, now);
    const run = createConversationRun(fixture, "run_media_parent_completed_before_child");
    const handler = createConversationMediaGenerationToolHandler({
      store: fixture.store,
      storeRegistry: fixture.storeRegistry,
      secretResolver: fixture.secretResolver,
      runtimeSupervisor: firstRuntime,
      run,
      linkedMessageId: "assistant_media_parent_completed_before_child",
      launchMediaJob() {},
    });
    const accepted = handler({
      toolCallId: "call_media_parent_completed_before_child",
      toolName: "image_generate",
      runId: run.id,
      prompt: "A pending generation after the reply completes",
      task: { id: run.taskId, title: "Generate", prompt: "Draw" },
      cwd: fixture.cwd,
    });
    const mediaJobId = accepted.details.mediaJobId;
    const originalChild = fixture.store.listWorkUnits({ linkedMediaJobId: mediaJobId, limit: 10 })[0];
    const started = startRuntimeWorkUnit({
      store: fixture.store,
      runtimeSupervisor: firstRuntime,
      kind: "media_job",
      ownerType: "media_job",
      ownerId: mediaJobId,
      providerPresetId: fixture.imageProviderId,
      linkedMediaJobId: mediaJobId,
      idempotencyKey: `media_job:${mediaJobId}:before-restart`,
      request: { mediaJobId, operation: "image_generate" },
    });
    assert.equal(started.workUnit.id, originalChild.id);
    fixture.store.upsertMediaJobExecutionHandle({
      mediaJobId,
      adapterKind: "recoverable-test-adapter",
      externalOperationId: "external_operation_before_restart",
      recovery: { phase: "polling" },
      nextPollAt: now,
      workUnitId: started.workUnit.id,
      attemptId: started.attempt.id,
    }, now);
    fixture.store.updateMediaJobStatus(mediaJobId, { status: "running" }, now);
    fixture.store.transitionRunStatus({
      runId: run.id,
      expectedStatus: "queued",
      event: "runner_started",
      actor: "runner",
      now,
      startedAt: now,
    });
    fixture.store.transitionRunStatus({
      runId: run.id,
      expectedStatus: "running",
      event: "runner_succeeded",
      actor: "runner",
      now: "2026-08-11T01:01:00.000Z",
      endedAt: "2026-08-11T01:01:00.000Z",
    });

    firstRuntime.releaseAll();
    restartedRuntime = new RuntimeSupervisor(runtimeConfig(fixture.cwd));
    restartedRuntime.getRuntime(fixture.cwd, fixture.store);

    const staleChild = fixture.store.getWorkUnit(originalChild.id);
    assert.equal(staleChild.status, "stale");
    assert.equal(fixture.store.getWorkUnitAttempt(started.attempt.id).status, "lost");
    recoverPendingConversationMediaWorkUnits(fixture.store, "2026-08-11T01:02:00.000Z");
    const queuedChild = fixture.store.getWorkUnit(originalChild.id);
    assert.equal(queuedChild.status, "queued");
    assert.equal(queuedChild.activeAttemptId, undefined);
    const retainedHandle = fixture.store.getMediaJobExecutionHandle(mediaJobId);
    assert.equal(retainedHandle.externalOperationId, "external_operation_before_restart");
    assert.equal(retainedHandle.workUnitId, undefined);
    assert.equal(retainedHandle.attemptId, undefined);

    const restarted = startRuntimeWorkUnit({
      store: fixture.store,
      runtimeSupervisor: restartedRuntime,
      kind: "media_job",
      ownerType: "media_job",
      ownerId: mediaJobId,
      providerPresetId: fixture.imageProviderId,
      linkedMediaJobId: mediaJobId,
      idempotencyKey: `media_job:${mediaJobId}:after-restart`,
      request: { mediaJobId, operation: "image_generate" },
    });
    assert.equal(restarted.workUnit.id, originalChild.id);
    assert.equal(restarted.attempt.attemptNumber, 2);
    assert.deepEqual(
      fixture.store.listWorkUnitAttempts(originalChild.id).map((attempt) => attempt.status),
      ["lost", "started"],
    );
  } finally {
    firstRuntime.releaseAll();
    restartedRuntime?.releaseAll();
    await fixture.close();
  }
});

test("explicit retry reuses the failed conversation media child work unit", async () => {
  const fixture = await createFixture();
  const runtimeSupervisor = new RuntimeSupervisor(runtimeConfig(fixture.cwd));
  try {
    fixture.store.updateWorkspaceSettings({
      mediaGenerationDefaults: {
        image: { kind: "provider", providerPresetId: fixture.imageProviderId },
      },
    }, now);
    const run = createConversationRun(fixture, "run_media_explicit_retry");
    const handler = createConversationMediaGenerationToolHandler({
      store: fixture.store,
      storeRegistry: fixture.storeRegistry,
      secretResolver: fixture.secretResolver,
      runtimeSupervisor,
      run,
      linkedMessageId: "assistant_media_explicit_retry",
      launchMediaJob() {},
    });
    const accepted = handler({
      toolCallId: "call_media_explicit_retry",
      toolName: "image_generate",
      runId: run.id,
      prompt: "Retry the same generation task",
      task: { id: run.taskId, title: "Generate", prompt: "Draw" },
      cwd: fixture.cwd,
    });
    const mediaJobId = accepted.details.mediaJobId;
    const originalChild = fixture.store.listWorkUnits({ linkedMediaJobId: mediaJobId, limit: 10 })[0];
    fixture.store.updateProviderPreset(fixture.imageProviderId, { enabled: false }, "2026-08-11T01:01:00.000Z");
    await runProviderMediaJobExecution({
      cwd: fixture.cwd,
      storeRegistry: fixture.storeRegistry,
      secretResolver: fixture.secretResolver,
      mediaJobId,
      hooks: mediaRuntimeHooks(runtimeSupervisor),
    });
    assert.equal(fixture.store.getWorkUnit(originalChild.id).status, "failed");

    await runProviderMediaJobExecution({
      cwd: fixture.cwd,
      storeRegistry: fixture.storeRegistry,
      secretResolver: fixture.secretResolver,
      mediaJobId,
      hooks: mediaRuntimeHooks(runtimeSupervisor),
      retryTerminal: true,
    });

    const children = fixture.store.listWorkUnits({ linkedMediaJobId: mediaJobId, limit: 10 });
    assert.equal(children.length, 1);
    assert.equal(children[0].id, originalChild.id);
    assert.equal(children[0].status, "failed");
    assert.deepEqual(
      fixture.store.listWorkUnitAttempts(originalChild.id).map((attempt) => attempt.status),
      ["failed", "failed"],
    );
  } finally {
    runtimeSupervisor.releaseAll();
    await fixture.close();
  }
});

test("repeated explicit retry never revives a terminal media job with an external operation handle", async () => {
  const fixture = await createFixture();
  const runtimeSupervisor = new RuntimeSupervisor(runtimeConfig(fixture.cwd));
  try {
    fixture.store.updateWorkspaceSettings({
      mediaGenerationDefaults: {
        image: { kind: "provider", providerPresetId: fixture.imageProviderId },
      },
    }, now);
    const run = createConversationRun(fixture, "run_media_external_handle_retry_guard");
    const handler = createConversationMediaGenerationToolHandler({
      store: fixture.store,
      storeRegistry: fixture.storeRegistry,
      secretResolver: fixture.secretResolver,
      runtimeSupervisor,
      run,
      launchMediaJob() {},
    });
    const accepted = handler({
      toolCallId: "call_media_external_handle_retry_guard",
      toolName: "image_generate",
      runId: run.id,
      prompt: "Do not submit this paid operation twice",
      task: { id: run.taskId, title: "Generate", prompt: "Draw" },
      cwd: fixture.cwd,
    });
    assert.equal(accepted.isError, undefined);
    const mediaJobId = accepted.details.mediaJobId;
    const child = fixture.store.listWorkUnits({ linkedMediaJobId: mediaJobId, limit: 10 })[0];
    const started = startRuntimeWorkUnit({
      store: fixture.store,
      runtimeSupervisor,
      kind: "media_job",
      ownerType: "media_job",
      ownerId: mediaJobId,
      providerPresetId: fixture.imageProviderId,
      linkedMediaJobId: mediaJobId,
      idempotencyKey: `media_job:${mediaJobId}:before-terminal-retry`,
      request: { mediaJobId, operation: "image_generate" },
    });
    fixture.store.upsertMediaJobExecutionHandle({
      mediaJobId,
      adapterKind: "openai-image",
      externalOperationId: "already_accepted_paid_operation",
      recovery: { phase: "submitted" },
      nextPollAt: null,
      workUnitId: started.workUnit.id,
      attemptId: started.attempt.id,
    }, now);
    fixture.store.updateMediaJobStatus(mediaJobId, {
      status: "failed",
      errorMessage: "Provider reported a terminal failure.",
    }, now);

    const retryInput = {
      cwd: fixture.cwd,
      storeRegistry: fixture.storeRegistry,
      secretResolver: fixture.secretResolver,
      mediaJobId,
      hooks: mediaRuntimeHooks(runtimeSupervisor),
      retryTerminal: true,
    };
    const result = await runProviderMediaJobExecution(retryInput);
    const repeated = await runProviderMediaJobExecution(retryInput);

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.error, "media_job_already_failed");
    assert.equal(result.body.mediaJob.errorMessage, "Provider reported a terminal failure.");
    assert.equal(repeated.statusCode, 200);
    assert.equal(repeated.body.error, "media_job_already_failed");
    assert.equal(repeated.body.mediaJob.errorMessage, "Provider reported a terminal failure.");
    assert.equal(fixture.store.getMediaJob(mediaJobId).status, "failed");
    assert.equal(fixture.store.getWorkUnit(child.id).status, "failed");
    assert.equal(fixture.store.listWorkUnitAttempts(child.id).length, 1);
    const retainedHandle = fixture.store.getMediaJobExecutionHandle(mediaJobId);
    assert.ok(retainedHandle);
    assert.equal(retainedHandle.adapterKind, "openai-image");
    assert.equal(retainedHandle.externalOperationId, "already_accepted_paid_operation");
    assert.equal(retainedHandle.nextPollAt, undefined);
    assert.equal(retainedHandle.workUnitId, undefined);
    assert.equal(retainedHandle.attemptId, undefined);
  } finally {
    runtimeSupervisor.releaseAll();
    await fixture.close();
  }
});

test("workflow restart polls the persisted operation with a new attempt and never submits twice", async () => {
  const fixture = await createFixture();
  const comfy = await startRecoverableComfyUiServer();
  const firstRuntime = new RuntimeSupervisor(runtimeConfig(fixture.cwd));
  let restartedRuntime;
  try {
    const connection = fixture.store.listMediaWorkflowConnections()[0];
    const definition = fixture.store.getMediaWorkflowDefinition(fixture.workflowId);
    assert.ok(connection && definition?.currentVersionId);
    fixture.store.updateMediaWorkflowConnection(connection.id, {
      baseUrl: comfy.url,
    }, now);
    publishReadyWorkflowConnection(fixture.store, connection.id);
    fixture.store.updateWorkspaceSettings({
      mediaGenerationDefaults: {
        video: { kind: "workflow", workflowDefinitionId: fixture.workflowId },
      },
    }, now);
    const run = createConversationRun(fixture, "run_workflow_restart_poll");
    const handler = createConversationMediaGenerationToolHandler({
      store: fixture.store,
      storeRegistry: fixture.storeRegistry,
      secretResolver: fixture.secretResolver,
      runtimeSupervisor: firstRuntime,
      run,
      linkedMessageId: "assistant_workflow_restart_poll",
      launchMediaJob() {},
    });
    const accepted = handler({
      toolCallId: "call_workflow_restart_poll",
      toolName: "video_generate",
      runId: run.id,
      prompt: "A recoverable ComfyUI video",
      task: { id: run.taskId, title: "Generate", prompt: "Animate" },
      cwd: fixture.cwd,
    });
    assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
    const mediaJobId = accepted.details.mediaJobId;
    const originalChild = fixture.store.listWorkUnits({ linkedMediaJobId: mediaJobId, limit: 10 })[0];
    const started = startRuntimeWorkUnit({
      store: fixture.store,
      runtimeSupervisor: firstRuntime,
      kind: "media_job",
      ownerType: "media_job",
      ownerId: mediaJobId,
      linkedMediaJobId: mediaJobId,
      idempotencyKey: `media_job:${mediaJobId}:workflow-before-restart`,
      request: { mediaJobId, workflowVersionId: definition.currentVersionId, operation: "video_generate" },
    });
    fixture.store.upsertMediaJobExecutionHandle({
      mediaJobId,
      adapterKind: "comfyui",
      externalOperationId: "prompt_existing",
      recovery: {
        protocolVariant: "prompt_legacy",
        workflowVersionId: definition.currentVersionId,
      },
      nextPollAt: "2026-08-11T00:00:00.000Z",
      workUnitId: started.workUnit.id,
      attemptId: started.attempt.id,
    }, now);
    fixture.store.updateMediaJobStatus(mediaJobId, { status: "running" }, now);

    firstRuntime.releaseAll();
    restartedRuntime = new RuntimeSupervisor(runtimeConfig(fixture.cwd));
    restartedRuntime.getRuntime(fixture.cwd, fixture.store);
    recoverPendingConversationMediaWorkUnits(fixture.store, "2026-08-11T01:02:00.000Z");
    const result = await runWorkflowMediaJobExecution({
      cwd: fixture.cwd,
      storeRegistry: fixture.storeRegistry,
      secretResolver: fixture.secretResolver,
      mediaJobId,
      hooks: mediaRuntimeHooks(restartedRuntime),
    });

    assert.equal(result.statusCode, 200);
    assert.equal(fixture.store.getMediaJob(mediaJobId).status, "succeeded");
    assert.equal(fixture.store.getMediaJobExecutionHandle(mediaJobId), undefined);
    assert.equal(fixture.store.listWorkUnits({ linkedMediaJobId: mediaJobId, limit: 10 }).length, 1);
    assert.equal(fixture.store.getWorkUnit(originalChild.id).status, "succeeded");
    assert.deepEqual(
      fixture.store.listWorkUnitAttempts(originalChild.id).map((attempt) => attempt.status),
      ["lost", "succeeded"],
    );
    assert.equal(comfy.requests.filter((request) => request.method === "POST" && request.path === "/api/prompt").length, 0);
    assert.equal(comfy.requests.some((request) => request.path === "/api/history/prompt_existing"), true);
  } finally {
    firstRuntime.releaseAll();
    restartedRuntime?.releaseAll();
    await comfy.close();
    await fixture.close();
  }
});

test("startup media recovery never revives failed or cancelled jobs", async () => {
  const fixture = await createFixture();
  try {
    const run = createConversationRun(fixture, "run_terminal_media_recovery_guard");
    const jobs = ["failed", "cancelled"].map((status) => {
      const created = fixture.store.createOrReuseConversationMediaJob({
        runId: run.id,
        idempotencyKey: `media_tool:${run.id}:${status}`,
        toolCallId: `call_${status}`,
        target: {
          id: `provider:${fixture.imageProviderId}`,
          ref: { kind: "provider", providerPresetId: fixture.imageProviderId },
          generationKind: "image",
          displayName: "Studio Image",
        },
        mediaJob: {
          providerPresetId: fixture.imageProviderId,
          operation: "image_generate",
          prompt: `${status} task`,
        },
      }, now);
      fixture.store.updateMediaJobStatus(created.mediaJob.id, { status }, now);
      return created;
    });

    const recovered = recoverPendingConversationMediaWorkUnits(fixture.store, "2026-08-11T01:02:00.000Z");
    assert.equal(recovered, 0);
    assert.deepEqual(jobs.map(({ mediaJob }) => fixture.store.getMediaJob(mediaJob.id).status), ["failed", "cancelled"]);
    assert.deepEqual(jobs.map(({ workUnit }) => fixture.store.getWorkUnit(workUnit.id).status), ["queued", "queued"]);
  } finally {
    await fixture.close();
  }
});

test("concurrent provider dispatches share one paid submission and one work unit attempt", async () => {
  const fixture = await createFixture();
  const imageServer = await startDelayedOpenAIImageServer();
  const runtimeSupervisor = new RuntimeSupervisor(runtimeConfig(fixture.cwd));
  try {
    fixture.store.updateProviderPreset(fixture.imageProviderId, { baseUrl: imageServer.url }, now);
    fixture.store.recordProviderCheckResult(fixture.imageProviderId, {
      ok: true,
      code: "ready",
      message: "Generation provider is ready.",
      checkedAt: now,
    });
    fixture.store.updateWorkspaceSettings({
      mediaGenerationDefaults: {
        image: { kind: "provider", providerPresetId: fixture.imageProviderId },
      },
    }, now);
    const run = createConversationRun(fixture, "run_concurrent_provider_dispatch");
    const handler = createConversationMediaGenerationToolHandler({
      store: fixture.store,
      storeRegistry: fixture.storeRegistry,
      secretResolver: fixture.secretResolver,
      runtimeSupervisor,
      run,
      launchMediaJob() {},
    });
    const accepted = handler({
      toolCallId: "call_concurrent_provider_dispatch",
      toolName: "image_generate",
      runId: run.id,
      prompt: "One paid request despite concurrent dispatch",
      task: { id: run.taskId, title: "Generate", prompt: "Draw" },
      cwd: fixture.cwd,
    });
    assert.equal(accepted.isError, undefined);
    const mediaJobId = accepted.details.mediaJobId;
    const runInput = {
      cwd: fixture.cwd,
      storeRegistry: fixture.storeRegistry,
      secretResolver: fixture.secretResolver,
      mediaJobId,
      hooks: mediaRuntimeHooks(runtimeSupervisor),
    };
    const first = runProviderMediaJobExecution(runInput);
    await imageServer.waitUntilRequested();
    const second = runProviderMediaJobExecution(runInput);
    imageServer.release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.body.mediaJob.id, mediaJobId);
    assert.equal(secondResult.body.mediaJob.id, mediaJobId);
    assert.equal(imageServer.requests.length, 1);
    const child = fixture.store.listWorkUnits({ linkedMediaJobId: mediaJobId, limit: 10 });
    assert.equal(child.length, 1);
    assert.equal(fixture.store.listWorkUnitAttempts(child[0].id).length, 1);
  } finally {
    runtimeSupervisor.releaseAll();
    await imageServer.close();
    await fixture.close();
  }
});

test("concurrent workflow dispatches share one ComfyUI submission and one work unit attempt", async () => {
  const fixture = await createFixture();
  const comfy = await startDelayedComfyUiSubmitServer();
  const runtimeSupervisor = new RuntimeSupervisor(runtimeConfig(fixture.cwd));
  try {
    const connection = fixture.store.listMediaWorkflowConnections()[0];
    const definition = fixture.store.getMediaWorkflowDefinition(fixture.workflowId);
    assert.ok(connection && definition);
    fixture.store.updateMediaWorkflowConnection(connection.id, {
      baseUrl: comfy.url,
      protocolVariant: "prompt_legacy",
    }, now);
    publishReadyWorkflowConnection(fixture.store, connection.id);
    const version = fixture.store.createMediaWorkflowVersion({
      workflowDefinitionId: definition.id,
      sourceDigest: "digest-concurrent-workflow",
      graphSnapshot: {
        "1": { class_type: "CLIPTextEncode", inputs: { text: "" } },
        "2": { class_type: "VHS_VideoCombine", inputs: {} },
      },
      inputFields: [{
        id: "prompt",
        label: "Prompt",
        kind: "text",
        semantic: "prompt",
        required: true,
        nodeId: "1",
        inputName: "text",
      }],
      outputRules: [{ nodeId: "2", artifactType: "video", collect: "first" }],
      validation: { ok: true, errors: [], warnings: [], checkedAt: now },
    }, now);
    fixture.store.updateMediaWorkflowDefinition(definition.id, {
      status: "ready",
      currentVersionId: version.id,
    }, now);
    fixture.store.updateWorkspaceSettings({
      mediaGenerationDefaults: {
        video: { kind: "workflow", workflowDefinitionId: fixture.workflowId },
      },
    }, now);
    const run = createConversationRun(fixture, "run_concurrent_workflow_dispatch");
    const handler = createConversationMediaGenerationToolHandler({
      store: fixture.store,
      storeRegistry: fixture.storeRegistry,
      secretResolver: fixture.secretResolver,
      runtimeSupervisor,
      run,
      launchMediaJob() {},
    });
    const accepted = handler({
      toolCallId: "call_concurrent_workflow_dispatch",
      toolName: "video_generate",
      runId: run.id,
      prompt: "One ComfyUI request despite concurrent dispatch",
      task: { id: run.taskId, title: "Generate", prompt: "Animate" },
      cwd: fixture.cwd,
    });
    assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
    const mediaJobId = accepted.details.mediaJobId;
    const runInput = {
      cwd: fixture.cwd,
      storeRegistry: fixture.storeRegistry,
      secretResolver: fixture.secretResolver,
      mediaJobId,
      hooks: mediaRuntimeHooks(runtimeSupervisor),
    };
    const first = runWorkflowMediaJobExecution(runInput);
    await comfy.waitUntilRequested();
    const second = runWorkflowMediaJobExecution(runInput);
    comfy.release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.statusCode, 202);
    assert.equal(secondResult.statusCode, 202);
    assert.equal(
      comfy.requests.filter((request) => request.method === "POST" && request.path === "/api/prompt").length,
      1,
    );
    const children = fixture.store.listWorkUnits({ linkedMediaJobId: mediaJobId, limit: 10 });
    assert.equal(children.length, 1);
    assert.equal(fixture.store.listWorkUnitAttempts(children[0].id).length, 1);
  } finally {
    runtimeSupervisor.releaseAll();
    await comfy.close();
    await fixture.close();
  }
});

test("background dispatch closes the conversation child when execution rejects before ownership starts", async () => {
  const fixture = await createFixture();
  const runtimeSupervisor = new RuntimeSupervisor(runtimeConfig(fixture.cwd));
  try {
    fixture.store.updateWorkspaceSettings({
      mediaGenerationDefaults: {
        image: { kind: "provider", providerPresetId: fixture.imageProviderId },
      },
    }, now);
    const run = createConversationRun(fixture, "run_background_dispatch_rejection");
    const handler = createConversationMediaGenerationToolHandler({
      store: fixture.store,
      storeRegistry: fixture.storeRegistry,
      secretResolver: fixture.secretResolver,
      runtimeSupervisor,
      run,
      launchMediaJob() {},
    });
    const accepted = handler({
      toolCallId: "call_background_dispatch_rejection",
      toolName: "image_generate",
      runId: run.id,
      prompt: "Fail before runtime ownership starts",
      task: { id: run.taskId, title: "Generate", prompt: "Draw" },
      cwd: fixture.cwd,
    });
    assert.equal(accepted.isError, undefined);
    const mediaJobId = accepted.details.mediaJobId;
    const child = fixture.store.listWorkUnits({ linkedMediaJobId: mediaJobId, limit: 10 })[0];
    let getMediaJobCalls = 0;
    const throwingStore = new Proxy(fixture.store, {
      get(target, property) {
        if (property === "getMediaJob") {
          return (id) => {
            getMediaJobCalls += 1;
            if (getMediaJobCalls === 1) throw new Error("Synthetic dispatch boundary failure");
            return target.getMediaJob(id);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    dispatchMediaJobExecution({
      cwd: fixture.cwd,
      storeRegistry: { getStore: () => throwingStore, mediaLocalExecutions: fixture.storeRegistry.mediaLocalExecutions },
      secretResolver: fixture.secretResolver,
      mediaJobId,
      hooks: mediaRuntimeHooks(runtimeSupervisor),
    });
    await waitForCondition(
      () => fixture.store.getMediaJob(mediaJobId)?.status === "failed" && fixture.store.getWorkUnit(child.id)?.status === "failed",
      "background media dispatch failure to close its child",
    );

    assert.equal(fixture.store.listWorkUnitAttempts(child.id).length, 0);
    assert.equal(fixture.store.getMediaJobExecutionHandle(mediaJobId), undefined);
  } finally {
    runtimeSupervisor.releaseAll();
    await fixture.close();
  }
});

async function createFixture() {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-conversation-media-generation-"));
  const store = createSqliteRunStore(cwd);
  const mediaLocalExecutions = new MediaLocalExecutionRegistry();
  const storeRegistry = { getStore: () => store, mediaLocalExecutions };
  const imageProvider = store.createProviderPreset({
    kind: "openai",
    displayName: "Studio Image",
    providerId: "openai",
    model: "gpt-image-1",
    api: "media-job",
    baseUrl: "https://example.invalid/v1",
    capabilities: ["image_generate"],
    compat: { mediaVendorTransport: { mode: "live" } },
  }, now);
  store.setProviderSecret(imageProvider.id, "test-secret", now);
  store.updateProviderPreset(imageProvider.id, { apiKeyRef: `local:${imageProvider.id}` }, now);
  store.recordProviderCheckResult(imageProvider.id, {
    ok: true,
    code: "ready",
    message: "Generation provider is ready.",
    checkedAt: now,
  });

  const connection = store.createMediaWorkflowConnection({
    name: "Local ComfyUI",
    baseUrl: "http://127.0.0.1:8188",
    authMode: "none",
    networkPolicy: "trusted_private_network",
  }, now);
  store.updateMediaWorkflowConnection(connection.id, { status: "ready" }, now);
  const workflow = store.createMediaWorkflowDefinition({
    connectionId: connection.id,
    name: "Storyboard Flow",
  }, now);
  const version = store.createMediaWorkflowVersion({
    workflowDefinitionId: workflow.id,
    sourceDigest: "digest-storyboard",
    graphSnapshot: {},
    inputFields: [{
      id: "prompt",
      label: "Prompt",
      kind: "text",
      semantic: "prompt",
      required: true,
      nodeId: "1",
      inputName: "text",
    }],
    outputRules: [{ nodeId: "2", artifactType: "video", collect: "first" }],
    validation: { ok: true, errors: [], warnings: [], checkedAt: now },
  }, now);
  store.updateMediaWorkflowDefinition(workflow.id, {
    status: "ready",
    currentVersionId: version.id,
  }, now);
  const secretResolver = {
    status(ref) { return { ref, kind: "env", configured: false }; },
    resolve(ref) { return { ref, configured: false }; },
  };
  return {
    cwd,
    store,
    storeRegistry,
    secretResolver,
    imageProviderId: imageProvider.id,
    workflowId: workflow.id,
    async close() {
      mediaLocalExecutions.beginShutdown();
      await mediaLocalExecutions.waitForIdle();
      store.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

function createConversationRun(fixture, id) {
  return fixture.store.createRun({
    id,
    cwd: fixture.cwd,
    taskId: `${id}_message`,
    providerName: "chat",
    providerModel: "chat-model",
    taskSnapshot: { id: `${id}_message`, title: "Generate", prompt: "Draw" },
    providerSnapshot: { provider: "chat", model: "chat-model" },
    requestSnapshot: { cwd: fixture.cwd },
    createdAt: now,
  });
}

function runtimeConfig(cwd) {
  return {
    host: "127.0.0.1",
    port: 0,
    maxBodyBytes: 1024 * 1024,
    defaultWorkspaceCwd: cwd,
    runners: {},
    sandbox: {},
    runtimeTools: {},
    transports: { providerWebSocketFallback: true, localWebSocketRpc: true },
    channels: {},
    cuaDriver: {
      bundledEmbedded: { darwin: false, win32: false },
      packagedProvider: { darwin: false, win32: false },
    },
    remoteAccess: { listenerPort: 0, managementAllowedOrigins: [] },
  };
}

class MediaToolProbeRunner {
  prepareTaskInput = prepareFixtureTaskInput;
  runs = [];

  async runTask(options) {
    this.runs.push(options);
    options.onEvent?.({ type: "assistant_text_delta", text: "Media generation is available." });
    return {
      taskId: options.task.id,
      messages: [{ role: "assistant", content: "Media generation is available." }],
      events: [],
    };
  }
}

function mediaRuntimeHooks(runtimeSupervisor) {
  return {
    startRuntimeWorkUnit: (input) => startRuntimeWorkUnit({ ...input, runtimeSupervisor }),
    recoverRuntimeWorkUnit: (input) => retryRuntimeWorkUnit({ ...input, runtimeSupervisor }),
    transitionRuntimeWorkUnitTerminal: (input) => transitionWorkUnitTerminal(input.store, {
      workUnitId: input.workUnitId,
      attemptId: input.attemptId,
      event: input.event,
      attemptStatus: input.attemptStatus,
      runtimeEventType: input.runtimeEventType,
      actor: input.actor,
      now: input.now,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    }),
    transitionRuntimeWorkUnitCancelled: (input) => transitionWorkUnitCancelled(
      input.store,
      input.workUnitId,
      input.attemptId,
      input.reason,
    ),
  };
}

function configureToolOnlyMediaFixture(store, imageBaseUrl) {
  const chatProvider = store.createProviderPreset({
    kind: "glm",
    displayName: "Tool-only Chat",
    providerId: "tool-only-chat",
    model: "tool-only-chat-model",
    api: "google-generative-ai",
    capabilities: ["chat"],
    authHeader: false,
    enabled: true,
  }, now);
  store.recordProviderCheckResult(chatProvider.id, {
    ok: true,
    code: "ready",
    message: "Chat provider is ready.",
    checkedAt: now,
  });
  const imageProvider = store.createProviderPreset({
    kind: "openai",
    displayName: "Tool-only Image",
    providerId: "openai",
    model: "gpt-image-1",
    api: "media-job",
    baseUrl: imageBaseUrl,
    capabilities: ["image_generate"],
    compat: { mediaVendorTransport: { mode: "live" } },
    enabled: true,
  }, now);
  store.setProviderSecret(imageProvider.id, "test-media-secret", now);
  store.updateProviderPreset(imageProvider.id, { apiKeyRef: `local:${imageProvider.id}` }, now);
  store.recordProviderCheckResult(imageProvider.id, {
    ok: true,
    code: "ready",
    message: "Image provider is ready.",
    checkedAt: now,
  });
  store.updateWorkspaceSettings({
    defaultProviderPresetId: chatProvider.id,
    mediaGenerationDefaults: {
      image: { kind: "provider", providerPresetId: imageProvider.id },
    },
  }, now);
  return { chatProvider, imageProvider };
}

class ToolOnlyMediaRunner {
  prepareTaskInput = prepareFixtureTaskInput;
  runs = [];

  async runTask(options) {
    this.runs.push(options);
    assert.deepEqual(options.mediaGenerationTools?.map((tool) => tool.name), ["image_generate"]);
    assert.equal(typeof options.onMediaGenerationToolCall, "function");
    const toolCallId = `tool_only_image_${this.runs.length}`;
    options.onEvent?.({
      type: "tool_start",
      toolCallId,
      toolName: "image_generate",
      args: { prompt: options.task.prompt },
    });
    const result = await options.onMediaGenerationToolCall({
      toolCallId,
      toolName: "image_generate",
      runId: options.runId,
      prompt: `Generated for ${options.task.title}`,
      task: options.task,
      cwd: options.cwd,
      signal: options.signal,
    });
    assert.equal(result.isError, undefined);
    options.onEvent?.({
      type: "tool_end",
      toolCallId,
      toolName: "image_generate",
      result,
      isError: false,
    });
    return { taskId: options.task.id, messages: [], events: [] };
  }
}

function appendChannelUserMessage(store, channelId, body, idempotencyKey) {
  const channel = store.getChannel(channelId);
  assert.ok(channel);
  const thread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId,
    title: `${channel.name} conversation`,
    objective: `Root conversation for ${channel.name}.`,
  }, now).thread;
  const result = store.appendConversationUserTurn({
    channelId,
    threadId: thread.id,
    turnKind: thread.nextItemSequence > 1 ? "manual_followup" : "initial_request",
    title: body,
    userInstruction: body,
    payload: {
      body,
      format: "plain_text",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
    },
    domainRefs: [],
    idempotencyKey,
  }, now);
  return projectConversationItemToChannelMessage(result.item);
}

function createPersistedToolOnlyContinuationRun({
  store,
  sourceRun,
  intervention,
  replyMessageId,
  imageProviderId,
}) {
  const replyItem = store.getConversationItem(replyMessageId);
  assert.ok(replyItem?.turnId);
  const workUnit = store.createWorkUnit({
    id: `wu_tool_only_${intervention.id}`,
    workspaceId: DEFAULT_WORKSPACE_ID,
    kind: "channel_ai_reply",
    ownerType: "channel_message",
    ownerId: intervention.messagePayload.sourceMessageId,
    channelId: sourceRun.channelId,
    teammateId: "ling_agent",
    idempotencyKey: `tool-only-continuation:${intervention.id}`,
    createdByActor: "local-user",
    request: { sourceMessageId: intervention.messagePayload.sourceMessageId },
    linkedMessageId: replyMessageId,
    now,
  });
  const run = store.createRun({
    id: `run_tool_only_${intervention.id}`,
    cwd: store.paths.cwd,
    taskId: `task_tool_only_${intervention.id}`,
    channelId: sourceRun.channelId,
    threadId: replyItem.threadId,
    teammateId: "ling_agent",
    providerPresetId: sourceRun.providerPresetId,
    providerName: sourceRun.providerName,
    providerModel: sourceRun.providerModel,
    taskSnapshot: { id: `task_tool_only_${intervention.id}`, title: "Channel continuation", prompt: intervention.instruction },
    providerSnapshot: { provider: sourceRun.providerName, model: sourceRun.providerModel },
    requestSnapshot: {
      cwd: store.paths.cwd,
      sourceMessageId: intervention.messagePayload.sourceMessageId,
      linkedMessageId: replyMessageId,
      mediaGenerationDefaults: { image: { kind: "provider", providerPresetId: imageProviderId } },
    },
    workUnitId: workUnit.id,
    parentRunId: sourceRun.id,
    interventionId: intervention.id,
    continuationReason: "queue_followup",
    createdAt: now,
  });
  store.linkRunToWorkUnit(run.id, workUnit.id, now);
  store.linkRunToLingTurn({ turnId: replyItem.turnId, runId: run.id, role: "primary", now });
  return store.getRun(run.id);
}

function buildContinuationSystemPromptForAssertion(store, sourceRun, intervention, sourceMessageId) {
  return buildChannelReplyContinuationContext({
    store,
    sourceRun,
    intervention,
    sourceMessageId,
  }).systemPromptInstruction;
}

function projectChannelReply(payload) {
  const item = payload.assistantItems?.[0];
  const decoration = payload.decorations?.find((candidate) => candidate.itemId === item?.id);
  assert.ok(item);
  return {
    id: item.id,
    body: item.payload.body,
    status: item.payload.deliveryStatus,
    linkedRunId: decoration?.linkedRunId,
  };
}

function parseSseEvents(text) {
  return text
    .split(/\n\n/u)
    .map((block) => {
      const lines = block.split(/\r?\n/u);
      const event = lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim();
      const data = lines.find((line) => line.startsWith("data:"))?.slice("data:".length).trim();
      return event && data ? { event, data: JSON.parse(data) } : undefined;
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

async function waitForCondition(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.fail(`Timed out waiting for ${label}.`);
}

async function startMockOpenAIImageServer() {
  const requests = [];
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      method: request.method,
      path: request.url,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: pngBase64 }] }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

async function startRecoverableComfyUiServer() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    requests.push({ method: request.method, path: url.pathname });
    if (request.method === "GET" && url.pathname === "/api/history_v2/prompt_existing") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/history/prompt_existing") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        prompt_existing: {
          status: { status_str: "success", completed: true },
          outputs: { "2": { videos: [{ filename: "recovered.mp4", type: "output" }] } },
        },
      }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/view") {
      response.writeHead(200, { "content-type": "video/mp4", "content-length": "15" });
      response.end(Buffer.from("recovered-video"));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
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

async function startDelayedOpenAIImageServer() {
  const requests = [];
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  let releaseResponse;
  let markRequested;
  const released = new Promise((resolveReleased) => { releaseResponse = resolveReleased; });
  const requested = new Promise((resolveRequested) => { markRequested = resolveRequested; });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ method: request.method, path: request.url, body: Buffer.concat(chunks).toString("utf8") });
    markRequested();
    await released;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: pngBase64 }] }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    waitUntilRequested: () => requested,
    release: () => releaseResponse(),
    close: () => new Promise((resolveClose, rejectClose) => {
      releaseResponse();
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

async function startDelayedComfyUiSubmitServer() {
  const requests = [];
  let releaseResponse;
  let markRequested;
  const released = new Promise((resolveReleased) => { releaseResponse = resolveReleased; });
  const requested = new Promise((resolveRequested) => { markRequested = resolveRequested; });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ method: request.method, path: url.pathname, body: Buffer.concat(chunks).toString("utf8") });
    if (request.method === "POST" && url.pathname === "/api/prompt") {
      markRequested();
      await released;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ prompt_id: "prompt_concurrent" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    waitUntilRequested: () => requested,
    release: () => releaseResponse(),
    close: () => new Promise((resolveClose, rejectClose) => {
      releaseResponse();
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

const emptySecretResolver = {
  status(ref) {
    return { ref, kind: "env", configured: false };
  },
  resolve(ref) {
    return { ref, configured: false };
  },
};
