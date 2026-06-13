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

test("provider capability snapshot uses conservative defaults for unknown compatible providers", () => {
  const snapshot = resolveProviderModelCapabilitySnapshot(provider());

  assert.equal(snapshot.chatEligible, true);
  assert.equal(snapshot.source, "conservative_default");
  assert.equal(snapshot.confidence, "conservative");
  assert.equal(snapshot.contextWindowTokens, 8192);
  assert.equal(snapshot.maxOutputTokens, 1024);
  assert.equal(providerCapabilitySourceLabel(snapshot.source), "Conservative");
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
