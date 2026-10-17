import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditGstackRuntimeDependencies } from "./runtime-dependency-audit.mjs";
import { extractReviewedNoticeBytes, verifyExactReleaseNoticeProof, verifyInstalledSourceMapNoticeProof,
  verifyInstalledNoticeSourceMap } from "./notice-source-provenance.mjs";
import { verifyOnnxDevNoticeProof } from "./onnx-dev-notice-provenance.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await readFile(join(scriptRoot, "upstream-lock.json"), "utf8"));
export const REVIEWED_GSTACK_NOTICE_CATALOG_CHECKSUM = "sha256:021859abab803098ef0515e832d6d67e4ef436b6aafa4f2e66af77ba07e587fc";
const names = ["LICENSE.ling-upstream", "ling-upstream-license-provenance.json"];
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const digest = value => /^sha256:[a-f0-9]{64}$/.test(value ?? "");
const revision = value => /^[a-f0-9]{40}$/.test(value ?? "");
const exists = path => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });

function safePath(path) {
  return typeof path === "string" && path.length > 0 && !isAbsolute(path) && !path.includes("\\") &&
    !path.includes(":") && !path.includes("\0") && !path.split("/").some(part => !part || part === "." || part === "..");
}

async function plainFile(root, path) {
  if (!safePath(path)) throw new Error("gstack_notice_path_invalid");
  const absolute = join(root, path);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(absolute) !== absolute) throw new Error("gstack_notice_file_invalid");
  return readFile(absolute);
}

function completeMitGrant(bytes) {
  if (!bytes.length || bytes.length > 256 * 1024 || bytes.includes(0) || !Buffer.from(bytes.toString("utf8")).equals(bytes)) return false;
  const text = bytes.toString("utf8").replace(/\s+/g, " ").trim();
  return /^(?:(?:The )?MIT License(?: \(MIT\))? )?Copyright .+?Permission is hereby granted,/i.test(text) &&
    /Permission is hereby granted, free of charge, to any person obtaining a copy of this software/i.test(text) &&
    /rights to use, copy, modify, merge, publish, distribute, sublicense, and\/or sell copies/i.test(text) &&
    /subject to the following conditions/i.test(text) &&
    /above copyright notice and this permission notice shall be included in all copies or substantial portions/i.test(text) &&
    /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/i.test(text) &&
    /IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE/i.test(text) &&
    !/GNU (?:LESSER |AFFERO )?GENERAL PUBLIC LICENSE|Apache License|statically links|additional licenses/i.test(text);
}

function completeIscGrant(bytes) {
  if (!bytes.length || bytes.length > 256 * 1024 || bytes.includes(0) || !Buffer.from(bytes.toString("utf8")).equals(bytes)) return false;
  const text = bytes.toString("utf8").replace(/\s+/g, " ").trim();
  return /^(?:ISC License )?Copyright .+?Permission to use,/i.test(text) &&
    /Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted/i.test(text) &&
    /copyright notice and this permission notice appear in all copies/i.test(text) &&
    /THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHORS? DISCLAIMS? ALL WARRANTIES/i.test(text) &&
    /INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS/i.test(text) &&
    /IN NO EVENT SHALL THE AUTHORS? BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES/i.test(text) &&
    /LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION/i.test(text) &&
    /IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE/i.test(text) &&
    !/GNU (?:LESSER |AFFERO )?GENERAL PUBLIC LICENSE|Apache License|statically links|additional licenses/i.test(text);
}

