import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore, defaultProviderTemplates, filterMediaModelOptions } from "../dist/index.js";

test("default provider templates include Seedream live HTTP transport config", () => {
  const seedream = defaultProviderTemplates().find((template) => template.templateId === "seedream-image");

  assert.ok(seedream);
  assert.equal(seedream.kind, "seedream");
  assert.equal(seedream.api, "media-job");
  assert.equal(seedream.model, "doubao-seedream-5-0-260128");
  assert.equal(seedream.baseUrl, "https://ark.cn-beijing.volces.com/api/v3");
  assert.equal(seedream.apiKeyRef, "env:SEEDREAM_API_KEY");
  assert.deepEqual(seedream.capabilities, ["image_generate", "image_edit"]);
  assert.deepEqual(seedream.compat, { mediaVendorTransport: { mode: "live" } });
  assert.equal(seedream.enabled, false);
});

test("official provider templates expose fixed default base URLs", () => {
  const templates = defaultProviderTemplates();
  const byId = new Map(templates.map((template) => [template.templateId, template]));

  assert.equal(byId.get("openai-gpt")?.baseUrl, "https://api.openai.com/v1");
  assert.equal(byId.get("openai-codex-responses")?.api, "openai-codex-responses");
  assert.equal(byId.get("openai-codex-responses")?.providerTransport, "auto");
  assert.equal(byId.get("openai-codex-responses")?.baseUrl, "https://chatgpt.com/backend-api");
  assert.equal(byId.get("openai-codex-responses")?.apiKeyRef, "env:OPENAI_CODEX_API_KEY");
  assert.equal(byId.get("xai-grok-web-search")?.kind, "openai-compatible");
  assert.equal(byId.get("xai-grok-web-search")?.api, "openai-responses");
  assert.equal(byId.get("xai-grok-web-search")?.baseUrl, "https://api.x.ai/v1");
  assert.equal(byId.get("xai-grok-web-search")?.apiKeyRef, "env:XAI_API_KEY");
  assert.deepEqual(byId.get("xai-grok-web-search")?.compat, { webSearch: { protocol: "responses-web-search" } });
  assert.equal(byId.get("google-gemini-web-search")?.kind, "google");
  assert.equal(byId.get("google-gemini-web-search")?.api, "google-generative-ai");
  assert.equal(byId.get("google-gemini-web-search")?.baseUrl, "https://generativelanguage.googleapis.com/v1beta");
  assert.equal(byId.get("google-gemini-web-search")?.apiKeyRef, "env:GEMINI_API_KEY");
  assert.deepEqual(byId.get("google-gemini-web-search")?.compat, { webSearch: { protocol: "google-interactions-search" } });
  assert.equal(byId.get("anthropic-claude")?.baseUrl, "https://api.anthropic.com/v1");
  assert.equal(byId.get("doubao-ark")?.baseUrl, "https://ark.cn-beijing.volces.com/api/v3");
  assert.equal(byId.get("deepseek-dpv4")?.baseUrl, "https://api.deepseek.com");
  assert.equal(byId.get("minimax-chat")?.baseUrl, "https://api.minimax.io/v1");
  assert.equal(byId.get("glm-zhipu")?.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
  assert.equal(byId.get("seedream-image")?.baseUrl, "https://ark.cn-beijing.volces.com/api/v3");
  assert.equal(byId.get("jimeng-image")?.baseUrl, "https://visual.volcengineapi.com");
  assert.equal(byId.get("seedance-video")?.baseUrl, "https://ark.cn-beijing.volces.com/api/v3");
});

test("provider media model filtering respects the selected media provider", () => {
  const models = [
    { id: "doubao-seedream-5-0-260128" },
    { id: "doubao-seedream-5-0-turbo-260128" },
    { id: "doubao-seedance-1-0-pro-250528" },
    { id: "jimeng-image" },
    { id: "doubao-seed-2-0-lite-260215" },
  ];

  assert.deepEqual(filterMediaModelOptions(models, "seedream").map((model) => model.id), [
    "doubao-seedream-5-0-260128",
    "doubao-seedream-5-0-turbo-260128",
  ]);
  assert.deepEqual(filterMediaModelOptions(models, "seedance").map((model) => model.id), [
    "doubao-seedance-1-0-pro-250528",
  ]);
  assert.deepEqual(filterMediaModelOptions(models, "jimeng").map((model) => model.id), [
    "jimeng-image",
  ]);
});

test("sqlite store persists provider check results", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-provider-"));
  const checkedAt = "2026-05-21T00:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  let providerId = "";
  try {
    const provider = store.createProviderPreset(
      {
        kind: "openai-compatible",
        displayName: "Local Relay",
        providerId: "local-relay",
        model: "dpv4",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:8317/v1",
        apiKeyRef: "env:LOCAL_RELAY_API_KEY",
        capabilities: ["chat", "tool_call"],
        enabled: true,
      },
      "2026-05-21T00:00:00.000Z",
    );
    providerId = provider.id;

    const updated = store.recordProviderCheckResult(providerId, {
      ok: false,
      code: "secret_missing",
      message: "Secret is not configured: env:LOCAL_RELAY_API_KEY",
      checkedAt,
    });

    assert.equal(updated?.lastCheck?.ok, false);
    assert.equal(updated?.lastCheck?.code, "secret_missing");

    const edited = store.updateProviderPreset(providerId, { model: "dpv4-next" }, "2026-05-21T00:01:00.000Z");
    assert.equal(edited?.model, "dpv4-next");
    assert.equal(edited?.lastCheck, undefined);

    store.recordProviderCheckResult(providerId, {
      ok: true,
      code: "ready",
      message: "Provider is reachable and accepted the configured model.",
      checkedAt,
    });
  } finally {
    store.close();
  }

  store = createSqliteRunStore(cwd);
  try {
    const persisted = store.getProviderPreset(providerId);

    assert.equal(persisted?.lastCheck?.ok, true);
    assert.equal(persisted?.lastCheck?.code, "ready");
    assert.equal(persisted?.lastCheck?.checkedAt, checkedAt);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite store persists and validates provider transport", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-provider-transport-"));
  let store = createSqliteRunStore(cwd);
  let providerId = "";
  try {
    const provider = store.createProviderPreset(
      {
        kind: "openai",
        displayName: "Codex Responses",
        providerId: "openai-codex",
        model: "gpt-5.5-codex",
        api: "openai-codex-responses",
        providerTransport: "websocket-cached",
        baseUrl: "https://chatgpt.com/backend-api",
        apiKeyRef: "env:OPENAI_CODEX_API_KEY",
        capabilities: ["chat", "tool_call"],
        enabled: true,
      },
      "2026-06-10T00:00:00.000Z",
    );
    providerId = provider.id;
    assert.equal(provider.providerTransport, "websocket-cached");

    const updated = store.updateProviderPreset(provider.id, { providerTransport: "sse" }, "2026-06-10T00:01:00.000Z");
    assert.equal(updated?.providerTransport, "sse");

    const cleared = store.updateProviderPreset(provider.id, { providerTransport: null }, "2026-06-10T00:02:00.000Z");
    assert.equal(cleared?.providerTransport, undefined);

    assert.throws(
      () => store.createProviderPreset({
        kind: "openai",
        displayName: "Bad Transport",
        providerId: "bad-transport",
        model: "gpt-5.5-codex",
        api: "openai-codex-responses",
        providerTransport: "websocket-jsonrpc",
        baseUrl: "https://chatgpt.com/backend-api",
        apiKeyRef: "env:OPENAI_CODEX_API_KEY",
        capabilities: ["chat"],
      }, "2026-06-10T00:03:00.000Z"),
      /providerTransport must be one of/,
    );
  } finally {
    store.close();
  }

  store = createSqliteRunStore(cwd);
  try {
    assert.equal(store.getProviderPreset(providerId)?.providerTransport, undefined);
    const updated = store.updateProviderPreset(providerId, { providerTransport: "auto" }, "2026-06-10T00:04:00.000Z");
    assert.equal(updated?.providerTransport, "auto");
    assert.throws(
      () => store.updateProviderPreset(providerId, { providerTransport: "http2" }, "2026-06-10T00:05:00.000Z"),
      /providerTransport must be one of/,
    );
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite store persists provider secrets separately and deletes them with providers", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-provider-secret-"));
  const now = "2026-05-27T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const provider = store.createProviderPreset(
      {
        kind: "openai-compatible",
        displayName: "Local Secret Relay",
        providerId: "local-secret-relay",
        model: "dpv4",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:8317/v1",
        apiKeyRef: "local:provider_pending",
        capabilities: ["chat", "tool_call"],
        enabled: true,
      },
      now,
    );

    store.setProviderSecret(provider.id, "local-secret-value", now);
    assert.equal(store.hasProviderSecret(provider.id), true);
    assert.equal(store.getProviderSecret(provider.id), "local-secret-value");

    store.setProviderSecret(provider.id, "local-secret-value-updated", "2026-05-27T00:01:00.000Z");
    assert.equal(store.getProviderSecret(provider.id), "local-secret-value-updated");

    assert.equal(store.deleteProviderSecret(provider.id), true);
    assert.equal(store.hasProviderSecret(provider.id), false);

    store.setProviderSecret(provider.id, "local-secret-value-final", "2026-05-27T00:02:00.000Z");
    assert.equal(store.deleteProviderPreset(provider.id), true);
    assert.equal(store.getProviderSecret(provider.id), undefined);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
