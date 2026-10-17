import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectLegacyRadixNoticeSources, LEGACY_RADIX_NOTICE_REVISION } from "./collect-legacy-radix-notice-sources.mjs";
import { verifyInstalledSourceMapNoticeProof } from "./notice-source-provenance.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const blob = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const notice = await readFile(new URL("../../LICENSE", import.meta.url));
const githubFile = bytes => ({ type: "file", encoding: "base64", content: bytes.toString("base64"), sha: blob(bytes) });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ling-radix-source-notice-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, "runtime");
  const path = "lib/diagram-render/node_modules/@radix-ui/react-tabs";
  const packageRoot = join(runtimeRoot, path);
  const metadata = Buffer.from(JSON.stringify({ name: "@radix-ui/react-tabs", version: "1.0.2", license: "MIT" }));
  const source = Buffer.from("export const fixture = 1;\n");
  const sourcePath = "packages/react/tabs/src/index.ts";
  const map = Buffer.from(JSON.stringify({ version: 3, sourceRoot: "", sources: [sourcePath], sourcesContent: [source.toString()], names: [], mappings: "" }));
  const files = new Map([["package.json", metadata], ["README.md", Buffer.from("Fixture README\n")],
    ["dist/index.js", source], ["dist/index.module.js", source], ["dist/index.d.ts", Buffer.from("export declare const fixture: number;\n")],
    ["dist/index.js.map", map], ["dist/index.module.js.map", map]]);
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  for (const [name, bytes] of files) await writeFile(join(packageRoot, name), bytes);
  const archiveRoot = join(root, "archive");
  await mkdir(archiveRoot);
  await cp(packageRoot, join(archiveRoot, "package"), { recursive: true });
  const tarPath = join(root, "source.tgz");
  execFileSync("tar", ["-czf", tarPath, "package"], { cwd: archiveRoot, stdio: "pipe" });
  const tarball = await readFile(tarPath);
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const npmMetadata = { name: "@radix-ui/react-tabs", version: "1.0.2", license: "MIT",
    repository: { url: "git+https://github.com/radix-ui/primitives.git" },
    dist: { tarball: "https://registry.npmjs.org/@radix-ui/react-tabs/-/react-tabs-1.0.2.tgz", integrity } };
  const registry = { url: "https://registry.npmjs.org/%40radix-ui%2Freact-tabs/1.0.2", checksum: checksum(JSON.stringify(npmMetadata)),
    gitHead: null, repository: npmMetadata.repository, integrity };
  const pkg = { name: npmMetadata.name, version: npmMetadata.version, path, license: "MIT", metadataChecksum: checksum(metadata) };
  const audit = { schemaVersion: 1, packages: [pkg], blockers: [{ code: "dependency_notice_missing", path }] };
  const auditPath = join(root, "audit.json");
  await writeFile(auditPath, JSON.stringify(audit));
  const tree = { sha: "b".repeat(40), truncated: false, tree: [
    { path: "packages/react/tabs/package.json", mode: "100644", type: "blob", sha: blob(metadata), size: metadata.length },
    { path: sourcePath, mode: "100644", type: "blob", sha: blob(source), size: source.length },
    { path: "LICENSE", mode: "100644", type: "blob", sha: blob(notice), size: notice.length },
  ] };
  const commit = { sha: LEGACY_RADIX_NOTICE_REVISION, tree: { sha: tree.sha } };
  const githubReader = async path => {
    assert.equal(path.includes("main"), false);
    assert.equal(path.includes(LEGACY_RADIX_NOTICE_REVISION) || path.includes(tree.sha), true);
    if (path.includes("/git/commits/")) return commit;
    if (path.includes("/git/trees/")) return tree;
    if (path.includes("/LICENSE?")) return githubFile(notice);
    if (path.includes("/package.json?")) return githubFile(metadata);
    throw new Error(`Unexpected source request: ${path}`);
  };
  const options = { runtimeRoot, auditPath, outputPath: join(root, "candidates.json"), githubReader,
    registryReader: async () => ({ metadata: npmMetadata, registry }), tarballReader: async () => tarball };
  return { root, options, audit, auditPath, packageRoot, files, tree, commit, metadata, npmMetadata, registry, tarball };
}

