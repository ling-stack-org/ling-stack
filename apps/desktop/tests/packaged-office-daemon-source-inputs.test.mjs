import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS } from "../../../packages/daemon/src/runtime/sandbox/packaged-office-native-published-review.ts";
import { PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS } from "../scripts/packaged-office-native-review-inputs.mjs";

const repositoryRoot = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
const workspaceNames = ["browser-host", "contracts", "core", "daemon", "localization", "plugin-sdk", "providers", "remote-protocol", "runner-pi"];
const reviewedLeaf = "packages/core/src/original-office-host-bridge.ts";
const compiledLeaf = "packages/core/dist/original-office-host-bridge.js";
const newAuthoredRuntimeLeaves = [
  "packages/daemon/src/features/channels/file-request-content.ts",
  "packages/browser-host/src/descriptor-coordination.ts",
  "packages/daemon/src/features/browser-extension/native-broker-shutdown.ts",
  "packages/core/src/automation-recurrence.ts",
  "packages/daemon/src/features/automations/recurrence.ts",
  "packages/core/src/run-progress-checkpoint-types.ts",
  "packages/core/src/run-progress-checkpoint-lineage.ts",
  "packages/core/src/storage/sqlite/run-progress-checkpoint-effects.ts",
  "packages/core/src/storage/sqlite/run-progress-checkpoint-migration.ts",
  "packages/core/src/storage/sqlite/run-progress-checkpoint-store.ts",
  "packages/daemon/src/features/harness/continuations/run-ordinary-progress.ts",
  "packages/daemon/src/shared/public-http-transport.ts",
  "packages/runner-pi/src/ordinary-progress-recovery.ts",
  "packages/runner-pi/src/provider-request-auth.ts",
  "packages/runner-pi/src/session-continuation.ts",
  "packages/runner-pi/src/session-transcript.ts",
  "packages/core/src/storage/sqlite/delegation-migration.ts",
  "packages/core/src/storage/sqlite/delegation-mappers.ts",
  "packages/core/src/storage/sqlite/delegation-store.ts",
  "packages/core/src/storage/sqlite/harness-diagnostics-mappers.ts",
  "packages/core/src/storage/sqlite/harness-diagnostics-store.ts",
  "packages/core/src/storage/sqlite/harness-diagnostics-validation.ts",
  "packages/daemon/src/runtime/harness-diagnostics.ts",
  "packages/core/src/storage/sqlite/mcp-metadata-migration.ts",
  "packages/core/src/storage/sqlite/mcp-metadata-publication-store.ts",
  "packages/daemon/src/features/mcp/metadata-publication.ts",
  "packages/core/src/storage/sqlite/provider-check-migration.ts",
  "packages/core/src/storage/sqlite/provider-check-publication-store.ts",
  "packages/daemon/src/features/providers/check-publication.ts",
  "packages/daemon/src/features/providers/model-discovery-authority.ts",
  "packages/core/src/provider-runtime-availability-types.ts",
  "packages/core/src/storage/sqlite/availability-incident-provenance-migration.ts",
  "packages/core/src/storage/sqlite/availability-incident-provenance-store.ts",
  "packages/core/src/storage/sqlite/availability-incident-source.ts",
  "packages/daemon/src/features/providers/runtime-failure-observations.ts",
  "packages/daemon/src/features/providers/runtime-invocations.ts",
  "packages/daemon/src/features/providers/runtime-observation-scope.ts",
  "packages/daemon/src/features/runs/provider-persistence.ts",
  "packages/daemon/src/features/runs/tool-context-budget.ts",
  "packages/runner-pi/src/provider-invocation.ts",
  "packages/core/src/harness/evaluation-tasks.ts",
  "packages/core/src/storage/sqlite/run-evaluation-task-validation.ts",
  "packages/core/src/storage/sqlite/run-evaluation-task-mappers.ts",
  "packages/core/src/storage/sqlite/run-evaluation-task-migration.ts",
  "packages/core/src/storage/sqlite/run-evaluation-task-store.ts",
  "packages/daemon/src/features/harness/evaluations/task-worker-input.ts",
  "packages/daemon/src/features/harness/evaluations/task-worker-prepared.ts",
  "packages/daemon/src/features/harness/evaluations/task-worker.ts",
  "packages/core/src/harness/evaluation-qa.ts",
  "packages/core/src/storage/sqlite/run-evaluation-qa-validation.ts",
  "packages/core/src/storage/sqlite/run-evaluation-qa-mappers.ts",
  "packages/core/src/storage/sqlite/run-evaluation-qa-migration.ts",
  "packages/core/src/storage/sqlite/run-evaluation-qa-store.ts",
  "packages/daemon/src/features/harness/evaluations/qa-model-json.ts",
  "packages/daemon/src/features/harness/evaluations/qa-model-preparation.ts",
  "packages/daemon/src/features/harness/evaluations/qa-model-owned-batch.ts",
  "packages/daemon/src/features/harness/evaluations/qa-model-transport.ts",
  "packages/daemon/src/features/harness/evaluations/qa-model-coordinator.ts",
  "packages/core/src/harness/human-evaluation.ts",
  "packages/core/src/storage/sqlite/run-evaluation-human-mappers.ts",
  "packages/core/src/storage/sqlite/run-evaluation-human-migration.ts",
  "packages/core/src/storage/sqlite/run-evaluation-human-store.ts",
  "packages/core/src/storage/sqlite/run-evaluation-human-validation.ts",
  "packages/core/src/storage/sqlite/run-evaluation-human-read-store.ts",
  "packages/core/src/storage/sqlite/run-evaluation-human-read-validation.ts",
  "packages/daemon/src/features/harness/evaluations/human-evaluation-authority.ts",
  "packages/daemon/src/features/harness/evaluations/human-evaluation-protocol.ts",
  "packages/daemon/src/features/harness/evaluations/human-evaluation-routes.ts",
  "packages/daemon/src/features/harness/evaluations/human-evaluation-service.ts",
  "packages/daemon/src/features/harness/evaluations/human-evaluation-report.ts",
];
// This contract is exported with `export type *`; esbuild correctly erases it.
// It remains an explicit reviewed source and gets every fail-closed check below.
const newAuthoredTypeOnlyInputs = ["packages/contracts/src/harness-evaluation-qa.ts", "packages/contracts/src/harness-human-evaluation.ts",
  "packages/contracts/src/harness-human-evaluation-read.ts", "packages/core/src/harness/human-evaluation-read.ts"];
