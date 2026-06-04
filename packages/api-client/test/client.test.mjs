import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonClient, LingDaemonError, daemonBaseUrlFromEnv } from "../dist/index.js";

function createFetchMock(responseBody = { ok: true }) {
  const calls = [];
  const responses = Array.isArray(responseBody) ? [...responseBody] : undefined;
  const fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
    });
    return jsonResponse(responses ? responses.shift() : responseBody);
  };
  return { calls, fetch };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    headers: { "Content-Type": "application/json" },
  });
}

test("daemonBaseUrlFromEnv trims configured URL and falls back to local daemon", () => {
  assert.equal(daemonBaseUrlFromEnv({ VITE_LING_STACK_DAEMON_URL: "http://127.0.0.1:9999/" }), "http://127.0.0.1:9999");
  assert.equal(daemonBaseUrlFromEnv({}), "http://127.0.0.1:17891");
});

test("binds global fetch to globalThis when no custom fetch is provided", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async function (url, init = {}) {
      assert.equal(this, globalThis);
      assert.equal(String(url), "http://daemon.test/runs?cwd=%2Frepo&limit=50");
      assert.equal(init.method, "GET");
      return jsonResponse({ cwd: "/repo", runs: [] });
    };

    const client = new LingDaemonClient({ baseUrl: "http://daemon.test" });
    await client.listRuns("/repo");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("builds URL query parameters for list endpoints", async () => {
  const mock = createFetchMock({ cwd: "/repo", runs: [] });
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test/", fetch: mock.fetch });

  await client.listRuns("/repo path", 25);
  await client.listChannelMessages("/repo", "channel 1", { limit: 15 });
  await client.listChannelAttachments("/repo", "channel 1", 16);
  await client.listChannelLinkPreviews("/repo", "channel 1", 17);
  await client.getChannelBrief("/repo", "channel 1");
  await client.listChannelDecisions("/repo", "channel 1", { status: "active", limit: 18 });
  await client.listChannelHandoffs("/repo", "channel 1", { status: "proposed", limit: 19 });
  await client.listChannelContextSummaries("/repo", "channel 1", { targetType: "task", targetId: "task 1", limit: 20 });
  await client.listChannelWorkflows("/repo", "channel 1", { status: "running", limit: 21 });
  await client.listChannelWorkflowSteps("/repo", "workflow 1", { status: "queued", limit: 22 });
  await client.listTasks("/repo", { channelId: "ch 1", status: "todo", limit: 5 });
  await client.listApprovals("/repo", { status: "pending", runId: "run 1", mediaJobId: "media 1", limit: 7 });
  await client.listStateTransitions("/repo", { entityType: "task", entityId: "task 1", limit: 9 });
  await client.listResourceLeases("/repo", { status: "active", ownerId: "run 1", limit: 11 });
  await client.listGitHubExternalWorkCiTriage("/repo", { externalWorkId: "external work 1", channelId: "channel 1", status: "task_created", limit: 12 });
  await client.getGitHubExternalWorkCiTriage("/repo", "triage 1");
  await client.getSecretStatus("keychain:provider 1", "provider_api_key");

  assert.equal(mock.calls[0].url, "http://daemon.test/runs?cwd=%2Frepo+path&limit=25");
  assert.equal(mock.calls[1].url, "http://daemon.test/channels/channel%201/messages?cwd=%2Frepo&limit=15");
  assert.equal(mock.calls[2].url, "http://daemon.test/channels/channel%201/attachments?cwd=%2Frepo&limit=16");
  assert.equal(mock.calls[3].url, "http://daemon.test/channels/channel%201/link-previews?cwd=%2Frepo&limit=17");
  assert.equal(mock.calls[4].url, "http://daemon.test/channels/channel%201/brief?cwd=%2Frepo");
  assert.equal(mock.calls[5].url, "http://daemon.test/channels/channel%201/decisions?cwd=%2Frepo&status=active&limit=18");
  assert.equal(mock.calls[6].url, "http://daemon.test/channels/channel%201/handoffs?cwd=%2Frepo&status=proposed&limit=19");
  assert.equal(mock.calls[7].url, "http://daemon.test/channels/channel%201/context-summaries?cwd=%2Frepo&targetType=task&targetId=task+1&limit=20");
  assert.equal(mock.calls[8].url, "http://daemon.test/channels/channel%201/workflows?cwd=%2Frepo&status=running&limit=21");
  assert.equal(mock.calls[9].url, "http://daemon.test/workflows/workflow%201/steps?cwd=%2Frepo&status=queued&limit=22");
  assert.equal(mock.calls[10].url, "http://daemon.test/tasks?cwd=%2Frepo&channelId=ch+1&status=todo&limit=5");
  assert.equal(mock.calls[11].url, "http://daemon.test/approvals?cwd=%2Frepo&status=pending&runId=run+1&mediaJobId=media+1&limit=7");
  assert.equal(mock.calls[12].url, "http://daemon.test/state-transitions?cwd=%2Frepo&entityType=task&entityId=task+1&limit=9");
  assert.equal(mock.calls[13].url, "http://daemon.test/runtime/leases?cwd=%2Frepo&status=active&ownerId=run+1&limit=11");
  assert.equal(mock.calls[14].url, "http://daemon.test/external-work/github/ci/triage?cwd=%2Frepo&externalWorkId=external+work+1&channelId=channel+1&status=task_created&limit=12");
  assert.equal(mock.calls[15].url, "http://daemon.test/external-work/github/ci/triage/triage%201?cwd=%2Frepo");
  assert.equal(mock.calls[16].url, "http://daemon.test/secrets/status?ref=keychain%3Aprovider+1&purpose=provider_api_key");
});

test("gets external work status with channel and workflow path", async () => {
  const mock = createFetchMock({ cwd: "/repo", workflow: { valid: true } });
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test/", fetch: mock.fetch });

  await client.getExternalWorkStatus("/repo", { channelId: "channel 1", workflowPath: "WORKFLOW.md" });

  assert.equal(mock.calls[0].method, "GET");
  assert.equal(mock.calls[0].url, "http://daemon.test/external-work/status?cwd=%2Frepo&channelId=channel+1&workflowPath=WORKFLOW.md");
});

test("configures and deletes external work secrets without transforming daemon responses", async () => {
  const configureResponse = {
    cwd: "/repo",
    channelId: "channel_1",
    sourceKind: "github",
    secretRef: "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
    secret: {
      ref: "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
      purpose: "github_token",
      status: "configured",
    },
    workflow: {
      path: "/repo/WORKFLOW.md",
      exists: true,
      valid: true,
      sourceKind: "github",
      repository: "owner/repo",
      events: ["pull_request.opened"],
      secretRef: "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
    },
    workflowUpdated: true,
  };
  const deleteResponse = {
    ...configureResponse,
    secret: {
      ref: "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
      purpose: "github_token",
      status: "missing",
    },
    workflowUpdated: false,
  };
  const mock = createFetchMock([configureResponse, deleteResponse]);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test/", fetch: mock.fetch });

  assert.deepEqual(await client.configureExternalWorkSecret("/repo path", {
    channelId: "channel 1",
    workflowPath: "WORKFLOW.md",
    token: "test-github-token",
    secretRef: "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
  }), configureResponse);
  assert.deepEqual(await client.deleteExternalWorkSecret("/repo path", {
    channelId: "channel 1",
    workflowPath: "WORKFLOW.md",
    secretRef: "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
  }), deleteResponse);

  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/external-work/secrets/configure?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[0].body), {
    channelId: "channel 1",
    workflowPath: "WORKFLOW.md",
    token: "test-github-token",
    secretRef: "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
  });
  assert.equal(mock.calls[1].method, "POST");
  assert.equal(mock.calls[1].url, "http://daemon.test/external-work/secrets/delete?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[1].body), {
    channelId: "channel 1",
    workflowPath: "WORKFLOW.md",
    secretRef: "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
  });
});

