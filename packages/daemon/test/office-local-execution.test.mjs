import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Packer } from "docx";
import { OfficeParser } from "officeparser";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "@ling-stack/core";
import { AttemptHostOperationTracker } from "../dist/runtime/attempt-host-operation-tracker.js";
import { executeOfficeLocalArtifact, OfficeLocalExecutionError } from "../dist/features/office-documents/office-local-execution.js";
import { captureOfficeLocalReservationSnapshot, reserveOfficeLocalWriter, settleOfficeLocalReservationNoStart } from "../dist/features/office-documents/office-local-authority.js";

const now = () => new Date().toISOString();
const required = Object.freeze({ kind: "user_input_required", requestId: "office-coordinator-stop", requestVersion: 1 });
const inputs = {
  xlsx: { path: "result.xlsx", sheets: [{ name: "Summary", rows: [["Metric", "Value"], ["Users", 42]] }] },
  docx: { path: "result.docx", blocks: [{ type: "paragraph", text: "Original Office text" }] },
  pptx: { path: "result.pptx", slides: [{ title: "Original Office", bullets: ["Local bytes"] }] },
};
const creates = { xlsx: "office_create_workbook", docx: "office_create_document", pptx: "office_create_presentation" };
const edits = {
  xlsx: { toolName: "office_edit_workbook", input: { path: "result.xlsx", edits: [{ sheet: "Summary", cell: "B2", value: 43 }] } },
  docx: { toolName: "office_edit_document", input: { path: "result.docx", replacements: [{ search: "Original", replace: "Updated" }], appendParagraphs: ["Appended"] } },
  pptx: { toolName: "office_edit_presentation", input: { path: "result.pptx", replacements: [{ slide: 1, search: "Original", replace: "Updated" }] } },
};

async function fixture(t) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ling-office-coordinator-"))), store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "unit", status: "running", createdByActor: "system", request: {}, now: now() });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "office-coordinator-original",
    runnerId: "pi", status: "started", now: now() });
  const thread = store.createLingThread({ kind: "conversation", title: "Office coordinator", objective: "Original local execution" }, now());
  const turn = store.appendConversationUserTurn({ threadId: thread.id, title: "Write", userInstruction: "Write", idempotencyKey: "turn",
    payload: { body: "Write", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, now());
  store.createRun({ id: "run", cwd, workUnitId: unit.id, threadId: thread.id, turnId: turn.turnId, taskId: "task", providerName: "test",
    providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now() });
  store.linkRunToWorkUnit("run", unit.id, now()); store.markRunStarted("run", now());
  const source = { runId: "run", ...toRuntimeAttemptFence(attempt) }, tracker = new AttemptHostOperationTracker({ store, source });
  let sequence = 0;
  const invoke = (toolName = creates.docx, input = inputs.docx, overrides = {}) => executeOfficeLocalArtifact({
    tracker, store, toolCallId: `office-call-${++sequence}`, workspaceCwd: cwd, toolName, input,
    requestDigest: "a".repeat(64), policyDigest: "b".repeat(64), ...overrides,
  });
  const rows = () => store.database.prepare("SELECT * FROM host_operations ORDER BY rowid").all();
  const replaceOwner = () => store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 2,
    runtimeInstanceId: "office-coordinator-successor", runnerId: "pi", status: "started", now: now() });
  return { cwd, store, source, tracker, invoke, rows, replaceOwner };
}

