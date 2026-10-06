import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  createSqliteRunStore,
  defaultProviderTemplates,
  enrichProviderModelOption,
  filterMediaModelOptions,
  findProviderModelCatalogRecord,
  inferGenerationModelFamily,
  isProviderModelCatalogStale,
  normalizeMediaProviderCompat,
  normalizeProviderPresetForMediaRuntime,
  resolveGenerationProviderRuntimeState,
  resolveMediaProviderRuntimeState,
  shouldAutoEnableLiveMediaTransport,
} from "../dist/index.js";

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
  assert.equal(byId.get("alibaba-bailian-qwen")?.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(byId.get("moonshot-kimi")?.baseUrl, "https://api.moonshot.cn/v1");
  assert.equal(byId.get("baidu-qianfan-ernie")?.baseUrl, "https://qianfan.baidubce.com/v2");
  assert.equal(byId.get("tencent-hunyuan")?.baseUrl, "https://api.hunyuan.cloud.tencent.com/v1");
  assert.equal(byId.get("siliconflow")?.baseUrl, "https://api.siliconflow.cn/v1");
  assert.equal(byId.get("stepfun")?.baseUrl, "https://api.stepfun.com/v1");
  assert.equal(byId.get("baichuan-ai")?.baseUrl, "https://api.baichuan-ai.com/v1");
  assert.equal(byId.get("01ai-yi")?.baseUrl, "https://api.lingyiwanwu.com/v1");
  assert.equal(byId.get("seedream-image")?.baseUrl, "https://ark.cn-beijing.volces.com/api/v3");
  assert.equal(byId.get("jimeng-image")?.baseUrl, "https://visual.volcengineapi.com");
  assert.equal(byId.get("seedance-video")?.baseUrl, "https://ark.cn-beijing.volces.com/api/v3");
});

