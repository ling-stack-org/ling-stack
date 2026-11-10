/** Explicit reviewed addon + default original Host composition; not portable CI, MCP route or packaged acceptance. */
import assert from "node:assert/strict";
import fs, { existsSync, readFileSync, realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { readOriginalOfficeDirectoryCommittedPairV2 } from "@ling-stack/core/original-office-committed-pair-v2";
import * as originalAuthority from "../dist/features/office-documents/office-local-directory-core-authority.js";
import { readOriginalOfficeDirectoryRuntimeReleasePermitV2 }
  from "../dist/features/office-documents/office-local-native-runtime.js";
import { releaseOriginalProtectedHostOfficeDirectoryLeaseV2 }
  from "../dist/runtime/sandbox/protected-host-staging.js";
import { createOriginalOfficeDirectoryCompositionFixture } from "./support/office-original-directory-composition-fixture.mjs";
import { executeOriginalOfficeDirectoryNativeGraph } from "./support/office-original-directory-native-graph.mjs";

const nativeOnly = { skip: process.platform !== "darwin" };
const expected = f => ({ executionId: f.plan.executionId, source: f.source,
  parentOperationId: f.state.execution.parentOperationId, producerOperationId: f.state.execution.producerOperationId });
const assertOpaque = value => {
  assert.ok(value && Object.isFrozen(value)); assert.deepEqual(Reflect.ownKeys(value), []);
};
function commitOriginalWriter(f) {
  assert.equal(existsSync(join(f.cwd, "reports")), false, "the native graph must create the genuinely missing requested subtree");
  assert.deepEqual(f.leaseRoots(), [f.facts.stagePath, f.state.execution.destination.parentPath]);
  const native = executeOriginalOfficeDirectoryNativeGraph(f);
  assert.deepEqual(readFileSync(f.state.execution.targetPath), f.artifact.bytes);
  assert.equal(f.artifact.bytes.subarray(0, 2).toString("ascii"), "PK", "real prepareOfficeArtifact DOCX bytes, not text digest fixtures");
  assert.equal(native.terminalArtifact.manifest.outcome, "published_native_only");
  assert.equal(f.effects().filter(effect => effect.kind === "capture_parents").length, 1);
  assert.equal(f.effects().filter(effect => effect.kind === "install_tree").length, 1);
  assert.equal(f.effects().filter(effect => effect.kind === "close_session").length, 1);
  assert.equal(f.runtime.readCoreWindowClosure(f.state.scope).phase, "active", "native closure and terminal seal do not close the Host window");
  assert.ok(f.pairRows().every(row => row.phase === "launched"));
  const claim = f.closeOriginalWindow();
  assertOpaque(claim);
  assert.equal(f.store.closeHostOfficeLocalDirectoryWindowV2(f.state.ticket), claim, "retain the exact original claim before pair settlement");
  assert.equal(f.runtime.readCoreWindowClosure(f.state.scope).phase, "closed_pending");
  assert.throws(() => f.leaseRoots(), /protected_host_stage_closed/u);
  const grant = f.store.settleHostOfficeLocalDirectoryExecutionV2(f.state.ticket);
  assertOpaque(grant);
  const pair = readOriginalOfficeDirectoryCommittedPairV2(f.store, grant, claim, expected(f));
  assert.ok(Object.isFrozen(pair) && Object.isFrozen(pair.parent) && Object.isFrozen(pair.producer));
  assert.ok([pair.parent, pair.producer].every(row => row.phase === "safe"));
  assert.equal(pair.parent.settlementKind, "office_local_chain_completed");
  assert.equal(pair.producer.settlementKind, "office_local_binary_completed");
  assert.equal(f.store.listHostOperationBlockers(f.source).length, 0);
  assert.throws(() => f.leaseRoots(), /protected_host_stage_closed/u, "committed Core proof alone does not release Host protection");
  return { ...native, grant, claim, pair };
}
function release(f, grant, claim, authority = f.authority) {
  assert.equal(typeof originalAuthority.releaseOriginalOfficeDirectoryLeaseV2, "function");
  return originalAuthority.releaseOriginalOfficeDirectoryLeaseV2(authority, grant, claim);
}
/** Actual native-source reads and original JS readonly closes are observed, never replaced. */
function observeOriginalProofIo(t, effect) {
  const sourcePath = realpathSync(new URL("../../../native/office-local/src/runtime.h", import.meta.url));
  const read = fs.readFileSync, close = fs.closeSync, stat = fs.fstatSync, calls = { sourceReads: 0, readonlyCloses: 0 };
  const readPatch = t.mock.method(fs, "readFileSync", (...args) => {
    if (args[0] === sourcePath) calls.sourceReads++;
    return read(...args);
  });
  const closePatch = t.mock.method(fs, "closeSync", (...args) => {
    // Initial current proof reads regular reviewed-source files. Their genuine
    // readFileSync closes are not the original readonly directory window.
    // An already-closed invalid FD still throws here; no reclose is hidden.
    if (stat(args[0]).isDirectory()) calls.readonlyCloses++;
    return close(...args);
  });
  syncBuiltinESMExports();
  try { return effect(calls); }
  finally { readPatch.mock.restore(); closePatch.mock.restore(); syncBuiltinESMExports(); }
}
/** Inject only after a genuine original source read returns unchanged bytes. */
function interruptOriginalProofRead(t, interrupt, effect) {
  const sourcePath = realpathSync(new URL("../../../native/office-local/src/runtime.h", import.meta.url)), read = fs.readFileSync;
  let entered = 0;
  const patch = t.mock.method(fs, "readFileSync", (...args) => {
    const bytes = read(...args);
    if (args[0] === sourcePath && entered === 0) { entered++; interrupt(); }
    return bytes;
  });
  syncBuiltinESMExports();
  try { return effect(() => entered); }
  finally { patch.mock.restore(); syncBuiltinESMExports(); }
}
const assertPendingLease = f => assert.throws(() => f.unboundActorGate(), /protected_host_actor_unbound_with_active_stage/u);

test("genuine original writer seals real DOCX native graph, original close claim and committed Core pair while retaining lease", nativeOnly, async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t), result = commitOriginalWriter(f);
  const effects = f.effects(), terminal = f.terminal();
  observeOriginalProofIo(t, calls => {
    assert.equal(f.store.settleHostOfficeLocalDirectoryExecutionV2(f.state.ticket), result.grant);
    assert.deepEqual(calls, { sourceReads: 0, readonlyCloses: 0 });
  });
  assert.deepEqual(f.effects(), effects); assert.deepEqual(f.terminal(), terminal);
  t.diagnostic(`Real reviewed addon + default 20 source entries + original Store/frame: DOCX ${f.artifact.bytes.length} bytes, ${effects.length} original effects; native-only terminal flags remain unchanged.`);
});

