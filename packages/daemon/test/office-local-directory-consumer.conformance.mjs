/** Explicit addon conformance, not portable test:ci, HTTP/GUI or packaged acceptance. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { OfficeParser } from "officeparser";
import { HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL, digestHarnessToolValue } from "@ling-stack/core";
import { captureMcpResultAuthority } from "../dist/features/mcp/result-authority.js";
import { createOriginalOfficeDirectoryCompositionFixture } from "./support/office-original-directory-composition-fixture.mjs";
import { callback, count, latestV2, reservedConsumer, rows, snapshot } from "./support/office-local-directory-consumer-callback-fixture.mjs";
import { observeUnpreparedOfficeDirectoryStage } from "./support/office-local-unprepared-directory-cleanup-fixture.mjs";
import * as officeAuthority from "../dist/features/office-documents/office-local-authority.js";

// The explicit reviewed native artifact is required. No skip can stand in for a
// conformance result; unsupported platform/configuration is an explicit failure.
assert.equal(process.platform, "darwin", "consumer addon conformance requires macOS");
assert.equal(process.arch, "arm64", "consumer addon conformance requires arm64");

const edits = {
  xlsx: path => ({ name: "office_edit_workbook", input: { path, edits: [{ sheet: "Summary", cell: "B1", value: 43 }] } }),
  docx: path => ({ name: "office_edit_document", input: { path, replacements: [{ search: "Genuine", replace: "Updated" }] } }),
  pptx: path => ({ name: "office_edit_presentation", input: { path, replacements: [{ slide: 1, search: "Original", replace: "Updated" }] } }),
};

test("original composition and fixed production MCP callback complete a genuine V2 missing-directory create", async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t, { preparePlan: false });
  const publicSettlement = t.mock.method(f.tracker, "settleOfficeLocalDirectoryFromStoreV2", () => assert.fail("fixed original settlement only"));
  const v1Settlement = t.mock.method(f.tracker, "settleOfficeLocalFromStore", () => assert.fail("V2 consumer cannot fall back to V1"));
  const result = await callback(f).call(), execution = latestV2(f);
  assert.equal(result.details.path, join(f.cwd, f.request.path)); assert.equal(result.details.blockCount, 1);
  assert.equal(count(f, "host_office_local_executions"), 0); assert.equal(count(f, "host_office_local_directory_v2_executions"), 1);
  assert.equal(f.store.getHostOfficeLocalDirectoryTerminalV2(execution.executionId).outcome, "published_native_only");
  assert.ok(rows(f).every(row => row.phase === "safe")); assert.ok(snapshot(f).operations.every(row => row.state === "settled"));
  assert.doesNotThrow(f.unboundActorGate); assert.deepEqual([publicSettlement.mock.callCount(), v1Settlement.mock.callCount()], [0, 0]);
});

for (const format of ["xlsx", "docx", "pptx"]) {
  test(`default daemon Store and original MCP callback create missing-directory ${format} V2 then edit existing file through V1`, async t => {
    const f = await createOriginalOfficeDirectoryCompositionFixture(t, { format, daemonStartup: true, preparePlan: false });
    const input = { ...f.request, ...(format === "xlsx" ? { overwrite: false } : format === "docx" ? { overwrite: "true" } : {}) };
    const originalAuthority = captureMcpResultAuthority(f.store, f.server.id, f.rawName).authority;
    let projections = 0;
    const c = callback(f, { onResult() { projections++; } });
    const publicClose = t.mock.method(f.tracker, "closeOfficeLocalDirectoryWindowV2", () => assert.fail("consumer cannot use replaceable public close"));
    const publicV2Settlement = t.mock.method(f.tracker, "settleOfficeLocalDirectoryFromStoreV2", () => assert.fail("consumer cannot use replaceable public settlement"));
    const v1Settlement = t.mock.method(f.tracker, "settleOfficeLocalFromStore");
    const created = await c.call(f.rawName, input), execution = latestV2(f);
    assert.equal(created.details.path, join(f.cwd, input.path)); assert.equal(created.details.format, format);
    for (const field of ["nativeFacts", "coreSafe", "canonicalVisibility", "packaged", "executionId", "settlement", "recoveryPath"]) {
      assert.equal(Object.hasOwn(created.details, field), false, `consumer must not expose/promote ${field}`);
    }
    assert.equal(execution.protocol, HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL);
    assert.equal(execution.requestDigest, digestHarnessToolValue({ toolName: f.rawName, input }));
    assert.equal(execution.policyDigest, digestHarnessToolValue({ protocol: HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL,
      authority: originalAuthority, approval: c.definitions.find(tool => tool.rawName === f.rawName).defaultApproval }));
    assert.equal(count(f, "host_office_local_directory_v2_executions"), 1); assert.equal(count(f, "host_office_local_executions"), 0);
    assert.equal(f.store.getHostOfficeLocalDirectoryTerminalV2(execution.executionId).outcome, "published_native_only");
    assert.ok(rows(f).every(row => row.phase === "safe")); assert.ok(snapshot(f).operations.every(row => row.state === "settled"));
    assert.doesNotThrow(f.unboundActorGate); assert.equal(v1Settlement.mock.callCount(), 0);
    assert.deepEqual([publicClose.mock.callCount(), publicV2Settlement.mock.callCount()], [0, 0]);
    const originalBytes = readFileSync(created.details.path), edit = edits[format](input.path);
    const edited = await c.call(edit.name, edit.input);
    assert.deepEqual(readFileSync(edited.details.recoveryPath), originalBytes);
    const text = (await (await OfficeParser.parseOffice(readFileSync(edited.details.path), { fileType: format, extractAttachments: false, ocr: false })).to("text")).value;
    assert.match(text, format === "xlsx" ? /43/u : /Updated/u);
    assert.equal(count(f, "host_office_local_directory_v2_executions"), 1); assert.equal(count(f, "host_office_local_executions"), 1);
    assert.equal(v1Settlement.mock.callCount(), 1); assert.equal(rows(f).length, 4);
    assert.ok(snapshot(f).operations.every(row => row.state === "settled")); assert.equal(projections, 2);
  });
}

test("original MCP V2 selection and request digest retain pre-observer owned path and nested input", async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t, { daemonStartup: true, preparePlan: false });
  const input = structuredClone(f.request), owned = structuredClone(input);
  const c = callback(f, { onStart() {
    assert.equal(rows(f).length, 2); assert.equal(existsSync(join(f.cwd, "reports")), false);
    input.path = "observer.docx"; input.blocks[0].text = "Observer replaced input";
  } });
  const result = await c.call(f.rawName, input), execution = latestV2(f);
  assert.equal(result.details.path, join(f.cwd, owned.path)); assert.equal(existsSync(join(f.cwd, "observer.docx")), false);
  assert.equal(execution.requestDigest, digestHarnessToolValue({ toolName: f.rawName, input: owned }));
  const text = (await (await OfficeParser.parseOffice(readFileSync(result.details.path), { fileType: "docx", extractAttachments: false, ocr: false })).to("text")).value;
  assert.match(text, /Genuine original Host writer/u); assert.doesNotMatch(text, /Observer replaced input/u);
});

test("unprepared V2 consumer preclaim parent race closes the actual original stage FDs without safe/no-start or native fallback", async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t, { preparePlan: false });
  const observation = observeUnpreparedOfficeDirectoryStage(t, f, { changeParent: true });
  const nativeLaunch = t.mock.method(f.tracker, "launchOfficeLocalDirectoryEffectV2");
  const v1Prepare = t.mock.method(f.store, "prepareHostOfficeLocalExecution");
  const v1Settlement = t.mock.method(f.tracker, "settleOfficeLocalFromStore");
  let failure, projections = 0;
  await assert.rejects(callback(f, { onResult() { projections++; } }).call(), error => { failure = error; return true; });
  assert.equal(failure.cause?.message, "office_local_snapshot_changed"); assert.equal(failure.stage, "preparation");
  assert.equal(observation.changed, true); assert.equal(observation.concurrentParentCreates, 1);
  assert.ok(observation.stageToken && observation.stagePath); assert.ok(observation.held.length >= 4);
  assert.equal(count(f, "host_office_local_executions"), 0); assert.equal(count(f, "host_office_local_directory_v2_executions"), 0);
  assert.equal(count(f, "host_office_local_no_start_receipts"), 0);
  assert.equal(rows(f).length, 2); assert.ok(rows(f).every(row => row.phase === "unknown_outcome"));
  assert.ok(snapshot(f).operations.every(row => row.state === "blocked"));
  assert.deepEqual([nativeLaunch.mock.callCount(), v1Prepare.mock.callCount(), v1Settlement.mock.callCount(), projections], [0, 0, 0, 0]);
  assert.equal(existsSync(join(f.cwd, "reports/nested")), false); assert.equal(existsSync(join(f.cwd, f.request.path)), false);
  t.diagnostic(`original preclaim stage=${observation.stagePath} held=${observation.held.length} closes=${observation.held.map(row => row.closeAttempts).join(",")}`);
  for (const row of observation.held) {
    assert.equal(row.closeAttempts, 1, `original stage ancestor ${row.path} must be physically closed once`);
    assert.equal(row.closeReturned, true);
    assert.throws(() => observation.originalStat(row.fd), error => error.code === "EBADF");
  }
  assert.doesNotThrow(f.unboundActorGate, "unprepared FD cleanup must retire the original Registry member, not leak its budget");
});

function assertBlockedUnpreparedPair(f) {
  assert.equal(rows(f).length, 2); assert.ok(rows(f).every(row => row.phase === "unknown_outcome"));
  assert.ok(snapshot(f).operations.every(row => row.state === "blocked"));
  assert.equal(count(f, "host_office_local_no_start_receipts"), 0);
  assert.equal(count(f, "host_office_local_executions"), 0);
  assert.equal(existsSync(join(f.cwd, f.request.path)), false);
}
const containsMessage = (error, message) => error?.message === message || (error?.cause && containsMessage(error.cause, message))
  || (Array.isArray(error?.errors) && error.errors.some(cause => containsMessage(cause, message)));

test("unprepared V2 route latch forbids original getHostOperation no-start reentry after genuine cleanup returned", async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t, { preparePlan: false }), original = reservedConsumer(f);
  const observation = observeUnpreparedOfficeDirectoryStage(t, f, { changeParent: true });
  const read = f.store.getHostOperation.bind(f.store);
  let reentered = false, noStartReturned = false, reentryError, failure;
  t.mock.method(f.store, "getHostOperation", operationId => {
    if (!reentered && observation.held.length >= 4 && observation.held.every(row => row.closeReturned)) {
      reentered = true;
      try { officeAuthority.settleOfficeLocalReservationNoStart(original.reservation); noStartReturned = true; }
      catch (error) { reentryError = error; }
    }
    return read(operationId);
  });
  await assert.rejects(original.invoke(), error => { failure = error; return true; });
  assert.equal(failure.cause?.message, "office_local_snapshot_changed"); assert.equal(reentered, true);
  const actualRows = snapshot(f).operations.map(row => read(row.ticket.id));
  t.diagnostic(`post-cleanup original no-start reentry returned=${noStartReturned}; Core=${actualRows.map(row => `${row.phase}/${row.settlementKind}`).join(",")}; Group=${snapshot(f).operations.map(row => row.state).join(",")}; original stage=${observation.stagePath}`);
  assert.equal(noStartReturned, false, "a returned readonly cleanup must not authorize generic no-start of the selected original V2 pair");
  assert.equal(reentryError?.message, "office_local_protocol_mismatch");
  assertBlockedUnpreparedPair(f); assert.equal(count(f, "host_office_local_directory_v2_executions"), 0);
  assert.ok(observation.held.every(row => row.closeAttempts === 1 && row.closeReturned));
  for (const row of observation.held) assert.throws(() => observation.originalStat(row.fd), error => error.code === "EBADF");
  assert.doesNotThrow(f.unboundActorGate);
});

for (const loss of ["prepare return-loss", "actual COMMIT return-loss"]) {
  test(`unprepared V2 cleanup refuses ${loss} after the original preparation claim and retains real stage FDs`, async t => {
    const f = await createOriginalOfficeDirectoryCompositionFixture(t, { preparePlan: false }), original = reservedConsumer(f);
    const observation = observeUnpreparedOfficeDirectoryStage(t, f);
    const nativeLaunch = t.mock.method(f.tracker, "launchOfficeLocalDirectoryEffectV2");
    const preparation = f.store.prepareHostOfficeLocalDirectoryExecutionV2.bind(f.store), fault = new Error(loss);
    let injected = false, inPrepare = false, exactReturnedTicket;
    t.mock.method(f.store, "prepareHostOfficeLocalDirectoryExecutionV2", (...args) => {
      inPrepare = true;
      try {
        exactReturnedTicket = preparation(...args);
        if (loss === "prepare return-loss") { injected = true; throw fault; }
        return exactReturnedTicket;
      } finally { inPrepare = false; }
    });
    if (loss === "actual COMMIT return-loss") {
      const exec = f.store.database.exec.bind(f.store.database);
      t.mock.method(f.store.database, "exec", sql => {
        const result = exec(sql);
        // Readonly snapshots COMMIT too. Inject only after the actual original
        // preparation INSERT exists and its write COMMIT physically returned.
        if (inPrepare && !injected && String(sql).trim() === "COMMIT" && count(f, "host_office_local_directory_v2_executions") === 1) {
          injected = true; throw fault;
        }
        return result;
      });
    }
    let failure;
    await assert.rejects(original.invoke(), error => { failure = error; return true; });
    assert.equal(injected, true); assert.ok(containsMessage(failure.cause, loss));
    assert.equal(failure.settlementError?.message, "office_local_directory_preparation_cleanup_unavailable");
    assertBlockedUnpreparedPair(f); assert.equal(count(f, "host_office_local_directory_v2_executions"), 1);
    assert.equal(nativeLaunch.mock.callCount(), 0); assert.ok(observation.stageToken && observation.held.length >= 4);
    assert.throws(() => officeAuthority.closeOfficeLocalUnpreparedDirectoryBootstrap(original.reservation),
      /office_local_directory_preparation_cleanup_unavailable/u);
    for (const row of observation.held) {
      assert.equal(row.closeAttempts, 0); assert.equal(row.closeReturned, false);
      const live = observation.originalStat(row.fd); assert.equal(live.dev, row.device); assert.equal(live.ino, row.inode);
    }
    assert.throws(f.unboundActorGate, /protected_host_actor_unbound_with_active_stage/u);
    assert.equal(existsSync(join(f.cwd, "reports")), false);
    t.diagnostic(`claimed ${loss}: retain original stage=${observation.stagePath}, all ${observation.held.length} actual FDs live, native capture=0`);
    if (exactReturnedTicket) assert.ok(Object.isFrozen(exactReturnedTicket), "a lost original return does not expose a replacement cleanup ticket");
  });
}

for (const closeFailure of ["throws", "return-loss"]) {
  test(`unprepared V2 cleanup ${closeFailure} never repeats the original stage FD close`, async t => {
    const f = await createOriginalOfficeDirectoryCompositionFixture(t, { preparePlan: false }), original = reservedConsumer(f);
    const observation = observeUnpreparedOfficeDirectoryStage(t, f, { changeParent: true, closeFailure });
    const nativeLaunch = t.mock.method(f.tracker, "launchOfficeLocalDirectoryEffectV2");
    let failure;
    await assert.rejects(original.invoke(), error => { failure = error; return true; });
    assert.equal(failure.cause?.message, "office_local_snapshot_changed"); assert.equal(observation.closeFaultEntered, true);
    assert.ok(containsMessage(failure.settlementError, observation.fault.message));
    assertBlockedUnpreparedPair(f); assert.equal(count(f, "host_office_local_directory_v2_executions"), 0);
    assert.equal(nativeLaunch.mock.callCount(), 0); assert.ok(observation.held.length >= 4);
    const attempts = observation.held.map(row => row.closeAttempts);
    assert.ok(attempts.every(value => value === 1), "all originally acquired ancestor closes drain even after one close is unconfirmed");
    for (let retry = 0; retry < 2; retry++) {
      assert.throws(() => officeAuthority.closeOfficeLocalUnpreparedDirectoryBootstrap(original.reservation),
        /office_local_native_stage_close_unknown/u);
    }
    assert.deepEqual(observation.held.map(row => row.closeAttempts), attempts, "a missing return cannot retry an original integer FD");
    for (const row of observation.held) {
      if (row.path === observation.stagePath && closeFailure === "throws") {
        const live = observation.originalStat(row.fd); assert.equal(live.dev, row.device); assert.equal(live.ino, row.inode);
        assert.equal(row.closeReturned, false);
      } else {
        assert.equal(row.closeReturned, true); assert.throws(() => observation.originalStat(row.fd), error => error.code === "EBADF");
      }
    }
    t.diagnostic(`cleanup ${closeFailure}: original stage=${observation.stagePath}, close attempts=${attempts.join(",")}; original unknown resource never retried`);
  });
}

test("unprepared V2 cleanup rejects synchronous original reservation reentry before any repeated close", async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t, { preparePlan: false }), original = reservedConsumer(f);
  let reentryError, reentered = false;
  const observation = observeUnpreparedOfficeDirectoryStage(t, f, { changeParent: true, beforeClose() {
    if (reentered) return;
    reentered = true;
    try { officeAuthority.closeOfficeLocalUnpreparedDirectoryBootstrap(original.reservation); }
    catch (error) { reentryError = error; }
  } });
  await assert.rejects(original.invoke(), error => error.cause?.message === "office_local_snapshot_changed");
  assert.equal(reentered, true); assert.match(reentryError?.message, /office_local_native_stage_close_unknown/u);
  assertBlockedUnpreparedPair(f); assert.ok(observation.held.length >= 4);
  assert.ok(observation.held.every(row => row.closeAttempts === 1 && row.closeReturned));
  const attempts = observation.held.map(row => row.closeAttempts);
  assert.doesNotThrow(() => officeAuthority.closeOfficeLocalUnpreparedDirectoryBootstrap(original.reservation));
  assert.deepEqual(observation.held.map(row => row.closeAttempts), attempts);
  assert.doesNotThrow(f.unboundActorGate);
});

test("unprepared V2 cleanup refuses a claimed bootstrap with no original returned scope and never retries its failed close", async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t, { preparePlan: false }), original = reservedConsumer(f);
  const observation = observeUnpreparedOfficeDirectoryStage(t, f, { closeFailure: "throws" });
  const read = f.registry.readStageIdentityFacts.bind(f.registry), fault = new Error("original bootstrap identity return lost");
  let returned = false;
  t.mock.method(f.registry, "readStageIdentityFacts", token => {
    const facts = read(token); returned = true; throw fault;
  });
  let failure;
  await assert.rejects(original.invoke(), error => { failure = error; return true; });
  assert.equal(returned, true); assert.ok(containsMessage(failure.cause, fault.message));
  assert.equal(observation.closeFaultEntered, true);
  assert.equal(failure.settlementError?.message, "office_local_directory_bootstrap_unconfirmed");
  assertBlockedUnpreparedPair(f); assert.equal(count(f, "host_office_local_directory_v2_executions"), 0);
  const attempts = observation.held.map(row => row.closeAttempts); assert.ok(attempts.every(value => value === 1));
  assert.throws(() => officeAuthority.closeOfficeLocalUnpreparedDirectoryBootstrap(original.reservation),
    /office_local_directory_bootstrap_unconfirmed/u);
  assert.deepEqual(observation.held.map(row => row.closeAttempts), attempts);
  const retained = observation.held.find(row => row.path === observation.stagePath), live = observation.originalStat(retained.fd);
  assert.equal(live.dev, retained.device); assert.equal(live.ino, retained.inode); assert.equal(retained.closeReturned, false);
  t.diagnostic(`unreturned bootstrap: original retained stage=${observation.stagePath}; no caller scope or cleanup retry admitted`);
});
