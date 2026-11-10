import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeNoticeSourcePath, verifyGitHubNoticeFile } from "./notice-source-provenance.mjs";

export const REVIEWED_PUBLIC_DOMAIN_CATALOG_CHECKSUM = "sha256:7439eb28fb40913f52c90692074579b2cc61c0223bf7ca84dc7129b896e8ab8b";
const defaultCatalogPath = fileURLToPath(new URL("./reviewed-public-domain-packages.json", import.meta.url));
const lock = JSON.parse(await readFile(new URL("./upstream-lock.json", import.meta.url), "utf8"));
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const digest = value => /^sha256:[a-f0-9]{64}$/.test(value ?? "");
const revision = value => /^[a-f0-9]{40}$/.test(value ?? "");
let defaultReviews;

function textBytes(value) {
  if (typeof value?.contentBase64 !== "string" || !digest(value.checksum)) throw new Error("gstack_public_domain_text_invalid");
  const bytes = Buffer.from(value.contentBase64, "base64");
  if (bytes.toString("base64") !== value.contentBase64 || !bytes.length || bytes.length > 256 * 1024 ||
    bytes.includes(0) || !Buffer.from(bytes.toString("utf8")).equals(bytes) || checksum(bytes) !== value.checksum) {
    throw new Error("gstack_public_domain_text_invalid");
  }
  return bytes;
}

function sourceBytes(value, expectedPath) {
  if (value?.path !== expectedPath || !revision(value.gitBlob)) throw new Error("gstack_public_domain_source_invalid");
  const bytes = textBytes(value);
  verifyGitHubNoticeFile({ type: "file", encoding: "base64", content: value.contentBase64, sha: value.gitBlob });
  return bytes;
}

function completeCc0Notice(bytes) {
  const text = bytes.toString("utf8").replace(/\s+/g, " ").trim();
  return text.startsWith("Creative Commons Legal Code CC0 1.0 Universal ") &&
    ["Statement of Purpose", "1. Copyright and Related Rights.", "2. Waiver.", "3. Public License Fallback.",
      "4. Limitations and Disclaimers.", "including without limitation commercial, advertising or promotional purposes",
      "No trademark or patent rights held by Affirmer are waived", "Creative Commons is not a party to this document"].every(part => text.includes(part));
}

