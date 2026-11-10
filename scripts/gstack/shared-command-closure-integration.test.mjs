import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { verifyGstackBundledBuildImports, verifyGstackClientCommandImports, verifyGstackSharedCommandClosure } from "./verify-shared-command-closure.mjs";

const stage = process.env.LING_GSTACK_RESOURCE_STAGE ? resolve(process.env.LING_GSTACK_RESOURCE_STAGE) : undefined;
const skip = !stage && "Set LING_GSTACK_RESOURCE_STAGE to a reviewed local prerequisite stage";
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const reviewed = JSON.parse(await readFile(new URL("./reviewed-source-bundle.json", import.meta.url), "utf8"));

test("actual client command imports retain optional API judge and external Claude command without paid-test roots", { skip }, async () => {
  const nativeBytes = await readFile(join(stage, "native-build.json"));
  assert.equal(checksum(nativeBytes), "sha256:65eb00f9b33dffaa561804ae47e0207f9005b9b1e9c9c0ccf04078c3b5c61964");
  const native = JSON.parse(nativeBytes), bun = native.components.find(component => component.path === "runtime/tools/bun");
  const report = await verifyGstackClientCommandImports({ runtimeRoot: join(stage, "runtime"), bunPath: join(stage, bun.path),
    expectedBunChecksum: bun.checksum, expectedSourceManifestChecksum: reviewed.manifestChecksum });
  assert.equal(report.upstreamRevision, reviewed.upstreamRevision);
  assert.equal(report.dependencyScope, "client-command-imports");
  assert.equal(report.runtimeResourceSelection, "pending");
  assert.equal(report.dynamicPaidEntrypoints, 0);
  assert.equal(report.unselectedSelfTestEntrypoints.length, 108);
  assert.deepEqual(report.dynamicChildEntrypoints, []);
  assert.deepEqual(report.entrypoints.slice(0, 3), ["bin/gstack-model-benchmark", "scripts/ship-measure.ts", "bin/gstack-claude-code"]);
  assert.equal(report.bunCommandCount, 57);
  assert.equal(report.entrypoints.length, 58);
  assert.equal(report.inputs.length, 274);
  for (const path of ["bin/gstack-artifact", "bin/gstack-docs-candidate", "bin/gstack-gbrain-detect", "bin/gstack-autoplan-snapshot.ts"]) {
    assert.ok(report.entrypoints.includes(path), path);
  }
  for (const path of ["lib/claude-code.ts", "lib/claude-bin.ts", "test/helpers/benchmark-judge.ts",
    "test/helpers/benchmark-runner.ts", "node_modules/@anthropic-ai/sdk/index.mjs"]) {
    assert.ok(report.inputs.some(input => input.path === path), path);
  }
  assert.equal(report.inputs.some(input => input.path.includes("@anthropic-ai/claude-agent-sdk")), false);
  assert.equal(report.dynamicResources.length, 7);
  assert.equal(report.releaseEligible, false);
  assert.ok(report.pendingGates.includes("complete-client-runtime-resource-selection"));
});

