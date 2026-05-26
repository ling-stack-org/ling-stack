import assert from "node:assert/strict";
import test from "node:test";
import {
  createDaemonServer,
  createDefaultLingExtensionRegistry,
  LOCAL_CHANNEL_SOURCE_EXTENSION_ID,
} from "../dist/index.js";

test("default daemon extension registry contains built-in capabilities", () => {
  const registry = createDefaultLingExtensionRegistry();
  const ids = new Set(registry.list().map((extension) => extension.manifest.id));

  assert.equal(ids.has("runner:pi"), true);
  assert.equal(ids.has(LOCAL_CHANNEL_SOURCE_EXTENSION_ID), true);
  assert.equal(ids.has("skill-pack:gstack-default"), true);
  assert.equal(ids.has("provider:media:jimeng"), true);
  assert.equal(ids.has("provider:media:seedream"), true);
  assert.equal(ids.has("provider:media:seedance"), true);
  for (const tool of ["read", "grep", "find", "ls", "bash", "edit", "write"]) {
    assert.equal(ids.has(`tool:${tool}`), true);
  }
});

test("daemon server creates the default registry without changing execution dependencies", () => {
  const server = createDaemonServer({ port: 0 });

  assert.equal(server.extensionRegistry.has("runner:pi"), true);
  assert.equal(server.extensionRegistry.tools.get("tool:write")?.defaultApproval, "ask");
});
