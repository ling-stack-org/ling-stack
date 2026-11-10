import { mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../../../core/dist/index.js";
import { directoryV2Prepared, directoryV2Capture, directoryV2Clone, directoryV2Hash }
  from "../../../core/test/support/host-office-local-directory-v2-fixture.mjs";
import { AttemptHostOperationTracker } from "../../dist/runtime/attempt-host-operation-tracker.js";

export const officeDirectoryTrackerNow = () => new Date().toISOString();
export const requiredOfficeDirectoryInput = Object.freeze({ kind: "user_input_required", requestId: "directory-v2-drain", requestVersion: 1 });

/** A legal v1 preparation for a real original ticket, never a v2 capability or native execution claim. */
function v1Prepared(f) {
  const stat = statSync(f.cwd, { bigint: true }), targetPath = join(f.cwd, "v1.docx");
  return { schemaVersion: 1, protocol: "ling-office-local-binary-v1", executionId: "original-v1-execution", source: f.source,
    parentOperationId: f.parent.operationId, producerOperationId: f.producer.operationId, toolCallId: f.toolCallId,
    toolName: "office_create_document", format: "docx", workspacePath: f.cwd,
    workspaceIdentity: { device: String(stat.dev), inode: String(stat.ino), sizeBytes: Number(stat.size),
      modifiedNs: String(stat.mtimeNs), changedNs: String(stat.ctimeNs) }, targetPath, overwrite: false,
    requestDigest: "a".repeat(64), policyDigest: "b".repeat(64), input: { state: "absent" },
    output: { sizeBytes: Buffer.byteLength("v1 output"), bytesSha256: directoryV2Hash("v1 output") },
    members: [{ memberId: "target", role: "target", path: targetPath, initial: { state: "absent" } },
      { memberId: "temporary", role: "temporary", path: join(f.cwd, ".original-v1.tmp"), initial: { state: "absent" } }],
    preparedAt: officeDirectoryTrackerNow() };
}

/**
 * Real migrated SQLite, current attempt, tracker-issued handles and Core-issued opaque Office tickets.
 * Prepared/capture DTOs are controlled contract facts only: no native syscall, scope issuance or safe proof.
 */
export async function officeDirectoryTrackerFixture(t, { prepare = true, version = 2 } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-office-directory-tracker-"));
  const store = createSqliteRunStore(cwd), other = createSqliteRunStore(cwd);
  t.after(async () => { other.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const at = officeDirectoryTrackerNow();
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "unit", status: "running", createdByActor: "system", request: {}, now: at });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "office-directory-original",
    runnerId: "pi", status: "started", now: at });
  store.createRun({ id: "run", cwd, workUnitId: unit.id, taskId: "task", providerName: "test", providerModel: "test",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: at });
  store.linkRunToWorkUnit("run", unit.id, at); store.markRunStarted("run", at);
  const source = { runId: "run", ...toRuntimeAttemptFence(attempt) }, toolCallId = "office-directory-call";
  const tracker = new AttemptHostOperationTracker({ store, source });
  const parent = tracker.beginHostCall("mcp", toolCallId), producer = tracker.registerProducer(parent, "file_mutation", "office-local-binary");
  const f = { cwd, store, other, unit, attempt, source, toolCallId, tracker, parent, producer,
    group: tracker.executorGroup, now: officeDirectoryTrackerNow };
  f.seal = payload => store.createArtifact({ runId: source.runId, type: "json", path: "office/directory-tracker-facts.json",
    sealedPayload: payload, createdAt: f.now() });
  f.prepared = version === 1 ? v1Prepared(f) : directoryV2Prepared({ workspacePath: cwd,
    stagePath: "/private/ling-history-only-stage", source, toolCallId, parentOperationId: parent.operationId,
    producerOperationId: producer.operationId, preparedAt: f.now() });
  const artifact = f.seal(f.prepared);
  f.input = { executionId: f.prepared.executionId, preparedArtifactId: artifact.id, preparedDigest: artifact.contentSha256 };
  f.prepare = () => {
    f.ticket = version === 1 ? tracker.prepareOfficeLocalExecution(parent, producer, f.input)
      : tracker.prepareOfficeLocalDirectoryExecutionV2(parent, producer, f.input);
    return f.ticket;
  };
  f.execution = () => store.getHostOfficeLocalDirectoryExecutionV2(f.ticket.executionId);
  f.effect = (input = {}) => tracker.prepareOfficeLocalDirectoryEffectV2(f.ticket,
    { effectId: "capture", ordinal: 0, kind: "capture_parents", mode: "forward", preparedAt: f.now(), ...input });
  f.cleanup = () => f.effect({ effectId: "cleanup", ordinal: 1, kind: "close_session", mode: "cleanup" });
  f.pairRows = (reader = other) => [parent, producer].map(handle => reader.getHostOperation(handle.operationId));
  f.pairStates = () => f.group.getSnapshot().operations.filter(row => [parent.operationId, producer.operationId].includes(row.ticket.id))
    .map(row => row.state);
  f.replaceOwner = () => store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 2, runtimeInstanceId: "office-directory-successor",
    runnerId: "pi", status: "started", now: f.now() });
  f.capture = ({ success = true, beforeReturn } = {}) => {
    const effect = f.effect(); let observation;
    const result = tracker.launchOfficeLocalDirectoryEffectV2(f.ticket, effect.effectId, () => {
      const current = store.listHostOfficeLocalDirectoryEffectsV2(f.ticket.executionId)[0];
      observation = directoryV2Capture(f.execution(), current, { success });
      observation.native.calledAt = f.now(); observation.native.returnedAt = f.now(); observation.completedAt = f.now();
      beforeReturn?.(observation);
      return observation.native.result;
    }, "forward");
    const artifact = f.seal(observation), row = tracker.recordOfficeLocalDirectoryObservationV2(f.ticket, effect.effectId, artifact.id);
    return { effect: row, observation, artifact, result };
  };
  if (prepare) f.prepare();
  return f;
}

/** Exact failed capture roster, not a publication/canonical-visibility certificate. */
export function failedOfficeDirectoryTerminal(f, item) {
  const execution = f.execution();
  const resources = [...execution.stage.ancestors, ...execution.destination.ancestors,
    ...execution.members.flatMap(member => [{ resourceSlotId: member.resourceSlotId }, { resourceSlotId: member.publicationResourceSlotId }])]
    .map(slot => ({ resourceSlotId: slot.resourceSlotId, state: "not_acquired" }));
  return { schemaVersion: 2, protocol: execution.protocol, kind: "office_local_directory_terminal_v2", executionId: execution.executionId,
    executionIdentityDigest: execution.identityDigest, source: directoryV2Clone(execution.source), preparedArtifactId: execution.preparedArtifactId,
    preparedDigest: execution.preparedDigest, outcome: "failed", installationEntered: false,
    effects: [{ ordinal: item.effect.ordinal, effectId: item.effect.effectId, effectDigest: item.effect.effectDigest, enteredAt: item.effect.enteredAt,
      observation: { artifactId: item.artifact.id, digest: item.artifact.contentSha256 } }], resources,
    canonicalVisibility: { state: "unverified", blockerCode: "original_destination_ancestor_window_unissued" }, completedAt: f.now() };
}
