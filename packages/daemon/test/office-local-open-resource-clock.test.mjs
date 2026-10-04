import assert from "node:assert/strict";
import fs, { mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "@ling-stack/core";
import { AttemptHostOperationTracker } from "../dist/runtime/attempt-host-operation-tracker.js";
import { prepareOfficeArtifact } from "../dist/features/office-documents/office-artifact-preparation.js";
import { captureOfficeLocalSnapshot } from "../dist/features/office-documents/office-local-snapshot.js";
import { prepareOfficeLocalWrite, reserveOfficeLocalWriter } from "../dist/features/office-documents/office-local-authority.js";
import { officeFileIdentity } from "../dist/features/office-documents/office-local-identity.js";
import { executeOfficeLocalWrite, OfficeLocalWriterError } from "../dist/features/office-documents/office-local-writer.js";

const now = () => new Date().toISOString();

/** Real isolated SQLite, captured source and SDK bytes, prepared before any clock fault. */
async function fixture(t) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ling-office-open-clock-"))), store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "unit", status: "running", createdByActor: "system", request: {}, now: now() });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "office-runtime",
    runnerId: "pi", status: "started", now: now() });
  const source = { runId: "run", ...toRuntimeAttemptFence(attempt) };
  const thread = store.createLingThread({ kind: "conversation", title: "Original open clock", objective: "Original source" }, now());
  const turn = store.appendConversationUserTurn({ threadId: thread.id, title: "Create", userInstruction: "Create",
    idempotencyKey: "turn", payload: { body: "Create", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, now());
  store.createRun({ id: "run", cwd, workUnitId: unit.id, threadId: thread.id, turnId: turn.turnId, taskId: "task",
    providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now() });
  store.linkRunToWorkUnit("run", unit.id, now()); store.markRunStarted("run", now());
  const tracker = new AttemptHostOperationTracker({ store, source });
  const reservation = reserveOfficeLocalWriter(tracker, store, "office-call", cwd);
  const snapshot = captureOfficeLocalSnapshot(cwd, "result.docx", "docx", source);
  const artifact = await prepareOfficeArtifact("office_create_document", { path: "result.docx",
    blocks: [{ type: "paragraph", text: "Actual SDK bytes for original-open clock" }] });
  const plan = prepareOfficeLocalWrite(reservation, snapshot, artifact, "a".repeat(64), "b".repeat(64));
  const prepared = store.getHostOfficeLocalExecution(plan.executionId);
  return { cwd, store, tracker, artifact, plan, prepared,
    temporary: prepared.members.find(member => member.role === "temporary").path };
}

function patchFs(t, name, replacement) {
  const original = fs[name]; fs[name] = replacement(original); syncBuiltinESMExports();
  t.after(() => { fs[name] = original; syncBuiltinESMExports(); });
}

test("Office original openResource clock rollback keeps the first FD fact recorded without changing native returnedAt", async t => {
  const f = await fixture(t), OriginalDate = globalThis.Date;
  const nativeFstat = fs.fstatSync, nativeClose = fs.closeSync;
  const createArtifact = f.store.createArtifact.bind(f.store);
  let writerFd, nativeOpenCalls = 0, nativeReturnEpoch, expectNativeReturn = false;
  let firstIdentity, rollbackNextSample = false, injected = false, rolledBackSample, openSeal;
  f.store.createArtifact = input => {
    const artifact = createArtifact(input);
    if (input.sealedPayload?.kind === "office_local_effect_v1" && input.sealedPayload.native?.result?.kind === "open") {
      openSeal = artifact;
    }
    return artifact;
  };
  t.after(() => { f.store.createArtifact = createArtifact; });
  patchFs(t, "openSync", original => (...args) => {
    const fd = original(...args);
    if (args[0] === f.temporary && (args[1] & fs.constants.O_WRONLY) !== 0) {
      writerFd = fd; nativeOpenCalls++; expectNativeReturn = true;
    }
    return fd;
  });
  patchFs(t, "fstatSync", original => (...args) => {
    const stats = original(...args);
    if (args[0] === writerFd && !firstIdentity) {
      firstIdentity = officeFileIdentity(stats);
      rollbackNextSample = true;
    }
    return stats;
  });
  globalThis.Date = class extends OriginalDate {
    constructor(...values) {
      if (values.length) { super(...values); return; }
      let sampled = OriginalDate.now();
      if (expectNativeReturn) { nativeReturnEpoch = sampled; expectNativeReturn = false; }
      if (rollbackNextSample) {
        sampled = nativeReturnEpoch - 1; rolledBackSample = new OriginalDate(sampled).toISOString();
        rollbackNextSample = false; injected = true;
      }
      super(sampled);
    }
  };
  t.after(() => { globalThis.Date = OriginalDate; });
  t.after(() => {
    if (writerFd !== undefined) {
      try { nativeClose(writerFd); } catch (error) { if (error.code !== "EBADF") throw error; }
    }
  });
  let result, failure;
  try { result = executeOfficeLocalWrite(f.plan); } catch (error) { failure = error; }
  finally { globalThis.Date = OriginalDate; }
  assert.equal(nativeOpenCalls, 1, "fault must reach the real original writer open after successful preparation");
  assert.equal(injected, true, "only the Host identity sample after the actual first fstat must roll back");
  assert.ok(firstIdentity && openSeal);
  const payload = f.store.getArtifact(openSeal.id).sealedPayload;
  const effect = f.store.listHostOfficeLocalEffects(f.plan.executionId).find(row => row.kind === "open");
  const nativeReturnedAt = new OriginalDate(nativeReturnEpoch).toISOString();
  assert.equal(payload.native.state, "returned"); assert.equal(payload.native.returnedAt, nativeReturnedAt);
  assert.equal(payload.host.state, "returned", "the real Host callback succeeds before validation of its seal");
  assert.equal(rolledBackSample < nativeReturnedAt, true);
  assert.ok(payload.native.returnedAt <= payload.completedAt, "the native axis and seal must remain ordered, isolating the new Host fact");
  assert.deepEqual(payload.openResource?.identity, firstIdentity);
  t.diagnostic(JSON.stringify({ injected, nativeOpenCalls, nativeReturnedAt, rolledBackSample,
    identityObservedAt: payload.openResource?.observedAt, completedAt: payload.completedAt,
    nativeAxisUnchanged: payload.native.returnedAt === nativeReturnedAt,
    openObservationRecorded: !!effect.observationArtifactId, host: payload.host.state,
    outcome: failure?.observation.outcome ?? result?.observation.outcome,
    writerError: failure instanceof OfficeLocalWriterError }));
  assert.equal(effect.observationArtifactId, openSeal.id, "a one-sample Host clock rollback must not discard the original successful open/fstat fact");
  assert.ok(payload.openResource.observedAt >= nativeReturnedAt && payload.openResource.observedAt <= payload.completedAt);
  assert.equal(payload.openResource.resourceLifetimeId, effect.resourceLifetimeId);
  assert.equal("fd" in payload.openResource, false);
  assert.equal(failure, undefined); assert.equal(result.observation.outcome, "published");
  assert.deepEqual(fs.readFileSync(result.path), f.artifact.bytes);
  assert.throws(() => nativeFstat(writerFd), { code: "EBADF" });
});
