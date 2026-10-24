#!/usr/bin/env node
/** Recover original notice text from the exact published npm revision; no license synthesis. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectInstalledClosure, lockedPackageKeys, repositoryRoot, sha256 } from "./materials.mjs";

const gitBlob = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
async function get(url, optional = false) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) { if (optional && response.status === 404) return undefined; throw new Error(`notice_source_http_${response.status}:${url}`); }
  return Buffer.from(await response.arrayBuffer());
}
function sourceRepository(metadata) {
  const url = typeof metadata.repository === "string" ? metadata.repository : metadata.repository?.url;
  return /github\.com[/:]([^/#]+\/[^/#]+?)(?:\.git)?(?:#.*)?$/u.exec(url ?? "")?.[1];
}
export function statementRevision(statement, metadata) {
  if (statement.predicateType !== "https://slsa.dev/provenance/v1") return undefined;
  const integrity = metadata.dist.integrity;
  const [algorithm, value] = integrity.split("-", 2);
  if (!statement.subject?.some(subject => subject.digest?.[algorithm] === Buffer.from(value, "base64").toString("hex"))) throw new Error("notice_source_provenance_subject_mismatch");
  const repository = sourceRepository(metadata)?.toLowerCase();
  const dependency = statement.predicate?.buildDefinition?.resolvedDependencies?.find(item => item.uri?.toLowerCase().startsWith(`git+https://github.com/${repository}@`));
  const revision = dependency?.digest?.gitCommit;
  return /^[a-f0-9]{40}$/u.test(revision ?? "") ? revision : undefined;
}
export function appliesToPackage(source, target) {
  if (source.name === target.name && /^[a-f0-9]{40}$/u.test(target.gitHead ?? "")) return true;
  if (source.name === "esbuild" && /^@esbuild\/(?:darwin-arm64|win32-x64)$/u.test(target.name) && source.version === target.version) return true;
  if (source.name === "@napi-rs/keyring" && /^@napi-rs\/keyring-(?:darwin-arm64|win32-x64-msvc)$/u.test(target.name) && source.version === target.version && Array.isArray(source.napi?.targets)) return true;
  if (source.name === target.name && source.version === target.version) return true;
  return target.name.startsWith(`${source.name}-`) && source.version === target.version && source.optionalDependencies?.[target.name] === target.version;
}

export async function recoverNotice(spec) {
  const at = spec.lastIndexOf("@"), name = spec.slice(0, at), version = spec.slice(at + 1);
  const registryUrl = `https://registry.npmjs.org/${name}/${version}`;
  const registryBytes = await get(registryUrl), metadata = JSON.parse(registryBytes);
  if (metadata.name !== name || metadata.version !== version) throw new Error("notice_source_registry_identity_mismatch");
  const repository = sourceRepository(metadata);
  if (!repository) return { component: spec, reason: "registry_has_no_supported_source_repository" };
  let revision = metadata.gitHead, provenance;
  if (!/^[a-f0-9]{40}$/u.test(revision ?? "") && metadata.dist.attestations?.url) {
    const bytes = await get(metadata.dist.attestations.url, true);
    if (bytes) for (const attestation of JSON.parse(bytes).attestations ?? []) {
      if (attestation.predicateType !== "https://slsa.dev/provenance/v1") continue;
      const statement = JSON.parse(Buffer.from(attestation.bundle.dsseEnvelope.payload, "base64"));
      revision = statementRevision(statement, metadata);
      provenance = { url: metadata.dist.attestations.url, sha256: sha256(bytes), statement, verification: "Retrieved npm registry provenance statement; signature verification is not asserted by this collector." };
    }
  }
  if (!/^[a-f0-9]{40}$/u.test(revision ?? "")) return { component: spec, reason: "registry_has_no_exact_source_revision" };
  const directory = metadata.repository?.directory;
  const platformDirectory = /@napi-rs\/(?:canvas|keyring)-(.+)$/u.exec(name)?.[1];
  const packagePaths = [...new Set([directory ? `${directory}/package.json` : undefined, platformDirectory ? `npm/${platformDirectory}/package.json` : undefined, name === "remark-math" ? "packages/remark-math/package.json" : undefined, name === "standardwebhooks" ? "libraries/javascript/package.json" : undefined, name.startsWith("@esbuild/") ? "npm/esbuild/package.json" : undefined, "package.json"].filter(Boolean))];
  let sourcePackage;
  for (const path of packagePaths) {
    const url = `https://raw.githubusercontent.com/${repository}/${revision}/${path}`, bytes = await get(url, true);
    if (bytes && appliesToPackage(JSON.parse(bytes), metadata)) { sourcePackage = { path, url, sha256: sha256(bytes), gitBlob: gitBlob(bytes), contentBase64: bytes.toString("base64") }; break; }
  }
  if (!sourcePackage) return { component: spec, reason: "source_package_identity_does_not_match_published_version", repository, revision };
  const ancestors = [];
  for (let path = dirname(sourcePackage.path); ; path = dirname(path)) { ancestors.push(path === "." ? "" : `${path}/`); if (path === ".") break; }
  let license;
  for (const prefix of ancestors) {
    const names = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md", "License", "COPYING", "LICENSE-MIT", "LICENSE-MIT.txt", "License.md", "license.txt", "LICENCE", "COPYING.md"];
    const found = await Promise.all(names.map(async name => { const path = `${prefix}${name}`, url = `https://raw.githubusercontent.com/${repository}/${revision}/${path}`; const bytes = await get(url, true); return bytes ? { path, url, sha256: sha256(bytes), gitBlob: gitBlob(bytes), contentBase64: bytes.toString("base64") } : undefined; }));
    license = found.find(Boolean);
    if (license) break;
  }
  if (!license) return { component: spec, reason: "exact_revision_license_text_missing", repository, revision };
  return { name, version, license: metadata.license, registry: { url: registryUrl, sha256: sha256(registryBytes), integrity: metadata.dist.integrity, tarball: metadata.dist.tarball, gitHead: metadata.gitHead ?? null }, repository, revision, provenance: provenance ?? null, sourcePackage, licenseText: license,
    scope: "Original notice restoration for the exact npm package revision only. Native/vendor and corresponding-source obligations are separate." };
}

export async function recoverCurrentNotices(root = repositoryRoot) {
  const closure = collectInstalledClosure(root, process.platform === "win32" ? "win32-x64" : "darwin-arm64");
  const wanted = new Set();
  for (const { path, metadata } of closure.packages) {
    if (metadata.name.startsWith("@ling-stack/")) continue;
    if (!readdirSync(path).some(name => /^(?:licen[cs]e|copying|copyright|notice)(?:[._-]|$)/iu.test(name))) wanted.add(`${metadata.name}@${metadata.version}`);
  }
  for (const key of lockedPackageKeys(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"))) if (/^@(?:napi-rs\/(?:canvas|keyring)-win32-x64-msvc|esbuild\/win32-x64)@/u.test(key)) wanted.add(key);
  const entries = [], unresolved = [];
  for (const spec of [...wanted].sort()) {
    const result = await recoverNotice(spec);
    (result.licenseText ? entries : unresolved).push(result);
    process.stderr.write(`${spec}: ${result.licenseText ? "exact notice recovered" : result.reason}\n`);
  }
  return { schemaVersion: 1, scope: "Exact current npm revisions only; original texts recovered from registry gitHead or subject-matched npm provenance and matching source package identity. No native/vendor clearance or legal approval.", entries, unresolved };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await recoverCurrentNotices();
  writeFileSync(new URL("./notice-sources.json", import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
}
