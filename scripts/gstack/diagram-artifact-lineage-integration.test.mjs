import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildEnvironment } from "./build-native-runtime.mjs";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";
import { resourceCheckpoint, resourceTreeBytes } from "./resource-workspace.mjs";

const input = process.env.LING_GSTACK_RESOURCE_STAGE && resolve(process.env.LING_GSTACK_RESOURCE_STAGE);
const skip = !input && "Set the retained resource stage and use managed supervision";
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const base = "lib/diagram-render";
const expectedSource = "sha256:2921f0cfd111004b078f33b50b91efb053e5d81a661f9fc9473c9ff0e2dcbf8d";
const expectedNative = "sha256:65eb00f9b33dffaa561804ae47e0207f9005b9b1e9c9c0ccf04078c3b5c61964";
const expectedResource = "sha256:ab63d645623de138a7bec3b0cf4a58271fadf6f25b907b1c313ae314e38d818b";
const expectedCompiler = "sha256:35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5";

test("frozen diagram dependencies reproduce the retained HTML and BUILD_INFO without copying or mutating the runtime", { skip }, async t => {
  const work = await realpath(await mkdtemp(join(tmpdir(), "ling real diagram artifact ")));
  t.after(() => rm(work, { recursive: true, force: true }));
  const output = join(work, "output");
  await mkdir(output);
  const runtime = join(input, "runtime"), compiler = join(runtime, "tools/bun"), node = join(runtime, "tools/node");
  const protectedFiles = [
    ["source-manifest.json", expectedSource], ["native-build.json", expectedNative], ["resource-stage.json", expectedResource],
    ["runtime/tools/bun", expectedCompiler],
  ];
  for (const [path, expected] of protectedFiles) assert.equal((await readGstackClosureFileRecord(join(input, path))).checksum, expected);
  const native = JSON.parse(await readFile(join(input, "native-build.json")));
  const env = buildEnvironment({ bunPath: compiler, nodePath: node, home: work, temporary: tmpdir() });
  for (const key of ["LING_GSTACK_RESOURCE_ROOT", "LING_GSTACK_RESOURCE_TOKEN"]) env[key] = process.env[key];
  const script = fileURLToPath(new URL("./build-portable-resources.ts", import.meta.url));
  const result = spawnSync(compiler, ["--no-env-file", "--no-install", script, "diagram", runtime, output], {
    cwd: join(runtime, base), env, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 ** 2,
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(join(output, base, "dist/diagram-build-provenance.json")));
  assert.equal(report.sourceManifestChecksum, expectedSource);
  assert.equal(report.compiler.checksum, expectedCompiler);
  assert.equal(report.compiledArtifactBinding, "repeated-upstream-assembly-and-emitted-byte-identity");
  assert.equal(report.releaseEligible, false);
  assert.ok(report.inputs.length >= 982);
  for (const artifact of report.artifacts) {
    const before = native.components.find(component => component.path === `runtime/${artifact.path}`);
    assert.ok(before, artifact.path);
    assert.equal(artifact.checksum, before.checksum, artifact.path);
    assert.equal(artifact.sizeBytes, before.sizeBytes, artifact.path);
    assert.equal((await readGstackClosureFileRecord(join(runtime, artifact.path))).checksum, before.checksum);
    assert.equal((await readGstackClosureFileRecord(join(output, artifact.path))).checksum, before.checksum);
  }
  const html = await readFile(join(output, base, "dist/diagram-render.html"));
  const info = JSON.parse(await readFile(join(output, base, "dist/BUILD_INFO.json")));
  assert.equal(`sha256:${info.sha256}`, hash(html));
  assert.equal(info.bytes, html.length);
  const fingerprint = createHash("sha256").update(await readFile(join(runtime, base, "src/entry.ts")))
    .update(await readFile(join(runtime, base, "scripts/build.ts"))).digest("hex");
  assert.equal(info.srcSha256, fingerprint);
  assert.deepEqual(info.deps, JSON.parse(await readFile(join(runtime, base, "package.json"))).dependencies);
  for (const source of report.inputs) {
    const actual = await readGstackClosureFileRecord(join(runtime, source.path));
    assert.equal(actual.checksum, source.checksum);
    assert.equal(actual.sizeBytes, source.sizeBytes);
  }
  for (const [path, expected] of protectedFiles) assert.equal((await readGstackClosureFileRecord(join(input, path))).checksum, expected);
  const peakScratchBytes = await resourceTreeBytes(work);
  assert.ok(peakScratchBytes < 64 * 1024 ** 2);
  await resourceCheckpoint(process.env.LING_GSTACK_RESOURCE_ROOT);
  const testInputs = [];
  for (const path of ["diagram-artifact-lineage-integration.test.mjs", "diagram-artifact-lineage.test.mjs", "build-native-runtime.mjs", "native-runtime-integration.test.mjs"]) {
    testInputs.push({ path: `scripts/gstack/${path}`, ...await readGstackClosureFileRecord(fileURLToPath(new URL(path, import.meta.url))) });
  }
  const proof = { schemaVersion: 1, deliveryStage: "compiled-resource-prerequisites", releaseEligible: false,
    verificationScope: "frozen-diagram-html-and-build-info-byte-identity-only", retainedResourceChecksum: expectedResource,
    nativeReceiptChecksum: expectedNative, report, testInputs, peakScratchBytes,
    rendererExecution: "not-run", completeNativeBuild: "pending", completeResourcePreparation: "pending", cleanup: "pending" };
  await rm(work, { recursive: true, force: true });
  await assert.rejects(lstat(work), { code: "ENOENT" });
  proof.cleanup = "complete";
  if (process.env.LING_GSTACK_DIAGRAM_LINEAGE_PROOF_OUTPUT) {
    const outputPath = resolve(process.env.LING_GSTACK_DIAGRAM_LINEAGE_PROOF_OUTPUT);
    assert.equal(outputPath, join(process.env.LING_GSTACK_RESOURCE_ROOT, "artifacts/report/diagram-artifact-lineage-proof.json"));
    const bytes = Buffer.from(`${JSON.stringify(proof, null, 2)}\n`);
    await writeFile(outputPath, bytes, { flag: "wx" });
    t.diagnostic(JSON.stringify({ proofPath: outputPath, sizeBytes: bytes.length, checksum: hash(bytes),
      inputCount: report.inputs.length, peakScratchBytes, cleanup: proof.cleanup }));
  }
});
