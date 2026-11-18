import { resolveStoragePaths, SqliteRunStore } from "@ling-stack/core";
import { createRuntimeHostCapacityStoreBinding, HostRunCapacityStore, RuntimeHostCapacityBridge } from "@ling-stack/core/runtime-host-capacity-store-bridge";
import { createDaemonServer } from "../../dist/index.js";
import { RuntimeSupervisor } from "../../dist/runtime/supervisor.js";
import { observeNodeRerunAdmission } from "../../dist/features/runs/node-rerun-observation.js";
import { observePreparedNodeRerunExecution } from "../../dist/features/runs/node-rerun-local-execution.js";
import { readStoredRunnerExecution } from "../../dist/features/runs/existing-run-request.js";
import { prepareNodeRerunTargetExecution } from "../../dist/features/runs/node-rerun-targets.js";
import { createFixture, prepareInput } from "./node-rerun-fixture.ts";

const phase = process.argv[2];
const home = process.argv[3];
const cwd = process.argv[4];
const recordId = process.argv[5];

function send(message) {
  if (process.send) process.send(message);
}

function now() {
  return new Date().toISOString();
}

async function seed() {
  const fakeTestContext = { after() {} };
  const capacity = createRuntimeHostCapacityStoreBinding();
  const fixture = await createFixture(fakeTestContext, {
    preparedExecution: true,
    runtimeHostCapacityBinding: capacity.binding,
  });
  const supervisor = new RuntimeSupervisor({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: fixture.cwd,
    runners: {},
    runtimeTools: {},
    channels: {},
    sandbox: {},
    harness: {},
    transports: { providerWebSocketFallback: true, localWebSocketRpc: true },
  });
  const runtime = supervisor.getRuntime(fixture.cwd, fixture.store);
  const prepared = fixture.store.prepareNodeRerunIntent(prepareInput(fixture));
  if (prepared.status !== "created") throw new Error(`rerun intent seed failed: ${prepared.status}`);
  const record = prepared.record;
  const preparedAt = now();
  const revalidate = intent => observeNodeRerunAdmission({
    store: fixture.store,
    activeRuns: fixture.activeRuns,
    intent,
    now: preparedAt,
  });
  const approval = fixture.store.requestNodeRerunApproval({ recordId: record.id, now: preparedAt, revalidate });
  if (approval.status !== "created") throw new Error(`rerun approval seed failed: ${approval.status}`);
  fixture.store.approveApprovalRequest(approval.approval.id, {
    resolvedBy: "local-user",
    decisionKind: "approve_once",
  }, preparedAt);
  const preparedTarget = fixture.store.prepareNodeRerunTarget({
    recordId: record.id,
    now: preparedAt,
    runtimeInstanceId: runtime.runtimeInstanceId,
    revalidate,
    prepareExecution: (source, taskId) => prepareNodeRerunTargetExecution(
      fixture.store,
      source,
      fixture.target.attempt.id,
      taskId,
    ),
  });
  if (preparedTarget.status !== "created") throw new Error(`rerun target seed failed: ${preparedTarget.status}`);
  const target = preparedTarget.target;
  const host = new HostRunCapacityStore({ globalDatabasePath: resolveStoragePaths(fixture.cwd).user.globalDatabasePath });
  const journal = capacity.workspace(target.workspaceId);
  const input = {
    recordId: record.id,
    now: now(),
    revalidate: intent => observeNodeRerunAdmission({ store: fixture.store, activeRuns: fixture.activeRuns, intent, now: now() }),
    observeLocalExecution: candidate => observePreparedNodeRerunExecution(fixture.activeRuns, candidate),
    validateExecution: candidate => Boolean(readStoredRunnerExecution(candidate)),
  };
  const preparedCapacity = journal.prepareNodeRerunCapacity(input);
  if (preparedCapacity.status !== "prepared") throw new Error(`rerun capacity seed failed: ${preparedCapacity.status}`);
  if (host.installPolicy({ expectedRevision: 0, maxConcurrentRuns: 1, installedAt: now() }).status !== "installed") {
    throw new Error("Host capacity policy seed failed");
  }
  const bridge = new RuntimeHostCapacityBridge(journal, host);
  const reserved = bridge.reserveNodeRerunTarget(input);
  if (reserved.status !== "reserved") throw new Error(`rerun Host reservation seed failed: ${reserved.status}`);
  const admitted = bridge.admitNodeRerunResources(input);
  if (admitted.status !== "admitted") throw new Error(`rerun resource admission seed failed: ${admitted.status}`);
  const reference = { intentId: reserved.record.intent.intentId, dispatchToken: reserved.record.dispatchToken };
  const dispatched = fixture.store.dispatchNodeRerunTarget({ recordId: record.id, now: now(), hostCapacity: reference });
  if (dispatched.status !== "admitted") throw new Error(`rerun dispatch seed failed: ${dispatched.status}`);
  const result = { type: "seeded", pid: process.pid, cwd: fixture.cwd, recordId: record.id };
  supervisor.releaseAll();
  fixture.store.close();
  host.close();
  send(result);
}

async function recover() {
  if (!cwd) throw new Error("recovery cwd is required");
  let store;
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
    runners: {},
    runtimeTools: {},
    channels: { intentSelector: false, terminalReports: false },
    concurrency: {
      enabled: true,
      maxConcurrentRuns: 1,
      maxReadOnlyRuns: 1,
      maxWorkspaceWriteRuns: 1,
      maxRunsPerProvider: 1,
      maxRunsPerRunner: 1,
      isolatedWriteMaxConcurrentSteps: 2,
    },
  }, {
    onStoreInitialized: initialized => { store = initialized; },
  });
  await daemon.start();
  if (!store) throw new Error("daemon did not initialize the workspace store");
  await daemon.stop({ waitForOwnedDrain: false });
  const recoveredStore = new SqliteRunStore({ cwd });
  const host = new HostRunCapacityStore({ globalDatabasePath: resolveStoragePaths(cwd).user.globalDatabasePath });
  const target = recordId ? recoveredStore.getNodeRerunTarget(recordId) : undefined;
  if (!target) throw new Error("rerun target missing after daemon restart");
  const events = recoveredStore.listRuntimeEvents(target.fence.workUnitId, { complete: true })
    .filter(event => event.type === "diagnostic_stuck_detected");
  const held = host.listHeld().reservations;
  const result = {
    type: "recovered",
    pid: process.pid,
    recovery: { observed: held.length, released: 0, unknown: events.length },
    capacity: host.counts(),
    target: {
      runStatus: recoveredStore.getRun(target.runId)?.status,
      workUnitStatus: recoveredStore.getWorkUnit(target.fence.workUnitId)?.status,
      attemptStatus: recoveredStore.getWorkUnitAttempt(target.fence.attemptId)?.status,
    },
    unknownDiagnostics: events.length,
  };
  recoveredStore.close();
  host.close();
  send(result);
}

try {
  if (phase === "seed") await seed();
  else if (phase === "recover") await recover();
  else throw new Error(`unknown phase: ${phase}`);
} catch (error) {
  send({ type: "error", error: String(error?.stack ?? error) });
  process.exitCode = 1;
}
