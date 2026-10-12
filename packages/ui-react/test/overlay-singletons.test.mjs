import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";

const uiRequire = createRequire(new URL("../package.json", import.meta.url));

/** Resolve the installed layer from each actual overlay consumer, not root hoisting. */
function dismissalIdentity(consumerName, dependencyName) {
  let consumerEntry = uiRequire.resolve(consumerName);
  if (dependencyName) {
    consumerEntry = createRequire(consumerEntry).resolve(dependencyName);
  }
  const layerEntry = createRequire(consumerEntry).resolve("@radix-ui/react-dismissable-layer");
  const manifestPath = join(dirname(layerEntry), "../package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.name, "@radix-ui/react-dismissable-layer");
  assert.equal(typeof manifest.module, "string");
  return {
    consumer: consumerName,
    version: manifest.version,
    cjs: realpathSync(layerEntry),
    esm: realpathSync(join(dirname(manifestPath), manifest.module)),
  };
}

test("Tooltip, Dialog, Popover, Menu and Toast share one installed dismissal stack", () => {
  // This Radix context owns document-level Escape handling and must be a singleton.
  // The targeted patch override intentionally reconciles upstream exact pins.
  const identities = [
    dismissalIdentity("@radix-ui/react-tooltip"),
    dismissalIdentity("@radix-ui/react-dialog"),
    dismissalIdentity("@radix-ui/react-popover"),
    dismissalIdentity("@radix-ui/react-dropdown-menu", "@radix-ui/react-menu"),
    dismissalIdentity("@radix-ui/react-toast"),
  ];
  for (const identity of identities) {
    assert.equal(identity.version, "1.1.20", identity.consumer);
    assert.equal(identity.cjs, identities[0].cjs, `${identity.consumer}: CJS singleton`);
    assert.equal(identity.esm, identities[0].esm, `${identity.consumer}: ESM singleton`);
  }
});
