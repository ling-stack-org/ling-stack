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
import { OfficeLocalMemberLedger, officeBytesDigest, officeFileIdentity } from "../dist/features/office-documents/office-local-members.js";

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

function effectPayloads(f) {
  return f.store.listHostOfficeLocalEffects(f.plan.executionId).map(effect => ({ effect,
    payload: f.store.getArtifact(effect.observationArtifactId)?.sealedPayload }));
}

test("Office native contract preserves short write return before readback failure", async t => {
  const f = await fixture(t), ledger = officeLocalWriteState(f.plan).ledger;
  let writes = 0;
  patchFs(t, "writeSync", original => (fd, bytes, offset, length, position) => {
    writes++;
    return original(fd, bytes, offset, Math.min(length, 64), position);
  });
  const refresh = ledger.refresh.bind(ledger);
  ledger.refresh = (...args) => {
    if (writes > 0 && args[0] === "temporary") throw Object.assign(new Error("readback failed"), { code: "EIO" });
    return refresh(...args);
  };
  assert.throws(() => executeOfficeLocalWrite(f.plan), OfficeLocalWriterError);
  const { effect, payload } = effectPayloads(f).find(row => row.effect.kind === "write");
  assert.equal(writes, 1);
  assert.equal(payload?.native?.state, "returned", "post-write readback failure cannot erase a real write return");
  assert.deepEqual(payload.native.result, { kind: "write", resourceLifetimeId: effect.resourceLifetimeId, bytesWritten: 64 });
  assert.deepEqual(payload.host, { state: "unconfirmed", errorCode: "EIO" });
  assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
});

test("Office native contract records each actual short write and advances exact offsets", async t => {
  const f = await fixture(t);
  patchFs(t, "writeSync", original => (fd, bytes, offset, length, position) => original(fd, bytes, offset, Math.min(length, 1024), position));
  const result = executeOfficeLocalWrite(f.plan), writes = effectPayloads(f).filter(row => row.effect.kind === "write");
  assert.ok(writes.length > 1);
  let offset = 0;
  for (const { effect, payload } of writes) {
    assert.equal(effect.offset, offset);
    assert.equal(payload?.native?.state, "returned");
    assert.equal(payload.native.result.bytesWritten, Math.min(effect.sizeBytes, 1024));
    assert.equal(payload.native.result.resourceLifetimeId, effect.resourceLifetimeId);
    assert.deepEqual(payload.host, { state: "returned" });
    offset += payload.native.result.bytesWritten;
  }
  assert.equal(offset, f.artifact.bytes.length);
  assert.deepEqual(readFileSync(result.path), f.artifact.bytes);
  const resource = result.observation.resources?.[0];
  assert.equal(resource?.state, "closed");
  assert.equal(typeof resource.resourceLifetimeId, "string");
  assert.ok(resource.openEffectId && resource.closeEffectId);
  assert.equal("fd" in resource, false, "numeric FD must not become durable resource identity");
  const fdEffects = effectPayloads(f).filter(row => ["open", "write", "fsync", "close"].includes(row.effect.kind));
  assert.equal(fdEffects.every(row => row.effect.resourceLifetimeId === resource.resourceLifetimeId), true);
});

test("Office native contract keeps zero return distinct from syscall throw and does not spin", async t => {
  const f = await fixture(t); let calls = 0;
  patchFs(t, "writeSync", () => () => { calls++; return 0; });
  assert.throws(() => executeOfficeLocalWrite(f.plan), OfficeLocalWriterError);
  const { payload } = effectPayloads(f).find(row => row.effect.kind === "write");
  assert.equal(calls, 1);
  assert.equal(payload?.native?.state, "returned");
  assert.equal(payload.native.result.bytesWritten, 0);
  assert.equal(payload.host.state, "unconfirmed");
  assert.equal(existsSync(f.prepared.targetPath), false);
});

test("Office native contract separates callback admission from native syscall entry", async t => {
  const f = await fixture(t), state = officeLocalWriteState(f.plan);
  const current = state.ledger.assertCurrent.bind(state.ledger); let guards = 0, opens = 0;
  state.ledger.assertCurrent = () => {
    if (++guards === 2) throw Object.assign(new Error("pre syscall guard failed"), { code: "EIO" });
    current();
  };
  patchFs(t, "openSync", original => (...args) => { if (args[0] === f.temporary) opens++; return original(...args); });
  assert.throws(() => executeOfficeLocalWrite(f.plan), OfficeLocalWriterError);
  const { effect, payload } = effectPayloads(f)[0];
  assert.equal(opens, 0);
  assert.ok(effect.enteredAt, "the Core callback entry is preserved even without native entry");
  assert.deepEqual(payload?.native, { state: "not_entered" });
  assert.equal(payload.host.state, "unconfirmed");
  assert.throws(() => f.tracker.settleNoStart(state.parent), /launched_no_start/);
  assert.throws(() => f.tracker.settleNoStart(state.producer), /launched_no_start/);
});

