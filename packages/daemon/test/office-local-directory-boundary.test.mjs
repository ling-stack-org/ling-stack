import assert from "node:assert/strict";
import fs from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { executeOfficeLocalWrite, OfficeLocalWriterError } from "../dist/features/office-documents/office-local-writer.js";
import { officeFileIdentity } from "../dist/features/office-documents/office-local-identity.js";
import { OfficeLocalResourceOwner } from "../dist/features/office-documents/office-local-resources.js";
import { createOfficeSettlementFixture, patchOfficeSettlementFs, readOfficePairRows }
  from "./support/office-local-settlement-fixture.mjs";

const mutationFlags = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT
  | fs.constants.O_TRUNC | fs.constants.O_APPEND;
const mutating = flags => typeof flags === "number" ? (flags & mutationFlags) !== 0
  : typeof flags === "string" && /[wa+]/u.test(flags);
const nodeIdentity = stat => ({ device: String(stat.dev), inode: String(stat.ino) });
const errorSummary = error => error ? { name: error.name, message: error.message, code: error.code ?? null } : null;

/** Real migrated SQLite and fixed writer; substitution occurs after actual mkdir return, never through fake stat data. */
test("Office absent directory cannot adopt a foreign inode after mkdir or mutate inside it without creator proof", async t => {
  const f = await createOfficeSettlementFixture(t, { path: "created/result.docx" });
  const directory = f.prepared.members.find(member => member.role === "directory");
  assert.equal(directory.initial.state, "absent"); assert.equal(f.prepared.input.state, "absent");
  const nativeMkdir = fs.mkdirSync, nativeRename = fs.renameSync, nativeLstat = fs.lstatSync;
  const nativeRead = fs.readFileSync, nativeWriteFile = fs.writeFileSync;
  const nativeFstat = fs.fstatSync, nativeClose = fs.closeSync;
  const foreignStage = join(f.cwd, ".foreign-directory-actor"), displacedCreated = join(f.cwd, ".original-created-directory");
  const markerName = "foreign-owner.marker", markerText = "external owner remains external";
  nativeMkdir(foreignStage, { mode: 0o700 });
  nativeWriteFile(join(foreignStage, markerName), markerText);
  const foreignIdentity = nodeIdentity(nativeLstat(foreignStage, { bigint: true }));
  const productCalls = [], writerFds = new Map(), liveFds = new Map(), restores = [], actorMoves = [];
  let injected = false, createdIdentity, firstWriterDirectoryStat, mkdirReturns = 0;
  const foreignParent = () => nodeIdentity(nativeLstat(directory.path, { bigint: true }));
  const productCall = (kind, facts) => productCalls.push({ kind, nativeReturned: true, parentIdentity: foreignParent(), ...facts });

  restores.push(patchOfficeSettlementFs(t, "mkdirSync", original => (...args) => {
    const returned = original(...args);
    if (args[0] === directory.path) {
      mkdirReturns++; assert.equal(injected, false);
      // Original mkdir returned; no writer lstat has observed this name yet.
      // Actor moves are real native calls, separate from product call counts.
      nativeRename(directory.path, displacedCreated);
      actorMoves.push({ from: directory.path, to: displacedCreated });
      nativeRename(foreignStage, directory.path);
      actorMoves.push({ from: foreignStage, to: directory.path });
      createdIdentity = nodeIdentity(nativeLstat(displacedCreated, { bigint: true }));
      assert.notDeepEqual(createdIdentity, foreignIdentity);
      injected = true;
    }
    return returned;
  }));
  restores.push(patchOfficeSettlementFs(t, "lstatSync", original => (...args) => {
    const stat = original(...args);
    if (injected && args[0] === directory.path && firstWriterDirectoryStat === undefined) {
      firstWriterDirectoryStat = nodeIdentity(stat);
    }
    return stat;
  }));
  restores.push(patchOfficeSettlementFs(t, "openSync", original => (...args) => {
    const isWriterMutation = injected && typeof args[0] === "string"
      && dirname(args[0]) === directory.path && mutating(args[1]);
    const fd = original(...args), identity = nodeIdentity(nativeFstat(fd, { bigint: true }));
    liveFds.set(fd, identity);
    if (isWriterMutation) {
      writerFds.set(fd, { path: args[0], identity });
      productCall("open", { path: args[0], flags: args[1], fd, fileIdentity: identity });
    }
    return fd;
  }));
  restores.push(patchOfficeSettlementFs(t, "writeSync", original => (...args) => {
    const written = original(...args), opened = writerFds.get(args[0]);
    if (opened) productCall("write", { fd: args[0], path: opened.path, bytesWritten: written,
      fileIdentity: nodeIdentity(nativeFstat(args[0], { bigint: true })) });
    return written;
  }));
  restores.push(patchOfficeSettlementFs(t, "closeSync", original => fd => {
    const returned = original(fd); liveFds.delete(fd); return returned;
  }));
  for (const name of ["linkSync", "renameSync", "unlinkSync", "rmdirSync"]) {
    restores.push(patchOfficeSettlementFs(t, name, original => (...args) => {
      const isProductParent = injected && args.some(arg => typeof arg === "string"
        && (arg === directory.path || dirname(arg) === directory.path));
      const sourceIdentity = isProductParent && name !== "rmdirSync"
        ? nodeIdentity(nativeLstat(args[0], { bigint: true })) : undefined;
      const returned = original(...args);
      if (isProductParent) productCall(name, { args, ...(sourceIdentity ? { sourceIdentity } : {}),
        ...(["linkSync", "renameSync"].includes(name)
          ? { targetIdentity: nodeIdentity(nativeLstat(args[1], { bigint: true })) } : {}) });
      return returned;
    }));
  }
  const launch = f.store.launchHostOfficeLocalEffect.bind(f.store);
  const settleHostCall = f.tracker.executorGroup.settleHostCall.bind(f.tracker.executorGroup);
  let callbacks = 0;
  const releases = [];
  f.store.launchHostOfficeLocalEffect = (ticket, effectId, callback) =>
    launch(ticket, effectId, () => { callbacks++; return callback(); });
  f.tracker.executorGroup.settleHostCall = (ticket, proof) => {
    releases.push({ operationId: ticket.id, proofKind: proof.kind }); return settleHostCall(ticket, proof);
  };
  let result, writerFailure, settlementFailure, settledPair;
  try {
    try { result = executeOfficeLocalWrite(f.plan); } catch (error) { writerFailure = error; }
    assert.equal(injected, true, "the fixed writer must reach genuine mkdir, not an early refusal or fixture failure");
    assert.equal(mkdirReturns, 1); assert.equal(actorMoves.length, 2);
    assert.deepEqual(firstWriterDirectoryStat, foreignIdentity);
    assert.deepEqual(foreignParent(), foreignIdentity);
    assert.equal(nativeRead(join(directory.path, markerName), "utf8"), markerText);
    let targetBytesMatch = false;
    try { targetBytesMatch = nativeRead(f.prepared.targetPath).equals(f.artifact.bytes); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    try { settledPair = f.tracker.settleOfficeLocalFromStore(f.state.ticket); }
    catch (error) { settlementFailure = error; }
    const foreignMutations = productCalls.filter(call => call.parentIdentity.device === foreignIdentity.device
      && call.parentIdentity.inode === foreignIdentity.inode);
    const pairRows = readOfficePairRows(f), terminal = f.store.getHostOfficeLocalTerminal(f.plan.executionId);
    t.diagnostic(JSON.stringify({ kind: "office_creator_directory_boundary_v1", pid: process.pid,
      executionId: f.plan.executionId, source: f.source, actorMoves, mkdirReturns, createdIdentity, foreignIdentity,
      firstWriterDirectoryStat, callbacks, productCalls, foreignMutationCount: foreignMutations.length,
      targetBytesMatch, writerOutcome: result?.observation.outcome ?? writerFailure?.observation?.outcome ?? null,
      writerFailure: errorSummary(writerFailure), terminalOutcome: terminal?.outcome ?? null,
      settlementFailure: errorSummary(settlementFailure), pairRows: pairRows.map(row => ({
        operationId: row.operation_id, phase: row.phase, settlementKind: row.settlement_kind })),
      blockerCount: f.store.listHostOperationBlockers(f.source).length, releases }));
    assert.ok(settlementFailure, "absent-directory graph without creator proof must not earn safe settlement");
    assert.equal(settledPair, undefined); assert.ok(pairRows.every(row => row.phase !== "safe"));
    assert.deepEqual(f.store.listHostOperationBlockers(f.source).map(row => row.operationId).sort(),
      [f.state.parent.operationId, f.state.producer.operationId].sort());
    assert.deepEqual(releases, []);
    assert.equal(foreignMutations.length, 0, "a post-mkdir foreign directory must not authorize later writer mutation");
    assert.equal(targetBytesMatch, false); assert.equal(result, undefined);
    assert.ok(writerFailure instanceof OfficeLocalWriterError); assert.equal(writerFailure.observation.outcome, "failed");
  } finally {
    f.store.launchHostOfficeLocalEffect = launch; f.tracker.executorGroup.settleHostCall = settleHostCall;
    for (const restore of restores.reverse()) restore();
    for (const [fd, identity] of liveFds) {
      let actual;
      try { actual = nodeIdentity(nativeFstat(fd, { bigint: true })); }
      catch (error) { if (error.code === "EBADF") { liveFds.delete(fd); continue; } throw error; }
      assert.deepEqual(actual, identity, "cleanup cannot close an FD number borrowed by another inode");
      nativeClose(fd); liveFds.delete(fd);
      assert.throws(() => nativeFstat(fd), error => error.code === "EBADF");
    }
    assert.equal(liveFds.size, 0);
    t.diagnostic(JSON.stringify({ kind: "office_creator_directory_boundary_cleanup_v1", liveNativeFdCount: 0, restoredBindings: true }));
  }
});

test("Office ledger cannot turn a caller supplied directory transition into ownership of an initially absent foreign node", async t => {
  const f = await createOfficeSettlementFixture(t, { path: "foreign/result.docx" }), before = readOfficePairRows(f);
  const directory = f.prepared.members.find(member => member.role === "directory");
  assert.equal(directory.initial.state, "absent");
  const expectedBefore = structuredClone(f.state.ledger.expected(directory.memberId));
  // A real unrelated actor creates the real inode. Identity comes from native
  // lstat, never a fake BigIntStats or a caller-invented device/inode string.
  fs.mkdirSync(directory.path, { mode: 0o700 });
  const marker = join(directory.path, "foreign-owner.marker");
  fs.writeFileSync(marker, "owned by another creator");
  const foreignIdentity = officeFileIdentity(fs.lstatSync(directory.path, { bigint: true }));
  const resources = new OfficeLocalResourceOwner(f.plan.executionId, f.source);
  let transitionFailure;
  try { f.state.ledger.refresh(directory.memberId, resources, { state: "directory", identity: foreignIdentity }); }
  catch (error) { transitionFailure = error; }
  t.diagnostic(JSON.stringify({ kind: "office_caller_directory_transition_boundary_v1", executionId: f.plan.executionId,
    memberId: directory.memberId, foreignIdentity, transitionFailure: errorSummary(transitionFailure),
    expectedBefore, expectedAfter: f.state.ledger.expected(directory.memberId), resourceCount: resources.snapshots().length,
    effectCount: f.store.listHostOfficeLocalEffects(f.plan.executionId).length }));
  assert.ok(transitionFailure, "a structural directory identity is not a native creator-bound ownership capability");
  assert.deepEqual(f.state.ledger.expected(directory.memberId), expectedBefore);
  assert.throws(() => f.state.ledger.assertCurrent(), "the foreign path must remain incompatible with the original absent ledger state");
  assert.equal(fs.readFileSync(marker, "utf8"), "owned by another creator");
  assert.deepEqual(resources.snapshots(), []); assert.deepEqual(f.store.listHostOfficeLocalEffects(f.plan.executionId), []);
  assert.equal(f.store.getHostOfficeLocalTerminal(f.plan.executionId), undefined);
  assert.equal(f.store.getHostOfficeLocalNoStartReceipt(f.plan.executionId), undefined);
  assert.deepEqual(readOfficePairRows(f), before);
  assert.deepEqual(f.store.listHostOperationBlockers(f.source).map(row => row.operationId).sort(),
    [f.state.parent.operationId, f.state.producer.operationId].sort());
});
