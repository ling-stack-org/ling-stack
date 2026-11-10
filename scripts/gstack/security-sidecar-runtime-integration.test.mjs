import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";
import { resourceTreeBytes } from "./resource-workspace.mjs";

const input = process.env.LING_GSTACK_RESOURCE_STAGE && resolve(process.env.LING_GSTACK_RESOURCE_STAGE);
const skip = !input && "Set the retained stage and use managed supervision";
const expectedSourceManifestChecksum = "sha256:2921f0cfd111004b078f33b50b91efb053e5d81a661f9fc9473c9ff0e2dcbf8d";

test("packaged Node imports the actual Transformers graph, runs native ONNX and sharp, without a model or dependency copy", { skip }, async t => {
  const { verifyGstackSecuritySidecarRuntime } = await import("./verify-security-sidecar-runtime.mjs");
  const work = await realpath(await mkdtemp(join(tmpdir(), "ling actual security runtime ")));
  t.after(() => rm(work, { recursive: true, force: true }));
  const runtimeRoot = join(input, "runtime"), outputRoot = join(work, "output");
  await mkdir(outputRoot);
  const options = { runtimeRoot, outputRoot, sourceManifestPath: join(input, "source-manifest.json"), expectedSourceManifestChecksum };
  await assert.rejects(verifyGstackSecuritySidecarRuntime({ ...options,
    expectedSourceManifestChecksum: `sha256:${"a".repeat(64)}` }), /source_manifest_mismatch/);
  await assert.rejects(verifyGstackSecuritySidecarRuntime({ ...options, outputRoot: runtimeRoot }), /output_not_private/);
  const alias = join(work, "runtime-alias");
  await symlink(runtimeRoot, alias);
  await assert.rejects(verifyGstackSecuritySidecarRuntime({ ...options, runtimeRoot: alias }), /root_invalid/);
  await rm(alias);
  const report = await verifyGstackSecuritySidecarRuntime(options);
  assert.equal(report.releaseEligible, false);
  assert.equal(report.upstreamRevision, "47d639abffa882b8cbb641d7d1dedf08ecada9ec");
  assert.deepEqual(report.observation.inference, { Y: [1.25, -3.5], type: "float32", dims: [2] });
  assert.deepEqual(report.observation.image, { format: "png", width: 2, height: 3, channels: 4 });
  assert.equal(report.observation.transformers.pipeline, "function");
  assert.equal(report.observation.permissions.fileWrites, false);
  assert.equal(report.observation.permissions.childProcesses, false);
  assert.equal(report.observation.networkAttempts, 0);
  assert.ok(report.observation.backends.some(backend => backend.name === "cpu"));
  assert.ok(report.observation.addons.some(path => path.endsWith("onnxruntime_binding.node")));
  assert.ok(report.observation.addons.some(path => /sharp-.*\.node$/.test(path)));
  assert.ok(report.observation.runtimeSharedObjects.some(path => /onnxruntime/.test(path)));
  assert.ok(report.observation.runtimeSharedObjects.some(path => /libvips/.test(path)));
  assert.equal(report.classifierModelInference, "pending");
  assert.equal(report.completeDynamicResourceClosure, "pending");
  assert.equal(report.modelDownloaded, false);
  assert.ok(report.inputs.length > 10);
  for (const file of report.inputs) {
    assert.deepEqual(await readGstackClosureFileRecord(join(runtimeRoot, file.path)), { sizeBytes: file.sizeBytes, checksum: file.checksum });
  }
  assert.ok(report.inputs.some(file => file.path.endsWith("@huggingface/transformers/dist/transformers.node.mjs")));
  assert.ok(report.inputs.some(file => file.path === "tools/node" || file.path === "tools/node.exe"));
  await assert.rejects(lstat(join(work, "node_modules")), { code: "ENOENT" });
  await assert.rejects(lstat(join(work, ".gstack/models")), { code: "ENOENT" });
  const artifact = join(outputRoot, "browse/dist/security-sidecar-runtime-verification.json");
  assert.deepEqual(JSON.parse(await readFile(artifact)), report);
  await assert.rejects(verifyGstackSecuritySidecarRuntime(options), /output_exists/);
  const peakScratchBytes = await resourceTreeBytes(work);
  assert.ok(peakScratchBytes < 1024 ** 2);
  const testInputs = [];
  for (const name of ["security-sidecar-runtime-integration.test.mjs", "security-sidecar-runtime.test.mjs",
    "build-native-runtime.mjs", "native-runtime-integration.test.mjs"]) {
    testInputs.push({ path: `scripts/gstack/${name}`, ...await readGstackClosureFileRecord(fileURLToPath(new URL(name, import.meta.url))) });
  }
  const proof = { schemaVersion: 1, releaseEligible: false, verificationScope: "actual-node-external-graph-and-native-prerequisites-only",
    report, testInputs, peakScratchBytes, cleanup: "complete" };
  await rm(work, { recursive: true, force: true });
  await assert.rejects(lstat(work), { code: "ENOENT" });
  if (process.env.LING_GSTACK_SECURITY_RUNTIME_PROOF_OUTPUT) {
    const output = resolve(process.env.LING_GSTACK_SECURITY_RUNTIME_PROOF_OUTPUT);
    assert.equal(output, join(process.env.LING_GSTACK_RESOURCE_ROOT, "artifacts/report/security-sidecar-runtime-proof.json"));
    const bytes = Buffer.from(`${JSON.stringify(proof, null, 2)}\n`);
    await writeFile(output, bytes, { flag: "wx" });
    t.diagnostic(JSON.stringify({ output, sizeBytes: bytes.length,
      checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, peakScratchBytes,
      loadedInputCount: report.inputs.length, addons: report.observation.addons }));
  }
});
