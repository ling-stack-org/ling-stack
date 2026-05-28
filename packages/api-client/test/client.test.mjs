import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonClient, LingDaemonError, daemonBaseUrlFromEnv } from "../dist/index.js";

function createFetchMock(responseBody = { ok: true }) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
    });
    return jsonResponse(responseBody);
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
  await client.listChannelMessages("/repo", "channel 1", 15);
  await client.listChannelAttachments("/repo", "channel 1", 16);
  await client.listChannelLinkPreviews("/repo", "channel 1", 17);
  await client.listTasks("/repo", { channelId: "ch 1", status: "todo", limit: 5 });
  await client.listApprovals("/repo", { status: "pending", runId: "run 1", mediaJobId: "media 1", limit: 7 });
  await client.listStateTransitions("/repo", { entityType: "task", entityId: "task 1", limit: 9 });
  await client.listResourceLeases("/repo", { status: "active", ownerId: "run 1", limit: 11 });
  await client.getSecretStatus("keychain:provider 1", "provider_api_key");

  assert.equal(mock.calls[0].url, "http://daemon.test/runs?cwd=%2Frepo+path&limit=25");
  assert.equal(mock.calls[1].url, "http://daemon.test/channels/channel%201/messages?cwd=%2Frepo&limit=15");
  assert.equal(mock.calls[2].url, "http://daemon.test/channels/channel%201/attachments?cwd=%2Frepo&limit=16");
  assert.equal(mock.calls[3].url, "http://daemon.test/channels/channel%201/link-previews?cwd=%2Frepo&limit=17");
  assert.equal(mock.calls[4].url, "http://daemon.test/tasks?cwd=%2Frepo&channelId=ch+1&status=todo&limit=5");
  assert.equal(mock.calls[5].url, "http://daemon.test/approvals?cwd=%2Frepo&status=pending&runId=run+1&mediaJobId=media+1&limit=7");
  assert.equal(mock.calls[6].url, "http://daemon.test/state-transitions?cwd=%2Frepo&entityType=task&entityId=task+1&limit=9");
  assert.equal(mock.calls[7].url, "http://daemon.test/runtime/leases?cwd=%2Frepo&status=active&ownerId=run+1&limit=11");
  assert.equal(mock.calls[8].url, "http://daemon.test/secrets/status?ref=keychain%3Aprovider+1&purpose=provider_api_key");
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
  assert.equal(mock.calls[5].url, "http://daemon.test/tasks/task%201?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[5].body), { title: "T", prompt: "P", status: "review" });
  assert.equal(mock.calls[6].url, "http://daemon.test/providers/provider%201?cwd=%2Frepo");
  assert.deepEqual(JSON.parse(mock.calls[7].body).allowedWritePaths, ["/repo"]);
  assert.deepEqual(JSON.parse(mock.calls[8].body), { providerPresetId: "media", operation: "image_generate", prompt: "draw", input: { size: "1024x1024" } });
  assert.deepEqual(JSON.parse(mock.calls[9].body), { reason: "looks good" });
  assert.deepEqual(JSON.parse(mock.calls[10].body), {});
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
