import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("security runtime verification is a production native preparation gate", async () => {
  const { verifyGstackSecuritySidecarRuntime } = await import("./verify-security-sidecar-runtime.mjs");
  assert.equal(typeof verifyGstackSecuritySidecarRuntime, "function");
  const source = await readFile(new URL("./build-native-runtime.mjs", import.meta.url), "utf8");
  assert.match(source, /await verifyGstackSecuritySidecarRuntime\(/);
  assert.match(source, /browse\/dist\/security-sidecar-runtime-verification\.json/);
});

test("a remapped Transformers package export rejects before executing any interpreter", {
  skip: !process.env.LING_GSTACK_RESOURCE_ROOT && "Use managed supervision",
}, async t => {
  const { verifyGstackSecuritySidecarRuntime } = await import("./verify-security-sidecar-runtime.mjs");
  const work = await mkdtemp(join(tmpdir(), "ling security runtime export "));
  t.after(() => rm(work, { recursive: true, force: true }));
  const runtimeRoot = join(work, "runtime"), outputRoot = join(work, "output");
  await mkdir(join(runtimeRoot, "node_modules/@huggingface/transformers"), { recursive: true });
  await mkdir(outputRoot);
  const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const files = [];
  for (const [name, bytes] of [["package.json", "{}\n"], ["bun.lock", "{}\n"]]) {
    await writeFile(join(runtimeRoot, name), bytes);
    files.push({ path: `runtime/${name}`, sizeBytes: Buffer.byteLength(bytes), checksum: checksum(bytes) });
  }
  await writeFile(join(runtimeRoot, "node_modules/@huggingface/transformers/package.json"),
    JSON.stringify({ name: "@huggingface/transformers", type: "module", exports: { node: { import: { default: "./unreviewed.mjs" } } } }));
  const manifest = JSON.stringify({ upstream: { revision: "a".repeat(40) }, files });
  const sourceManifestPath = join(work, "manifest.json");
  await writeFile(sourceManifestPath, manifest);
  await assert.rejects(verifyGstackSecuritySidecarRuntime({ runtimeRoot, outputRoot, sourceManifestPath,
    expectedSourceManifestChecksum: checksum(manifest) }), /external_entry_invalid/);
  await assert.rejects(lstat(join(outputRoot, "browse")), { code: "ENOENT" });
});

test("security runtime verification rejects unpinned source and missing live lease before execution", async t => {
  const { verifyGstackSecuritySidecarRuntime } = await import("./verify-security-sidecar-runtime.mjs");
  const root = await mkdtemp(join(tmpdir(), "ling security runtime guard "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(verifyGstackSecuritySidecarRuntime({ runtimeRoot: root }), /source_identity_required/);
  const env = { ...process.env };
  try {
    delete process.env.LING_GSTACK_RESOURCE_ROOT;
    delete process.env.LING_GSTACK_RESOURCE_TOKEN;
    await assert.rejects(verifyGstackSecuritySidecarRuntime({ runtimeRoot: root,
      sourceManifestPath: join(root, "manifest.json"), expectedSourceManifestChecksum: `sha256:${"a".repeat(64)}` }), /lease_required/);
  } finally {
    for (const key of ["LING_GSTACK_RESOURCE_ROOT", "LING_GSTACK_RESOURCE_TOKEN"]) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
  }
});
