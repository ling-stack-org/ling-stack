import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence, HOST_OFFICE_LOCAL_PROTOCOL } from "../dist/index.js";
import { SqliteHostOperationJournalStore } from "../dist/storage/sqlite/host-operation-journal-store.js";

const now = () => new Date().toISOString();
const code = expected => error => error.code === expected;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

/** Real isolated SQLite and binary filesystem calls; not packaged Office/GUI evidence. */
async function fixture(t, override = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-office-local-facts-"));
  const store = createSqliteRunStore(cwd), other = createSqliteRunStore(cwd);
  t.after(async () => { other.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const at = now();
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "unit", status: "running", createdByActor: "system", request: {}, now: at });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "original-office", runnerId: "pi", status: "started", now: at });
  const fence = toRuntimeAttemptFence(attempt);
  const thread = store.createLingThread({ kind: "conversation", title: "Office binary", objective: "Original source" }, at);
  const turn = store.appendConversationUserTurn({ threadId: thread.id, title: "Create", userInstruction: "Create",
    idempotencyKey: "turn", payload: { body: "Create", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, at);
  const run = store.createRun({ id: "run", cwd, workUnitId: unit.id, threadId: thread.id, turnId: turn.turnId,
    taskId: "task", providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: at });
  store.linkRunToWorkUnit(run.id, unit.id, at); store.markRunStarted(run.id, at);
  const source = { runId: run.id, ...fence }, toolCallId = "office-call";
  const parent = store.admitHostOperation({ operationId: "parent", source, kind: "mcp", toolCallId });
  const producer = store.admitHostOperation({ operationId: "writer", source, kind: "file_mutation", toolCallId,
    parentOperationId: parent.operationId, producerId: "office-local-binary" });
  const bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0xff, 0x80]), targetPath = join(cwd, "result.docx"), tempPath = join(cwd, ".result.office.tmp");
  const prepared = { schemaVersion: 1, protocol: HOST_OFFICE_LOCAL_PROTOCOL, executionId: "office-execution", source,
    parentOperationId: "parent", producerOperationId: "writer", toolCallId, toolName: "office_create_document", format: "docx",
    workspacePath: cwd, targetPath, overwrite: false, requestDigest: "a".repeat(64), policyDigest: "b".repeat(64),
    input: { state: "absent" }, output: { bytesSha256: hash(bytes), sizeBytes: bytes.length }, members: [
      { memberId: "target", role: "target", path: targetPath, initial: { state: "absent" } },
      { memberId: "temp", role: "temporary", path: tempPath, initial: { state: "absent" } },
    ], preparedAt: now(), ...override };
  const seal = payload => store.createArtifact({ runId: "run", type: "json", path: "office/facts.json", createdAt: now(), sealedPayload: payload });
  const artifact = seal(prepared), prepare = () => store.prepareHostOfficeLocalExecution(parent, producer,
    { executionId: prepared.executionId, preparedArtifactId: artifact.id, preparedDigest: artifact.contentSha256 });
  const f = { cwd, store, other, unit, source, fence, thread, turn, parent, producer, bytes, prepared, artifact, seal, prepare, tempPath };
  f.effect = (ticket, override = {}) => store.prepareHostOfficeLocalEffect(ticket, { effectId: "open-temp", ordinal: 0,
    kind: "open", mode: "forward", memberId: "temp", preparedAt: now(), ...override });
  f.observe = (ticket, effect, outcome = "returned", override = {}) => {
    const execution = store.getHostOfficeLocalExecution(ticket.executionId);
    const receipt = seal({ schemaVersion: 1, protocol: HOST_OFFICE_LOCAL_PROTOCOL, kind: "office_local_effect_v1",
      executionId: ticket.executionId, executionIdentityDigest: execution.identityDigest, source, effectId: effect.effectId,
      effectDigest: effect.effectDigest, outcome, completedAt: now(), ...(outcome === "failed" ? { errorCode: "fs.failed" } : {}), ...override });
    return { receipt, record: () => store.recordHostOfficeLocalObservation(ticket, effect.effectId, receipt.id) };
  };
  f.ask = () => store.createUserInputRequest({ sourceRunId: "run", sourceItemId: turn.item.id, sourceFence: fence,
    toolCallId: "ask", idempotencyKey: "ask", toolInput: { schemaVersion: 1, waitMode: "required",
      questions: [{ questionId: "choice", prompt: "Choose", required: true, allowFreeText: true, options: [] }] } }, now());
  f.replace = () => store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 2,
    runtimeInstanceId: "successor-office", runnerId: "pi", status: "started", now: now() });
  return f;
}