const reviewedNativeInputs = ["apps/desktop/scripts/build-human-evaluation-helper.mjs", "apps/desktop/scripts/native/human-evaluation-darwin.swift"];
const newAuthoredRequiredInputs = [...newAuthoredRuntimeLeaves, ...newAuthoredTypeOnlyInputs, ...reviewedNativeInputs];
const staleSentinel = "__LING_EXPLICIT_STALE_DIST_RED__";
const authoredSentinel = "__LING_EXPLICIT_REVIEWED_AUTHORED_SOURCE_GREEN__";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function newFile(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600 });
}

test("Office packaging review requires every new browser lifecycle, Pi, progress, transport, delegation, diagnostics, Provider and evaluation task/QA authored source", () => {
  for (const name of newAuthoredRequiredInputs) {
    assert.equal(PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS.includes(name), true,
      `Runtime leaf must be an explicit required review input: ${name}`);
  }
});

test("Office fixed fresh daemon must not consume a stale compiled bridge with unchanged reviewed TS (real esbuild, synthetic native only)", {
  skip: process.platform !== "darwin" || process.arch !== "arm64",
}, async t => {
  const f = await approvedSyntheticFixture(t);
  const baseline = await f.bundle();
  assert.equal(baseline.bytes.includes(staleSentinel), false);
  assert.equal(baseline.pins.evidenceKind, "original_emitted_cli_byte_pins_only");
  const authoredBefore = readFileSync(join(f.root, reviewedLeaf));
  const reviewBefore = readFileSync(f.reviewPath);
  const originalCompiled = readFileSync(join(f.root, compiledLeaf));
  assert.equal(originalCompiled.length > 0, true);
  // Only this disposable generated leaf changes. Preserve every original JS
  // export/import and the fixed reviewed TS/approval row, including their hash.
  writeFileSync(join(f.root, compiledLeaf), Buffer.concat([
    Buffer.from(`globalThis.${staleSentinel} = true;\n`), originalCompiled,
  ]));
  assert.deepEqual(readFileSync(join(f.root, reviewedLeaf)), authoredBefore);
  assert.deepEqual(readFileSync(f.reviewPath), reviewBefore);
  assert.equal(f.reviewApi.readReviewedPackagedOfficeSource().sourceReviewSha256, hash(reviewBefore));
  const changed = await f.bundle();
  assert.deepEqual(readFileSync(join(f.root, reviewedLeaf)), authoredBefore);
  assert.deepEqual(readFileSync(f.reviewPath), reviewBefore);
  assert.equal(changed.pins.sha256, hash(changed.bytes));
  assert.equal(changed.pins.sizeBytes, changed.bytes.length);
  t.diagnostic(JSON.stringify({
    simulation: "native compiler/codesign only; esbuild and fixed fresh daemon/publication APIs are real",
    fixtureOnly: true, artifactExecuted: false,
    authoredSha256: hash(authoredBefore), unchangedReviewSha256: hash(reviewBefore),
    originalCompiledSha256: hash(originalCompiled), mutatedCompiledSha256: hash(readFileSync(join(f.root, compiledLeaf))),
    baselineBundleSha256: baseline.pins.sha256, changedBundleSha256: changed.pins.sha256,
    changedBundleSizeBytes: changed.bytes.length, staleSentinelInOriginalEmittedCli: changed.bytes.includes(staleSentinel),
    nativeCompilerCalls: f.counts.nativeCompilerCalls, signCalls: f.counts.signCalls,
    nativeVerifyCalls: f.counts.nativeVerifyCalls, helperNormalizeCalls: f.counts.helperNormalizeCalls,
  }));
  // The saved original RED reached real esbuild and granted original pins yet
  // carried this side effect. The same semantic assertion must now be GREEN.
  assert.equal(changed.bytes.includes(staleSentinel), false,
    "Unchanged reviewed authored TS must not authorize an added workspace dist runtime side effect");
  const baselineSource = assertOriginalSourceOnlyBuild(f, baseline, 0);
  const changedSource = assertOriginalSourceOnlyBuild(f, changed, 1);
  assert.equal(changedSource.reviewedBridgeSha256, baselineSource.reviewedBridgeSha256);
  t.diagnostic(JSON.stringify({ realEsbuildSourceAudit: { baseline: baselineSource, changed: changedSource } }));
});

