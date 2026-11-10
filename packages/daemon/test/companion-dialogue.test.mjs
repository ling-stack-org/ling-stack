import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";

// This fixture intentionally stays ESM JavaScript because the daemon's current
// Node test entrypoint runs built dist through the existing *.test.mjs glob.
const execFileAsync = promisify(execFile);
const teammateId = "teammate_builtin_engineer";

test("Companion dialogue reuses the bound teammate provider and persists validated reply facets", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-companion-dialogue-"));
  await execFileAsync("git", ["init", "-q", cwd]);
  const now = "2026-11-09T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  const provider = store.createProviderPreset({
    kind: "glm",
    displayName: "Companion Test Provider",
    providerId: "companion-test",
    model: "companion-model",
    api: "google-generative-ai",
    capabilities: ["chat"],
    input: ["text"],
    authHeader: false,
    enabled: true,
  }, now);
  store.recordProviderCheckResult(provider.id, {
    ok: true,
    code: "test_provider_ready",
    message: "Provider is ready for the test.",
    checkedAt: now,
  });
  store.updateAiTeammate(teammateId, {
    modelBindingMode: "fixed",
    providerPresetId: provider.id,
  }, now);

  const runner = new CompanionRunner();
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    { storeFactory: () => store, runner },
  );
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const query = `cwd=${encodeURIComponent(cwd)}`;

  try {
    const created = await requestJson(`${baseUrl}/companions?${query}`, "POST", {
      teammateId,
      displayName: "Dialogue Companion",
    });
    assert.equal(created.status, 201);
    const companionId = created.body.companion.id;

    const reply = await requestJson(`${baseUrl}/companions/${encodeURIComponent(companionId)}/messages?${query}`, "POST", {
      body: "今天状态怎么样？",
      providerPresetId: "provider_should_be_ignored",
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.body.message.body, "今天状态怎么样？");
    assert.equal(reply.body.aiReply.body, "我很好，正在陪你。");
    assert.equal(reply.body.companionReply.text, "我很好，正在陪你。");
    assert.equal(reply.body.companionReply.emotion.id, "happy");
    assert.equal(reply.body.state.emotionId, "happy");
    assert.equal(reply.body.state.phase, "reacting");

    const run = store.getRun(reply.body.aiReply.linkedRunId);
    assert.equal(run.providerPresetId, provider.id);
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0].systemPrompt, /Ling Companion/);
    assert.match(runner.runs[0].systemPrompt, /Declared actions/);

    const idempotentFirst = await requestJson(`${baseUrl}/companions/${encodeURIComponent(companionId)}/messages?${query}`, "POST", {
      body: "这条消息只运行一次",
      idempotencyKey: "user-message-1",
    });
    const idempotentSecond = await requestJson(`${baseUrl}/companions/${encodeURIComponent(companionId)}/messages?${query}`, "POST", {
      body: "这条消息只运行一次",
      idempotencyKey: "user-message-1",
    });
    assert.equal(idempotentFirst.status, 200);
    assert.equal(idempotentSecond.status, 200);
    assert.equal(idempotentFirst.body.message.id, idempotentSecond.body.message.id);
    assert.equal(idempotentFirst.body.aiReply.id, idempotentSecond.body.aiReply.id);
    assert.equal(runner.runs.length, 2);

    const messagePage = await requestJson(`${baseUrl}/companions/${encodeURIComponent(companionId)}/messages?${query}&limit=1`);
    assert.equal(messagePage.status, 200);
    assert.equal(messagePage.body.hasMore, true);
    const previousMessagePage = await requestJson(`${baseUrl}/companions/${encodeURIComponent(companionId)}/messages?${query}&limit=1&beforeMessageId=${encodeURIComponent(messagePage.body.nextBeforeMessageId)}`);
    assert.equal(previousMessagePage.status, 200);
    assert.equal(messagePage.body.messages.some((message) => previousMessagePage.body.messages.some((other) => other.id === message.id)), false);

    const events = await requestJson(`${baseUrl}/companions/${encodeURIComponent(companionId)}/events?${query}`);
    assert.equal(events.status, 200);
    assert.equal(events.body.events.filter((event) => event.type === "memory_candidate").length >= 2, true);
    assert.equal(events.body.events.some((event) => event.type === "action_requested" && event.payload.actionId === "greet"), true);
    assert.equal(events.body.events.some((event) => event.type === "emotion_changed" && event.payload.emotionId === "happy"), true);

    const streamResponse = await fetch(`${baseUrl}/companions/${encodeURIComponent(companionId)}/messages/stream?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "再说一句" }),
    });
    assert.equal(streamResponse.status, 200);
    const streamText = await streamResponse.text();
    const streamEvents = parseSse(streamText);
    assert.equal(streamEvents.some((event) => event.event === "ready"), true);
    assert.equal(streamEvents.some((event) => event.event === "run_linked"), true);
    assert.equal(streamEvents.some((event) => event.event === "delta"), true);
    assert.equal(streamEvents.some((event) => event.event === "done"), true);
    assert.equal(streamEvents.filter((event) => event.event === "delta").every((event) => !event.data.body.includes("LING_COMPANION_META:")), true);

    const keyedStream = await fetch(`${baseUrl}/companions/${encodeURIComponent(companionId)}/messages/stream?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "流式消息只运行一次", idempotencyKey: "stream-message-1" }),
    });
    assert.equal(keyedStream.status, 200);
    const keyedStreamEvents = parseSse(await keyedStream.text());
    assert.equal(keyedStreamEvents.some((event) => event.event === "done"), true);
    const runsAfterFirstKeyedStream = runner.runs.length;

    const keyedStreamRetry = await fetch(`${baseUrl}/companions/${encodeURIComponent(companionId)}/messages/stream?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "流式消息只运行一次", idempotencyKey: "stream-message-1" }),
    });
    assert.equal(keyedStreamRetry.status, 200);
    const keyedStreamRetryEvents = parseSse(await keyedStreamRetry.text());
    assert.equal(keyedStreamRetryEvents.some((event) => event.event === "done"), true);
    assert.equal(runner.runs.length, runsAfterFirstKeyedStream);

    runner.delayMs = 25;
    const runsBeforeConcurrentStream = runner.runs.length;
    const concurrentStreams = await Promise.all([
      fetch(`${baseUrl}/companions/${encodeURIComponent(companionId)}/messages/stream?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "并发流式消息只运行一次", idempotencyKey: "stream-message-concurrent" }),
      }),
      fetch(`${baseUrl}/companions/${encodeURIComponent(companionId)}/messages/stream?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "并发流式消息只运行一次", idempotencyKey: "stream-message-concurrent" }),
      }),
    ]);
    assert.equal(concurrentStreams.every((response) => response.status === 200), true);
    const concurrentStreamEvents = await Promise.all(concurrentStreams.map(async (response) => parseSse(await response.text())));
    assert.equal(concurrentStreamEvents.every((events) => events.some((event) => event.event === "done")), true);
    assert.equal(runner.runs.length, runsBeforeConcurrentStream + 1);
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Disabled companions reject dialogue without creating a user message", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-companion-disabled-"));
  const store = createSqliteRunStore(cwd);
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    { storeFactory: () => store },
  );
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const query = `cwd=${encodeURIComponent(cwd)}`;
  try {
    const created = await requestJson(`${baseUrl}/companions?${query}`, "POST", {
      teammateId,
      displayName: "Disabled Companion",
    });
    const companionId = created.body.companion.id;
    await requestJson(`${baseUrl}/companions/${encodeURIComponent(companionId)}?${query}`, "DELETE", {});
    const rejected = await requestJson(`${baseUrl}/companions/${encodeURIComponent(companionId)}/messages?${query}`, "POST", {
      body: "hello",
    });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error, "companion_disabled");
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

class CompanionRunner {
  constructor() {
    this.runs = [];
    this.delayMs = 0;
  }

  async runTask(options) {
    this.runs.push(options);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const chunks = [
      "我很好，",
      "正在陪你。\nLING_COMPANION_META: ",
      JSON.stringify({
        emotion: { id: "happy", intensity: 0.9 },
        actionRequests: [{ actionId: "greet", arguments: { style: "wave" } }],
        memoryCandidates: [{ summary: "用户喜欢每天收到问候", reason: "explicit preference" }],
      }),
    ];
    options.onEvent?.({ type: "run_start", taskId: options.task.id, cwd: options.cwd, provider: options.provider.provider, model: options.provider.model });
    for (const text of chunks) options.onEvent?.({ type: "assistant_text_delta", text });
    options.onEvent?.({ type: "run_end", taskId: options.task.id, messageCount: 1 });
    return { taskId: options.task.id, messages: [{ role: "assistant", content: chunks.join("") }], events: [] };
  }
}

async function requestJson(url, method = "GET", body) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

function parseSse(text) {
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const event = chunk.match(/^event: ([^\n]+)\ndata: ([\s\S]+)$/);
      return event ? { event: event[1], data: JSON.parse(event[2]) } : undefined;
    })
    .filter(Boolean);
}
