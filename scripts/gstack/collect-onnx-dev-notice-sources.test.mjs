import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { c, Header } from "tar";
import { collectOnnxDevNoticeSources } from "./collect-onnx-dev-notice-sources.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const blob = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const source = bytes => ({ type: "file", encoding: "base64", content: bytes.toString("base64"), sha: blob(bytes) });
const name = "onnxruntime-common", version = "1.24.0-dev.20251116-b39e144322";
const revision = "b39e14432259d5f579f34c3e338f1f70aa368f01";
const lock = JSON.parse(await readFile(new URL("./upstream-lock.json", import.meta.url), "utf8"));
const license = await readFile(new URL("../../LICENSE", import.meta.url));

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-onnx-notice-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new Map([["package.json", Buffer.from(JSON.stringify({ name, version, license: "MIT" }))],
    ["__commit.txt", Buffer.from(revision)], ["lib/version.ts", Buffer.from(`export const version = '${version}';\n`)],
    ["dist/esm/index.js", Buffer.from("export const tensor = 1;\n")]]);
  for (const prefix of ["runtime/node_modules/onnxruntime-common", "archive/package"]) {
    for (const [path, bytes] of files) {
      await mkdir(dirname(join(root, prefix, path)), { recursive: true });
      await writeFile(join(root, prefix, path), bytes);
    }
  }
  const metadata = { name, version, license: "MIT", repository: { url: "https://github.com/Microsoft/onnxruntime.git" },
    dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` } };
  const audit = { schemaVersion: 1, packages: [{ name, version, license: "MIT", path: `node_modules/${name}`,
    metadataChecksum: checksum(files.get("package.json")) }],
    blockers: [{ code: "dependency_notice_missing", path: `node_modules/${name}` }] };
  const auditPath = join(root, "audit.json");
  await writeFile(auditPath, JSON.stringify(audit));
  let archiveBytes;
  const options = { runtimeRoot: join(root, "runtime"), auditPath, outputPath: join(root, "candidates.json"),
    registryReader: async () => {
      const stream = c({ cwd: join(root, "archive"), gzip: true }, ["package"]);
      const parts = []; for await (const part of stream) parts.push(part);
      const bytes = Buffer.concat(parts);
      archiveBytes = bytes;
      metadata.dist.integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
      return { metadata, registry: { url: `https://registry.npmjs.org/${name}/${version}`, checksum: checksum(JSON.stringify(metadata)),
        gitHead: null, repository: metadata.repository, integrity: metadata.dist.integrity } };
    },
    githubReader: async path => {
      if (path.endsWith(`/git/commits/${revision}`)) return { sha: revision, tree: { sha: "c".repeat(40) }, committer: { date: "2025-11-16T20:50:06Z" } };
      if (path.includes("contents/js/common/package.json")) return source(Buffer.from(JSON.stringify({ name, version: "1.24.0", license: "MIT" })));
      if (path.includes("contents/VERSION_NUMBER")) return source(Buffer.from("1.24.0\n"));
      if (path.includes("contents/LICENSE?")) return source(license);
      throw new Error(`unexpected_github_request:${path}`);
    },
    tarballReader: async () => archiveBytes };
  return { root, files, metadata, options, audit };
}

test("real npm archives bind all installed ONNX artifacts to the full exact dev commit without extraction", async t => {
  const f = await fixture(t);
  const result = await collectOnnxDevNoticeSources(f.options);
  assert.equal(result.releaseEligible, false);
  assert.equal(result.upstreamRevision, lock.revision);
  assert.equal(result.entries[0].status, "candidate");
  assert.equal(result.entries[0].source.revisionProof.installedFiles.length, f.files.size);
  assert.equal(result.entries[0].source.revision, revision);
  assert.deepEqual(Buffer.from(result.entries[0].source.contentBase64, "base64"), license);
  for (const [path, bytes] of f.files) assert.deepEqual(await readFile(join(f.options.runtimeRoot, `node_modules/${name}`, path)), bytes);
});

test("artifact tampering, unlisted archive members and symlinks cannot become notice candidates", async t => {
  for (const change of ["code", "extra-archive", "extra-installed", "link", "marker"]) {
    const f = await fixture(t);
    const installed = join(f.options.runtimeRoot, `node_modules/${name}`);
    if (change === "code") await writeFile(join(installed, "dist/esm/index.js"), "unreviewed code");
    if (change === "extra-archive") await writeFile(join(f.root, "archive/package/extra.js"), "extra");
    if (change === "extra-installed") await writeFile(join(installed, "extra.js"), "extra");
    if (change === "marker") await writeFile(join(installed, "__commit.txt"), revision.slice(0, 10));
    if (change === "link") {
      await rm(join(f.root, "archive/package/dist/esm/index.js"));
      await symlink("../../../owner.js", join(f.root, "archive/package/dist/esm/index.js"));
    }
    const result = await collectOnnxDevNoticeSources(f.options);
    assert.equal(result.entries[0].status, "unresolved", change);
    assert.match(result.entries[0].reason, /onnx_notice_/, change);
  }
});

test("changed registry integrity or historical source identity remains unresolved", async t => {
  for (const change of ["integrity", "version", "repository", "date"]) {
    const f = await fixture(t);
    const reader = f.options.registryReader;
    f.options.registryReader = async (...args) => {
      const result = await reader(...args);
      if (change === "integrity") result.metadata.dist.integrity = `sha512-${Buffer.alloc(64, 2).toString("base64")}`;
      if (change === "version") result.metadata.version = "1.24.0";
      if (change === "repository") result.metadata.repository.url = "https://github.com/unrelated/onnxruntime.git";
      return result;
    };
    const github = f.options.githubReader;
    f.options.githubReader = async path => {
      const data = await github(path);
      if (change === "date" && data.committer) data.committer.date = "2025-11-17T12:00:00Z";
      return data;
    };
    const result = await collectOnnxDevNoticeSources(f.options);
    assert.equal(result.entries[0].status, "unresolved", change);
  }
});

test("archive path traversal, duplicate members, hard links and oversized entries reject without extraction", async t => {
  const header = data => { const value = new Header({ mode: 0o644, size: 0, type: "File", ...data }); value.encode(); return value.block; };
  for (const members of [
    [header({ path: "package/../owner.js" })],
    [header({ path: "/package/owner.js" })],
    [header({ path: "package/package.json" }), header({ path: "package/package.json" })],
    [header({ path: "package/link", type: "Link", linkpath: "../owner.js" })],
    [header({ path: "package/huge", size: 65 * 1024 * 1024 })],
  ]) {
    const f = await fixture(t), bytes = Buffer.concat([...members, Buffer.alloc(1024)]);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const reader = f.options.registryReader;
    f.options.registryReader = async (...args) => { const result = await reader(...args);
      result.metadata.dist.integrity = integrity; result.registry.integrity = integrity; return result; };
    f.options.tarballReader = async () => bytes;
    const result = await collectOnnxDevNoticeSources(f.options);
    assert.equal(result.entries[0].status, "unresolved");
    assert.match(result.entries[0].reason, /onnx_notice_archive_/);
    await assert.rejects(readFile(join(f.root, "owner.js")), { code: "ENOENT" });
  }
});
