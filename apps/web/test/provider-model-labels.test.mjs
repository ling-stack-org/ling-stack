import assert from "node:assert/strict";
import test from "node:test";
import {
  formatProviderModelRouteLabel,
  providerCompactModelLabel,
  providerDisplaySourceLabel,
} from "../src/lib/provider-model-labels.ts";

const duplicateNameProvider = {
  api: "openai-completions",
  baseUrl: "http://192.168.80.2:8317/v1",
  displayName: "gpt-5.6-luna · gpt-5.6-luna",
  kind: "openai-compatible",
  model: "gpt-5.6-luna",
  providerId: "custom-openai-compatible",
};

test("compact model labels ignore duplicate provider display names", () => {
  assert.equal(providerCompactModelLabel(duplicateNameProvider), "gpt-5.6-luna");
  assert.equal(
    providerDisplaySourceLabel(duplicateNameProvider.displayName, duplicateNameProvider.model),
    "gpt-5.6-luna",
  );
});

test("model selectors use model and route without repeating the model", () => {
  assert.equal(
    formatProviderModelRouteLabel("gpt-5.6-luna", "192.168.80.2:8317"),
    "gpt-5.6-luna · 192.168.80.2:8317",
  );
  assert.equal(formatProviderModelRouteLabel("gpt-5.6-luna", "gpt-5.6-luna"), "gpt-5.6-luna");
});
