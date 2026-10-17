import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readPackagedGstackIdentity } from "../dist/features/skills/packaged-identity.js";
import { preparePackagedGstackStartup } from "../dist/features/skills/packaged-startup.js";

test("an ordinary development daemon has no implicitly selected package", async () => {
  assert.equal(readPackagedGstackIdentity(), undefined);
  assert.equal(await preparePackagedGstackStartup(), undefined);
});

test("packaged desktop intent cannot silently fall back to old builtins without an embedded identity", async () => {
  const previous = process.env.LING_STACK_PACKAGED_DESKTOP;
  process.env.LING_STACK_PACKAGED_DESKTOP = "1";
  try { await assert.rejects(preparePackagedGstackStartup(), /packaged_gstack_identity_missing/); }
  finally {
    if (previous === undefined) delete process.env.LING_STACK_PACKAGED_DESKTOP;
    else process.env.LING_STACK_PACKAGED_DESKTOP = previous;
  }
});

test("build literal parser rejects unpinned, incomplete, duplicate and nonportable selections", async () => {
  const source = await readFile(new URL("../dist/features/skills/packaged-identity.js", import.meta.url), "utf8");
  const marker = 'const embeddedBundledGstackJson = "NO_PACKAGED_GSTACK_IDENTITY";';
  assert.equal(source.split(marker).length, 2);
  const valid = { manifestChecksum: `sha256:${"1".repeat(64)}`, upstreamRevision: "2".repeat(40),
    adaptationRevision: "ling-v1", target: { platform: "darwin", arch: "arm64" },
    skillIds: Array.from({ length: 57 }, (_, i) => `skill-${i}`) };
  const load = async value => {
    const code = source.replace(marker, `const embeddedBundledGstackJson = ${JSON.stringify(JSON.stringify(value))};`);
    return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  };
  const identity = (await load(valid)).readPackagedGstackIdentity();
  assert.ok(Object.isFrozen(identity) && Object.isFrozen(identity.skillIds) && Object.isFrozen(identity.target));
  for (const changes of [{ manifestChecksum: "untrusted" }, { adaptationRevision: "../escape" },
    { upstreamRevision: "main" }, { target: { platform: "darwin", arch: "unknown" } },
    { skillIds: [] }, { skillIds: new Array(57).fill("same") }, { skillIds: [...valid.skillIds.slice(1), "../escape"] }]) {
    assert.throws((await load({ ...valid, ...changes })).readPackagedGstackIdentity, /packaged_gstack_identity_invalid/);
  }
});
