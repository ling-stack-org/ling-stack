import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MediaAdapterExecutionError,
  createStaticMediaAdapter,
  executeMediaJob,
  normalizeMediaAdapterError,
} from "../dist/index.js";

const provider = {
  id: "provider_seedream",
  displayName: "Seedream Image",
  providerId: "seedream",
  model: "seedream",
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
