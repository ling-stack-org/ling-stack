import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultMediaAdapterRegistry,
  listBuiltinProviderExtensions,
  resolveMediaAdapter,
} from "../dist/index.js";

test("built-in media provider extensions include supported vendor adapters", () => {
  const extensions = listBuiltinProviderExtensions();
  const ids = extensions.map((extension) => extension.manifest.id);

  assert.deepEqual(ids, ["provider:media:jimeng", "provider:media:seedream", "provider:media:seedance"]);
  assert.deepEqual(
    extensions.map((extension) => extension.providerApi),
    ["media-job", "media-job", "media-job"],
  );
});

test("built-in media provider extensions preserve media adapter resolution", () => {
  const registry = createDefaultMediaAdapterRegistry({ enableStaticFallback: false });

  for (const extension of listBuiltinProviderExtensions()) {
    const resolution = resolveMediaAdapter(registry, {
      id: extension.manifest.id,
      kind: extension.providerKind,
      displayName: extension.manifest.name,
      providerId: extension.providerKind,
      model: extension.providerKind,
      api: "media-job",
      capabilities: extension.providerCapabilities,
    });

    assert.equal(resolution.ok, true);
    for (const operation of extension.mediaOperations ?? []) {
      assert.equal(resolution.adapter?.supports(operation), true);
    }
  }
});
