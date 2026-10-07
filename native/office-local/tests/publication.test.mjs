import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, succeeded, docxBytes } from "./test-helpers.mjs";

const addon = createRequire(import.meta.url)(process.env.OFFICE_LOCAL_ADDON);

function publish(addon, held, { bytes = docxBytes(), empty = false, originalRead = false } = {}) {
  const top = succeeded(addon.createDirectory(held.session, held.stageParent, "native-tree", "mkdir-top"));
  const nested = succeeded(addon.createDirectory(held.session, top.capability, "nested", "mkdir-nested"));
  const file = succeeded(addon.createFile(held.session, nested.capability, "report.docx", "create-file"));
  succeeded(addon.writeFile(held.session, file.capability, bytes, "write-file"));
  succeeded(addon.fsyncResource(held.session, file.capability, "sync-file"));
  if (originalRead) assert.deepEqual(succeeded(addon.readFile(held.session, file.capability, bytes.length, bytes.length + 1, "original-read")).bytes, bytes);
  succeeded(addon.closeResource(held.session, file.capability, "close-file"));
  let emptyFile;
  if (empty) {
    emptyFile = succeeded(addon.createFile(held.session, top.capability, "empty", "create-empty"));
    succeeded(addon.fsyncResource(held.session, emptyFile.capability, "sync-empty"));
    succeeded(addon.closeResource(held.session, emptyFile.capability, "close-empty"));
  }
  succeeded(addon.fsyncResource(held.session, nested.capability, "sync-nested"));
  succeeded(addon.fsyncResource(held.session, top.capability, "sync-top"));
  const installed = succeeded(addon.installTree(held.session, top.capability, "canonical-tree", "install"));
  return { top, nested, file, emptyFile, bytes, installed, budget: bytes.length + 1 + Number(empty) };
}

function noPayload(result, blocker) {
  assert.equal(result.success, false);
  assert.equal(result.publication.success, false);
  assert.equal(result.publication.nativeOutcome, "returned_failed");
  assert.equal(result.publication.blockerCode, blocker);
  assert.equal(result.blockerCode, blocker);
  assert.equal(result.publicationFiles, undefined);
  assert.equal(result.snapshot.scopeBinding, "unbound");
  assert.equal(result.snapshot.protectedStageVerified, false);
  assert.equal(result.snapshot.coreSafe, false);
  assert.equal(result.snapshot.packaged, false);
}

test("post-install genuine DOCX and empty file use original canonical roster; actual EOF and all readonly close", t => {
  const fx = fixture(t, addon), held = fx.open();
  const tree = publish(addon, held, { empty: true, originalRead: true });
  const observed = succeeded(addon.observePublication(held.session, tree.top.capability, tree.budget, "observe-publication"));
  assert.equal(observed.publication.observationBasis, "original_destination_parent_relative");
  assert.equal(observed.publication.nativeOutcome, "returned_success");
  assert.equal(observed.snapshot.installation.destinationName, "canonical-tree");
  assert.equal(observed.snapshot.installation.returned, 0);
  assert.equal(observed.snapshot.installation.nativeReturnState, "returned");
  assert.equal(observed.snapshot.installation.entries.length, 4);
  assert.equal(observed.publicationFiles.length, 2);
  assert.deepEqual(observed.publicationFiles[0].bytes, tree.bytes);
  assert.deepEqual(observed.publicationFiles[1].bytes, Buffer.alloc(0));
  assert.equal(observed.publicationFiles[0].originalLifetimeId, tree.file.resourceFact.lifetimeId);
  for (const entry of observed.publication.entries) {
    const fact = observed.snapshot.resources.find(resource => resource.lifetimeId === entry.observedLifetimeId);
    assert.match(fact.kind, /^publication_(directory|file)$/);
    assert.equal(fact.state, "closed");
    assert.equal(fact.bytesWritten, "0");
    assert.equal(fact.fsyncReturned, false);
    assert.equal(entry.capability, undefined);
    assert.ok(observed.calls.some(call => call.syscall === "close" && call.resourceLifetimeId === fact.lifetimeId && call.returned === 0));
    assert.ok(observed.calls.some(call => call.syscall === "fstatat_no_follow" && call.resourceLifetimeId === fact.lifetimeId && call.identity));
    if (entry.readback) {
      assert.equal(entry.readback.eofObserved, true);
      assert.equal(entry.readback.identitiesMatch, true);
      assert.equal(entry.readback.success, true);
      assert.ok(entry.readback.calls.some(call => call.syscall === "pread_eof_probe" && call.returned === 0 && call.requestedBytes === "1"));
    }
  }
  const openCalls = observed.calls.filter(call => call.syscall === "openat");
  assert.equal(openCalls[0].entryName, "canonical-tree");
  assert.equal(openCalls[0].parentLifetimeId, tree.installed.snapshot.installation.destinationParentLifetimeId);
  for (const call of observed.calls) {
    assert.equal(call.nativeReturnState, "returned");
    assert.ok(BigInt(call.calledAtMonotonicNs) > 0n);
    assert.ok(BigInt(call.returnedAtMonotonicNs) >= BigInt(call.calledAtMonotonicNs));
  }
  assert.ok(observed.calls.length <= Number(observed.publication.maximumCalls));
  const snapshot = addon.inspectSession(held.session);
  assert.equal(snapshot.publicationFiles, undefined);
  assert.equal(JSON.stringify(snapshot).includes('"type":"Buffer"'), false);
  assert.throws(() => addon.observePublication(held.session, tree.top.capability, tree.budget, "different-operation"), /publication_observation_already_claimed/);
  assert.equal(addon.inspectSession(held.session).publication.calls.length, observed.calls.length);
});