test("Office fixed fresh daemon consumes an explicitly reviewed authored bridge change, not unchanged dist (real esbuild, synthetic native only)", {
  skip: process.platform !== "darwin" || process.arch !== "arm64",
}, async t => {
  const f = await approvedSyntheticFixture(t);
  const compiledBefore = readFileSync(join(f.root, compiledLeaf));
  const authored = Buffer.concat([Buffer.from(`globalThis.${authoredSentinel} = true;\n`), readFileSync(join(f.root, reviewedLeaf))]);
  writeFileSync(join(f.root, reviewedLeaf), authored);
  // This is a new, explicit disposable fixture review of these authored bytes,
  // never a production approval refresh. The stale-dist test above does not do it.
  const explicitFixtureReview = JSON.parse(readFileSync(f.reviewPath, "utf8"));
  explicitFixtureReview.packagingSha256[reviewedLeaf] = hash(authored);
  writeFileSync(f.reviewPath, JSON.stringify(explicitFixtureReview));
  const bundle = await f.bundle();
  assert.deepEqual(readFileSync(join(f.root, compiledLeaf)), compiledBefore);
  assert.equal(compiledBefore.includes(authoredSentinel), false);
  assert.equal(bundle.bytes.includes(authoredSentinel), true,
    "A real original bundle must consume the explicitly reviewed authored side effect");
  const sourceAudit = assertOriginalSourceOnlyBuild(f, bundle, 0);
  assert.equal(sourceAudit.reviewedBridgeSha256, hash(authored));
  t.diagnostic(JSON.stringify({ fixtureOnly: true, artifactExecuted: false, reviewedAuthoredSentinelInOriginalEmittedCli: true,
    unchangedCompiledSha256: hash(compiledBefore), originalBundleSha256: bundle.pins.sha256,
    explicitFixtureReviewSha256: hash(readFileSync(f.reviewPath)), realEsbuildSourceAudit: sourceAudit }));
});