function validateCatalog(bytes, expectedChecksum) {
  if (!digest(expectedChecksum) || checksum(bytes) !== expectedChecksum) throw new Error("gstack_notice_catalog_checksum_mismatch");
  const catalog = JSON.parse(bytes.toString("utf8"));
  if (catalog.schemaVersion !== 1 || catalog.reviewStatus !== "reviewed-notice-texts" || catalog.releaseEligible !== false ||
    catalog.upstreamRevision !== lock.revision || catalog.upstreamVersion !== lock.version ||
    !Array.isArray(catalog.entries) || !catalog.entries.length) throw new Error("gstack_notice_catalog_invalid");
  const entries = new Map();
  for (const entry of catalog.entries) {
    const key = `${entry.name}@${entry.version}`;
    const source = entry.source;
    const registry = entry.registry;
    if (!/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(entry.name ?? "") ||
      !/^[0-9][A-Za-z0-9.+-]*$/.test(entry.version ?? "") || !["MIT", "ISC"].includes(entry.license) || entries.has(key) ||
      !Array.isArray(entry.installedMetadataChecksums) || !entry.installedMetadataChecksums.length ||
      !entry.installedMetadataChecksums.every(digest) ||
      new Set(entry.installedMetadataChecksums).size !== entry.installedMetadataChecksums.length ||
      registry?.url !== `https://registry.npmjs.org/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}` ||
      !digest(registry.checksum) || typeof registry.integrity !== "string" || !registry.integrity ||
      !source || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository ?? "") ||
      !revision(source.revision) || !safePath(source.path) || !digest(source.checksum) ||
      !revision(source.gitBlob) || typeof source.contentBase64 !== "string") throw new Error("gstack_notice_entry_invalid");
    const url = typeof registry.repository === "string" ? registry.repository : registry.repository?.url;
    const repository = typeof url === "string" ? /(?:github\.com[/:]|^github:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:$|[#/])/.exec(url)?.[1] : undefined;
    if (repository !== source.repository) throw new Error("gstack_notice_repository_mismatch");
    if (revision(registry.gitHead)) {
      if (source.revision !== registry.gitHead || source.revisionProof) throw new Error("gstack_notice_revision_mismatch");
    } else {
      if (registry.gitHead !== null) throw new Error("gstack_notice_revision_missing");
      try {
        const options = { proof: source.revisionProof, repository, revision: source.revision,
          name: entry.name, version: entry.version, license: entry.license, registryIntegrity: registry.integrity };
        if (source.revisionProof?.kind === "installed-source-map-match") verifyInstalledSourceMapNoticeProof(options);
        else if (source.revisionProof?.kind === "installed-onnx-dev-commit-match") verifyOnnxDevNoticeProof(options);
        else verifyExactReleaseNoticeProof(options);
      }
      catch (error) { throw new Error("gstack_notice_release_proof_invalid", { cause: error }); }
    }
    const sourceBytes = Buffer.from(source.contentBase64, "base64");
    const gitBlob = createHash("sha1").update(`blob ${sourceBytes.length}\0`).update(sourceBytes).digest("hex");
    if (sourceBytes.toString("base64") !== source.contentBase64 || checksum(sourceBytes) !== source.checksum ||
      gitBlob !== source.gitBlob || sourceBytes.length > 256 * 1024 || sourceBytes.includes(0) ||
      !Buffer.from(sourceBytes.toString("utf8")).equals(sourceBytes)) throw new Error("gstack_notice_source_invalid");
    let text;
    try { text = extractReviewedNoticeBytes(sourceBytes, entry.notice); }
    catch (error) { throw new Error("gstack_notice_selection_invalid", { cause: error }); }
    if (!(entry.license === "ISC" ? completeIscGrant(text) : completeMitGrant(text))) throw new Error("gstack_notice_source_invalid");
    entries.set(key, { entry, text });
  }
  return entries;
}

async function verifyInstalledPackageArtifacts(root, packagePath, proof) {
  if (!["installed-source-map-match", "installed-onnx-dev-commit-match"].includes(proof?.kind)) return;
  const errorPrefix = proof.kind === "installed-source-map-match" ? "gstack_notice_source_map" : "gstack_notice_onnx_artifact";
  const packageRoot = join(root, packagePath);
  async function ownPaths(prefix = "") {
    const paths = [];
    for (const entry of await readdir(join(packageRoot, prefix), { withFileTypes: true })) {
      if (!prefix && (entry.name === "node_modules" || names.includes(entry.name))) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!safePath(path)) throw new Error(`${errorPrefix}_path_invalid`);
      if (entry.isDirectory()) paths.push(...await ownPaths(path));
      else if (entry.isFile()) paths.push(path);
      else throw new Error(`${errorPrefix}_resource_invalid`);
    }
    return paths;
  }
  const expected = new Map(proof.installedFiles.map(file => [file.path, file]));
  const actualPaths = await ownPaths();
  if (actualPaths.length !== expected.size || actualPaths.some(path => !expected.has(path))) {
    throw new Error(`${errorPrefix}_inventory_mismatch`);
  }
  for (const path of actualPaths) {
    try {
      const file = expected.get(path);
      const stat = await lstat(join(packageRoot, path));
      if (stat.size !== file.sizeBytes) throw new Error("notice_source_map_size_mismatch");
      const bytes = await plainFile(packageRoot, path);
      if (checksum(bytes) !== file.checksum) throw new Error("notice_source_map_checksum_mismatch");
      if (proof.sourceMaps?.some(map => map.path === path)) verifyInstalledNoticeSourceMap({ proof, path, bytes });
    } catch (error) { throw new Error(proof.kind === "installed-source-map-match" ? "gstack_notice_source_map_artifact_mismatch" :
      "gstack_notice_onnx_artifact_mismatch", { cause: error }); }
  }
}

function provenanceBytes(entry, pkg, catalogChecksum) {
  const { contentBase64: _content, ...source } = entry.source;
  return Buffer.from(`${JSON.stringify({ schemaVersion: 1, reviewScope: "notice-text-only", releaseEligible: false,
    upstreamRevision: lock.revision, upstreamVersion: lock.version, catalogChecksum,
    package: { name: pkg.name, version: pkg.version, path: pkg.path, license: entry.license,
      metadataChecksum: pkg.metadataChecksum }, registry: entry.registry, source,
    ...(entry.notice ? { notice: entry.notice } : {}) }, null, 2)}\n`);
}