test("observer never accepts a substituted path, cloned capability, or foreign session", t => {
  const fx = fixture(t, addon), held = fx.open(), other = fx.open();
  const tree = publish(addon, held);
  for (const values of [
    [held.session, tree.top.capability, tree.budget, "extra", "replacement"],
    [held.session, { ...tree.top.capability }, tree.budget, "clone"],
    [other.session, tree.top.capability, tree.budget, "foreign"],
    [held.session, join(fx.workspace, "canonical-tree"), tree.budget, "path"],
  ]) assert.throws(() => addon.observePublication(...values), /invalid_argument_count|invalid_capability|foreign_session_capability/);
  assert.equal(addon.inspectSession(held.session).publicationObservationClaimed, false);
});

test("budget is exact and invalid inputs reject before any observer syscall", t => {
  const fx = fixture(t, addon), held = fx.open(), tree = publish(addon, held);
  for (const [index, budget] of [0, tree.budget - 1, tree.budget + 1, NaN, Infinity, -1, 1.5, true, 50 * 1024 * 1024 + 129].entries()) {
    assert.throws(() => addon.observePublication(held.session, tree.top.capability, budget, `budget-${index}`), /invalid_(read|publication)_budget/);
    const snapshot = addon.inspectSession(held.session);
    assert.equal(snapshot.publication, undefined);
    assert.equal(snapshot.publicationObservationClaimed, false);
    assert.equal(snapshot.resources.some(resource => resource.kind.startsWith("publication_")), false);
  }
  succeeded(addon.observePublication(held.session, tree.top.capability, tree.budget, "correct-budget"));
});

test("total original-written payload over 50 MiB rejects before entry", t => {
  const fx = fixture(t, addon), held = fx.open();
  const tree = publish(addon, held, { bytes: Buffer.alloc(50 * 1024 * 1024 + 1, 0x41) });
  assert.throws(() => addon.observePublication(held.session, tree.top.capability, tree.budget, "oversize"), /publication_payload_too_large/);
  assert.equal(addon.inspectSession(held.session).publication, undefined);
});

test("installation roster over 128 entries rejects before entry", t => {
  const fx = fixture(t, addon), held = fx.open();
  const top = succeeded(addon.createDirectory(held.session, held.stageParent, "roster-tree", "top"));
  for (let index = 0; index < 128; index++) {
    const child = succeeded(addon.createDirectory(held.session, top.capability, `d-${index}`, `mkdir-${index}`));
    succeeded(addon.fsyncResource(held.session, child.capability, `sync-${index}`));
  }
  succeeded(addon.fsyncResource(held.session, top.capability, "sync-top"));
  succeeded(addon.installTree(held.session, top.capability, "canonical-tree", "install"));
  assert.throws(() => addon.observePublication(held.session, top.capability, 0, "too-many"), /invalid_publication_roster/);
  assert.equal(addon.inspectSession(held.session).publicationObservationClaimed, false);
});

