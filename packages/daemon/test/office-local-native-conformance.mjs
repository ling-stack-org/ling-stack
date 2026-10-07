/** Explicit local-addon conformance gate; not part of portable daemon test:ci or a Host safe receipt. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareOfficeArtifact } from "../dist/features/office-documents/office-artifact-preparation.js";
import { projectOfficeLocalNativePacket } from "../dist/features/office-documents/office-local-native-facts.js";

const artifactPath = process.env.OFFICE_LOCAL_NATIVE_CONFORMANCE_ADDON;
if (!artifactPath || realpathSync(artifactPath) !== artifactPath) throw new Error("A canonical explicit reviewed local addon is required.");
const addon = createRequire(import.meta.url)(artifactPath);
assert.equal(addon.protocolVersion, 2);
assert.equal(addon.scopeBinding, "unbound"); assert.equal(addon.coreSafe, false);

test("actual native packet, original read and publication bytes satisfy Core's unique v2 facts schema", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-office-native-conformance-"))), stage = join(root, "stage"), destination = join(root, "workspace");
  mkdirSync(stage, { mode: 0o700 }); mkdirSync(destination, { mode: 0o700 });
  let session, closed = false;
  t.after(() => {
    if (session && !closed) {
      const close = addon.closeSession(session);
      assert.equal(close.success, true, "A failed original close cannot be hidden by fixture cleanup.");
      closed = true;
    }
    if (!session || closed) rmSync(root, { recursive: true }); // Exact owned test fixture only.
  });
  const artifact = await prepareOfficeArtifact("office_create_document", { path: "nested/report.docx",
    blocks: [{ type: "paragraph", text: "Native → actual Buffer → Core v2 facts conformance" }] });
  const bytes = artifact.bytes, digest = createHash("sha256").update(bytes).digest("hex");
  const checked = packet => {
    const projection = projectOfficeLocalNativePacket(packet);
    assert.equal(projection.facts.success, true, JSON.stringify(projection.facts));
    assert.equal(projection.facts.snapshot.scopeBinding, "unbound");
    assert.equal(projection.facts.snapshot.coreSafe, false);
    assert.equal(projection.facts.snapshot.packaged, false);
    return projection;
  };
  const capture = addon.openSession(stage, destination); session = capture.session;
  assert.equal(checked(capture).facts.operationId, "");
  const top = addon.createDirectory(session, capture.stageParent, "host-tree", "create-tree"); checked(top);
  const file = addon.createFile(session, top.capability, "report.docx", "create-file"); checked(file);
  checked(addon.writeFile(session, file.capability, bytes, "write-original"));
  checked(addon.fsyncResource(session, file.capability, "sync-original"));
  const read = checked(addon.readFile(session, file.capability, bytes.length, bytes.length + 1, "read-original"));
  assert.deepEqual(read.readbackBytes, { bytesSha256: digest, sizeBytes: bytes.length });
  checked(addon.closeResource(session, file.capability, "close-original"));
  checked(addon.fsyncResource(session, top.capability, "sync-tree"));
  checked(addon.installTree(session, top.capability, "nested", "install-tree"));
  checked(addon.fsyncResource(session, capture.stageParent, "sync-stage-parent"));
  checked(addon.fsyncResource(session, capture.destinationParent, "sync-destination-parent"));
  const publication = checked(addon.observePublication(session, top.capability, bytes.length + 1, "observe-publication"));
  assert.equal(publication.facts.publication.observationBasis, "original_destination_parent_relative");
  assert.equal(publication.publicationBytes.length, 1);
  assert.equal(publication.publicationBytes[0].bytesSha256, digest);
  assert.equal(publication.publicationBytes[0].sizeBytes, bytes.length);
  assert.equal(publication.publicationBytes[0].originalLifetimeId, file.resourceFact.lifetimeId);
  assert.deepEqual(readFileSync(join(destination, "nested/report.docx")), bytes);
  const close = addon.closeSession(session); closed = close.success === true;
  assert.equal(checked(close).facts.operationId, "");
  assert.ok(close.snapshot.resources.every(resource => resource.state === "closed"));
  t.diagnostic("Local Node22 native/Daemon/Core-schema conformance only; no Host scope, SQLite pair settlement or packaged capability.");
});

test("actual foreign FIFO publication remains a returned-false packet with its true node type", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-office-native-fifo-facts-"))), stage = join(root, "stage"), destination = join(root, "workspace");
  mkdirSync(stage, { mode: 0o700 }); mkdirSync(destination, { mode: 0o700 });
  const capture = addon.openSession(stage, destination), session = capture.session;
  let closed = false;
  t.after(() => {
    if (!closed) { const packet = addon.closeSession(session); assert.equal(packet.success, true); closed = true; }
    if (closed) rmSync(root, { recursive: true }); // Explicitly owned fixture only, not product cleanup.
  });
  const checked = packet => { projectOfficeLocalNativePacket(packet); assert.equal(packet.success, true); return packet; };
  checked(capture);
  const top = checked(addon.createDirectory(session, capture.stageParent, "tree", "create-tree"));
  const file = checked(addon.createFile(session, top.capability, "report.docx", "create-file"));
  checked(addon.writeFile(session, file.capability, Buffer.from("abc"), "write-file"));
  checked(addon.fsyncResource(session, file.capability, "sync-file"));
  checked(addon.closeResource(session, file.capability, "close-file"));
  checked(addon.fsyncResource(session, top.capability, "sync-tree"));
  checked(addon.installTree(session, top.capability, "nested", "install-tree"));
  const path = join(destination, "nested/report.docx");
  renameSync(path, join(root, "original-file"));
  execFileSync("/usr/bin/mkfifo", [path]); // Actual kernel FIFO in this exact disposable fixture.
  const raw = addon.observePublication(session, top.capability, 4, "observe-fifo"), projection = projectOfficeLocalNativePacket(raw);
  assert.equal(raw.success, false); assert.equal(projection.facts.success, false);
  assert.equal(projection.facts.nativeOutcome, "returned");
  assert.equal(projection.publicationBytes, undefined);
  const foreign = projection.facts.snapshot.resources.find(resource => resource.kind === "publication_file");
  assert.equal(foreign.initialIdentity.mode & 0o170000, 0o010000);
  assert.equal(foreign.initialIdentity.isFile, false); assert.equal(foreign.initialIdentity.isDirectory, false);
  const close = addon.closeSession(session); closed = close.success === true;
  projectOfficeLocalNativePacket(close); assert.equal(closed, true);
});
