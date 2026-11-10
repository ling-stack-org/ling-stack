import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultProviderTemplates,
  providerCapabilitySourceLabel,
  resolveProviderModelCapabilitySnapshot,
} from "../dist/index.js";

function provider(overrides = {}) {
  return {
    id: "provider_test",
    kind: "openai-compatible",
    providerId: "custom-openai-compatible",
    model: "custom-model",
    api: "openai-completions",
    contextWindow: undefined,
    maxTokens: undefined,
    capabilities: ["chat", "tool_call"],
    ...overrides,
  };
}

test("provider capability snapshot treats advanced token fields as user overrides", () => {
  const snapshot = resolveProviderModelCapabilitySnapshot(provider({ contextWindow: 12000, maxTokens: 2000 }));

  assert.equal(snapshot.chatEligible, true);
  assert.equal(snapshot.source, "user_override");
  assert.equal(snapshot.confidence, "known");
  assert.equal(snapshot.contextWindowTokens, 12000);
  assert.equal(snapshot.maxOutputTokens, 2000);
  assert.equal(snapshot.tokenizer, "openai-compatible");
  assert.equal(providerCapabilitySourceLabel(snapshot.source), "Custom override");
});

test("provider capability snapshot allows blank token overrides and matches bundled templates", () => {
  const template = defaultProviderTemplates().find((candidate) => candidate.templateId === "openai-gpt");
  assert.ok(template);

  const snapshot = resolveProviderModelCapabilitySnapshot(
    provider({
      kind: template.kind,
      providerId: template.providerId,
      model: template.model,
      api: template.api,
      contextWindow: undefined,
      maxTokens: undefined,
      capabilities: template.capabilities,
    }),
  );

  assert.equal(snapshot.chatEligible, true);
  assert.equal(snapshot.source, "provider_template");
  assert.equal(snapshot.confidence, "known");
  assert.equal(snapshot.contextWindowTokens, 128000);
  assert.equal(snapshot.maxOutputTokens, 16384);
  assert.equal(providerCapabilitySourceLabel(snapshot.source), "Auto");
});

test("provider capability snapshot estimates known provider families without exact template metadata", () => {
  const snapshot = resolveProviderModelCapabilitySnapshot(
    provider({
      kind: "anthropic",
      providerId: "custom-anthropic",
      model: "claude-custom",
      api: "anthropic-messages",
    }),
  );

  assert.equal(snapshot.chatEligible, true);
  assert.equal(snapshot.source, "provider_metadata");
  assert.equal(snapshot.confidence, "estimated");
  assert.equal(snapshot.contextWindowTokens, 32768);
  assert.equal(snapshot.maxOutputTokens, 1024);
  assert.equal(snapshot.tokenizer, "anthropic-compatible");
  assert.equal(providerCapabilitySourceLabel(snapshot.source), "Estimated");
});

test("provider capability snapshot does not promote custom model ids to bundled template known", () => {
  const snapshot = resolveProviderModelCapabilitySnapshot(
    provider({
      kind: "openai",
      providerId: "openai",
      model: "custom-openai-model",
      api: "openai-completions",
    }),
  );

  assert.equal(snapshot.chatEligible, true);
  assert.equal(snapshot.source, "provider_metadata");
  assert.equal(snapshot.confidence, "estimated");
  assert.equal(snapshot.contextWindowTokens, 32768);
  assert.equal(snapshot.maxOutputTokens, 1024);
});

test("provider capability snapshot applies runtime observed downgrades without mutating source identity", () => {
  const snapshot = resolveProviderModelCapabilitySnapshot(
    provider({
      kind: "anthropic",
      providerId: "custom-anthropic",
      model: "claude-custom",
      api: "anthropic-messages",
    }),
    {
      runtimeObservation: {
        providerPresetId: "provider_test",
        providerKind: "anthropic",
        providerApi: "anthropic-messages",
        modelId: "claude-custom",
        previousContextWindowTokens: 32768,
        observedContextWindowTokens: 12000,
        failureCode: "context_length_error",
        observedAt: "2026-06-13T00:00:00.000Z",
      },
    },
  );

  assert.equal(snapshot.chatEligible, true);
  assert.equal(snapshot.source, "runtime_observed");
  assert.equal(snapshot.confidence, "estimated");
  assert.equal(snapshot.contextWindowTokens, 12000);
  assert.equal(snapshot.maxOutputTokens, 1024);
  assert.equal(snapshot.observedAt, "2026-06-13T00:00:00.000Z");
});