test("actual bundled build graphs retain native HTML and diagram packages even when their npm trees may later be excluded", { skip }, async () => {
  const bytes = await readFile(join(stage, "native-build.json"));
  assert.equal(checksum(bytes), "sha256:65eb00f9b33dffaa561804ae47e0207f9005b9b1e9c9c0ccf04078c3b5c61964");
  const native = JSON.parse(bytes), bun = native.components.find(component => component.path === "runtime/tools/bun");
  const reports = await verifyGstackBundledBuildImports({ runtimeRoot: join(stage, "runtime"), bunPath: join(stage, bun.path),
    expectedBunChecksum: bun.checksum, expectedSourceManifestChecksum: reviewed.manifestChecksum });
  assert.deepEqual(reports.map(report => report.dependencyScope), ["native-build-imports", "node-browser-build-imports", "diagram-build-imports", "security-sidecar-build-imports"]);
  assert.deepEqual(reports.map(report => report.entrypoints.length), [6, 1, 1, 1]);
  assert.ok(reports[3].inputs.some(input => input.path === "browse/src/security-classifier.ts"));
  assert.deepEqual(reports[3].externalSpecifiers, ["@huggingface/transformers"]);
  assert.equal(reports[0].inputs.length, 416);
  assert.equal(reports[2].inputs.length, 982);
  assert.ok(reports[0].inputs.some(input => input.path === "node_modules/html-to-vdom/index.js"));
  assert.ok(reports[2].inputs.some(input => input.path === "lib/diagram-render/node_modules/react-remove-scroll-bar/dist/es2015/index.js"));
  for (const report of reports) {
    assert.equal(report.releaseEligible, false);
    assert.equal(report.compiledArtifactBinding, "pending");
    assert.equal(report.inputs.some(input => input.path.includes("@anthropic-ai/claude-agent-sdk")), false);
  }
});

test("pinned actual shared commands and every dynamically selected paid file compile offline without running paid providers", { skip }, async () => {
  const nativeBytes = await readFile(join(stage, "native-build.json"));
  assert.equal(checksum(nativeBytes), "sha256:65eb00f9b33dffaa561804ae47e0207f9005b9b1e9c9c0ccf04078c3b5c61964");
  const native = JSON.parse(nativeBytes), runtime = join(stage, "runtime");
  const bun = native.components.find(component => component.path === "runtime/tools/bun");
  const report = await verifyGstackSharedCommandClosure({ runtimeRoot: runtime, bunPath: join(stage, bun.path),
    expectedBunChecksum: bun.checksum, expectedSourceManifestChecksum: reviewed.manifestChecksum });
  assert.equal(report.upstreamRevision, reviewed.upstreamRevision);
  assert.equal(report.dependencyScope, "upstream-validation");
  assert.equal(report.compilerVersion, "1.4.2");
  assert.equal(report.dynamicPaidEntrypoints, 108);
  assert.equal(report.entrypoints.length, 111);
  assert.deepEqual(report.dynamicChildEntrypoints, ["scripts/test-paid-shards.ts"]);
  assert.equal(report.inputs.length, 500);
  assert.ok(report.inputs.some(input => input.path === "test/helpers/benchmark-runner.ts"));
  assert.ok(report.inputs.some(input => input.path === "test/helpers/benchmark-judge.ts"));
  assert.ok(report.inputs.some(input => input.path === "test/helpers/agent-sdk-runner.ts"));
  assert.ok(report.inputs.some(input => input.path === "node_modules/@anthropic-ai/sdk/index.mjs"));
  assert.ok(report.inputs.some(input => input.path === "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"));
  assert.equal(report.dynamicResources.length, 7);
  assert.deepEqual(report.dynamicResources.map(input => input.path), ["bin/gstack-config", "browse/scripts/build-node-server.sh",
    "scripts/free-test-durations.json", "scripts/paid-test-durations.json", "scripts/ubicloud/setup-free-suite.sh",
    "scripts/ubicloud/test-free.sh", "scripts/ubicloud/ubi-runner.sh"]);
  for (const input of report.dynamicResources) {
    const bytes = await readFile(join(runtime, input.path));
    assert.equal(checksum(bytes), input.checksum, input.path);
    assert.equal(bytes.length, input.sizeBytes, input.path);
    assert.equal(checksum(await readFile(join(runtime, input.consumerPath))), input.consumerChecksum, input.consumerPath);
  }
  assert.equal(report.dynamicResourceGraphChecksum, "sha256:a1d36a18fb8a9bafa8a72cb5ce89d33dd8d222153a5c1dc20de728a63de4c95f");
  assert.equal(report.releaseEligible, false);
  assert.equal(report.packageAcceptance, "pending");
  assert.ok(report.pendingGates.includes("shell-and-dynamic-resource-closure"));
  assert.ok(report.pendingGates.includes("real-skill-execution"));
});
