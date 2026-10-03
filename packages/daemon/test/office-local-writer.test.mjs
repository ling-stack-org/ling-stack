import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "@ling-stack/core";
import { AttemptHostOperationTracker } from "../dist/runtime/attempt-host-operation-tracker.js";
import { prepareOfficeArtifact } from "../dist/features/office-documents/office-artifact-preparation.js";
import { captureOfficeLocalSnapshot, copyOfficeLocalSnapshotBytes } from "../dist/features/office-documents/office-local-snapshot.js";
import { assertOfficeLocalReservation, officeLocalWriteState, prepareOfficeLocalWrite, reserveOfficeLocalWriter } from "../dist/features/office-documents/office-local-authority.js";
import { executeOfficeLocalWrite, OfficeLocalWriterError } from "../dist/features/office-documents/office-local-writer.js";
import { OfficeLocalMemberLedger } from "../dist/features/office-documents/office-local-members.js";

const now = () => new Date().toISOString();
async function fixture(t, path = "result.docx") {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ling-office-writer-"))), store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "unit", status: "running", createdByActor: "system", request: {}, now: now() });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "office-runtime", runnerId: "pi", status: "started", now: now() });
  const fence = toRuntimeAttemptFence(attempt);
  const thread = store.createLingThread({ kind: "conversation", title: "Office actual writer", objective: "Original source" }, now());
  const turn = store.appendConversationUserTurn({ threadId: thread.id, title: "Create", userInstruction: "Create", idempotencyKey: "turn",
    payload: { body: "Create", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, now());
  store.createRun({ id: "run", cwd, workUnitId: unit.id, threadId: thread.id, turnId: turn.turnId, taskId: "task", providerName: "test",
    providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now() });
  store.linkRunToWorkUnit("run", unit.id, now()); store.markRunStarted("run", now());
  const source = { runId: "run", ...fence }, tracker = new AttemptHostOperationTracker({ store, source });
  const reservation = reserveOfficeLocalWriter(tracker, store, "office-call", cwd);
  const snapshot = captureOfficeLocalSnapshot(cwd, path, "docx", source);
  const artifact = await prepareOfficeArtifact("office_create_document", { path, blocks: [{ type: "paragraph", text: "Actual Office SDK bytes" }] });
  const plan = prepareOfficeLocalWrite(reservation, snapshot, artifact, "a".repeat(64), "b".repeat(64));
  const prepared = store.getHostOfficeLocalExecution(plan.executionId);
  const temporary = prepared.members.find(member => member.role === "temporary").path;
  return { cwd, store, unit, fence, source, tracker, reservation, snapshot, artifact, plan, prepared, temporary };
}
function patchFs(t, name, replacement) {
  const original = fs[name]; fs[name] = replacement(original); syncBuiltinESMExports();
  t.after(() => { fs[name] = original; syncBuiltinESMExports(); });
}

test("Office real SDK bytes publish through exact SQLite effects without safe settlement", async t => {
  const f = await fixture(t, "nested/one/result.docx"), result = executeOfficeLocalWrite(f.plan);
  assert.deepEqual(readFileSync(result.path), f.artifact.bytes);
  assert.equal(existsSync(f.temporary), false);
  assert.equal(result.observation.outcome, "published");
  assert.equal(result.observation.descriptors.every(row => row.state === "closed"), true);
  assert.equal(result.observation.members.length, f.prepared.members.length);
  const effects = f.store.listHostOfficeLocalEffects(f.plan.executionId);
  assert.deepEqual(effects.map(row => row.kind), ["mkdir", "mkdir", "open", "write", "fsync", "close", "link", "unlink"]);
  assert.equal(effects.every(row => row.enteredAt && row.observationArtifactId), true);
  assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
  assert.throws(() => executeOfficeLocalWrite(f.plan), /already_entered/);
  assert.throws(() => executeOfficeLocalWrite({ ...f.plan }), /plan_invalid/);
});

test("Office cloned reservation cannot acquire a plan or read permission", async t => {
  const f = await fixture(t);
  assert.throws(() => assertOfficeLocalReservation({ ...f.reservation }), /reservation_invalid/);
  assert.throws(() => prepareOfficeLocalWrite(f.reservation, f.snapshot, f.artifact, "a".repeat(64), "b".repeat(64)), /reservation_invalid/);
});

test("Office externally replaced temporary file is never adopted then deleted by cleanup", async t => {
  const f = await fixture(t);
  patchFs(t, "writeSync", original => (...args) => {
    const count = original(...args);
    renameSync(f.temporary, join(f.cwd, "owned-displaced.tmp"));
    writeFileSync(f.temporary, "external-owned-file");
    return count;
  });
  assert.throws(() => executeOfficeLocalWrite(f.plan), OfficeLocalWriterError);
  assert.equal(existsSync(f.temporary), true, "external inode must survive cleanup");
  assert.equal(readFileSync(f.temporary, "utf8"), "external-owned-file");
  assert.equal(existsSync(f.prepared.targetPath), false);
});

test("Office member observation does not use unbounded path readFileSync", async t => {
  const f = await fixture(t);
  const member = { memberId: "temporary", role: "temporary", path: f.temporary, initial: { state: "absent" } };
  const ledger = new OfficeLocalMemberLedger(f.cwd, [member]);
  writeFileSync(f.temporary, "bounded");
  patchFs(t, "readFileSync", original => (...args) => {
    if (args[0] === f.temporary) throw new Error("unbounded_path_read_forbidden");
    return original(...args);
  });
  assert.doesNotThrow(() => ledger.refresh("temporary"));
  assert.equal(ledger.expected("temporary").sizeBytes, 7);
});

test("Office Tracker cannot relabel a forward row cleanup after local admission closes", async t => {
  const f = await fixture(t), state = officeLocalWriteState(f.plan), tracker = f.tracker;
  const open = tracker.prepareOfficeLocalEffect(state.ticket, { effectId: "open", ordinal: 0, kind: "open", mode: "forward", memberId: "temporary", preparedAt: now() });
  tracker.launchOfficeLocalEffect(state.ticket, open.effectId, () => { const fd = fs.openSync(f.temporary, "wx"); fs.closeSync(fd); }, "forward");
  const seal = f.store.createArtifact({ runId: "run", type: "json", path: "office/open.json", createdAt: now(), sealedPayload: {
    schemaVersion: 1, protocol: "ling-office-local-binary-v1", kind: "office_local_effect_v1", executionId: f.plan.executionId,
    executionIdentityDigest: state.identityDigest, source: f.source, effectId: open.effectId, effectDigest: open.effectDigest, outcome: "returned", completedAt: now(),
  } });
  tracker.recordOfficeLocalObservation(state.ticket, open.effectId, seal.id);
  const write = tracker.prepareOfficeLocalEffect(state.ticket, { effectId: "write", ordinal: 1, kind: "write", mode: "forward", memberId: "temporary", offset: 0, sizeBytes: 1, preparedAt: now() });
  tracker.executorGroup.closeAdmission({ kind: "user_input_required", requestId: "required", requestVersion: 1 });
  let mutations = 0;
  assert.throws(() => tracker.launchOfficeLocalEffect(state.ticket, write.effectId, () => { mutations++; writeFileSync(f.temporary, "bad"); }, "cleanup"));
  assert.equal(mutations, 0);
});
