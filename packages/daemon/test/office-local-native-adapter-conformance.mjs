/** Explicit reviewed local addon adapter only. NOT portable test:ci, kernel/fullscope, Core safe, six-route or packaged proof. */
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { verifyOfficeLocalDirectoryReplayV2 } from "@ling-stack/core";
import { verifyHostOfficeReceipt } from "../../core/dist/storage/sqlite/host-office-local-journal-evidence.js";
import { readHostOperation } from "../../core/dist/storage/sqlite/host-operation-journal-evidence.js";
import { executeOfficeLocalDirectoryWrite, OfficeLocalDirectoryWriterError } from "../dist/features/office-documents/office-local-native-adapter.js";
import { settleOfficeLocalReservationNoStart } from "../dist/features/office-documents/office-local-authority.js";
import { OfficeLocalDirectoryResourceFacts } from "../dist/features/office-documents/office-local-directory-resource-facts.js";
import { createNativeDirectoryAdapterFixture, observeNativeAdapterEntries, injectOneCommitFailure }
  from "./support/office-local-native-adapter-fixture.mjs";

function captureFailure(f) {
  let failure;
  assert.throws(() => { try { executeOfficeLocalDirectoryWrite(f.plan); } catch (error) { failure = error; throw error; } },
    error => error instanceof OfficeLocalDirectoryWriterError);
  return failure;
}
function assertOriginalPairBlocked(f) {
  const rows = f.pairRows(); assert.equal(rows.length, 2);
  assert.equal(rows[1].parentOperationId, rows[0].operationId);
  assert.equal(rows[1].producerId, "office-local-binary");
  assert.ok(rows.every(row => row.phase !== "safe"));
  assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
  assert.equal(f.tracker.executorGroup.getSnapshot().operations.length, 2);
}
function assertNoReentry(f, entries) {
  const before = f.effects(), count = entries.length;
  assert.throws(() => executeOfficeLocalDirectoryWrite(f.plan), /office_local_directory_write_already_entered/u);
  assert.throws(() => executeOfficeLocalDirectoryWrite({ ...f.plan }), /office_local_directory_plan_invalid/u);
  assert.throws(() => settleOfficeLocalReservationNoStart(f.reservation), /office_local_reservation_invalid/u);
  assert.deepEqual(f.effects(), before); assert.equal(entries.length, count);
  assertOriginalPairBlocked(f);
}

for (const format of ["docx", "xlsx", "pptx"]) test(`fixed adapter creates genuine missing nested ${format}, real bytes, returned closes and graph-only facts`, async t => {
  const f = await createNativeDirectoryAdapterFixture(t, { format }), entries = observeNativeAdapterEntries(t, f);
  assert.equal(existsSync(join(f.cwd, "nested")), false, "do not precreate the requested parent to dodge the positive case");
  const result = executeOfficeLocalDirectoryWrite(f.plan), terminal = f.terminal(), history = f.observations();
  assert.equal(result.kind, "office_local_directory_native_facts_v2"); assert.equal(result.outcome, "published_native_only");
  assert.equal(result.graph.kind, "graph_verified_only"); assert.equal(result.coreSafe, false);
  assert.equal(result.canonicalVisibility, "unverified"); assert.equal(result.packaged, false);
  assert.equal(result.hostStageClosure, "closed");
  assert.deepEqual(readFileSync(result.targetPath), f.artifact.bytes);
  assert.equal(terminal.outcome, "published_native_only");
  assert.ok(terminal.resources.every(resource => resource.state === "closed"));
  assert.equal(terminal.terminalArtifactId, result.terminalArtifactId); assert.equal(terminal.terminalDigest, result.terminalDigest);
  assert.equal(entries.filter(item => item.kind === "capture_parents").length, 1);
  assert.equal(entries.filter(item => item.kind === "install_tree").length, 1);
  assert.deepEqual(entries.filter(item => item.kind === "close_session").map(item => item.mode), ["forward"]);
  assert.ok(history.every(item => item.observation.native.state === "returned" && item.observation.host.state === "returned"));
  assertNoReentry(f, entries);
});

