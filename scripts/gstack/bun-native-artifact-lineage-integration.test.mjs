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
const expectedSource = "sha256:2921f0cfd111004b078f33b50b91efb053e5d81a661f9fc9473c9ff0e2dcbf8d";
const expectedNative = "sha256:65eb00f9b33dffaa561804ae47e0207f9005b9b1e9c9c0ccf04078c3b5c61964";
const expectedResource = "sha256:ab63d645623de138a7bec3b0cf4a58271fadf6f25b907b1c313ae314e38d818b";
const expectedCompiler = "sha256:35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5";

test("five frozen native commands reproduce retained executable bytes one at a time without copying the runtime or executing commands", { skip }, async t => {
  const work = await realpath(await mkdtemp(join(tmpdir(), "ling real native artifacts ")));
  t.after(() => rm(work, { recursive: true, force: true }));
  const output = join(work, "output");
  await mkdir(output);
  const runtime = join(input, "runtime"), compiler = join(runtime, "tools/bun"), node = join(runtime, "tools/node");
  const protectedFiles = [["source-manifest.json", expectedSource], ["native-build.json", expectedNative],
    ["resource-stage.json", expectedResource], ["runtime/tools/bun", expectedCompiler]];
  for (const [path, expected] of protectedFiles) assert.equal((await readGstackClosureFileRecord(join(input, path))).checksum, expected);
  const native = JSON.parse(await readFile(join(input, "native-build.json")));
  const env = buildEnvironment({ bunPath: compiler, nodePath: node, home: work, temporary: tmpdir() });
  for (const key of ["LING_GSTACK_RESOURCE_ROOT", "LING_GSTACK_RESOURCE_TOKEN"]) env[key] = process.env[key];
  const script = fileURLToPath(new URL("./build-bun-native-resource.mjs", import.meta.url));
  const reports = [];
  let peakScratchBytes = 0;
  for (const [kind, path] of [["browse", "browse/dist/browse"], ["find-browse", "browse/dist/find-browse"],
    ["design", "design/dist/design"], ["pdf", "make-pdf/dist/pdf"], ["global-discover", "bin/gstack-global-discover"]]) {
    const result = spawnSync(compiler, ["--no-env-file", "--no-install", script, kind, runtime, output], {
      cwd: runtime, env, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 ** 2,
    });
    assert.equal(result.status, 0, `${kind}: ${result.stderr}`);
    const reportPath = join(output, `${path}.build-provenance.json`), report = JSON.parse(await readFile(reportPath));
    assert.equal(report.sourceManifestChecksum, expectedSource);
    assert.equal(report.compiler.checksum, expectedCompiler);
    assert.equal(report.compiledArtifactBinding, "repeated-native-compilation-and-emitted-byte-identity");
    assert.equal(report.releaseEligible, false);
    const expected = native.components.find(component => component.path === `runtime/${path}`);
    assert.ok(expected, kind);
    assert.equal(report.artifact.checksum, expected.checksum, kind);
    assert.equal(report.artifact.sizeBytes, expected.sizeBytes, kind);
    assert.equal((await readGstackClosureFileRecord(join(output, path))).checksum, expected.checksum);
    assert.equal((await readGstackClosureFileRecord(join(runtime, path))).checksum, expected.checksum);
    for (const source of report.inputs) {
      const actual = await readGstackClosureFileRecord(join(runtime, source.path));
      assert.equal(actual.checksum, source.checksum);
      assert.equal(actual.sizeBytes, source.sizeBytes);
    }
    peakScratchBytes = Math.max(peakScratchBytes, report.compileScratchPeakBytes, await resourceTreeBytes(work));
    assert.ok(peakScratchBytes < 256 * 1024 ** 2);
    reports.push(report);
    // Keep only compact evidence between commands, never five 60 MiB binaries.
    await rm(join(output, path));
    await rm(reportPath);
    await resourceCheckpoint(process.env.LING_GSTACK_RESOURCE_ROOT);
  }
  for (const [path, expected] of protectedFiles) assert.equal((await readGstackClosureFileRecord(join(input, path))).checksum, expected);
  const testInputs = [];
  for (const path of ["bun-native-artifact-lineage.test.mjs", "bun-native-artifact-lineage-integration.test.mjs", "native-runtime-integration.test.mjs"]) {
    testInputs.push({ path: `scripts/gstack/${path}`, ...await readGstackClosureFileRecord(fileURLToPath(new URL(path, import.meta.url))) });
  }
  const proof = { schemaVersion: 1, deliveryStage: "compiled-resource-prerequisites", releaseEligible: false,
    verificationScope: "five-frozen-bun-native-executable-byte-identities-only", retainedResourceChecksum: expectedResource,
    nativeReceiptChecksum: expectedNative, reports, testInputs, peakScratchBytes,
    commandExecution: "not-run", completeNativeBuild: "pending", completeResourcePreparation: "pending", cleanup: "pending" };
  await rm(work, { recursive: true, force: true });
  await assert.rejects(lstat(work), { code: "ENOENT" });
  proof.cleanup = "complete";
  if (process.env.LING_GSTACK_BUN_NATIVE_LINEAGE_PROOF_OUTPUT) {
    const path = resolve(process.env.LING_GSTACK_BUN_NATIVE_LINEAGE_PROOF_OUTPUT);
    assert.equal(path, join(process.env.LING_GSTACK_RESOURCE_ROOT, "artifacts/report/bun-native-artifact-lineage-proof.json"));
    const bytes = Buffer.from(`${JSON.stringify(proof, null, 2)}\n`);
    await writeFile(path, bytes, { flag: "wx" });
    t.diagnostic(JSON.stringify({ proofPath: path, sizeBytes: bytes.length, checksum: hash(bytes),
      inputCounts: reports.map(report => report.inputs.length), peakScratchBytes, cleanup: proof.cleanup }));
  }
});