// Called only on exclusively owned, unpublished staging by the resource preparer.
// Downloaded candidates never authorize installation or native redistribution.
export async function installReviewedGstackNotices({ runtimeRoot, target,
  catalogPath = join(scriptRoot, "reviewed-third-party-notices.json"),
  expectedCatalogChecksum = REVIEWED_GSTACK_NOTICE_CATALOG_CHECKSUM, onProgress = () => {} }) {
  const requested = resolve(runtimeRoot);
  const stat = await lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("gstack_notice_runtime_root_invalid");
  const root = await realpath(requested);
  if (await exists(join(root, "manifest.json")) || await exists(join(dirname(root), "manifest.json"))) {
    throw new Error("gstack_notice_stage_already_executable");
  }
  const catalogAbsolute = resolve(catalogPath);
  const entries = validateCatalog(await plainFile(await realpath(dirname(catalogAbsolute)), catalogAbsolute.split(/[\\/]/).at(-1)), expectedCatalogChecksum);
  const lockPath = join(root, ".ling-notice-install-lock");
  try { await mkdir(lockPath); } catch (error) {
    if (error.code === "EEXIST") throw new Error("gstack_notice_install_busy");
    throw error;
  }
  const created = [];
  try {
    const audit = await auditGstackRuntimeDependencies({ runtimeRoot: root, target });
    if (audit.blockers.some(b => ["dependency_link_escape", "dependency_link_materialization_required", "dependency_resource_kind_invalid"].includes(b.code))) {
      throw new Error("gstack_notice_unsafe_resource_links");
    }
    const result = { schemaVersion: 1, reviewScope: "notice-text-only", releaseEligible: false,
      catalogChecksum: expectedCatalogChecksum, installed: [], alreadyInstalled: [], preservedExistingNotices: [] };
    const plans = [];
    for (const pkg of audit.packages) {
      const reviewed = entries.get(`${pkg.name}@${pkg.version}`);
      if (!reviewed) continue;
      if (!safePath(pkg.path) || !/^(?:node_modules\/|lib\/diagram-render\/node_modules\/)/.test(pkg.path)) throw new Error("gstack_notice_package_path_invalid");
      const metadata = await plainFile(root, `${pkg.path}/package.json`);
      const parsed = JSON.parse(metadata.toString("utf8"));
      const { entry, text } = reviewed;
      if (!entry.installedMetadataChecksums.includes(checksum(metadata)) || checksum(metadata) !== pkg.metadataChecksum ||
        parsed.name !== entry.name || parsed.version !== entry.version || parsed.license !== entry.license) {
        throw new Error("gstack_notice_package_metadata_mismatch");
      }
      await verifyInstalledPackageArtifacts(root, pkg.path, entry.source.revisionProof);
      const bytes = [text, provenanceBytes(entry, pkg, expectedCatalogChecksum)];
      const paths = names.map(name => `${pkg.path}/${name}`);
      const present = await Promise.all(paths.map(path => exists(join(root, path))));
      if (present.some(Boolean)) {
        if (!present.every(Boolean)) throw new Error("gstack_notice_existing_installation_mismatch");
        for (let i = 0; i < paths.length; i++) {
          if (!(await plainFile(root, paths[i])).equals(bytes[i])) throw new Error("gstack_notice_existing_installation_mismatch");
        }
        result.alreadyInstalled.push(pkg.path);
      } else if (pkg.noticePaths.length) result.preservedExistingNotices.push(pkg.path);
      else plans.push({ pkg, metadata, paths, bytes, proof: entry.source.revisionProof });
    }
    // Preflight every matching location before the first write; never repair metadata.
    for (const plan of plans) {
      await onProgress({ stage: "install-reviewed-notice", path: plan.pkg.path });
      if (!(await plainFile(root, `${plan.pkg.path}/package.json`)).equals(plan.metadata)) throw new Error("gstack_notice_package_metadata_changed");
      await verifyInstalledPackageArtifacts(root, plan.pkg.path, plan.proof);
      for (let i = 0; i < plan.paths.length; i++) {
        const path = join(root, plan.paths[i]);
        const handle = await open(path, "wx");
        try {
          const { ino, dev } = await handle.stat();
          created.push({ path, ino, dev });
          await handle.writeFile(plan.bytes[i]);
        } finally { await handle.close(); }
      }
      result.installed.push(plan.pkg.path);
    }
    return result;
  } catch (error) {
    for (const file of created.reverse()) {
      const stat = await lstat(file.path).catch(() => undefined);
      if (stat?.isFile() && stat.ino === file.ino && stat.dev === file.dev) await rm(file.path);
    }
    throw error;
  } finally { await rmdir(lockPath); }
}