test("Office 148 immutable preparation preserves full original lineage and never releases blockers", async t => {
  const f = await fixture(t), ticket = f.prepare(), row = f.other.getHostOfficeLocalExecution(ticket.executionId);
  assert.deepEqual(row.source, f.source); assert.deepEqual(row.members, f.prepared.members);
  assert.equal(row.preparedDigest, f.artifact.contentSha256); assert.equal(row.protocol, HOST_OFFICE_LOCAL_PROTOCOL);
  assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
  assert.throws(() => f.store.database.prepare("UPDATE host_office_local_executions SET tool_name='office_edit_document'").run(), /identity_immutable/);
  assert.throws(() => f.store.database.prepare("DELETE FROM host_office_local_executions").run(), /append_only/);
  assert.deepEqual(f.store.database.prepare("PRAGMA foreign_key_check").all(), []);
});

for (const change of [
  { protocol: "ling-apply-patch-v1" }, { toolName: "write" }, { toolName: "office_edit_document" },
  { format: "xlsx" }, { targetPath: "/private/foreign.docx" }, { output: { bytesSha256: "x".repeat(64), sizeBytes: 8 } },
  { members: [] }, { source: { runId: "foreign" } }, { producerOperationId: "parent" }, { overwrite: "true" },
]) {
  test(`Office preparation rejects altered ${Object.keys(change)[0]} before any execution fact`, async t => {
    const f = await fixture(t, change);
    assert.throws(f.prepare);
    assert.equal(f.other.database.prepare("SELECT count(*) AS n FROM host_office_local_executions").get().n, 0);
    assert.equal(f.other.getHostOperation("writer").phase, "admitted");
  });
}

test("Office execution and original journal tickets cannot be cloned or transferred between stores", async t => {
  const f = await fixture(t), ticket = f.prepare();
  for (const writer of [f.store, f.other]) {
    assert.throws(() => writer.prepareHostOfficeLocalEffect({ ...ticket }, { effectId: "e" }), code("host_office_local_invalid_ticket"));
  }
  assert.throws(() => f.other.prepareHostOfficeLocalEffect(ticket, { effectId: "e" }), code("host_office_local_invalid_ticket"));
  assert.throws(() => f.store.prepareHostOfficeLocalExecution({ ...f.parent }, f.producer,
    { executionId: f.prepared.executionId, preparedArtifactId: f.artifact.id, preparedDigest: f.artifact.contentSha256 }), code("host_operation_invalid_ticket"));
});

test("Office valid binary seal for a different workspace cannot borrow the original source", async t => {
  const f = await fixture(t), foreign = join(f.cwd, "foreign-workspace"), targetPath = join(foreign, "result.docx");
  const artifact = f.seal({ ...f.prepared, workspacePath: foreign, targetPath, members: [
    { memberId: "target", role: "target", path: targetPath, initial: { state: "absent" } },
    { memberId: "temp", role: "temporary", path: join(foreign, ".result.office.tmp"), initial: { state: "absent" } },
  ] });
  assert.throws(() => f.store.prepareHostOfficeLocalExecution(f.parent, f.producer, {
    executionId: f.prepared.executionId, preparedArtifactId: artifact.id, preparedDigest: artifact.contentSha256,
  }), code("host_office_local_evidence_invalid"));
  assert.equal(f.other.database.prepare("SELECT count(*) AS n FROM host_office_local_executions").get().n, 0);
});

test("Office actual binary write enters both original scopes, immutable observation still is not completion", async t => {
  const f = await fixture(t), ticket = f.prepare(), effect = f.effect(ticket);
  f.store.launchHostOfficeLocalEffect(ticket, effect.effectId, () => writeFileSync(f.tempPath, f.bytes, { flag: "wx" }));
  assert.deepEqual(readFileSync(f.tempPath), f.bytes);
  for (const id of ["parent", "writer"]) assert.equal(f.other.getHostOperation(id).phase, "launched");
  const observation = f.observe(ticket, effect), row = observation.record();
  assert.equal(row.observationArtifactId, observation.receipt.id);
  assert.deepEqual(observation.record(), row);
  assert.throws(() => f.store.launchHostOfficeLocalEffect(ticket, effect.effectId, () => {}), code("host_office_local_effect_already_entered"));
  for (const operation of [f.parent, f.producer]) {
    assert.throws(() => f.store.settleHostOperation(operation, { kind: "known_no_start" }), code("host_operation_launched_no_start"));
    assert.throws(() => f.store.settleHostOperation(operation, { kind: "file_completed" }));
  }
  assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
});

