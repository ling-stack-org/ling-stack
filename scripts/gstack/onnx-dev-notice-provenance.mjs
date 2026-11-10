import { createHash } from "node:crypto";
import { safeNoticeSourcePath } from "./notice-source-provenance.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const blob = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const revision = value => /^[a-f0-9]{40}$/.test(value ?? "");
const digest = value => /^sha256:[a-f0-9]{64}$/.test(value ?? "");

function proofBytes(encoded, expectedChecksum) {
  if (typeof encoded !== "string") throw new Error("notice_source_onnx_text_invalid");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > 256 * 1024 || bytes.toString("base64") !== encoded || bytes.includes(0) ||
    !Buffer.from(bytes.toString("utf8")).equals(bytes) || checksum(bytes) !== expectedChecksum) {
    throw new Error("notice_source_onnx_text_invalid");
  }
  return bytes;
}

function sourceRecord(value) {
  const bytes = proofBytes(value?.contentBase64, value?.checksum);
  if (blob(bytes) !== value.gitBlob) throw new Error("notice_source_onnx_blob_mismatch");
  return bytes;
}

// Official dev archives carry a full __commit.txt. A version's short SHA alone
// is not provenance, and this notice proof does not attest to a reproducible build.
export function verifyOnnxDevNoticeProof({ proof, repository, revision: expectedRevision, name, version, license, registryIntegrity }) {
  const suffix = /^(\d+\.\d+\.\d+)-dev\.(\d{8})-([a-f0-9]{10})$/.exec(version ?? "");
  const target = name === "onnxruntime-web" ? "web" : name === "onnxruntime-common" ? "common" : undefined;
  if (!target || !suffix || license !== "MIT" || proof?.kind !== "installed-onnx-dev-commit-match" ||
    repository?.toLowerCase() !== "microsoft/onnxruntime" || proof.repository?.toLowerCase() !== repository.toLowerCase() ||
    !revision(expectedRevision) || proof.revision !== expectedRevision || !expectedRevision.startsWith(suffix[3]) ||
    proof.packagePath !== `js/${target}/package.json` || proof.versionNumber?.path !== "VERSION_NUMBER" ||
    !Array.isArray(proof.installedFiles)) throw new Error("notice_source_onnx_identity_invalid");
  const pkg = JSON.parse(sourceRecord(proof.package).toString("utf8"));
  if (pkg.name !== name || pkg.license !== license || pkg.version !== suffix[1] ||
    sourceRecord(proof.versionNumber).toString("utf8").trim() !== suffix[1]) throw new Error("notice_source_onnx_package_mismatch");
  const commit = JSON.parse(proofBytes(proof.commitContentBase64, proof.commitChecksum).toString("utf8"));
  const date = new Date(commit.committer?.date);
  if (commit.sha !== expectedRevision || !revision(commit.tree?.sha) || !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10).replaceAll("-", "") !== suffix[2]) throw new Error("notice_source_onnx_commit_mismatch");
  if (proof.tarball?.url !== `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` ||
    proof.tarball.integrity !== registryIntegrity || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(registryIntegrity ?? "") ||
    !digest(proof.tarball.checksum) || !Number.isSafeInteger(proof.tarball.sizeBytes) ||
    proof.tarball.sizeBytes <= 0 || proof.tarball.sizeBytes > 128 * 1024 * 1024) throw new Error("notice_source_onnx_tarball_invalid");
  const files = new Map();
  let total = 0;
  for (const file of proof.installedFiles) {
    if (!safeNoticeSourcePath(file.path) || files.has(file.path) || !digest(file.checksum) ||
      !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes > 64 * 1024 * 1024 ||
      file.path === "node_modules" || file.path.startsWith("node_modules/") ||
      ["LICENSE.ling-upstream", "ling-upstream-license-provenance.json"].includes(file.path)) {
      throw new Error("notice_source_onnx_artifact_invalid");
    }
    total += file.sizeBytes;
    files.set(file.path, file);
  }
  if (total > 256 * 1024 * 1024 || ["package.json", "__commit.txt", "lib/version.ts"].some(path => !files.has(path)) ||
    ![...files.keys()].some(path => path.startsWith("dist/") && path.endsWith(".js"))) {
    throw new Error("notice_source_onnx_inventory_incomplete");
  }
  const marker = files.get("__commit.txt");
  const bytes = proofBytes(proof.markerContentBase64, marker.checksum);
  if (marker.sizeBytes !== bytes.length || bytes.toString("utf8") !== expectedRevision) throw new Error("notice_source_onnx_marker_mismatch");
}