test("normal returned false keeps genuine mkdirat EEXIST/errno and partial facts before stopping forward", async t => {
  const f = await createNativeDirectoryAdapterFixture(t); let armed = true;
  const entries = observeNativeAdapterEntries(t, f, { before(effect) {
    if (effect.kind === "create_directory" && armed) {
      armed = false; mkdirSync(join(f.state.execution.stage.parentPath, f.state.execution.stage.topBasename), { mode: 0o700 });
    }
  } });
  const failure = captureFailure(f), item = f.observations().find(item => item.effect.kind === "create_directory");
  assert.equal(armed, false); assert.equal(item.observation.native.state, "returned");
  assert.equal(item.observation.native.result.success, false);
  const call = item.observation.native.result.calls.find(call => call.syscall === "mkdirat");
  assert.equal(call.nativeReturnState, "returned"); assert.equal(call.returned, -1); assert.equal(call.errno, 17);
  assert.equal(item.observation.host.state, "returned"); assert.equal(f.terminal().outcome, "failed");
  assert.equal(failure.evidenceAcknowledgment, "confirmed"); assert.equal(failure.hostStageClosure, "closed");
  assert.equal(entries.some(item => ["write_file", "install_tree"].includes(item.kind)), false);
  assert.deepEqual(entries.filter(item => item.kind === "close_session").map(item => item.mode), ["cleanup"]);
  assert.equal(existsSync(f.state.execution.targetPath), false); assertNoReentry(f, entries);
});

test("real install observation COMMIT then missing ACK preserves physical publication and seals unknown, not failed", async t => {
  const f = await createNativeDirectoryAdapterFixture(t), entries = observeNativeAdapterEntries(t, f),
    record = f.tracker.recordOfficeLocalDirectoryObservationV2.bind(f.tracker); let faults = 0;
  t.mock.method(f.tracker, "recordOfficeLocalDirectoryObservationV2", (ticket, effectId, artifactId) => {
    if (f.effects().find(item => item.effectId === effectId).kind === "install_tree") {
      faults++; return injectOneCommitFailure(f.store.database, () => record(ticket, effectId, artifactId));
    }
    return record(ticket, effectId, artifactId);
  });
  const failure = captureFailure(f), installed = f.observations().find(item => item.effect.kind === "install_tree");
  assert.equal(faults, 1); assert.deepEqual(readFileSync(f.state.execution.targetPath), f.artifact.bytes);
  assert.equal(installed.observation.native.state, "returned"); assert.equal(installed.observation.native.result.success, true);
  assert.equal(installed.observation.host.state, "returned", "the committed original observation is not rewritten after a lost ACK");
  assert.equal(failure.evidenceAcknowledgment, "unconfirmed"); assert.equal(failure.hostStageClosure, "closed");
  assert.equal(f.terminal().outcome, "unknown"); assert.equal(f.terminal().installationEntered, true);
  assert.equal(entries.filter(item => item.kind === "install_tree").length, 1);
  assert.throws(() => verifyOfficeLocalDirectoryReplayV2({ execution: f.store.getHostOfficeLocalDirectoryExecutionV2(f.plan.executionId),
    terminal: f.terminal(), effects: f.observations() }), error => error.code === "host_office_local_directory_v2_evidence_invalid");
  assertNoReentry(f, entries);
});

test("actual terminal COMMIT then lost ACK retains exact original claim and never issues another terminal or native graph", async t => {
  const f = await createNativeDirectoryAdapterFixture(t), entries = observeNativeAdapterEntries(t, f),
    seal = f.tracker.sealOfficeLocalDirectoryTerminalV2.bind(f.tracker); let faults = 0;
  t.mock.method(f.tracker, "sealOfficeLocalDirectoryTerminalV2", (ticket, claim) => {
    faults++; return injectOneCommitFailure(f.store.database, () => seal(ticket, claim));
  });
  const failure = captureFailure(f), terminal = f.terminal();
  assert.equal(faults, 1); assert.equal(failure.terminalSealConfirmed, false); assert.equal(failure.evidenceAcknowledgment, "unconfirmed");
  assert.equal(failure.terminalArtifactId, terminal.terminalArtifactId); assert.equal(failure.terminalDigest, terminal.terminalDigest);
  assert.equal(terminal.outcome, "published_native_only", "original physically complete terminal stays immutable despite caller ACK loss");
  assert.equal(failure.hostStageClosure, "closed"); assert.deepEqual(readFileSync(f.state.execution.targetPath), f.artifact.bytes);
  assert.equal(entries.filter(item => item.kind === "close_session").length, 1); assertNoReentry(f, entries);
});

