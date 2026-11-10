import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { installReviewedGstackNotices, REVIEWED_GSTACK_NOTICE_CATALOG_CHECKSUM } from "./install-reviewed-notices.mjs";
import { auditGstackRuntimeDependencies } from "./runtime-dependency-audit.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const blob = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const target = { platform: "darwin", arch: "arm64" };
const lock = JSON.parse(await readFile(new URL("./upstream-lock.json", import.meta.url), "utf8"));
const notice = await readFile(new URL("../../LICENSE", import.meta.url));
const iscNotice = Buffer.from(`ISC License

Copyright (c) 2026 Fixture Authors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
`);
const names = ["LICENSE.ling-upstream", "ling-upstream-license-provenance.json"];

async function fixture(t, packagePaths = ["node_modules/helper", "node_modules/parent/node_modules/helper"]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-gstack-notices-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = join(root, "runtime");
  await mkdir(runtime);
  const metadata = Buffer.from(JSON.stringify({ name: "helper", version: "1.0.0", license: "MIT" }));
  for (const path of packagePaths) {
    await mkdir(join(runtime, path), { recursive: true });
    await writeFile(join(runtime, path, "package.json"), metadata);
  }
  const catalog = { schemaVersion: 1, reviewStatus: "reviewed-notice-texts", releaseEligible: false,
    upstreamRevision: lock.revision, upstreamVersion: lock.version,
    entries: [{ name: "helper", version: "1.0.0", license: "MIT", installedMetadataChecksums: [checksum(metadata)],
      registry: { url: "https://registry.npmjs.org/helper/1.0.0", checksum: checksum("registry fixture"),
        gitHead: "a".repeat(40), repository: { url: "git+https://github.com/fixture/helper.git" }, integrity: "sha512:fixture" },
      source: { repository: "fixture/helper", revision: "a".repeat(40), path: "LICENSE", gitBlob: blob(notice),
        checksum: checksum(notice), contentBase64: notice.toString("base64") } }] };
  const catalogPath = join(root, "reviewed.json");
  const bytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);
  await writeFile(catalogPath, bytes);
  return { root, runtime, metadata, packagePaths, catalog, catalogPath,
    options: { runtimeRoot: runtime, target, catalogPath, expectedCatalogChecksum: checksum(bytes) } };
}

async function replaceCatalog(f, mutate) {
  mutate(f.catalog);
  const bytes = Buffer.from(`${JSON.stringify(f.catalog, null, 2)}\n`);
  await writeFile(f.catalogPath, bytes);
  f.options.expectedCatalogChecksum = checksum(bytes);
}

async function assertNoInstallation(f) {
  for (const path of f.packagePaths) for (const name of names) {
    await assert.rejects(readFile(join(f.runtime, path, name)), { code: "ENOENT" });
  }
  assert.equal((await readdir(f.runtime)).includes(".ling-notice-install-lock"), false);
}

async function iscFixture(t) {
  const f = await fixture(t);
  f.metadata = Buffer.from(JSON.stringify({ name: "helper", version: "1.0.0", license: "ISC" }));
  for (const path of f.packagePaths) await writeFile(join(f.runtime, path, "package.json"), f.metadata);
  await replaceCatalog(f, catalog => {
    const entry = catalog.entries[0];
    entry.license = "ISC";
    entry.installedMetadataChecksums = [checksum(f.metadata)];
    Object.assign(entry.source, { checksum: checksum(iscNotice), gitBlob: blob(iscNotice),
      contentBase64: iscNotice.toString("base64") });
  });
  return f;
}

test("reviewed ISC grants install byte-for-byte offline at every exact location and are idempotent", async t => {
  const f = await iscFixture(t);
  const result = await installReviewedGstackNotices(f.options);
  assert.deepEqual(result.installed, f.packagePaths);
  assert.equal(result.releaseEligible, false);
  for (const path of f.packagePaths) {
    assert.deepEqual(await readFile(join(f.runtime, path, "package.json")), f.metadata);
    assert.deepEqual(await readFile(join(f.runtime, path, names[0])), iscNotice);
    const provenance = JSON.parse(await readFile(join(f.runtime, path, names[1]), "utf8"));
    assert.equal(provenance.package.license, "ISC");
    assert.equal(provenance.reviewScope, "notice-text-only");
  }
  assert.deepEqual((await installReviewedGstackNotices(f.options)).alreadyInstalled, f.packagePaths);
  const audit = await auditGstackRuntimeDependencies({ runtimeRoot: f.runtime, target });
  assert.equal(audit.blockers.length, 0);
});

