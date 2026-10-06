import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_ID, resolveSessionRunPolicy, toRuntimeAttemptFence } from "@ling-stack/core";
import { OFFICE_DOCUMENTS_MCP_SERVER_ID } from "@ling-stack/contracts";
import { resolveConfig } from "../../dist/config.js";
import { RuntimeSupervisor } from "../../dist/runtime/supervisor.js";
import { AttemptHostOperationTracker } from "../../dist/runtime/attempt-host-operation-tracker.js";
import { createDefaultMcpBroker, createHostOfficeLocalGenerationFacade } from "../../dist/features/mcp/broker.js";
import { captureMcpResultAuthority } from "../../dist/features/mcp/result-authority.js";
import { officeDocumentTools } from "../../dist/features/plugins/office-documents-generation-broker.js";
import { prepareOfficeArtifact } from "../../dist/features/office-documents/office-artifact-preparation.js";
import { reserveOfficeLocalWriter, bindOfficeLocalMcpForwardAuthority, captureOfficeLocalReservationSnapshot,
  bootstrapOfficeLocalDirectoryScope, prepareOfficeLocalDirectoryWrite, officeLocalDirectoryWriteState }
  from "../../dist/features/office-documents/office-local-authority.js";
import { captureOriginalOfficeDirectoryAuthorityV2, createOriginalOfficeDirectoryStoreFactory }
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
export async function createOriginalOfficeDirectoryCompositionFixture(t, { path = "reports/nested/report.docx" } = {}) {
  const root = realpathSync(mkdtempSync("/private/tmp/ling-office-original-writer-")), cwd = join(root, "workspace");
  mkdirSync(cwd, { mode: 0o755 }); chmodSync(cwd, 0o755);
  let supervisor, store, runtime, state, facts, originalClosedSnapshot;
  t.after(() => {
    let cleanupKnown = true;
    try {
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
      try { supervisor?.releaseAll(); }
      finally {
        store?.close();
        if (cleanupKnown) {
          if (facts) rmSync(facts.stagePath, { recursive: true, force: true });
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  });
  supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }), undefined,
    { officeLocalNativeArtifact: reviewedNativeArtifact() }); // Do not supply actorEntries.
  store = createOriginalOfficeDirectoryStoreFactory(supervisor)(cwd);
  const registry = supervisor.getProtectedHostStageRegistry(), hostRuntime = supervisor.getRuntime(cwd, store);
  runtime = supervisor.getOfficeLocalNativeRuntime(cwd, store);
  const entries = readOriginalProtectedHostActorEntries();
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
  const tracker = new AttemptHostOperationTracker({ store, source }), controller = new AbortController();
  const reservation = reserveOfficeLocalWriter(tracker, store, toolCallId, cwd);
  const { authority: mcpAuthority } = captureMcpResultAuthority(store, server.id, "office_create_document");
  bindOfficeLocalMcpForwardAuthority(reservation, { authority: mcpAuthority, originalBroker: factory, factory, signal: controller.signal });
  const request = { path, blocks: [{ type: "paragraph", text: "Genuine original Host writer, terminal, certificate and protection lease." }] };
  const snapshot = captureOfficeLocalReservationSnapshot(reservation, path, "docx");
  const artifact = await prepareOfficeArtifact("office_create_document", request, undefined, controller.signal);
  assert.ok(Buffer.isBuffer(artifact.bytes) && artifact.bytes.length > 0);
  bootstrapOfficeLocalDirectoryScope(reservation, runtime);
  const plan = prepareOfficeLocalDirectoryWrite(reservation, snapshot, artifact, digest(request), digest(policy));
  state = officeLocalDirectoryWriteState(plan); facts = runtime.scopeFacts(state.scope);
  const authority = captureOriginalOfficeDirectoryAuthorityV2(store, runtime, state.scope);
  store.bindHostOfficeLocalDirectoryScopeAuthorityV2(state.ticket, authority);
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
  return { root, cwd, supervisor, store, registry, hostRuntime, runtime, tracker, controller, reservation, plan, state, facts,
    authority, source, request, artifact, actor, closeOriginalWindow, diagnostic: message => t.diagnostic(message),
    unboundActorGate: () => registry.assertActorEntryLaunchCurrent(
      entries.find(entry => readProtectedHostActorEntry(entry).entryId === "macos_native_command"), undefined, false),
    execution: () => store.getHostOfficeLocalDirectoryExecutionV2(plan.executionId),
    effects: () => store.listHostOfficeLocalDirectoryEffectsV2(plan.executionId),
    terminal: () => store.getHostOfficeLocalDirectoryTerminalV2(plan.executionId),
    pairRows: () => [state.execution.parentOperationId, state.execution.producerOperationId].map(operationId => store.getHostOperation(operationId)),
    leaseRoots: () => registry.protectedRoots(actor) };
}