test("original install launch COMMIT rollback cannot erase physical publication, fabricate throw or retry installation", async t => {
  const f = await createNativeDirectoryAdapterFixture(t), entries = observeNativeAdapterEntries(t, f),
    launch = f.tracker.launchOfficeLocalDirectoryEffectV2.bind(f.tracker); let faults = 0;
  t.mock.method(f.tracker, "launchOfficeLocalDirectoryEffectV2", (ticket, effectId, callback, mode) => {
    if (f.effects().find(item => item.effectId === effectId).kind !== "install_tree") return launch(ticket, effectId, callback, mode);
    let armed = false; faults++;
    return injectOneCommitFailure(f.store.database, () => launch(ticket, effectId, () => {
      const packet = callback(); armed = true; return packet;
    }, mode), { commitFirst: false, shouldFail: () => armed });
  });
  const failure = captureFailure(f), installed = f.observations().find(item => item.effect.kind === "install_tree");
  assert.equal(faults, 1); assert.deepEqual(readFileSync(f.state.execution.targetPath), f.artifact.bytes);
  assert.equal(installed.observation.native.state, "returned"); assert.equal(installed.observation.native.result.success, true);
  assert.equal(installed.observation.host.state, "unconfirmed"); assert.ok(installed.effect.enteredAt, "original local entry is recovered, not executed twice");
  assert.equal(failure.evidenceAcknowledgment, "unconfirmed"); assert.equal(f.terminal().outcome, "unknown");
  assert.equal(entries.filter(item => item.kind === "install_tree").length, 1);
  assert.deepEqual(entries.filter(item => item.kind === "close_session").map(item => item.mode), ["cleanup"]);
  assertNoReentry(f, entries);
});

test("cancel after real bounded write stops later forward effects and explicitly closes only the original session once", async t => {
  const f = await createNativeDirectoryAdapterFixture(t), entries = observeNativeAdapterEntries(t, f, { after(effect) {
    if (effect.kind === "write_file") f.controller.abort(new Error("fixture_cancel_after_original_write"));
  } });
  const failure = captureFailure(f);
  assert.equal(entries.filter(item => item.kind === "write_file").length, 1);
  assert.equal(entries.some(item => item.kind === "install_tree"), false);
  assert.deepEqual(entries.filter(item => item.kind === "close_session").map(item => item.mode), ["cleanup"]);
  assert.equal(failure.hostStageClosure, "closed"); assert.equal(f.terminal().outcome, "failed");
  assert.equal(existsSync(f.state.execution.targetPath), false);
  assert.ok(f.terminal().resources.filter(item => item.nativeLifetimeId).every(item => item.state === "closed"));
  assertNoReentry(f, entries);
});

test("projection binding rejection after an actual capture preserves returned-unprojectable, unknown original facts and no native retry", async t => {
  const f = await createNativeDirectoryAdapterFixture(t), entries = observeNativeAdapterEntries(t, f);
  // This injects Host binding-boundary failure, NOT malformed native raw output.
  // Existing office-local-native-facts.test.mjs separately rejects malformed raw packets.
  t.mock.method(OfficeLocalDirectoryResourceFacts.prototype, "accept", () => { throw new Error("fixture_binding_projection_rejected"); });
  const failure = captureFailure(f), capture = f.observations().find(item => item.effect.kind === "capture_parents");
  assert.equal(capture.observation.native.state, "returned_unprojectable"); assert.equal(capture.observation.host.state, "unconfirmed");
  assert.deepEqual(capture.observation.resourceBindings, []); assert.equal(Object.hasOwn(capture.observation.native, "result"), false);
  assert.equal(f.terminal().outcome, "unknown");
  assert.ok(f.terminal().resources.every(item => item.state !== "closed" && !Object.hasOwn(item, "nativeLifetimeId")));
  assert.equal(failure.hostStageClosure, "closed", "Host stage close does not turn unknown native facts into Core closure proof");
  assert.equal(entries.filter(item => item.kind === "capture_parents").length, 1);
  assert.deepEqual(entries.filter(item => item.kind === "close_session").map(item => item.mode), ["cleanup"]);
  assertNoReentry(f, entries);
});

test("Host callback return lost after genuine native close does not reenter close or claim native threw", async t => {
  const f = await createNativeDirectoryAdapterFixture(t), entries = observeNativeAdapterEntries(t, f, { after(effect) {
    if (effect.kind === "close_session") throw new Error("fixture_host_close_callback_return_lost");
  } });
  const failure = captureFailure(f), close = f.observations().find(item => item.effect.kind === "close_session");
  assert.equal(close.observation.native.state, "returned"); assert.equal(close.observation.native.result.success, true);
  assert.equal(close.observation.host.state, "unconfirmed"); assert.equal(f.terminal().outcome, "unknown");
  assert.equal(entries.filter(item => item.kind === "close_session").length, 1);
  assert.equal(failure.hostStageClosure, "closed"); assertNoReentry(f, entries);
});

