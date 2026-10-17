import { createHash } from "node:crypto";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const revision = value => /^[a-f0-9]{40}$/.test(value ?? "");
const gitBlob = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const digest = value => /^sha256:[a-f0-9]{64}$/.test(value ?? "");
export function safeNoticeSourcePath(path) {
  return typeof path === "string" && /^[A-Za-z0-9_@./-]+$/.test(path) &&
    !path.split("/").some(part => !part || part === "." || part === "..");
}

export function verifyGitHubNoticeFile(data) {
  if (data?.type !== "file" || data.encoding !== "base64" || typeof data.content !== "string") throw new Error("notice_source_not_plain_text");
  const encoded = data.content.replace(/\s+/g, "");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || !bytes.length || bytes.length > 256 * 1024 ||
    bytes.includes(0) || !Buffer.from(bytes.toString("utf8")).equals(bytes)) throw new Error("notice_source_text_invalid");
  if (gitBlob(bytes) !== data.sha) throw new Error("notice_source_git_blob_mismatch");
  return bytes;
}

function proofBytes(encoded, expectedChecksum) {
  if (typeof encoded !== "string") throw new Error("notice_source_release_proof_invalid");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > 256 * 1024 || bytes.toString("base64") !== encoded ||
    bytes.includes(0) || !Buffer.from(bytes.toString("utf8")).equals(bytes) || checksum(bytes) !== expectedChecksum) {
    throw new Error("notice_source_release_proof_invalid");
  }
  return bytes;
}

// A frozen tag must resolve to the reviewed commit and its package identity must
// agree with the exact npm record. Neither current main nor a nearby version is proof.
export function verifyExactReleaseNoticeProof({ proof, repository, revision: expectedRevision, name, version, license }) {
  if (proof?.kind !== "exact-version-tag" || !revision(expectedRevision) ||
    proof.repository?.toLowerCase() !== repository.toLowerCase() || proof.revision !== expectedRevision ||
    typeof proof.tag !== "string" || ![version, `v${version}`].includes(proof.tag) || !safeNoticeSourcePath(proof.packagePath) ||
    !proof.packagePath.endsWith("package.json") || !revision(proof.packageGitBlob)) throw new Error("notice_source_release_identity_invalid");
  const refBytes = proofBytes(proof.refContentBase64, proof.refChecksum);
  const ref = JSON.parse(refBytes.toString("utf8"));
  if (ref.ref !== `refs/tags/${proof.tag}` || ref.object?.type !== "commit" || ref.object.sha !== expectedRevision) {
    throw new Error("notice_source_release_tag_mismatch");
  }
  const packageBytes = proofBytes(proof.packageContentBase64, proof.packageChecksum);
  if (gitBlob(packageBytes) !== proof.packageGitBlob) throw new Error("notice_source_release_package_blob_mismatch");
  const pkg = JSON.parse(packageBytes.toString("utf8"));
  if (pkg.name !== name || pkg.version !== version || pkg.license !== license) throw new Error("notice_source_release_package_identity_mismatch");
}

export function extractReviewedNoticeBytes(sourceBytes, selection) {
  if (!selection) return sourceBytes;
  if (selection.method !== "verbatim-byte-range" || !Number.isSafeInteger(selection.startByte) ||
    !Number.isSafeInteger(selection.endByte) || selection.startByte < 0 || selection.endByte <= selection.startByte ||
    selection.endByte > sourceBytes.length) throw new Error("notice_source_selection_invalid");
  const bytes = sourceBytes.subarray(selection.startByte, selection.endByte);
  if (checksum(bytes) !== selection.checksum) throw new Error("notice_source_selection_checksum_mismatch");
  return bytes;
}