function patchFs(t, name, replacement) {
  const original = fs[name]; fs[name] = replacement(original); syncBuiltinESMExports();
  let restored = false;
  const restore = () => { if (!restored) { restored = true; fs[name] = original; syncBuiltinESMExports(); } };
  t.after(restore); return restore;
}
function assertNoStart(f) {
  assert.equal(f.rows().length, 2);
  assert.ok(f.rows().every(row => row.phase === "safe" && row.settlement_kind === "known_no_start"));
  assert.ok(f.tracker.executorGroup.getSnapshot().operations.every(row => row.state === "settled"));
  assert.equal(f.store.database.prepare("SELECT count(*) n FROM host_office_local_executions").get().n, 0);
}
function assertBlocked(f) {
  assert.ok(f.rows().every(row => row.phase !== "safe"));
  assert.ok(f.tracker.executorGroup.getSnapshot().operations.every(row => row.state !== "settled"));
}
const causeCode = code => error => error instanceof OfficeLocalExecutionError && error.cause?.code === code;
function hasErrorMessage(error, message) {
  return error?.message === message || (error?.cause && hasErrorMessage(error.cause, message))
    || (Array.isArray(error?.errors) && error.errors.some(cause => hasErrorMessage(cause, message)));
}

for (const format of Object.keys(creates)) {
  test(`Office coordinator creates and edits real ${format} SDK bytes through original atomic settlement`, async t => {
    const f = await fixture(t);
    const created = await f.invoke(creates[format], inputs[format]);
    assert.equal(created.path, join(f.cwd, inputs[format].path)); assert.equal(created.format, format);
    assert.equal(created.recoveryPath, undefined);
    assert.equal(created.settlement.parent.settlementKind, "office_local_chain_completed");
    assert.equal(created.settlement.producer.settlementKind, "office_local_binary_completed");
    assert.equal(created.settlement.parent.settledAt, created.settlement.producer.settledAt);
    const before = readFileSync(created.path), edited = await f.invoke(edits[format].toolName, edits[format].input);
    assert.deepEqual(readFileSync(edited.recoveryPath), before);
    const text = (await OfficeParser.parseOffice(readFileSync(edited.path), { fileType: format, extractAttachments: false, ocr: false })).toText();
    assert.match(text, new RegExp(format === "xlsx" ? "43" : "Updated"));
    assert.equal(edited.settlement.parent.evidenceRef.id, edited.executionId);
    assert.equal(edited.settlement.producer.evidenceRef.id, edited.executionId);
    assert.ok(f.rows().every(row => row.phase === "safe"));
    assert.ok(f.tracker.executorGroup.getSnapshot().operations.every(row => row.state === "settled"));
    assert.deepEqual(format === "xlsx" ? [created.sheetCount, edited.editCount]
      : format === "docx" ? [created.blockCount, edited.replacementCount, edited.appendedParagraphCount]
      : [created.slideCount, edited.replacementCount, ...edited.changedSlides], format === "docx" ? [1, 1, 1] : format === "pptx" ? [1, 1, 1] : [1, 1]);
  });
}

test("Office coordinator owns nested input and reserves both roles before the serializer's first await", async t => {
  const f = await fixture(t), input = structuredClone(inputs.docx), original = Packer.toBuffer;
  let release; const ready = new Promise(resolve => { release = resolve; });
  t.mock.method(Packer, "toBuffer", async (...args) => { assert.equal(f.rows().length, 2); await ready; return original(...args); });
  const pending = f.invoke(creates.docx, input);
  assert.equal(f.rows().length, 2); input.path = "different.docx"; input.blocks[0].text = "External mutation"; release();
  const result = await pending;
  assert.equal(result.path, join(f.cwd, "result.docx")); assert.equal(existsSync(join(f.cwd, "different.docx")), false);
  const text = (await OfficeParser.parseOffice(readFileSync(result.path), { fileType: "docx", extractAttachments: false, ocr: false })).toText();
  assert.match(text, /Original Office text/u); assert.doesNotMatch(text, /External mutation/u);
});

test("Office coordinator already-cancelled request reserves then safely settles only its genuine unprepared no-start", async t => {
  const f = await fixture(t), controller = new AbortController(), reason = new Error("cancelled before capture"); controller.abort(reason);
  await assert.rejects(f.invoke(creates.docx, inputs.docx, { signal: controller.signal }), error => error.cause === reason);
  assertNoStart(f); assert.equal(existsSync(join(f.cwd, "result.docx")), false);
});