test("unrelated directory metadata changes between preparation and original native capture still permit the same genuine node", nativeOnly, async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t), prepared = f.state.execution.destination.ancestors.at(-1).identity;
  // Actual mutation of this owned fixture only; no scheduler timing dependency,
  // fabricated packet or replacement of the reviewed native/Host gates.
  fs.mkdirSync(join(f.cwd, "unrelated-entry"));
  fs.utimesSync(f.cwd, new Date("2000-01-01T00:00:00.000Z"), new Date("2000-01-01T00:00:00.000Z"));
  const actual = fs.lstatSync(f.cwd, { bigint: true });
  assert.equal(String(actual.dev), prepared.device); assert.equal(String(actual.ino), prepared.inode);
  assert.equal(Number(actual.mode), prepared.mode); assert.notEqual(String(actual.mtimeNs), prepared.modifiedNs);
  const result = commitOriginalWriter(f), capture = f.effects().find(effect => effect.kind === "capture_parents");
  const observation = f.store.getArtifact(capture.observationArtifactId).sealedPayload;
  const binding = observation.resourceBindings.find(row => row.resourceSlotId === f.state.execution.destination.parentResourceSlotId);
  const original = observation.native.result.snapshot.resources.find(row => row.lifetimeId === binding.nativeLifetimeId).initialIdentity;
  assert.notEqual(original.modifiedNs, prepared.modifiedNs, "persist the actual original first-fstat identity, not the prepared timestamps");
  release(f, result.grant, result.claim);
  assert.deepEqual(f.leaseRoots(), []);
});

test("exact original authority, committed grant and close claim release only the owning protection lease", nativeOnly, async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t), result = commitOriginalWriter(f);
  const effects = f.effects(), terminal = f.terminal();
  observeOriginalProofIo(t, calls => {
    release(f, result.grant, result.claim);
    assert.equal(calls.readonlyCloses, 0, "lease release never recloses the original readonly window");
  });
  assert.deepEqual(f.leaseRoots(), []);
  assert.deepEqual(f.effects(), effects); assert.deepEqual(f.terminal(), terminal);
  assert.equal(f.terminal().outcome, "published_native_only");
});

