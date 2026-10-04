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
import { OfficeLocalResourceOwner } from "../dist/features/office-documents/office-local-resources.js";
import { verifyOfficeLocalReplay } from "../../core/dist/storage/sqlite/host-office-local-replay.js";

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

test("Office persisted provenance seals the captured workspace root without adopting a later root", async t => {
  const f = await fixture(t), root = officeFileIdentity(fs.lstatSync(f.cwd, { bigint: true }));
  assert.ok(f.prepared.workspaceIdentity, "prepared evidence must persist the original workspace root identity");
  assert.deepEqual(f.prepared.workspaceIdentity, f.snapshot.workspaceIdentity);
  assert.equal(f.prepared.workspaceIdentity.device, root.device);
  assert.equal(f.prepared.workspaceIdentity.inode, root.inode);
  const captured = structuredClone(f.prepared.workspaceIdentity);
  writeFileSync(join(f.cwd, "unrelated.txt"), "directory timestamps may change");
  executeOfficeLocalWrite(f.plan);
  assert.deepEqual(f.store.getHostOfficeLocalExecution(f.plan.executionId).workspaceIdentity, captured);
});

test("Office persisted provenance records the first original writer FD identity in its open seal", async t => {
  const f = await fixture(t), opened = new Set(), first = new Map();
  patchFs(t, "openSync", original => (...args) => {
    const fd = original(...args);
    if (args[0] === f.temporary && (args[1] & fs.constants.O_WRONLY) !== 0) opened.add(fd);
    return fd;
  });
  patchFs(t, "fstatSync", original => (...args) => {
    const stats = original(...args);
    if (opened.has(args[0]) && !first.has(args[0])) first.set(args[0], officeFileIdentity(stats));
    return stats;
  });
  executeOfficeLocalWrite(f.plan);
  const { effect, payload } = effectPayloads(f).find(row => row.effect.kind === "open");
  assert.equal(first.size, 1);
  assert.ok(payload.openResource, "an open lifetime cannot be reconstructed from final path identity");
  assert.deepEqual(payload.openResource.identity, [...first.values()][0]);
  assert.equal(payload.openResource.identity.sizeBytes, 0, "the first fstat precedes all writes");
  assert.equal(payload.openResource.resourceLifetimeId, effect.resourceLifetimeId);
  assert.ok(payload.native.returnedAt <= payload.openResource.observedAt);
  assert.ok(payload.openResource.observedAt <= payload.completedAt);
  assert.equal("fd" in payload.openResource, false);
});

test("Office persisted provenance rejects a replacement workspace root at ledger issuance", async t => {
  const f = await fixture(t), root = join(f.cwd, "captured-root");
  fs.mkdirSync(root);
  const captured = officeFileIdentity(fs.lstatSync(root, { bigint: true }));
  renameSync(root, join(f.cwd, "displaced-root"));
  fs.mkdirSync(root);
  const member = { memberId: "target", role: "target", path: join(root, "result.docx"), initial: { state: "absent" } };
  assert.throws(() => new OfficeLocalMemberLedger(root, [member], captured), /office_local_snapshot_changed/);
});

test("Office final workspace observation seals the original root without freezing directory timestamps", async t => {
  const f = await fixture(t), state = officeLocalWriteState(f.plan);
  const observeFinal = state.ledger.observeFinal.bind(state.ledger);
  state.ledger.observeFinal = (...args) => {
    const members = observeFinal(...args);
    writeFileSync(join(f.cwd, "unrelated-after-final.txt"), "directory metadata may legitimately change");
    return members;
  };
  t.after(() => { state.ledger.observeFinal = observeFinal; });
  const result = executeOfficeLocalWrite(f.plan), workspace = result.observation.workspace;
  assert.ok(workspace, "final member reads do not replace an independent terminal root fact");
  assert.equal(workspace.final.state, "directory");
  assert.equal(workspace.final.identity.device, f.prepared.workspaceIdentity.device);
  assert.equal(workspace.final.identity.inode, f.prepared.workspaceIdentity.inode);
  assert.deepEqual(workspace.final.identity, officeFileIdentity(fs.lstatSync(f.cwd, { bigint: true })));
  assert.ok(workspace.observedAt <= result.observation.completedAt);
  for (const member of result.observation.members) {
    assert.ok(member.observedAt <= workspace.observedAt);
    if (member.readRef) assert.ok(member.readRef.completedAt <= workspace.observedAt);
  }
  for (const resource of result.observation.resources) {
    if (resource.origin === "member_read") assert.ok(resource.closeReturnedAt <= workspace.observedAt);
  }
  assert.equal(f.store.getArtifact(result.observationArtifactId).createdAt, result.observation.completedAt);
  assert.deepEqual(f.store.getArtifact(result.observationArtifactId).sealedPayload.workspace, workspace);
  assert.deepEqual(f.store.getHostOfficeLocalExecution(f.plan.executionId).workspaceIdentity, f.prepared.workspaceIdentity);
});

test("Office final workspace replacement after every member observation cannot return published", async t => {
  const f = await fixture(t), state = officeLocalWriteState(f.plan), displaced = f.cwd + "-displaced";
  const observeFinal = state.ledger.observeFinal.bind(state.ledger);
  let injected = false;
  state.ledger.observeFinal = (...args) => {
    const members = observeFinal(...args);
    assert.ok(members.every(member => member.final.state !== "unobserved"));
    renameSync(f.cwd, displaced); fs.mkdirSync(f.cwd); injected = true;
    return members;
  };
  t.after(async () => { state.ledger.observeFinal = observeFinal; await rm(displaced, { recursive: true, force: true }); });
  let failure, result;
  try { result = executeOfficeLocalWrite(f.plan); } catch (error) { failure = error; }
  assert.equal(injected, true, "replacement must happen after all real final member reads");
  assert.ok(failure instanceof OfficeLocalWriterError, "a missing final root fence previously returned published");
  assert.equal(result, undefined);
  assert.equal(failure.observation.outcome, "failed");
  assert.deepEqual(failure.observation.workspace.final, { state: "unobserved", errorCode: "office_local_snapshot_changed" });
  assert.ok(failure.observation.members.every(member => member.final.state !== "unobserved"));
  assert.deepEqual(readFileSync(join(displaced, "result.docx")), f.artifact.bytes);
  assert.equal(existsSync(join(f.cwd, "result.docx")), false);
  for (const operation of [state.parent, state.producer]) {
    assert.equal(f.store.getHostOperation(operation.operationId).phase, "launched");
  }
});

