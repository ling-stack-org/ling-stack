import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_ID, resolveSessionRunPolicy, toRuntimeAttemptFence } from "@ling-stack/core";
import { OFFICE_DOCUMENTS_MCP_SERVER_ID } from "@ling-stack/contracts";
import { resolveConfig } from "../../dist/config.js";
import { createDaemonServer } from "../../dist/index.js";
import { RuntimeSupervisor } from "../../dist/runtime/supervisor.js";
import { RunStoreRegistry } from "../../dist/runtime/store-registry.js";
import { AttemptHostOperationTracker } from "../../dist/runtime/attempt-host-operation-tracker.js";
import { readOriginalAttemptExecutorGroupSnapshot } from "../../dist/runtime/attempt-execution-quiescence.js";
import { createDefaultMcpBroker, createHostOfficeLocalGenerationFacade } from "../../dist/features/mcp/broker.js";
import { captureMcpResultAuthority } from "../../dist/features/mcp/result-authority.js";
import { officeDocumentTools } from "../../dist/features/plugins/office-documents-generation-broker.js";
import { prepareOfficeArtifact } from "../../dist/features/office-documents/office-artifact-preparation.js";
import { reserveOfficeLocalWriter, bindOfficeLocalMcpForwardAuthority, captureOfficeLocalReservationSnapshot,
  bootstrapOfficeLocalDirectoryScope, prepareOfficeLocalDirectoryWrite, officeLocalDirectoryWriteState }
  from "../../dist/features/office-documents/office-local-authority.js";
import { createOriginalOfficeDirectoryStoreFactory, readOriginalOfficeDirectoryNativeRuntime }
  from "../../dist/features/office-documents/office-local-directory-core-authority.js";
import { PROTECTED_HOST_ACTOR_ENTRIES, readProtectedHostActorEntry }
  from "../../dist/runtime/sandbox/protected-host-actor-inventory.js";
import { readOriginalProtectedHostActorEntries }
  from "../../dist/runtime/sandbox/protected-host-original-entry-manifest.js";
import { reviewedNativeArtifact } from "./office-local-native-runtime-fixture.mjs";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Genuine default 20-source startup, original Store/Host custody and original
 * fixed MCP frame. No supplied inventory, replacement gate, synthetic native
 * packet or external service. Only the serializer and owned fixture paths are
 * used; this is not an actual MCP route or packaged application acceptance.
 */
