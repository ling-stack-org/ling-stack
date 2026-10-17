import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyExactReleaseNoticeProof, verifyGitHubNoticeFile, safeNoticeSourcePath } from "./notice-source-provenance.mjs";

const lock = JSON.parse(await readFile(new URL("./upstream-lock.json", import.meta.url), "utf8"));
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const noticeNames = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "COPYING", "LICENSE-MIT", "README.md"];
const releaseSources = JSON.parse(await readFile(new URL("./exact-release-notice-sources.json", import.meta.url), "utf8")).entries;
function githubRepository(value) {
  const url = typeof value === "string" ? value : value?.url;
  if (typeof url !== "string") return undefined;
  return /(?:github\.com[/:]|^github:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:$|[#/])/.exec(url)?.[1];
}
function githubJson(path) {
  return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", timeout: 30_000,
    maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
}
export async function registryMetadata(name, version) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`registry_http_${response.status}`);
  const parts = []; let length = 0;
  for await (const part of response.body) {
    length += part.length;
    if (length > 1024 * 1024) throw new Error("registry_metadata_too_large");
    parts.push(part);
  }
  const bytes = Buffer.concat(parts);
  const metadata = JSON.parse(bytes.toString("utf8"));
  if (metadata.name !== name || metadata.version !== version) throw new Error("registry_identity_mismatch");
  return { metadata, registry: { url, checksum: checksum(bytes), gitHead: metadata.gitHead ?? null,
    repository: metadata.repository ?? null, integrity: metadata.dist?.integrity ?? null } };
}

// Collect candidate texts only. An explicit reviewed catalog controls installation.
export async function collectGstackThirdPartyNoticeSources({ auditPath, outputPath, onProgress = () => {},
  registryReader = registryMetadata, githubReader = githubJson, releaseTagSources = releaseSources }) {
  const auditBytes = await readFile(auditPath);
  const audit = JSON.parse(auditBytes.toString("utf8"));
  if (audit.schemaVersion !== 1 || !Array.isArray(audit.packages) || !Array.isArray(audit.blockers)) throw new Error("notice_source_audit_invalid");
  const missingPaths = new Set(audit.blockers.filter(b => b.code === "dependency_notice_missing").map(b => b.path));
  const packages = [...new Map(audit.packages.filter(p => missingPaths.has(p.path)).map(p => [`${p.name}@${p.version}`, p])).values()]
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en"));
  const output = resolve(outputPath);
  if (await lstat(output).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("notice_source_output_exists");
  const sources = new Map();
  const entries = [];
  for (const pkg of packages) {
    const entry = { name: pkg.name, version: pkg.version, license: pkg.license, status: "unresolved" };
    try {
      const { metadata, registry } = await registryReader(pkg.name, pkg.version);
      if (metadata.name !== pkg.name || metadata.version !== pkg.version) throw new Error("registry_identity_mismatch");
      entry.registry = registry;
      const repository = githubRepository(metadata.repository);
      if (!repository) throw new Error("notice_source_repository_unresolved");
      let sourceRevision = metadata.gitHead;
      let revisionProof;
      if (!/^[a-f0-9]{40}$/i.test(sourceRevision ?? "")) {
        const release = releaseTagSources.find(r => r.name === pkg.name && r.version === pkg.version);
        if (!release || release.repository.toLowerCase() !== repository.toLowerCase() || release.license !== pkg.license ||
          !/^[a-f0-9]{40}$/.test(release.revision) || !safeNoticeSourcePath(release.packagePath)) throw new Error("notice_source_exact_revision_missing");
        const ref = await githubReader(`repos/${repository}/git/ref/tags/${release.tag}`);
        const refBytes = Buffer.from(JSON.stringify(ref));
        const data = await githubReader(`repos/${repository}/contents/${release.packagePath}?ref=${release.revision}`);
        const packageBytes = verifyGitHubNoticeFile(data);
        revisionProof = { kind: "exact-version-tag", repository, tag: release.tag, revision: release.revision,
          refChecksum: checksum(refBytes), refContentBase64: refBytes.toString("base64"),
          packagePath: release.packagePath, packageGitBlob: data.sha, packageChecksum: checksum(packageBytes),
          packageContentBase64: packageBytes.toString("base64") };
        verifyExactReleaseNoticeProof({ proof: revisionProof, repository, revision: release.revision,
          name: pkg.name, version: pkg.version, license: pkg.license });
        sourceRevision = release.revision;
      }
      let source;
      const directory = typeof metadata.repository === "object" ? metadata.repository.directory : undefined;
      const prefixes = ["", ...(typeof directory === "string" && /^[A-Za-z0-9_./-]+$/.test(directory) && !directory.split("/").includes("..") ? [`${directory}/`] : [])];
      for (const prefix of prefixes) {
        for (const name of noticeNames) {
          const path = `${prefix}${name}`;
          const key = `${repository}@${sourceRevision}:${path}`;
          if (!sources.has(key)) {
            try {
              const data = await githubReader(`repos/${repository}/contents/${path}?ref=${sourceRevision}`);
              const bytes = verifyGitHubNoticeFile(data);
              sources.set(key, { repository, revision: sourceRevision, path, gitBlob: data.sha,
                checksum: checksum(bytes), contentBase64: bytes.toString("base64") });
            } catch (error) {
              if (/HTTP 404/.test(error.stderr?.toString() ?? "")) sources.set(key, null);
              else throw error;
            }
          }
          if (sources.get(key)) { source = sources.get(key); break; }
        }
        if (source) break;
      }
      if (!source) throw new Error("notice_source_text_not_found");
      entry.source = { ...source, ...(revisionProof ? { revisionProof } : {}) };
      entry.status = "candidate";
    } catch (error) {
      entry.reason = error.code ?? error.message;
    }
    entries.push(entry);
    onProgress(`${entry.name}@${entry.version}: ${entry.status}${entry.reason ? ` (${entry.reason})` : ""}`);
  }
  const result = { schemaVersion: 1, reviewStatus: "candidate-only", releaseEligible: false,
    upstreamRevision: lock.revision, upstreamVersion: lock.version, inputAuditChecksum: checksum(auditBytes),
    uniquePackageCount: packages.length, installedMissingNoticeCount: missingPaths.size, entries };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [auditPath, outputPath] = process.argv.slice(2);
  if (!auditPath || !outputPath) throw new Error("Usage: collect-third-party-notice-sources.mjs <dependency-audit> <new-candidate-output>");
  const result = await collectGstackThirdPartyNoticeSources({ auditPath, outputPath,
    onProgress: message => process.stderr.write(`${message}\n`) });
  process.stdout.write(`${JSON.stringify({ candidates: result.entries.filter(e => e.status === "candidate").length,
    unresolved: result.entries.filter(e => e.status !== "candidate").length, outputPath })}\n`);
}
