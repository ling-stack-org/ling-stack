import { createHash } from "node:crypto";
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest("hex");
function decode(record) {
  if (!record || typeof record.contentBase64 !== "string") throw new Error("distribution_restored_notice_text_missing");
  const bytes = Buffer.from(record.contentBase64, "base64");
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (digest("sha256", bytes) !== record.sha256 || blob !== record.gitBlob) throw new Error("distribution_restored_notice_digest_mismatch");
  return bytes;
}
export function packageIntegrity(lockfile, identity) {
  const key = identity.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const block = new RegExp(`^  (?:'${key}'|"${key}"|${key}):\\r?\\n([\\s\\S]*?)(?=^  [^ ]|^snapshots:|$(?![\\s\\S]))`, "mu").exec(lockfile)?.[1];
  return /\bintegrity:\s*([^,}\s]+)/u.exec(block ?? "")?.[1];
}
export function validateNoticeRestoration(entry, metadata, lockfile) {
  const identity = `${metadata.name}@${metadata.version}`;
  if (entry.name !== metadata.name || entry.version !== metadata.version || packageIntegrity(lockfile, identity) !== entry.registry?.integrity) throw new Error("distribution_restored_notice_lock_identity_mismatch");
  if (!/^[a-f0-9]{40}$/u.test(entry.revision ?? "")) throw new Error("distribution_restored_notice_revision_invalid");
  const sourceBytes = decode(entry.sourcePackage), source = JSON.parse(sourceBytes);
  const applies = source.name === metadata.name && (source.version === metadata.version || entry.registry.gitHead === entry.revision)
    || source.name === "esbuild" && /^@esbuild\/(?:darwin-arm64|win32-x64)$/u.test(metadata.name) && source.version === metadata.version
    || source.name === "@napi-rs/keyring" && /^@napi-rs\/keyring-(?:darwin-arm64|win32-x64-msvc)$/u.test(metadata.name) && source.version === metadata.version && Array.isArray(source.napi?.targets)
    || metadata.name.startsWith(`${source.name}-`) && source.version === metadata.version && source.optionalDependencies?.[metadata.name] === metadata.version;
  if (!applies) throw new Error("distribution_restored_notice_source_identity_mismatch");
  const sourceRoot = `https://raw.githubusercontent.com/${entry.repository}/${entry.revision}/`;
  for (const file of [entry.sourcePackage, entry.licenseText]) if (file.url !== `${sourceRoot}${file.path}` || file.path.split("/").includes("..")) throw new Error("distribution_restored_notice_source_url_mismatch");
  if (entry.registry.gitHead !== entry.revision) {
    const statement = entry.provenance?.statement;
    const [algorithm, value] = entry.registry.integrity.split("-", 2);
    const subject = statement?.subject?.some(item => item.digest?.[algorithm] === Buffer.from(value, "base64").toString("hex"));
    const dependency = statement?.predicate?.buildDefinition?.resolvedDependencies?.some(item => item.digest?.gitCommit === entry.revision && item.uri?.toLowerCase().startsWith(`git+https://github.com/${entry.repository.toLowerCase()}@`));
    if (statement?.predicateType !== "https://slsa.dev/provenance/v1" || !subject || !dependency) throw new Error("distribution_restored_notice_provenance_mismatch");
  }
  return { license: decode(entry.licenseText), sourcePackage: sourceBytes };
}
