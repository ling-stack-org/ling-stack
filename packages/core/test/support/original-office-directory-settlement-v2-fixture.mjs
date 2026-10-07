import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRunStore, createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../../dist/index.js";
import { createOriginalOfficeHostBridgeForComposition, sealOriginalOfficeHostBridgeForComposition,
  mintOriginalOfficeDirectoryAuthorityV2, retireOriginalOfficeHostBridgeForComposition } from "../../dist/original-office-host-bridge.js";
import { directoryV2ReplayClone as clone, directoryV2ReplayFixture } from "./host-office-local-directory-v2-replay-fixture.mjs";

/**
 * Real SQLite reservations, original tickets, sealed artifacts and transactions.
 * The complete native graph and fixed Host endpoint are controlled mechanism
 * fixtures: /workspace and /stage are virtual historical namespaces, not actual
 * kernel resources, OOXML output, production Host or packaged acceptance.
 */
export async function originalOfficeDirectorySettlementV2Fixture(t, { bind = true, complete = true, closed = true,
  close, assertClosed } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-core-office-directory-settlement-v2-"));
  const bridge = createOriginalOfficeHostBridgeForComposition();
  const store = new SqliteRunStore({ cwd, originalOfficeHostBridge: bridge.reader });
  const other = createSqliteRunStore(cwd);
  t.after(async () => { other.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = () => new Date().toISOString(), graph = directoryV2ReplayFixture({ directoryCount: 1, sizeBytes: 1 });
  const at = now(), unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run",
    ownerId: "run", idempotencyKey: "directory-settlement-unit", status: "running", createdByActor: "system", request: {}, now: at });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "directory-settlement-runtime", runnerId: "pi", status: "started", now: at });
  const run = store.createRun({ id: "run", cwd: graph.execution.workspacePath, workUnitId: unit.id, taskId: "task",
    providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: at });
  store.linkRunToWorkUnit(run.id, unit.id, at); store.markRunStarted(run.id, at);
  const source = { runId: run.id, ...toRuntimeAttemptFence(attempt) }, toolCallId = "directory-settlement-call";
  const parent = store.admitHostOperation({ operationId: "directory-settlement-parent", source, kind: "mcp", toolCallId });
  const producer = store.admitHostOperation({ operationId: "directory-settlement-producer", source, kind: "file_mutation",
    toolCallId, parentOperationId: parent.operationId, producerId: "office-local-binary" });
  const { preparedArtifactId: _preparedArtifact, preparedDigest: _preparedDigest, identityDigest: _identity,
    revision: _revision, ...prepared } = clone(graph.execution);
  Object.assign(prepared, { source, parentOperationId: parent.operationId, producerOperationId: producer.operationId,
    toolCallId, preparedAt: now() });
  const seal = payload => store.createArtifact({ runId: run.id, type: "json", path: "office/directory-settlement-v2-facts.json",
    sealedPayload: payload, createdAt: now() });
  const preparation = seal(prepared), ticket = store.prepareHostOfficeLocalDirectoryExecutionV2(parent, producer,
    { executionId: prepared.executionId, preparedArtifactId: preparation.id, preparedDigest: preparation.contentSha256 });
  const execution = () => store.getHostOfficeLocalDirectoryExecutionV2(ticket.executionId);
  const expected = execution(), custody = Object.freeze({}), counts = { binding: 0, close: 0, assertClosed: 0, native: 0 };
  const state = { phase: "active" };
  const checkEndpoint = (received, actual) => {
    assert.equal(received, custody); assert.deepEqual(actual, expected);
    assert.ok(Object.isFrozen(actual) && Object.isFrozen(actual.source) && Object.isFrozen(actual.stage.ancestors));
    assert.throws(() => store.database.exec("CREATE TABLE forbidden_settlement_endpoint_write(value TEXT)"), /readonly/i);
  };
  const f = { cwd, store, other, source, parent, producer, ticket, expected, execution, seal, now, graph, counts, state,
    bridge, claim: undefined };
  sealOriginalOfficeHostBridgeForComposition(bridge.setup, store, Object.freeze({
    assertBinding(received, actual) { checkEndpoint(received, actual); counts.binding++; },
    closeBoundWindow(received, actual) {
      checkEndpoint(received, actual); counts.close++;
      if (close) return close(f);
      state.phase = "closed_pending";
    },
    assertClosedBoundWindow(received, actual) {
      checkEndpoint(received, actual); counts.assertClosed++;
      if (assertClosed) return assertClosed(f);
      assert.equal(state.phase, "closed_pending", "original mechanism closure is unknown");
    },
  }));
  f.authority = mintOriginalOfficeDirectoryAuthorityV2(bridge.setup, custody);
  if (bind) store.bindHostOfficeLocalDirectoryScopeAuthorityV2(ticket, f.authority);
  f.complete = () => {
    for (const item of graph.effects) {
      const { executionId: _executionId, effectDigest: _effectDigest, enteredAt: _enteredAt,
        observationArtifactId: _observationArtifactId, revision: _effectRevision, ...descriptor } = clone(item.effect);
      descriptor.preparedAt = now();
      const effect = store.prepareHostOfficeLocalDirectoryEffectV2(ticket, descriptor);
      let observation;
      store.launchHostOfficeLocalDirectoryEffectV2(ticket, effect.effectId, () => {
        const entered = store.listHostOfficeLocalDirectoryEffectsV2(ticket.executionId).at(-1);
        observation = clone(item.observation);
        Object.assign(observation, { executionId: ticket.executionId, executionIdentityDigest: expected.identityDigest,
          source: clone(source), effectId: entered.effectId, effectDigest: entered.effectDigest });
        observation.native.calledAt = now(); observation.native.returnedAt = now(); observation.completedAt = now();
        counts.native++;
        return observation.native.result;
      });
      const artifact = seal(observation);
      store.recordHostOfficeLocalDirectoryObservationV2(ticket, effect.effectId, artifact.id);
    }
    const { terminalArtifactId: _terminalArtifact, terminalDigest: _terminalDigest, effectSetDigest: _effectSetDigest,
      effectCount: _effectCount, sealedAt: _sealedAt, ...manifest } = clone(graph.terminal);
    Object.assign(manifest, { executionId: ticket.executionId, executionIdentityDigest: expected.identityDigest,
      source: clone(source), preparedArtifactId: expected.preparedArtifactId, preparedDigest: expected.preparedDigest,
      completedAt: now(), effects: store.listHostOfficeLocalDirectoryEffectsV2(ticket.executionId).map(effect => ({
        ordinal: effect.ordinal, effectId: effect.effectId, effectDigest: effect.effectDigest, enteredAt: effect.enteredAt,
        observation: { artifactId: effect.observationArtifactId, digest: store.getArtifact(effect.observationArtifactId).contentSha256 },
      })) });
    const terminalArtifact = seal(manifest);
    f.terminal = store.sealHostOfficeLocalDirectoryTerminalV2(ticket,
      { terminalArtifactId: terminalArtifact.id, terminalDigest: terminalArtifact.contentSha256 });
    return f.terminal;
  };
  f.close = () => { f.claim = store.closeHostOfficeLocalDirectoryWindowV2(ticket); return f.claim; };
  f.settle = () => store.settleHostOfficeLocalDirectoryExecutionV2(ticket);
  f.certificates = (reader = other) => reader.database.prepare("SELECT * FROM host_office_local_directory_v2_certificates ORDER BY execution_id").all();
  f.rawPair = (reader = other) => reader.database.prepare("SELECT * FROM host_operations WHERE operation_id IN (?,?) ORDER BY operation_id")
    .all(parent.operationId, producer.operationId);
  f.reserve = (id, parentId = parent.operationId, reader = store, kind = "hydration") => reader.admitHostOperation({
    operationId: id, source, kind, toolCallId, parentOperationId: parentId, producerId: id,
  });
  f.finish = (child, reader = store) => reader.settleHostOperation(child, { kind: "known_no_start", settledAt: now() });
  f.retire = () => retireOriginalOfficeHostBridgeForComposition(bridge.setup, store);
  if (complete) f.complete();
  if (closed) f.close();
  return f;
}