test("domestic OpenAI-compatible templates do not force reasoning support", () => {
  const templates = defaultProviderTemplates();
  const byId = new Map(templates.map((template) => [template.templateId, template]));
  const domesticTemplateIds = [
    "alibaba-bailian-qwen",
    "moonshot-kimi",
    "baidu-qianfan-ernie",
    "tencent-hunyuan",
    "siliconflow",
    "stepfun",
    "baichuan-ai",
    "01ai-yi",
  ];

  for (const templateId of domesticTemplateIds) {
    const template = byId.get(templateId);
    assert.ok(template, templateId);
    assert.equal(template.kind, "openai-compatible", templateId);
    assert.equal(template.api, "openai-completions", templateId);
    assert.deepEqual(template.capabilities, ["chat", "tool_call"], templateId);
    assert.equal(template.reasoning, false, templateId);
    assert.deepEqual(template.thinkingModes, [], templateId);
  }
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

test("generation model catalog recognizes public image families without marking chat models", () => {
  const cases = [
    ["gpt-image-2", ["image_generate"]],
    ["dall-e-3", ["image_generate"]],
    ["google/imagen-4.0-generate", ["image_generate"]],
    ["gemini-2.5-flash-image-preview", ["image_generate"]],
    ["black-forest-labs/flux-2-pro", ["image_generate"]],
    ["black-forest-labs/flux-kontext-pro", ["image_generate", "image_edit"]],
    ["stability-ai/stable-diffusion-3.5-large", ["image_generate"]],
    ["qwen-image-edit", ["image_generate", "image_edit"]],
    ["ideogram-ai/ideogram-v3-quality", ["image_generate"]],
    ["xai/grok-imagine", ["image_generate"]],
  ];

  for (const [modelId, capabilities] of cases) {
    const inferred = inferGenerationModelFamily(modelId);
    assert.ok(inferred, modelId);
    assert.deepEqual(inferred.capabilities, capabilities, modelId);
  }

  assert.equal(inferGenerationModelFamily("gpt-5"), undefined);
  assert.equal(inferGenerationModelFamily("claude-4-sonnet"), undefined);
  assert.equal(inferGenerationModelFamily("gemini-2.5-pro"), undefined);
});

test("provider model enrichment uses catalog fallback only when upstream is silent", () => {
  const context = {
    kind: "openai-compatible",
    providerId: "custom-openai-compatible",
    api: "openai-completions",
  };
  const catalog = enrichProviderModelOption({ id: "black-forest-labs/flux-2-pro" }, context);

  assert.equal(catalog.api, "media-job");
  assert.deepEqual(catalog.input, ["text", "image"]);
  assert.deepEqual(catalog.capabilities, ["image_generate"]);
  assert.equal(catalog.capabilitySource, "model_catalog");
  assert.equal(catalog.capabilityConfidence, "known");

  const upstream = enrichProviderModelOption({
    id: "plain-provider-image",
    api: "media-job",
    input: ["text", "image"],
    capabilities: ["image_generate"],
    capabilitySource: "upstream",
    capabilityConfidence: "known",
  }, context);

  assert.equal(upstream.api, "media-job");
  assert.deepEqual(upstream.capabilities, ["image_generate"]);
  assert.equal(upstream.capabilitySource, "upstream");

  const unknownVision = enrichProviderModelOption({ id: "gpt-5" }, context);
  assert.notEqual(unknownVision.api, "media-job");
  assert.ok(!unknownVision.capabilities.includes("image_generate"));
});

test("versioned provider model catalog prefers exact metadata and preserves explicit upstream capabilities", () => {
  const openAiContext = {
    kind: "openai",
    providerId: "openai",
    api: "openai-responses",
  };
  const catalog = enrichProviderModelOption({ id: "gpt-5-nano" }, openAiContext);
  assert.equal(catalog.capabilitySource, "model_catalog");
  assert.equal(catalog.contextWindow, 400000);
  assert.ok(catalog.capabilities.includes("reasoning"));
  assert.ok(catalog.capabilities.includes("vision"));

  const upstream = enrichProviderModelOption({
    id: "gpt-5-nano",
    capabilities: ["chat"],
    capabilitySource: "upstream",
    capabilityConfidence: "known",
  }, openAiContext);
  assert.deepEqual(upstream.capabilities, ["chat"]);
  assert.equal(upstream.capabilitySource, "upstream");
});

test("exact catalog records without thinking modes retain known family thinking metadata", () => {
  const cases = [
    {
      id: "claude-sonnet-4-5",
      context: { kind: "anthropic", providerId: "anthropic", api: "anthropic-messages" },
      contextWindow: 1000000,
      maxTokens: 64000,
      supportedParameters: ["thinking", "tools"],
    },
    {
      id: "gemini-2.5-pro",
      context: { kind: "google", providerId: "google", api: "google-generative-ai" },
      contextWindow: 1048576,
      maxTokens: 65536,
      supportedParameters: ["thinkingConfig", "tools"],
    },
  ];

  for (const expected of cases) {
    const model = enrichProviderModelOption({ id: expected.id }, expected.context);
    assert.deepEqual(model.thinkingModes, ["off", "auto", "low", "medium", "high"], expected.id);
    assert.deepEqual(model.thinkingSupport, {
      levels: ["off", "auto", "low", "medium", "high"],
      dynamicAllowed: true,
    }, expected.id);
    assert.deepEqual(model.supportedParameters, expected.supportedParameters, expected.id);
    assert.equal(model.contextWindow, expected.contextWindow, expected.id);
    assert.equal(model.maxTokens, expected.maxTokens, expected.id);
    assert.equal(model.capabilitySource, "model_catalog", expected.id);
    assert.equal(model.capabilityConfidence, "known", expected.id);
  }
});

test("family thinking fallback preserves explicit upstream disablement and support flags", () => {
  const context = { kind: "anthropic", providerId: "anthropic", api: "anthropic-messages" };
  for (const thinkingModes of [[], ["off"]]) {
    const model = enrichProviderModelOption({ id: "claude-sonnet-4-5", thinkingModes }, context);
    assert.deepEqual(model.thinkingModes, thinkingModes);
    assert.equal(model.thinkingSupport, undefined);
  }

  const thinkingSupport = { levels: ["off"], zeroAllowed: false, dynamicAllowed: false };
  const model = enrichProviderModelOption({ id: "claude-sonnet-4-5", thinkingSupport }, context);
  assert.deepEqual(model.thinkingModes, ["off"]);
  assert.deepEqual(model.thinkingSupport, thinkingSupport);

  const emptySupport = { levels: [], zeroAllowed: false, dynamicAllowed: false };
  const disabled = enrichProviderModelOption({ id: "claude-sonnet-4-5", thinkingSupport: emptySupport }, context);
  assert.deepEqual(disabled.thinkingModes, []);
  assert.deepEqual(disabled.thinkingSupport, emptySupport);

  const explicitEmptyModes = enrichProviderModelOption({
    id: "claude-sonnet-4-5", thinkingModes: [],
    thinkingSupport: { levels: ["off", "high"], zeroAllowed: false, dynamicAllowed: false },
  }, context);
  assert.deepEqual(explicitEmptyModes.thinkingModes, []);
});

test("exact catalog thinking modes take priority over broader family modes", () => {
  const model = enrichProviderModelOption({ id: "gpt-5-nano" }, {
    kind: "openai",
    providerId: "openai",
    api: "openai-responses",
  });

  assert.deepEqual(model.thinkingModes, ["minimal", "low", "medium", "high"]);
  assert.deepEqual(model.thinkingSupport, {
    levels: ["minimal", "low", "medium", "high"],
    dynamicAllowed: false,
  });
  assert.deepEqual(model.supportedParameters, ["reasoning_effort", "tools", "response_format"]);
  assert.equal(model.contextWindow, 400000);
  assert.equal(model.capabilitySource, "model_catalog");
});

test("exact audio catalog records retain empty capabilities and do not inherit family thinking metadata", () => {
  const model = enrichProviderModelOption({ id: "gemini-2.5-flash-preview-tts" }, {
    kind: "google",
    providerId: "google",
    api: "google-generative-ai",
  });

  assert.deepEqual(model.capabilities, []);
  assert.deepEqual(model.thinkingModes, []);
  assert.equal(model.thinkingSupport, undefined);
  assert.equal(model.supportedParameters, undefined);
});

test("unknown compatible relays use only unique exact catalog ids and otherwise stay conservative", () => {
  const relayContext = {
    kind: "openai-compatible",
    providerId: "private-relay",
    api: "openai-completions",
  };
  const unique = findProviderModelCatalogRecord("claude-sonnet-4-6", relayContext);
  assert.equal(unique?.providerId, "anthropic");

  const unknown = enrichProviderModelOption({ id: "future-private-model" }, relayContext);
  assert.deepEqual(unknown.capabilities, ["chat"]);
  assert.equal(unknown.capabilitySource, "conservative_default");
  assert.equal(unknown.capabilityConfidence, "conservative");
});

test("provider model catalog stale calculation uses the reviewed 45 day threshold", () => {
  assert.equal(isProviderModelCatalogStale("2026-08-20", new Date("2026-09-22T00:00:00.000Z")), false);
  assert.equal(isProviderModelCatalogStale("2026-07-01", new Date("2026-09-22T00:00:00.000Z")), true);
  assert.equal(isProviderModelCatalogStale("invalid", new Date("2026-09-22T00:00:00.000Z")), true);
});

test("live media transport auto-enable is restricted to implemented image adapters", () => {
  assert.equal(shouldAutoEnableLiveMediaTransport({
    kind: "openai-compatible",
    providerId: "custom-openai-compatible",
    modelId: "gpt-image-2",
    api: "media-job",
    capabilities: ["image_generate"],
  }), true);

  assert.equal(shouldAutoEnableLiveMediaTransport({
    kind: "seedream",
    providerId: "seedream",
    modelId: "doubao-seedream-5-0-260128",
    api: "media-job",
    capabilities: ["image_generate", "image_edit"],
  }), true);

  assert.equal(shouldAutoEnableLiveMediaTransport({
    kind: "openai-compatible",
    providerId: "relay",
    modelId: "black-forest-labs/flux-2-pro",
    api: "media-job",
    capabilities: ["image_generate"],
  }), false);
});

test("media provider normalization centralizes live runtime eligibility", () => {
  const baseProvider = {
    id: "provider_image",
    kind: "openai-compatible",
    displayName: "Relay Image",
    providerId: "custom-openai-compatible",
    model: "gpt-image-2",
    api: "media-job",
    baseUrl: "https://relay.example.com/v1",
    apiKeyRef: "env:OPENAI_API_KEY",
    headers: {},
    authHeader: true,
    input: ["text", "image"],
    compat: {},
    capabilities: ["image_generate"],
    enabled: true,
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
  };

  assert.deepEqual(normalizeMediaProviderCompat(baseProvider).mediaVendorTransport, { mode: "live" });
  assert.deepEqual(normalizeProviderPresetForMediaRuntime(baseProvider).compat.mediaVendorTransport, { mode: "live" });
  const openAIState = resolveGenerationProviderRuntimeState(baseProvider, "image_generate");
  assert.equal(openAIState.canRun, true);
  assert.equal(openAIState.uiCopyKey, "generation_runtime_ready");
  assert.deepEqual(openAIState.supportedOperations, ["image_generate"]);
  assert.deepEqual(openAIState.imageGeneration, {
    aspectRatios: ["1:1", "3:2", "2:3"],
    sizeByAspectRatio: {
      "1:1": "1024x1024",
      "3:2": "1536x1024",
      "2:3": "1024x1536",
    },
    maxCount: 4,
  });

  const dallE = { ...baseProvider, model: "dall-e-3" };
  assert.deepEqual(normalizeMediaProviderCompat(dallE).mediaVendorTransport, { mode: "live" });
  assert.deepEqual(resolveMediaProviderRuntimeState(dallE, "image_generate").imageGeneration, {
    aspectRatios: ["1:1", "7:4", "4:7"],
    sizeByAspectRatio: {
      "1:1": "1024x1024",
      "7:4": "1792x1024",
      "4:7": "1024x1792",
    },
    maxCount: 1,
  });

  const seedream = {
    ...baseProvider,
    kind: "seedream",
    providerId: "seedream",
    model: "doubao-seedream-5-0-260128",
    capabilities: ["image_generate", "image_edit"],
  };
  const seedreamState = resolveMediaProviderRuntimeState(seedream, "image_generate");
  assert.deepEqual(normalizeMediaProviderCompat(seedream).mediaVendorTransport, { mode: "live" });
  assert.equal(seedreamState.canRun, true);
  assert.equal(seedreamState.imageGeneration, undefined);
  assert.equal(resolveMediaProviderRuntimeState(seedream, "image_edit").canRun, true);

  const jimeng = {
    ...baseProvider,
    kind: "jimeng",
    providerId: "jimeng",
    model: "jimeng-image",
    capabilities: ["image_generate", "image_edit"],
  };
  assert.equal(resolveMediaProviderRuntimeState(jimeng, "image_generate").reason, "live_transport_required");
  assert.equal(
    resolveMediaProviderRuntimeState({ ...jimeng, compat: { mediaVendorTransport: { mode: "live" } } }, "image_generate").reason,
    "unsupported_live_adapter",
  );

  const seedance = {
    ...baseProvider,
    kind: "seedance",
    providerId: "seedance",
    model: "doubao-seedance-1-0-pro-250528",
    capabilities: ["video_generate"],
  };
  const seedanceState = resolveGenerationProviderRuntimeState(seedance, "video_generate");
  assert.deepEqual(normalizeMediaProviderCompat(seedance).mediaVendorTransport, { mode: "live" });
  assert.equal(seedanceState.canRun, true);
  assert.deepEqual(seedanceState.supportedOperations, ["video_generate"]);
  assert.deepEqual(seedanceState.videoGeneration?.inputModes, ["text", "first_frame"]);

  const seedanceCapabilities = [
    ["doubao-seedance-1-5-pro-251215", ["text", "first_frame"], undefined],
    ["doubao-seedance-2-0-260128", ["text", "first_frame", "reference_image"], 9],
    ["doubao-seedance-2-5-260628", ["text", "first_frame", "reference_image"], 30],
    ["doubao-seedance-next", ["text"], undefined],
  ];
  for (const [model, inputModes, maxReferenceImages] of seedanceCapabilities) {
    const state = resolveGenerationProviderRuntimeState({ ...seedance, model }, "video_generate");
    assert.deepEqual(state.videoGeneration?.inputModes, inputModes, model);
    assert.equal(state.videoGeneration?.maxReferenceImages, maxReferenceImages, model);
  }

  const flux = { ...baseProvider, model: "black-forest-labs/flux-2-pro", providerId: "relay" };
  const fluxState = resolveMediaProviderRuntimeState(flux, "image_generate");
  assert.equal(normalizeMediaProviderCompat(flux).mediaVendorTransport, undefined);
  assert.equal(fluxState.canRun, false);
  assert.equal(fluxState.reason, "live_transport_required");

  const chatProvider = {
    ...baseProvider,
    model: "gpt-5",
    api: "openai-completions",
    capabilities: ["chat", "tool_call"],
  };
  const chatState = resolveMediaProviderRuntimeState(chatProvider, "image_generate");
  assert.equal(chatState.canRun, false);
  assert.equal(chatState.reason, "not_media_provider");
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

test("sqlite store persists provider secret header refs with empty defaults", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-provider-secret-headers-"));
  let store = createSqliteRunStore(cwd);
  let providerId = "";
  try {
    const provider = store.createProviderPreset(
      {
        kind: "openai-compatible",
        displayName: "Secret Header Relay",
        providerId: "secret-header-relay",
        model: "gpt-test",
        api: "openai-completions",
        baseUrl: "https://relay.example.com/v1",
        apiKeyRef: "env:RELAY_API_KEY",
        headers: { "x-static": "static" },
        secretHeaderRefs: { "x-tenant-token": "env:TENANT_TOKEN" },
        capabilities: ["chat"],
      },
      "2026-06-30T00:00:00.000Z",
    );
    providerId = provider.id;
    assert.deepEqual(provider.secretHeaderRefs, { "x-tenant-token": "env:TENANT_TOKEN" });

    const updated = store.updateProviderPreset(
      provider.id,
      { secretHeaderRefs: { "x-tenant-token": "keychain:TENANT_TOKEN" } },
      "2026-06-30T00:01:00.000Z",
    );
    assert.deepEqual(updated?.secretHeaderRefs, { "x-tenant-token": "keychain:TENANT_TOKEN" });

    const defaulted = store.createProviderPreset(
      {
        kind: "openai-compatible",
        displayName: "Default Secret Headers",
        providerId: "default-secret-headers",
        model: "gpt-test",
        api: "openai-completions",
        baseUrl: "https://relay.example.com/v1",
        apiKeyRef: "env:RELAY_API_KEY",
        capabilities: ["chat"],
      },
      "2026-06-30T00:02:00.000Z",
    );
    assert.deepEqual(defaulted.secretHeaderRefs, {});
  } finally {
    store.close();
  }

  store = createSqliteRunStore(cwd);
  try {
    const persisted = store.getProviderPreset(providerId);
    assert.deepEqual(persisted?.headers, { "x-static": "static" });
    assert.deepEqual(persisted?.secretHeaderRefs, { "x-tenant-token": "keychain:TENANT_TOKEN" });
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
