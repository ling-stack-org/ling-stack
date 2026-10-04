import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureOfficeLocalSnapshot, copyOfficeLocalSnapshotBytes, revalidateOfficeLocalSnapshot } from "../dist/features/office-documents/office-local-snapshot.js";

const source = Object.freeze({ runId: "run", workUnitId: "unit", attemptId: "original", runtimeInstanceId: "runtime", fencingToken: "fence" });
async function fixture(t) {
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), "ling-office-snapshot-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test("Office fixed reader captures owned source bytes once and returns independent copies", async t => {
  const cwd = await fixture(t), path = join(cwd, "input.docx"), bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 0xff]);
  writeFileSync(path, bytes);
  const snapshot = captureOfficeLocalSnapshot(cwd, "input.docx", "docx", source);
  assert.deepEqual(snapshot.source, source); assert.equal(snapshot.targetPath, path);
  assert.equal(snapshot.input.bytesSha256, createHash("sha256").update(bytes).digest("hex"));
  const one = copyOfficeLocalSnapshotBytes(snapshot); one.fill(0);
  assert.deepEqual(copyOfficeLocalSnapshotBytes(snapshot), bytes);
  assert.deepEqual(readFileSync(path), bytes);
  assert.throws(() => copyOfficeLocalSnapshotBytes({ ...snapshot }), /office_local_snapshot_invalid/);
  assert.throws(() => revalidateOfficeLocalSnapshot({ ...snapshot }), /office_local_snapshot_invalid/);
  assert.equal(Object.isFrozen(snapshot), true); assert.equal(Object.isFrozen(snapshot.input.identity), true);
  assert.equal(Object.isFrozen(snapshot.workspaceIdentity), true);
  assert.throws(() => { snapshot.workspaceIdentity.inode = "foreign"; }, TypeError);
});

test("Office preparation of a nonexistent nested path creates no directory or file", async t => {
  const cwd = await fixture(t), snapshot = captureOfficeLocalSnapshot(cwd, "new/nested/result.xlsx", "xlsx", source);
  assert.equal(snapshot.input.state, "absent"); assert.equal(copyOfficeLocalSnapshotBytes(snapshot), undefined);
  assert.deepEqual(snapshot.directories.map(item => item.path), [join(cwd, "new"), join(cwd, "new/nested")]);
  assert.throws(() => readFileSync(join(cwd, "new")), error => error.code === "ENOENT");
  revalidateOfficeLocalSnapshot(snapshot);
});

for (const path of ["../outside.docx", "/private/outside.docx", "wrong.xlsx", "", "bad\0.docx"]) {
  test(`Office fixed reader refuses unsafe/wrong-format request ${JSON.stringify(path)}`, async t => {
    const cwd = await fixture(t);
    assert.throws(() => captureOfficeLocalSnapshot(cwd, path, "docx", source), /office_local_path_invalid/);
  });
}

test("Office fixed reader refuses target and ancestor symlinks including in-workspace aliases", async t => {
  const cwd = await fixture(t); writeFileSync(join(cwd, "original.docx"), Buffer.from("binary"));
  symlinkSync(join(cwd, "original.docx"), join(cwd, "alias.docx"));
  assert.throws(() => captureOfficeLocalSnapshot(cwd, "alias.docx", "docx", source), /office_local_path_unsafe/);
  mkdirSync(join(cwd, "folder")); writeFileSync(join(cwd, "folder/input.docx"), Buffer.from("binary"));
  symlinkSync(join(cwd, "folder"), join(cwd, "alias-folder"));
  assert.throws(() => captureOfficeLocalSnapshot(cwd, "alias-folder/input.docx", "docx", source), /office_local_path_unsafe/);
});

test("Office exact target update/replacement is rejected and does not overwrite external bytes", async t => {
  const cwd = await fixture(t), path = join(cwd, "input.docx"); writeFileSync(path, Buffer.from("original"));
  const snapshot = captureOfficeLocalSnapshot(cwd, "input.docx", "docx", source);
  writeFileSync(path, Buffer.from("external"));
  assert.throws(() => revalidateOfficeLocalSnapshot(snapshot), /office_local_snapshot_changed/);
  assert.deepEqual(copyOfficeLocalSnapshotBytes(snapshot), Buffer.from("original"));
  assert.deepEqual(readFileSync(path), Buffer.from("external"));
  renameSync(path, join(cwd, "displaced.docx")); writeFileSync(path, Buffer.from("original"));
  assert.throws(() => revalidateOfficeLocalSnapshot(snapshot), /office_local_snapshot_changed/);
});

test("Office formerly absent target/directory cannot be borrowed after another writer creates it", async t => {
  const cwd = await fixture(t), absent = captureOfficeLocalSnapshot(cwd, "input.docx", "docx", source);
  writeFileSync(join(cwd, "input.docx"), Buffer.from("external"));
  assert.throws(() => revalidateOfficeLocalSnapshot(absent), /office_local_snapshot_changed/);
  const nested = captureOfficeLocalSnapshot(cwd, "nested/input.docx", "docx", source); mkdirSync(join(cwd, "nested"));
  assert.throws(() => revalidateOfficeLocalSnapshot(nested), /office_local_snapshot_changed/);
});

test("Office ancestor replacement and symlink substitution fail before subsequent publication", async t => {
  const cwd = await fixture(t); mkdirSync(join(cwd, "folder")); writeFileSync(join(cwd, "folder/input.docx"), Buffer.from("original"));
  const snapshot = captureOfficeLocalSnapshot(cwd, "folder/input.docx", "docx", source);
  renameSync(join(cwd, "folder"), join(cwd, "displaced")); mkdirSync(join(cwd, "folder"));
  writeFileSync(join(cwd, "folder/input.docx"), Buffer.from("external"));
  assert.throws(() => revalidateOfficeLocalSnapshot(snapshot), /office_local_snapshot_changed/);
  renameSync(join(cwd, "folder"), join(cwd, "external-folder")); symlinkSync(join(cwd, "external-folder"), join(cwd, "folder"));
  assert.throws(() => revalidateOfficeLocalSnapshot(snapshot), /office_local_snapshot_changed/);
  assert.deepEqual(readFileSync(join(cwd, "external-folder/input.docx")), Buffer.from("external"));
});

test("Office reader rejects empty, oversized, or directory inputs without serializer work", async t => {
  const cwd = await fixture(t); writeFileSync(join(cwd, "empty.docx"), Buffer.alloc(0));
  assert.throws(() => captureOfficeLocalSnapshot(cwd, "empty.docx", "docx", source), /office_document_too_large/);
  mkdirSync(join(cwd, "directory.docx"));
  assert.throws(() => captureOfficeLocalSnapshot(cwd, "directory.docx", "docx", source), /office_local_path_unsafe/);
  // A sparse file exercises size admission without allocating a large reader buffer.
  const { openSync, ftruncateSync, closeSync } = await import("node:fs");
  const fd = openSync(join(cwd, "large.docx"), "wx");
  try { ftruncateSync(fd, 50 * 1024 * 1024 + 1); } finally { closeSync(fd); }
  assert.throws(() => captureOfficeLocalSnapshot(cwd, "large.docx", "docx", source), /office_document_too_large/);
});