test("same released authority, grant and claim retry is private historical SQL-only after Host retirement", nativeOnly, async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t), result = commitOriginalWriter(f);
  release(f, result.grant, result.claim);
  f.supervisor.releaseAll();
  const effects = f.effects(), terminal = f.terminal();
  observeOriginalProofIo(t, calls => {
    release(f, result.grant, result.claim);
    release(f, result.grant, result.claim);
    assert.deepEqual(calls, { sourceReads: 0, readonlyCloses: 0 });
  });
  assert.deepEqual(f.effects(), effects); assert.deepEqual(f.terminal(), terminal);
  assert.deepEqual(readOriginalOfficeDirectoryCommittedPairV2(f.store, result.grant, result.claim, expected(f)), result.pair);
});

test("cloned or proxied authority, grant and claim cannot release a genuine pending protection lease", nativeOnly, async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t), result = commitOriginalWriter(f);
  const cloneForms = value => [structuredClone(value), { ...value }, JSON.parse(JSON.stringify(value)), new Proxy(value, {})];
  const effects = f.effects(), terminal = f.terminal();
  observeOriginalProofIo(t, calls => {
    for (const authority of cloneForms(f.authority)) assert.throws(() => release(f, result.grant, result.claim, authority));
    for (const grant of cloneForms(result.grant)) assert.throws(() => release(f, grant, result.claim));
    for (const claim of cloneForms(result.claim)) assert.throws(() => release(f, result.grant, claim));
    assert.equal(calls.readonlyCloses, 0);
  });
  assert.throws(() => f.leaseRoots(), /protected_host_stage_closed/u);
  assert.deepEqual(f.effects(), effects); assert.deepEqual(f.terminal(), terminal);
  release(f, result.grant, result.claim); assert.deepEqual(f.leaseRoots(), []);
});

test("foreign genuine authority, grant and claim never release another original window", nativeOnly, async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t), result = commitOriginalWriter(f);
  const foreign = await createOriginalOfficeDirectoryCompositionFixture(t), other = commitOriginalWriter(foreign);
  assert.throws(() => release(f, result.grant, result.claim, foreign.authority));
  assert.throws(() => release(f, other.grant, result.claim));
  assert.throws(() => release(f, result.grant, other.claim));
  assert.throws(() => f.leaseRoots(), /protected_host_stage_closed/u);
  assert.throws(() => foreign.leaseRoots(), /protected_host_stage_closed/u);
  release(f, result.grant, result.claim); assert.deepEqual(f.leaseRoots(), []);
  assert.throws(() => foreign.leaseRoots(), /protected_host_stage_closed/u);
  release(foreign, other.grant, other.claim); assert.deepEqual(foreign.leaseRoots(), []);
});

test("revoked original Host proof cannot initially release even after a genuine committed Core pair", nativeOnly, async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t), result = commitOriginalWriter(f);
  f.runtime.revokeScope(f.state.scope);
  const effects = f.effects(), terminal = f.terminal();
  observeOriginalProofIo(t, calls => {
    assert.throws(() => release(f, result.grant, result.claim), /office_local_native_core_proof_closed/u);
    assert.equal(calls.readonlyCloses, 0);
  });
  assert.throws(() => f.leaseRoots(), /protected_host_stage_closed/u);
  assert.deepEqual(f.effects(), effects); assert.deepEqual(f.terminal(), terminal);
  assert.ok(f.pairRows().every(row => row.phase === "safe"));
});

test("reopened public Store sees canonical safe pair but cannot turn a copied grant into lease authority", nativeOnly, async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t), result = commitOriginalWriter(f);
  const reopened = createSqliteRunStore(f.cwd); t.after(() => reopened.close());
  assert.ok(f.pairRows().every(row => reopened.getHostOperation(row.operationId).phase === "safe"));
  assert.throws(() => readOriginalOfficeDirectoryCommittedPairV2(reopened, result.grant, result.claim, expected(f)));
  assert.throws(() => release(f, structuredClone(result.grant), result.claim));
  assert.throws(() => f.leaseRoots(), /protected_host_stage_closed/u);
  release(f, result.grant, result.claim); assert.deepEqual(f.leaseRoots(), []);
});