test("Office final workspace read failure stays explicit even with complete member and resource observations", async t => {
  const f = await fixture(t), state = officeLocalWriteState(f.plan);
  const observeFinal = state.ledger.observeFinal.bind(state.ledger);
  let afterMembers = false, faults = 0;
  state.ledger.observeFinal = (...args) => {
    const members = observeFinal(...args); afterMembers = true; return members;
  };
  t.after(() => { state.ledger.observeFinal = observeFinal; });
  patchFs(t, "lstatSync", original => (...args) => {
    if (afterMembers && args[0] === f.cwd) { faults++; throw Object.assign(new Error("final root lstat failed"), { code: "EIO" }); }
    return original(...args);
  });
  let failure;
  try { executeOfficeLocalWrite(f.plan); } catch (error) { failure = error; }
  assert.equal(faults, 1, "the writer must actually inspect the original root after final members");
  assert.ok(failure instanceof OfficeLocalWriterError);
  assert.deepEqual(failure.observation.workspace.final, { state: "unobserved", errorCode: "EIO" });
  assert.equal(failure.observation.outcome, "failed");
  assert.ok(failure.observation.members.every(member => member.final.state !== "unobserved"));
  assert.ok(failure.observation.resources.every(resource => resource.state === "closed"));
});

test("Office final published member replacement with identical bytes remains a failed observed residue", async t => {
  const f = await fixture(t), state = officeLocalWriteState(f.plan), displaced = join(f.cwd, "original-output.docx");
  const observeFinal = state.ledger.observeFinal.bind(state.ledger);
  let originalIdentity;
  state.ledger.observeFinal = (...args) => {
    originalIdentity = state.ledger.expected("target").identity;
    renameSync(f.prepared.targetPath, displaced); writeFileSync(f.prepared.targetPath, f.artifact.bytes);
    return observeFinal(...args);
  };
  t.after(() => { state.ledger.observeFinal = observeFinal; });
  let result, failure;
  try { result = executeOfficeLocalWrite(f.plan); } catch (error) { failure = error; }
  assert.ok(failure instanceof OfficeLocalWriterError, "identical final hash must not adopt an external replacement as the writer's node");
  assert.equal(result, undefined);
  const target = failure.observation.members.find(member => member.memberId === "target");
  assert.equal(target.final.state, "file", "external residue is still a real observed fact, not erased by the safety decision");
  assert.equal(target.final.bytesSha256, f.prepared.output.bytesSha256);
  assert.notEqual(target.final.identity.inode, originalIdentity.inode);
  assert.equal(state.ledger.expected("target").identity.inode, originalIdentity.inode);
  assert.equal(failure.observation.outcome, "failed"); assert.equal(failure.observation.publicationEntered, true);
  assert.deepEqual(readFileSync(displaced), f.artifact.bytes);
  assert.deepEqual(readFileSync(f.prepared.targetPath), f.artifact.bytes);
  assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
});

test("Office terminal owner seals the whole original effect and resource roster without granting safe", async t => {
  const f = await fixture(t), state = officeLocalWriteState(f.plan), result = executeOfficeLocalWrite(f.plan);
  const row = f.store.database.prepare("SELECT * FROM host_office_local_terminals WHERE execution_id=?").get(f.plan.executionId);
  assert.ok(row, "a writer.json summary alone never freezes the original effect set");
  const terminal = f.store.getHostOfficeLocalTerminal(f.plan.executionId), seal = f.store.getArtifact(row.terminal_artifact_id);
  assert.equal(seal.sealedPayload.kind, "office_local_terminal_v1");
  assert.equal(result.observationArtifactId, seal.id);
  assert.equal(terminal.terminalDigest, seal.contentSha256);
  assert.equal(terminal.preparedArtifactId, f.prepared.preparedArtifactId);
  assert.equal(terminal.preparedDigest, f.prepared.preparedDigest);
  assert.deepEqual(terminal.resources, result.observation.resources);
  assert.deepEqual(terminal.members, result.observation.members);
  assert.deepEqual(terminal.workspace, result.observation.workspace);
  assert.deepEqual(terminal.effects, f.store.listHostOfficeLocalEffects(f.plan.executionId).map(effect => ({
    ordinal: effect.ordinal, effectId: effect.effectId, effectDigest: effect.effectDigest, enteredAt: effect.enteredAt ?? null,
    observation: effect.observationArtifactId ? { artifactId: effect.observationArtifactId,
      digest: f.store.getArtifact(effect.observationArtifactId).contentSha256 } : null,
  })));
  assert.equal(terminal.effectCount, terminal.effects.length);
  for (const operation of [state.parent, state.producer]) {
    assert.equal(f.store.getHostOperation(operation.operationId).phase, "launched");
  }
  assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
});

