/** Explicit reviewed local-addon gate; not a portable daemon test:ci input or a Host safe receipt. */
import assert from "node:assert/strict";
import fs, { closeSync, copyFileSync, fstatSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { resolveConfig } from "../dist/config.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { isOwnedOfficeLocalNativeRuntime } from "../dist/features/office-documents/office-local-native-runtime.js";
import { loadReviewedOfficeLocalNativeArtifact } from "../dist/runtime/sandbox/protected-host-office-native-identity.js";
import { reviewedNativeArtifact } from "./support/office-local-native-runtime-fixture.mjs";

function artifactFixture(t) {
  const artifact = reviewedNativeArtifact(), root = realpathSync(mkdtempSync("/private/tmp/ling-office-native-identity-"));
  const binaryPath = join(root, "office-local.node"); copyFileSync(artifact.binaryPath, binaryPath);
  t.after(() => rmSync(root, { recursive: true }));
  return { artifact: { ...artifact, binaryPath }, root };
}
test("the actual original-FD-loaded local addon has stable facts and positional repeated reads", t => {
  const { artifact } = artifactFixture(t), native = loadReviewedOfficeLocalNativeArtifact(artifact);
  t.after(() => native.closeIdentity());
  native.assertCurrent(); native.assertCurrent();
  assert.equal(native.facts.classification, "local_verified"); assert.equal(native.facts.packaged, false);
  assert.equal(native.facts.coreSafe, false); assert.equal(native.facts.distributionSignature, "not_verified");
  assert.throws(() => native.invoke("inspectSession", [{}]), /capability|session/u);
});
test("caller-provided matching flags cannot replace reviewed binary/source identity", t => {
  const { artifact } = artifactFixture(t);
  assert.throws(() => loadReviewedOfficeLocalNativeArtifact({ ...artifact, reviewedBinarySha256: "0".repeat(64) }), /identity_invalid/u);
  assert.throws(() => loadReviewedOfficeLocalNativeArtifact({ ...artifact,
    reviewedSourceSha256: { ...artifact.reviewedSourceSha256, "src/addon.cc": "0".repeat(64) } }), /identity_invalid/u);
});
test("a same-bytes pathname replacement cannot become the loaded original's identity", t => {
  const { artifact, root } = artifactFixture(t), native = loadReviewedOfficeLocalNativeArtifact(artifact);
  renameSync(artifact.binaryPath, join(root, "original.node"));
  copyFileSync(join(root, "original.node"), artifact.binaryPath);
  assert.throws(() => native.assertCurrent(), /identity_invalid/u);
  native.closeIdentity(); native.closeIdentity();
});
test("real original FD loss/reuse tombstones once and never closes the replacement integer", t => {
  const { artifact, root } = artifactFixture(t), originalOpen = fs.openSync;
  let retainedFd;
  fs.openSync = (...args) => { const fd = originalOpen(...args); if (args[0] === artifact.binaryPath) retainedFd = fd; return fd; };
  syncBuiltinESMExports();
  let native;
  try { native = loadReviewedOfficeLocalNativeArtifact(artifact); } finally { fs.openSync = originalOpen; syncBuiltinESMExports(); }
  assert.ok(Number.isInteger(retainedFd)); closeSync(retainedFd);
  const replacement = openSync(join(root, "replacement"), "wx+", 0o600);
  try {
    assert.equal(replacement, retainedFd);
    assert.throws(() => native.assertCurrent(), /original_fd_changed/u);
    assert.throws(() => native.closeIdentity(), /identity_invalid/u);
    assert.ok(fstatSync(replacement).isFile());
  } finally { closeSync(replacement); }
});
test("genuine Supervisor cache objects reject clones/noop runtimes and retain primitive non-safe facts", t => {
  const { artifact, root } = artifactFixture(t), store = createSqliteRunStore(root);
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: root }), undefined,
    { officeLocalNativeArtifact: artifact });
  t.after(() => { supervisor.releaseAll(); store.close(); });
  const runtime = supervisor.getOfficeLocalNativeRuntime(root, store);
  assert.ok(isOwnedOfficeLocalNativeRuntime(runtime)); assert.equal(supervisor.getOfficeLocalNativeRuntime(root, store), runtime);
  assert.equal(isOwnedOfficeLocalNativeRuntime({ ...runtime }), false);
  assert.equal(isOwnedOfficeLocalNativeRuntime({ assertScopeBinding() {}, scopeFacts: () => ({ packaged: true }) }), false);
  assert.throws(() => runtime.bootstrapStage({ store, run: { cwd: root }, sourceFence: {}, toolCallId: "test",
    originalBroker: {}, factory: {}, rawName: "office_create_document" }), /runtime_schema_unsupported/u);
  assert.throws(() => { runtime.openSession = () => ({ success: true }); }, TypeError);
});
