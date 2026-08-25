import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MediaAdapterExecutionError,
  MediaAdapterRegistry,
  createDefaultMediaAdapterRegistry,
  createDisabledMediaVendorTransport,
  createLiveMediaVendorTransport,
  createMediaVendorRequestPlan,
  createStaticMediaAdapter,
  createStaticVendorMediaAdapterFactory,
  defaultMediaVendorAdapterDefinitions,
  executeMediaJob,
  normalizeMediaAdapterError,
  resolveMediaAdapter,
  resolveMediaVendorTransportGateConfig,
} from "../dist/index.js";

const provider = {
  id: "provider_seedream",
  kind: "seedream",
  displayName: "Seedream Image",
  providerId: "seedream",
  model: "seedream",
  api: "media-job",
  baseUrl: "https://media.example.invalid",
  apiKeyRef: "env:SEEDREAM_API_KEY",
  capabilities: ["image_generate", "image_edit"],
};

test("static media adapter returns a redacted markdown artifact contract", async () => {
  const result = await executeMediaJob(createStaticMediaAdapter(), {
    jobId: "media_job_contract_success",
    provider,
    operation: "image_generate",
    prompt: "Create a product mockup.",
    input: {
      size: "1024x1024",
      apiKey: "sk-test_123456789",
      nested: { token: "Bearer secret-token" },
    },
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.errorCode, undefined);
  assert.equal(result.errorMessage, undefined);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].type, "markdown");
  assert.equal(result.artifacts[0].contentType, "text/markdown; charset=utf-8");
  assert.match(result.artifacts[0].content ?? "", /Media job static result/);
  assert.match(result.artifacts[0].content ?? "", /No vendor media API was called/);
  assert.doesNotMatch(result.artifacts[0].content ?? "", /sk-test_123456789/);
  assert.doesNotMatch(result.artifacts[0].content ?? "", /secret-token/);
});