test("Office terminal owner keeps final root failure as sealed failed facts, not a safe receipt", async t => {
  const f = await fixture(t), state = officeLocalWriteState(f.plan);
  const observeFinal = state.ledger.observeFinal.bind(state.ledger);
  let afterMembers = false;
  state.ledger.observeFinal = (...args) => { const members = observeFinal(...args); afterMembers = true; return members; };
  t.after(() => { state.ledger.observeFinal = observeFinal; });
  patchFs(t, "lstatSync", original => (...args) => {
    if (afterMembers && args[0] === f.cwd) throw Object.assign(new Error("terminal root read failed"), { code: "EIO" });
    return original(...args);
  });
  let failure;
  try { executeOfficeLocalWrite(f.plan); } catch (error) { failure = error; }
  assert.ok(failure instanceof OfficeLocalWriterError);
  const row = f.store.database.prepare("SELECT * FROM host_office_local_terminals WHERE execution_id=?").get(f.plan.executionId);
  assert.ok(row, "incomplete facts must remain explicit in the sealed terminal, not disappear with the exception");
  const terminal = f.store.getHostOfficeLocalTerminal(f.plan.executionId);
  assert.equal(terminal.outcome, "failed");
  assert.equal(terminal.publicationEntered, true);
  assert.deepEqual(terminal.workspace.final, { state: "unobserved", errorCode: "EIO" });
  assert.deepEqual(terminal.resources, failure.observation.resources);
  assert.equal(terminal.terminalArtifactId, failure.observationArtifactId);
  assert.equal(failure.terminalSealConfirmed, true, "failed physical facts and confirmed persistence are separate axes");
  assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
});

test("Office terminal owner distinguishes callback entry from publication refused before native entry", async t => {
  const f = await fixture(t), state = officeLocalWriteState(f.plan);
  const assertCurrent = state.ledger.assertCurrent.bind(state.ledger);
  let refused = false, linkCalls = 0;
  state.ledger.assertCurrent = () => {
    const row = f.store.database.prepare("SELECT descriptor_json FROM host_office_local_effects ORDER BY ordinal DESC LIMIT 1").get();
    if (row && JSON.parse(row.descriptor_json).kind === "link" && !refused) {
      refused = true; throw Object.assign(new Error("guard refused publication before native call"), { code: "EIO" });
    }
    return assertCurrent();
  };
  t.after(() => { state.ledger.assertCurrent = assertCurrent; });
  patchFs(t, "linkSync", original => (...args) => { linkCalls++; return original(...args); });
  let failure;
  try { executeOfficeLocalWrite(f.plan); } catch (error) { failure = error; }
  assert.equal(refused, true); assert.equal(linkCalls, 0);
  assert.ok(failure instanceof OfficeLocalWriterError);
  const publication = effectPayloads(f).find(row => row.effect.kind === "link");
  assert.ok(publication.effect.enteredAt, "the Core callback really entered before its guard rejected");
  assert.deepEqual(publication.payload.native, { state: "not_entered" });
  assert.equal(failure.observation.publicationEntered, false);
  const terminal = f.store.getHostOfficeLocalTerminal(f.plan.executionId);
  assert.ok(terminal, "callback-entry facts must not erase a valid failed terminal with no native publication");
  assert.equal(terminal.publicationEntered, false); assert.equal(terminal.outcome, "failed");
  assert.equal(existsSync(f.prepared.targetPath), false); assert.equal(existsSync(f.temporary), false);
  assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
});

for (const afterCommit of [false, true]) {
  test(`Office terminal owner COMMIT ${afterCommit ? "post-COMMIT throw" : "rollback"} freezes live claims without repeating effects`, async t => {
    const f = await fixture(t), state = officeLocalWriteState(f.plan), exec = f.store.database.exec.bind(f.store.database);
    let injected = false, writes = 0;
    patchFs(t, "writeSync", original => (...args) => { writes++; return original(...args); });
    f.store.database.exec = sql => {
      if (sql === "COMMIT" && !injected && f.store.database.prepare(
        "SELECT count(*) n FROM host_office_local_terminals WHERE execution_id=?").get(f.plan.executionId).n === 1) {
        injected = true;
        if (afterCommit) exec(sql);
        throw Object.assign(new Error("terminal COMMIT return uncertain"), { code: "EIO" });
      }
      return exec(sql);
    };
    t.after(() => { f.store.database.exec = exec; });
    let failure;
    try { executeOfficeLocalWrite(f.plan); } catch (error) { failure = error; }
    assert.equal(injected, true, "the actual terminal INSERT must reach its real SQLite COMMIT");
    assert.ok(failure instanceof OfficeLocalWriterError);
    assert.ok(failure.observationArtifactId, "a COMMIT error must preserve the exact immutable terminal artifact identity");
    assert.equal(failure.terminalSealConfirmed, false, "a lost seal return cannot masquerade as a confirmed Host acknowledgement");
    assert.equal(failure.observation.outcome, "published", "physical publication already happened and must not be rewritten by COMMIT failure");
    assert.deepEqual(readFileSync(f.prepared.targetPath), f.artifact.bytes);
    assert.equal(writes, 1);
    assert.equal(f.store.database.prepare("SELECT count(*) n FROM host_office_local_terminals").get().n, afterCommit ? 1 : 0);
    assert.throws(() => f.tracker.prepareOfficeLocalEffect(state.ticket, { effectId: "late-cleanup", ordinal: 6,
      kind: "unlink", mode: "cleanup", memberId: "temporary", preparedAt: now() }), { code: "host_office_local_execution_sealed" });
    const first = f.store.listHostOfficeLocalEffects(f.plan.executionId)[0];
    assert.throws(() => f.tracker.recordOfficeLocalObservation(state.ticket, first.effectId, first.observationArtifactId),
      { code: "host_office_local_execution_sealed" });
    const artifact = f.store.getArtifact(failure.observationArtifactId);
    f.store.database.exec = exec;
    const terminal = f.tracker.sealOfficeLocalTerminal(state.ticket, {
      terminalArtifactId: artifact.id, terminalDigest: artifact.contentSha256,
    });
    assert.equal(terminal.terminalArtifactId, artifact.id);
    assert.equal(f.store.database.prepare("SELECT count(*) n FROM host_office_local_terminals").get().n, 1);
    assert.equal(writes, 1, "same-claim retry only persists facts, never re-enters the native writer");
    assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
    assert.throws(() => executeOfficeLocalWrite(f.plan), /already_entered/);
  });
}