test("Office fixed fresh daemon rejects missing review digests, changed authored bytes and missing new runtime sources before any build (synthetic native only)", {
  skip: process.platform !== "darwin" || process.arch !== "arm64",
}, async t => {
  const f = await approvedSyntheticFixture(t);
  const originalReview = readFileSync(f.reviewPath);
  assert.equal(f.reviewApi.readReviewedPackagedOfficeSource().sourceReviewSha256, hash(originalReview));
  for (const name of newAuthoredRequiredInputs) {
    await t.test(name, async t => {
      const sourcePath = join(f.root, name), authoredBefore = readFileSync(sourcePath);
      // Native/compiler-script inputs are reviewed source, not a daemon dist leaf.
      const distPath = reviewedNativeInputs.includes(name) ? undefined
        : join(f.root, name.replace("/src/", "/dist/").replace(/\.ts$/u, ".js"));
      const compiledBefore = distPath ? readFileSync(distPath) : undefined;
      if (compiledBefore) assert.ok(compiledBefore.length > 0, "the stale generated leaf must exist throughout the rejection checks");
      await t.test("missing required review digest", async () => {
        const review = JSON.parse(originalReview.toString("utf8"));
        delete review.packagingSha256[name];
        const incompleteReview = Buffer.from(JSON.stringify(review));
        writeFileSync(f.reviewPath, incompleteReview);
        try {
          await assert.rejects(f.bundle(), /packaged_office_native_source_review_invalid/u);
          assert.deepEqual(readFileSync(f.reviewPath), incompleteReview);
          assert.deepEqual(readFileSync(sourcePath), authoredBefore);
          assertNoBuild(f);
        } finally { writeFileSync(f.reviewPath, originalReview); }
      });
      await t.test("authored mutation with unchanged review", async () => {
        const changed = Buffer.concat([Buffer.from("// EXPLICIT TEST-ONLY UNREVIEWED RUNTIME LEAF\n"), authoredBefore]);
        writeFileSync(sourcePath, changed);
        try {
          await assert.rejects(f.bundle(), /packaged_office_native_source_review_invalid/u);
          assert.deepEqual(readFileSync(f.reviewPath), originalReview);
          assert.deepEqual(readFileSync(sourcePath), changed);
          assertNoBuild(f);
        } finally { writeFileSync(sourcePath, authoredBefore); }
      });
      await t.test("missing authored source cannot fall back to existing dist", async () => {
        rmSync(sourcePath); // This exact path is inside the disposable mkdtemp fixture.
        try {
          await assert.rejects(f.bundle(), error => error.code === "ENOENT" && error.path === sourcePath);
          assert.equal(existsSync(sourcePath), false);
          assert.deepEqual(readFileSync(f.reviewPath), originalReview);
          assertNoBuild(f);
        } finally { writeFileSync(sourcePath, authoredBefore, { mode: 0o600 }); }
      });
      if (distPath) assert.deepEqual(readFileSync(distPath), compiledBefore);
    });
  }
  t.diagnostic(JSON.stringify({ fixtureOnly: true, artifactExecuted: false, newAuthoredRuntimeLeaves, newAuthoredTypeOnlyInputs,
    nativeCompilerCalls: f.counts.nativeCompilerCalls, signCalls: f.counts.signCalls,
    nativeVerifyCalls: f.counts.nativeVerifyCalls, helperNormalizeCalls: f.counts.helperNormalizeCalls,
    realEsbuildCalls: f.builds.length }));
});

