import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";

test("daemon API exposes durable Ling turns and links runs to turns", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-ling-turns-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(new SuccessfulRunner(), stores);
  try {
    const initial = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_auto_turn"));
    assert.equal(initial.events.some((event) => event.event === "ready"), true);
    assert.equal(initial.events.some((event) => event.event === "result"), true);

    const store = stores.get(cwd);
    assert.ok(store);
    const initialRun = store.getRun(initial.runId);
    assert.ok(initialRun);
    assert.ok(initialRun.threadId);
    const autoTurn = store.getLingTurnForRun(initialRun.id);
    assert.ok(autoTurn);
    assert.equal(autoTurn.threadId, initialRun.threadId);
    assert.equal(autoTurn.kind, "initial_request");
    assert.equal(autoTurn.status, "succeeded");

    const listed = await getJson(`${daemon.url}/threads/${encodeURIComponent(initialRun.threadId)}/turns?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.threadId, initialRun.threadId);
    assert.deepEqual(listed.turns.map((turn) => turn.id), [autoTurn.id]);
    assert.deepEqual(listed.runLinks.map((link) => [link.turnId, link.runId, link.attemptNumber, link.role]), [
      [autoTurn.id, initialRun.id, 1, "primary"],
    ]);

    const created = await postJson(`${daemon.url}/threads/${encodeURIComponent(initialRun.threadId)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      kind: "manual_followup",
      status: "succeeded",
      title: "Retry with sk-manualturnsecret123",
      userInstruction: "Do not leak sk-manualturnsecret123 into durable turn fields.",
      activeRunId: initialRun.id,
      createdByActor: "local-user",
    });
    assert.equal(created.turn.kind, "manual_followup");
    assert.equal(created.turn.status, "open");
    assert.equal(created.turn.activeRunId, undefined);
    assert.equal(created.turn.title.includes("sk-manualturnsecret123"), false);
    assert.equal(created.turn.userInstruction.includes("sk-manualturnsecret123"), false);
    assert.deepEqual(created.runLinks, []);

    const explicit = await postRunAndCollectEvents(daemon.url, {
      ...runBody(cwd, "task_manual_turn"),
      threadId: initialRun.threadId,
      turnId: created.turn.id,
    });
    const explicitRun = store.getRun(explicit.runId);
    assert.ok(explicitRun);
    assert.equal(explicitRun.threadId, initialRun.threadId);
    assert.equal(store.getLingTurnForRun(explicitRun.id)?.id, created.turn.id);

    const afterExplicit = await getJson(`${daemon.url}/threads/${encodeURIComponent(initialRun.threadId)}/turns?cwd=${encodeURIComponent(cwd)}&limit=10`);
    assert.deepEqual(afterExplicit.runLinks.find((link) => link.runId === explicitRun.id), {
      turnId: created.turn.id,
      runId: explicitRun.id,
      attemptNumber: 1,
      role: "primary",
      createdAt: afterExplicit.runLinks.find((link) => link.runId === explicitRun.id)?.createdAt,
    });
    assert.equal(afterExplicit.turns.find((turn) => turn.id === created.turn.id)?.status, "succeeded");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

class SuccessfulRunner {
  async runTask(options) {
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });
    options.onEvent?.({
      type: "run_end",
      taskId: options.task.id,
      messageCount: 1,
    });
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: "done" }],
    };
  }
}

async function startDaemonForTest(runner, stores) {
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0 },
    {
      runner,
      storeFactory(cwd) {
        const store = createSqliteRunStore(cwd);
        stores.set(cwd, store);
        return store;
      },
    },
  );
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

function runBody(cwd, taskId) {
  return {
    cwd,
    task: {
      id: taskId,
      title: taskId,
      prompt: "Exercise Ling turn persistence.",
    },
    provider: {
      provider: "test-provider",
      model: "test-model",
    },
    tools: ["read"],
    thinkingLevel: "off",
  };
}

async function postRunAndCollectEvents(baseUrl, body) {
  const response = await fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    assert.fail(await response.text());
  }
  const text = await response.text();
  const events = parseSseText(text);
  return {
    events,
    runId: events.find((event) => event.event === "ready")?.data.runId,
  };
}

async function getJson(url) {
  const response = await fetch(url);
  return await readJsonResponse(response);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await readJsonResponse(response);
}

async function readJsonResponse(response) {
  const text = await response.text();
  assert.ok(response.ok, text);
  return text.trim() ? JSON.parse(text) : {};
}

function parseSseText(text) {
  return text
    .split("\n\n")
    .map(parseSseEvent)
    .filter(Boolean);
}

function parseSseEvent(raw) {
  const lines = raw.split("\n").filter(Boolean);
  const event = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length);
  const data = lines
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .join("\n");
  if (!event) {
    return undefined;
  }
  return { event, data: data ? JSON.parse(data) : undefined };
}