for (const variant of ["create", "short-write", "overwrite"]) {
  test(`Office terminal native ${variant} replay uses sealed historical facts after target changes and SQLite reopens`, async t => {
    const f = await fixture(t);
    let plan = f.plan;
    if (variant === "overwrite") {
      executeOfficeLocalWrite(plan);
      const reservation = reserveOfficeLocalWriter(f.tracker, f.store, "office-overwrite-call", f.cwd);
      const snapshot = captureOfficeLocalSnapshot(f.cwd, "result.docx", "docx", f.source);
      const artifact = await prepareOfficeArtifact("office_create_document", { path: "result.docx", overwrite: true,
        blocks: [{ type: "paragraph", text: "Replacement real Office SDK output" }] });
      plan = prepareOfficeLocalWrite(reservation, snapshot, artifact, "c".repeat(64), "d".repeat(64));
    }
    let writes = 0;
    if (variant === "short-write") patchFs(t, "writeSync", original => (fd, bytes, offset, length, position) => {
      writes++; return original(fd, bytes, offset, Math.min(length, 1024), position);
    });
    const result = executeOfficeLocalWrite(plan), execution = f.store.getHostOfficeLocalExecution(plan.executionId);
    if (variant === "short-write") assert.ok(writes > 1, "the OS must really return multiple short writes");
    assert.equal(result.observation.outcome, "published");
    // The verifier must not consult today's bytes or recover a serialized FD.
    writeFileSync(execution.targetPath, "unrelated later content");
    fs.unlinkSync(execution.targetPath);
    const reopened = createSqliteRunStore(f.cwd);
    try {
      const terminal = reopened.getHostOfficeLocalTerminal(plan.executionId);
      const effects = reopened.listHostOfficeLocalEffects(plan.executionId).map(effect => ({ effect,
        observation: reopened.getArtifact(effect.observationArtifactId).sealedPayload }));
      const verified = verifyOfficeLocalReplay({ execution: reopened.getHostOfficeLocalExecution(plan.executionId), terminal, effects });
      assert.equal(verified.kind, "office_local_published_verified");
      assert.equal(verified.executionIdentityDigest, execution.identityDigest);
      assert.equal(verified.effectCount, effects.length);
      assert.equal(existsSync(execution.targetPath), false);
      assert.equal(verified.recoveryMemberId, variant === "overwrite" ? "recovery" : undefined);
      assert.equal(reopened.getHostOperation(execution.parentOperationId).phase, "launched",
        "a pure replay data result still cannot settle the original journal roles");
    } finally { reopened.close(); }
  });
}

test("Office read-only final close must retain unknown resource and cannot report published", async t => {
  const f = await fixture(t), state = officeLocalWriteState(f.plan);
  const nativeOpen = fs.openSync, nativeClose = fs.closeSync, nativeFstat = fs.fstatSync;
  const paths = new Map(f.prepared.members.map(member => [member.path, member.memberId]));
  const observeFinal = state.ledger.observeFinal.bind(state.ledger), readOpens = [];
  let finalPhase = false, finalFd, borrowedFd, originalIdentity, closes = 0, statsAfterUnknown = 0, injected = false, writeOpens = 0;
  state.ledger.observeFinal = (...args) => {
    finalPhase = true;
    try { return observeFinal(...args); } finally { finalPhase = false; }
  };
  t.after(() => { state.ledger.observeFinal = observeFinal; });
  patchFs(t, "openSync", original => (...args) => {
    const fd = original(...args), memberId = paths.get(args[0]), flags = args[1];
    if (memberId && typeof flags === "number") {
      if ((flags & fs.constants.O_WRONLY) !== 0) writeOpens++;
      else {
        readOpens.push({ memberId, fd, final: finalPhase });
        if (finalPhase && args[0] === f.prepared.targetPath) finalFd = fd;
      }
    }
    return fd;
  });
  patchFs(t, "fstatSync", original => (...args) => {
    if (injected && args[0] === borrowedFd) statsAfterUnknown++;
    return original(...args);
  });
  patchFs(t, "closeSync", original => fd => {
    if (fd !== finalFd) return original(fd);
    closes++;
    if (!injected) {
      originalIdentity = nativeFstat(fd, { bigint: true });
      original(fd);
      borrowedFd = nativeOpen(f.prepared.targetPath, "r");
      assert.equal(borrowedFd, finalFd, "the actual OS must reuse this number for the same inode");
      injected = true;
      throw Object.assign(new Error("final read close outcome is unknown"), { code: "EINTR" });
    }
    return original(fd);
  });
  t.after(() => {
    if (borrowedFd !== undefined) {
      try { nativeClose(borrowedFd); } catch (error) { if (error.code !== "EBADF") throw error; }
    }
  });
  let result, failure;
  try { result = executeOfficeLocalWrite(f.plan); } catch (error) { failure = error; }
  assert.equal(injected, true, "fault must reach the final target read, not SDK preparation or a writer FD");
  assert.equal(readOpens.some(row => row.final && row.memberId === "target" && row.fd === finalFd), true);
  assert.equal(closes, 1, "unknown read close cannot be retried against the borrowed descriptor");
  assert.equal(statsAfterUnknown, 0, "unknown read resource cannot fstat the OS-reused number");
  const borrowedIdentity = nativeFstat(borrowedFd, { bigint: true });
  assert.equal(borrowedIdentity.dev, originalIdentity.dev); assert.equal(borrowedIdentity.ino, originalIdentity.ino);
  assert.deepEqual(fs.readFileSync(borrowedFd), f.artifact.bytes);
  if (failure) assert.ok(failure instanceof OfficeLocalWriterError, "failure must retain the actual writer observation");
  const observation = failure?.observation ?? result.observation;
  const target = observation.members.find(member => member.memberId === "target");
  assert.deepEqual(target.final, { state: "unobserved", errorCode: "EINTR" });
  const unknownReads = observation.resources.filter(resource => resource.memberId === "target" && resource.state === "unknown");
  t.diagnostic(JSON.stringify({ injected, readOpens: readOpens.length, writeOpens,
    resourceCount: observation.resources.length, unknownTargetReads: unknownReads.length,
    outcome: observation.outcome, writerError: failure instanceof OfficeLocalWriterError,
    finalTarget: target.final, closeAttempts: closes, fstatsAfterUnknown: statsAfterUnknown }));
  assert.equal(unknownReads.length, 1, "the original final read FD must be in the resource roster even when close throws");
  assert.equal(unknownReads[0].origin, "member_read");
  assert.equal(unknownReads[0].purpose, "final");
  assert.ok(unknownReads[0].resourceLifetimeId && unknownReads[0].readId);
  assert.ok(unknownReads[0].openCalledAt <= unknownReads[0].openReturnedAt);
  assert.ok(unknownReads[0].openReturnedAt <= unknownReads[0].closeEnteredAt);
  assert.equal(unknownReads[0].closeReturnedAt, undefined);
  assert.equal("openEffectId" in unknownReads[0], false, "member read must not forge a Core open effect");
  assert.equal("closeEffectId" in unknownReads[0], false, "member read must not forge a Core close effect");
  assert.equal("fd" in unknownReads[0], false);
  assert.equal(observation.resources.length, readOpens.length + writeOpens, "every successful member read open needs its own resource lifetime");
  assert.equal(observation.resources.filter(resource => resource.state !== "closed").length, 1);
  assert.equal(observation.outcome, "failed", "a missing final read/close fact must not masquerade as fully published");
  assert.ok(failure instanceof OfficeLocalWriterError);
  assert.equal(observation.publicationEntered, true, "already entered publication is not no-start");
  assert.equal(existsSync(f.prepared.targetPath), true, "failed final observation does not undo the actual prior publication");
  for (const operation of [state.parent, state.producer]) {
    assert.throws(() => f.tracker.settleNoStart(operation), { code: "attempt_host_operation_launched_no_start" });
    assert.throws(() => f.tracker.settleFromStore(operation));
  }
  assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
});

