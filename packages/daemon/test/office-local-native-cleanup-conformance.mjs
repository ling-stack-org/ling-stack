/** Explicit local addon gate: failed publication → original cleanup → Core observation/history. Not portable test:ci. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateOfficeLocalDirectoryObservationPayloadV2 } from "../../core/dist/storage/sqlite/host-office-local-directory-v2-observations.js";
import { officeDirectorySlotsV2 } from "../../core/dist/storage/sqlite/host-office-local-directory-v2-effects.js";
import { validateOfficeDirectoryHistoryV2 } from "../../core/dist/storage/sqlite/host-office-local-directory-v2-history.js";
import { directoryV2Hash, directoryV2Prepared } from "../../core/test/support/host-office-local-directory-v2-fixture.mjs";
import { projectOfficeLocalNativePacket } from "../dist/features/office-documents/office-local-native-facts.js";

const artifactPath = process.env.OFFICE_LOCAL_NATIVE_CONFORMANCE_ADDON;
if (!artifactPath || realpathSync(artifactPath) !== artifactPath) throw new Error("A canonical explicit reviewed local addon is required.");
const addon = createRequire(import.meta.url)(artifactPath);
assert.equal(addon.protocolVersion, 2);

test("actual failed FIFO publication and guarded closeSession retain valid Core observations without claiming safe", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-native-cleanup-conformance-"))), stage = join(root, "stage"), destination = join(root, "workspace");
  mkdirSync(stage, { mode: 0o700 }); mkdirSync(destination, { mode: 0o700 });
  let session, closeEntered = false, closed = false;
  t.after(() => {
    if (session && !closeEntered) {
      closeEntered = true;
      const reply = addon.closeSession(session); closed = reply.success === true;
    }
    if (session && !closed) {
      t.diagnostic(`Original close is unconfirmed; no retry or fixture removal. Retained fixture: ${root}`);
      assert.equal(closed, true, "A failed or unacknowledged original close cannot be retried during teardown.");
    }
    if (!session || closed) rmSync(root, { recursive: true }); // Exact disposable fixture only; not product path cleanup.
  });
  const capture = addon.openSession(stage, destination); session = capture.session;
  const prepared = directoryV2Prepared({ workspacePath: destination, stagePath: stage }), captured = projectOfficeLocalNativePacket(capture).facts;
  let index = 0;
  for (const role of ["stage", "destination"]) for (const ancestor of prepared[role].ancestors) {
    ancestor.identity = captured.snapshot.resources[index++].initialIdentity;
  }
  prepared.workspaceIdentity = prepared.destination.ancestors.at(-1).identity;
  prepared.output = { bytesSha256: directoryV2Hash("abc"), sizeBytes: 3 };
  const execution = { ...prepared, preparedArtifactId: "pure-conformance-preparation", preparedDigest: "d".repeat(64),
    identityDigest: "e".repeat(64), revision: 0 }, slots = officeDirectorySlotsV2(execution), bindings = new Map(), history = [];
  const observe = (kind, packet, parameters = {}) => {
    const effectId = kind === "capture_parents" ? "capture" : kind === "close_session" ? "cleanup" : packet.operationId;
    const effect = { effectId, ordinal: history.length, kind, mode: kind === "close_session" ? "cleanup" : "forward",
      preparedAt: prepared.preparedAt, enteredAt: prepared.preparedAt, executionId: execution.executionId,
      effectDigest: "f".repeat(64), revision: 1, ...parameters };
    const facts = projectOfficeLocalNativePacket(packet).facts;
    for (const [ordinal, resource] of facts.snapshot.resources.entries()) {
      const slot = slots[ordinal];
      assert.equal(resource.kind, slot.kind); assert.equal(resource.basename, slot.basename);
      if (!bindings.has(resource.lifetimeId)) {
        const acquisition = facts.calls.findIndex(call => call.resourceLifetimeId === resource.lifetimeId && call.returned === "descriptor_acquired_redacted");
        const firstStat = facts.calls.findIndex(call => call.resourceLifetimeId === resource.lifetimeId && call.syscall === "fstat" && call.returned === 0);
        bindings.set(resource.lifetimeId, { resourceSlotId: slot.resourceSlotId, nativeLifetimeId: resource.lifetimeId,
          ...(acquisition < 0 ? {} : { acquisitionCallRef: { effectId, ordinal: acquisition } }),
          ...(firstStat < 0 ? {} : { firstFstatCallRef: { effectId, ordinal: firstStat } }) });
      }
    }
    // Full observation validation is used for closeSession. All earlier actual
    // batches retain original callRefs for history continuity; these envelopes
    // are pure DTOs, not SQLite/Host authority or a canonical window proof.
    const observation = { schemaVersion: 2, protocol: prepared.protocol, kind: "office_local_directory_effect_v2",
      executionId: execution.executionId, executionIdentityDigest: execution.identityDigest, source: prepared.source,
      effectId, effectDigest: effect.effectDigest, native: { state: "returned", calledAt: effect.enteredAt, returnedAt: effect.enteredAt, result: facts },
      host: { state: "returned" }, resourceBindings: [...bindings.values()], completedAt: effect.enteredAt };
    history.push({ effect, observation });
    if (kind === "close_session") assert.deepEqual(validateOfficeLocalDirectoryObservationPayloadV2(execution, effect, observation, observation.completedAt), observation);
    return facts;
  };
  observe("capture_parents", capture);
  const top = addon.createDirectory(session, capture.stageParent, "private", "create-tree");
  const stageLifetimeId = top.resourceFact.parentLifetimeId, treeLifetimeId = top.resourceFact.lifetimeId;
  observe("create_directory", top, { resourceSlotId: "tree", parentResourceSlotId: prepared.stage.parentResourceSlotId,
    parentNativeLifetimeId: stageLifetimeId, basename: "private" });
  const file = addon.createFile(session, top.capability, "report.docx", "create-file"), fileLifetimeId = file.resourceFact.lifetimeId;
  observe("create_file", file, { resourceSlotId: "file", parentResourceSlotId: "tree", parentNativeLifetimeId: treeLifetimeId, basename: "report.docx" });
  const fileParameters = { resourceSlotId: "file", nativeLifetimeId: fileLifetimeId }, treeParameters = { resourceSlotId: "tree", nativeLifetimeId: treeLifetimeId };
  observe("write_file", addon.writeFile(session, file.capability, Buffer.from("abc"), "write-file"), { ...fileParameters, offset: 0, sizeBytes: 3 });
  observe("fsync_resource", addon.fsyncResource(session, file.capability, "sync-file"), fileParameters);
  observe("close_resource", addon.closeResource(session, file.capability, "close-file"), fileParameters);
  observe("fsync_resource", addon.fsyncResource(session, top.capability, "sync-tree"), treeParameters);
  observe("install_tree", addon.installTree(session, top.capability, "new", "install-tree"), { ...treeParameters,
    sourceParentResourceSlotId: prepared.stage.parentResourceSlotId, sourceParentNativeLifetimeId: stageLifetimeId, sourceBasename: "private",
    destinationParentResourceSlotId: prepared.destination.parentResourceSlotId, destinationParentNativeLifetimeId: captured.snapshot.resources.at(-1).lifetimeId,
    destinationBasename: "new", flags: "RENAME_EXCL" });
  const path = join(destination, "new/report.docx"); renameSync(path, join(root, "original-file"));
  execFileSync("/usr/bin/mkfifo", [path]);
  const publication = observe("observe_publication", addon.observePublication(session, top.capability, 4, "observe-fifo"), { ...treeParameters, budgetBytes: 4 });
  assert.equal(publication.success, false); assert.equal(publication.nativeOutcome, "returned");
  closeEntered = true;
  const close = addon.closeSession(session); closed = close.success === true;
  const cleanup = observe("close_session", close);
  assert.equal(cleanup.success, true); assert.equal(cleanup.snapshot.everFailed, true);
  assert.equal(cleanup.calls[0].syscall, "fstat"); assert.equal(cleanup.calls[1].syscall, "close");
  assert.equal(cleanup.snapshot.resources.at(-1).initialIdentity.mode & 0o170000, 0o010000);
  assert.equal(validateOfficeDirectoryHistoryV2(history).size, cleanup.snapshot.resources.length);
  assert.equal(cleanup.snapshot.coreSafe, false); assert.equal(cleanup.snapshot.protectedStageVerified, false);
  assert.equal(cleanup.snapshot.scopeBinding, "unbound"); assert.equal(cleanup.snapshot.packaged, false);
  t.diagnostic("Actual local Node22/addon failure cleanup conformance; pure envelopes, not SQLite settlement, protected Host scope or packaged GUI.");
});