for (const condition of ["required", "replacement"]) {
  test(`Office ${condition} between preparation and actual syscall prevents all physical writes`, async t => {
    const f = await fixture(t), ticket = f.prepare(), effect = f.effect(ticket);
    if (condition === "required") f.ask(); else f.replace();
    let writes = 0;
    assert.throws(() => f.store.launchHostOfficeLocalEffect(ticket, effect.effectId, () => { writes++; writeFileSync(f.tempPath, f.bytes); }));
    assert.equal(writes, 0); assert.equal(existsSync(f.tempPath), false);
    assert.equal(f.other.listHostOfficeLocalEffects(ticket.executionId)[0].enteredAt, undefined);
  });
}

for (const afterCommit of [false, true]) {
  test(`Office syscall followed by ${afterCommit ? "post-COMMIT exception" : "COMMIT rollback"} retains entered fact and never repeats publication`, async t => {
    const f = await fixture(t), ticket = f.prepare(), effect = f.effect(ticket);
    const exec = f.store.database.exec.bind(f.store.database); let inject = true, writes = 0;
    f.store.database.exec = sql => {
      if (sql === "COMMIT" && inject && writes > 0) { inject = false; if (afterCommit) exec(sql); throw new Error("office commit fault"); }
      return exec(sql);
    };
    assert.throws(() => f.store.launchHostOfficeLocalEffect(ticket, effect.effectId, () => { writes++; writeFileSync(f.tempPath, f.bytes, { flag: "wx" }); }), /office commit fault/);
    f.store.database.exec = exec;
    assert.equal(writes, 1); assert.deepEqual(readFileSync(f.tempPath), f.bytes);
    assert.equal(!!f.other.listHostOfficeLocalEffects(ticket.executionId)[0].enteredAt, afterCommit);
    const observation = f.observe(ticket, effect); assert.ok(observation.record().enteredAt, "original live latch repairs observation, never invokes the syscall again");
    assert.equal(writes, 1);
    assert.throws(() => f.store.launchHostOfficeLocalEffect(ticket, effect.effectId, () => { writes++; }), code("host_office_local_effect_already_entered"));
    for (const operation of [f.parent, f.producer]) assert.throws(() => f.store.settleHostOperation(operation, { kind: "known_no_start" }), code("host_operation_launched_no_start"));
    const cleanup = f.effect(ticket, { effectId: "cleanup-temp", ordinal: 1, kind: "unlink", mode: "cleanup" });
    f.store.launchHostOfficeLocalEffect(ticket, cleanup.effectId, () => unlinkSync(f.tempPath));
    f.observe(ticket, cleanup).record(); assert.equal(existsSync(f.tempPath), false);
    assert.equal(f.other.listHostOperationBlockers(f.source).length, 2, "cleanup is not a safety receipt");
    const reopened = createSqliteRunStore(f.cwd);
    try {
      assert.equal(reopened.listHostOfficeLocalEffects(ticket.executionId).length, 2);
      assert.equal(reopened.listHostOperationBlockers(f.source).length, 2);
      assert.throws(() => reopened.launchHostOfficeLocalEffect(ticket, effect.effectId, () => { writes++; }), code("host_office_local_invalid_ticket"));
    } finally { reopened.close(); }
    assert.equal(writes, 1);
  });
}