for (const rejectCleanupProjection of [true, false]) test(`actual install return with rejected projection and cleanup ${rejectCleanupProjection ? "unprojectable" : "trusted"} cannot become no-start`, async t => {
  const f = await createNativeDirectoryAdapterFixture(t), entries = observeNativeAdapterEntries(t, f),
    originalAccept = OfficeLocalDirectoryResourceFacts.prototype.accept;
  let installRejected = 0, cleanupRejected = 0, physicalInstallReturn, physicalCloseReturn;
  // Host binding-boundary injection after genuine native returns. It does not
  // mutate raw packets or replace the frozen runtime, and is not a natural
  // native reply-loss fault or a controlled kernel/fullscope test.
  t.mock.method(OfficeLocalDirectoryResourceFacts.prototype, "accept", function (effectId, facts) {
    const install = facts.calls.find(call => call.syscall === "renameatx_np_RENAME_EXCL");
    if (install) {
      installRejected++;
      physicalInstallReturn = { success: facts.success, installationEntered: facts.snapshot.installationEntered,
        nativeReturnState: install.nativeReturnState, returned: install.returned, errno: install.errno };
      throw new Error("fixture_install_return_projection_rejected");
    }
    if (facts.operationId === "" && facts.snapshot.installationEntered && facts.calls.some(call => call.syscall === "close")) {
      physicalCloseReturn = { success: facts.success, installationEntered: facts.snapshot.installationEntered };
      if (rejectCleanupProjection) {
        cleanupRejected++; throw new Error("fixture_cleanup_return_projection_rejected");
      }
    }
    return Reflect.apply(originalAccept, this, [effectId, facts]);
  });
  const failure = captureFailure(f), terminal = f.terminal(), history = f.observations(),
    installed = history.find(item => item.effect.kind === "install_tree"),
    cleanup = history.find(item => item.effect.kind === "close_session");
  assert.equal(installRejected, 1); assert.equal(cleanupRejected, rejectCleanupProjection ? 1 : 0);
  assert.deepEqual(physicalInstallReturn, { success: true, installationEntered: true, nativeReturnState: "returned", returned: 0, errno: 0 });
  assert.deepEqual(physicalCloseReturn, { success: true, installationEntered: true });
  assert.deepEqual(readFileSync(f.state.execution.targetPath), f.artifact.bytes,
    "independent fixture read proves publication may exist; it is not Core canonical proof");
  assert.equal(installed.observation.native.state, "returned_unprojectable");
  assert.equal(installed.observation.host.state, "unconfirmed"); assert.ok(installed.effect.enteredAt);
  assert.deepEqual(installed.observation.resourceBindings, []);
  assert.equal(Object.hasOwn(installed.observation.native, "result"), false);
  assert.equal(cleanup.observation.native.state, rejectCleanupProjection ? "returned_unprojectable" : "returned");
  assert.equal(terminal.outcome, "unknown");
  assert.equal(terminal.installationEntered, !rejectCleanupProjection,
    "false under unknown is absence of a trustworthy snapshot, not a physical no-start claim; later trusted cleanup restores true only");
  assert.equal(failure.hostStageClosure, "closed", "real Host stage close never replaces missing Core native close evidence");
  if (rejectCleanupProjection) assert.ok(terminal.resources.some(resource => resource.state === "unknown"));
  const originalFile = terminal.resources.find(resource => resource.resourceSlotId === f.state.execution.members.at(-1).resourceSlotId);
  assert.equal(originalFile.state, "closed", "previously confirmed file closure must not regress after install or cleanup projection loss");
  assert.ok(originalFile.closeCallRef, "confirmed closure retains its original native close evidence");
  assert.equal(terminal.canonicalVisibility.state, "unverified");
  assert.equal(entries.filter(item => item.kind === "install_tree").length, 1);
  assert.deepEqual(entries.filter(item => item.kind === "close_session").map(item => item.mode), ["cleanup"]);
  assert.throws(() => verifyOfficeLocalDirectoryReplayV2({ execution: f.store.getHostOfficeLocalDirectoryExecutionV2(f.plan.executionId),
    terminal, effects: history }), error => error.code === "host_office_local_directory_v2_evidence_invalid");
  assert.throws(() => verifyHostOfficeReceipt(f.store.database, readHostOperation(f.store.database, f.state.execution.parentOperationId)),
    error => error.code === "host_office_local_directory_v2_safe_unavailable");
  assertNoReentry(f, entries);
});

