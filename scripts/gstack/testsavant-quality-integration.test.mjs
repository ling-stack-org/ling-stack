import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyTestsavantModel, testsavantArtifactName } from "./collect-testsavant-model.mjs";
import { verifyTestsavantExecutable } from "./testsavant-client.mjs";
import { summarizeTestsavantQuality, summarizeTestsavantOperations, testsavantQualityCorpus } from "./testsavant-quality.mjs";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";

const stage = process.env.LING_GSTACK_RESOURCE_STAGE;
test("original TestSavant runs the frozen bilingual corpus locally without altering weights or thresholds", {
  skip: !stage && "requires retained stage and managed external lease", timeout: 180000,
}, async t => {
  const runtime = join(stage, "runtime"), node = join(runtime, "tools/node");
  const model = join(process.env.LING_GSTACK_RESOURCE_ROOT, "artifacts/resource", testsavantArtifactName);
  await verifyTestsavantExecutable(node, "sha256:5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c");
  const before = await verifyTestsavantModel(model);
  const paths = ["testsavant-quality.mjs", "testsavant-quality-probe.mjs", "testsavant-quality-integration.test.mjs",
    "testsavant-quality-observer.mjs", "testsavant-runtime.mjs", "testsavant-offline-guard.mjs", "security-model-evaluation-corpus.mjs",
    "build-testsavant-component.mjs"];
  const inputRecords = () => Promise.all(paths.map(async path => ({ path,
    ...await readGstackClosureFileRecord(fileURLToPath(new URL(path, import.meta.url))) })));
  const inputs = await inputRecords();
  const work = await mkdtemp(join(tmpdir(), "ling-quality-combiner-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const component = join(work, "component");
  const build = spawnSync(join(runtime, "tools/bun"), ["--no-env-file", "--no-install",
    fileURLToPath(new URL("build-testsavant-component.mjs", import.meta.url)), runtime, component,
    join(stage, "source-manifest.json"), "sha256:2921f0cfd111004b078f33b50b91efb053e5d81a661f9fc9473c9ff0e2dcbf8d"], {
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" }, encoding: "utf8", timeout: 30000, maxBuffer: 1024 ** 2,
  });
  assert.equal(build.status, 0, build.stderr);
  const componentReport = JSON.parse(await readFile(join(component, "testsavant-component.json")));
  const parity = componentReport.artifacts.find(file => file.path === "testsavant-upstream-parity.mjs");
  assert.ok(parity);
  const executionPaths = [parity.path, "node_modules/@huggingface/transformers/package.json", "node_modules/@huggingface/transformers/index.mjs"];
  const executionRecords = () => Promise.all(executionPaths.map(async path => ({ path,
    ...await readGstackClosureFileRecord(join(component, path)) })));
  const executionInputs = await executionRecords();
  assert.equal(executionInputs[0].checksum, parity.checksum); assert.equal(executionInputs[0].sizeBytes, parity.sizeBytes);
  const run = spawnSync(node, ["--max-old-space-size=512", fileURLToPath(new URL("testsavant-quality-probe.mjs", import.meta.url)),
    runtime, model, join(component, "testsavant-upstream-parity.mjs")], {
    env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PATH: "/no-system-node" },
    encoding: "utf8", timeout: 150000, maxBuffer: 1024 ** 2,
  });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.rows.length, testsavantQualityCorpus.length);
  assert.deepEqual(summarizeTestsavantQuality(report.rows), report.summary, "independently recompute every quality count and criterion");
  assert.deepEqual(summarizeTestsavantOperations(report.rows), report.operational);
  assert.equal(report.upstreamThresholds.SOLO_CONTENT_BLOCK, 0.92);
  assert.equal(report.upstreamThresholds.WARN, 0.75); assert.equal(report.upstreamThresholds.LOG_ONLY, 0.4);
  for (const [expected, count] of [["SAFE", 18], ["INJECTION", 20]]) {
    assert.equal(Object.values(report.operational.byExpected[expected]).reduce((a, b) => a + b), count);
  }
  assert.deepEqual(await executionRecords(), executionInputs);
  assert.equal(report.networkAttempts, 0);
  assert.equal(report.summary.representativeQualityAccepted, false);
  assert.deepEqual(await verifyTestsavantModel(model), before);
  assert.deepEqual(await inputRecords(), inputs);
  assert.ok(report.observedDependencies.inputs.some(file => file.path.endsWith("transformers.node.mjs")));
  assert.ok(report.observedDependencies.addons.some(path => path.endsWith("onnxruntime_binding.node")));
  assert.ok(report.observedDependencies.sharedObjects.some(path => /onnxruntime/.test(path)));
  for (const { path, ...record } of report.observedDependencies.inputs) {
    assert.ok(!path.startsWith("/") && !path.split(/[\\/]/).includes(".."));
    assert.deepEqual(await readGstackClosureFileRecord(join(runtime, path)), record);
  }
  const proof = { ...report, componentReport, executionInputs, inputs, model: before, node: await readGstackClosureFileRecord(node),
    corpusChecksum: `sha256:${createHash("sha256").update(JSON.stringify(testsavantQualityCorpus)).digest("hex")}`,
    scope: "local-synthetic-quality-measurement-not-client-or-representative-acceptance" };
  await writeFile(join(process.env.LING_GSTACK_RESOURCE_ROOT, "artifacts/report/testsavant-quality-proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
  t.diagnostic(JSON.stringify(report.summary));
});