test("Office read-only first fstat failure retains the original read lifetime before one finally close", async t => {
  const f = await fixture(t), state = officeLocalWriteState(f.plan), nativeFstat = fs.fstatSync;
  const observeFinal = state.ledger.observeFinal.bind(state.ledger);
  let finalPhase = false, finalOwner, finalFd, retainedBeforeFailure, injected = false, stats = 0, closes = 0, reads = 0;
  state.ledger.observeFinal = (owner, ...args) => {
    finalPhase = true; finalOwner = owner;
    try { return observeFinal(owner, ...args); } finally { finalPhase = false; }
  };
  t.after(() => { state.ledger.observeFinal = observeFinal; });
  patchFs(t, "openSync", original => (...args) => {
    const fd = original(...args);
    if (finalPhase && args[0] === f.prepared.targetPath) finalFd = fd;
    return fd;
  });
  patchFs(t, "fstatSync", original => (...args) => {
    if (args[0] === finalFd) {
      stats++;
      if (!injected) {
        assert.ok(finalOwner instanceof OfficeLocalResourceOwner, "real writer must pass the same live owner to final reads");
        retainedBeforeFailure = finalOwner.snapshots().find(resource => resource.origin === "member_read"
          && resource.memberId === "target" && resource.purpose === "final" && resource.state === "retained");
        assert.ok(retainedBeforeFailure, "retain the actual open return before its first fstat");
        assert.equal(retainedBeforeFailure.identity, undefined);
        assert.equal(retainedBeforeFailure.closeEnteredAt, undefined);
        injected = true;
        throw Object.assign(new Error("first final read fstat failed"), { code: "EIO" });
      }
    }
    return original(...args);
  });
  patchFs(t, "readSync", original => (...args) => {
    if (args[0] === finalFd) reads++;
    return original(...args);
  });
  patchFs(t, "closeSync", original => fd => {
    if (fd === finalFd) closes++;
    return original(fd);
  });
  let failure;
  assert.throws(() => {
    try { executeOfficeLocalWrite(f.plan); } catch (error) { failure = error; throw error; }
  }, OfficeLocalWriterError);
  assert.equal(injected, true, "fault must be the first fstat after the real final target read open");
  assert.equal(stats, 1); assert.equal(reads, 0); assert.equal(closes, 1, "the original finally must close once without retrying fstat");
  assert.throws(() => nativeFstat(finalFd), { code: "EBADF" });
  const observation = failure.observation;
  const target = observation.members.find(member => member.memberId === "target");
  assert.deepEqual(target.final, { state: "unobserved", errorCode: "EIO" });
  const readResource = observation.resources.find(resource => resource.resourceLifetimeId === retainedBeforeFailure.resourceLifetimeId);
  assert.ok(readResource, "the failed read lifetime must survive into the complete writer resource roster");
  assert.equal(readResource.origin, "member_read"); assert.equal(readResource.purpose, "final");
  assert.equal(readResource.state, "closed"); assert.equal(readResource.readId, retainedBeforeFailure.readId);
  assert.equal(readResource.identity, undefined); assert.equal(readResource.identityObservedAt, undefined);
  assert.ok(readResource.openCalledAt <= readResource.openReturnedAt);
  assert.ok(readResource.openReturnedAt <= readResource.closeEnteredAt);
  assert.ok(readResource.closeEnteredAt <= readResource.closeReturnedAt);
  assert.equal("fd" in readResource, false);
  assert.equal("openEffectId" in readResource, false); assert.equal("closeEffectId" in readResource, false);
  const effectResource = observation.resources.find(resource => resource.origin === "effect");
  assert.ok(effectResource && effectResource.state === "closed");
  assert.notEqual(readResource.resourceLifetimeId, effectResource.resourceLifetimeId);
  assert.equal(observation.outcome, "failed"); assert.equal(observation.publicationEntered, true);
  for (const operation of [state.parent, state.producer]) {
    assert.throws(() => f.tracker.settleNoStart(operation), { code: "attempt_host_operation_launched_no_start" });
    assert.throws(() => f.tracker.settleFromStore(operation));
  }
  assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
});

