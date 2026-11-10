import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registryMetadata } from "./collect-third-party-notice-sources.mjs";
import { safeNoticeSourcePath, verifyGitHubNoticeFile, verifyInstalledSourceMapNoticeProof,
  verifyInstalledNoticeSourceMap } from "./notice-source-provenance.mjs";

export const LEGACY_RADIX_NOTICE_REVISION = "21a7c97dc8efa79fecca36428eec49f187294085";
const repository = "radix-ui/primitives";
const lock = JSON.parse(await readFile(new URL("./upstream-lock.json", import.meta.url), "utf8"));
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const gitBlob = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const exists = path => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const inside = (root, path) => { const r = relative(root, path); return !r || !isAbsolute(r) && r !== ".." && !r.startsWith("../") && !r.startsWith("..\\"); };
const githubJson = path => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", timeout: 30_000,
  maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));

async function tarballBytes(metadata) {
  const url = new URL(metadata.dist.tarball);
  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.username || url.password || url.port) throw new Error("radix_notice_tarball_url_invalid");
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`radix_notice_tarball_http_${response.status}`);
  const parts = []; let length = 0;
  for await (const part of response.body) {
    length += part.length;
    if (length > 10 * 1024 * 1024) throw new Error("radix_notice_tarball_too_large");
    parts.push(part);
  }
  return Buffer.concat(parts);
}

async function plainFile(root, path) {
  if (!safeNoticeSourcePath(path)) throw new Error("radix_notice_file_path_invalid");
  const absolute = join(root, path);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(absolute) !== absolute || stat.size > 8 * 1024 * 1024) throw new Error("radix_notice_file_invalid");
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
    } else throw new Error("radix_notice_package_resource_invalid");
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

function sourceMapsFromTree(fileMaps, tree) {
  return fileMaps.map(({ path, bytes }) => {
    const map = JSON.parse(bytes.toString("utf8"));
    if (map.version !== 3 || !Array.isArray(map.sources) || !Array.isArray(map.sourcesContent) || map.sources.length !== map.sourcesContent.length) {
      throw new Error("radix_notice_map_invalid");
    }
    const sources = map.sources.map((sourcePath, index) => {
      if (!safeNoticeSourcePath(sourcePath) || typeof map.sourcesContent[index] !== "string") throw new Error("radix_notice_map_source_invalid");
      const bytes = Buffer.from(map.sourcesContent[index]);
      const entry = tree.get(sourcePath);
      if (entry?.type !== "blob" || entry.mode !== "100644" || entry.sha !== gitBlob(bytes) || entry.size !== bytes.length) {
        throw new Error("radix_notice_map_source_mismatch");
      }
      return { path: sourcePath, checksum: checksum(bytes), gitBlob: entry.sha, sizeBytes: bytes.length };
    });
    return { path, checksum: checksum(bytes), sources };
  });
}

