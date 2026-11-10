import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { extractReviewedNoticeBytes, verifyExactReleaseNoticeProof, verifyGitHubNoticeFile,
  verifyInstalledSourceMapNoticeProof, verifyInstalledNoticeSourceMap, safeNoticeSourcePath } from "./notice-source-provenance.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const blob = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const revision = "a".repeat(40);
const pkg = Buffer.from(JSON.stringify({ name: "helper", version: "1.0.0", license: "MIT" }));
const ref = Buffer.from(JSON.stringify({ ref: "refs/tags/v1.0.0", object: { type: "commit", sha: revision } }));
const proof = { kind: "exact-version-tag", repository: "fixture/helper", revision, tag: "v1.0.0",
  refContentBase64: ref.toString("base64"), refChecksum: checksum(ref), packagePath: "packages/helper/package.json",
  packageGitBlob: blob(pkg), packageChecksum: checksum(pkg), packageContentBase64: pkg.toString("base64") };
const options = { proof, repository: "fixture/helper", revision, name: "helper", version: "1.0.0", license: "MIT" };

test("notice paths support scoped npm packages without permitting absolute paths or traversal", () => {
  for (const path of ["LICENSE", "packages/react/tabs/src/index.ts", "node_modules/@radix-ui/react-tabs/package.json",
    "lib/diagram-render/node_modules/parent/node_modules/@radix-ui/react-tabs/dist/index.js.map"]) {
    assert.equal(safeNoticeSourcePath(path), true, path);
  }
  for (const path of ["", "/node_modules/@radix-ui/react-tabs", "../LICENSE", "node_modules/../LICENSE", "./LICENSE",
    "node_modules//helper", "node_modules\\helper", "C:/node_modules/helper", "%2e%2e/LICENSE", "LICENSE\0", "LICENSE\n"]) {
    assert.equal(safeNoticeSourcePath(path), false, path);
  }
});

test("release provenance binds the exact frozen tag, commit and source package identity", () => {
  assert.equal(verifyExactReleaseNoticeProof(options), undefined);
  assert.equal(verifyExactReleaseNoticeProof({ ...options, repository: "Fixture/Helper" }), undefined);
});

test("an exact version tag without a v prefix retains the same commit and package identity requirements", () => {
  const changed = structuredClone(proof);
  changed.tag = "1.0.0";
  const bytes = Buffer.from(JSON.stringify({ ref: "refs/tags/1.0.0", object: { type: "commit", sha: revision } }));
  changed.refContentBase64 = bytes.toString("base64");
  changed.refChecksum = checksum(bytes);
  assert.equal(verifyExactReleaseNoticeProof({ ...options, proof: changed }), undefined);
  for (const tag of ["latest", "release-1.0.0", "1.0.1", "v1.0.0-old", "../1.0.0"]) {
    assert.throws(() => verifyExactReleaseNoticeProof({ ...options, proof: { ...changed, tag } }), /notice_source_release_/);
  }
});

test("a moved tag, wrong package or changed proof bytes cannot substitute for an exact release", () => {
  for (const change of [
    p => { p.revision = "b".repeat(40); },
    p => { p.tag = "v2.0.0"; },
    p => { p.repository = "unrelated/helper"; },
    p => { p.packagePath = "../package.json"; },
    p => { p.packageGitBlob = "b".repeat(40); },
    p => { p.refContentBase64 = Buffer.from("{}").toString("base64"); },
    p => { const bytes = Buffer.from(JSON.stringify({ ref: "refs/tags/v1.0.0", object: { type: "tag", sha: revision } }));
      p.refContentBase64 = bytes.toString("base64"); p.refChecksum = checksum(bytes); },
    p => { const bytes = Buffer.from(JSON.stringify({ name: "helper", version: "1.0.1", license: "MIT" }));
      p.packageContentBase64 = bytes.toString("base64"); p.packageChecksum = checksum(bytes); p.packageGitBlob = blob(bytes); },
  ]) {
    const changed = structuredClone(proof);
    change(changed);
    assert.throws(() => verifyExactReleaseNoticeProof({ ...options, proof: changed }), /notice_source_/);
  }
});

test("README notice selection preserves a reviewed byte range rather than synthesizing a generic license", () => {
  const bytes = Buffer.from("README intro\r\nCopyright original owner\r\nOriginal exact grant\r\n");
  const startByte = bytes.indexOf(Buffer.from("Copyright"));
  const selected = bytes.subarray(startByte);
  const selection = { method: "verbatim-byte-range", startByte, endByte: bytes.length, checksum: checksum(selected) };
  assert.deepEqual(extractReviewedNoticeBytes(bytes, selection), selected);
  assert.deepEqual(extractReviewedNoticeBytes(bytes), bytes);
  for (const change of [{ startByte: -1 }, { startByte: 0.5 }, { endByte: bytes.length + 1 },
    { endByte: startByte }, { checksum: checksum("wrong") }, { method: "generated-mit" }]) {
    assert.throws(() => extractReviewedNoticeBytes(bytes, { ...selection, ...change }), /notice_source_selection_/);
  }
});