test("Office effect seal timestamp cannot precede its completed observation", async t => {
  const f = await fixture(t), OriginalDate = globalThis.Date;
  let tick = OriginalDate.now() + 1000;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [tick++])); }
  };
  t.after(() => { globalThis.Date = OriginalDate; });
  let result;
  assert.doesNotThrow(() => { result = executeOfficeLocalWrite(f.plan); },
    "distinct clock ticks must not cause valid native effects to lose their observations");
  assert.deepEqual(readFileSync(result.path), f.artifact.bytes);
  const effects = f.store.listHostOfficeLocalEffects(f.plan.executionId);
  assert.ok(effects.length > 0);
  for (const effect of effects) {
    const seal = f.store.getArtifact(effect.observationArtifactId);
    assert.ok(seal, "each entered effect must retain a validated immutable observation");
    assert.equal(seal.sealedPayload.host.state, "returned");
    assert.ok(seal.sealedPayload.completedAt <= seal.createdAt);
  }
});

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
  assert.throws(() => f.tracker.settleNoStart(state.parent), { code: "attempt_host_operation_launched_no_start" });
  assert.throws(() => f.tracker.settleNoStart(state.producer), { code: "attempt_host_operation_launched_no_start" });
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

for (const afterCommit of [false, true]) {
  test(`Office close-return Host COMMIT ${afterCommit ? "post-COMMIT throw" : "rollback"} preserves closed resource and borrowed same-inode FD`, async t => {
    const f = await fixture(t), state = officeLocalWriteState(f.plan), exec = f.store.database.exec.bind(f.store.database);
    const nativeClose = fs.closeSync, nativeFstat = fs.fstatSync;
    let writerFd, borrowedFd, originalIdentity, closes = 0, inject = true, injected = false, closeReturnedAt;
    patchFs(t, "openSync", original => (...args) => {
      const fd = original(...args);
      if (args[0] === f.temporary && (args[1] & fs.constants.O_WRONLY)) writerFd = fd;
      return fd;
    });
    patchFs(t, "closeSync", original => fd => {
      if (fd !== writerFd) return original(fd);
      closes++;
      originalIdentity = nativeFstat(fd, { bigint: true });
      const result = original(fd);
      closeReturnedAt = now();
      borrowedFd = fs.openSync(f.temporary, "r");
      assert.equal(borrowedFd, writerFd, "the OS must actually reuse the original number, without a mocked FD");
      return result;
    });
    f.store.database.exec = sql => {
      if (sql === "COMMIT" && inject && closes > 0) {
        inject = false; injected = true;
        if (afterCommit) exec(sql);
        throw Object.assign(new Error("Host COMMIT failed after actual native close return"), { code: "EIO" });
      }
      return exec(sql);
    };
    t.after(() => { f.store.database.exec = exec; });
    t.after(() => {
      if (borrowedFd !== undefined) {
        try { nativeClose(borrowedFd); } catch (error) { if (error.code !== "EBADF") throw error; }
      }
    });
    let failure;
    assert.throws(() => {
      try { executeOfficeLocalWrite(f.plan); } catch (error) { failure = error; throw error; }
    }, OfficeLocalWriterError);
    assert.equal(injected, true, "fault must occur on the real SQLite COMMIT after the close returned");
    assert.equal(closes, 1, "a confirmed native close cannot be retried during cleanup after Host failure");
    const closeRows = effectPayloads(f).filter(row => row.effect.kind === "close");
    assert.equal(closeRows.length, 1);
    const { effect, payload } = closeRows[0], resource = failure.observation.resources[0];
    assert.ok(effect.enteredAt, "COMMIT rollback is repaired only by the original live callback latch");
    assert.equal(payload.native.state, "returned");
    assert.deepEqual(payload.native.result, { kind: "close", resourceLifetimeId: effect.resourceLifetimeId });
    assert.deepEqual(payload.host, { state: "unconfirmed", errorCode: "EIO" });
    assert.deepEqual(payload.source, f.source);
    assert.ok(payload.native.calledAt >= effect.enteredAt);
    assert.ok(payload.native.returnedAt >= closeReturnedAt);
    assert.ok(payload.native.returnedAt <= payload.completedAt);
    assert.equal(resource.state, "closed", "Host rollback cannot roll back a real native close");
    assert.equal(resource.resourceLifetimeId, effect.resourceLifetimeId);
    assert.equal(resource.closeEffectId, effect.effectId);
    assert.equal("fd" in resource, false);
    assert.equal(failure.observation.outcome, "failed");
    assert.equal(failure.observation.publicationEntered, false);
    assert.equal(existsSync(f.prepared.targetPath), false);
    const borrowedIdentity = nativeFstat(borrowedFd, { bigint: true });
    assert.equal(borrowedIdentity.dev, originalIdentity.dev); assert.equal(borrowedIdentity.ino, originalIdentity.ino);
    assert.deepEqual(fs.readFileSync(borrowedFd), f.artifact.bytes, "same-inode borrowed descriptor remains usable after failed Host COMMIT");
    for (const operation of [state.parent, state.producer]) {
      assert.throws(() => f.tracker.settleNoStart(operation), { code: "attempt_host_operation_launched_no_start" });
      assert.throws(() => f.tracker.settleFromStore(operation), "no terminal verifier receipt exists to grant safe");
    }
    for (const operationId of [f.prepared.parentOperationId, f.prepared.producerOperationId]) {
      const original = f.store.getHostOperation(operationId);
      assert.equal(original.phase, "launched"); assert.equal(original.settledAt, undefined);
    }
    assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
    assert.throws(() => executeOfficeLocalWrite(f.plan), /already_entered/);
    assert.equal(closes, 1);
    assert.doesNotThrow(() => nativeFstat(borrowedFd));
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
  assert.equal(result.observation.resources.every(row => row.state === "closed"), true);
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
  assert.throws(() => assertOfficeLocalReservation({ ...f.reservation }), /office_local_reservation_closed/);
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
  const ledger = new OfficeLocalMemberLedger(f.cwd, [member], f.prepared.workspaceIdentity), owner = new OfficeLocalResourceOwner("member-test", f.source);
  writeFileSync(f.temporary, "bounded");
  patchFs(t, "readFileSync", original => (...args) => {
    if (args[0] === f.temporary) throw new Error("unbounded_path_read_forbidden");
    return original(...args);
  });
  const identity = officeFileIdentity(fs.lstatSync(f.temporary, { bigint: true }));
  assert.doesNotThrow(() => ledger.refresh("temporary", owner, { state: "file", identity }));
  assert.equal(ledger.expected("temporary").sizeBytes, 7);
});

test("Office final residue observation cannot grant cleanup authority for an external member", async t => {
  const f = await fixture(t), ledger = officeLocalWriteState(f.plan).ledger;
  const owner = new OfficeLocalResourceOwner("member-test", f.source);
  writeFileSync(f.temporary, "external-owned-file");
  const final = ledger.observeFinal(owner).find(row => row.memberId === "temporary");
  assert.equal(final.final.state, "file");
  assert.deepEqual(ledger.expected("temporary"), { state: "absent" });
  assert.throws(() => ledger.refresh("temporary", owner), /snapshot_changed/);
  assert.deepEqual(ledger.expected("temporary"), { state: "absent" });
});

test("Office refresh binds the existing owned inode even when a replacement has identical bytes", async t => {
  const f = await fixture(t), ledger = officeLocalWriteState(f.plan).ledger;
  const owner = new OfficeLocalResourceOwner("member-test", f.source);
  writeFileSync(f.temporary, "same bytes");
  const identity = officeFileIdentity(fs.lstatSync(f.temporary, { bigint: true }));
  ledger.refresh("temporary", owner, { state: "file", identity });
  const expected = ledger.expected("temporary");
  renameSync(f.temporary, join(f.cwd, "original-owned.tmp"));
  writeFileSync(f.temporary, "same bytes");
  assert.throws(() => ledger.refresh("temporary", owner), /snapshot_changed/);
  assert.deepEqual(ledger.expected("temporary"), expected);
  assert.equal(ledger.observeFinal(owner).find(row => row.memberId === "temporary").final.state, "file");
  assert.deepEqual(ledger.expected("temporary"), expected);
});

test("Office member reads bind one FD, handle short reads and cannot extend allocation when the file grows", async t => {
  const f = await fixture(t), ledger = officeLocalWriteState(f.plan).ledger;
  const owner = new OfficeLocalResourceOwner("member-test", f.source);
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
  ledger.refresh("temporary", owner, { state: "file", identity });
  assert.equal(reads, 4);
  assert.equal(ledger.expected("temporary").bytesSha256, officeBytesDigest(Buffer.from("bounded")));
  const expected = ledger.expected("temporary");
  grow = true;
  assert.throws(() => ledger.refresh("temporary", owner), /snapshot_changed/);
  assert.deepEqual(ledger.expected("temporary"), expected);
});

test("Office Tracker cannot relabel a forward row cleanup after local admission closes", async t => {
  const f = await fixture(t), state = officeLocalWriteState(f.plan), tracker = f.tracker;
  const resourceLifetimeId = "tracker-open-lifetime";
  const open = tracker.prepareOfficeLocalEffect(state.ticket, { effectId: "open", ordinal: 0, kind: "open", mode: "forward",
    memberId: "temporary", resourceLifetimeId, preparedAt: now() });
  let calledAt, returnedAt;
  tracker.launchOfficeLocalEffect(state.ticket, open.effectId, () => {
    calledAt = now();
    const fd = fs.openSync(f.temporary, "wx");
    returnedAt = now();
    fs.closeSync(fd);
  }, "forward");
  const completedAt = now();
  const seal = f.store.createArtifact({ runId: "run", type: "json", path: "office/open.json", createdAt: completedAt, sealedPayload: {
    schemaVersion: 1, protocol: "ling-office-local-binary-v1", kind: "office_local_effect_v1", executionId: f.plan.executionId,
    executionIdentityDigest: state.identityDigest, source: f.source, effectId: open.effectId, effectDigest: open.effectDigest,
    native: { state: "returned", calledAt, returnedAt, result: { kind: "open", resourceLifetimeId } },
    host: { state: "returned" }, completedAt,
  } });
  tracker.recordOfficeLocalObservation(state.ticket, open.effectId, seal.id);
  const write = tracker.prepareOfficeLocalEffect(state.ticket, { effectId: "write", ordinal: 1, kind: "write", mode: "forward",
    memberId: "temporary", resourceLifetimeId, offset: 0, sizeBytes: 1, preparedAt: now() });
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
  const { payload } = effectPayloads(f).find(row => row.effect.kind === "open");
  assert.equal(payload.native.state, "returned", "fstat failure cannot rewrite the real native open return");
  assert.equal(payload.host.state, "unconfirmed");
  assert.equal("openResource" in payload, false, "cleanup's later fstat cannot backfill the first open seal");
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
  assert.equal(failure.observation.resources[0].state, "unknown");
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
  const owner = new OfficeLocalResourceOwner("member-test", f.source);
  writeFileSync(f.temporary, "small"); fs.truncateSync(f.temporary, 50 * 1024 * 1024 + 1);
  let reads = 0;
  patchFs(t, "readSync", original => (...args) => { reads++; return original(...args); });
  const final = ledger.observeFinal(owner).find(row => row.memberId === "temporary");
  assert.deepEqual(final.final, { state: "unobserved", errorCode: "office_document_too_large" });
  assert.equal(reads, 0);
  assert.deepEqual(ledger.expected("temporary"), { state: "absent" });
});

for (const rollbackAfter of ["open return", "second fstat"]) {
  test(`Office read-only clock rollback after ${rollbackAfter} retains and closes the actual final read once`, async t => {
    const f = await fixture(t), state = officeLocalWriteState(f.plan), OriginalDate = globalThis.Date;
    const nativeFstat = fs.fstatSync, nativeClose = fs.closeSync;
    const observeFinal = state.ledger.observeFinal.bind(state.ledger);
    const members = new Map(f.prepared.members.map(member => [member.path, member.memberId]));
    let tick, finalPhase = false, finalOwner, targetFd, rolledBack = false, stats = 0, closes = 0;
    let targetReadOpen = false, retainedBeforeInspection;
    const readOpens = [], effectOpens = [];
    state.ledger.observeFinal = (owner, ...args) => {
      finalPhase = true; finalOwner = owner; tick = OriginalDate.now();
      globalThis.Date = class extends OriginalDate {
        constructor(...values) { super(...(values.length ? values : [tick])); }
        static now() { return tick; }
      };
      try { return observeFinal(owner, ...args); }
      finally { finalPhase = false; globalThis.Date = OriginalDate; }
    };
    t.after(() => { state.ledger.observeFinal = observeFinal; globalThis.Date = OriginalDate; });
    patchFs(t, "openSync", original => (...args) => {
      const fd = original(...args), memberId = members.get(args[0]);
      if (memberId && typeof args[1] === "number") {
        if ((args[1] & fs.constants.O_WRONLY) !== 0) effectOpens.push(fd);
        else readOpens.push(fd);
      }
      if (finalPhase && args[0] === f.prepared.targetPath) {
        targetFd = fd; targetReadOpen = true;
        if (rollbackAfter === "open return") { tick--; rolledBack = true; }
      }
      return fd;
    });
    patchFs(t, "fstatSync", original => (...args) => {
      const targetRead = finalPhase && targetReadOpen && args[0] === targetFd;
      if (targetRead) {
        stats++;
        if (stats === 1) retainedBeforeInspection = finalOwner.snapshots().find(resource => resource.origin === "member_read"
          && resource.memberId === "target" && resource.purpose === "final" && resource.state === "retained");
      }
      const result = original(...args);
      if (targetRead && stats === 2 && rollbackAfter === "second fstat") { tick--; rolledBack = true; }
      return result;
    });
    patchFs(t, "closeSync", original => fd => {
      if (finalPhase && targetReadOpen && fd === targetFd) {
        closes++; const result = original(fd); targetReadOpen = false; return result;
      }
      return original(fd);
    });
    t.after(() => {
      if (targetReadOpen && targetFd !== undefined) {
        try { nativeClose(targetFd); } catch (error) { if (error.code !== "EBADF") throw error; }
      }
    });
    let result, failure;
    try { result = executeOfficeLocalWrite(f.plan); } catch (error) { failure = error; }
    assert.equal(rolledBack, true, "the fault must reach a real final target open/read, not fixture preparation or a Host write");
    assert.ok(finalOwner instanceof OfficeLocalResourceOwner);
    assert.equal(existsSync(f.prepared.targetPath), true, "publication must already have entered before this final-read clock fault");
    if (failure) assert.ok(failure instanceof OfficeLocalWriterError);
    const observation = failure?.observation ?? result.observation;
    const targetReads = observation.resources.filter(resource => resource.origin === "member_read" && resource.memberId === "target"
      && resource.purpose === "final");
    t.diagnostic(JSON.stringify({ rollbackAfter, rolledBack, stats, closes, finalTargetReads: targetReads.length,
      resourceCount: observation.resources.length, nativeOpens: readOpens.length + effectOpens.length,
      targetState: observation.members.find(member => member.memberId === "target").final.state,
      outcome: observation.outcome, writerError: failure instanceof OfficeLocalWriterError }));
    assert.equal(targetReads.length, 1, "every actual returned final read FD must remain in the original owner's roster after clock rollback");
    assert.ok(retainedBeforeInspection, "the actual final read must be retained before its first fstat despite wall-clock rollback");
    const read = targetReads[0];
    assert.equal(read.resourceLifetimeId, retainedBeforeInspection.resourceLifetimeId);
    assert.equal(read.readId, retainedBeforeInspection.readId);
    assert.equal(observation.resources.length, readOpens.length + effectOpens.length, "the complete roster must include every actual owned open");
    assert.equal(stats, 2); assert.equal(closes, 1, "wall-clock validation must not skip the original finally close");
    assert.equal(read.state, "closed"); assert.throws(() => nativeFstat(targetFd), { code: "EBADF" });
    assert.ok(read.openCalledAt <= read.openReturnedAt && read.openReturnedAt <= read.identityObservedAt);
    assert.ok(read.identityObservedAt <= read.closeEnteredAt && read.closeEnteredAt <= read.closeReturnedAt);
    assert.equal("fd" in read, false); assert.equal("openEffectId" in read, false); assert.equal("closeEffectId" in read, false);
    const target = observation.members.find(member => member.memberId === "target");
    assert.equal(target.final.state, "file");
    assert.deepEqual(target.readRef, { readId: read.readId, resourceLifetimeId: read.resourceLifetimeId, completedAt: read.closeReturnedAt });
    assert.equal(observation.outcome, "published"); assert.equal(failure, undefined);
  });
}
