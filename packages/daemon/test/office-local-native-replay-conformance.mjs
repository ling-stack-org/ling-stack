/** Explicit local addon → Daemon facts → complete pure Core replay; never portable test:ci or a safe receipt. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyOfficeLocalDirectoryReplayV2 } from "../../core/dist/index.js";
import { prepareOfficeArtifact } from "../dist/features/office-documents/office-artifact-preparation.js";
import { projectOfficeLocalNativePacket } from "../dist/features/office-documents/office-local-native-facts.js";
import { createNativeReplayEnvelope } from "./support/office-local-native-replay-envelope.mjs";

const artifactPath = process.env.OFFICE_LOCAL_NATIVE_CONFORMANCE_ADDON;
if (!artifactPath || realpathSync(artifactPath) !== artifactPath) throw new Error("A canonical explicit reviewed local addon is required.");
const addon = createRequire(import.meta.url)(artifactPath);
assert.equal(addon.protocolVersion, 2);
assert.equal(addon.scopeBinding, "unbound");
assert.equal(addon.coreSafe, false);
assert.equal(addon.packaged, false);

for (const directoryCount of [1, 3]) test(`actual ${directoryCount}-directory OOXML multi-chunk history passes complete graph-only replay`, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-native-replay-conformance-"))),
    stage = join(root, "stage"), workspace = join(root, "workspace");
  mkdirSync(stage, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
  let session, closeEntered = false, closed = false;
  t.after(() => {
    if (session && !closeEntered) {
      closeEntered = true;
      const reply = addon.closeSession(session);
      closed = reply.success === true;
    }
    if (session && !closed) {
      t.diagnostic(`Original close is unconfirmed; no retry or recursive removal. Owned fixture retained: ${root}`);
      assert.equal(closed, true, "Never hide an unsuccessful original cleanup with recursive fixture removal.");
    }
    if (!session || closed) rmSync(root, { recursive: true }); // Exact owned fixture only, not product path cleanup.
  });
  const request = { path: "report.docx", blocks: Array.from({ length: 16 }, () => ({ type: "paragraph",
    text: randomBytes(12 * 1024).toString("base64") })) };
  const artifact = await prepareOfficeArtifact("office_create_document", request);
  const bytes = artifact.bytes, chunkSize = 65536 + 257,
    digest = createHash("sha256").update(bytes).digest("hex"), caseId = `actual-native-replay-${directoryCount}`;
  assert.ok(Buffer.isBuffer(bytes));
  assert.ok(bytes.length > chunkSize * 2, "Actual OOXML must exercise multiple effects and internal 64 KiB writes.");
  const preparedAt = new Date().toISOString();
  const captureWindow = { preparedAt, enteredAt: new Date().toISOString(), calledAt: new Date().toISOString() };
  const capturePacket = addon.openSession(stage, workspace); session = capturePacket.session;
  captureWindow.returnedAt = new Date().toISOString();
  const capture = projectOfficeLocalNativePacket(capturePacket);
  const history = createNativeReplayEnvelope({ caseId, stagePath: stage, workspacePath: workspace,
    directoryCount, bytes, capture, preparedAt,
    requestDigest: createHash("sha256").update(JSON.stringify(request)).digest("hex") });
  history.record("capture_parents", `${caseId}-capture`, capture, {}, captureWindow);
  const invoke = (kind, parameters, callback, mode = "forward") => {
    const effectId = `${caseId}-${history.effectCount()}-${kind}`;
    const window = { preparedAt: new Date().toISOString(), enteredAt: new Date().toISOString(), calledAt: new Date().toISOString() };
    const packet = callback(effectId);
    window.returnedAt = new Date().toISOString();
    const projection = projectOfficeLocalNativePacket(packet);
    history.record(kind, effectId, projection, parameters, window, mode);
    return { packet, projection };
  };
  const directories = [], { execution } = history;
  let parent = capturePacket.stageParent,
    parentLifetimeId = capture.facts.snapshot.resources.find(resource => resource.kind === "stage_parent").lifetimeId;
  for (const member of execution.members.slice(0, -1)) {
    const { packet } = invoke("create_directory", { resourceSlotId: member.resourceSlotId,
      parentResourceSlotId: member.parentResourceSlotId, parentNativeLifetimeId: parentLifetimeId, basename: member.basename },
    effectId => addon.createDirectory(session, parent, member.basename, effectId));
    directories.push({ member, packet }); parent = packet.capability; parentLifetimeId = packet.resourceFact.lifetimeId;
  }
  const member = execution.members.at(-1);
  const file = invoke("create_file", { resourceSlotId: member.resourceSlotId, parentResourceSlotId: member.parentResourceSlotId,
    parentNativeLifetimeId: parentLifetimeId, basename: member.basename },
  effectId => addon.createFile(session, parent, member.basename, effectId)).packet;
  const fileParameters = { resourceSlotId: member.resourceSlotId, nativeLifetimeId: file.resourceFact.lifetimeId };
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    invoke("write_file", { ...fileParameters, offset, sizeBytes: chunk.length },
      effectId => addon.writeFile(session, file.capability, chunk, effectId));
  }
  invoke("fsync_resource", fileParameters, effectId => addon.fsyncResource(session, file.capability, effectId));
  const read = invoke("read_file", { ...fileParameters, expectedBytes: bytes.length, budgetBytes: bytes.length + 1 },
    effectId => addon.readFile(session, file.capability, bytes.length, bytes.length + 1, effectId));
  assert.deepEqual(read.projection.readbackBytes, { bytesSha256: digest, sizeBytes: bytes.length });
  assert.deepEqual(read.packet.bytes, bytes);
  invoke("close_resource", fileParameters, effectId => addon.closeResource(session, file.capability, effectId));
  for (const directory of directories.slice().reverse()) {
    invoke("fsync_resource", { resourceSlotId: directory.member.resourceSlotId, nativeLifetimeId: directory.packet.resourceFact.lifetimeId },
      effectId => addon.fsyncResource(session, directory.packet.capability, effectId));
  }
  const top = directories[0], stageParentId = capture.facts.snapshot.resources.find(resource => resource.kind === "stage_parent").lifetimeId,
    destinationParentId = capture.facts.snapshot.resources.find(resource => resource.kind === "destination_parent").lifetimeId;
  invoke("install_tree", { resourceSlotId: top.member.resourceSlotId, nativeLifetimeId: top.packet.resourceFact.lifetimeId,
    sourceParentResourceSlotId: execution.stage.parentResourceSlotId, sourceParentNativeLifetimeId: stageParentId,
    sourceBasename: execution.stage.topBasename, destinationParentResourceSlotId: execution.destination.parentResourceSlotId,
    destinationParentNativeLifetimeId: destinationParentId, destinationBasename: execution.destination.firstMissingComponent, flags: "RENAME_EXCL" },
  effectId => addon.installTree(session, top.packet.capability, execution.destination.firstMissingComponent, effectId));
  const parentSyncs = [
    { resourceSlotId: execution.stage.parentResourceSlotId, nativeLifetimeId: stageParentId, capability: capturePacket.stageParent },
    { resourceSlotId: execution.destination.parentResourceSlotId, nativeLifetimeId: destinationParentId, capability: capturePacket.destinationParent },
  ];
  for (const { resourceSlotId, nativeLifetimeId, capability } of directoryCount === 3 ? parentSyncs.reverse() : parentSyncs) {
    invoke("fsync_resource", { resourceSlotId, nativeLifetimeId }, effectId => addon.fsyncResource(session, capability, effectId));
  }
  const publication = invoke("observe_publication", { resourceSlotId: top.member.resourceSlotId,
    nativeLifetimeId: top.packet.resourceFact.lifetimeId, budgetBytes: bytes.length + 1 },
  effectId => addon.observePublication(session, top.packet.capability, bytes.length + 1, effectId));
  assert.equal(publication.projection.publicationBytes.length, 1);
  assert.equal(publication.projection.publicationBytes[0].bytesSha256, digest);
  assert.equal(publication.projection.publicationBytes[0].sizeBytes, bytes.length);
  assert.deepEqual(publication.packet.publicationFiles[0].bytes, bytes);
  assert.deepEqual(readFileSync(execution.targetPath), bytes, "Independent fixture read is not replay evidence.");
  invoke("close_session", {}, () => {
    closeEntered = true;
    const packet = addon.closeSession(session); closed = packet.success === true; return packet;
  }, directoryCount === 3 ? "cleanup" : "forward");
  const input = history.finish(), proof = verifyOfficeLocalDirectoryReplayV2(input);
  assert.deepEqual(proof, { kind: "graph_verified_only", executionId: execution.executionId,
    executionIdentityDigest: execution.identityDigest, targetMemberId: "file", effectCount: input.effects.length,
    resourceCount: input.terminal.resources.length,
    callCount: input.effects.reduce((count, entry) => count + entry.observation.native.result.calls.length, 0),
    coreSafe: false, canonicalVisibility: "unverified", scopeBinding: "unbound", packaged: false });
  assert.ok(Object.isFrozen(proof));
  const writes = input.effects.filter(entry => entry.effect.kind === "write_file");
  assert.ok(writes.length >= 3);
  assert.ok(writes.some(entry => entry.observation.native.result.calls.length >= 2));
  t.diagnostic(`Actual addon/Daemon/full Core graph: directories=${directoryCount}, bytes=${bytes.length}, writeEffects=${writes.length}, calls=${proof.callCount}. Pure DTO scope/seal references only; no SQLite, live issuer, protected scope, canonical window, pair settlement or packaged GUI.`);
});