test("Office failed callback cannot masquerade as no-start and old cleanup cannot use successor", async t => {
  const f = await fixture(t), ticket = f.prepare(), effect = f.effect(ticket);
  assert.throws(() => f.store.launchHostOfficeLocalEffect(ticket, effect.effectId, () => { writeFileSync(f.tempPath, f.bytes); throw new Error("partial failure"); }), /partial failure/);
  assert.throws(f.observe(ticket, effect, "not_entered").record);
  f.observe(ticket, effect, "failed").record();
  const cleanup = f.effect(ticket, { effectId: "cleanup", ordinal: 1, kind: "unlink", mode: "cleanup" });
  f.replace();
  const before = f.other.database.prepare("SELECT * FROM work_unit_attempts ORDER BY attempt_number").all();
  let removed = 0;
  assert.throws(() => f.store.launchHostOfficeLocalEffect(ticket, cleanup.effectId, () => { removed++; unlinkSync(f.tempPath); }), code("host_operation_stale_owner"));
  assert.equal(removed, 0); assert.equal(existsSync(f.tempPath), true);
  assert.deepEqual(f.other.database.prepare("SELECT * FROM work_unit_attempts ORDER BY attempt_number").all(), before);
});

for (const change of [
  { effectId: "foreign" }, { source: { runId: "foreign" } }, { executionIdentityDigest: "f".repeat(64) },
  { effectDigest: "f".repeat(64) }, { outcome: "not_entered" }, { protocol: "ling-apply-patch-v1" },
]) {
  test(`Office rejects ${Object.keys(change)[0]} observation substitution without changing facts`, async t => {
    const f = await fixture(t), ticket = f.prepare(), effect = f.effect(ticket);
    f.store.launchHostOfficeLocalEffect(ticket, effect.effectId, () => writeFileSync(f.tempPath, f.bytes));
    const before = f.other.listHostOfficeLocalEffects(ticket.executionId);
    assert.throws(f.observe(ticket, effect, "returned", change).record);
    assert.deepEqual(f.other.listHostOfficeLocalEffects(ticket.executionId), before);
  });
}

test("Office asynchronous callback is rejected before physical start; plain thenable remains blocked", async t => {
  const f = await fixture(t), ticket = f.prepare(), effect = f.effect(ticket); let writes = 0;
  assert.throws(() => f.store.launchHostOfficeLocalEffect(ticket, effect.effectId, async () => { writes++; }), code("host_operation_effect_must_be_synchronous"));
  assert.equal(writes, 0);
  assert.throws(() => f.store.launchHostOfficeLocalEffect(ticket, effect.effectId, () => Promise.reject(new Error("async result"))), /synchronous/);
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => f.store.settleHostOperation(f.producer, { kind: "known_no_start" }), code("host_operation_launched_no_start"));
});

test("Office cleanup label cannot admit a new scope before any original effect entered", async t => {
  const f = await fixture(t), ticket = f.prepare();
  assert.throws(() => f.effect(ticket, { mode: "cleanup", kind: "unlink" }), code("host_office_local_cleanup_not_entered"));
  assert.deepEqual(f.other.listHostOfficeLocalEffects(ticket.executionId), []);
  assert.equal(f.other.getHostOperation("parent").phase, "admitted");
});

test("Office effect history cannot reorder a later syscall before its actual prior observation", async t => {
  const f = await fixture(t), ticket = f.prepare(), effect = f.effect(ticket);
  f.store.launchHostOfficeLocalEffect(ticket, effect.effectId, () => writeFileSync(f.tempPath, f.bytes));
  f.observe(ticket, effect).record();
  assert.throws(() => f.effect(ticket, { effectId: "backdated", ordinal: 1, kind: "close", preparedAt: f.prepared.preparedAt }), code("host_office_local_evidence_invalid"));
  assert.equal(f.other.listHostOfficeLocalEffects(ticket.executionId).length, 1);
});

test("Office forward permission is derived from the captured descriptor, not a second accessor read", async t => {
  const f = await fixture(t), ticket = f.prepare(); f.ask();
  let reads = 0;
  const input = { effectId: "foreign-mode", ordinal: 0, kind: "open", memberId: "temp", preparedAt: now(),
    get mode() { reads++; return reads === 1 ? "forward" : "cleanup"; } };
  assert.throws(() => f.store.prepareHostOfficeLocalEffect(ticket, input), code("host_operation_admission_closed"));
  assert.equal(reads, 1); assert.deepEqual(f.other.listHostOfficeLocalEffects(ticket.executionId), []);
});

