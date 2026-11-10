import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";

const execFileAsync = promisify(execFile);
const teammateId = "teammate_builtin_engineer";

test("Companion proactive trigger reuses the bound provider and deduplicates retries", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-companion-proactive-"));
  await execFileAsync("git", ["init", "-q", cwd]);
  const now = "2026-11-09T00:00:00.000Z";
  const providerCheckAt = new Date().toISOString();
  const store = createSqliteRunStore(cwd);
  const provider = store.createProviderPreset({
    kind: "openai-compatible",
    displayName: "Local OpenAI Compatible",
    providerId: "local-openai-compatible",
    model: "local-companion-model",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:19001/v1",
    capabilities: ["chat"],
    input: ["text"],
    authHeader: false,
    enabled: true,
  }, now);
  store.recordProviderCheckResult(provider.id, { ok: true, code: "ready", message: "ready", checkedAt: providerCheckAt });
  store.updateAiTeammate(teammateId, { modelBindingMode: "fixed", providerPresetId: provider.id }, now);
  const runner = new ProactiveRunner();
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
      displayName: "Proactive Companion",
      behaviorPolicy: { proactiveEnabled: true, cooldownMs: 0 },
    });
    const companionId = created.body.companion.id;

    const first = await requestJson(`${baseUrl}/companions/${companionId}/proactive?${query}`, "POST", {
      idempotencyKey: "proactive-1",
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.response.aiReply.body, "我来陪你一下。");
    assert.equal(store.getRun(first.body.response.aiReply.linkedRunId).providerPresetId, provider.id);

    const duplicate = await requestJson(`${baseUrl}/companions/${companionId}/proactive?${query}`, "POST", {
      idempotencyKey: "proactive-1",
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.status, "duplicate");
    assert.equal(runner.runs, 1);

    const concurrent = await Promise.all([
      requestJson(`${baseUrl}/companions/${companionId}/proactive?${query}`, "POST", { idempotencyKey: "proactive-2" }),
      requestJson(`${baseUrl}/companions/${companionId}/proactive?${query}`, "POST", { idempotencyKey: "proactive-2" }),
    ]);
    assert.equal(concurrent.filter((item) => item.status === 201).length, 1);
    assert.equal(concurrent.filter((item) => item.status === 200 && item.body.status === "duplicate").length, 1);
    assert.equal(runner.runs, 2);

    for (let index = 0; index < 520; index += 1) {
      store.recordCompanionEvent({
        companionId,
        type: "milestone",
        payload: { index },
      }, new Date(Date.now() + index).toISOString());
    }
    const oldDuplicate = await requestJson(`${baseUrl}/companions/${companionId}/proactive?${query}`, "POST", {
      idempotencyKey: "proactive-1",
    });
    assert.equal(oldDuplicate.status, 200);
    assert.equal(oldDuplicate.body.status, "duplicate");
    assert.equal(runner.runs, 2);

    const events = await requestJson(`${baseUrl}/companions/${companionId}/events?${query}&limit=2`);
    assert.equal(events.status, 200);
    assert.equal(events.body.hasMore, true);
    const next = await requestJson(`${baseUrl}/companions/${companionId}/events?${query}&limit=2&beforeCreatedAt=${encodeURIComponent(events.body.nextBeforeCreatedAt)}&beforeEventId=${encodeURIComponent(events.body.nextBeforeEventId)}`);
    assert.equal(next.status, 200);
    assert.equal(events.body.events.some((event) => next.body.events.some((other) => other.id === event.id)), false);
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Companion proactive idempotency survives a daemon restart", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-companion-restart-"));
  await execFileAsync("git", ["init", "-q", cwd]);
  const now = "2026-11-09T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  const provider = store.createProviderPreset({
    kind: "glm",
    displayName: "Restart Provider",
    providerId: "companion-restart-provider",
    model: "companion-restart-model",
    api: "google-generative-ai",
    capabilities: ["chat"],
    input: ["text"],
    authHeader: false,
    enabled: true,
  }, now);
  store.recordProviderCheckResult(provider.id, { ok: true, code: "ready", message: "ready", checkedAt: now });
  store.updateAiTeammate(teammateId, { modelBindingMode: "fixed", providerPresetId: provider.id }, now);
  const firstRunner = new ProactiveRunner();
  const firstDaemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    { storeFactory: () => store, runner: firstRunner },
  );
  await firstDaemon.start();
  const firstAddress = firstDaemon.server.address();
  assert.ok(firstAddress && typeof firstAddress === "object");
  const firstBaseUrl = `http://127.0.0.1:${firstAddress.port}`;
  const query = `cwd=${encodeURIComponent(cwd)}`;
  let companionId;
  try {
    const created = await requestJson(`${firstBaseUrl}/companions?${query}`, "POST", {
      teammateId,
      displayName: "Restart Companion",
      behaviorPolicy: { proactiveEnabled: false, cooldownMs: 0 },
    });
    companionId = created.body.companion.id;
    const first = await requestJson(`${firstBaseUrl}/companions/${companionId}/proactive?${query}`, "POST", {
      force: true,
      idempotencyKey: "persisted-proactive-key",
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
  } finally {
    await firstDaemon.stop();
  }

  const reopenedStore = createSqliteRunStore(cwd);
  const secondRunner = new ProactiveRunner();
  const secondDaemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    { storeFactory: () => reopenedStore, runner: secondRunner },
  );
  await secondDaemon.start();
  const secondAddress = secondDaemon.server.address();
  assert.ok(secondAddress && typeof secondAddress === "object");
  const secondBaseUrl = `http://127.0.0.1:${secondAddress.port}`;
  try {
    const duplicate = await requestJson(`${secondBaseUrl}/companions/${companionId}/proactive?${query}`, "POST", {
      force: true,
      idempotencyKey: "persisted-proactive-key",
    });
    assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.status, "duplicate");
    assert.equal(secondRunner.runs, 0);
  } finally {
    await secondDaemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

class ProactiveRunner {
  constructor() {
    this.runs = 0;
  }

  async runTask(options) {
    this.runs += 1;
    const text = "我来陪你一下。";
    options.onEvent?.({ type: "run_start", taskId: options.task.id, cwd: options.cwd, provider: options.provider.provider, model: options.provider.model });
    options.onEvent?.({ type: "assistant_text_delta", text });
    options.onEvent?.({ type: "run_end", taskId: options.task.id, messageCount: 1 });
    return { taskId: options.task.id, messages: [{ role: "assistant", content: text }], events: [] };
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