for (const phase of ["building", "cancelled", "closed"]) test(`observer rejects ${phase} before syscall`, t => {
  const fx = fixture(t, addon), held = fx.open();
  const top = succeeded(addon.createDirectory(held.session, held.stageParent, "native-tree", "mkdir"));
  if (phase === "cancelled") addon.cancelSession(held.session);
  if (phase === "closed") succeeded(addon.closeSession(held.session));
  assert.throws(() => addon.observePublication(held.session, top.capability, 0, "observe"), /session_(not_published|cancel_requested)/);
  assert.equal(addon.inspectSession(held.session).publication, undefined);
});

test("cancel requested after publication rejects observation and keeps no observer calls", t => {
  const fx = fixture(t, addon), held = fx.open(), tree = publish(addon, held);
  const snapshot = addon.cancelSession(held.session);
  assert.equal(snapshot.cancelRequested, true);
  assert.throws(() => addon.observePublication(held.session, tree.top.capability, tree.budget, "cancelled"), /session_cancel_requested/);
  assert.equal(addon.inspectSession(held.session).publication, undefined);
});

for (const kind of ["top", "directory", "leaf"]) test(`${kind} ABA replacement is not read or adopted`, t => {
  const fx = fixture(t, addon), held = fx.open(), tree = publish(addon, held);
  const root = join(fx.workspace, "canonical-tree"), nested = join(root, "nested"), leaf = join(nested, "report.docx");
  const original = kind === "top" ? root : kind === "directory" ? nested : leaf;
  renameSync(original, original + "-moved");
  if (kind === "leaf") writeFileSync(original, Buffer.alloc(tree.bytes.length, 0x42));
  else mkdirSync(original, { mode: 0o700 });
  const observation = addon.observePublication(held.session, tree.top.capability, tree.budget, "aba");
  noPayload(observation, "publication_original_node_mismatch");
  assert.equal(observation.calls.some(call => call.syscall.startsWith("pread")), false);
  assert.equal(observation.snapshot.resources.filter(resource => resource.kind === "created_file").length, 1);
  if (kind === "leaf") assert.deepEqual(readFileSync(original), Buffer.alloc(tree.bytes.length, 0x42));
  assert.throws(() => addon.observePublication(held.session, tree.top.capability, tree.budget, "aba-second"), /publication_observation_already_claimed/);
});

for (const kind of ["symlink", "missing", "append"]) test(`canonical ${kind} rejects without payload`, t => {
  const fx = fixture(t, addon), held = fx.open(), tree = publish(addon, held);
  const leaf = join(fx.workspace, "canonical-tree", "nested", "report.docx");
  if (kind === "append") appendFileSync(leaf, "x");
  else {
    renameSync(leaf, leaf + "-original");
    if (kind === "symlink") symlinkSync(leaf + "-original", leaf);
  }
  const observation = addon.observePublication(held.session, tree.top.capability, tree.budget, "observe" );
  noPayload(observation, kind === "append" ? "readback_size_mismatch" : "publication_entry_open_failed");
  assert.equal(observation.calls.some(call => call.syscall.startsWith("pread")), false);
});

test("foreign FIFO replacement is opened nonblocking and never read", t => {
  const fx = fixture(t, addon), held = fx.open(), tree = publish(addon, held);
  const leaf = join(fx.workspace, "canonical-tree", "nested", "report.docx");
  unlinkSync(leaf);
  const fifo = spawnSync("/usr/bin/mkfifo", ["-m", "600", leaf], { encoding: "utf8", timeout: 5000 });
  assert.equal(fifo.status, 0, fifo.stderr);
  noPayload(addon.observePublication(held.session, tree.top.capability, tree.budget, "fifo"), "publication_original_node_mismatch");
  assert.equal(addon.inspectSession(held.session).publication.calls.some(call => call.syscall.startsWith("pread")), false);
});

for (const mode of ["root-aba-after-eof", "readonly-ebadf-close", "readonly-reuse-close", "readonly-reuse-abandon", "short-read-budget", "unknown-after-eof"]) {
  test(`native publication ${mode}`, t => {
    const fx = fixture(t, addon);
    const child = spawnSync(process.env.OFFICE_LOCAL_PUBLICATION_TEST, [fx.stage, fx.workspace, mode], { encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const evidence = JSON.parse(child.stdout);
    t.diagnostic(JSON.stringify(evidence));
    if (mode === "root-aba-after-eof") assert.equal(evidence.parentRelativeFenceRejected, true);
    else if (mode === "short-read-budget") assert.equal(evidence.bounded, true);
    else if (mode === "unknown-after-eof") assert.equal(evidence.newOperationRejectedWithoutNewCalls, true);
    else assert.equal(evidence.foreignFDStillOpen, true);
  });
}