for (const afterCommit of [false, true]) {
  test(`Office native contract retains actual write on ${afterCommit ? "post-COMMIT throw" : "COMMIT rollback"}`, async t => {
    const f = await fixture(t), exec = f.store.database.exec.bind(f.store.database);
    let writes = 0, inject = true;
    patchFs(t, "writeSync", original => (...args) => { const result = original(...args); writes++; return result; });
    f.store.database.exec = sql => {
      if (sql === "COMMIT" && inject && writes > 0) {
        inject = false;
        if (afterCommit) exec(sql);
        throw Object.assign(new Error("commit failed after native write"), { code: "EIO" });
      }
      return exec(sql);
    };
    t.after(() => { f.store.database.exec = exec; });
    assert.throws(() => executeOfficeLocalWrite(f.plan), OfficeLocalWriterError);
    const { effect, payload } = effectPayloads(f).find(row => row.effect.kind === "write");
    assert.equal(writes, 1);
    assert.equal(payload?.native?.state, "returned");
    assert.equal(payload.native.result.bytesWritten, f.artifact.bytes.length);
    assert.ok(effect.enteredAt);
    assert.deepEqual(payload.host, { state: "unconfirmed", errorCode: "EIO" });
    assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
  });
}

test("Office native contract retains open return before first fstat throws", async t => {
  const f = await fixture(t); let fd, injected = false, failure;
  patchFs(t, "openSync", original => (...args) => {
    const result = original(...args);
    if (args[0] === f.temporary && (args[1] & fs.constants.O_WRONLY)) fd = result;
    return result;
  });
  patchFs(t, "fstatSync", original => (...args) => {
    if (args[0] === fd && !injected) { injected = true; throw Object.assign(new Error("fstat failed"), { code: "EIO" }); }
    return original(...args);
  });
  assert.throws(() => { try { executeOfficeLocalWrite(f.plan); } catch (error) { failure = error; throw error; } }, OfficeLocalWriterError);
  const { effect, payload } = effectPayloads(f).find(row => row.effect.kind === "open");
  assert.equal(payload?.native?.state, "returned");
  assert.deepEqual(payload.native.result, { kind: "open", resourceLifetimeId: effect.resourceLifetimeId });
  assert.deepEqual(payload.host, { state: "unconfirmed", errorCode: "EIO" });
  assert.equal(failure.observation.resources?.[0]?.openEffectId, effect.effectId);
  assert.equal(failure.observation.resources[0].state, "closed");
  assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
});

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
  let writerFd;
  patchFs(t, "writeSync", original => (...args) => {
    writerFd = args[0];
    const count = original(...args);
    renameSync(f.temporary, join(f.cwd, "owned-displaced.tmp"));
    writeFileSync(f.temporary, "external-owned-file");
    return count;
  });
  assert.throws(() => executeOfficeLocalWrite(f.plan), OfficeLocalWriterError);
  assert.equal(existsSync(f.temporary), true, "external inode must survive cleanup");
  assert.equal(readFileSync(f.temporary, "utf8"), "external-owned-file");
  assert.equal(existsSync(f.prepared.targetPath), false);
  assert.throws(() => fs.fstatSync(writerFd), { code: "EBADF" }, "the displaced original descriptor must still be closed");
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
  const identity = officeFileIdentity(fs.lstatSync(f.temporary, { bigint: true }));
  assert.doesNotThrow(() => ledger.refresh("temporary", { state: "file", identity }));
  assert.equal(ledger.expected("temporary").sizeBytes, 7);
});

test("Office final residue observation cannot grant cleanup authority for an external member", async t => {
  const f = await fixture(t), ledger = officeLocalWriteState(f.plan).ledger;
  writeFileSync(f.temporary, "external-owned-file");
  const final = ledger.observeFinal().find(row => row.memberId === "temporary");
  assert.equal(final.final.state, "file");
  assert.deepEqual(ledger.expected("temporary"), { state: "absent" });
  assert.throws(() => ledger.refresh("temporary"), /snapshot_changed/);
  assert.deepEqual(ledger.expected("temporary"), { state: "absent" });
});

test("Office refresh binds the existing owned inode even when a replacement has identical bytes", async t => {
  const f = await fixture(t), ledger = officeLocalWriteState(f.plan).ledger;
  writeFileSync(f.temporary, "same bytes");
  const identity = officeFileIdentity(fs.lstatSync(f.temporary, { bigint: true }));
  ledger.refresh("temporary", { state: "file", identity });
  const expected = ledger.expected("temporary");
  renameSync(f.temporary, join(f.cwd, "original-owned.tmp"));
  writeFileSync(f.temporary, "same bytes");
  assert.throws(() => ledger.refresh("temporary"), /snapshot_changed/);
  assert.deepEqual(ledger.expected("temporary"), expected);
  assert.equal(ledger.observeFinal().find(row => row.memberId === "temporary").final.state, "file");
  assert.deepEqual(ledger.expected("temporary"), expected);
});