// Investigative only: exact source matches still require a reviewed frozen catalog.
export async function collectLegacyRadixNoticeSources({ runtimeRoot, auditPath, outputPath,
  registryReader = registryMetadata, githubReader = githubJson, tarballReader = tarballBytes, onProgress = () => {} }) {
  const stat = await lstat(resolve(runtimeRoot));
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("radix_notice_runtime_invalid");
  const root = await realpath(runtimeRoot);
  const output = join(await realpath(dirname(resolve(outputPath))), basename(outputPath));
  if (inside(root, output)) throw new Error("radix_notice_output_overlaps_runtime");
  if (await exists(output)) throw new Error("radix_notice_output_exists");
  const auditBytes = await readFile(auditPath);
  const audit = JSON.parse(auditBytes.toString("utf8"));
  if (audit.schemaVersion !== 1 || !Array.isArray(audit.packages) || !Array.isArray(audit.blockers)) throw new Error("radix_notice_audit_invalid");
  const missing = new Set(audit.blockers.filter(b => b.code === "dependency_notice_missing").map(b => b.path));
  const missingPackages = audit.packages.filter(p => missing.has(p.path) && p.name.startsWith("@radix-ui/"));
  const packages = [...new Map(missingPackages.map(p => [`${p.name}@${p.version}`, p])).values()]
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en"));
  let context;
  try {
    const commitData = await githubReader(`repos/${repository}/git/commits/${LEGACY_RADIX_NOTICE_REVISION}`);
    if (commitData.sha !== LEGACY_RADIX_NOTICE_REVISION || !/^[a-f0-9]{40}$/.test(commitData.tree?.sha ?? "")) throw new Error("radix_notice_commit_invalid");
    const treeData = await githubReader(`repos/${repository}/git/trees/${commitData.tree.sha}?recursive=1`);
    if (treeData.truncated !== false || !Array.isArray(treeData.tree) || treeData.sha !== commitData.tree.sha) throw new Error("radix_notice_tree_invalid");
    const tree = new Map(treeData.tree.map(file => [file.path, file]));
    const data = await githubReader(`repos/${repository}/contents/LICENSE?ref=${LEGACY_RADIX_NOTICE_REVISION}`);
    const license = verifyGitHubNoticeFile(data);
    if (tree.get("LICENSE")?.sha !== data.sha || tree.get("LICENSE")?.mode !== "100644") throw new Error("radix_notice_license_tree_mismatch");
    context = { commitData, treeData, tree, source: { repository, revision: LEGACY_RADIX_NOTICE_REVISION, path: "LICENSE",
      gitBlob: data.sha, checksum: checksum(license), contentBase64: license.toString("base64") } };
  } catch (error) { context = { error }; }
  const entries = [];
  for (const pkg of packages) {
    const entry = { name: pkg.name, version: pkg.version, license: pkg.license, status: "unresolved" };
    let temporary;
    try {
      if (context.error) throw context.error;
      if (!safeNoticeSourcePath(pkg.path) || pkg.license !== "MIT") throw new Error("radix_notice_package_invalid");
      const packageRoot = join(root, pkg.path);
      const metadataBytes = await plainFile(packageRoot, "package.json");
      const installed = JSON.parse(metadataBytes.toString("utf8"));
      if (checksum(metadataBytes) !== pkg.metadataChecksum || installed.name !== pkg.name || installed.version !== pkg.version || installed.license !== pkg.license) throw new Error("radix_notice_metadata_mismatch");
      const files = await packageFiles(packageRoot);
      const maps = await Promise.all(["dist/index.js.map", "dist/index.module.js.map"].map(async path => ({ path, bytes: await plainFile(packageRoot, path) })));
      const sourceMaps = sourceMapsFromTree(maps, context.tree);
      const firstSource = sourceMaps[0].sources[0]?.path;
      if (!firstSource?.includes("/src/")) throw new Error("radix_notice_package_source_invalid");
      const packagePath = `${firstSource.split("/src/")[0]}/package.json`;
      const sourceData = await githubReader(`repos/${repository}/contents/${packagePath}?ref=${LEGACY_RADIX_NOTICE_REVISION}`);
      const sourceBytes = verifyGitHubNoticeFile(sourceData);
      if (context.tree.get(packagePath)?.sha !== sourceData.sha || context.tree.get(packagePath)?.mode !== "100644") throw new Error("radix_notice_package_tree_mismatch");
      const sourcePackage = JSON.parse(sourceBytes.toString("utf8"));
      if (sourcePackage.name !== pkg.name || sourcePackage.version !== pkg.version || sourcePackage.license !== pkg.license) throw new Error("radix_notice_source_identity_mismatch");
      const { metadata, registry } = await registryReader(pkg.name, pkg.version);
      if (metadata.name !== pkg.name || metadata.version !== pkg.version || metadata.license !== pkg.license ||
        !/github\.com[/:]radix-ui\/primitives(?:\.git)?$/.test((typeof metadata.repository === "string" ? metadata.repository : metadata.repository?.url) ?? "")) throw new Error("radix_notice_registry_identity_mismatch");
      const bytes = await tarballReader(metadata);
      const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
      if (!bytes.length || bytes.length > 10 * 1024 * 1024 || metadata.dist.integrity !== integrity || registry.integrity !== integrity) throw new Error("radix_notice_tarball_integrity_mismatch");
      temporary = await mkdtemp(join(tmpdir(), "ling-radix-archive-proof-"));
      const archive = join(temporary, "source.tgz");
      await writeFile(archive, bytes, { flag: "wx" });
      const env = { PATH: process.platform === "win32" ? process.env.SystemRoot : "/usr/bin:/bin", HOME: temporary,
        TMPDIR: temporary, TMP: temporary, TEMP: temporary, SystemRoot: process.env.SystemRoot };
      for (const file of files) {
        const published = execFileSync(process.platform === "win32" ? "tar.exe" : "/usr/bin/tar", ["-xOf", archive, `package/${file.path}`],
          { env, timeout: 10_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
        if (published.length !== file.sizeBytes || checksum(published) !== file.checksum || !(await plainFile(packageRoot, file.path)).equals(published)) throw new Error("radix_notice_installed_artifact_mismatch");
      }
      const proof = { kind: "installed-source-map-match", repository, revision: LEGACY_RADIX_NOTICE_REVISION,
        packagePath, packageChecksum: checksum(sourceBytes), packageGitBlob: sourceData.sha, packageContentBase64: sourceBytes.toString("base64"),
        sourceTreeHash: context.treeData.sha, treeChecksum: checksum(JSON.stringify(context.treeData)),
        commitChecksum: checksum(JSON.stringify(context.commitData)), commitContentBase64: Buffer.from(JSON.stringify(context.commitData)).toString("base64"),
        tarball: { url: metadata.dist.tarball, integrity, checksum: checksum(bytes), sizeBytes: bytes.length }, installedFiles: files, sourceMaps };
      verifyInstalledSourceMapNoticeProof({ proof, repository, revision: LEGACY_RADIX_NOTICE_REVISION,
        name: pkg.name, version: pkg.version, license: pkg.license, registryIntegrity: registry.integrity });
      for (const map of maps) verifyInstalledNoticeSourceMap({ proof, path: map.path, bytes: map.bytes });
      entry.registry = registry;
      entry.source = { ...context.source, revisionProof: proof };
      entry.status = "candidate";
    } catch (error) { entry.reason = error.message; }
    finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
    entries.push(entry);
    onProgress(`${pkg.name}@${pkg.version}: ${entry.status}${entry.reason ? ` (${entry.reason})` : ""}`);
  }
  const result = { schemaVersion: 1, reviewStatus: "candidate-only", releaseEligible: false, upstreamRevision: lock.revision,
    upstreamVersion: lock.version, inputAuditChecksum: checksum(auditBytes), installedMissingNoticeCount: missingPackages.length,
    uniquePackageCount: packages.length, reviewedSourceRevision: LEGACY_RADIX_NOTICE_REVISION, entries };
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runtimeRoot, auditPath, outputPath] = process.argv.slice(2);
  if (!runtimeRoot || !auditPath || !outputPath) throw new Error("Usage: collect-legacy-radix-notice-sources.mjs <runtime-root> <audit> <new-candidate-output>");
  const result = await collectLegacyRadixNoticeSources({ runtimeRoot, auditPath, outputPath, onProgress: message => process.stderr.write(`${message}\n`) });
  process.stdout.write(`${JSON.stringify({ candidates: result.entries.filter(e => e.status === "candidate").length,
    unresolved: result.entries.filter(e => e.status !== "candidate").length, outputPath })}\n`);
}