test("provider capability snapshot keeps user overrides authoritative over runtime observations", () => {
  const snapshot = resolveProviderModelCapabilitySnapshot(
    provider({ contextWindow: 64000, maxTokens: 4096 }),
    {
      runtimeObservation: {
        providerPresetId: "provider_test",
        providerKind: "openai-compatible",
        providerApi: "openai-completions",
        modelId: "custom-model",
        previousContextWindowTokens: 64000,
        observedContextWindowTokens: 12000,
        failureCode: "context_length_error",
        observedAt: "2026-06-13T00:00:00.000Z",
      },
    },
  );

  assert.equal(snapshot.chatEligible, true);
  assert.equal(snapshot.source, "user_override");
  assert.equal(snapshot.confidence, "known");
  assert.equal(snapshot.contextWindowTokens, 64000);
  assert.equal(snapshot.maxOutputTokens, 4096);
});

test("provider capability snapshot uses conservative defaults for unknown compatible providers", () => {
  const snapshot = resolveProviderModelCapabilitySnapshot(provider());

  assert.equal(snapshot.chatEligible, true);
  assert.equal(snapshot.source, "conservative_default");
  assert.equal(snapshot.confidence, "conservative");
  assert.equal(snapshot.contextWindowTokens, 8192);
  assert.equal(snapshot.maxOutputTokens, 1024);
  assert.equal(providerCapabilitySourceLabel(snapshot.source), "Conservative");
});

test("an output-only override does not assert an unknown context window is known", () => {
  const snapshot = resolveProviderModelCapabilitySnapshot(provider({ maxTokens: 8192 }));
  assert.equal(snapshot.source, "conservative_default");
  assert.equal(snapshot.confidence, "conservative");
  assert.equal(snapshot.contextWindowTokens, 8192);
  assert.equal(snapshot.maxOutputTokens, 8192);
});

test("an output-only override retains a matching runtime context downgrade", () => {
  const snapshot = resolveProviderModelCapabilitySnapshot(provider({ maxTokens: 2048 }), {
    runtimeObservation: {
      providerPresetId: "provider_test", providerKind: "openai-compatible",
      providerApi: "openai-completions", modelId: "custom-model",
      previousContextWindowTokens: 8192, observedContextWindowTokens: 4096,
      failureCode: "context_length_error", observedAt: "2026-10-23T00:00:00.000Z",
    },
  });
  assert.equal(snapshot.source, "runtime_observed");
  assert.equal(snapshot.confidence, "estimated");
  assert.equal(snapshot.contextWindowTokens, 4096);
  assert.equal(snapshot.maxOutputTokens, 2048);
});

test("provider capability snapshot returns explicit non-chat state for media providers", () => {
  const snapshot = resolveProviderModelCapabilitySnapshot(
    provider({
      kind: "seedream",
      providerId: "seedream",
      model: "doubao-seedream-5-0-260128",
      api: "media-job",
      capabilities: ["image_generate", "image_edit"],
    }),
  );

  assert.equal(snapshot.chatEligible, false);
  assert.equal(snapshot.source, "non_chat");
  assert.equal(snapshot.confidence, "conservative");
  assert.equal(snapshot.contextWindowTokens, undefined);
  assert.equal(snapshot.maxOutputTokens, undefined);
  assert.equal(providerCapabilitySourceLabel(snapshot.source), "Auto");
});

test("legacy unsafe token overrides cannot become known model capacity or output limits", () => {
  const snapshot = resolveProviderModelCapabilitySnapshot(provider({
    contextWindow: Number.MAX_SAFE_INTEGER + 1, maxTokens: Number.MAX_SAFE_INTEGER + 1,
  }));
  assert.equal(snapshot.source, "conservative_default");
  assert.equal(snapshot.confidence, "conservative");
  assert.equal(snapshot.contextWindowTokens, 8192);
  assert.equal(snapshot.maxOutputTokens, 1024);
});
