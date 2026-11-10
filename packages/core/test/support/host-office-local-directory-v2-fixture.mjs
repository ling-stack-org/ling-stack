import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteRunStore, SqliteRunStore, DEFAULT_WORKSPACE_ID, HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL,
  HOST_OFFICE_LOCAL_DIRECTORY_V2_GRAPH, toRuntimeAttemptFence } from "../../dist/index.js";

export const directoryV2Clone = value => JSON.parse(JSON.stringify(value));
export const directoryV2Hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
export const directoryV2Identity = (inode, file = false, size = file ? "0" : "4096") => ({ device: "1", inode: String(inode), sizeBytes: size,
  modifiedNs: "1", changedNs: "1", mode: file ? 0o100600 : 0o040700, isFile: file, isDirectory: !file });
export function directoryV2Prepared({ workspacePath = "/workspace", stagePath = "/stage", source = {
  runId: "run", workUnitId: "work", attemptId: "attempt", runtimeInstanceId: "runtime", fencingToken: "fence" },
  parentOperationId = "parent", producerOperationId = "producer", executionId = "directory-execution", toolCallId = "call", preparedAt = "2026-10-05T00:00:00.000Z" } = {}) {
  const ancestors = (path, prefix) => ["/", ...path.split("/").filter(Boolean).map((_, index, parts) => "/" + parts.slice(0, index + 1).join("/"))]
    .map((path, index) => ({ resourceSlotId: prefix + index, path, identity: directoryV2Identity(index === 0 ? 1 : prefix === "stage-" ? 10 + index : 20 + index) }));
  const stage = ancestors(stagePath, "stage-"), destination = ancestors(workspacePath, "destination-");
  return { schemaVersion: 2, protocol: HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL, graph: HOST_OFFICE_LOCAL_DIRECTORY_V2_GRAPH,
    executionId, source, parentOperationId, producerOperationId, toolCallId, toolName: "office_create_document", format: "docx",
    workspacePath, workspaceIdentity: destination.at(-1).identity, targetPath: join(workspacePath, "new", "report.docx"), requestDigest: "a".repeat(64), policyDigest: "b".repeat(64),
    output: { bytesSha256: directoryV2Hash("actual output"), sizeBytes: Buffer.byteLength("actual output") },
    stage: { parentPath: stagePath, parentResourceSlotId: stage.at(-1).resourceSlotId, topBasename: "private", ancestors: stage },
    destination: { parentPath: workspacePath, parentResourceSlotId: destination.at(-1).resourceSlotId, firstMissingComponent: "new", ancestors: destination },
    members: [
      { memberId: "tree", kind: "created_directory", resourceSlotId: "tree", publicationResourceSlotId: "tree-publication", parentResourceSlotId: stage.at(-1).resourceSlotId,
        basename: "private", canonicalPath: join(workspacePath, "new"), stagePath: join(stagePath, "private"), initial: "absent" },
      { memberId: "file", kind: "created_file", resourceSlotId: "file", publicationResourceSlotId: "file-publication", parentResourceSlotId: "tree",
        basename: "report.docx", canonicalPath: join(workspacePath, "new", "report.docx"), stagePath: join(stagePath, "private", "report.docx"), initial: "absent" },
    ], scopeRef: { scopeId: "original-scope-reference", issuerId: "original-host-issuer", evidenceDigest: "c".repeat(64) }, preparedAt };
}
/** Controlled factual input for Core contracts only, not a claim of native/kernel execution or scope issuance. */
export function directoryV2Capture(execution, effect, { success = true } = {}) {
  const nonce = "0123456789abcdef0123456789abcdef", resources = [], trace = [], bindings = []; let clock = 100n, serial = 0;
  const call = (syscall, resource, ok, identity) => ({ syscall, resourceLifetimeId: resource.lifetimeId, parentLifetimeId: resource.parentLifetimeId,
    nativeReturnState: "returned", calledAtMonotonicNs: String(++clock), returnedAtMonotonicNs: String(++clock),
    returned: ok ? syscall === "fstat" ? 0 : "descriptor_acquired_redacted" : -1, success: ok, errno: ok ? 0 : 2, ...(identity ? { identity } : {}) });
  for (const role of ["stage", "destination"]) {
    let parent = "";
    for (const [index, ancestor] of execution[role].ancestors.entries()) {
      const lifetimeId = nonce + ":" + ++serial, acquired = success;
      const open = trace.length, stat = open + 1;
      const resource = { lifetimeId, kind: index === execution[role].ancestors.length - 1 ? role === "stage" ? "stage_parent" : "destination_parent" : "ancestor",
        basename: ancestor.path === "/" ? "/" : ancestor.path.split("/").at(-1), parentLifetimeId: parent,
        state: acquired ? "retained" : "not_acquired", identityObserved: acquired, device: acquired ? ancestor.identity.device : "0", inode: acquired ? ancestor.identity.inode : "0",
        bytesWritten: "0", fsyncReturned: false };
      trace.push(call(index === 0 ? "open" : "openat", resource, acquired));
      const binding = { resourceSlotId: ancestor.resourceSlotId, nativeLifetimeId: lifetimeId };
      if (acquired) {
        trace.push(call("fstat", resource, true, ancestor.identity));
        Object.assign(resource, { initialIdentity: directoryV2Clone(ancestor.identity), identity: directoryV2Clone(ancestor.identity),
          initialObservedAtMonotonicNs: trace[stat].returnedAtMonotonicNs, observedAtMonotonicNs: trace[stat].returnedAtMonotonicNs });
        Object.assign(binding, { acquisitionCallRef: { effectId: effect.effectId, ordinal: open }, firstFstatCallRef: { effectId: effect.effectId, ordinal: stat } });
      }
      resources.push(resource); bindings.push(binding); parent = lifetimeId;
      if (!success) break;
    }
    if (!success) break;
  }
  const snapshot = { sessionNonce: nonce, phase: success ? "building" : "blocked", resources, installationEntered: false, residualCreation: false, everFailed: !success,
    publicationObservationClaimed: false, cancelRequested: false, readbacks: [], scopeBinding: "unbound", protectedStageVerified: false, coreSafe: false, packaged: false };
  const result = { success, nativeOutcome: "returned", hostAcknowledgment: "not_provided", operationId: "", calls: trace, snapshot };
  return { schemaVersion: 2, protocol: execution.protocol, kind: "office_local_directory_effect_v2", executionId: execution.executionId,
    executionIdentityDigest: execution.identityDigest, source: directoryV2Clone(execution.source), effectId: effect.effectId, effectDigest: effect.effectDigest,
    native: { state: "returned", calledAt: effect.enteredAt, returnedAt: effect.enteredAt, result }, host: { state: "returned" }, resourceBindings: bindings, completedAt: effect.enteredAt };
}
/** Real original pair and SQLite lifecycle; no fixed writer/native syscall is invoked by this fixture. */
export async function directoryV2StoreFixture(t, { originalOfficeHostBridge } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-core-directory-v2-"));
  const store = originalOfficeHostBridge === undefined ? createSqliteRunStore(cwd)
    : new SqliteRunStore({ cwd, originalOfficeHostBridge });
  const other = createSqliteRunStore(cwd);
  t.after(async () => { other.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = () => new Date().toISOString(), at = now();
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run", idempotencyKey: "unit", status: "running", createdByActor: "system", request: {}, now: at });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "directory-runtime", runnerId: "pi", status: "started", now: at });
  const run = store.createRun({ id: "run", cwd, workUnitId: unit.id, taskId: "task", providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: at });
  store.linkRunToWorkUnit(run.id, unit.id, at); store.markRunStarted(run.id, at);
  const source = { runId: run.id, ...toRuntimeAttemptFence(attempt) }, toolCallId = "directory-call";
  const parent = store.admitHostOperation({ operationId: "directory-parent", source, kind: "mcp", toolCallId });
  const producer = store.admitHostOperation({ operationId: "directory-producer", source, kind: "file_mutation", toolCallId, parentOperationId: parent.operationId, producerId: "office-local-binary" });
  const prepared = directoryV2Prepared({ workspacePath: cwd, stagePath: "/private/ling-history-only-stage", source, toolCallId,
    parentOperationId: parent.operationId, producerOperationId: producer.operationId, preparedAt: now() });
  const seal = payload => store.createArtifact({ runId: run.id, type: "json", path: "office/directory-v2-facts.json", sealedPayload: payload, createdAt: now() });
  const preparation = seal(prepared), ticket = store.prepareHostOfficeLocalDirectoryExecutionV2(parent, producer, {
    executionId: prepared.executionId, preparedArtifactId: preparation.id, preparedDigest: preparation.contentSha256 });
  return { cwd, store, other, source, parent, producer, ticket, prepared, seal, now,
    execution: () => store.getHostOfficeLocalDirectoryExecutionV2(ticket.executionId),
    prepare: () => store.prepareHostOfficeLocalDirectoryEffectV2(ticket, { effectId: "capture", ordinal: 0, kind: "capture_parents", mode: "forward", preparedAt: now() }) };
}
