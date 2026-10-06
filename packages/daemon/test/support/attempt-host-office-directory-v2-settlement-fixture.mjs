import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRunStore, createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../../../core/dist/index.js";
import { createOriginalOfficeHostBridgeForComposition, sealOriginalOfficeHostBridgeForComposition,
  mintOriginalOfficeDirectoryAuthorityV2, retireOriginalOfficeHostBridgeForComposition } from "../../../core/dist/original-office-host-bridge.js";
import { directoryV2ReplayClone as clone, directoryV2ReplayFixture }
  from "../../../core/test/support/host-office-local-directory-v2-replay-fixture.mjs";
import { AttemptHostOperationTracker } from "../../dist/runtime/attempt-host-operation-tracker.js";

/**
 * Real SQLite, original Tracker/Core tickets, sealed history and committed grants.
 * Explicit Host endpoint/native-graph mechanism fixtures only: no real FD/native
 * custody, Registry lease release, OOXML output, product or packaged acceptance.
 */
export async function officeDirectoryTrackerSettlementFixture(t, { complete = true, close, assertClosed } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-office-directory-tracker-settlement-"));
  const bridge = createOriginalOfficeHostBridgeForComposition();
  const store = new SqliteRunStore({ cwd, originalOfficeHostBridge: bridge.reader }), other = createSqliteRunStore(cwd);
  t.after(async () => { other.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = () => new Date().toISOString(), graph = directoryV2ReplayFixture({ directoryCount: 1, sizeBytes: 1 }), at = now();
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "tracker-directory-settlement-unit", status: "running", createdByActor: "system", request: {}, now: at });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "tracker-directory-runtime",
    runnerId: "pi", status: "started", now: at });
  const run = store.createRun({ id: "run", cwd: graph.execution.workspacePath, workUnitId: unit.id, taskId: "task",
    providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: at });
  store.linkRunToWorkUnit(run.id, unit.id, at); store.markRunStarted(run.id, at);
  const source = { runId: run.id, ...toRuntimeAttemptFence(attempt) }, tracker = new AttemptHostOperationTracker({ store, source });
  const parent = tracker.beginHostCall("mcp", "tracker-directory-call"), producer = tracker.registerProducer(parent, "file_mutation", "office-local-binary");
  const { preparedArtifactId: _preparedArtifact, preparedDigest: _preparedDigest, identityDigest: _identity,
    revision: _revision, ...prepared } = clone(graph.execution);
  Object.assign(prepared, { source, parentOperationId: parent.operationId, producerOperationId: producer.operationId,
    toolCallId: parent.toolCallId, preparedAt: now() });
  const seal = payload => store.createArtifact({ runId: run.id, type: "json", path: "office/tracker-directory-settlement.json",
    sealedPayload: payload, createdAt: now() });
  const preparation = seal(prepared), ticket = tracker.prepareOfficeLocalDirectoryExecutionV2(parent, producer,
    { executionId: prepared.executionId, preparedArtifactId: preparation.id, preparedDigest: preparation.contentSha256 });
  const expected = store.getHostOfficeLocalDirectoryExecutionV2(ticket.executionId), custody = Object.freeze({});
  const counts = { binding: 0, close: 0, assertClosed: 0, invocations: 0 }, state = { phase: "active" };
  const group = tracker.executorGroup, f = { cwd, store, other, bridge, source, tracker, parent, producer, ticket,
    expected, graph, counts, state, group, seal, now };
  const check = (received, actual) => { assert.equal(received, custody); assert.deepEqual(actual, expected); };
  sealOriginalOfficeHostBridgeForComposition(bridge.setup, store, Object.freeze({
    assertBinding(received, actual) { check(received, actual); counts.binding++; },
    closeBoundWindow(received, actual) { check(received, actual); counts.close++; if (close) return close(f); state.phase = "closed_pending"; },
    assertClosedBoundWindow(received, actual) {
      check(received, actual); counts.assertClosed++; if (assertClosed) return assertClosed(f);
      assert.equal(state.phase, "closed_pending");
    },
  }));
  f.authority = mintOriginalOfficeDirectoryAuthorityV2(bridge.setup, custody);
  store.bindHostOfficeLocalDirectoryScopeAuthorityV2(ticket, f.authority);
  f.pairRows = (reader = other) => [parent, producer].map(handle => reader.getHostOperation(handle.operationId));
  f.pairStates = () => group.getSnapshot().operations.filter(row => [parent.operationId, producer.operationId].includes(row.ticket.id)).map(row => row.state);
  f.rawPair = () => other.database.prepare("SELECT * FROM host_operations WHERE operation_id IN (?,?) ORDER BY operation_id")
    .all(parent.operationId, producer.operationId);
  f.retire = () => retireOriginalOfficeHostBridgeForComposition(bridge.setup, store);
  f.complete = () => {
    for (const item of graph.effects) {
      const { executionId: _executionId, effectDigest: _effectDigest, enteredAt: _enteredAt,
        observationArtifactId: _observationArtifactId, revision: _effectRevision, ...descriptor } = clone(item.effect);
      descriptor.preparedAt = now();
      const effect = tracker.prepareOfficeLocalDirectoryEffectV2(ticket, descriptor);
      let observation;
      tracker.launchOfficeLocalDirectoryEffectV2(ticket, effect.effectId, () => {
        const entered = store.listHostOfficeLocalDirectoryEffectsV2(ticket.executionId).at(-1);
        observation = clone(item.observation);
        Object.assign(observation, { executionId: ticket.executionId, executionIdentityDigest: expected.identityDigest,
          source: clone(source), effectId: entered.effectId, effectDigest: entered.effectDigest });
        observation.native.calledAt = now(); observation.native.returnedAt = now(); observation.completedAt = now();
        counts.invocations++; return observation.native.result;
      }, effect.mode);
      const artifact = seal(observation);
      tracker.recordOfficeLocalDirectoryObservationV2(ticket, effect.effectId, artifact.id);
    }
    const { terminalArtifactId: _terminalArtifact, terminalDigest: _terminalDigest, effectSetDigest: _effectSetDigest,
      effectCount: _effectCount, sealedAt: _sealedAt, ...manifest } = clone(graph.terminal);
    Object.assign(manifest, { executionId: ticket.executionId, executionIdentityDigest: expected.identityDigest,
      source: clone(source), preparedArtifactId: expected.preparedArtifactId, preparedDigest: expected.preparedDigest,
      completedAt: now(), effects: store.listHostOfficeLocalDirectoryEffectsV2(ticket.executionId).map(effect => ({
        ordinal: effect.ordinal, effectId: effect.effectId, effectDigest: effect.effectDigest, enteredAt: effect.enteredAt,
        observation: { artifactId: effect.observationArtifactId, digest: store.getArtifact(effect.observationArtifactId).contentSha256 },
      })) });
    const terminal = seal(manifest);
    f.terminal = tracker.sealOfficeLocalDirectoryTerminalV2(ticket,
      { terminalArtifactId: terminal.id, terminalDigest: terminal.contentSha256 });
    return f.terminal;
  };
  if (complete) f.complete();
  return f;
}
