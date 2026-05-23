import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MediaAdapterExecutionError,
  MediaAdapterRegistry,
  createDefaultMediaAdapterRegistry,
  createDisabledMediaVendorTransport,
  createMediaVendorRequestPlan,
  createStaticMediaAdapter,
  createStaticVendorMediaAdapterFactory,
  defaultMediaVendorAdapterDefinitions,
  executeMediaJob,
  normalizeMediaAdapterError,
  resolveMediaAdapter,
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
  assert.match(result.artifacts[0].content ?? "", /"apiKeyRef": "env:SEEDREAM_API_KEY"/);
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
