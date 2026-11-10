import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser } from "tar";
import { registryMetadata } from "./collect-third-party-notice-sources.mjs";
import { safeNoticeSourcePath, verifyGitHubNoticeFile } from "./notice-source-provenance.mjs";
import { verifyOnnxDevNoticeProof } from "./onnx-dev-notice-provenance.mjs";

const repository = "Microsoft/onnxruntime";
const lock = JSON.parse(await readFile(new URL("./upstream-lock.json", import.meta.url), "utf8"));
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const githubJson = path => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", timeout: 30_000,
  maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
const exists = path => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const sourceRecord = data => { const bytes = verifyGitHubNoticeFile(data);
  return { gitBlob: data.sha, checksum: checksum(bytes), contentBase64: bytes.toString("base64") }; };

async function plainFile(root, path) {
  if (!safeNoticeSourcePath(path)) throw new Error("onnx_notice_file_path_invalid");
  const absolute = join(root, path), stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(absolute) !== absolute || stat.size > 64 * 1024 * 1024) {
    throw new Error("onnx_notice_file_invalid");
  }
  return readFile(absolute);
}

async function packageFiles(root, prefix = "") {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (!prefix && entry.name === "node_modules") continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await packageFiles(root, path));
    else if (entry.isFile()) {
      const bytes = await plainFile(root, path);
      files.push({ path, checksum: checksum(bytes), sizeBytes: bytes.length });
    } else throw new Error("onnx_notice_package_resource_invalid");
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

async function tarballBytes(metadata) {
  if (metadata.dist?.tarball !== `https://registry.npmjs.org/${metadata.name}/-/${metadata.name}-${metadata.version}.tgz`) {
    throw new Error("onnx_notice_tarball_url_invalid");
  }
  const response = await fetch(metadata.dist.tarball, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`onnx_notice_tarball_http_${response.status}`);
  const parts = []; let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > 128 * 1024 * 1024) throw new Error("onnx_notice_tarball_too_large");
    parts.push(part);
  }
  return Buffer.concat(parts);
}

// Stream and hash with the repository's tar parser. No archive member is extracted
// or executed; links, traversal, duplicates and excess resource sizes reject.
async function archiveFiles(bytes) {
  const files = [], paths = new Set();
  let total = 0;
  await new Promise((resolve, reject) => {
    const parser = new Parser({ strict: true, maxMetaEntrySize: 256 * 1024 });
    parser.on("error", reject);
    parser.on("end", resolve);
    parser.on("entry", entry => {
      try {
        const path = entry.path;
        const normalized = entry.type === "Directory" ? path.replace(/\/$/, "") : path;
        if (!safeNoticeSourcePath(normalized) || !(normalized === "package" || normalized.startsWith("package/")) ||
          paths.has(normalized) || !["Directory", "File", "OldFile"].includes(entry.type)) throw new Error("onnx_notice_archive_resource_invalid");
        paths.add(normalized);
        if (entry.type === "Directory") { entry.resume(); return; }
        if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 64 * 1024 * 1024) throw new Error("onnx_notice_archive_size_invalid");
        total += entry.size;
        if (total > 256 * 1024 * 1024) throw new Error("onnx_notice_archive_too_large");
        const hash = createHash("sha256"); let size = 0;
        entry.on("data", part => { size += part.length; hash.update(part); });
        entry.on("error", error => parser.abort(error));
        entry.on("end", () => {
          if (size !== entry.size) { parser.abort(new Error("onnx_notice_archive_truncated")); return; }
          files.push({ path: path.slice("package/".length), checksum: `sha256:${hash.digest("hex")}`, sizeBytes: size });
        });
        entry.resume();
      } catch (error) { parser.abort(error); }
    });
    parser.end(bytes);
  });
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