export function verifyInstalledSourceMapNoticeProof({ proof, repository, revision: expectedRevision, name, version, license, registryIntegrity }) {
  const required = ["package.json", "README.md", "dist/index.js", "dist/index.module.js", "dist/index.d.ts", "dist/index.js.map", "dist/index.module.js.map"];
  if (proof?.kind !== "installed-source-map-match" || !revision(expectedRevision) || proof.revision !== expectedRevision ||
    proof.repository?.toLowerCase() !== repository.toLowerCase() || !safeNoticeSourcePath(proof.packagePath) ||
    !proof.packagePath.endsWith("/package.json") || !revision(proof.packageGitBlob) || !revision(proof.sourceTreeHash) || !digest(proof.treeChecksum) ||
    !Array.isArray(proof.installedFiles) || !Array.isArray(proof.sourceMaps)) throw new Error("notice_source_map_proof_invalid");
  const commit = JSON.parse(proofBytes(proof.commitContentBase64, proof.commitChecksum).toString("utf8"));
  if (commit.sha !== expectedRevision || commit.tree?.sha !== proof.sourceTreeHash) throw new Error("notice_source_map_commit_tree_mismatch");
  let pkgBytes;
  try { pkgBytes = proofBytes(proof.packageContentBase64, proof.packageChecksum); }
  catch (error) { throw new Error("notice_source_map_package_invalid", { cause: error }); }
  const pkg = JSON.parse(pkgBytes.toString("utf8"));
  if (gitBlob(pkgBytes) !== proof.packageGitBlob || pkg.name !== name || pkg.version !== version || pkg.license !== license) {
    throw new Error("notice_source_map_package_identity_mismatch");
  }
  let url;
  try { url = new URL(proof.tarball?.url); } catch { throw new Error("notice_source_map_tarball_invalid"); }
  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.username || url.password || url.port ||
    proof.tarball.integrity !== registryIntegrity || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(registryIntegrity ?? "") ||
    !digest(proof.tarball.checksum) || !Number.isSafeInteger(proof.tarball.sizeBytes) || proof.tarball.sizeBytes <= 0 ||
    proof.tarball.sizeBytes > 10 * 1024 * 1024) throw new Error("notice_source_map_tarball_invalid");
  const files = new Map();
  for (const file of proof.installedFiles) {
    if (!safeNoticeSourcePath(file.path) || files.has(file.path) || !digest(file.checksum) ||
      !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes > 8 * 1024 * 1024) throw new Error("notice_source_map_artifact_invalid");
    files.set(file.path, file);
  }
  if (required.some(path => !files.has(path))) throw new Error("notice_source_map_artifact_incomplete");
  const maps = new Set();
  const allSources = new Map();
  const sourcePrefix = `${proof.packagePath.slice(0, -"package.json".length)}src/`;
  for (const map of proof.sourceMaps) {
    if (maps.has(map.path) || !["dist/index.js.map", "dist/index.module.js.map"].includes(map.path) ||
      !files.has(map.path) || map.checksum !== files.get(map.path).checksum || !Array.isArray(map.sources) || !map.sources.length) {
      throw new Error("notice_source_map_inventory_invalid");
    }
    maps.add(map.path);
    const paths = new Set();
    for (const source of map.sources) {
      if (!safeNoticeSourcePath(source.path) || !source.path.startsWith(sourcePrefix) || paths.has(source.path) ||
        !digest(source.checksum) || !revision(source.gitBlob) || !Number.isSafeInteger(source.sizeBytes) ||
        source.sizeBytes <= 0 || source.sizeBytes > 256 * 1024) throw new Error("notice_source_map_source_invalid");
      paths.add(source.path);
      const prior = allSources.get(source.path);
      if (prior && JSON.stringify(prior) !== JSON.stringify(source)) throw new Error("notice_source_map_source_identity_conflict");
      allSources.set(source.path, source);
    }
  }
  if (maps.size !== 2) throw new Error("notice_source_map_inventory_incomplete");
}

export function verifyInstalledNoticeSourceMap({ proof, path, bytes }) {
  const expected = proof.sourceMaps.find(map => map.path === path);
  if (!expected || checksum(bytes) !== expected.checksum) throw new Error("notice_source_map_checksum_mismatch");
  const map = JSON.parse(bytes.toString("utf8"));
  if (map.version !== 3 || ![undefined, ""].includes(map.sourceRoot) || !Array.isArray(map.sources) || !Array.isArray(map.sourcesContent) ||
    map.sources.length !== expected.sources.length || map.sourcesContent.length !== map.sources.length) throw new Error("notice_source_map_content_invalid");
  for (let index = 0; index < map.sources.length; index++) {
    const source = expected.sources[index];
    if (typeof map.sourcesContent[index] !== "string" || map.sources[index] !== source.path) throw new Error("notice_source_map_content_mismatch");
    const text = Buffer.from(map.sourcesContent[index]);
    if (text.length !== source.sizeBytes || checksum(text) !== source.checksum || gitBlob(text) !== source.gitBlob) throw new Error("notice_source_map_git_blob_mismatch");
  }
}