for (const variant of ["serializer-error", "cancel", "required-input", "source-replacement"]) {
  test(`Office coordinator ${variant} during real serializer await never accepts a late payload`, async t => {
    const f = await fixture(t), controller = new AbortController(), original = Packer.toBuffer;
    const sdkFailure = new Error("real serializer rejected");
    t.mock.method(Packer, "toBuffer", async (...args) => {
      await Promise.resolve();
      if (variant === "serializer-error") throw sdkFailure;
      if (variant === "cancel") controller.abort(new Error("cancel during serialization"));
      if (variant === "required-input") f.tracker.executorGroup.closeAdmission(required);
      if (variant === "source-replacement") f.replaceOwner();
      return original(...args);
    });
    await assert.rejects(f.invoke(creates.docx, inputs.docx, { signal: controller.signal }), error => {
      assert.ok(error instanceof OfficeLocalExecutionError);
      if (variant === "serializer-error") assert.equal(error.cause, sdkFailure);
      if (variant === "required-input") assert.equal(error.cause.code, "attempt_execution_admission_closed");
      if (variant === "source-replacement") assert.equal(error.cause.code, "attempt_execution_stale_owner");
      return true;
    });
    assert.equal(existsSync(join(f.cwd, "result.docx")), false);
    if (variant === "source-replacement") assertBlocked(f); else assertNoStart(f);
  });
}

test("Office reservation read latches before original native read callback can try premature no-start", async t => {
  const f = await fixture(t); writeFileSync(join(f.cwd, "result.docx"), Buffer.from("snapshot bytes"));
  const reservation = reserveOfficeLocalWriter(f.tracker, f.store, "explicit-reader", f.cwd);
  let rejected = 0;
  patchFs(t, "readSync", original => (...args) => {
    assert.throws(() => settleOfficeLocalReservationNoStart(reservation), /office_local_snapshot_unconfirmed/u);
    assert.equal(f.rows().length, 2); assert.ok(f.rows().every(row => row.phase === "admitted"));
    assert.equal(f.tracker.executorGroup.getSnapshot().operations.filter(row => row.state === "settled").length, 0);
    rejected++; return original(...args);
  });
  assert.throws(() => captureOfficeLocalReservationSnapshot(reservation, "result.docx", "docx"), /office_local_reservation_closed/u);
  assert.equal(rejected, 1, "a rejected early settlement still irreversibly closes preparation");
  const pair = settleOfficeLocalReservationNoStart(reservation);
  assert.equal(pair.parent.settlementKind, "known_no_start"); assertNoStart(f);
  assert.throws(() => captureOfficeLocalReservationSnapshot(reservation, "result.docx", "docx"), /closed/u);
});

test("Office coordinator failed original readonly close preserves the real retained FD and both blockers", async t => {
  const f = await fixture(t); writeFileSync(join(f.cwd, "result.docx"), Buffer.from("snapshot bytes"));
  let retained; const actualClose = fs.closeSync;
  const restoreOpen = patchFs(t, "openSync", original => (...args) => {
    const fd = original(...args); if (args[0] === join(f.cwd, "result.docx")) retained = fd; return fd;
  });
  const restoreClose = patchFs(t, "closeSync", original => fd => {
    if (fd === retained) throw Object.assign(new Error("original readonly close uncertain"), { code: "EIO" });
    return original(fd);
  });
  await assert.rejects(f.invoke(edits.docx.toolName, edits.docx.input), causeCode("EIO"));
  assert.equal(fs.fstatSync(retained).isFile(), true); assertBlocked(f);
  assert.equal(f.store.database.prepare("SELECT count(*) n FROM host_office_local_no_start_receipts").get().n, 0);
  restoreOpen(); restoreClose(); actualClose(retained);
  assertBlocked(f); // Later external cleanup cannot retroactively mint the original proof.
});

test("Office coordinator successful original readonly close permits malformed source serializer no-start", async t => {
  const f = await fixture(t); writeFileSync(join(f.cwd, "result.docx"), Buffer.from("not an Office package"));
  await assert.rejects(f.invoke(edits.docx.toolName, edits.docx.input), error => error.cause?.message === "office_document_package_invalid");
  assertNoStart(f); assert.deepEqual(readFileSync(join(f.cwd, "result.docx")), Buffer.from("not an Office package"));
});

