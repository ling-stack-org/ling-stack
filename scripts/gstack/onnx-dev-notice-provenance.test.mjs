import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { verifyOnnxDevNoticeProof } from "./onnx-dev-notice-provenance.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const blob = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const record = bytes => ({ checksum: checksum(bytes), gitBlob: blob(bytes), contentBase64: bytes.toString("base64") });

export function onnxProofFixture(name = "onnxruntime-common") {
  const revision = "b39e14432259d5f579f34c3e338f1f70aa368f01";
  const version = "1.24.0-dev.20251116-b39e144322";
  const pkg = Buffer.from(JSON.stringify({ name, version: "1.24.0", license: "MIT" }));
  const marker = Buffer.from(revision);
  const commit = Buffer.from(JSON.stringify({ sha: revision, tree: { sha: "c".repeat(40) },
    committer: { date: "2025-11-16T12:00:00Z" } }));
  const proof = { kind: "installed-onnx-dev-commit-match", repository: "Microsoft/onnxruntime", revision,
    packagePath: `js/${name === "onnxruntime-web" ? "web" : "common"}/package.json`,
    package: record(pkg), versionNumber: { path: "VERSION_NUMBER", ...record(Buffer.from("1.24.0\n")) },
    commitChecksum: checksum(commit), commitContentBase64: commit.toString("base64"),
    markerContentBase64: marker.toString("base64"),
    tarball: { url: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`, checksum: checksum("verified archive"), sizeBytes: 512 },
    installedFiles: [
      { path: "package.json", checksum: checksum("installed metadata"), sizeBytes: 32 },
      { path: "__commit.txt", checksum: checksum(marker), sizeBytes: marker.length },
      { path: "lib/version.ts", checksum: checksum("generated version"), sizeBytes: 32 },
      { path: "dist/esm/index.js", checksum: checksum("compiled code"), sizeBytes: 32 },
    ] };
  return { proof, options: { proof, repository: proof.repository, revision, name, version, license: "MIT",
    registryIntegrity: proof.tarball.integrity } };
}

test("ONNX dev notices require the official full embedded commit and exact source version/date", () => {
  for (const name of ["onnxruntime-common", "onnxruntime-web"]) {
    const f = onnxProofFixture(name);
    assert.equal(verifyOnnxDevNoticeProof(f.options), undefined);
  }
});

test("short version suffixes cannot replace the complete verified build commit", () => {
  for (const mutate of [
    p => { delete p.markerContentBase64; },
    p => { p.markerContentBase64 = Buffer.from(p.revision.slice(0, 10)).toString("base64"); },
    p => { p.markerContentBase64 = Buffer.from("d".repeat(40)).toString("base64"); },
    p => { p.installedFiles = p.installedFiles.filter(file => file.path !== "__commit.txt"); },
    p => { p.installedFiles.find(file => file.path === "__commit.txt").checksum = checksum("changed marker"); },
    p => { const bytes = Buffer.from(JSON.stringify({ sha: p.revision, tree: { sha: "c".repeat(40) },
      committer: { date: "2025-11-17T12:00:00Z" } }));
      p.commitChecksum = checksum(bytes); p.commitContentBase64 = bytes.toString("base64"); },
  ]) {
    const f = onnxProofFixture(); mutate(f.proof);
    assert.throws(() => verifyOnnxDevNoticeProof(f.options), /notice_source_onnx_/);
  }
});

test("ONNX build proofs reject unrelated repositories, nearby versions and altered or incomplete resources", () => {
  for (const mutate of [
    p => { p.repository = "unrelated/onnxruntime"; },
    p => { p.packagePath = "js/web/package.json"; },
    p => { p.package = record(Buffer.from(JSON.stringify({ name: "onnxruntime-common", version: "1.25.0", license: "MIT" }))); },
    p => { p.versionNumber = { path: "VERSION_NUMBER", ...record(Buffer.from("1.25.0\n")) }; },
    p => { p.tarball.url = "https://untrusted.example/onnx.tgz"; },
    p => { p.tarball.integrity = `sha512-${Buffer.alloc(64, 2).toString("base64")}`; },
    p => { p.installedFiles.pop(); },
    p => { p.installedFiles.push(p.installedFiles[0]); },
    p => { p.installedFiles[0].path = "../package.json"; },
    p => { p.installedFiles[0].sizeBytes = -1; },
  ]) {
    const f = onnxProofFixture(); mutate(f.proof);
    assert.throws(() => verifyOnnxDevNoticeProof(f.options), /notice_source_onnx_/);
  }
  const f = onnxProofFixture();
  for (const changes of [{ name: "onnxruntime-node" }, { version: "1.24.0-dev.20251117-b39e144322" },
    { version: "1.24.0-dev.20251116-b39e1443220" }, { license: "Apache-2.0" }]) {
    assert.throws(() => verifyOnnxDevNoticeProof({ ...f.options, ...changes }), /notice_source_onnx_/);
  }
});