test("Office member reads bind one FD, handle short reads and cannot extend allocation when the file grows", async t => {
  const f = await fixture(t), ledger = officeLocalWriteState(f.plan).ledger;
  writeFileSync(f.temporary, "bounded");
  const identity = officeFileIdentity(fs.lstatSync(f.temporary, { bigint: true }));
  let reads = 0, grow = false;
  patchFs(t, "readSync", original => (fd, buffer, offset, length, position) => {
    assert.equal(typeof fd, "number");
    assert.equal(buffer.length, 7);
    assert.equal(length <= 7 - offset, true);
    reads++;
    const count = original(fd, buffer, offset, Math.min(length, 2), position);
    if (grow) { grow = false; fs.appendFileSync(f.temporary, "extra bytes"); }
    return count;
  });
  ledger.refresh("temporary", { state: "file", identity });
  assert.equal(reads, 4);
  assert.equal(ledger.expected("temporary").bytesSha256, officeBytesDigest(Buffer.from("bounded")));
  const expected = ledger.expected("temporary");
  grow = true;
  assert.throws(() => ledger.refresh("temporary"), /snapshot_changed/);
  assert.deepEqual(ledger.expected("temporary"), expected);
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

test("Office open retains its original descriptor before a first fstat failure", async t => {
  const f = await fixture(t); let writerFd, rejected = false;
  patchFs(t, "openSync", original => (...args) => {
    const fd = original(...args);
    if (args[0] === f.temporary && (args[1] & fs.constants.O_WRONLY)) writerFd = fd;
    return fd;
  });
  patchFs(t, "fstatSync", original => (...args) => {
    if (args[0] === writerFd && !rejected) { rejected = true; throw Object.assign(new Error("injected_fstat_failure"), { code: "EIO" }); }
    return original(...args);
  });
  assert.throws(() => executeOfficeLocalWrite(f.plan), OfficeLocalWriterError);
  assert.equal(rejected, true);
  assert.throws(() => fs.fstatSync(writerFd), { code: "EBADF" });
  assert.equal(existsSync(f.prepared.targetPath), false);
});

test("Office unknown close is not replayed against an FD number reused by the same inode", async t => {
  const f = await fixture(t); let writerFd, borrowedFd, attempts = 0;
  patchFs(t, "openSync", original => (...args) => {
    const fd = original(...args);
    if (args[0] === f.temporary && (args[1] & fs.constants.O_WRONLY)) writerFd = fd;
    return fd;
  });
  patchFs(t, "closeSync", original => fd => {
    if (fd === writerFd) {
      attempts++;
      if (attempts === 1) {
        original(fd);
        borrowedFd = fs.openSync(f.temporary, "r");
        assert.equal(borrowedFd, writerFd, "fault injection must reuse the actual descriptor number");
        throw Object.assign(new Error("injected_unknown_close"), { code: "EINTR" });
      }
    }
    return original(fd);
  });
  t.after(() => { if (borrowedFd !== undefined) try { fs.closeSync(borrowedFd); } catch (error) { if (error.code !== "EBADF") throw error; } });
  let failure;
  assert.throws(() => { try { executeOfficeLocalWrite(f.plan); } catch (error) { failure = error; throw error; } }, OfficeLocalWriterError);
  assert.equal(attempts, 1, "an unknown close cannot be retried");
  assert.doesNotThrow(() => fs.fstatSync(borrowedFd));
  assert.equal(failure.observation.descriptors[0].state, "retained");
  assert.equal(existsSync(f.prepared.targetPath), false);
});

test("Office post-mkdir path identity cannot authorize deletion of an externally replaced directory", async t => {
  const f = await fixture(t, "nested/result.docx"), nested = join(f.cwd, "nested"), displaced = join(f.cwd, "owned-displaced");
  patchFs(t, "mkdirSync", original => (...args) => {
    const result = original(...args);
    if (args[0] === nested) { renameSync(nested, displaced); original(nested); }
    return result;
  });
  patchFs(t, "writeSync", () => () => { throw Object.assign(new Error("injected_write_failure"), { code: "EIO" }); });
  let failure;
  assert.throws(() => { try { executeOfficeLocalWrite(f.plan); } catch (error) { failure = error; throw error; } }, OfficeLocalWriterError);
  assert.equal(existsSync(nested), true, "an external directory cannot be removed on a post-mkdir path observation");
  assert.equal(existsSync(displaced), true);
  assert.equal(existsSync(f.prepared.targetPath), false);
  assert.equal(failure.observation.members.find(row => row.role === "directory").final.state, "directory");
  assert.equal(f.store.listHostOfficeLocalEffects(f.plan.executionId).some(row => row.kind === "rmdir"), false);
});

test("Office oversized final residue is not read or adopted", async t => {
  const f = await fixture(t), ledger = officeLocalWriteState(f.plan).ledger;
  writeFileSync(f.temporary, "small"); fs.truncateSync(f.temporary, 50 * 1024 * 1024 + 1);
  let reads = 0;
  patchFs(t, "readSync", original => (...args) => { reads++; return original(...args); });
  const final = ledger.observeFinal().find(row => row.memberId === "temporary");
  assert.deepEqual(final.final, { state: "unobserved", errorCode: "office_document_too_large" });
  assert.equal(reads, 0);
  assert.deepEqual(ledger.expected("temporary"), { state: "absent" });
});