export async function collectOnnxDevNoticeSources({ runtimeRoot, auditPath, outputPath,
  registryReader = registryMetadata, githubReader = githubJson, tarballReader = tarballBytes, onProgress = () => {} }) {
  const requested = resolve(runtimeRoot), stat = await lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("onnx_notice_runtime_invalid");
  const root = await realpath(requested);
  const output = join(await realpath(dirname(resolve(outputPath))), basename(outputPath));
  const r = relative(root, output);
  if (!r || !isAbsolute(r) && r !== ".." && !r.startsWith("../") && !r.startsWith("..\\")) throw new Error("onnx_notice_output_overlaps_runtime");
  if (await exists(output)) throw new Error("onnx_notice_output_exists");
  const auditBytes = await readFile(auditPath), audit = JSON.parse(auditBytes.toString("utf8"));
  if (audit.schemaVersion !== 1 || !Array.isArray(audit.packages) || !Array.isArray(audit.blockers)) throw new Error("onnx_notice_audit_invalid");
  const missing = new Set(audit.blockers.filter(b => b.code === "dependency_notice_missing").map(b => b.path));
  const packages = [...new Map(audit.packages.filter(p => missing.has(p.path) &&
    ["onnxruntime-web", "onnxruntime-common"].includes(p.name) && p.version.includes("-dev.")).map(p => [`${p.name}@${p.version}`, p])).values()];
  const entries = [];
  for (const pkg of packages) {
    const entry = { name: pkg.name, version: pkg.version, license: pkg.license, status: "unresolved" };
    try {
      if (!safeNoticeSourcePath(pkg.path) || pkg.license !== "MIT") throw new Error("onnx_notice_package_invalid");
      const packageRoot = join(root, pkg.path);
      const metadataBytes = await plainFile(packageRoot, "package.json");
      const installed = JSON.parse(metadataBytes.toString("utf8"));
      if (checksum(metadataBytes) !== pkg.metadataChecksum || installed.name !== pkg.name || installed.version !== pkg.version ||
        installed.license !== pkg.license) throw new Error("onnx_notice_metadata_mismatch");
      const marker = await plainFile(packageRoot, "__commit.txt"), revision = marker.toString("utf8");
      if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("onnx_notice_full_commit_missing");
      const { metadata, registry } = await registryReader(pkg.name, pkg.version);
      const url = typeof metadata.repository === "string" ? metadata.repository : metadata.repository?.url;
      if (metadata.name !== pkg.name || metadata.version !== pkg.version || metadata.license !== pkg.license ||
        !/github\.com[/:]Microsoft\/onnxruntime(?:\.git)?$/i.test(url ?? "") || registry.gitHead !== null) {
        throw new Error("onnx_notice_registry_identity_mismatch");
      }
      const files = await packageFiles(packageRoot), bytes = await tarballReader(metadata);
      const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
      if (!bytes.length || bytes.length > 128 * 1024 * 1024 || integrity !== metadata.dist?.integrity || integrity !== registry.integrity) {
        throw new Error("onnx_notice_tarball_integrity_mismatch");
      }
      if (JSON.stringify(await archiveFiles(bytes)) !== JSON.stringify(files)) throw new Error("onnx_notice_installed_artifact_mismatch");
      const commit = await githubReader(`repos/${repository}/git/commits/${revision}`);
      const packagePath = `js/${pkg.name === "onnxruntime-web" ? "web" : "common"}/package.json`;
      const packageSource = sourceRecord(await githubReader(`repos/${repository}/contents/${packagePath}?ref=${revision}`));
      const versionNumber = sourceRecord(await githubReader(`repos/${repository}/contents/VERSION_NUMBER?ref=${revision}`));
      const notice = sourceRecord(await githubReader(`repos/${repository}/contents/LICENSE?ref=${revision}`));
      const proof = { kind: "installed-onnx-dev-commit-match", repository, revision, packagePath, package: packageSource,
        versionNumber: { path: "VERSION_NUMBER", ...versionNumber }, commitChecksum: checksum(JSON.stringify(commit)),
        commitContentBase64: Buffer.from(JSON.stringify(commit)).toString("base64"), markerContentBase64: marker.toString("base64"),
        tarball: { url: metadata.dist.tarball, integrity, checksum: checksum(bytes), sizeBytes: bytes.length }, installedFiles: files };
      verifyOnnxDevNoticeProof({ proof, repository, revision, name: pkg.name, version: pkg.version, license: pkg.license, registryIntegrity: integrity });
      entry.registry = registry;
      entry.source = { repository, revision, path: "LICENSE", ...notice, revisionProof: proof };
      entry.status = "candidate";
    } catch (error) { entry.reason = error.message; }
    entries.push(entry);
    onProgress(`${pkg.name}@${pkg.version}: ${entry.status}${entry.reason ? ` (${entry.reason})` : ""}`);
  }
  const result = { schemaVersion: 1, reviewStatus: "candidate-only", releaseEligible: false, upstreamRevision: lock.revision,
    upstreamVersion: lock.version, inputAuditChecksum: checksum(auditBytes), uniquePackageCount: packages.length, entries };
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runtimeRoot, auditPath, outputPath] = process.argv.slice(2);
  if (!runtimeRoot || !auditPath || !outputPath) throw new Error("Usage: collect-onnx-dev-notice-sources.mjs <runtime-root> <audit> <new-candidate-output>");
  const result = await collectOnnxDevNoticeSources({ runtimeRoot, auditPath, outputPath, onProgress: message => process.stderr.write(`${message}\n`) });
  process.stdout.write(`${JSON.stringify({ candidates: result.entries.filter(e => e.status === "candidate").length,
    unresolved: result.entries.filter(e => e.status !== "candidate").length, outputPath })}\n`);
}