test("ISC headers, truncated grants, missing disclaimers, MIT text and mixed terms fail before writes", async t => {
  for (const bytes of [
    Buffer.from("ISC License\nCopyright (c) 2026 Fixture Authors\n"),
    Buffer.from(iscNotice.toString().replace("copyright notice and this permission notice appear in all copies.", "")),
    Buffer.from(iscNotice.toString().split("THE SOFTWARE IS PROVIDED")[0]),
    Buffer.from(iscNotice.toString().split("IN NO EVENT")[0]),
    notice,
    Buffer.concat([iscNotice, Buffer.from("\nGNU LESSER GENERAL PUBLIC LICENSE\n")]),
  ]) {
    const f = await iscFixture(t);
    await replaceCatalog(f, catalog => {
      Object.assign(catalog.entries[0].source, { checksum: checksum(bytes), gitBlob: blob(bytes),
        contentBase64: bytes.toString("base64") });
    });
    await assert.rejects(installReviewedGstackNotices(f.options), /gstack_notice_source_invalid/);
    await assertNoInstallation(f);
  }
});

test("reviewed ISC text cannot replace a package whose exact metadata still declares MIT", async t => {
  const f = await iscFixture(t);
  const original = Buffer.from(JSON.stringify({ name: "helper", version: "1.0.0", license: "MIT" }));
  await writeFile(join(f.runtime, f.packagePaths[1], "package.json"), original);
  await assert.rejects(installReviewedGstackNotices(f.options), /gstack_notice_package_metadata_mismatch/);
  await assertNoInstallation(f);
});

async function sourceMatchFixture(t) {
  const f = await fixture(t);
  const source = Buffer.from("export const reviewed = 1;\n");
  const sourcePath = "packages/helper/src/index.ts";
  const map = Buffer.from(JSON.stringify({ version: 3, sourceRoot: "", sources: [sourcePath],
    sourcesContent: [source.toString()], names: [], mappings: "" }));
  const files = new Map([["package.json", f.metadata], ["README.md", Buffer.from("Original package README\n")],
    ["dist/index.js", source], ["dist/index.module.js", source], ["dist/index.d.ts", Buffer.from("export declare const reviewed: number;\n")],
    ["dist/index.js.map", map], ["dist/index.module.js.map", map]]);
  for (const path of f.packagePaths) {
    await mkdir(join(f.runtime, path, "dist"));
    for (const [name, bytes] of files) await writeFile(join(f.runtime, path, name), bytes);
  }
  await replaceCatalog(f, c => {
    const entry = c.entries[0];
    entry.registry.gitHead = null;
    entry.registry.integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
    const commit = Buffer.from(JSON.stringify({ sha: entry.source.revision, tree: { sha: "b".repeat(40) } }));
    entry.source.revisionProof = { kind: "installed-source-map-match", repository: entry.source.repository,
      revision: entry.source.revision, packagePath: "packages/helper/package.json", packageChecksum: checksum(f.metadata),
      packageGitBlob: blob(f.metadata), packageContentBase64: f.metadata.toString("base64"),
      sourceTreeHash: "b".repeat(40), treeChecksum: checksum("reviewed tree"),
      commitChecksum: checksum(commit), commitContentBase64: commit.toString("base64"),
      tarball: { url: "https://registry.npmjs.org/helper/-/helper-1.0.0.tgz", integrity: entry.registry.integrity,
        checksum: checksum("verified archive"), sizeBytes: 512 },
      installedFiles: [...files].map(([path, bytes]) => ({ path, checksum: checksum(bytes), sizeBytes: bytes.length })),
      sourceMaps: ["dist/index.js.map", "dist/index.module.js.map"].map(path => ({ path, checksum: checksum(map),
        sources: [{ path: sourcePath, checksum: checksum(source), gitBlob: blob(source), sizeBytes: source.length }] })) };
  });
  return { ...f, files };
}

