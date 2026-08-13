import assert from "node:assert/strict";
import test from "node:test";
import { providerWorkbenchReady } from "../src/lib/provider-workbench-readiness.ts";

test("generation providers require runtime readiness and a successful latest check", () => {
  const base = {
    enabled: true,
    secretReady: true,
    generationCapable: true,
    generationRuntimeReady: true,
  };

  assert.equal(providerWorkbenchReady({ ...base, latestCheckReady: false }), false);
  assert.equal(providerWorkbenchReady({
    ...base,
    latestCheckReady: true,
    generationRuntimeReady: false,
  }), false);
  assert.equal(providerWorkbenchReady({ ...base, latestCheckReady: true }), true);
});

test("chat-only providers keep the existing checked readiness contract", () => {
  assert.equal(providerWorkbenchReady({
    enabled: true,
    secretReady: true,
    latestCheckReady: true,
    generationCapable: false,
    generationRuntimeReady: false,
  }), true);
  assert.equal(providerWorkbenchReady({
    enabled: true,
    secretReady: true,
    latestCheckReady: false,
    generationCapable: false,
    generationRuntimeReady: false,
  }), false);
});