test("source candidate collection checks the real archive, every installed file and historical source-map blobs", async t => {
  const f = await fixture(t);
  const result = await collectLegacyRadixNoticeSources(f.options);
  assert.equal(result.reviewStatus, "candidate-only");
  assert.equal(result.releaseEligible, false);
  assert.equal(result.entries.length, 1);
  const entry = result.entries[0];
  assert.equal(entry.status, "candidate", entry.reason);
  assert.equal(entry.source.revision, LEGACY_RADIX_NOTICE_REVISION);
  assert.equal(entry.source.revisionProof.installedFiles.length, 7);
  verifyInstalledSourceMapNoticeProof({ proof: entry.source.revisionProof, repository: "radix-ui/primitives",
    revision: LEGACY_RADIX_NOTICE_REVISION, name: entry.name, version: entry.version, license: entry.license, registryIntegrity: entry.registry.integrity });
  for (const [path, bytes] of f.files) assert.deepEqual(await readFile(join(f.packageRoot, path)), bytes);
  assert.equal((await readdir(f.packageRoot)).some(name => name.startsWith("LICENSE")), false);
});

test("changed npm artifacts and mismatched archive integrity remain unresolved without changing the installed package", async t => {
  for (const changed of ["artifact", "archive"]) {
    const f = await fixture(t);
    if (changed === "artifact") await writeFile(join(f.packageRoot, "dist/index.js"), "unreviewed compiled code");
    else f.options.tarballReader = async () => Buffer.from("wrong archive");
    const result = await collectLegacyRadixNoticeSources(f.options);
    assert.equal(result.entries[0].status, "unresolved");
    assert.match(result.entries[0].reason, /radix_notice_.*mismatch/);
    assert.equal(result.entries[0].source, undefined);
  }
});

test("a matching version string is insufficient when package identity or a source-map Git blob differs", async t => {
  for (const changed of ["version", "source", "tree", "commit"]) {
    const f = await fixture(t);
    if (changed === "source") f.tree.tree[1].sha = "c".repeat(40);
    if (changed === "tree") f.tree.truncated = true;
    if (changed === "commit") f.commit.sha = "c".repeat(40);
    if (changed === "version") f.options.githubReader = async path => {
      if (path.includes("/package.json?")) return githubFile(Buffer.from(JSON.stringify({ name: f.npmMetadata.name, version: "1.0.3", license: "MIT" })));
      return path.includes("/git/trees/") ? f.tree : path.includes("/git/commits/") ? f.commit : githubFile(notice);
    };
    const result = await collectLegacyRadixNoticeSources(f.options);
    assert.equal(result.entries[0].status, "unresolved");
    assert.match(result.entries[0].reason, /radix_notice_|notice_source_/);
  }
});

test("notice source collection never follows package links or writes investigative output into runtime resources", async t => {
  const f = await fixture(t);
  const outside = join(f.root, "owner-file");
  await writeFile(outside, "keep owner content");
  await rm(join(f.packageRoot, "README.md"));
  await symlink(outside, join(f.packageRoot, "README.md"));
  const result = await collectLegacyRadixNoticeSources(f.options);
  assert.equal(result.entries[0].status, "unresolved");
  assert.equal(await readFile(outside, "utf8"), "keep owner content");
  await assert.rejects(collectLegacyRadixNoticeSources({ ...f.options, outputPath: join(f.packageRoot, "candidates.json") }), /radix_notice_output_overlaps_runtime/);
  await assert.rejects(collectLegacyRadixNoticeSources(f.options), /radix_notice_output_exists/);
});

test("nested locations of the same exact version deduplicate only source collection, not location counts", async t => {
  const f = await fixture(t);
  const nestedPath = "node_modules/parent/node_modules/@radix-ui/react-tabs";
  await cp(f.packageRoot, join(f.options.runtimeRoot, nestedPath), { recursive: true });
  f.audit.packages.push({ ...f.audit.packages[0], path: nestedPath });
  f.audit.blockers.push({ code: "dependency_notice_missing", path: nestedPath });
  await writeFile(f.auditPath, JSON.stringify(f.audit));
  const result = await collectLegacyRadixNoticeSources(f.options);
  assert.equal(result.uniquePackageCount, 1);
  assert.equal(result.installedMissingNoticeCount, 2);
  assert.equal(result.entries[0].status, "candidate", result.entries[0].reason);
});