// This immutable record classifies exact public-domain package artifacts only.
// It never changes the global SPDX allowlist or approves native/embedded releases.
export async function loadReviewedPublicDomainPackages({ catalogPath = defaultCatalogPath,
  expectedCatalogChecksum = REVIEWED_PUBLIC_DOMAIN_CATALOG_CHECKSUM } = {}) {
  const path = resolve(catalogPath), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path || stat.size > 2 * 1024 * 1024) throw new Error("gstack_public_domain_catalog_file_invalid");
  const bytes = await readFile(path);
  if (!digest(expectedCatalogChecksum) || checksum(bytes) !== expectedCatalogChecksum) throw new Error("gstack_public_domain_catalog_checksum_mismatch");
  const catalog = JSON.parse(bytes.toString("utf8"));
  if (catalog.schemaVersion !== 1 || catalog.reviewStatus !== "reviewed-exact-public-domain-packages" || catalog.releaseEligible !== false ||
    catalog.upstreamRevision !== lock.revision || catalog.upstreamVersion !== lock.version || !Array.isArray(catalog.entries) || !catalog.entries.length) {
    throw new Error("gstack_public_domain_catalog_invalid");
  }
  const result = new Map();
  for (const entry of catalog.entries) {
    const key = `${entry.name}@${entry.version}`, registry = entry.registry, source = entry.source;
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(entry.name ?? "") || !/^\d+\.\d+\.\d+$/.test(entry.version ?? "") ||
      entry.license !== "CC0-1.0" || result.has(key) || !Array.isArray(entry.installedFiles) ||
      registry?.url !== `https://registry.npmjs.org/${entry.name}/${entry.version}` || !digest(registry.checksum) ||
      !revision(registry.gitHead) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source?.repository ?? "") ||
      source.revision !== registry.gitHead || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(registry.integrity ?? "")) throw new Error("gstack_public_domain_entry_invalid");
    const url = typeof registry.repository === "string" ? registry.repository : registry.repository?.url;
    if (![ `https://github.com/${source.repository}`, `https://github.com/${source.repository}.git`,
      `git+https://github.com/${source.repository}.git` ].includes(url)) throw new Error("gstack_public_domain_repository_mismatch");
    const sourcePackage = JSON.parse(sourceBytes(source.package, "package.json").toString("utf8"));
    const notice = sourceBytes(source.notice, "LICENSE");
    const code = sourceBytes(source.code, "src/index.js");
    if (sourcePackage.name !== entry.name || sourcePackage.version !== entry.version || sourcePackage.license !== entry.license ||
      !completeCc0Notice(notice)) throw new Error("gstack_public_domain_source_identity_invalid");
    if (entry.tarball?.url !== `https://registry.npmjs.org/${entry.name}/-/${entry.name}-${entry.version}.tgz` ||
      entry.tarball.integrity !== registry.integrity || !digest(entry.tarball.checksum) || !Number.isSafeInteger(entry.tarball.sizeBytes) ||
      entry.tarball.sizeBytes <= 0 || entry.tarball.sizeBytes > 1024 * 1024) throw new Error("gstack_public_domain_tarball_invalid");
    const files = new Map();
    for (const file of entry.installedFiles) {
      if (!safeNoticeSourcePath(file.path) || files.has(file.path) || file.path.startsWith("node_modules/") ||
        !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) throw new Error("gstack_public_domain_artifact_invalid");
      const bytes = textBytes(file);
      if (bytes.length !== file.sizeBytes) throw new Error("gstack_public_domain_artifact_size_mismatch");
      files.set(file.path, bytes);
    }
    if (["package.json", "LICENSE", "README.md", "src/index.js", "src/index.d.ts"].some(path => !files.has(path)) ||
      !files.get("LICENSE").equals(notice) || !files.get("src/index.js").equals(code)) throw new Error("gstack_public_domain_artifacts_incomplete");
    const installed = JSON.parse(files.get("package.json").toString("utf8"));
    if (installed.name !== entry.name || installed.version !== entry.version || installed.license !== entry.license) {
      throw new Error("gstack_public_domain_artifact_identity_invalid");
    }
    result.set(key, entry);
  }
  return result;
}

async function ownFileInventoryMatches(root, expected, prefix = "", found = new Set()) {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (!prefix && entry.name === "node_modules") continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!safeNoticeSourcePath(path)) return false;
    if (entry.isDirectory()) {
      if (!await ownFileInventoryMatches(root, expected, path, found)) return false;
    } else if (entry.isFile()) {
      const file = expected.get(path), absolute = join(root, path), stat = await lstat(absolute);
      if (!file || !stat.isFile() || stat.isSymbolicLink() || stat.size !== file.sizeBytes || await realpath(absolute) !== absolute ||
        checksum(await readFile(absolute)) !== file.checksum) return false;
      found.add(path);
    } else return false;
  }
  return prefix ? true : found.size === expected.size;
}

export async function reviewExactPublicDomainRuntimePackage({ packageRoot, name, version, license }) {
  if (license !== "CC0-1.0") return undefined;
  defaultReviews ??= loadReviewedPublicDomainPackages();
  const entry = (await defaultReviews).get(`${name}@${version}`);
  if (!entry) return undefined;
  const root = resolve(packageRoot), stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) return undefined;
  const expected = new Map(entry.installedFiles.map(file => [file.path, file]));
  const matched = await ownFileInventoryMatches(root, expected).catch(error => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (!matched) return undefined;
  return { path: "LICENSE", checksum: entry.source.notice.checksum, method: "exact-reviewed-public-domain-package",
    catalogChecksum: REVIEWED_PUBLIC_DOMAIN_CATALOG_CHECKSUM, sourceRevision: entry.source.revision,
    installedFileCount: entry.installedFiles.length };
}