export async function createOriginalOfficeDirectoryCompositionFixture(t, {
  format = "docx", path = `reports/nested/report.${format}`, daemonStartup = false, preparePlan = true,
} = {}) {
  const root = realpathSync(mkdtempSync("/private/tmp/ling-office-original-writer-")), cwd = join(root, "workspace");
  mkdirSync(cwd, { mode: 0o755 }); chmodSync(cwd, 0o755);
  let supervisor, store, runtime, state, facts, originalClosedSnapshot, authority, daemon,
    tracker, registry, entries, boundTicket, originalCloseClaim;
  const previousLingHome = process.env.LING_STACK_HOME;
  t.after(async () => {
    let cleanupKnown = preparePlan;
    try {
      if (!preparePlan) {
        // Product startup mode has no fixture-owned plan/scope. A returned
        // result cannot authorize cleanup, nor can the absence of fixture state.
        // Inspect its genuine original pair, local barriers and same Registry.
        let noPendingLease = false;
        try {
          registry?.assertActorEntryLaunchCurrent(entries?.find(entry =>
            readProtectedHostActorEntry(entry).entryId === "macos_native_command"), undefined, false);
          noPendingLease = Boolean(registry && entries);
        } catch { /* An unknown original stage remains protected and retained. */ }
        const execution = boundTicket && store.getHostOfficeLocalDirectoryExecutionV2(boundTicket.executionId);
        const rows = execution && [execution.parentOperationId, execution.producerOperationId]
          .map(operationId => store.getHostOperation(operationId));
        const localRows = tracker && readOriginalAttemptExecutorGroupSnapshot(tracker.executorGroup).operations;
        cleanupKnown = Boolean(originalCloseClaim && execution && rows.every(row => row?.phase === "safe")
          && localRows?.length === 2 && localRows.every(row => row.state === "settled")
          && [execution.parentOperationId, execution.producerOperationId].every(operationId =>
            localRows.some(row => row.ticket.id === operationId))
          && noPendingLease);
        if (!cleanupKnown) t.diagnostic(`Product cleanup unconfirmed; retain original workspace/stage evidence: ${root}`);
      }
      if (state && !originalClosedSnapshot) {
        const closure = runtime.readCoreWindowClosure(state.scope);
        if (closure.phase === "active") {
          try { runtime.closeCoreWindow(state.scope); }
          catch (error) {
            if (error.message !== "office_local_native_stage_lifetime_unknown") throw error;
            // A genuinely still-owned session can close once. If its original
            // close already entered/failed, runtime refuses; never retry it.
            assert.equal(runtime.closeSession(state.scope).success, true);
            runtime.closeCoreWindow(state.scope);
          }
        }
        const closed = runtime.readCoreWindowClosure(state.scope);
        cleanupKnown = closed.phase === "closed_pending" && [...closed.stage, ...closed.destination]
          .every(row => row.state === "closed" && row.close === "returned");
      }
    } catch (error) {
      cleanupKnown = false;
      t.diagnostic(`Original cleanup unconfirmed; no retry or recursive removal. Fixture retained: ${root}`);
      throw error;
    } finally {
      try {
        if (daemon) await daemon.stop();
        else supervisor?.releaseAll();
      }
      finally {
        if (!daemon) store?.close();
        if (daemonStartup) {
          if (previousLingHome === undefined) delete process.env.LING_STACK_HOME;
          else process.env.LING_STACK_HOME = previousLingHome;
        }
        if (cleanupKnown) {
          if (facts) rmSync(facts.stagePath, { recursive: true, force: true });
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  });
  if (daemonStartup) {
    process.env.LING_STACK_HOME = join(root, "ling-home");
    const observedStores = [], getStore = RunStoreRegistry.prototype.getStore;
    const observer = t.mock.method(RunStoreRegistry.prototype, "getStore", function (path) {
      const value = getStore.call(this, path);
      if (realpathSync(path) === cwd && !observedStores.includes(value)) observedStores.push(value);
      return value;
    });
    try {
      // Only Host-reviewed build selection is supplied. The real daemon owns
      // its default original factory, cached Store and same Supervisor.
      daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
        { officeLocalNativeArtifact: reviewedNativeArtifact() });
      await daemon.start();
    } finally { observer.mock.restore(); }
    assert.equal(observedStores.length, 1, "actual daemon startup must reuse one original default Store");
    [store] = observedStores;
    runtime = readOriginalOfficeDirectoryNativeRuntime(store);
    assert.ok(runtime, "the same original daemon Store must resolve its Host-reviewed runtime");
    supervisor = runtime.supervisor;
  } else {
    supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }), undefined,
      { officeLocalNativeArtifact: reviewedNativeArtifact() }); // Do not supply actorEntries.
    store = createOriginalOfficeDirectoryStoreFactory(supervisor)(cwd);
  }
  const bindAuthority = store.bindHostOfficeLocalDirectoryScopeAuthorityV2.bind(store);
  t.mock.method(store, "bindHostOfficeLocalDirectoryScopeAuthorityV2", (ticket, value) => {
    const result = bindAuthority(ticket, value);
    assert.equal(authority, undefined, "observe exactly one real production binding, never mint a second authority");
    authority = value;
    boundTicket = ticket;
    return result;
  });
  registry = supervisor.getProtectedHostStageRegistry();
  const hostRuntime = supervisor.getRuntime(cwd, store);
  runtime ??= supervisor.getOfficeLocalNativeRuntime(cwd, store);
  entries = readOriginalProtectedHostActorEntries();
  assert.ok(Object.isFrozen(entries)); assert.equal(entries.length, 20);
  assert.deepEqual(entries.map(entry => readProtectedHostActorEntry(entry).entryId).sort(), Object.keys(PROTECTED_HOST_ACTOR_ENTRIES).sort());
  registry.assertActorInventoryCurrent();

  const at = new Date().toISOString(), id = `original-writer-${randomUUID()}`;
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: id,
    idempotencyKey: id, status: "running", createdByActor: "system", request: {}, now: at });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: hostRuntime.runtimeInstanceId, runnerId: "pi", status: "started", now: at });
  const policy = resolveSessionRunPolicy({ workspacePolicy: store.getApprovalPolicy(), authorizationMode: "always",
    workspaceAccessMode: "workspace_write" }).snapshot;
  store.createRun({ id, cwd, workUnitId: unit.id, taskId: "original-writer-task", providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: { effectivePolicySnapshot: policy }, createdAt: at });
  store.linkRunToWorkUnit(id, unit.id, at); store.markRunStarted(id, at);
  const source = { runId: id, ...toRuntimeAttemptFence(attempt) }, toolCallId = `original-writer-call-${randomUUID()}`;
  const baseBroker = createDefaultMcpBroker(), factory = createHostOfficeLocalGenerationFacade({ baseBroker, workspaceCwd: cwd, facade: baseBroker });
  const server = store.createMcpServer({ id: OFFICE_DOCUMENTS_MCP_SERVER_ID, displayName: "Original local Office",
    enabled: true, required: false, transport: { type: "streamable-http", url: "http://127.0.0.1:1/never-used", headers: {}, secretHeaderRefs: {} } }, at);
  store.replaceMcpServerTools(server.id, officeDocumentTools, at);
  const rawName = { docx: "office_create_document", xlsx: "office_create_workbook", pptx: "office_create_presentation" }[format];
  assert.ok(rawName);
  tracker = new AttemptHostOperationTracker({ store, source });
  const controller = new AbortController();
  const request = format === "xlsx" ? { path, sheets: [{ name: "Summary", rows: [["Original production adapter", 42]] }] }
    : format === "pptx" ? { path, slides: [{ title: "Original production adapter", bullets: ["Genuine OOXML"] }] }
    : { path, blocks: [{ type: "paragraph", text: "Genuine original Host writer, terminal, certificate and protection lease." }] };
  const closeWindow = store.closeHostOfficeLocalDirectoryWindowV2.bind(store);
  t.mock.method(store, "closeHostOfficeLocalDirectoryWindowV2", ticket => {
    const claim = closeWindow(ticket);
    originalCloseClaim = claim;
    if (state) {
      // Observe the original returned closure while membership is still pending;
      // teardown cannot resurrect it after production lease release.
      const closed = runtime.readCoreWindowClosure(state.scope);
      assert.equal(closed.phase, "closed_pending");
      assert.ok([...closed.stage, ...closed.destination].every(row => row.state === "closed" && row.close === "returned"));
      originalClosedSnapshot = closed;
    }
    return claim;
  });
  const common = { root, cwd, daemon, supervisor, store, registry, hostRuntime, runtime, tracker, controller,
    source, request, rawName, server, factory, baseBroker, toolCallId, diagnostic: message => t.diagnostic(message),
    unboundActorGate: () => registry.assertActorEntryLaunchCurrent(
      entries.find(entry => readProtectedHostActorEntry(entry).entryId === "macos_native_command"), undefined, false) };
  if (!preparePlan) return common;
  const reservation = reserveOfficeLocalWriter(tracker, store, toolCallId, cwd);
  const { authority: mcpAuthority } = captureMcpResultAuthority(store, server.id, rawName);
  bindOfficeLocalMcpForwardAuthority(reservation, { authority: mcpAuthority, originalBroker: factory, factory, signal: controller.signal });
  const snapshot = captureOfficeLocalReservationSnapshot(reservation, path, format);
  const artifact = await prepareOfficeArtifact(rawName, request, undefined, controller.signal);
  assert.ok(Buffer.isBuffer(artifact.bytes) && artifact.bytes.length > 0);
  bootstrapOfficeLocalDirectoryScope(reservation, runtime);
  const plan = prepareOfficeLocalDirectoryWrite(reservation, snapshot, artifact, digest(request), digest(policy));
  state = officeLocalDirectoryWriteState(plan); facts = runtime.scopeFacts(state.scope);
  assert.ok(authority, "original production preparation must capture and bind its real authority");
  const actor = registry.captureActorSource({ ...state.binding, command: "true", toolCallId: `original-writer-actor-${randomUUID()}` });
  const closeOriginalWindow = () => {
    const claim = store.closeHostOfficeLocalDirectoryWindowV2(state.ticket);
    // Retain only a snapshot returned by the genuine original reader before
    // Registry membership is released. It authorizes no proof/release action;
    // teardown uses these observed close returns instead of resurrecting an
    // intentionally retired product membership or physically reclosing an FD.
    const closed = runtime.readCoreWindowClosure(state.scope);
    assert.equal(closed.phase, "closed_pending");
    assert.ok(Object.isFrozen(closed) && [...closed.stage, ...closed.destination]
      .every(row => Object.isFrozen(row) && row.state === "closed" && row.close === "returned"));
    originalClosedSnapshot = closed;
    return claim;
  };
  return { ...common, reservation, plan, state, facts, authority, artifact, actor, closeOriginalWindow,
    execution: () => store.getHostOfficeLocalDirectoryExecutionV2(plan.executionId),
    effects: () => store.listHostOfficeLocalDirectoryEffectsV2(plan.executionId),
    terminal: () => store.getHostOfficeLocalDirectoryTerminalV2(plan.executionId),
    pairRows: () => [state.execution.parentOperationId, state.execution.producerOperationId].map(operationId => store.getHostOperation(operationId)),
    leaseRoots: () => registry.protectedRoots(actor) };
}