test("GitHub text decoding accepts wrapped base64 but rejects symlinks, corrupt blobs and invalid encoding", () => {
  const bytes = Buffer.from("Copyright fixture\n");
  const data = { type: "file", encoding: "base64", content: `${bytes.toString("base64")}\n`, sha: blob(bytes) };
  assert.deepEqual(verifyGitHubNoticeFile(data), bytes);
  for (const change of [{ type: "symlink" }, { encoding: "none" }, { sha: "b".repeat(40) }, { content: "!invalid!" }]) {
    assert.throws(() => verifyGitHubNoticeFile({ ...data, ...change }), /notice_source_/);
  }
});

function sourceMapProof() {
  const code = Buffer.from("export const real = 1;\n");
  const map = Buffer.from(JSON.stringify({ version: 3, sourceRoot: "", sources: ["packages/helper/src/index.ts"], sourcesContent: [code.toString()], names: [], mappings: "" }));
  const files = ["package.json", "README.md", "dist/index.js", "dist/index.module.js", "dist/index.d.ts", "dist/index.js.map", "dist/index.module.js.map"]
    .map(path => ({ path, checksum: checksum(path.endsWith(".map") ? map : pkg), sizeBytes: path.endsWith(".map") ? map.length : pkg.length }));
  const sources = [{ path: "packages/helper/src/index.ts", checksum: checksum(code), gitBlob: blob(code), sizeBytes: code.length }];
  const commit = Buffer.from(JSON.stringify({ sha: revision, tree: { sha: "b".repeat(40) } }));
  const value = { kind: "installed-source-map-match", repository: "fixture/helper", revision,
    packagePath: "packages/helper/package.json", packageContentBase64: pkg.toString("base64"), packageChecksum: checksum(pkg), packageGitBlob: blob(pkg),
    sourceTreeHash: "b".repeat(40), treeChecksum: checksum("reviewed tree"),
    commitChecksum: checksum(commit), commitContentBase64: commit.toString("base64"),
    tarball: { url: "https://registry.npmjs.org/helper/-/helper-1.0.0.tgz", integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
      checksum: checksum("verified archive"), sizeBytes: 512 }, installedFiles: files,
    sourceMaps: ["dist/index.js.map", "dist/index.module.js.map"].map(path => ({ path, checksum: checksum(map), sources })) };
  return { value, map, options: { proof: value, repository: "fixture/helper", revision, name: "helper", version: "1.0.0", license: "MIT", registryIntegrity: value.tarball.integrity } };
}

test("installed source-map proofs bind exact npm artifacts, source package identity and every map source", () => {
  const f = sourceMapProof();
  assert.equal(verifyInstalledSourceMapNoticeProof(f.options), undefined);
  assert.equal(verifyInstalledNoticeSourceMap({ proof: f.value, path: "dist/index.js.map", bytes: f.map }), undefined);
});

test("source-map proof preflight rejects incomplete artifacts, mismatched identity and unreviewed source paths", () => {
  const f = sourceMapProof();
  for (const mutate of [
    p => { p.packageGitBlob = "b".repeat(40); },
    p => { p.sourceTreeHash = "c".repeat(40); },
    p => { const bytes = Buffer.from(JSON.stringify({ sha: "c".repeat(40), tree: { sha: p.sourceTreeHash } }));
      p.commitChecksum = checksum(bytes); p.commitContentBase64 = bytes.toString("base64"); },
    p => { p.tarball.integrity = `sha512-${Buffer.alloc(64, 2).toString("base64")}`; },
    p => { p.tarball.url = "https://untrusted.example/helper.tgz"; },
    p => { p.installedFiles.pop(); },
    p => { p.installedFiles.push(p.installedFiles[0]); },
    p => { p.installedFiles[0].path = "../package.json"; },
    p => { p.sourceMaps[0].sources[0].path = "packages/unrelated/src/index.ts"; },
    p => { p.sourceMaps[0].checksum = checksum("wrong map"); },
  ]) {
    const changed = structuredClone(f.value); mutate(changed);
    assert.throws(() => verifyInstalledSourceMapNoticeProof({ ...f.options, proof: changed }), /notice_source_map_/);
  }
});

test("actual map verification rejects a changed or omitted source even with a refreshed map checksum", () => {
  for (const mutate of [
    m => { m.sourcesContent[0] = "export const tampered = 2;\n"; },
    m => { m.sources.push("packages/helper/src/unreviewed.ts"); m.sourcesContent.push("extra"); },
    m => { m.sourceRoot = "https://untrusted.example/"; },
    m => { m.sourcesContent = []; },
  ]) {
    const f = sourceMapProof();
    const map = JSON.parse(f.map.toString()); mutate(map);
    const bytes = Buffer.from(JSON.stringify(map));
    f.value.sourceMaps[0].checksum = checksum(bytes);
    assert.throws(() => verifyInstalledNoticeSourceMap({ proof: f.value, path: "dist/index.js.map", bytes }), /notice_source_map_/);
  }
});