test("configures external work workflow without transforming daemon responses", async () => {
  const response = {
    cwd: "/repo",
    channelId: "channel_1",
    sourceKind: "github",
    workflow: {
      path: "/repo/WORKFLOW.md",
      exists: true,
      valid: true,
      sourceKind: "github",
      repository: "owner/repo",
      events: ["pull_request.opened", "pull_request.synchronize", "issue.opened"],
    },
    workflowCreated: true,
    workflowUpdated: true,
  };
  const mock = createFetchMock(response);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test/", fetch: mock.fetch });

  assert.deepEqual(await client.configureExternalWorkWorkflow("/repo path", {
    channelId: "channel 1",
    workflowPath: "WORKFLOW.md",
    sourceKind: "github",
    repository: "owner/repo",
  }), response);

  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/external-work/workflow/configure?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[0].body), {
    channelId: "channel 1",
    workflowPath: "WORKFLOW.md",
    sourceKind: "github",
    repository: "owner/repo",
  });
});

test("sends mutation bodies for channel, task, provider, policy, media, and approval requests", async () => {
  const mock = createFetchMock({ channel: { id: "ch_1" } });
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  await client.createChannel("/repo", {
    name: "Engineering",
    status: "active",
    boundPath: "/repo",
    defaultTeammateId: "engineer",
    allowedTools: ["read"],
    runtimePolicy: {
      maxConcurrentRuns: 1,
      executionMode: "serial",
      writeLockScope: "boundPath",
      allowReadOnlyParallel: true,
      queueOnConflict: true,
    },
  });
  await client.updateChannel("/repo", "channel 1", { defaultTeammateId: "designer" });
  await client.createChannelMessage("/repo", "channel 1", {
    body: "hello @Engineer",
    mentions: [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }],
    requestAiReply: true,
  });
  await client.createChannelAttachment("/repo", "channel 1", {
    fileName: "brief.txt",
    contentType: "text/plain",
    contentBase64: "aGVsbG8=",
  });
  await client.createChannelLinkPreview("/repo", "channel 1", { url: "https://example.com" });
  await client.updateChannelBrief("/repo", "channel 1", {
    objective: "Ship channel v1.1",
    scope: "Protocol tracking",
    acceptanceCriteria: ["Brief persists"],
    updatedBy: "local-user",
  });
  await client.createChannelDecision("/repo", "channel 1", {
    sourceMessageId: "msg 1",
    title: "Use manual handoffs",
    decision: "Handoffs stay manual.",
    createdBy: "local-user",
  });
  await client.updateChannelDecision("/repo", "decision 1", { status: "superseded" });
  await client.createChannelHandoff("/repo", "channel 1", {
    sourceTaskId: "task 1",
    fromParticipantId: "tian",
    fromParticipantLabel: "Tian",
    toParticipantId: "engineer",
    toParticipantLabel: "Engineer",
    reason: "Need implementation",
    requiredInput: "Plan",
    expectedOutput: "Patch",
    createdBy: "local-user",
  });
  await client.updateChannelHandoff("/repo", "handoff 1", { status: "completed" });
  await client.createChannelContextSummary("/repo", "channel 1", {
    targetType: "task",
    targetId: "task 1",
    sourceMessageIds: ["msg 1"],
    decisionIds: ["decision 1"],
    summary: "Build the protocol layer.",
    authorType: "local-user",
  });
  await client.updateChannelContextSummary("/repo", "summary 1", { openQuestions: ["None"] });
  await client.createChannelWorkflow("/repo", "channel 1", {
    sourceHandoffId: "handoff 1",
    title: "Engineer handoff",
    objective: "Ship workflow",
    createdBy: "local-user",
  });
  await client.updateChannelWorkflow("/repo", "workflow 1", { status: "running" });
  await client.createChannelWorkflowFromHandoff("/repo", "handoff 1", { createdBy: "local-user" });
  await client.createChannelWorkflowStep("/repo", "workflow 1", {
    title: "Implement",
    prompt: "Build the patch",
    toParticipantId: "engineer",
    toParticipantLabel: "Engineer",
  });
  await client.updateChannelWorkflowStep("/repo", "step 1", { status: "skipped", resultSummary: "Not needed" });
  await client.startChannelWorkflowStep("/repo", "step 1", { mode: "create_task", taskTitle: "Implement" });
  await client.updateTask("/repo", "task 1", { title: "T", prompt: "P", status: "review" });
  await client.updateProvider("/repo", "provider 1", {
    kind: "openai-compatible",
    displayName: "Relay",
    providerId: "relay",
    model: "gpt",
    api: "openai-completions",
    capabilities: ["chat"],
    input: ["text"],
    enabled: true,
  });
  await client.updateApprovalPolicy("/repo", { toolDecisions: { read: "allow", grep: "allow", find: "allow", ls: "allow", bash: "ask", edit: "ask", write: "ask" }, allowedWritePaths: ["/repo"] });
  await client.createMediaJob("/repo", { providerPresetId: "media", operation: "image_generate", prompt: "draw", input: { size: "1024x1024" } });
  await client.approveApproval("/repo", "approval 1", "looks good");
  await client.denyApproval("/repo", "approval 2");

  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/channels?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[0].body), {
    name: "Engineering",
    status: "active",
    boundPath: "/repo",
    defaultTeammateId: "engineer",
    allowedTools: ["read"],
    runtimePolicy: {
      maxConcurrentRuns: 1,
      executionMode: "serial",
      writeLockScope: "boundPath",
      allowReadOnlyParallel: true,
      queueOnConflict: true,
    },
  });
  assert.equal(mock.calls[1].method, "PATCH");
  assert.equal(mock.calls[1].url, "http://daemon.test/channels/channel%201?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[1].body), { defaultTeammateId: "designer" });
  assert.equal(mock.calls[2].method, "POST");
  assert.equal(mock.calls[2].url, "http://daemon.test/channels/channel%201/messages?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[2].body), {
    body: "hello @Engineer",
    mentions: [{ id: "engineer", label: "Engineer", kind: "ai-teammate" }],
    requestAiReply: true,
  });
  assert.equal(mock.calls[3].url, "http://daemon.test/channels/channel%201/attachments?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[3].body), { fileName: "brief.txt", contentType: "text/plain", contentBase64: "aGVsbG8=" });
  assert.equal(mock.calls[4].url, "http://daemon.test/channels/channel%201/link-previews?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[4].body), { url: "https://example.com" });
  assert.equal(mock.calls[5].method, "PATCH");
  assert.equal(mock.calls[5].url, "http://daemon.test/channels/channel%201/brief?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[5].body).acceptanceCriteria, ["Brief persists"]);
  assert.equal(mock.calls[6].url, "http://daemon.test/channels/channel%201/decisions?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[6].body).sourceMessageId, "msg 1");
  assert.equal(mock.calls[7].url, "http://daemon.test/decisions/decision%201?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[7].body), { status: "superseded" });
  assert.equal(mock.calls[8].url, "http://daemon.test/channels/channel%201/handoffs?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[8].body).toParticipantId, "engineer");
  assert.equal(mock.calls[9].url, "http://daemon.test/handoffs/handoff%201?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[9].body), { status: "completed" });
  assert.equal(mock.calls[10].url, "http://daemon.test/channels/channel%201/context-summaries?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[10].body).decisionIds, ["decision 1"]);
  assert.equal(mock.calls[11].url, "http://daemon.test/context-summaries/summary%201?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[11].body), { openQuestions: ["None"] });
  assert.equal(mock.calls[12].url, "http://daemon.test/channels/channel%201/workflows?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[12].body).sourceHandoffId, "handoff 1");
  assert.equal(mock.calls[13].url, "http://daemon.test/workflows/workflow%201?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[13].body), { status: "running" });
  assert.equal(mock.calls[14].url, "http://daemon.test/handoffs/handoff%201/workflow?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[14].body), { createdBy: "local-user" });
  assert.equal(mock.calls[15].url, "http://daemon.test/workflows/workflow%201/steps?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[15].body).toParticipantId, "engineer");
  assert.equal(mock.calls[16].url, "http://daemon.test/workflow-steps/step%201?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[16].body), { status: "skipped", resultSummary: "Not needed" });
  assert.equal(mock.calls[17].url, "http://daemon.test/workflow-steps/step%201/start?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[17].body), { mode: "create_task", taskTitle: "Implement" });
  assert.equal(mock.calls[18].method, "PATCH");
  assert.equal(mock.calls[18].url, "http://daemon.test/tasks/task%201?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[18].body), { title: "T", prompt: "P", status: "review" });
  assert.equal(mock.calls[19].url, "http://daemon.test/providers/provider%201?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[20].body).allowedWritePaths, ["/repo"]);
  assert.deepEqual(JSON.parse(mock.calls[21].body), { providerPresetId: "media", operation: "image_generate", prompt: "draw", input: { size: "1024x1024" } });
  assert.deepEqual(JSON.parse(mock.calls[22].body), { reason: "looks good" });
  assert.deepEqual(JSON.parse(mock.calls[23].body), {});
});

test("uses expected routes for delete, cancel, check, and artifact URLs", async () => {
  const mock = createFetchMock({ ok: true });
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  await client.deleteChannel("/repo", "channel 1");
  await client.deleteChannelAttachment("/repo", "attachment 1");
  await client.cancelRun("/repo", "run 1");
  await client.checkProvider("/repo", "provider 1");
  await client.refreshChannelLinkPreview("/repo", "link 1");

  assert.equal(mock.calls[0].method, "DELETE");
  assert.equal(mock.calls[0].url, "http://daemon.test/channels/channel%201?cwd=%2Frepo");
  assert.equal(mock.calls[1].method, "DELETE");
  assert.equal(mock.calls[1].url, "http://daemon.test/attachments/attachment%201?cwd=%2Frepo");
  assert.equal(mock.calls[2].method, "POST");
  assert.equal(mock.calls[2].url, "http://daemon.test/runs/run%201/cancel?cwd=%2Frepo");
  assert.equal(mock.calls[3].method, "POST");
  assert.equal(mock.calls[3].url, "http://daemon.test/providers/provider%201/check?cwd=%2Frepo");
  assert.equal(mock.calls[4].method, "POST");
  assert.equal(mock.calls[4].url, "http://daemon.test/link-previews/link%201/refresh?cwd=%2Frepo");
  assert.equal(client.artifactContentUrl("artifact 1", "/repo"), "http://daemon.test/artifacts/artifact%201/content?cwd=%2Frepo");
  assert.equal(client.attachmentContentUrl("attachment 1", "/repo"), "http://daemon.test/attachments/attachment%201/content?cwd=%2Frepo");
});

test("uses expected teammate private data lifecycle routes", async () => {
  const mock = createFetchMock({ ok: true });
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  await client.hardDeleteAiTeammate("/repo", "teammate 1", { reason: "owner request" });
  await client.streamTeammateDirectMessage("/repo", "teammate 1", { body: "hello", attachmentIds: ["att 1"] });
  await client.listTeammatePrivateAttachments("/repo", "teammate 1", 12);
  await client.createTeammatePrivateAttachment("/repo", "teammate 1", { fileName: "a.txt", contentBase64: "YQ==" });
  await client.uploadTeammateAvatar("/repo", "teammate 1", { fileName: "a.png", contentBase64: "YQ==", scope: "teammate_profile_avatar" });
  await client.deleteTeammateAvatar("/repo", "teammate 1");

  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/teammates/teammate%201/hard-delete?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[0].body), { reason: "owner request" });
  assert.equal(mock.calls[1].method, "POST");
  assert.equal(mock.calls[1].url, "http://daemon.test/teammates/teammate%201/direct-messages/stream?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[1].body), { body: "hello", attachmentIds: ["att 1"] });
  assert.equal(mock.calls[2].url, "http://daemon.test/teammates/teammate%201/direct-attachments?cwd=%2Frepo&limit=12");
  assert.equal(mock.calls[3].url, "http://daemon.test/teammates/teammate%201/direct-attachments?cwd=%2Frepo");
  assert.equal(mock.calls[4].url, "http://daemon.test/teammates/teammate%201/avatar?cwd=%2Frepo");
  assert.equal(mock.calls[5].method, "DELETE");
  assert.equal(mock.calls[5].url, "http://daemon.test/teammates/teammate%201/avatar?cwd=%2Frepo");
});

test("imports GitHub and Linear external work without transforming daemon responses", async () => {
  const importResponse = {
    externalWorkItem: {
      id: "github:pull_request:owner/repo#123",
      sourceKind: "github",
      kind: "github_pull_request",
      identifier: "owner/repo#123",
      title: "Fix bug",
      state: "open",
      labels: ["bug"],
      payloadRef: "pull_request.opened:owner/repo#123",
      idempotencyKey: "github:pull_request:owner/repo:123:head-sha:updated-at",
    },
    workflow: { id: "workflow_1", status: "ready" },
    workflowStep: { id: "step_1", status: "queued" },
    artifacts: [{ id: "artifact_1", type: "json", path: "external-work/item.json", createdAt: "2026-05-31T00:00:00.000Z" }],
    duplicate: false,
  };
  const linearImportResponse = {
    externalWorkItem: {
      id: "linear:issue:linear-issue-123",
      sourceKind: "linear",
      kind: "linear_issue",
      identifier: "LIN-123",
      title: "Wire Linear external work",
      state: "Todo",
      labels: ["external-work"],
      payloadRef: "linear:fixture:LIN-123",
      idempotencyKey: "linear:issue:ling-stack:LIN-123:2026-06-01T00:00:00.000Z",
    },
    workflow: { id: "workflow_linear_1", status: "ready" },
    workflowStep: { id: "step_linear_1", status: "queued" },
    artifacts: [{ id: "artifact_linear_1", type: "json", path: "external-work/linear-item.json", createdAt: "2026-06-01T00:00:00.000Z" }],
    duplicate: false,
  };
  const mock = createFetchMock([importResponse, linearImportResponse]);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  const githubResponse = await client.importGitHubExternalWork("/repo path", {
    channelId: "channel 1",
    eventType: "pull_request.opened",
    payload: { pull_request: { number: 123 } },
    workflowPath: "WORKFLOW.md",
  });
  const linearResponse = await client.importLinearExternalWork("/repo path", {
    channelId: "channel 1",
    eventType: "issue.created",
    payload: { identifier: "LIN-123" },
    workflowPath: "WORKFLOW.md",
  });

  assert.deepEqual(githubResponse, importResponse);
  assert.deepEqual(linearResponse, linearImportResponse);
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/external-work/github/import?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[0].body), {
    channelId: "channel 1",
    eventType: "pull_request.opened",
    payload: { pull_request: { number: 123 } },
    workflowPath: "WORKFLOW.md",
  });
  assert.equal(mock.calls[1].method, "POST");
  assert.equal(mock.calls[1].url, "http://daemon.test/external-work/linear/import?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[1].body), {
    channelId: "channel 1",
    eventType: "issue.created",
    payload: { identifier: "LIN-123" },
    workflowPath: "WORKFLOW.md",
  });
});

test("polls and reconciles external work without transforming daemon responses", async () => {
  const pollResponse = {
    candidates: 1,
    claimed: 1,
    duplicates: 0,
    blocked: 0,
    retryScheduled: 0,
    terminalIgnored: 0,
    artifacts: [],
    results: [{ action: "claimed", identifier: "owner/repo#123" }],
    schedulerStates: [{ externalWorkId: "external_work_1", schedulerStatus: "ready" }],
  };
  const linearPollResponse = {
    ...pollResponse,
    results: [{ action: "claimed", identifier: "LIN-123" }],
    schedulerStates: [{ externalWorkId: "external_work_linear_1", schedulerStatus: "ready" }],
  };
  const reconcileResponse = {
    expiredLeases: 1,
    checked: 1,
    blocked: 0,
    retryReady: 0,
    terminal: 1,
    schedulerStates: [{ externalWorkId: "external_work_1", schedulerStatus: "terminal" }],
  };
  const mock = createFetchMock([pollResponse, linearPollResponse, reconcileResponse]);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  assert.deepEqual(await client.pollGitHubExternalWork("/repo", {
    channelId: "channel_1",
    workflowPath: "WORKFLOW.md",
    limit: 25,
    executeHooks: true,
  }), pollResponse);
  assert.deepEqual(await client.pollLinearExternalWork("/repo", {
    channelId: "channel_1",
    workflowPath: "WORKFLOW.md",
    limit: 10,
  }), linearPollResponse);
  assert.deepEqual(await client.reconcileExternalWork("/repo", {
    channelId: "channel_1",
    workflowPath: "WORKFLOW.md",
  }), reconcileResponse);

  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/external-work/github/poll?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[0].body), {
    channelId: "channel_1",
    workflowPath: "WORKFLOW.md",
    limit: 25,
    executeHooks: true,
  });
  assert.equal(mock.calls[1].method, "POST");
  assert.equal(mock.calls[1].url, "http://daemon.test/external-work/linear/poll?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[1].body), {
    channelId: "channel_1",
    workflowPath: "WORKFLOW.md",
    limit: 10,
  });
  assert.equal(mock.calls[2].method, "POST");
  assert.equal(mock.calls[2].url, "http://daemon.test/external-work/reconcile?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[2].body), {
    channelId: "channel_1",
    workflowPath: "WORKFLOW.md",
  });
});

test("manages GitHub external work background schedulers without transforming daemon responses", async () => {
  const scheduler = {
    id: "external_work_background_1",
    cwd: "/repo",
    sourceKind: "github",
    channelId: "channel_1",
    workflowPath: "WORKFLOW.md",
    repository: "owner/repo",
    pollIntervalMs: 30000,
    limit: 5,
    executeHooks: true,
    status: "running",
    startedAt: "2026-06-01T00:00:00.000Z",
    tickCount: 1,
  };
  const startResponse = { cwd: "/repo", scheduler, duplicate: false };
  const listResponse = { cwd: "/repo", schedulers: [scheduler] };
  const stopResponse = {
    cwd: "/repo",
    scheduler: {
      ...scheduler,
      status: "stopped",
      stoppedAt: "2026-06-01T00:01:00.000Z",
    },
  };
  const mock = createFetchMock([startResponse, listResponse, stopResponse]);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  assert.deepEqual(await client.startGitHubExternalWorkBackground("/repo", {
    channelId: "channel_1",
    workflowPath: "WORKFLOW.md",
    limit: 5,
    executeHooks: true,
    runImmediately: false,
  }), startResponse);
  assert.deepEqual(await client.listExternalWorkBackgroundSchedulers("/repo"), listResponse);
  assert.deepEqual(await client.stopExternalWorkBackgroundScheduler("/repo", "external_work_background_1"), stopResponse);

  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/external-work/github/background/start?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[0].body), {
    channelId: "channel_1",
    workflowPath: "WORKFLOW.md",
    limit: 5,
    executeHooks: true,
    runImmediately: false,
  });
  assert.equal(mock.calls[1].method, "GET");
  assert.equal(mock.calls[1].url, "http://daemon.test/external-work/background?cwd=%2Frepo");
  assert.equal(mock.calls[2].method, "POST");
  assert.equal(mock.calls[2].url, "http://daemon.test/external-work/background/external_work_background_1/stop?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[2].body), {});
});

test("triages GitHub external work CI without transforming daemon response", async () => {
  const triageResponse = {
    cwd: "/repo",
    triaged: 1,
    taskCreated: 1,
    duplicates: 0,
    blocked: 0,
    stale: 0,
    failed: 0,
    records: [{
      triage: {
        id: "external_work_ci_triage_1",
        externalWorkId: "external_work_1",
        status: "task_created",
        checkName: "web e2e",
      },
      artifacts: [],
    }],
  };
  const mock = createFetchMock(triageResponse);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  assert.deepEqual(await client.triageGitHubExternalWorkCi("/repo path", {
    externalWorkId: "external_work_1",
    workflowPath: "WORKFLOW.md",
    limit: 5,
    createTask: true,
  }), triageResponse);

  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/external-work/github/ci/triage?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[0].body), {
    externalWorkId: "external_work_1",
    workflowPath: "WORKFLOW.md",
    limit: 5,
    createTask: true,
  });
});

test("starts GitHub external work CI triage runs as an SSE request", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
    });
    return new Response("event: ready\ndata: {\"ok\":true,\"runId\":\"run_1\"}\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch });

  const response = await client.startGitHubExternalWorkCiTriageRun("/repo path", "triage 1", {
    providerPresetId: "provider_1",
    skipProviderPreflight: true,
    tools: ["read"],
    thinkingLevel: "low",
  });

  assert.equal(await response.text(), "event: ready\ndata: {\"ok\":true,\"runId\":\"run_1\"}\n\n");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "http://daemon.test/external-work/github/ci/triage/triage%201/run?cwd=%2Frepo+path");
  assert.deepEqual(calls[0].headers, {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(calls[0].body), {
    providerPresetId: "provider_1",
    skipProviderPreflight: true,
    tools: ["read"],
    thinkingLevel: "low",
  });
});

test("lists and shows external work without transforming daemon responses", async () => {
  const listResponse = {
    cwd: "/repo",
    externalWork: [{
      externalWork: { id: "external_work_1", identifier: "owner/repo#123", workItemKind: "github_pull_request" },
      schedulerState: { externalWorkId: "external_work_1", schedulerStatus: "ready" },
      artifacts: [],
    }],
  };
  const detailResponse = {
    cwd: "/repo",
    externalWork: listResponse.externalWork[0],
  };
  const mock = createFetchMock([listResponse, detailResponse]);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  assert.deepEqual(await client.listExternalWork("/repo path", {
    channelId: "channel_1",
    workItemKind: "github_pull_request",
    schedulerStatus: "ready",
    limit: 25,
  }), listResponse);
  assert.deepEqual(await client.getExternalWork("/repo path", "external_work_1"), detailResponse);

  assert.equal(mock.calls[0].method, "GET");
  assert.equal(mock.calls[0].url, "http://daemon.test/external-work?cwd=%2Frepo+path&channelId=channel_1&workItemKind=github_pull_request&schedulerStatus=ready&limit=25");
  assert.equal(mock.calls[1].method, "GET");
  assert.equal(mock.calls[1].url, "http://daemon.test/external-work/external_work_1?cwd=%2Frepo+path");
});

test("manages external work actions without transforming daemon responses", async () => {
  const mutationResponse = {
    cwd: "/repo",
    action: { id: "external_work_action_1", status: "waiting_for_approval", actionKind: "github_comment" },
    approval: { id: "approval_1", status: "pending" },
    artifacts: [],
    duplicate: false,
  };
  const listResponse = {
    cwd: "/repo",
    actions: [{ action: mutationResponse.action, approval: mutationResponse.approval, artifacts: [] }],
  };
  const detailResponse = {
    cwd: "/repo",
    action: listResponse.actions[0],
  };
  const cancelResponse = {
    ...mutationResponse,
    action: { ...mutationResponse.action, status: "cancelled" },
  };
  const executeResponse = {
    ...mutationResponse,
    action: { ...mutationResponse.action, status: "succeeded" },
  };
  const reviewResponse = {
    ...mutationResponse,
    action: { ...mutationResponse.action, actionKind: "github_pr_review", approvalRequirement: "strict" },
  };
  const mock = createFetchMock([mutationResponse, reviewResponse, listResponse, detailResponse, cancelResponse, executeResponse]);
  const client = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: mock.fetch });

  assert.deepEqual(await client.proposeExternalWorkAction("/repo path", {
    externalWorkId: "external_work_1",
    actionKind: "github_comment",
    payload: { type: "github_comment", body: "Ready" },
  }), mutationResponse);
  assert.deepEqual(await client.proposeExternalWorkAction("/repo path", {
    externalWorkId: "external_work_1",
    actionKind: "github_pr_review",
    approvalRequirement: "strict",
    payload: { type: "github_pr_review", event: "REQUEST_CHANGES", body: "Please fix CI." },
  }), reviewResponse);
  assert.deepEqual(await client.listExternalWorkActions("/repo path", {
    externalWorkId: "external_work_1",
    status: "waiting_for_approval",
    actionKind: "github_comment",
    limit: 10,
  }), listResponse);
  assert.deepEqual(await client.getExternalWorkAction("/repo path", "external_work_action_1"), detailResponse);
  assert.deepEqual(await client.cancelExternalWorkAction("/repo path", "external_work_action_1", { reason: "No longer needed" }), cancelResponse);
  assert.deepEqual(await client.executeExternalWorkAction("/repo path", "external_work_action_1", { workflowPath: "WORKFLOW.md" }), executeResponse);

  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].url, "http://daemon.test/external-work/actions/propose?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[0].body), {
    externalWorkId: "external_work_1",
    actionKind: "github_comment",
    payload: { type: "github_comment", body: "Ready" },
  });
  assert.equal(mock.calls[1].method, "POST");
  assert.equal(mock.calls[1].url, "http://daemon.test/external-work/actions/propose?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[1].body), {
    externalWorkId: "external_work_1",
    actionKind: "github_pr_review",
    approvalRequirement: "strict",
    payload: { type: "github_pr_review", event: "REQUEST_CHANGES", body: "Please fix CI." },
  });
  assert.equal(mock.calls[2].method, "GET");
  assert.equal(mock.calls[2].url, "http://daemon.test/external-work/actions?cwd=%2Frepo+path&externalWorkId=external_work_1&status=waiting_for_approval&actionKind=github_comment&limit=10");
  assert.equal(mock.calls[3].method, "GET");
  assert.equal(mock.calls[3].url, "http://daemon.test/external-work/actions/external_work_action_1?cwd=%2Frepo+path");
  assert.equal(mock.calls[4].method, "POST");
  assert.equal(mock.calls[4].url, "http://daemon.test/external-work/actions/external_work_action_1/cancel?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[4].body), { reason: "No longer needed" });
  assert.equal(mock.calls[5].method, "POST");
  assert.equal(mock.calls[5].url, "http://daemon.test/external-work/actions/external_work_action_1/execute?cwd=%2Frepo+path");
  assert.deepEqual(JSON.parse(mock.calls[5].body), { workflowPath: "WORKFLOW.md" });
});

test("maps daemon error bodies and workspace path errors", async () => {
  const fetchMessage = async () => jsonResponse({ message: "explicit message" }, { status: 418, statusText: "Teapot" });
  const messageClient = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: fetchMessage });
  await assert.rejects(
    () => messageClient.listRuns("/repo"),
    (error) => error instanceof LingDaemonError && error.message === "explicit message" && error.status === 418,
  );

  const fetchError = async () => jsonResponse({ error: "raw_error" }, { status: 500, statusText: "Server Error" });
  const errorClient = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: fetchError });
  await assert.rejects(() => errorClient.listRuns("/repo"), /raw_error/);

  const fetchFriendly = async () => jsonResponse({ message: "ENOENT .ling-stack" }, { status: 400, statusText: "Bad Request" });
  const friendlyClient = new LingDaemonClient({ baseUrl: "http://daemon.test", fetch: fetchFriendly });
  await assert.rejects(() => friendlyClient.listRuns("/repo"), /Workspace path does not exist or is not writable/);
});