for (const descriptor of [
  { kind: "rename", memberId: "temp", fromMemberId: "target" },
  { kind: "unlink", memberId: "target" },
  { kind: "write", offset: 0, sizeBytes: 9 },
  { kind: "mkdir", memberId: "temp" },
]) {
  test(`Office ${descriptor.kind} descriptor cannot mutate outside its reserved binary role`, async t => {
    const f = await fixture(t), ticket = f.prepare();
    assert.throws(() => f.effect(ticket, descriptor), code("host_office_local_evidence_invalid"));
    assert.deepEqual(f.other.listHostOfficeLocalEffects(ticket.executionId), []);
  });
}

for (const descriptor of [{ kind: ["write"] }, { kind: ["mkdir"] }, { mode: ["forward"] }]) {
  test(`Office typed enum refuses array ${Object.keys(descriptor)[0]} instead of String coercion`, async t => {
    const f = await fixture(t), ticket = f.prepare();
    assert.throws(() => f.effect(ticket, descriptor), code("host_office_local_evidence_invalid"));
    assert.deepEqual(f.other.listHostOfficeLocalEffects(ticket.executionId), []);
  });
}

test("Office typed enum refuses array observation outcome", async t => {
  const f = await fixture(t), ticket = f.prepare(), effect = f.effect(ticket);
  f.store.launchHostOfficeLocalEffect(ticket, effect.effectId, () => writeFileSync(f.tempPath, f.bytes));
  assert.throws(f.observe(ticket, effect, "returned", { outcome: ["returned"] }).record, code("host_office_local_evidence_invalid"));
  assert.equal(f.other.listHostOfficeLocalEffects(ticket.executionId)[0].observationArtifactId, undefined);
});

test("Office typed enum refuses an extra array directory member role", async t => {
  const f = await fixture(t);
  const artifact = f.seal({ ...f.prepared, members: [...f.prepared.members,
    { memberId: "fake-dir", role: ["directory"], path: join(f.cwd, "extra"), initial: { state: "absent" } },
  ] });
  assert.throws(() => f.store.prepareHostOfficeLocalExecution(f.parent, f.producer, {
    executionId: f.prepared.executionId, preparedArtifactId: artifact.id, preparedDigest: artifact.contentSha256,
  }), code("host_office_local_evidence_invalid"));
});

function seam(f) {
  const journal = new SqliteHostOperationJournalStore({ database: f.store.database });
  const parent = journal.admitHostOperation({ operationId: "seam-parent", source: f.source, kind: "mcp", toolCallId: "internal-seam" });
  const producer = journal.admitHostOperation({ operationId: "seam-producer", source: f.source, kind: "file_mutation", toolCallId: "internal-seam",
    parentOperationId: parent.operationId, producerId: "office-local-binary" });
  return { journal, parent, producer };
}

for (const kind of ["Promise", "thenable"]) {
  test(`Office internal pre-effect seam refuses plain callback returning ${kind} before syscall`, async t => {
    const f = await fixture(t), { journal, parent, producer } = seam(f); let writes = 0;
    const pending = Promise.reject(new Error("internal async preparation"));
    void pending.catch(() => {}); // Observe original RED too; this is not a crash disguised as the assertion result.
    const before = () => kind === "Promise" ? pending : { then: (resolve, reject) => reject(new Error("internal thenable")) };
    assert.throws(() => journal.officeLocal.effect(parent, producer, before, () => { writes++; writeFileSync(f.tempPath, f.bytes); }, "forward"),
      code("host_operation_effect_must_be_synchronous"));
    assert.equal(writes, 0); assert.equal(existsSync(f.tempPath), false);
    assert.equal(journal.getHostOperation(parent.operationId).phase, "admitted");
    await new Promise(resolve => setImmediate(resolve));
  });
}

test("Office internal pre-effect writes cannot close original admission and still perform the syscall", async t => {
  const f = await fixture(t), { journal, parent, producer } = seam(f); let writes = 0;
  assert.throws(() => journal.officeLocal.effect(parent, producer, () => {
    f.store.database.prepare("UPDATE work_unit_attempts SET abort_requested_at=? WHERE id=?").run(now(), f.source.attemptId);
  }, () => { writes++; writeFileSync(f.tempPath, f.bytes); }, "forward"), code("host_operation_stale_owner"));
  assert.equal(writes, 0); assert.equal(existsSync(f.tempPath), false);
  assert.equal(f.other.database.prepare("SELECT abort_requested_at FROM work_unit_attempts WHERE id=?").get(f.source.attemptId).abort_requested_at, null);
});