/** A rejected review must not reach native compilation, codesign or actual esbuild. */
function assertNoBuild(f) {
  assert.deepEqual(f.counts, { nativeCompilerCalls: 0, signCalls: 0, nativeVerifyCalls: 0, helperNormalizeCalls: 0 });
  assert.equal(f.builds.length, 0);
}

/** Independent checks of captured real esbuild metadata and original API output pins. */
function assertOriginalSourceOnlyBuild(f, bundle, index) {
  const observed = f.builds[index];
  assert.ok(observed, "the actual fixed builder must call the capture-only real esbuild observer");
  assert.deepEqual(observed.options.entryPoints, [join(f.root, "packages/daemon/src/cli.ts")]);
  assert.equal(observed.options.write, false);
  assert.equal(observed.options.metafile, true);
  assert.equal(observed.options.target, "es2022");
  assert.deepEqual(observed.options.tsconfigRaw, { compilerOptions: { target: "ES2022", useDefineForClassFields: true } });
  assert.ok(observed.metafile?.inputs, "the real esbuild result must include its actual runtime inputs");
  const paths = Object.keys(observed.metafile.inputs).map(name => resolve(f.root, "apps/desktop", name));
  const workspaceInputs = paths.filter(path => workspaceNames.some(name => path.startsWith(join(f.root, "packages", name) + sep)));
  assert.ok(workspaceInputs.length > 0);
  const anyWorkspaceDist = paths.filter(path => workspaceNames.some(name => path.includes(`${sep}packages${sep}${name}${sep}dist${sep}`)));
  assert.deepEqual(anyWorkspaceDist, [], "no generated dist from any of the nine workspace packages may be a runtime input");
  assert.equal(workspaceInputs.every(path => workspaceNames.some(name => path.startsWith(join(f.root, "packages", name, "src") + sep))), true);
  const bridgePath = join(f.root, reviewedLeaf);
  assert.equal(paths.includes(bridgePath), true, "actual metafile must contain the reviewed authored bridge");
  const review = JSON.parse(readFileSync(f.reviewPath, "utf8"));
  const authored = readFileSync(bridgePath);
  assert.equal(hash(authored), review.packagingSha256[reviewedLeaf]);
  const bridgeInputName = Object.keys(observed.metafile.inputs).find(name => resolve(f.root, "apps/desktop", name) === bridgePath);
  assert.equal(observed.metafile.inputs[bridgeInputName].bytes, authored.length);
  assert.equal(workspaceInputs.every(path => Object.hasOwn(review.packagingSha256, path.slice(f.root.length + 1).split(sep).join("/"))), true);
  const reviewedAuthoredRuntimeSha256 = Object.fromEntries(newAuthoredRuntimeLeaves.map(name => {
    const path = join(f.root, name), bytes = readFileSync(path);
    assert.equal(paths.includes(path), true, `actual esbuild metafile must contain the reviewed runtime leaf: ${name}`);
    assert.equal(hash(bytes), review.packagingSha256[name]);
    const inputName = Object.keys(observed.metafile.inputs).find(input => resolve(f.root, "apps/desktop", input) === path);
    assert.equal(observed.metafile.inputs[inputName].bytes, bytes.length);
    return [name, hash(bytes)];
  }));
  const reviewedAuthoredTypeOnlySha256 = Object.fromEntries(newAuthoredTypeOnlyInputs.map(name => {
    const path = join(f.root, name), bytes = readFileSync(path);
    assert.equal(hash(bytes), review.packagingSha256[name]);
    assert.equal(paths.includes(path), false, `type-only contract must not become an executable runtime input: ${name}`);
    return [name, hash(bytes)];
  }));
  assert.deepEqual(observed.outputFiles, [{ path: bundle.pins.path, sha256: bundle.pins.sha256, sizeBytes: bundle.pins.sizeBytes }],
    "original emitted API pins must match the untouched true esbuild output, not a synthesized result");
  return { entryPoint: "packages/daemon/src/cli.ts", runtimeInputs: paths.length, authoredWorkspaceRuntimeInputs: workspaceInputs.length,
    nineWorkspaceDistRuntimeInputs: anyWorkspaceDist.length, reviewedBridgeSha256: hash(authored),
    reviewedAuthoredRuntimeSha256, reviewedAuthoredTypeOnlySha256,
    originalEsbuildOutputSha256: observed.outputFiles[0].sha256 };
}