test("synchronous first-proof reentry rejects the nested original release gate and releases only once", nativeOnly, async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t), result = commitOriginalWriter(f);
  const effects = f.effects(), terminal = f.terminal();
  observeOriginalProofIo(t, calls => interruptOriginalProofRead(t, () => {
    assert.throws(() => release(f, result.grant, result.claim), /office_local_native_lease_release_already_entered/u);
    assertPendingLease(f);
  }, entered => {
    release(f, result.grant, result.claim);
    assert.equal(entered(), 1); assert.equal(calls.readonlyCloses, 0);
  }));
  assert.deepEqual(f.leaseRoots(), []); assert.equal(f.unboundActorGate(), undefined);
  assert.deepEqual(f.effects(), effects); assert.deepEqual(f.terminal(), terminal);
});

test("coverage closure during a genuine first-proof source read refuses release and retains its pending member", nativeOnly, async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t), result = commitOriginalWriter(f);
  const effects = f.effects(), terminal = f.terminal();
  observeOriginalProofIo(t, calls => interruptOriginalProofRead(t, () => f.registry.markActorEntryCoverageUnknown(), entered => {
    assert.throws(() => release(f, result.grant, result.claim), /protected_host_actor_coverage_unknown/u);
    assert.equal(entered(), 1); assert.equal(calls.readonlyCloses, 0);
  }));
  assertPendingLease(f);
  assert.throws(() => f.leaseRoots(), /protected_host_stage_closed/u);
  assert.throws(() => release(f, result.grant, result.claim), /office_local_native_core_proof_closed/u);
  assertPendingLease(f);
  assert.deepEqual(f.effects(), effects); assert.deepEqual(f.terminal(), terminal);
  assert.ok(f.pairRows().every(row => row.phase === "safe"));
});

test("Host retirement during a genuine first-proof source read cannot release its already-closed pending window", nativeOnly, async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t), result = commitOriginalWriter(f);
  const effects = f.effects(), terminal = f.terminal();
  observeOriginalProofIo(t, calls => interruptOriginalProofRead(t, () => f.supervisor.releaseAll(), entered => {
    assert.throws(() => release(f, result.grant, result.claim), /office_local_native_core_proof_closed/u);
    assert.equal(entered(), 1); assert.equal(calls.readonlyCloses, 0);
  }));
  assertPendingLease(f);
  assert.deepEqual(f.effects(), effects); assert.deepEqual(f.terminal(), terminal);
  assert.ok(f.pairRows().every(row => row.phase === "safe"));
});

test("real private Registry history publication return-loss reconciles only the same committed grant after retirement", nativeOnly, async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t), result = commitOriginalWriter(f);
  const effects = f.effects(), terminal = f.terminal(), originalSet = WeakMap.prototype.set;
  let injected = false, capturedPermit;
  const patch = t.mock.method(WeakMap.prototype, "set", function(key, value) {
    const returned = originalSet.call(this, key, value);
    if (!injected && value?.state?.execution?.executionId === f.plan.executionId && value?.window && value?.state?.registration) {
      capturedPermit = key; injected = true;
      throw new Error("fixture_original_lease_history_return_lost");
    }
    return returned;
  });
  try { assert.throws(() => release(f, result.grant, result.claim), /fixture_original_lease_history_return_lost/u); }
  finally { patch.mock.restore(); }
  assert.equal(injected, true, "actual Registry member deletion and original private history set must be reached");
  assertOpaque(capturedPermit);
  assert.deepEqual(f.leaseRoots(), []); assert.equal(f.unboundActorGate(), undefined);
  assert.deepEqual(readFileSync(f.state.execution.targetPath), f.artifact.bytes);
  assert.ok(f.pairRows().every(row => row.phase === "safe"));
  f.supervisor.releaseAll();
  observeOriginalProofIo(t, calls => {
    release(f, result.grant, result.claim);
    release(f, result.grant, result.claim);
    assert.throws(() => readOriginalOfficeDirectoryRuntimeReleasePermitV2(capturedPermit), /office_local_native_lease_release_permit_invalid/u);
    assert.throws(() => releaseOriginalProtectedHostOfficeDirectoryLeaseV2(f.registry, capturedPermit), /office_local_native_lease_release_permit_invalid/u);
    assert.deepEqual(calls, { sourceReads: 0, readonlyCloses: 0 });
  });
  assert.deepEqual(f.effects(), effects); assert.deepEqual(f.terminal(), terminal);
  assert.deepEqual(readOriginalOfficeDirectoryCommittedPairV2(f.store, result.grant, result.claim, expected(f)), result.pair);
  t.diagnostic("Actual JS private-history publication completed before injected return loss; not an HTTP/MCP transport ACK-loss acceptance.");
});