test("normal returned false keeps genuine exclusive create_file EEXIST without adopting or writing the foreign node", async t => {
  const f = await createNativeDirectoryAdapterFixture(t), member = f.state.execution.members.at(-1),
    foreignBytes = Buffer.from("foreign fixture file remains outside original native ownership");
  let collisions = 0, originalForeignIdentity;
  const entries = observeNativeAdapterEntries(t, f, { before(effect) {
    if (effect.kind !== "create_file") return;
    assert.equal(effect.resourceSlotId, member.resourceSlotId); assert.equal(effect.basename, member.basename);
    assert.equal(existsSync(member.stagePath), false);
    // Real filesystem collision in this owned fixture, not a fabricated native
    // reply/resource. Existing fixture inventory bypass is NOT kernel/fullscope
    // or Full Access isolation proof. The original native call still runs.
    writeFileSync(member.stagePath, foreignBytes, { flag: "wx", mode: 0o600 });
    originalForeignIdentity = lstatSync(member.stagePath, { bigint: true }); collisions++;
  } });
  const failure = captureFailure(f), item = f.observations().find(item => item.effect.kind === "create_file"),
    result = item.observation.native.result, call = result.calls[0],
    binding = item.observation.resourceBindings.find(resource => resource.resourceSlotId === member.resourceSlotId),
    parent = item.observation.resourceBindings.find(resource => resource.resourceSlotId === member.parentResourceSlotId),
    resource = result.snapshot.resources.find(resource => resource.lifetimeId === binding.nativeLifetimeId),
    terminal = f.terminal(), terminalFile = terminal.resources.find(resource => resource.resourceSlotId === member.resourceSlotId);
  assert.equal(collisions, 1); assert.equal(item.observation.native.state, "returned");
  assert.equal(item.observation.host.state, "returned"); assert.equal(result.success, false);
  assert.equal(Object.hasOwn(result, "resourceFact"), false); assert.equal(result.calls.length, 1);
  assert.equal(call.syscall, "openat_create_exclusive"); assert.equal(call.nativeReturnState, "returned");
  assert.equal(call.returned, -1); assert.equal(call.errno, 17); assert.equal(call.success, false);
  assert.equal(call.resourceLifetimeId, binding.nativeLifetimeId); assert.equal(call.parentLifetimeId, parent.nativeLifetimeId);
  assert.equal(resource.kind, "created_file"); assert.equal(resource.basename, member.basename);
  assert.equal(resource.state, "not_acquired"); assert.equal(resource.identityObserved, false);
  assert.equal(resource.device, "0"); assert.equal(resource.inode, "0"); assert.equal(resource.bytesWritten, "0");
  assert.equal(resource.fsyncReturned, false); assert.equal(result.snapshot.residualCreation, true,
    "prior genuine directory creation must not be erased merely because file open failed");
  assert.equal(Object.hasOwn(binding, "acquisitionCallRef"), false); assert.equal(Object.hasOwn(binding, "firstFstatCallRef"), false);
  assert.deepEqual(readFileSync(member.stagePath), foreignBytes);
  const after = lstatSync(member.stagePath, { bigint: true });
  assert.equal(after.dev, originalForeignIdentity.dev); assert.equal(after.ino, originalForeignIdentity.ino);
  assert.equal(entries.filter(item => item.kind === "create_file").length, 1);
  assert.equal(entries.some(item => ["write_file", "install_tree"].includes(item.kind)), false);
  assert.deepEqual(entries.filter(item => item.kind === "close_session").map(item => item.mode), ["cleanup"]);
  assert.equal(terminal.outcome, "failed"); assert.equal(terminalFile.state, "not_acquired");
  assert.equal(Object.hasOwn(terminalFile, "nativeLifetimeId"), false, "foreign inode cannot become a native acquired lifetime");
  assert.equal(terminal.installationEntered, false); assert.equal(terminal.canonicalVisibility.state, "unverified");
  assert.equal(failure.evidenceAcknowledgment, "confirmed"); assert.equal(failure.hostStageClosure, "closed");
  assert.equal(existsSync(f.state.execution.targetPath), false);
  assert.throws(() => verifyHostOfficeReceipt(f.store.database, readHostOperation(f.store.database, f.state.execution.parentOperationId)),
    error => error.code === "host_office_local_directory_v2_safe_unavailable");
  assertNoReentry(f, entries);
});
