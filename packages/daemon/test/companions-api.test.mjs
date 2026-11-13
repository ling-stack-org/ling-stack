import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";

const teammateId = "teammate_builtin_engineer";

test("Companion API persists a teammate binding and validates semantic interactions", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-companion-api-"));

  const store = createSqliteRunStore(cwd);
  assert.ok(store.getAiTeammate(teammateId));
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
    const invalidStatus = await requestJson(`${baseUrl}/companions?${query}&status=unknown`);
    assert.equal(invalidStatus.status, 400);
    assert.match(invalidStatus.body.message, /status must be one of/);

    const created = await requestJson(`${baseUrl}/companions?${query}`, "POST", {
      teammateId,
      displayName: "Ling Companion",
      description: "A test companion",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.companion.teammateId, teammateId);
    assert.equal(created.body.companion.manifest.defaultEmotionId, "neutral");

    const companionId = created.body.companion.id;
    const state = await requestJson(`${baseUrl}/companions/${companionId}/state?${query}`);
    assert.equal(state.status, 200);
    assert.equal(state.body.state.phase, "idle");
    assert.equal(state.body.state.energy, 100);

    const interaction = await requestJson(`${baseUrl}/companions/${companionId}/interactions?${query}`, "POST", {
      type: "action_requested",
      actionId: "greet",
      emotionId: "happy",
      emotionIntensity: 1.5,
      energy: 80,
      payload: { source: "test" },
    });
    assert.equal(interaction.status, 201);
    assert.equal(interaction.body.state.phase, "reacting");
    assert.equal(interaction.body.state.emotionId, "happy");
    assert.equal(interaction.body.state.emotionIntensity, 1);
    assert.equal(interaction.body.state.energy, 80);
    assert.equal(interaction.body.event.type, "action_requested");

    const events = await requestJson(`${baseUrl}/companions/${companionId}/events?${query}`);
    assert.equal(events.status, 200);
    assert.equal(events.body.events.length, 1);
    assert.equal(events.body.events[0].payload.actionId, "greet");

    const invalidAction = await requestJson(`${baseUrl}/companions/${companionId}/interactions?${query}`, "POST", {
      type: "action_requested",
      actionId: "execute-shell",
    });
    assert.equal(invalidAction.status, 400);
    assert.match(invalidAction.body.message, /not declared/);

    const paused = await requestJson(`${baseUrl}/companions/${companionId}?${query}`, "PATCH", { status: "paused" });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.companion.status, "paused");

    const configured = await requestJson(`${baseUrl}/companions/${companionId}?${query}`, "PATCH", {
      behaviorPolicy: { proactiveEnabled: true, cooldownMs: 12_345, quietHours: [22, 6] },
    });
    assert.equal(configured.status, 200);
    const partialPolicy = await requestJson(`${baseUrl}/companions/${companionId}?${query}`, "PATCH", {
      behaviorPolicy: { proactiveEnabled: false },
    });
    assert.equal(partialPolicy.status, 200);
    assert.deepEqual(partialPolicy.body.companion.behaviorPolicy, {
      proactiveEnabled: false,
      cooldownMs: 12_345,
      quietHours: [22, 6],
    });

    const disabled = await requestJson(`${baseUrl}/companions/${companionId}?${query}`, "DELETE", {});
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.companion.status, "disabled");

    const disabledInteraction = await requestJson(`${baseUrl}/companions/${companionId}/interactions?${query}`, "POST", {
      type: "presence_changed",
    });
    assert.equal(disabledInteraction.status, 400);
    assert.match(disabledInteraction.body.message, /Disabled companions/);
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function requestJson(url, method = "GET", body) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}
