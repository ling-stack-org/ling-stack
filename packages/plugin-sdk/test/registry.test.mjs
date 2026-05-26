import assert from "node:assert/strict";
import test from "node:test";
import {
  createExtensionKindRegistry,
  createLingExtensionRegistry,
} from "../dist/index.js";

function toolExtension(id, kind = "tool") {
  return {
    manifest: {
      id,
      name: `Tool ${id}`,
      version: "0.1.0",
      kind,
      trustLevel: "internal",
      capabilities: [id],
    },
    toolName: id.replace(/^tool:/, ""),
    sideEffectLevel: "read",
    defaultApproval: "allow",
  };
}

function runnerExtension(id) {
  return {
    manifest: {
      id,
      name: `Runner ${id}`,
      version: "0.1.0",
      kind: "runner",
      trustLevel: "internal",
      capabilities: ["chat"],
    },
    runnerId: id.replace(/^runner:/, ""),
    supportedTools: ["read"],
    supportedProviderApis: ["openai-completions"],
    eventTypes: ["run_start", "run_end"],
  };
}

test("kind registry rejects wrong kinds and exposes read-only snapshots", () => {
  const tools = createExtensionKindRegistry("tool");
  tools.register(toolExtension("tool:read"));

  assert.equal(tools.get("tool:read")?.toolName, "read");
  assert.equal(tools.has("tool:read"), true);
  assert.deepEqual(tools.list().map((extension) => extension.manifest.id), ["tool:read"]);
  assert.throws(() => tools.list().push(toolExtension("tool:write")), /object is not extensible|Cannot add property/);
  assert.throws(() => tools.register(toolExtension("runner:pi", "runner")), /expected tool/);
});

test("global registry rejects duplicate ids across extension kinds", () => {
  const registry = createLingExtensionRegistry();
  registry.register(toolExtension("shared:id"));
  assert.throws(() => registry.register(runnerExtension("shared:id")), /Duplicate extension id/);
});

test("global registry routes get list and listByKind", () => {
  const registry = createLingExtensionRegistry();
  registry.register(toolExtension("tool:read"));
  registry.register(runnerExtension("runner:pi"));

  assert.equal(registry.get("runner:pi")?.manifest.kind, "runner");
  assert.equal(registry.has("tool:read"), true);
  assert.deepEqual(registry.list().map((extension) => extension.manifest.id), ["tool:read", "runner:pi"]);
  assert.deepEqual(registry.listByKind("tool").map((extension) => extension.toolName), ["read"]);
});

test("manifest validation rejects invalid required fields", () => {
  const registry = createLingExtensionRegistry();
  assert.throws(() => registry.register(toolExtension("")), /manifest.id/);
  assert.throws(
    () =>
      registry.register({
        ...toolExtension("tool:bad"),
        manifest: {
          ...toolExtension("tool:bad").manifest,
          version: "",
        },
      }),
    /manifest.version/,
  );
  assert.throws(
    () =>
      registry.register({
        ...toolExtension("tool:bad-trust"),
        manifest: {
          ...toolExtension("tool:bad-trust").manifest,
          trustLevel: "external",
        },
      }),
    /trust level/,
  );
});
