import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";

test("public channel and teammate creation require a checked chat model", async (t) => {
  isolateProviderNetwork(t);
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-conversation-model-create-"));
  const stores = new Map();
  const store = createSqliteRunStore(cwd);
  stores.set(cwd, store);
  const readyProvider = store.createProviderPreset({
    kind: "openai-compatible",
    displayName: "Ready chat",
    providerId: "ready-chat",
    model: "gpt-test",
    api: "openai-responses",
    authHeader: false,
    capabilities: ["chat"],
    enabled: true,
  }, "2026-07-30T00:00:00.000Z");
  store.recordProviderCheckResult(readyProvider.id, {
    ok: true,
    code: "ready",
    message: "Ready",
    checkedAt: new Date().toISOString(),
  });
  const uncheckedProvider = store.createProviderPreset({
    kind: "openai-compatible",
    displayName: "Unchecked chat",
    providerId: "unchecked-chat",
    model: "gpt-unchecked",
    api: "openai-responses",
    authHeader: false,
    capabilities: ["chat"],
    enabled: true,
  }, "2026-07-30T00:00:00.000Z");
  const daemon = await startDaemonForTest(stores);
  try {
    const missingChannel = await postJsonResult(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, channelInput());
    assert.equal(missingChannel.status, 400);
    assert.equal(missingChannel.body.error, "conversation_model_required");
    assert.equal(store.listChannels({ archived: false }).length, 0);

    const missingTeammate = await postJsonResult(`${daemon.url}/teammates?cwd=${encodeURIComponent(cwd)}`, teammateInput());
    assert.equal(missingTeammate.status, 400);
    assert.equal(missingTeammate.body.error, "conversation_model_required");

    const unchecked = await postJsonResult(`${daemon.url}/teammates?cwd=${encodeURIComponent(cwd)}`, teammateInput(uncheckedProvider.id));
    assert.equal(unchecked.status, 400);
    assert.equal(unchecked.body.error, "conversation_model_not_ready");

    const createdTeammate = await postJsonResult(`${daemon.url}/teammates?cwd=${encodeURIComponent(cwd)}`, teammateInput(readyProvider.id));
    assert.equal(createdTeammate.status, 201, JSON.stringify(createdTeammate.body));
    assert.equal(createdTeammate.body.teammate.modelBindingMode, "fixed");
    assert.equal(createdTeammate.body.teammate.providerPresetId, readyProvider.id);

    const createdChannel = await postJsonResult(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, channelInput(readyProvider.id));
    assert.equal(createdChannel.status, 201);
    assert.equal(createdChannel.body.channel.defaultProviderPresetId, readyProvider.id);

    const invalidModelUpdate = await patchJsonResult(
      `${daemon.url}/channels/${encodeURIComponent(createdChannel.body.channel.id)}?cwd=${encodeURIComponent(cwd)}`,
      { defaultProviderPresetId: uncheckedProvider.id },
    );
    assert.equal(invalidModelUpdate.status, 400);
    assert.equal(invalidModelUpdate.body.error, "conversation_model_not_ready");
    assert.equal(store.getChannel(createdChannel.body.channel.id).defaultProviderPresetId, readyProvider.id);

    store.recordProviderCheckResult(readyProvider.id, {
      ok: false,
      code: "temporarily_unavailable",
      message: "Temporarily unavailable",
      checkedAt: "2026-07-30T00:00:02.000Z",
    });
    const renamedChannel = await patchJsonResult(
      `${daemon.url}/channels/${encodeURIComponent(createdChannel.body.channel.id)}?cwd=${encodeURIComponent(cwd)}`,
      { name: "Engineering renamed" },
    );
    assert.equal(renamedChannel.status, 200);
    assert.equal(renamedChannel.body.channel.name, "Engineering renamed");

    const pausedChannel = await patchJsonResult(
      `${daemon.url}/channels/${encodeURIComponent(createdChannel.body.channel.id)}?cwd=${encodeURIComponent(cwd)}`,
      { status: "paused" },
    );
    assert.equal(pausedChannel.status, 200);
    const reactivatedChannel = await patchJsonResult(
      `${daemon.url}/channels/${encodeURIComponent(createdChannel.body.channel.id)}?cwd=${encodeURIComponent(cwd)}`,
      { status: "active" },
    );
    assert.equal(reactivatedChannel.status, 400);
    assert.equal(reactivatedChannel.body.error, "conversation_model_not_ready");
    assert.equal(store.getChannel(createdChannel.body.channel.id).status, "paused");
  } finally {
    await daemon.close();
    for (const currentStore of stores.values()) currentStore.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("only built-in teammates may switch back to workspace default binding", async (t) => {
  isolateProviderNetwork(t);
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-conversation-model-binding-"));
  const stores = new Map();
  const store = createSqliteRunStore(cwd);
  stores.set(cwd, store);
  const provider = store.createProviderPreset({
    kind: "openai-compatible",
    displayName: "Ready chat",
    providerId: "ready-chat",
    model: "gpt-test",
    api: "openai-responses",
    authHeader: false,
    capabilities: ["chat"],
    enabled: true,
  }, "2026-07-30T00:00:00.000Z");
  store.recordProviderCheckResult(provider.id, {
    ok: true,
    code: "ready",
    message: "Ready",
    checkedAt: new Date().toISOString(),
  });
  const custom = store.createAiTeammate({
    id: "teammate_custom_model_binding",
    roleKey: "custom",
    displayName: "Custom",
    description: "Custom teammate",
    modelBindingMode: "fixed",
    providerPresetId: provider.id,
    approvalProfile: { mode: "none" },
  }, "2026-07-30T00:00:00.000Z");
  const daemon = await startDaemonForTest(stores);
  try {
    const builtin = store.getAiTeammate("teammate_builtin_engineer");
    const builtinResult = await patchJsonResult(`${daemon.url}/teammates/${encodeURIComponent(builtin.id)}?cwd=${encodeURIComponent(cwd)}`, {
      modelBindingMode: "workspace_default",
      providerPresetId: null,
    });
    assert.equal(builtinResult.status, 200);
    assert.equal(builtinResult.body.teammate.modelBindingMode, "workspace_default");
    assert.equal(builtinResult.body.teammate.providerPresetId, undefined);

    const customResult = await patchJsonResult(`${daemon.url}/teammates/${encodeURIComponent(custom.id)}?cwd=${encodeURIComponent(cwd)}`, {
      modelBindingMode: "workspace_default",
      providerPresetId: null,
    });
    assert.equal(customResult.status, 400);
    assert.equal(customResult.body.error, "teammate_model_binding_invalid");
    assert.equal(store.getAiTeammate(custom.id).modelBindingMode, "fixed");
  } finally {
    await daemon.close();
    for (const currentStore of stores.values()) currentStore.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

function channelInput(defaultProviderPresetId) {
  return {
    name: "Engineering",
    status: "active",
    allowedTools: ["read"],
    runtimePolicy: {
      maxConcurrentRuns: 2,
      schedulingMode: "smart",
      writeLockScope: "channel",
      allowReadOnlyParallel: true,
      queueOnConflict: true,
    },
    ...(defaultProviderPresetId ? { defaultProviderPresetId } : {}),
  };
}

// This API test controls readiness, not provider networking. An unchecked fixture
// can be warmed in the background, but must never call an external model endpoint.
function isolateProviderNetwork(t) {
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input, options) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    return url.hostname === "127.0.0.1"
      ? fetch(input, options)
      : Promise.resolve(new Response("Unchecked fixture provider", { status: 503 }));
  });
}

function teammateInput(providerPresetId) {
  return {
    roleKey: "custom",
    displayName: "Custom teammate",
    description: "A teammate created by the user.",
    approvalProfile: { mode: "none" },
    ...(providerPresetId ? { providerPresetId } : {}),
  };
}

async function startDaemonForTest(stores) {
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 }, {
    storeFactory: (cwd) => {
      const existing = stores.get(cwd);
      if (existing) return existing;
      const created = createSqliteRunStore(cwd);
      stores.set(cwd, created);
      return created;
    },
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

async function postJsonResult(url, body) {
  return requestJson(url, "POST", body);
}

async function patchJsonResult(url, body) {
  return requestJson(url, "PATCH", body);
}

async function requestJson(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
