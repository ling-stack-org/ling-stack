/** Explicit reviewed-addon gate, not portable test:ci; no runtime-generated or simulated native artifact. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_WORKSPACE_ID, HOST_OFFICE_LOCAL_DIRECTORY_V2_GRAPH, HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL,
  resolveSessionRunPolicy, toRuntimeAttemptFence,
} from "@ling-stack/core";
import { resolveConfig } from "../dist/config.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { createDefaultMcpBroker, createHostOfficeLocalGenerationFacade } from "../dist/features/mcp/broker.js";
import { captureOriginalOfficeDirectoryAuthorityV2, createOriginalOfficeDirectoryStoreFactory }
  from "../dist/features/office-documents/office-local-directory-core-authority.js";
import { isOwnedOfficeLocalNativeRuntime } from "../dist/features/office-documents/office-local-native-runtime.js";
import { captureOfficeLocalSnapshot } from "../dist/features/office-documents/office-local-snapshot.js";
import { projectOfficeLocalDirectoryGraph } from "../dist/features/office-documents/office-local-directory-graph.js";
import { PROTECTED_HOST_ACTOR_ENTRIES, readProtectedHostActorEntry } from "../dist/runtime/sandbox/protected-host-actor-inventory.js";
import { readOriginalProtectedHostActorEntries } from "../dist/runtime/sandbox/protected-host-original-entry-manifest.js";
import { reviewedNativeArtifact } from "./support/office-local-native-runtime-fixture.mjs";

// Genuine Host ownership + original SQLite ticket binding and readonly FD
// closure only. No substituted manifest, public no-op, invented issuer, native
// write graph, Core cleanup claim, settlement, packaged or Core-safe evidence.
const nativeOnly = { skip: process.platform !== "darwin" };
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const allRows = closure => [...closure.stage, ...closure.destination];

function owningFixture(t, { bind = true } = {}) {
  const root = realpathSync(mkdtempSync("/private/tmp/ling-office-owning-window-")), cwd = join(root, "workspace");
  mkdirSync(cwd, { mode: 0o755 }); chmodSync(cwd, 0o755);
  let supervisor, store, runtime, scope, facts;
  t.after(() => {
    try {
      if (runtime && scope) {
        let closure;
        try { closure = runtime.readCoreWindowClosure(scope); }
        catch (error) {
          if (error.message !== "office_local_native_core_window_unbound") throw error;
          runtime.closeStage(scope);
        }
        if (closure?.phase === "active") runtime.closeCoreWindow(scope);
        // Unknown original closes are tombstoned and never retried in teardown.
      }
    } finally {
      try { supervisor?.releaseAll(); }
      finally {
        store?.close();
        if (facts) rmSync(facts.stagePath, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  const artifact = reviewedNativeArtifact();
  // Deliberately omit actorEntries: the real Supervisor must enroll its own
  // fixed exact list, not a fixture-provided complete inventory.
  supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }), undefined,
    { officeLocalNativeArtifact: artifact });
  store = createOriginalOfficeDirectoryStoreFactory(supervisor)(cwd);
  const registry = supervisor.getProtectedHostStageRegistry(), hostRuntime = supervisor.getRuntime(cwd, store);
  runtime = supervisor.getOfficeLocalNativeRuntime(cwd, store);
  assert.equal(isOwnedOfficeLocalNativeRuntime(runtime), true);
  assert.equal(runtime, supervisor.getOfficeLocalNativeRuntime(cwd, store));
  const entries = readOriginalProtectedHostActorEntries();
  assert.equal(Object.isFrozen(entries), true); assert.equal(entries.length, 20);
  assert.deepEqual(entries.map(entry => readProtectedHostActorEntry(entry).entryId).sort(), Object.keys(PROTECTED_HOST_ACTOR_ENTRIES).sort());
  registry.assertActorInventoryCurrent();

  const at = new Date().toISOString(), id = "office-owning-" + randomUUID();
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: id,
    idempotencyKey: id, status: "running", createdByActor: "system", request: {}, now: at });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: hostRuntime.runtimeInstanceId, runnerId: "pi", status: "started", now: at });
  const policy = resolveSessionRunPolicy({ workspacePolicy: store.getApprovalPolicy(), authorizationMode: "always",
    workspaceAccessMode: "workspace_write" }).snapshot;
  store.createRun({ id, cwd, workUnitId: unit.id, taskId: "owning-window-task", providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: { effectivePolicySnapshot: policy }, createdAt: at });
  store.linkRunToWorkUnit(id, unit.id, at); store.markRunStarted(id, at);
  const sourceFence = toRuntimeAttemptFence(attempt), source = { runId: id, ...sourceFence }, toolCallId = "owning-window-call";
  const baseBroker = createDefaultMcpBroker(), factory = createHostOfficeLocalGenerationFacade({
    baseBroker, workspaceCwd: cwd, facade: baseBroker,
  });
  const input = { store, run: store.getRun(id), sourceFence, originalBroker: factory,
    factory, rawName: "office_create_document", toolCallId };
  scope = runtime.bootstrapStage(input); facts = runtime.scopeFacts(scope);
  runtime.assertScopeBinding(scope, input);
  const parent = store.admitHostOperation({ operationId: "owning-parent-" + randomUUID(), source, kind: "mcp", toolCallId });
  const producer = store.admitHostOperation({ operationId: "owning-producer-" + randomUUID(), source, kind: "file_mutation",
    toolCallId, parentOperationId: parent.operationId, producerId: "office-local-binary" });
  const snapshot = captureOfficeLocalSnapshot(cwd, "new/report.docx", "docx", source), executionId = randomUUID();
  const graph = projectOfficeLocalDirectoryGraph(snapshot, facts.stagePath, "owning-tree");
  const bytes = Buffer.from("Readonly owning-window preparation; no native writer entered.\n");
  const prepared = { schemaVersion: 2, protocol: HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL,
    graph: HOST_OFFICE_LOCAL_DIRECTORY_V2_GRAPH, executionId, source, parentOperationId: parent.operationId,
    producerOperationId: producer.operationId, toolCallId, toolName: input.rawName, format: "docx", workspacePath: cwd,
    targetPath: snapshot.targetPath, requestDigest: digest(Buffer.from(JSON.stringify({ toolCallId, path: "new/report.docx" }))),
    policyDigest: digest(Buffer.from(JSON.stringify(policy))), output: { bytesSha256: digest(bytes), sizeBytes: bytes.length },
    ...graph, scopeRef: facts.scopeRef, preparedAt: new Date().toISOString() };
  const seal = store.createArtifact({ runId: id, type: "json", path: `office/${executionId}/owning-prepared.json`,
    sealedPayload: prepared, createdAt: new Date().toISOString() });
  const ticket = store.prepareHostOfficeLocalDirectoryExecutionV2(parent, producer,
    { executionId, preparedArtifactId: seal.id, preparedDigest: seal.contentSha256 });
  const execution = store.getHostOfficeLocalDirectoryExecutionV2(ticket.executionId);
  assert.deepEqual(execution.scopeRef, facts.scopeRef);
  assert.deepEqual(execution.source, source);
  const bindOriginal = () => {
    const authority = captureOriginalOfficeDirectoryAuthorityV2(store, runtime, scope);
    store.bindHostOfficeLocalDirectoryScopeAuthorityV2(ticket, authority);
    return authority;
  };
  if (bind) bindOriginal();
  return { root, cwd, store, supervisor, registry, runtime, scope, facts, source, input, execution, ticket, parent, producer,
    bind: bindOriginal,
    blockers: () => store.listHostOperationBlockers(source),
    actorSource: () => registry.captureActorSource({ ...input, command: "true", toolCallId: "owning-window-protected-source" }) };
}

test("default exact Host inventory and original Core row bind retain a genuine owning closed-pending window", nativeOnly, t => {
  const f = owningFixture(t), before = f.runtime.readCoreWindowClosure(f.scope), blockers = f.blockers(), actor = f.actorSource();
  assert.equal(before.phase, "active");
  assert.equal(lstatSync(f.cwd).mode & 0o777, 0o755);
  assert.equal(lstatSync(f.facts.stagePath).mode & 0o777, 0o700);
  for (const role of ["stage", "destination"]) {
    assert.deepEqual(before[role].map(row => ({ path: row.path, device: row.device, inode: row.inode, mode: row.mode })),
      f.execution[role].ancestors.map(row => ({ path: row.path, device: row.identity.device, inode: row.identity.inode, mode: String(row.identity.mode) })));
  }
  assert.ok(allRows(before).every(row => row.state === "retained" && row.close === "not_entered"));
  assert.equal(blockers.length, 2);
  assert.deepEqual(f.store.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId), []);
  for (const name of ["closeCoreWindow", "readCoreWindowClosure"]) {
    const descriptor = Object.getOwnPropertyDescriptor(f.runtime, name);
    assert.equal(descriptor.writable, false); assert.equal(descriptor.configurable, false);
    assert.throws(() => { f.runtime[name] = () => undefined; }, TypeError);
  }
  assert.deepEqual(f.registry.protectedRoots(actor), [f.facts.stagePath, f.execution.destination.parentPath]);
  f.runtime.closeCoreWindow(f.scope);
  const closed = f.runtime.readCoreWindowClosure(f.scope);
  assert.equal(closed.phase, "closed_pending");
  for (const role of ["stage", "destination"]) assert.deepEqual(closed[role],
    before[role].map(row => ({ ...row, state: "closed", close: "returned" })));
  assert.ok(Object.isFrozen(closed) && allRows(closed).every(Object.isFrozen));
  assert.deepEqual(f.blockers(), blockers);
  assert.deepEqual(f.store.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId), []);
  assert.equal(existsSync(f.facts.stagePath), true); assert.equal(existsSync(f.cwd), true);
  assert.equal(existsSync(f.execution.targetPath), false);
  assert.throws(() => f.registry.protectedRoots(actor), /protected_host_stage_closed/u);
  assert.throws(() => f.runtime.closeStage(f.scope), /office_local_native_core_window_close_required/u);
  assert.throws(() => f.runtime.closeCoreWindow(f.scope), /office_local_native_core_window_close_already_entered/u);
  assert.throws(() => f.runtime.openSession(f.scope, f.cwd), /office_local_native_scope_closed/u);
  assert.equal(f.facts.scopeBinding, "unbound"); assert.equal(f.facts.protectedStageVerified, false);
  assert.equal(f.facts.coreSafe, false); assert.equal(f.facts.packaged, false);
  assert.equal(f.facts.nativeArtifact.coreSafe, false);
});

test("window closure accepts only its original bound typed scope, never a clone or foreign scope", nativeOnly, t => {
  const f = owningFixture(t), other = owningFixture(t, { bind: false }), before = f.runtime.readCoreWindowClosure(f.scope);
  for (const value of [{ ...f.scope }, new Proxy(f.scope, {}), other.scope]) {
    assert.throws(() => f.runtime.readCoreWindowClosure(value), /office_local_native_scope_invalid/u);
    assert.throws(() => f.runtime.closeCoreWindow(value), /office_local_native_scope_invalid/u);
  }
  assert.throws(() => other.runtime.readCoreWindowClosure(other.scope), /office_local_native_core_window_unbound/u);
  assert.throws(() => other.runtime.closeCoreWindow(other.scope), /office_local_native_core_window_unbound/u);
  assert.deepEqual(f.runtime.readCoreWindowClosure(f.scope), before);
  other.runtime.assertScopeCurrent(other.scope);
  f.runtime.closeCoreWindow(f.scope);
});

test("scope revocation still permits one original readonly close and historical facts without reopening admission", nativeOnly, t => {
  const f = owningFixture(t), before = f.runtime.readCoreWindowClosure(f.scope), blockers = f.blockers();
  f.runtime.revokeScope(f.scope);
  assert.throws(() => f.runtime.assertScopeCurrent(f.scope), /office_local_native_scope_closed/u);
  assert.deepEqual(f.runtime.readCoreWindowClosure(f.scope), before);
  f.runtime.closeCoreWindow(f.scope);
  const pending = f.runtime.readCoreWindowClosure(f.scope);
  assert.equal(pending.phase, "closed_pending");
  assert.ok(allRows(pending).every(row => row.state === "closed" && row.close === "returned"));
  assert.deepEqual(f.blockers(), blockers);
  f.supervisor.releaseAll();
  assert.deepEqual(f.runtime.readCoreWindowClosure(f.scope), pending);
  assert.throws(() => captureOriginalOfficeDirectoryAuthorityV2(f.store, f.runtime, f.scope), /office_local_directory_core_composition_invalid/u);
  assert.throws(() => f.runtime.openSession(f.scope, f.cwd), /office_local_native_runtime_obsolete|office_local_native_scope_closed/u);
});

test("real readonly close return loss tombstones reentry and leaves original closure unknown with blockers intact", nativeOnly, t => {
  const f = owningFixture(t), blockers = f.blockers(), originalClose = fs.closeSync, calls = [];
  const patch = t.mock.method(fs, "closeSync", fd => {
    calls.push(fd);
    if (calls.length === 1) {
      assert.throws(() => f.runtime.closeCoreWindow(f.scope), /office_local_native_core_window_close_already_entered/u);
      originalClose(fd);
      throw new Error("original_readonly_window_close_return_lost");
    }
    return originalClose(fd);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => f.runtime.closeCoreWindow(f.scope), /protected_host_office_window_close_unknown/u);
    assert.ok(calls.length > 1); assert.equal(new Set(calls).size, calls.length);
    const unknown = f.runtime.readCoreWindowClosure(f.scope), count = calls.length;
    assert.equal(unknown.phase, "unknown");
    assert.equal(allRows(unknown).filter(row => row.state === "unknown" && row.close === "unknown").length, 1);
    assert.throws(() => f.runtime.closeCoreWindow(f.scope), /office_local_native_core_window_close_already_entered/u);
    assert.equal(calls.length, count);
    assert.deepEqual(f.runtime.readCoreWindowClosure(f.scope), unknown);
    assert.deepEqual(f.blockers(), blockers);
    assert.throws(() => f.runtime.openSession(f.scope, f.cwd), /office_local_native_scope_closed/u);
  } finally { patch.mock.restore(); syncBuiltinESMExports(); }
});
