/** Reviewed-addon loading + genuine cached scope negative checks; no native effect, issuer success or safe claim. */
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { assertOriginalOfficeHostBridgeForCompositionCurrent, captureOriginalOfficeHostBridgeReader,
  createOriginalOfficeHostBridgeForComposition, mintOriginalOfficeDirectoryAuthorityV2,
  sealOriginalOfficeHostBridgeForComposition } from "@ling-stack/core/original-office-host-bridge";
import { resolveConfig } from "../dist/config.js";
import { isOriginalRuntimeSupervisorOfficeRoot, retainOriginalRuntimeSupervisorOfficeStoreBridge,
  RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { captureOriginalOfficeDirectoryRuntimeCustody, assertOriginalOfficeDirectoryRuntimeBinding } from "../dist/features/office-documents/office-local-native-runtime.js";
import { captureOriginalOfficeDirectoryAuthorityV2, createOriginalOfficeDirectoryStoreFactory } from "../dist/features/office-documents/office-local-directory-core-authority.js";
import { createNativeBootstrapFixture } from "./support/office-local-native-bootstrap-fixture.mjs";
import { reviewedNativeArtifact } from "./support/office-local-native-runtime-fixture.mjs";

test("private Core custody rejects public inventory and stage noops against the real incomplete manifest", t => {
  const f = createNativeBootstrapFixture(t), scope = f.runtime.bootstrapStage(f.input);
  t.mock.method(f.registry, "assertStageCurrent", () => {});
  assert.throws(() => captureOriginalOfficeDirectoryRuntimeCustody(f.runtime, scope), /protected_host_actor_inventory_incomplete/u);
  assert.throws(() => captureOriginalOfficeDirectoryRuntimeCustody(f.runtime, scope), /office_local_native_core_custody_closed/u);
  assert.throws(() => f.runtime.openSession(scope, f.cwd), /office_local_native_scope_closed/u);
  assert.throws(() => assertOriginalOfficeDirectoryRuntimeBinding(f.runtime, {}, {}), /office_local_native_core_custody_invalid/u);
  assert.throws(() => captureOriginalOfficeDirectoryAuthorityV2(f.store, f.runtime, scope), /office_local_directory_core_composition_invalid/u);
  f.runtime.closeStage(scope); // Failure cannot strand the separately owned stage's original cleanup.
});

test("private Core custody rejects cloned and borrowed scope/runtime capabilities before native capture", t => {
  const f = createNativeBootstrapFixture(t), other = createNativeBootstrapFixture(t);
  const scope = f.runtime.bootstrapStage(f.input), foreign = other.runtime.bootstrapStage(other.input);
  for (const counterfeit of [{ ...scope }, new Proxy(scope, {}), foreign]) {
    assert.throws(() => captureOriginalOfficeDirectoryRuntimeCustody(f.runtime, counterfeit), /office_local_native_scope_invalid/u);
  }
  for (const runtime of [Object.create(f.runtime), { ...f.runtime }, new Proxy(f.runtime, {})]) {
    assert.throws(() => captureOriginalOfficeDirectoryRuntimeCustody(runtime, scope), /office_local_native_runtime_unowned/u);
  }
  assert.equal(f.runtime.scopeFacts(scope).coreSafe, false);
  assert.equal(other.runtime.scopeFacts(foreign).coreSafe, false);
  f.runtime.closeStage(scope); other.runtime.closeStage(foreign);
});

test("root revokes enrolled transport before real original binary-identity close return loss, without retrying that FD", t => {
  const root = realpathSync(mkdtempSync("/private/tmp/ling-office-retirement-native-")), cwd = join(root, "workspace");
  mkdirSync(cwd, { mode: 0o700 });
  const artifact = reviewedNativeArtifact(), supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }),
    undefined, { officeLocalNativeArtifact: artifact });
  const store = createOriginalOfficeDirectoryStoreFactory(supervisor)(cwd);
  // Separate Core transport mechanism, not a genuine issued scope or endpoint. Its
  // capability lifetime must still be revoked before genuine binary-FD cleanup.
  const pair = createOriginalOfficeHostBridgeForComposition(), bridge = captureOriginalOfficeHostBridgeReader(pair.reader, store);
  sealOriginalOfficeHostBridgeForComposition(pair.setup, store, Object.freeze({ assertBinding() {} }));
  retainOriginalRuntimeSupervisorOfficeStoreBridge(supervisor, store, pair.setup);
  const authority = mintOriginalOfficeDirectoryAuthorityV2(pair.setup, {}), originalOpen = fs.openSync, originalClose = fs.closeSync;
  let identityFd, closeCalls = 0;
  const open = t.mock.method(fs, "openSync", (...args) => {
    const fd = originalOpen(...args);
    if (args[0] === artifact.binaryPath) identityFd = fd;
    return fd;
  });
  syncBuiltinESMExports();
  try { supervisor.getOfficeLocalNativeRuntime(cwd, store); }
  finally { open.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(typeof identityFd, "number");
  const close = t.mock.method(fs, "closeSync", fd => {
    if (fd !== identityFd) return originalClose(fd);
    closeCalls++;
    assert.equal(isOriginalRuntimeSupervisorOfficeRoot(supervisor), false);
    assert.throws(() => assertOriginalOfficeHostBridgeForCompositionCurrent(pair.setup, store), { code: "host_office_local_bridge_unavailable" });
    assert.throws(() => bridge.assertAuthorityOwned(authority), { code: "host_office_local_bridge_unavailable" });
    originalClose(fd); throw new Error("original_identity_close_return_lost");
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => supervisor.releaseAll(), error => error instanceof AggregateError
      && error.message === "office_local_native_identity_close_unknown" && error.errors[0]?.message === "original_identity_close_return_lost");
    assert.equal(closeCalls, 1);
    assert.throws(() => supervisor.releaseAll(), /office_local_native_identity_close_unknown/u);
    assert.equal(closeCalls, 1);
    assert.throws(() => mintOriginalOfficeDirectoryAuthorityV2(pair.setup, {}), { code: "host_office_local_bridge_unavailable" });
  } finally {
    close.mock.restore(); syncBuiltinESMExports();
    store.close(); rmSync(root, { recursive: true, force: true });
  }
});