test("static media adapter exposes deterministic failure for contract tests", async () => {
  const result = await executeMediaJob(createStaticMediaAdapter(), {
    jobId: "media_job_contract_failure",
    provider,
    operation: "image_generate",
    prompt: "Create a product mockup.",
    input: { forceFailure: true },
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "provider_internal_error");
  assert.match(result.errorMessage, /forced failure/);
  assert.deepEqual(result.artifacts, []);
});

test("media adapter executor normalizes thrown provider errors", async () => {
  const result = await executeMediaJob(createStaticMediaAdapter(), {
    jobId: "media_job_contract_error",
    provider,
    operation: "image_generate",
    prompt: "Create a product mockup.",
    input: { forceErrorCode: "rate_limited" },
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "rate_limited");
  assert.match(result.errorMessage, /rate_limited/);
  assert.deepEqual(result.artifacts, []);
});

test("media adapter executor rejects unsupported operations before execution", async () => {
  const adapter = {
    id: "image-only",
    displayName: "Image Only",
    capabilities: ["image_generate"],
    supports(operation) {
      return operation === "image_generate";
    },
    async execute() {
      assert.fail("unsupported operations must not execute the adapter");
    },
  };

  const result = await executeMediaJob(adapter, {
    jobId: "media_job_contract_unsupported",
    provider,
    operation: "video_generate",
    prompt: "Create a short clip.",
    input: {},
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "unsupported_capability");
  assert.match(result.errorMessage, /does not support video_generate/);
});

test("media adapter execution errors keep their normalized code", () => {
  const normalized = normalizeMediaAdapterError(new MediaAdapterExecutionError("auth_failed", "Missing API key."));

  assert.deepEqual(normalized, {
    code: "auth_failed",
    message: "Missing API key.",
  });
});

test("default media adapter registry maps vendor providers to static adapter stubs", async () => {
  const registry = createDefaultMediaAdapterRegistry();
  const vendorCases = [
    {
      kind: "jimeng",
      id: "jimeng-static",
      displayName: "Jimeng Static Adapter",
      capabilities: ["image_generate", "image_edit"],
    },
    {
      kind: "seedream",
      id: "seedream-static",
      displayName: "Seedream Static Adapter",
      capabilities: ["image_generate", "image_edit"],
    },
    {
      kind: "seedance",
      id: "seedance-static",
      displayName: "Seedance Static Adapter",
      capabilities: ["video_generate"],
    },
  ];

  for (const vendor of vendorCases) {
    const resolution = resolveMediaAdapter(registry, { ...provider, kind: vendor.kind });
    assert.equal(resolution.ok, true);
    assert.ok(resolution.adapter);
    assert.equal(resolution.adapter.id, vendor.id);
    assert.equal(resolution.adapter.displayName, vendor.displayName);
    assert.deepEqual(resolution.adapter.capabilities, vendor.capabilities);
  }
});

test("resolved vendor adapter stubs emit redacted request plans without live calls", async () => {
  const resolution = resolveMediaAdapter(createDefaultMediaAdapterRegistry(), provider);

  assert.equal(resolution.ok, true);
  assert.ok(resolution.adapter);
  const result = await executeMediaJob(resolution.adapter, {
    jobId: "media_job_registry_static",
    provider,
    operation: "image_generate",
    prompt: "Create a product mockup.",
    input: {
      imageUrl: "file://input.png",
      apiKey: "sk-test_123456789",
      nested: { token: "Bearer secret-token" },
    },
    requestedAt: "2026-05-23T00:00:00.000Z",
  });
  assert.equal(result.status, "succeeded");
  assert.match(result.artifacts[0].content ?? "", /Vendor request plan/);
  assert.match(result.artifacts[0].content ?? "", /"mode": "static_vendor_request_plan"/);
  assert.match(result.artifacts[0].content ?? "", /"liveCall": false/);
  assert.match(result.artifacts[0].content ?? "", /"apiKeyRef": "\[REDACTED\]"/);
  assert.doesNotMatch(result.artifacts[0].content ?? "", /env:SEEDREAM_API_KEY/);
  assert.match(result.artifacts[0].content ?? "", /Transport: disabled/);
  assert.match(result.artifacts[0].content ?? "", /No vendor media API was called/);
  assert.doesNotMatch(result.artifacts[0].content ?? "", /sk-test_123456789/);
  assert.doesNotMatch(result.artifacts[0].content ?? "", /secret-token/);
});

test("seedance vendor adapter only exposes video generation", async () => {
  const resolution = resolveMediaAdapter(createDefaultMediaAdapterRegistry(), {
    ...provider,
    kind: "seedance",
    capabilities: ["video_generate"],
  });

  assert.equal(resolution.ok, true);
  assert.ok(resolution.adapter);
  assert.equal(resolution.adapter.supports("video_generate"), true);
  assert.equal(resolution.adapter.supports("image_generate"), false);

  const result = await executeMediaJob(resolution.adapter, {
    jobId: "media_job_seedance_wrong_operation",
    provider: { ...provider, kind: "seedance", capabilities: ["video_generate"] },
    operation: "image_generate",
    prompt: "Create a product mockup.",
    input: {},
    requestedAt: "2026-05-23T00:00:00.000Z",
  });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "unsupported_capability");
  assert.deepEqual(result.artifacts, []);
});

test("media vendor request plan is stable and redacted", () => {
  const seedream = defaultMediaVendorAdapterDefinitions().find((definition) => definition.kind === "seedream");
  assert.ok(seedream);

  const plan = createMediaVendorRequestPlan(seedream, {
    jobId: "media_job_plan",
    provider,
    operation: "image_edit",
    prompt: "Edit this product shot.",
    input: { maskUrl: "file://mask.png", apiKey: "sk-test_123456789" },
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  assert.equal(plan.mode, "static_vendor_request_plan");
  assert.equal(plan.liveCall, false);
  assert.equal(plan.vendor, "seedream");
  assert.equal(plan.operation, "image_edit");
  assert.equal(plan.provider.presetId, "provider_seedream");
  assert.equal(plan.provider.apiKeyRef, "env:SEEDREAM_API_KEY");
  assert.deepEqual(plan.payload.input, { maskUrl: "file://mask.png", apiKey: "[REDACTED]" });
});

test("disabled media vendor transport is the default no-network seam", async () => {
  const transport = createDisabledMediaVendorTransport();
  const seedream = defaultMediaVendorAdapterDefinitions().find((definition) => definition.kind === "seedream");
  assert.ok(seedream);
  const plan = createMediaVendorRequestPlan(seedream, {
    jobId: "media_job_disabled_transport",
    provider,
    operation: "image_generate",
    prompt: "Create a product mockup.",
    input: {},
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  const result = await transport.execute({
    vendor: seedream,
    requestPlan: plan,
    jobId: "media_job_disabled_transport",
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  assert.equal(transport.mode, "disabled");
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.artifacts, []);
});

test("media vendor transport gate defaults to disabled and rejects preset fake mode", () => {
  assert.deepEqual(resolveMediaVendorTransportGateConfig(undefined), {
    ok: true,
    config: { mode: "disabled" },
  });
  assert.deepEqual(resolveMediaVendorTransportGateConfig({}), {
    ok: true,
    config: { mode: "disabled" },
  });
  assert.deepEqual(resolveMediaVendorTransportGateConfig({ mediaVendorTransport: { mode: "live" } }), {
    ok: true,
    config: { mode: "live" },
  });

  const fake = resolveMediaVendorTransportGateConfig({ mediaVendorTransport: { mode: "fake" } });
  assert.equal(fake.ok, false);
  assert.equal(fake.errorCode, "invalid_request");
  assert.match(fake.errorMessage ?? "", /reserved for test injection/);

  const invalid = resolveMediaVendorTransportGateConfig({ mediaVendorTransport: { mode: "other" } });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errorCode, "invalid_request");
  assert.match(invalid.errorMessage ?? "", /disabled or live/);
});

test("live media vendor transport validates config before Seedream HTTP", async () => {
  const seedream = defaultMediaVendorAdapterDefinitions().find((definition) => definition.kind === "seedream");
  assert.ok(seedream);
  const plan = createMediaVendorRequestPlan(seedream, {
    jobId: "media_job_live_transport",
    provider,
    operation: "image_generate",
    prompt: "Create a product mockup.",
    input: {},
    requestedAt: "2026-05-23T00:00:00.000Z",
  });
  const request = {
    vendor: seedream,
    requestPlan: plan,
    jobId: "media_job_live_transport",
    requestedAt: "2026-05-23T00:00:00.000Z",
  };

  const missingBaseUrl = await createLiveMediaVendorTransport({
    apiKeyRef: "env:SEEDREAM_API_KEY",
    apiKeyConfigured: true,
  }).execute(request);
  assert.equal(missingBaseUrl.status, "failed");
  assert.equal(missingBaseUrl.errorCode, "invalid_request");
  assert.match(missingBaseUrl.errorMessage ?? "", /baseUrl/);

  const missingKeyRef = await createLiveMediaVendorTransport({
    baseUrl: "https://media.example.invalid",
    apiKeyConfigured: true,
  }).execute(request);
  assert.equal(missingKeyRef.status, "failed");
  assert.equal(missingKeyRef.errorCode, "auth_failed");
  assert.match(missingKeyRef.errorMessage ?? "", /apiKeyRef/);

  const missingSecret = await createLiveMediaVendorTransport({
    baseUrl: "https://media.example.invalid",
    apiKeyRef: "env:SEEDREAM_API_KEY",
    apiKeyConfigured: false,
  }).execute(request);
  assert.equal(missingSecret.status, "failed");
  assert.equal(missingSecret.errorCode, "auth_failed");
  assert.match(missingSecret.errorMessage ?? "", /env:SEEDREAM_API_KEY/);

  const missingSecretValue = await createLiveMediaVendorTransport({
    baseUrl: "https://media.example.invalid",
    apiKeyRef: "env:SEEDREAM_API_KEY",
    apiKeyConfigured: true,
  }).execute(request);
  assert.equal(missingSecretValue.status, "failed");
  assert.equal(missingSecretValue.errorCode, "auth_failed");
  assert.match(missingSecretValue.errorMessage ?? "", /secret value is not available/);
});

test("live media vendor transport calls Seedream image generation through the OpenAI-compatible images API", async () => {
  const capturedRequests = [];
  const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const registry = createDefaultMediaAdapterRegistry({
    mediaVendorTransport: createLiveMediaVendorTransport({
      baseUrl: "https://media.example.invalid",
      apiKeyRef: "env:SEEDREAM_API_KEY",
      apiKeyConfigured: true,
      apiKey: "test-key",
      httpClient: async (url, init) => {
        capturedRequests.push({ url, init });
        if (init.method === "GET") {
          return binaryResponse(200, "OK", imageBytes, { "content-type": "image/png" });
        }
        return jsonResponse(200, {
          created: 1779537600,
          data: [
            {
              url: "https://media.example.invalid/generated/image-1.png",
            },
          ],
          debug: {
            echoedSecret: "test-key",
          },
        });
      },
    }),
  });
  const resolution = resolveMediaAdapter(registry, provider);

  assert.equal(resolution.ok, true);
  assert.ok(resolution.adapter);
  const result = await executeMediaJob(resolution.adapter, {
    jobId: "media_job_live_seedream",
    provider,
    operation: "image_generate",
    prompt: "Create a product mockup.",
    input: { apiKey: "sk-test_123456789", size: "2K", watermark: false },
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.errorCode, undefined);
  assert.equal(result.artifacts.length, 3);
  assert.match(result.artifacts[0].content ?? "", /Transport: live/);
  assert.equal(result.artifacts[1].type, "json");
  assert.match(result.artifacts[1].content ?? "", /live_seedream_image_generate/);
  assert.match(result.artifacts[1].content ?? "", /image-1\.png/);
  assert.doesNotMatch(result.artifacts[1].content ?? "", /test-key/);
  assert.equal(result.artifacts[2].type, "image");
  assert.equal(result.artifacts[2].contentType, "image/png");
  assert.deepEqual(result.artifacts[2].contentBytes, imageBytes);
  assert.equal(capturedRequests.length, 2);
  assert.equal(capturedRequests[0].url, "https://media.example.invalid/images/generations");
  assert.equal(capturedRequests[0].init.headers.authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(capturedRequests[0].init.body ?? "{}"), {
    model: "seedream",
    prompt: "Create a product mockup.",
    response_format: "url",
    size: "2K",
    watermark: false,
  });
  assert.equal(capturedRequests[1].url, "https://media.example.invalid/generated/image-1.png");
  assert.equal(capturedRequests[1].init.method, "GET");
  assert.deepEqual(capturedRequests[1].init.headers, {});
});

test("live media vendor transport calls Seedream image edit with source image URLs", async () => {
  const capturedRequests = [];
  const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const registry = createDefaultMediaAdapterRegistry({
    mediaVendorTransport: createLiveMediaVendorTransport({
      baseUrl: "https://media.example.invalid",
      apiKeyRef: "env:SEEDREAM_API_KEY",
      apiKeyConfigured: true,
      apiKey: "test-key",
      httpClient: async (url, init) => {
        capturedRequests.push({ url, init });
        if (init.method === "GET") {
          return binaryResponse(200, "OK", imageBytes, { "content-type": "image/png" });
        }
        return jsonResponse(200, {
          data: [
            {
              url: "https://media.example.invalid/edited/image-1.png",
            },
          ],
          debug: {
            echoedSecret: "test-key",
          },
        });
      },
    }),
  });
  const resolution = resolveMediaAdapter(registry, provider);

  assert.equal(resolution.ok, true);
  assert.ok(resolution.adapter);
  const result = await executeMediaJob(resolution.adapter, {
    jobId: "media_job_live_seedream_edit",
    provider,
    operation: "image_edit",
    prompt: "Replace the background.",
    input: {
      imageUrl: "https://cdn.example.invalid/source.png",
      maskUrl: "https://cdn.example.invalid/mask.png",
      size: "2K",
      watermark: false,
    },
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.errorCode, undefined);
  assert.equal(result.artifacts.length, 3);
  assert.match(result.artifacts[1].content ?? "", /live_seedream_image_edit/);
  assert.doesNotMatch(result.artifacts[1].content ?? "", /test-key/);
  assert.equal(result.artifacts[2].type, "image");
  assert.deepEqual(result.artifacts[2].contentBytes, imageBytes);
  assert.equal(capturedRequests.length, 2);
  assert.equal(capturedRequests[0].url, "https://media.example.invalid/images/generations");
  assert.deepEqual(JSON.parse(capturedRequests[0].init.body ?? "{}"), {
    model: "seedream",
    prompt: "Replace the background.",
    image: "https://cdn.example.invalid/source.png",
    mask: "https://cdn.example.invalid/mask.png",
    response_format: "url",
    size: "2K",
    watermark: false,
  });
});

test("live media vendor transport rejects Seedream image edit without supported image input", async () => {
  const resolution = resolveMediaAdapter(createDefaultMediaAdapterRegistry({
    mediaVendorTransport: createLiveMediaVendorTransport({
      baseUrl: "https://media.example.invalid",
      apiKeyRef: "env:SEEDREAM_API_KEY",
      apiKeyConfigured: true,
      apiKey: "test-key",
      httpClient: async () => {
        assert.fail("Seedream image_edit without image input must not call HTTP");
      },
    }),
  }), provider);

  assert.equal(resolution.ok, true);
  assert.ok(resolution.adapter);
  const result = await executeMediaJob(resolution.adapter, {
    jobId: "media_job_live_seedream_edit_missing_image",
    provider,
    operation: "image_edit",
    prompt: "Replace the background.",
    input: {},
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "invalid_request");
  assert.match(result.errorMessage ?? "", /source image URL/);
  assert.deepEqual(result.artifacts, []);
});

test("live media vendor transport calls OpenAI Images and stores b64 artifacts", async () => {
  const capturedRequests = [];
  const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const openAIImageProvider = {
    ...provider,
    id: "provider_openai_image",
    kind: "openai-compatible",
    displayName: "OpenAI Image",
    providerId: "custom-openai-compatible",
    model: "gpt-image-2",
    capabilities: ["image_generate"],
  };
  const registry = createDefaultMediaAdapterRegistry({
    mediaVendorTransport: createLiveMediaVendorTransport({
      baseUrl: "https://api.openai.test/v1",
      apiKeyRef: "env:OPENAI_API_KEY",
      apiKeyConfigured: true,
      apiKey: "test-key",
      httpClient: async (url, init) => {
        capturedRequests.push({ url, init });
        return jsonResponse(200, {
          created: 1779537600,
          data: [
            {
              b64_json: Buffer.from(imageBytes).toString("base64"),
            },
          ],
          debug: {
            echoedSecret: "test-key",
          },
        });
      },
    }),
  });
  const resolution = resolveMediaAdapter(registry, openAIImageProvider);

  assert.equal(resolution.ok, true);
  assert.ok(resolution.adapter);
  const result = await executeMediaJob(resolution.adapter, {
    jobId: "media_job_live_openai_image",
    provider: openAIImageProvider,
    operation: "image_generate",
    prompt: "Create a product mockup.",
    input: { size: "1024x1024", n: 1, seed: 42, watermark: false },
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.errorCode, undefined);
  assert.equal(result.artifacts.length, 3);
  assert.match(result.artifacts[0].content ?? "", /Transport: live/);
  assert.equal(result.artifacts[1].type, "json");
  assert.match(result.artifacts[1].content ?? "", /live_openai_image_generate/);
  assert.doesNotMatch(result.artifacts[1].content ?? "", /test-key/);
  assert.equal(result.artifacts[2].type, "image");
  assert.equal(result.artifacts[2].contentType, "image/png");
  assert.deepEqual(result.artifacts[2].contentBytes, imageBytes);
  assert.equal(capturedRequests.length, 1);
  assert.equal(capturedRequests[0].url, "https://api.openai.test/v1/images/generations");
  assert.equal(capturedRequests[0].init.headers.authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(capturedRequests[0].init.body ?? "{}"), {
    model: "gpt-image-2",
    prompt: "Create a product mockup.",
    response_format: "b64_json",
    size: "1024x1024",
    n: 1,
    seed: 42,
    watermark: false,
  });
});

test("OpenAI Images classifies content policy rejection separately from invalid configuration", async () => {
  const openAIImageProvider = {
    ...provider,
    id: "provider_openai_image_policy",
    kind: "openai-compatible",
    displayName: "OpenAI Image",
    providerId: "custom-openai-compatible",
    model: "gpt-image-2",
    capabilities: ["image_generate"],
  };
  const registry = createDefaultMediaAdapterRegistry({
    mediaVendorTransport: createLiveMediaVendorTransport({
      baseUrl: "https://api.openai.test/v1",
      apiKeyRef: "env:OPENAI_API_KEY",
      apiKeyConfigured: true,
      apiKey: "test-key",
      httpClient: async () => jsonResponse(400, {
        error: {
          message: "Request rejected by the safety system.",
          code: "moderation_blocked",
          moderation_details: { categories: ["sexual"] },
        },
      }),
    }),
  });
  const resolution = resolveMediaAdapter(registry, openAIImageProvider);
  assert.equal(resolution.ok, true);
  assert.ok(resolution.adapter);

  const result = await executeMediaJob(resolution.adapter, {
    jobId: "media_job_live_openai_image_policy",
    provider: openAIImageProvider,
    operation: "image_generate",
    prompt: "A request rejected by the upstream policy.",
    input: {},
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "content_policy_blocked");
  assert.deepEqual(result.artifacts, []);
});

test("OpenAI Images classifies a successful upstream response without image data as unavailable result", async () => {
  const openAIImageProvider = {
    ...provider,
    id: "provider_openai_image_empty_result",
    kind: "openai-compatible",
    displayName: "OpenAI Image",
    providerId: "custom-openai-compatible",
    model: "gpt-image-2",
    capabilities: ["image_generate"],
  };
  const registry = createDefaultMediaAdapterRegistry({
    mediaVendorTransport: createLiveMediaVendorTransport({
      baseUrl: "https://api.openai.test/v1",
      apiKeyRef: "env:OPENAI_API_KEY",
      apiKeyConfigured: true,
      apiKey: "test-key",
      httpClient: async () => jsonResponse(200, { data: [] }),
    }),
  });
  const resolution = resolveMediaAdapter(registry, openAIImageProvider);
  assert.equal(resolution.ok, true);
  assert.ok(resolution.adapter);

  const result = await executeMediaJob(resolution.adapter, {
    jobId: "media_job_live_openai_image_empty_result",
    provider: openAIImageProvider,
    operation: "image_generate",
    prompt: "A request that returns no generated image.",
    input: {},
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "media_result_unavailable");
  assert.equal(result.errorMessage, "OpenAI Images response did not include image data.");
});

test("live media vendor transport polls Seedance task status and downloads final video", async () => {
  const capturedRequests = [];
  const videoBytes = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
  let statusPollCount = 0;
  const seedanceProvider = {
    ...provider,
    id: "provider_seedance",
    kind: "seedance",
    displayName: "Seedance Video",
    providerId: "seedance",
    model: "seedance",
    capabilities: ["video_generate"],
  };
  const registry = createDefaultMediaAdapterRegistry({
    mediaVendorTransport: createLiveMediaVendorTransport({
      baseUrl: "https://media.example.invalid",
      apiKeyRef: "env:SEEDANCE_API_KEY",
      apiKeyConfigured: true,
      apiKey: "test-key",
      pollIntervalMs: 0,
      maxPollAttempts: 3,
      httpClient: async (url, init) => {
        capturedRequests.push({ url, init });
        if (url.endsWith("/contents/generations/tasks") && init.method === "POST") {
          return jsonResponse(200, { id: "task_123", debug: { echoedSecret: "test-key" } });
        }
        if (url.endsWith("/contents/generations/tasks/task_123") && init.method === "GET") {
          statusPollCount += 1;
          if (statusPollCount === 1) {
            return jsonResponse(200, { id: "task_123", status: "running" });
          }
          return jsonResponse(200, {
            id: "task_123",
            status: "succeeded",
            content: {
              video_url: "https://media.example.invalid/generated/video-1.mp4",
            },
            debug: {
              echoedSecret: "test-key",
            },
          });
        }
        if (url === "https://media.example.invalid/generated/video-1.mp4" && init.method === "GET") {
          return binaryResponse(200, "OK", videoBytes, { "content-type": "video/mp4" });
        }
        throw new Error(`Unexpected request: ${init.method} ${url}`);
      },
    }),
  });
  const resolution = resolveMediaAdapter(registry, seedanceProvider);

  assert.equal(resolution.ok, true);
  assert.ok(resolution.adapter);
  const result = await executeMediaJob(resolution.adapter, {
    jobId: "media_job_live_seedance",
    provider: seedanceProvider,
    operation: "video_generate",
    prompt: "Create a product walkthrough.",
    input: { ratio: "16:9", duration: 5, watermark: false },
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.errorCode, undefined);
  assert.equal(result.artifacts.length, 3);
  assert.match(result.artifacts[0].content ?? "", /Transport: live/);
  assert.equal(result.artifacts[1].type, "json");
  assert.match(result.artifacts[1].content ?? "", /live_seedance_video_generate_final/);
  assert.doesNotMatch(result.artifacts[1].content ?? "", /test-key/);
  assert.equal(result.artifacts[2].type, "video");
  assert.equal(result.artifacts[2].contentType, "video/mp4");
  assert.deepEqual(result.artifacts[2].contentBytes, videoBytes);
  assert.equal(statusPollCount, 2);
  assert.equal(capturedRequests[0].url, "https://media.example.invalid/contents/generations/tasks");
  assert.equal(capturedRequests[0].init.headers.authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(capturedRequests[0].init.body ?? "{}"), {
    model: "seedance",
    content: [{ type: "text", text: "Create a product walkthrough." }],
    ratio: "16:9",
    duration: 5,
    watermark: false,
  });
  assert.equal(capturedRequests.at(-1).url, "https://media.example.invalid/generated/video-1.mp4");
  assert.deepEqual(capturedRequests.at(-1).init.headers, {});
});

test("Seedance task submission sends role-bearing image inputs without persisting their Data URLs", async () => {
  const capturedRequests = [];
  const providerWithModel = {
    ...provider,
    id: "provider_seedance_2_0",
    kind: "seedance",
    displayName: "Seedance 2.0",
    providerId: "seedance",
    model: "doubao-seedance-2-0-260128",
    capabilities: ["video_generate"],
  };
  const resolution = resolveMediaAdapter(createDefaultMediaAdapterRegistry({
    mediaVendorTransport: createLiveMediaVendorTransport({
      baseUrl: "https://media.example.invalid",
      apiKeyRef: "env:SEEDANCE_API_KEY",
      apiKeyConfigured: true,
      apiKey: "test-key",
      httpClient: async (url, init) => {
        capturedRequests.push({ url, init });
        return jsonResponse(200, { id: "task_image_input" });
      },
    }),
  }), providerWithModel);
  assert.equal(resolution.ok, true);
  assert.ok(resolution.adapter?.submit);

  const imageUrl = "data:image/png;base64,aGVsbG8=";
  const submission = await resolution.adapter.submit({
    jobId: "media_job_seedance_image_input",
    provider: providerWithModel,
    operation: "video_generate",
    prompt: "Move the camera slowly.",
    input: { ratio: "16:9", duration: 5 },
    videoImageInputs: [{ role: "reference_image", imageUrl }],
    requestedAt: "2026-08-21T00:00:00.000Z",
  });

  assert.equal(submission.status, "submitted");
  assert.equal(capturedRequests.length, 1);
  assert.deepEqual(JSON.parse(capturedRequests[0].init.body ?? "{}"), {
    model: "doubao-seedance-2-0-260128",
    content: [
      { type: "text", text: "Move the camera slowly." },
      { type: "image_url", image_url: { url: imageUrl }, role: "reference_image" },
    ],
    ratio: "16:9",
    duration: 5,
    watermark: false,
  });
  assert.doesNotMatch(JSON.stringify(submission), /data:image|aGVsbG8/);
  if (submission.status === "submitted") {
    assert.deepEqual(submission.handle.recovery.requestSummary, {
      model: "doubao-seedance-2-0-260128",
      ratio: "16:9",
      duration: 5,
      watermark: false,
      inputMode: "reference_image",
      imageCount: 1,
    });
  }
});

test("Seedance image input validation fails closed for unknown versions and provider limits", async () => {
  let requestCount = 0;
  const registry = createDefaultMediaAdapterRegistry({
    mediaVendorTransport: createLiveMediaVendorTransport({
      baseUrl: "https://media.example.invalid",
      apiKeyRef: "env:SEEDANCE_API_KEY",
      apiKeyConfigured: true,
      apiKey: "test-key",
      httpClient: async () => {
        requestCount += 1;
        return jsonResponse(200, { id: `task_${requestCount}` });
      },
    }),
  });
  const image = { role: "reference_image", imageUrl: "data:image/png;base64,YQ==" };

  async function submit(model, videoImageInputs) {
    const configured = {
      ...provider,
      id: `provider_${model}`,
      kind: "seedance",
      providerId: "seedance",
      model,
      capabilities: ["video_generate"],
    };
    const resolution = resolveMediaAdapter(registry, configured);
    assert.ok(resolution.adapter?.submit);
    return await resolution.adapter.submit({
      jobId: `job_${model}`,
      provider: configured,
      operation: "video_generate",
      prompt: "Animate this image.",
      input: {},
      videoImageInputs,
      requestedAt: "2026-08-21T00:00:00.000Z",
    });
  }

  await assert.rejects(() => submit("doubao-seedance-next", [image]), /Unknown Seedance model versions/);
  await assert.rejects(() => submit("doubao-seedance-1-5-pro-251215", [image]), /does not accept reference images/);
  await assert.rejects(() => submit("doubao-seedance-2-0-260128", Array.from({ length: 10 }, () => image)), /at most 9/);
  await assert.rejects(() => submit("doubao-seedance-2-5-260628", Array.from({ length: 31 }, () => image)), /at most 30/);
  assert.equal(requestCount, 0);

  const firstFrame = await submit("doubao-seedance-1-5-pro-251215", [{ ...image, role: "first_frame" }]);
  assert.equal(firstFrame.status, "submitted");
  const nineReferences = await submit("doubao-seedance-2-0-260128", Array.from({ length: 9 }, () => image));
  assert.equal(nineReferences.status, "submitted");
  const thirtyReferences = await submit("doubao-seedance-2-5-260628", Array.from({ length: 30 }, () => image));
  assert.equal(thirtyReferences.status, "submitted");
  assert.equal(requestCount, 3);
});

test("live media vendor transport rejects Seedance success without final video", async () => {
  const seedanceProvider = {
    ...provider,
    id: "provider_seedance",
    kind: "seedance",
    displayName: "Seedance Video",
    providerId: "seedance",
    model: "seedance",
    capabilities: ["video_generate"],
  };
  const resolution = resolveMediaAdapter(createDefaultMediaAdapterRegistry({
    mediaVendorTransport: createLiveMediaVendorTransport({
      baseUrl: "https://media.example.invalid",
      apiKeyRef: "env:SEEDANCE_API_KEY",
      apiKeyConfigured: true,
      apiKey: "test-key",
      pollIntervalMs: 0,
      maxPollAttempts: 1,
      httpClient: async (url, init) => {
        if (url.endsWith("/contents/generations/tasks") && init.method === "POST") {
          return jsonResponse(200, { id: "task_123" });
        }
        if (url.endsWith("/contents/generations/tasks/task_123") && init.method === "GET") {
          return jsonResponse(200, { id: "task_123", status: "succeeded" });
        }
        throw new Error(`Unexpected request: ${init.method} ${url}`);
      },
    }),
  }), seedanceProvider);

  assert.equal(resolution.ok, true);
  assert.ok(resolution.adapter);
  const result = await executeMediaJob(resolution.adapter, {
    jobId: "media_job_live_seedance_no_video",
    provider: seedanceProvider,
    operation: "video_generate",
    prompt: "Create a product walkthrough.",
    input: {},
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "invalid_request");
  assert.match(result.errorMessage ?? "", /final video URL|recognizable status/);
  assert.deepEqual(result.artifacts, []);
});

test("live media vendor transport fails Seedance terminal failure status", async () => {
  const seedanceProvider = {
    ...provider,
    id: "provider_seedance",
    kind: "seedance",
    displayName: "Seedance Video",
    providerId: "seedance",
    model: "seedance",
    capabilities: ["video_generate"],
  };
  const resolution = resolveMediaAdapter(createDefaultMediaAdapterRegistry({
    mediaVendorTransport: createLiveMediaVendorTransport({
      baseUrl: "https://media.example.invalid",
      apiKeyRef: "env:SEEDANCE_API_KEY",
      apiKeyConfigured: true,
      apiKey: "test-key",
      pollIntervalMs: 0,
      maxPollAttempts: 1,
      httpClient: async (url, init) => {
        if (url.endsWith("/contents/generations/tasks") && init.method === "POST") {
          return jsonResponse(200, { id: "task_123" });
        }
        if (url.endsWith("/contents/generations/tasks/task_123") && init.method === "GET") {
          return jsonResponse(200, { id: "task_123", status: "failed" });
        }
        throw new Error(`Unexpected request: ${init.method} ${url}`);
      },
    }),
  }), seedanceProvider);

  assert.equal(resolution.ok, true);
  assert.ok(resolution.adapter);
  const result = await executeMediaJob(resolution.adapter, {
    jobId: "media_job_live_seedance_failed_status",
    provider: seedanceProvider,
    operation: "video_generate",
    prompt: "Create a product walkthrough.",
    input: {},
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "provider_internal_error");
  assert.match(result.errorMessage ?? "", /failed before returning a video URL/);
});

test("live media vendor transport reports a clear timeout error", async () => {
  const registry = createDefaultMediaAdapterRegistry({
    mediaVendorTransport: createLiveMediaVendorTransport({
      baseUrl: "https://media.example.invalid",
      apiKeyRef: "env:SEEDREAM_API_KEY",
      apiKeyConfigured: true,
      apiKey: "test-key",
      timeoutMs: 5,
      httpClient: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("This operation was aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    }),
  });
  const resolution = resolveMediaAdapter(registry, provider);

  assert.equal(resolution.ok, true);
  assert.ok(resolution.adapter);
  const result = await executeMediaJob(resolution.adapter, {
    jobId: "media_job_live_seedream_timeout",
    provider,
    operation: "image_generate",
    prompt: "Create a product mockup.",
    input: { size: "2K" },
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "timeout");
  assert.match(result.errorMessage ?? "", /timed out after/);
  assert.doesNotMatch(result.errorMessage ?? "", /This operation was aborted/);
});

test("live media vendor transport normalizes Seedream HTTP failures", async () => {
  const seedream = defaultMediaVendorAdapterDefinitions().find((definition) => definition.kind === "seedream");
  assert.ok(seedream);
  const plan = createMediaVendorRequestPlan(seedream, {
    jobId: "media_job_live_transport_http_failure",
    provider,
    operation: "image_generate",
    prompt: "Create a product mockup.",
    input: {},
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  const result = await createLiveMediaVendorTransport({
    baseUrl: "https://media.example.invalid/",
    apiKeyRef: "env:SEEDREAM_API_KEY",
    apiKeyConfigured: true,
    apiKey: "test-key",
    httpClient: async () => textResponse(429, "Too Many Requests", "{\"error\":\"rate limited\",\"echo\":\"test-key\"}"),
  }).execute({
    vendor: seedream,
    requestPlan: plan,
    jobId: "media_job_live_transport_http_failure",
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "rate_limited");
  assert.match(result.errorMessage ?? "", /HTTP 429/);
  assert.match(result.errorMessage ?? "", /rate limited/);
  assert.doesNotMatch(result.errorMessage ?? "", /test-key/);
});

test("live media vendor transport rejects invalid image downloads", async () => {
  const seedream = defaultMediaVendorAdapterDefinitions().find((definition) => definition.kind === "seedream");
  assert.ok(seedream);
  const plan = createMediaVendorRequestPlan(seedream, {
    jobId: "media_job_live_transport_invalid_image",
    provider,
    operation: "image_generate",
    prompt: "Create a product mockup.",
    input: {},
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  const missingUrl = await createLiveMediaVendorTransport({
    baseUrl: "https://media.example.invalid/",
    apiKeyRef: "env:SEEDREAM_API_KEY",
    apiKeyConfigured: true,
    apiKey: "test-key",
    httpClient: async () => jsonResponse(200, { data: [{ b64_json: "not-supported-in-this-slice" }] }),
  }).execute({
    vendor: seedream,
    requestPlan: plan,
    jobId: "media_job_live_transport_missing_url",
    requestedAt: "2026-05-23T00:00:00.000Z",
  });
  assert.equal(missingUrl.status, "failed");
  assert.equal(missingUrl.errorCode, "invalid_request");
  assert.match(missingUrl.errorMessage ?? "", /did not include image URL data/);

  const invalidProtocol = await createLiveMediaVendorTransport({
    baseUrl: "https://media.example.invalid/",
    apiKeyRef: "env:SEEDREAM_API_KEY",
    apiKeyConfigured: true,
    apiKey: "test-key",
    httpClient: async () => jsonResponse(200, { data: [{ url: "file:///tmp/image.png" }] }),
  }).execute({
    vendor: seedream,
    requestPlan: plan,
    jobId: "media_job_live_transport_invalid_protocol",
    requestedAt: "2026-05-23T00:00:00.000Z",
  });
  assert.equal(invalidProtocol.status, "failed");
  assert.equal(invalidProtocol.errorCode, "invalid_request");
  assert.match(invalidProtocol.errorMessage ?? "", /must use http or https/);

  const nonImage = await createLiveMediaVendorTransport({
    baseUrl: "https://media.example.invalid/",
    apiKeyRef: "env:SEEDREAM_API_KEY",
    apiKeyConfigured: true,
    apiKey: "test-key",
    httpClient: async (_url, init) => init.method === "GET"
      ? textResponse(200, "OK", "not an image", { "content-type": "text/plain" })
      : jsonResponse(200, { data: [{ url: "https://media.example.invalid/generated/image-1.txt" }] }),
  }).execute({
    vendor: seedream,
    requestPlan: plan,
    jobId: "media_job_live_transport_invalid_image",
    requestedAt: "2026-05-23T00:00:00.000Z",
  });
  assert.equal(nonImage.status, "failed");
  assert.equal(nonImage.errorCode, "invalid_request");
  assert.match(nonImage.errorMessage ?? "", /non-image content type/);

  const failedDownload = await createLiveMediaVendorTransport({
    baseUrl: "https://media.example.invalid/",
    apiKeyRef: "env:SEEDREAM_API_KEY",
    apiKeyConfigured: true,
    apiKey: "test-key",
    httpClient: async (_url, init) => init.method === "GET"
      ? textResponse(404, "Not Found", "missing")
      : jsonResponse(200, { data: [{ url: "https://media.example.invalid/generated/missing.png" }] }),
  }).execute({
    vendor: seedream,
    requestPlan: plan,
    jobId: "media_job_live_transport_missing_image",
    requestedAt: "2026-05-23T00:00:00.000Z",
  });
  assert.equal(failedDownload.status, "failed");
  assert.equal(failedDownload.errorCode, "model_not_found");
  assert.match(failedDownload.errorMessage ?? "", /image download failed with HTTP 404/);

  const tooLarge = await createLiveMediaVendorTransport({
    baseUrl: "https://media.example.invalid/",
    apiKeyRef: "env:SEEDREAM_API_KEY",
    apiKeyConfigured: true,
    apiKey: "test-key",
    httpClient: async (_url, init) => init.method === "GET"
      ? binaryResponse(200, "OK", Uint8Array.from([1, 2, 3]), {
        "content-type": "image/png",
        "content-length": String(26 * 1024 * 1024),
      })
      : jsonResponse(200, { data: [{ url: "https://media.example.invalid/generated/too-large.png" }] }),
  }).execute({
    vendor: seedream,
    requestPlan: plan,
    jobId: "media_job_live_transport_large_image",
    requestedAt: "2026-05-23T00:00:00.000Z",
  });
  assert.equal(tooLarge.status, "failed");
  assert.equal(tooLarge.errorCode, "invalid_request");
  assert.match(tooLarge.errorMessage ?? "", /byte limit/);
});

test("fake media vendor transport receives redacted request mapping and can add artifacts", async () => {
  let capturedPlan;
  const fakeTransport = {
    mode: "fake",
    async execute(request) {
      capturedPlan = request.requestPlan;
      return {
        status: "succeeded",
        artifacts: [
          {
            type: "json",
            title: "Fake vendor response",
            contentType: "application/json; charset=utf-8",
            pathHint: "fake-vendor-response.json",
            content: JSON.stringify({
              mode: request.requestPlan.mode,
              vendor: request.vendor.kind,
              operation: request.requestPlan.operation,
            }, null, 2),
          },
        ],
      };
    },
  };
  const registry = createDefaultMediaAdapterRegistry({ mediaVendorTransport: fakeTransport });
  const resolution = resolveMediaAdapter(registry, provider);

  assert.equal(resolution.ok, true);
  assert.ok(resolution.adapter);
  const result = await executeMediaJob(resolution.adapter, {
    jobId: "media_job_fake_transport",
    provider,
    operation: "image_generate",
    prompt: "Create a product mockup.",
    input: { apiKey: "sk-test_123456789" },
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.artifacts.length, 2);
  assert.equal(result.artifacts[1].type, "json");
  assert.match(result.artifacts[0].content ?? "", /Transport: fake/);
  assert.deepEqual(capturedPlan?.payload.input, { apiKey: "[REDACTED]" });
  assert.doesNotMatch(JSON.stringify(capturedPlan), /sk-test_123456789/);
});

test("media vendor transport failures normalize through the media adapter result", async () => {
  const registry = new MediaAdapterRegistry({
    factories: [
      createStaticVendorMediaAdapterFactory("seedream", "Seedream", {
        transport: {
          mode: "fake",
          async execute() {
            return {
              status: "failed",
              errorCode: "rate_limited",
              errorMessage: "Fake vendor rate limit.",
            };
          },
        },
      }),
    ],
  });
  const resolution = resolveMediaAdapter(registry, provider);

  assert.equal(resolution.ok, true);
  assert.ok(resolution.adapter);
  const result = await executeMediaJob(resolution.adapter, {
    jobId: "media_job_fake_transport_failure",
    provider,
    operation: "image_generate",
    prompt: "Create a product mockup.",
    input: {},
    requestedAt: "2026-05-23T00:00:00.000Z",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "rate_limited");
  assert.match(result.errorMessage ?? "", /rate limit/);
  assert.deepEqual(result.artifacts, []);
});

test("media adapter registry reports clear missing adapter errors when fallback is disabled", () => {
  const registry = new MediaAdapterRegistry({ enableStaticFallback: false });
  const resolution = resolveMediaAdapter(registry, { ...provider, kind: "unknown-media" });

  assert.equal(resolution.ok, false);
  assert.equal(resolution.errorCode, "unsupported_capability");
  assert.match(resolution.errorMessage ?? "", /No media adapter is registered/);
});

test("media adapter registry rejects non-media provider presets", () => {
  const resolution = resolveMediaAdapter(createDefaultMediaAdapterRegistry(), { ...provider, api: "openai-completions" });

  assert.equal(resolution.ok, false);
  assert.equal(resolution.errorCode, "unsupported_capability");
  assert.match(resolution.errorMessage ?? "", /media-job provider preset/);
});

function jsonResponse(status, body, headers = { "content-type": "application/json" }) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    headers: headersObject(headers),
    async json() {
      return body;
    },
    async text() {
      return text;
    },
    async arrayBuffer() {
      return new TextEncoder().encode(text).buffer;
    },
  };
}

function textResponse(status, statusText, body, headers = { "content-type": "text/plain" }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: headersObject(headers),
    async json() {
      return JSON.parse(body);
    },
    async text() {
      return body;
    },
    async arrayBuffer() {
      return new TextEncoder().encode(body).buffer;
    },
  };
}

function binaryResponse(status, statusText, bytes, headers) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: headersObject({
      "content-length": String(bytes.byteLength),
      ...headers,
    }),
    async json() {
      throw new Error("binary response is not JSON");
    },
    async text() {
      return Buffer.from(bytes).toString("binary");
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function headersObject(headers) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    get(name) {
      return normalized.get(name.toLowerCase()) ?? null;
    },
  };
}
