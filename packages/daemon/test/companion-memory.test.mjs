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

test("Companion memory candidates enter the promotion inbox and activate only after review", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-companion-memory-"));
  await execFileAsync("git", ["init", "-q", cwd]);
  const now = "2026-11-09T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  const provider = store.createProviderPreset({
    kind: "glm",
    displayName: "Companion Memory Provider",
    providerId: "companion-memory-provider",
    model: "companion-memory-model",
    api: "google-generative-ai",
    capabilities: ["chat"],
    input: ["text"],
    authHeader: false,
    enabled: true,
  }, now);
  store.recordProviderCheckResult(provider.id, { ok: true, code: "ready", message: "ready", checkedAt: now });
  store.updateAiTeammate(teammateId, { modelBindingMode: "fixed", providerPresetId: provider.id }, now);

  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    { storeFactory: () => store, runner: new MemoryCandidateRunner() },
  );
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const query = `cwd=${encodeURIComponent(cwd)}`;
  try {
    const created = await requestJson(`${baseUrl}/companions?${query}`, "POST", {
      teammateId,
      displayName: "Memory Companion",
    });
    const companionId = created.body.companion.id;
    const reply = await requestJson(`${baseUrl}/companions/${companionId}/messages?${query}`, "POST", {
      body: "请记住我喜欢早上的问候",
      idempotencyKey: "memory-candidate-1",
    });
    assert.equal(reply.status, 200);

    const inbox = await requestJson(`${baseUrl}/memory/promotion-inbox?${query}&scopeType=teammate&ownerId=${teammateId}`);
    assert.equal(inbox.status, 200);
    assert.equal(inbox.body.items.length, 1);
    const memory = inbox.body.items[0].memory;
    assert.equal(memory.reviewState, "candidate");
    assert.equal(memory.enabled, false);
    assert.equal(memory.verifyBeforeUse, true);

    const events = await requestJson(`${baseUrl}/companions/${companionId}/events?${query}`);
    const candidateEvent = events.body.events.find((event) => event.type === "memory_candidate");
    assert.equal(candidateEvent.payload.memoryId, memory.id);

    const approved = await requestJson(`${baseUrl}/memory/${memory.id}/review?${query}`, "POST", {
      action: "approve",
      actor: "local-user",
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.memory.reviewState, "active");
    assert.equal(approved.body.memory.enabled, true);
    assert.equal(store.listMemoryPromotionInbox({ ownerId: teammateId }).length, 0);
    assert.equal(store.listGovernanceNotifications({ kind: "memory_candidate", includeResolved: true }).some((item) => item.status === "resolved"), true);
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

class MemoryCandidateRunner {
  async runTask(options) {
    const text = "已记住。\nLING_COMPANION_META: " + JSON.stringify({
      memoryCandidates: [{ summary: "用户喜欢早上的问候", reason: "explicit preference" }],
    });
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
