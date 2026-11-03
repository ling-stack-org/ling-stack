import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PINNED_SHELL_INVENTORY_CHECKSUM } from "./verify-shell-resource-prerequisites.mjs";
import { PINNED_SHELL_DEPENDENCY_REVIEW_CHECKSUM } from "./verify-reviewed-shell-dependencies.mjs";
import { PINNED_SHELL_COMMAND_REVIEW_CHECKSUM } from "./verify-reviewed-shell-commands.mjs";

const bytes = name => readFile(new URL(name, import.meta.url));
const json = async name => JSON.parse(await bytes(name));
const source = await json("reviewed-source-bundle.json");
const checksum = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;

// The reviewed-sdk-only macOS lane consumes these four catalogs. Windows and
// build-only type pruning require separate reviews; never auto-refresh them.
for (const name of ["reviewed-upstream-self-test-packages.json", "pinned-shell-inventory.json",
  "reviewed-shell-dependencies.json", "reviewed-shell-commands.json"]) {
  test(`macOS SDK-only source consumer stays bound to the reviewed source: ${name}`, async () => {
    const consumer = await json(name);
    assert.equal(consumer.upstreamRevision, source.upstreamRevision);
    assert.equal(consumer.sourceManifestChecksum, source.manifestChecksum,
      "Source recipe changes require content verification and explicit consumer review before packaging");
  });
}

for (const [name, expected] of [
  ["pinned-shell-inventory.json", PINNED_SHELL_INVENTORY_CHECKSUM],
  ["reviewed-shell-dependencies.json", PINNED_SHELL_DEPENDENCY_REVIEW_CHECKSUM],
  ["reviewed-shell-commands.json", PINNED_SHELL_COMMAND_REVIEW_CHECKSUM],
]) {
  test(`shell review detached checksum stays bound to the exact catalog: ${name}`, async () => {
    assert.equal(checksum(await bytes(name)), expected);
  });
}