test("Office coordinator prepared cancellation settles with its original ticket, without entering the writer", async t => {
  const f = await fixture(t), controller = new AbortController(), original = f.store.prepareHostOfficeLocalExecution.bind(f.store);
  t.mock.method(f.store, "prepareHostOfficeLocalExecution", (...args) => {
    const ticket = original(...args); controller.abort(new Error("cancel after original prepare")); return ticket;
  });
  await assert.rejects(f.invoke(creates.docx, inputs.docx, { signal: controller.signal }), error => error.cause?.message === "cancel after original prepare");
  const execution = f.store.database.prepare("SELECT execution_id FROM host_office_local_executions").get();
  assert.ok(f.store.getHostOfficeLocalNoStartReceipt(execution.execution_id));
  assert.deepEqual(f.store.listHostOfficeLocalEffects(execution.execution_id), []);
  assert.ok(f.rows().every(row => row.phase === "safe" && row.settlement_kind === "known_no_start"));
  assert.equal(existsSync(join(f.cwd, "result.docx")), false);
});

test("Office coordinator unknown preparation acknowledgement cannot generic-no-start its bound original pair", async t => {
  const f = await fixture(t), original = f.store.prepareHostOfficeLocalExecution.bind(f.store);
  t.mock.method(f.store, "prepareHostOfficeLocalExecution", (...args) => {
    original(...args); throw new Error("original preparation acknowledgement lost");
  });
  await assert.rejects(f.invoke(), error => error.cause?.message === "original preparation acknowledgement lost");
  assertBlocked(f); assert.equal(existsSync(join(f.cwd, "result.docx")), false);
  assert.equal(f.store.database.prepare("SELECT count(*) n FROM host_office_local_no_start_receipts").get().n, 0);
});

test("Office coordinator actual native write failure seals residue without fabricating local success or no-start", async t => {
  const f = await fixture(t);
  patchFs(t, "writeSync", () => () => { throw Object.assign(new Error("actual native write failed"), { code: "EIO" }); });
  await assert.rejects(f.invoke(), error => error instanceof OfficeLocalExecutionError && error.cause?.name === "OfficeLocalWriterError");
  assertBlocked(f); assert.equal(existsSync(join(f.cwd, "result.docx")), false);
  assert.equal(f.store.database.prepare("SELECT count(*) n FROM host_office_local_no_start_receipts").get().n, 0);
});

test("Office coordinator missing-directory create refuses non-original composition without precreating destination residue", async t => {
  const f = await fixture(t);
  await assert.rejects(f.invoke(creates.docx, { ...inputs.docx, path: "new/nested/result.docx" }), error => {
    assert.ok(error instanceof OfficeLocalExecutionError); assert.equal(error.stage, "preparation");
    assert.equal(hasErrorMessage(error.cause, "office_local_directory_core_composition_invalid"), true);
    return true;
  });
  assert.equal(existsSync(join(f.cwd, "new")), false, "a missing-directory V2 refusal cannot run legacy mkdir");
  assert.equal(existsSync(join(f.cwd, "new/nested/result.docx")), false);
  assertBlocked(f);
  assert.equal(f.store.database.prepare("SELECT count(*) n FROM host_office_local_executions").get().n, 0);
  assert.equal(f.store.database.prepare("SELECT count(*) n FROM host_office_local_directory_v2_executions").get().n, 0);
});

test("Office coordinator existing nested directories retain supported original settlement", async t => {
  const f = await fixture(t); fs.mkdirSync(join(f.cwd, "existing/nested"), { recursive: true });
  const result = await f.invoke(creates.docx, { ...inputs.docx, path: "existing/nested/result.docx" });
  assert.equal(result.settlement.parent.phase, "safe"); assert.ok(f.rows().every(row => row.phase === "safe"));
});