async function onnxDevFixture(t) {
  const f = await fixture(t);
  const name = "onnxruntime-common", version = "1.24.0-dev.20251116-b39e144322";
  const revision = "b39e14432259d5f579f34c3e338f1f70aa368f01";
  f.metadata = Buffer.from(JSON.stringify({ name, version, license: "MIT" }));
  const files = new Map([["package.json", f.metadata], ["__commit.txt", Buffer.from(revision)],
    ["lib/version.ts", Buffer.from(`export const version = '${version}';\n`)],
    ["dist/esm/index.js", Buffer.from("export const reviewed = 1;\n")]]);
  for (const path of f.packagePaths) for (const [name, bytes] of files) {
    await mkdir(dirname(join(f.runtime, path, name)), { recursive: true });
    await writeFile(join(f.runtime, path, name), bytes);
  }
  await replaceCatalog(f, c => {
    const entry = c.entries[0];
    Object.assign(entry, { name, version, installedMetadataChecksums: [checksum(f.metadata)] });
    Object.assign(entry.registry, { url: `https://registry.npmjs.org/${name}/${version}`, gitHead: null,
      repository: { url: "https://github.com/Microsoft/onnxruntime.git" }, integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}` });
    Object.assign(entry.source, { repository: "Microsoft/onnxruntime", revision });
    const source = Buffer.from(JSON.stringify({ name, version: "1.24.0", license: "MIT" }));
    const versionNumber = Buffer.from("1.24.0\n");
    const record = bytes => ({ checksum: checksum(bytes), gitBlob: blob(bytes), contentBase64: bytes.toString("base64") });
    const commit = Buffer.from(JSON.stringify({ sha: revision, tree: { sha: "c".repeat(40) }, committer: { date: "2025-11-16T20:50:06Z" } }));
    entry.source.revisionProof = { kind: "installed-onnx-dev-commit-match", repository: entry.source.repository, revision,
      packagePath: "js/common/package.json", package: record(source), versionNumber: { path: "VERSION_NUMBER", ...record(versionNumber) },
      commitChecksum: checksum(commit), commitContentBase64: commit.toString("base64"), markerContentBase64: Buffer.from(revision).toString("base64"),
      tarball: { url: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, integrity: entry.registry.integrity,
        checksum: checksum("verified archive"), sizeBytes: 512 },
      installedFiles: [...files].map(([path, bytes]) => ({ path, checksum: checksum(bytes), sizeBytes: bytes.length })) };
  });
  return { ...f, files };
}

test("ONNX dev notices install offline with full-commit artifact proofs and revalidate on repeat", async t => {
  const f = await onnxDevFixture(t);
  const result = await installReviewedGstackNotices(f.options);
  assert.deepEqual(result.installed, f.packagePaths);
  for (const path of f.packagePaths) for (const [name, bytes] of f.files) {
    assert.deepEqual(await readFile(join(f.runtime, path, name)), bytes);
  }
  const repeated = await installReviewedGstackNotices(f.options);
  assert.deepEqual(repeated.alreadyInstalled, f.packagePaths);
  await writeFile(join(f.runtime, f.packagePaths[1], "__commit.txt"), "d".repeat(40));
  await assert.rejects(installReviewedGstackNotices(f.options), /gstack_notice_onnx_artifact_mismatch/);
  for (const path of f.packagePaths) assert.deepEqual(await readFile(join(f.runtime, path, names[0])), notice);
});

test("ONNX compiled resources and complete inventory are preflighted at all package locations", async t => {
  for (const change of ["compiled", "marker", "extra", "missing", "link"]) {
    const f = await onnxDevFixture(t);
    const path = join(f.runtime, f.packagePaths[1]);
    if (change === "compiled") await writeFile(join(path, "dist/esm/index.js"), "changed compiled code");
    if (change === "marker") await writeFile(join(path, "__commit.txt"), "d".repeat(40));
    if (change === "extra") await writeFile(join(path, "extra.wasm"), "extra");
    if (change === "missing") await rm(join(path, "lib/version.ts"));
    if (change === "link") {
      await rm(join(path, "dist/esm/index.js"));
      await symlink(join(f.root, "owner.js"), join(path, "dist/esm/index.js"));
    }
    await assert.rejects(installReviewedGstackNotices(f.options), /gstack_notice_(?:onnx_artifact|unsafe_resource)/, change);
    await assertNoInstallation(f);
  }
});

test("ONNX resources changed after preflight fail and preserve owner changes during rollback", async t => {
  const f = await onnxDevFixture(t);
  const path = join(f.runtime, f.packagePaths[1], "dist/esm/index.js");
  await assert.rejects(installReviewedGstackNotices({ ...f.options, onProgress: async ({ path: packagePath }) => {
    if (packagePath === f.packagePaths[1]) await writeFile(path, "owner changed code");
  } }), /gstack_notice_onnx_artifact_mismatch/);
  await assertNoInstallation(f);
  assert.equal(await readFile(path, "utf8"), "owner changed code");
});

test("offline source matches preflight complete package artifacts at every location and remain idempotent", async t => {
  const f = await sourceMatchFixture(t);
  const result = await installReviewedGstackNotices(f.options);
  assert.deepEqual(result.installed, f.packagePaths);
  for (const path of f.packagePaths) {
    for (const [name, bytes] of f.files) assert.deepEqual(await readFile(join(f.runtime, path, name)), bytes);
    const provenance = JSON.parse(await readFile(join(f.runtime, path, names[1]), "utf8"));
    assert.equal(provenance.source.revisionProof.kind, "installed-source-map-match");
    assert.equal(provenance.source.revisionProof.installedFiles.length, 7);
  }
  const repeated = await installReviewedGstackNotices(f.options);
  assert.deepEqual(repeated.alreadyInstalled, result.installed);
  assert.equal(repeated.installed.length, 0);
});

test("changed compiled code, missing or extra artifacts and linked resources fail before any notice writes", async t => {
  for (const change of ["javascript", "module", "declaration", "map", "missing", "extra", "link"]) {
    const f = await sourceMatchFixture(t);
    const path = join(f.runtime, f.packagePaths[1]);
    if (change === "javascript") await writeFile(join(path, "dist/index.js"), "unreviewed JS");
    if (change === "module") await writeFile(join(path, "dist/index.module.js"), "unreviewed ESM");
    if (change === "declaration") await writeFile(join(path, "dist/index.d.ts"), "unreviewed declaration");
    if (change === "map") await writeFile(join(path, "dist/index.js.map"), "{}");
    if (change === "missing") await rm(join(path, "README.md"));
    if (change === "extra") await writeFile(join(path, "unreviewed.js"), "extra artifact");
    if (change === "link") {
      const outside = join(f.root, "owner-source");
      await writeFile(outside, "keep owner source");
      await rm(join(path, "dist/index.js"));
      await symlink(outside, join(path, "dist/index.js"));
    }
    await assert.rejects(installReviewedGstackNotices(f.options), /gstack_notice_(?:source_map|unsafe_resource)/, change);
    await assertNoInstallation(f);
    if (change === "link") assert.equal(await readFile(join(f.root, "owner-source"), "utf8"), "keep owner source");
  }
});

test("actual source map content must match reviewed Git blobs even when the artifact checksum is refreshed", async t => {
  const f = await sourceMatchFixture(t);
  const path = "dist/index.js.map";
  const map = JSON.parse(f.files.get(path).toString());
  map.sourcesContent[0] = "export const unreviewed = 2;\n";
  const bytes = Buffer.from(JSON.stringify(map));
  for (const pkg of f.packagePaths) await writeFile(join(f.runtime, pkg, path), bytes);
  await replaceCatalog(f, c => {
    const proof = c.entries[0].source.revisionProof;
    Object.assign(proof.installedFiles.find(file => file.path === path), { checksum: checksum(bytes), sizeBytes: bytes.length });
    proof.sourceMaps.find(file => file.path === path).checksum = checksum(bytes);
  });
  await assert.rejects(installReviewedGstackNotices(f.options), /gstack_notice_source_map_artifact_mismatch/);
  await assertNoInstallation(f);
});

test("code changed after preflight is detected and only this attempt's earlier notice writes are rolled back", async t => {
  const f = await sourceMatchFixture(t);
  const changed = join(f.runtime, f.packagePaths[1], "dist/index.js");
  await assert.rejects(installReviewedGstackNotices({ ...f.options, onProgress: async ({ path }) => {
    if (path === f.packagePaths[1]) await writeFile(changed, "owner changed compiled code");
  } }), /gstack_notice_source_map_artifact_mismatch/);
  await assertNoInstallation(f);
  assert.equal(await readFile(changed, "utf8"), "owner changed compiled code");
});

test("repeat installation revalidates artifacts without removing earlier owned notices on failure", async t => {
  const f = await sourceMatchFixture(t);
  await installReviewedGstackNotices(f.options);
  await writeFile(join(f.runtime, f.packagePaths[1], "dist/index.module.js"), "changed later");
  await assert.rejects(installReviewedGstackNotices(f.options), /gstack_notice_source_map_artifact_mismatch/);
  for (const path of f.packagePaths) assert.deepEqual(await readFile(join(f.runtime, path, names[0])), notice);
});

test("reviewed notices install offline at every exact package location without changing metadata", async t => {
  const f = await fixture(t);
  const result = await installReviewedGstackNotices(f.options);
  assert.equal(result.releaseEligible, false);
  assert.equal(result.installed.length, 2);
  for (const path of f.packagePaths) {
    assert.deepEqual(await readFile(join(f.runtime, path, "package.json")), f.metadata);
    assert.deepEqual(await readFile(join(f.runtime, path, names[0])), notice);
    const provenance = JSON.parse(await readFile(join(f.runtime, path, names[1]), "utf8"));
    assert.equal(provenance.reviewScope, "notice-text-only");
    assert.equal(provenance.catalogChecksum, f.options.expectedCatalogChecksum);
    assert.equal(provenance.package.path, path);
    assert.equal(provenance.source.revision, "a".repeat(40));
    assert.equal(provenance.source.checksum, checksum(notice));
  }
  const repeated = await installReviewedGstackNotices(f.options);
  assert.equal(repeated.installed.length, 0);
  assert.deepEqual(repeated.alreadyInstalled, result.installed);
  const audit = await auditGstackRuntimeDependencies({ runtimeRoot: f.runtime, target });
  assert.equal(audit.blockers.filter(b => b.code === "dependency_notice_missing").length, 0);
  assert.equal(audit.packages.every(p => p.noticePaths.length === 1 && p.noticePaths[0].endsWith(names[0])), true);
});

test("source text, Git blob, catalog hash and package identity are checked before any installation", async t => {
  for (const mutation of [
    c => { c.entries[0].source.contentBase64 = Buffer.from("MIT header only").toString("base64"); },
    c => { c.entries[0].source.gitBlob = "b".repeat(40); },
    c => { c.entries[0].source.revision = "b".repeat(40); },
    c => { c.entries[0].registry.url = "https://registry.npmjs.org/wrong/1.0.0"; },
    c => { c.entries.push(c.entries[0]); },
  ]) {
    const f = await fixture(t);
    await replaceCatalog(f, mutation);
    await assert.rejects(installReviewedGstackNotices(f.options), /gstack_notice_/);
    await assertNoInstallation(f);
  }
  const f = await fixture(t);
  f.options.expectedCatalogChecksum = checksum("wrong catalog");
  await assert.rejects(installReviewedGstackNotices(f.options), /gstack_notice_catalog_checksum_mismatch/);
  await assertNoInstallation(f);
});

test("all metadata is preflighted so a later corrupt package cannot leave a partial installation", async t => {
  const f = await fixture(t);
  await writeFile(join(f.runtime, f.packagePaths[1], "package.json"), JSON.stringify({ name: "helper", version: "1.0.0", license: "MIT", tampered: true }));
  await assert.rejects(installReviewedGstackNotices(f.options), /gstack_notice_package_metadata_mismatch/);
  await assertNoInstallation(f);
});

test("unreviewed packages and pre-existing notices are preserved without filling from a different version", async t => {
  const f = await fixture(t, ["node_modules/helper"]);
  await writeFile(join(f.runtime, f.packagePaths[0], "LICENSE"), "existing owner notice");
  await mkdir(join(f.runtime, "node_modules/older"));
  await writeFile(join(f.runtime, "node_modules/older/package.json"), JSON.stringify({ name: "helper", version: "0.9.0", license: "MIT" }));
  const result = await installReviewedGstackNotices(f.options);
  assert.equal(result.installed.length, 0);
  assert.deepEqual(result.preservedExistingNotices, ["node_modules/helper"]);
  assert.equal(await readFile(join(f.runtime, f.packagePaths[0], "LICENSE"), "utf8"), "existing owner notice");
  await assertNoInstallation(f);
  const audit = await auditGstackRuntimeDependencies({ runtimeRoot: f.runtime, target });
  assert.deepEqual(audit.blockers.filter(b => b.code === "dependency_notice_missing").map(b => b.path), ["node_modules/older"]);
});

test("copyleft, mixed license prose, empty grants and candidate sources cannot become reviewed MIT notices", async t => {
  for (const mutation of [
    c => { c.reviewStatus = "candidate-only"; },
    c => { c.entries[0].license = "LGPL-3.0-or-later"; },
    c => { c.releaseEligible = true; },
    c => { c.upstreamRevision = "b".repeat(40); },
    c => { const bytes = Buffer.from("Bun itself is MIT-licensed. GNU LESSER GENERAL PUBLIC LICENSE");
      Object.assign(c.entries[0].source, { checksum: checksum(bytes), gitBlob: blob(bytes), contentBase64: bytes.toString("base64") }); },
  ]) {
    const f = await fixture(t);
    await replaceCatalog(f, mutation);
    await assert.rejects(installReviewedGstackNotices(f.options), /gstack_notice_/);
    await assertNoInstallation(f);
  }
});

test("pre-existing generated files, including forged provenance, are never overwritten", async t => {
  for (const name of names) {
    const f = await fixture(t, ["node_modules/helper"]);
    await writeFile(join(f.runtime, f.packagePaths[0], name), "keep owner file");
    await assert.rejects(installReviewedGstackNotices(f.options), /gstack_notice_existing_installation_mismatch/);
    assert.equal(await readFile(join(f.runtime, f.packagePaths[0], name), "utf8"), "keep owner file");
  }
  const f = await fixture(t);
  await installReviewedGstackNotices(f.options);
  await writeFile(join(f.runtime, f.packagePaths[1], names[1]), "forged provenance");
  await assert.rejects(installReviewedGstackNotices(f.options), /gstack_notice_existing_installation_mismatch/);
  assert.equal(await readFile(join(f.runtime, f.packagePaths[1], names[1]), "utf8"), "forged provenance");
});

test("symbolic links, escaping package paths and a concurrent installation lock reject without touching outside data", async t => {
  const f = await fixture(t, ["node_modules/helper"]);
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "package.json"), f.metadata);
  await symlink(outside, join(f.runtime, "node_modules/escape"), "junction");
  await assert.rejects(installReviewedGstackNotices(f.options), /gstack_notice_unsafe_resource_links/);
  assert.deepEqual(await readdir(outside), ["package.json"]);
  await rm(join(f.runtime, "node_modules/escape"));
  await mkdir(join(f.runtime, ".ling-notice-install-lock"));
  await assert.rejects(installReviewedGstackNotices(f.options), /gstack_notice_install_busy/);
  await rm(join(f.runtime, ".ling-notice-install-lock"), { recursive: true });
  await assertNoInstallation(f);
  const alias = join(f.root, "alias");
  await symlink(f.runtime, alias, "junction");
  await assert.rejects(installReviewedGstackNotices({ ...f.options, runtimeRoot: alias }), /gstack_notice_runtime_root_invalid/);
});

test("an executable delivery cannot be modified as unpublished notice staging", async t => {
  const f = await fixture(t);
  await writeFile(join(dirname(f.runtime), "manifest.json"), "published manifest");
  await assert.rejects(installReviewedGstackNotices(f.options), /gstack_notice_stage_already_executable/);
  await assertNoInstallation(f);
});

test("a mid-install failure rolls back only files created by this attempt and preserves a competing owner file", async t => {
  const f = await fixture(t);
  const competing = join(f.runtime, f.packagePaths[1], names[0]);
  await assert.rejects(installReviewedGstackNotices({ ...f.options, onProgress: async ({ path }) => {
    if (path === f.packagePaths[1]) await writeFile(competing, "competing owner", { flag: "wx" });
  } }), { code: "EEXIST" });
  for (const name of names) await assert.rejects(readFile(join(f.runtime, f.packagePaths[0], name)), { code: "ENOENT" });
  assert.equal(await readFile(competing, "utf8"), "competing owner");
  await assert.rejects(readFile(join(f.runtime, f.packagePaths[1], names[1])), { code: "ENOENT" });
  assert.equal((await readdir(f.runtime)).includes(".ling-notice-install-lock"), false);
});

test("metadata changed after preflight is detected and earlier writes are rolled back without reverting the changed metadata", async t => {
  const f = await fixture(t);
  const changed = `${f.metadata.toString()}\n`;
  await assert.rejects(installReviewedGstackNotices({ ...f.options, onProgress: async ({ path }) => {
    if (path === f.packagePaths[1]) await writeFile(join(f.runtime, path, "package.json"), changed);
  } }), /gstack_notice_package_metadata_changed/);
  await assertNoInstallation(f);
  assert.equal(await readFile(join(f.runtime, f.packagePaths[1], "package.json"), "utf8"), changed);
});

test("reviewed README byte ranges preserve original copyright and grant text with parent-source provenance", async t => {
  const f = await fixture(t);
  const sourceBytes = Buffer.concat([Buffer.from("# README\r\nIntroduction\r\n\r\n"), notice]);
  const startByte = sourceBytes.length - notice.length;
  await replaceCatalog(f, c => {
    Object.assign(c.entries[0].source, { path: "README.md", contentBase64: sourceBytes.toString("base64"), checksum: checksum(sourceBytes), gitBlob: blob(sourceBytes) });
    c.entries[0].notice = { method: "verbatim-byte-range", startByte, endByte: sourceBytes.length, checksum: checksum(notice) };
  });
  await installReviewedGstackNotices(f.options);
  assert.deepEqual(await readFile(join(f.runtime, f.packagePaths[0], names[0])), notice);
  const provenance = JSON.parse(await readFile(join(f.runtime, f.packagePaths[0], names[1]), "utf8"));
  assert.equal(provenance.source.checksum, checksum(sourceBytes));
  assert.equal(provenance.notice.checksum, checksum(notice));
  assert.equal(provenance.notice.startByte, startByte);
});

test("offline exact-tag proof supports missing gitHead without permitting a wrong release identity", async t => {
  const f = await fixture(t);
  await replaceCatalog(f, c => {
    const entry = c.entries[0];
    entry.registry.gitHead = null;
    const refBytes = Buffer.from(JSON.stringify({ ref: "refs/tags/v1.0.0", object: { type: "commit", sha: entry.source.revision } }));
    entry.source.revisionProof = { kind: "exact-version-tag", repository: entry.source.repository, revision: entry.source.revision, tag: "v1.0.0",
      refChecksum: checksum(refBytes), refContentBase64: refBytes.toString("base64"), packagePath: "src/package.json",
      packageGitBlob: blob(f.metadata), packageChecksum: checksum(f.metadata), packageContentBase64: f.metadata.toString("base64") };
  });
  assert.equal((await installReviewedGstackNotices(f.options)).installed.length, 2);
  const other = await fixture(t);
  await replaceCatalog(other, c => { c.entries[0].registry.gitHead = null; c.entries[0].source.revisionProof = f.catalog.entries[0].source.revisionProof;
    c.entries[0].source.revisionProof.tag = "v2.0.0"; });
  await assert.rejects(installReviewedGstackNotices(other.options), /gstack_notice_release_proof_invalid/);
  await assertNoInstallation(other);
});

test("offline bare-version proof can install an unchanged reviewed README grant with its parent provenance", async t => {
  const f = await fixture(t);
  const prefix = Buffer.from("# README\n\n## License\n\n");
  const source = Buffer.concat([prefix, notice]);
  await replaceCatalog(f, c => {
    const entry = c.entries[0];
    entry.registry.gitHead = null;
    const refBytes = Buffer.from(JSON.stringify({ ref: "refs/tags/1.0.0", object: { type: "commit", sha: entry.source.revision } }));
    Object.assign(entry.source, { path: "README.md", checksum: checksum(source), gitBlob: blob(source), contentBase64: source.toString("base64"),
      revisionProof: { kind: "exact-version-tag", repository: entry.source.repository, revision: entry.source.revision, tag: "1.0.0",
        refChecksum: checksum(refBytes), refContentBase64: refBytes.toString("base64"), packagePath: "package.json",
        packageChecksum: checksum(f.metadata), packageGitBlob: blob(f.metadata), packageContentBase64: f.metadata.toString("base64") } });
    entry.notice = { method: "verbatim-byte-range", startByte: prefix.length, endByte: source.length, checksum: checksum(notice) };
  });
  assert.equal((await installReviewedGstackNotices(f.options)).installed.length, 2);
  for (const path of f.packagePaths) {
    assert.deepEqual(await readFile(join(f.runtime, path, names[0])), notice);
    const provenance = JSON.parse(await readFile(join(f.runtime, path, names[1]), "utf8"));
    assert.equal(provenance.source.revisionProof.tag, "1.0.0");
    assert.equal(provenance.source.checksum, checksum(source));
    assert.equal(provenance.notice.checksum, checksum(notice));
  }
});

test("altered or out-of-bounds README selection is rejected before installation", async t => {
  for (const selection of [
    { method: "verbatim-byte-range", startByte: -1, endByte: notice.length, checksum: checksum(notice) },
    { method: "verbatim-byte-range", startByte: 0, endByte: notice.length + 1, checksum: checksum(notice) },
    { method: "verbatim-byte-range", startByte: 0, endByte: notice.length, checksum: checksum("wrong") },
  ]) {
    const f = await fixture(t);
    await replaceCatalog(f, c => { c.entries[0].notice = selection; });
    await assert.rejects(installReviewedGstackNotices(f.options), /gstack_notice_selection_invalid/);
    await assertNoInstallation(f);
  }
});

test("the frozen real catalog keeps reviewed notice scope separate from native redistribution approval", async () => {
  const bytes = await readFile(new URL("./reviewed-third-party-notices.json", import.meta.url));
  assert.equal(checksum(bytes), REVIEWED_GSTACK_NOTICE_CATALOG_CHECKSUM);
  const catalog = JSON.parse(bytes.toString("utf8"));
  assert.equal(catalog.entries.length, 44);
  assert.equal(catalog.releaseEligible, false);
  assert.equal(catalog.entries.some(e => e.name === "bun-types" || e.name.startsWith("@img/")), false);
  assert.equal(catalog.entries.every(e => e.license === "MIT" && (e.registry.gitHead
    ? e.source.revision === e.registry.gitHead : ["exact-version-tag", "installed-source-map-match", "installed-onnx-dev-commit-match"].includes(e.source.revisionProof?.kind))), true);
  assert.equal(catalog.entries.filter(e => e.source.revisionProof?.kind === "exact-version-tag").length, 4);
  const sourceMatches = catalog.entries.filter(e => e.source.revisionProof?.kind === "installed-source-map-match");
  assert.equal(sourceMatches.length, 14);
  assert.equal(sourceMatches.every(e => e.source.revision === "21a7c97dc8efa79fecca36428eec49f187294085" &&
    e.source.revisionProof.sourceTreeHash === "fd3ea0b0cb76cae4b525a764cbdf1a93c7ff86b0" &&
    e.source.revisionProof.installedFiles.length === 8 &&
    e.source.revisionProof.sourceMaps.length === 2), true);
  assert.equal(catalog.entries.filter(e => e.notice?.method === "verbatim-byte-range").length, 2);
  const dev = catalog.entries.filter(e => e.source.revisionProof?.kind === "installed-onnx-dev-commit-match");
  assert.equal(dev.length, 2);
  for (const entry of dev) {
    const proof = entry.source.revisionProof;
    assert.equal(Buffer.from(proof.markerContentBase64, "base64").toString(), proof.revision);
    assert.equal(proof.installedFiles.length, entry.name === "onnxruntime-web" ? 508 : 194);
    assert.equal(entry.source.checksum, "sha256:2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c");
  }
  const browser = catalog.entries.find(e => e.name === "browser-split");
  assert.equal(browser.source.revisionProof.tag, "0.0.1");
  assert.equal(browser.source.revision, "c54802648e908f6b1e3e0ed5b8b9448aa7b0f0fb");
  assert.deepEqual(browser.notice, { method: "verbatim-byte-range", startByte: 1336, endByte: 2490,
    checksum: "sha256:0a070eddda71cf7ec3706e9ab7779881bf97c7ecd739a776339c44a73bf7bd48" });
  const browserText = Buffer.from(browser.source.contentBase64, "base64").subarray(browser.notice.startByte, browser.notice.endByte).toString();
  assert.match(browserText, /Copyright \(c\) 2013 Julian Gruber &lt;julian@juliangruber.com&gt;/);
  assert.match(browserText, /Copyright 2007-2012 Steven Levithan &lt;stevenlevithan.com&gt;/);
});