/**
 * Disposable test-only approved rows, faithful nine-package workspace inputs,
 * real existing esbuild, original native publication and original CLI APIs.
 * Only native compiler bodies and codesign transforms are explicitly replaced.
 * There is no fake esbuild result, generated-output execution or product approval.
 */
async function approvedSyntheticFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-office-daemon-source-inputs-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "apps/desktop/scripts"), nativeOffice = join(root, "native/office-local");
  for (const name of PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS) {
    assert.equal(existsSync(join(repositoryRoot, name)), true, `review input must exist: ${name}`);
    newFile(join(root, name), readFileSync(join(repositoryRoot, name)));
  }
  for (const name of OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS) {
    newFile(join(nativeOffice, name), readFileSync(join(repositoryRoot, "native/office-local", name)));
  }
  for (const name of workspaceNames) {
    const packageRoot = join(root, "packages", name), originalRoot = join(repositoryRoot, "packages", name);
    newFile(join(packageRoot, "package.json"), readFileSync(join(originalRoot, "package.json")));
    newFile(join(packageRoot, "tsconfig.json"), readFileSync(join(originalRoot, "tsconfig.json")));
    cpSync(join(originalRoot, "src"), join(packageRoot, "src"), { recursive: true });
    cpSync(join(originalRoot, "dist"), join(packageRoot, "dist"), { recursive: true });
    linkExistingDependencies(join(originalRoot, "node_modules"), join(packageRoot, "node_modules"), root);
  }
  linkExistingDependencies(join(repositoryRoot, "node_modules"), join(root, "node_modules"), root);
  linkExistingDependencies(join(repositoryRoot, "apps/desktop/node_modules"), join(root, "apps/desktop/node_modules"), root);
  const temporary = join(root, "temporary"); mkdirSync(temporary);
  // Standard publication fixture seams only. The fixed daemon builder remains
  // byte-for-byte the authored implementation and still calls actual esbuild.
  for (const name of ["build-packaged-office-native.mjs", "build-restricted-command-helper.mjs"]) {
    const path = join(scripts, name);
    let source = readFileSync(path, "utf8").replace('import { tmpdir } from "node:os";',
      `const tmpdir = () => ${JSON.stringify(temporary)};`);
    if (name === "build-packaged-office-native.mjs") {
      source = source.replace('import { resolveSigningProfile } from "./cua-driver-signing/signing-contract.mjs";',
        'const resolveSigningProfile = () => ({ signingTier: "unsigned_dev" });');
    }
    writeFileSync(path, source);
  }
  const compilerPath = join(root, "toolchain/clang++"), sdkRoot = join(root, "sdk"), headersRoot = join(root, "headers");
  newFile(compilerPath, "EXPLICIT SYNTHETIC COMPILER IDENTITY");
  newFile(join(sdkRoot, "SDKSettings.json"), "EXPLICIT SYNTHETIC SDK");
  const headerNames = ["node_api.h", "js_native_api.h", "js_native_api_types.h", "node_api_types.h"];
  for (const name of headerNames) newFile(join(headersRoot, name), "EXPLICIT SYNTHETIC HEADER:" + name);
  const review = {
    schemaVersion: 1, reviewId: "packaged_office_native_v1", approval: "approved_source_and_packaging_review",
    protocolVersion: 2, napiVersion: 8, deploymentTarget: "13.0",
    sourceSha256: Object.fromEntries(OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS.map(name => [name, hash(readFileSync(join(nativeOffice, name)))])),
    packagingSha256: Object.fromEntries(PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS.map(name => [name, hash(readFileSync(join(root, name)))])),
    compiler: { path: compilerPath, version: "explicit synthetic compiler", sha256: hash(readFileSync(compilerPath)) },
    sdk: { root: sdkRoot, settingsSha256: hash(readFileSync(join(sdkRoot, "SDKSettings.json"))) },
    headers: { root: headersRoot, sha256: Object.fromEntries(headerNames.map(name => [name, hash(readFileSync(join(headersRoot, name)))])) },
    runtime: { platform: "darwin", architecture: "arm64", electron: "44.5.1", node: "24.14.0", uv: "1.51.0" },
    signing: { profile: "unsigned_dev", mode: "adhoc", identifier: "com.ling-stack.office-local.native" },
    trust: "original_office_source_and_packaging_v1",
  };
  const reviewPath = join(nativeOffice, "reviewed-packaged-source-v1.json");
  newFile(reviewPath, JSON.stringify(review));
  const helperReview = JSON.parse(readFileSync(join(root, "native/sandbox/reviewed-codesign-source-v1.json"), "utf8"));
  // Its unchanged reviewed source files were already copied by the fixed
  // packaging inventory; this is a disposable copy, not a product row update.
  for (const name of Object.keys(helperReview.sourceSha256)) {
    assert.equal(hash(readFileSync(join(root, "native/sandbox", name))), helperReview.sourceSha256[name]);
  }
  const counts = { nativeCompilerCalls: 0, signCalls: 0, nativeVerifyCalls: 0, helperNormalizeCalls: 0 };
  const builds = [];
  const counterKey = `__LING_EXPLICIT_NATIVE_FIXTURE_${root.split("/").at(-1).replaceAll("-", "_")}__`;
  globalThis[counterKey] = counts;
  t.after(() => { delete globalThis[counterKey]; });
  const realEsbuild = await import("esbuild");
  const observerKey = `${counterKey}_REAL_ESBUILD_OBSERVER`;
  // Delegate unchanged options to the installed real esbuild and return its
  // untouched result. This seam records evidence only; it does not fake output,
  // metafile, compiler transforms, publication APIs or the daemon builder bytes.
  globalThis[observerKey] = async options => {
    const result = await realEsbuild.build(options);
    builds.push({ options: { entryPoints: [...options.entryPoints], write: options.write, metafile: options.metafile,
      target: options.target, tsconfigRaw: structuredClone(options.tsconfigRaw) },
      metafile: structuredClone(result.metafile), outputFiles: result.outputFiles?.map(output => ({ path: output.path,
        sha256: hash(output.contents), sizeBytes: output.contents.byteLength })) });
    return result;
  };
  t.after(() => { delete globalThis[observerKey]; });
  const daemonBuildUrl = pathToFileURL(join(scripts, "build-packaged-daemon.mjs")).href;
  const esbuildObserverUrl = pathToFileURL(join(root, "explicit-capture-only-real-esbuild-observer.mjs")).href;
  const officeBuildUrl = pathToFileURL(join(nativeOffice, "scripts/build.mjs")).href;
  const helperBuildUrl = pathToFileURL(join(root, "native/sandbox/scripts/build.mjs")).href;
  const loader = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "esbuild" && context.parentURL === daemonBuildUrl) return { url: esbuildObserverUrl, shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
    if (url === esbuildObserverUrl) return { format: "module", shortCircuit: true,
      source: `export async function build(options) { return await globalThis[${JSON.stringify(observerKey)}](options); }` };
    if (url === officeBuildUrl) return { format: "module", shortCircuit: true, source: `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { createHash } from "node:crypto";
      const review = ${JSON.stringify(review)};
      export function buildNativeEvidence({output}) {
        globalThis[${JSON.stringify(counterKey)}].nativeCompilerCalls++;
        mkdirSync(output); const bytes = Buffer.from("EXPLICIT SYNTHETIC UNSIGNED OFFICE ADDON");
        writeFileSync(join(output, "office-local.node"), bytes);
        return {schemaVersion:2,addon:"office-local",protocolVersion:2,napiVersion:8,deploymentTarget:"13.0",
          platform:"darwin",architecture:"arm64",compiler:review.compiler,sdk:review.sdk,headers:review.headers,
          sourceSha256:review.sourceSha256,binary:{sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length},
          verification:{compilation:"passed"},scopeBinding:"unbound",coreSafe:false,packaged:false};
      }
    ` };
    if (url === helperBuildUrl) return { format: "module", shortCircuit: true, source: `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { createHash } from "node:crypto";
      export function buildNativeEvidence({target,output}) {
        globalThis[${JSON.stringify(counterKey)}].nativeCompilerCalls++;
        mkdirSync(output); mkdirSync(join(output,"licenses"));
        const bytes=Buffer.from("EXPLICIT SYNTHETIC HELPER:LINKER-SIGNATURE");
        writeFileSync(join(output,"ling-sandbox-runner"),bytes);
        writeFileSync(join(output,"licenses/notice.txt"),"EXPLICIT SYNTHETIC NOTICE");
        return {schemaVersion:1,helperName:"ling-sandbox-runner",helperVersion:"source-input-simulation-v1",
          target,host:target,toolchain:"1.97.1",sourceSha256:${JSON.stringify(helperReview.sourceSha256)},
          verification:{format:"passed",releaseBuild:"passed",inputCapture:"passed"},
          fixedCodesignLeaf:{parserProtocol:"passed"},binary:{filename:"ling-sandbox-runner",
            sha256:createHash("sha256").update(bytes).digest("hex"),sizeBytes:bytes.length}};
      }
    ` };
    return nextLoad(url, context);
  } });
  t.after(() => loader.deregister());
  const mock = t.mock.method(childProcess, "spawnSync", (command, args) => {
    assert.equal(command, "/usr/bin/codesign");
    if (args[0] === "--force") {
      counts.signCalls++;
      const path = args.at(-1); writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from(":EXPLICIT SYNTHETIC SIGN TRANSFORM")]));
    } else if (args[0] === "--verify") counts.nativeVerifyCalls++;
    else {
      assert.equal(args[0], "--remove-signature"); counts.helperNormalizeCalls++;
      const bytes = readFileSync(args[1]), suffix = Buffer.from(":LINKER-SIGNATURE");
      assert.equal(bytes.subarray(-suffix.length).equals(suffix), true);
      writeFileSync(args[1], bytes.subarray(0, bytes.length - suffix.length));
    }
    return { status: 0, signal: null, stdout: "", stderr: "" };
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const daemonApi = await import(pathToFileURL(join(scripts, "build-packaged-daemon.mjs")).href);
  const officeApi = await import(pathToFileURL(join(scripts, "build-packaged-office-native.mjs")).href);
  const reviewApi = await import(pathToFileURL(join(scripts, "packaged-office-native-review.mjs")).href);
  return {
    root, counts, builds, reviewApi, reviewPath,
    async bundle() {
      const token = await daemonApi.buildFreshPackagedDaemonForMacOffice();
      return officeApi.withOriginalPackagedOfficeNativePublication(token, async () => {
        const pins = daemonApi.readActiveOriginalPackagedOfficeDaemonBundle();
        const bytes = readFileSync(pins.path);
        assert.equal(hash(bytes), pins.sha256);
        return { pins, bytes };
      });
    },
  };
}

/** Keep workspace imports inside this fixture; only external dependencies reuse installed bytes. */
function linkExistingDependencies(original, destination, fixtureRoot) {
  if (!existsSync(original)) return;
  mkdirSync(destination, { recursive: true });
  const linkOne = (name, source) => {
    if (name === ".pnpm" || name === ".bin" || name.startsWith(".")) return;
    const target = name.startsWith("@ling-stack/")
      ? join(fixtureRoot, "packages", name.slice("@ling-stack/".length)) : realpathSync(source);
    if (!existsSync(target)) return; // Unused non-reviewed workspace packages are not silently adopted.
    const output = join(destination, name); mkdirSync(dirname(output), { recursive: true });
    if (!existsSync(output)) symlinkSync(target, output, "dir");
  };
  for (const name of readdirSync(original)) {
    const source = join(original, name);
    if (name.startsWith("@") && lstatSync(source).isDirectory()) {
      for (const child of readdirSync(source)) linkOne(`${name}/${child}`, join(source, child));
    } else linkOne(name, source);
  }
}
