import { readPublicGstackGithubMetadata } from "./public-github-metadata.mjs";
import { managedResourceWrite, resourceCheckpoint } from "./resource-workspace.mjs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBrowserArchiveSource } from "./collect-browser-archives.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const digest = value => /^sha256:[a-f0-9]{64}$/.test(value ?? "");
const commit = value => /^[a-f0-9]{40}$/.test(value ?? "");
const fail = reason => { throw new Error(`gstack_ungoogled_${reason}`); };
const exists = path => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const overlap = (root, path) => {
  const r = relative(root, path);
  return !r || !isAbsolute(r) && r !== ".." && !r.startsWith("../") && !r.startsWith("..\\");
};
const inputNames = ["collect-ungoogled-chromium.mjs", "ungoogled-chromium-candidate.json", "collect-browser-archives.mjs",
  "runtime-dependency-audit.mjs", "upstream-lock.json", "public-github-metadata.mjs"];
const inputRecords = () => Promise.all(inputNames.map(async path => ({ path, checksum: checksum(await readFile(new URL(path, import.meta.url))) })));

export function validateUngoogledChromiumPin(pin) {
  if (pin?.schemaVersion !== 1 || pin.reviewStatus !== "candidate-only" || pin.releaseEligible !== false ||
    pin.target?.platform !== "darwin" || pin.target.arch !== "arm64" ||
    pin.repository !== "ungoogled-software/ungoogled-chromium-macos" ||
    pin.commonRepository !== "ungoogled-software/ungoogled-chromium" ||
    !commit(pin.revision) || !commit(pin.commonRevision) || !/^\d+\.\d+\.\d+\.\d+$/.test(pin.version ?? "") ||
    pin.tag !== `${pin.version}-1.1` || !Number.isSafeInteger(pin.buildRunId) || pin.buildRunId < 1 ||
    !Number.isSafeInteger(pin.asset?.id) || pin.asset.id < 1 ||
    pin.asset.name !== `ungoogled-chromium_${pin.tag}_arm64-macos.dmg` || !digest(pin.asset.checksum) ||
    !Number.isSafeInteger(pin.asset.sizeBytes) || pin.asset.sizeBytes < 512 || pin.asset.sizeBytes > 512 * 1024 * 1024 ||
    !Array.isArray(pin.references) || pin.references.length !== 8) fail("pin_invalid");
  const identities = new Set(), outputs = new Set();
  for (const r of pin.references) {
    const validRoot = r.repository === pin.repository && r.revision === pin.revision;
    const validCommon = r.repository === pin.commonRepository && r.revision === pin.commonRevision;
    if (!validRoot && !validCommon || !commit(r.blob) || !digest(r.checksum) ||
      !Number.isSafeInteger(r.sizeBytes) || r.sizeBytes < 1 || r.sizeBytes > 256 * 1024 ||
      typeof r.path !== "string" || !/^[a-zA-Z0-9_./-]+$/.test(r.path) ||
      r.path.split("/").some(p => !p || p === "." || p === "..") ||
      !/^[a-zA-Z0-9_.-]+\.txt$/.test(r.output ?? "") || outputs.has(r.output) || identities.has(`${r.repository}:${r.path}`)) fail("pin_invalid");
    outputs.add(r.output); identities.add(`${r.repository}:${r.path}`);
  }
  const expected = [[pin.repository, ["flags.macos.gn", "build.sh", "LICENSE", ".github/workflows/build.yml", ".github/scripts/github_build.sh"]],
    [pin.commonRepository, ["flags.gn", "chromium_version.txt", "LICENSE"]]];
  for (const [repo, paths] of expected) for (const path of paths) if (!identities.has(`${repo}:${path}`)) fail("pin_invalid");
  return `https://github.com/${pin.repository}/releases/download/${pin.tag}/${pin.asset.name}`;
}

async function github(endpoint) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await readPublicGstackGithubMetadata(endpoint);
    } catch (error) {
      const transient = /ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/.test(error.cause?.code ?? error.code ?? "")
        || /^gstack_github_metadata_http_50[234]$/.test(error.message);
      if (!transient || attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt ? 1000 : 250));
    }
  }
}

export async function verifyUngoogledSourceRecords(pin, reader = r => github(`repos/${r.repository}/contents/${r.path}?ref=${r.revision}`)) {
  validateUngoogledChromiumPin(pin);
  const records = [];
  for (const r of pin.references) {
    const response = await reader(r);
    if (response.sha !== r.blob || response.encoding !== "base64" || response.size !== r.sizeBytes ||
      typeof response.content !== "string" || response.content.length > 512 * 1024) fail("source_identity_mismatch");
    const encoded = response.content.replace(/[\r\n]/g, ""), bytes = Buffer.from(encoded, "base64");
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (bytes.toString("base64") !== encoded || bytes.length !== r.sizeBytes || blob !== r.blob ||
      checksum(bytes) !== r.checksum || bytes.includes(0) || !Buffer.from(bytes.toString("utf8")).equals(bytes)) fail("source_bytes_mismatch");
    records.push({ ...r, bytes });
  }
  return records;
}

export async function verifyUngoogledReleaseIdentity(pin, reader = github) {
  const url = validateUngoogledChromiumPin(pin);
  const tag = await reader(`repos/${pin.repository}/git/ref/tags/${pin.tag}`);
  const release = await reader(`repos/${pin.repository}/releases/tags/${pin.tag}`);
  const run = await reader(`repos/${pin.repository}/actions/runs/${pin.buildRunId}`);
  const tree = await reader(`repos/${pin.repository}/git/trees/${pin.revision}?recursive=1`);
  const asset = release.assets?.filter(a => a.id === pin.asset.id);
  const common = tree.tree?.filter(e => e.path === "ungoogled-chromium" && e.mode === "160000");
  if (tag.ref !== `refs/tags/${pin.tag}` || tag.object?.type !== "commit" || tag.object.sha !== pin.revision ||
    release.tag_name !== pin.tag || release.draft !== false || asset?.length !== 1 ||
    asset[0].name !== pin.asset.name || asset[0].size !== pin.asset.sizeBytes || asset[0].digest !== pin.asset.checksum ||
    asset[0].browser_download_url !== url || run.id !== pin.buildRunId || run.head_sha !== pin.revision ||
    run.status !== "completed" || run.conclusion !== "success" || run.path !== ".github/workflows/build.yml" ||
    tree.truncated !== false || common?.length !== 1 || common[0].sha !== pin.commonRevision) fail("release_identity_mismatch");
  for (const r of pin.references.filter(r => r.repository === pin.repository)) {
    const entries = tree.tree.filter(e => e.path === r.path && e.type === "blob");
    if (entries.length !== 1 || entries[0].sha !== r.blob) fail("source_tree_mismatch");
  }
  return { tag: { ref: tag.ref, revision: tag.object.sha }, asset: { ...pin.asset, url },
    build: { id: run.id, revision: run.head_sha, conclusion: run.conclusion, path: run.path },
    common: { repository: pin.commonRepository, revision: common[0].sha } };
}

function validEndpoint(url, firstUrl) {
  return url.protocol === "https:" && !url.username && !url.password && !url.port &&
    (url.href === firstUrl || url.hostname === "release-assets.githubusercontent.com" &&
      url.pathname.startsWith("/github-production-release-asset/") && url.pathname.length > 40);
}

export async function downloadUngoogledChromium(pin, outputPath, request = fetch, onProgress = () => {}) {
  const firstUrl = validateUngoogledChromiumPin(pin);
  let endpoint = new URL(firstUrl), response;
  for (let count = 0; count < 6; count++) {
    if (!validEndpoint(endpoint, firstUrl)) fail("download_endpoint_invalid");
    response = await request(endpoint.href, { redirect: "manual", signal: AbortSignal.timeout(600_000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location"); await response.body?.cancel();
    if (!location || count === 5) fail("download_redirect_invalid");
    endpoint = new URL(location, endpoint);
  }
  if (!response.ok || !response.body) fail(`download_http_${response.status}`);
  if (response.headers.get("content-length") !== String(pin.asset.sizeBytes) || response.headers.get("content-encoding") !== null) {
    await response.body.cancel(); fail("download_identity_mismatch");
  }
  let file;
  try { file = await open(outputPath, "wx", 0o600); } catch (error) { await response.body.cancel(); throw error; }
  const owned = await file.stat(), hash = createHash("sha256");
  let sizeBytes = 0, trailer = Buffer.alloc(0), complete = false, nextProgressBytes = 16 * 1024 * 1024;
  try {
    for await (const part of response.body) {
      sizeBytes += part.length;
      if (sizeBytes > pin.asset.sizeBytes) fail("archive_too_large");
      hash.update(part); trailer = Buffer.concat([trailer, part]).subarray(-512); await file.writeFile(part);
      if (sizeBytes >= nextProgressBytes) {
        onProgress({ sizeBytes, totalBytes: pin.asset.sizeBytes }); nextProgressBytes += 16 * 1024 * 1024;
      }
    }
    if (sizeBytes !== pin.asset.sizeBytes) fail("archive_truncated");
    if (trailer.length !== 512 || trailer.toString("ascii", 0, 4) !== "koly") fail("archive_not_dmg");
    if (`sha256:${hash.digest("hex")}` !== pin.asset.checksum) fail("archive_checksum_mismatch");
    await file.sync(); complete = true;
  } finally {
    try {
      if (!complete) {
        const current = await lstat(outputPath).catch(() => undefined);
        if (current?.isFile() && !current.isSymbolicLink() && current.ino === owned.ino && current.dev === owned.dev) await unlink(outputPath);
      }
    } finally { await file.close(); }
  }
  return { checksum: pin.asset.checksum, sizeBytes, endpoint: `${endpoint.origin}${endpoint.pathname}` };
}

async function verifyArchive(path, pin) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pin.asset.sizeBytes || await realpath(path) !== path) fail("archive_file_invalid");
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  if (`sha256:${hash.digest("hex")}` !== pin.asset.checksum) fail("archive_checksum_mismatch");
}

// Retain a non-executing DMG and source evidence. Never mount, install, modify,
// or publish it here; native/compiled-notice and security reviews are separate.
export async function collectUngoogledChromiumCandidate({ resourceStagePath, expectedResourceStageChecksum, outputPath,
  onProgress = () => {} }) {
  const pinBytes = await readFile(new URL("./ungoogled-chromium-candidate.json", import.meta.url)), pin = JSON.parse(pinBytes);
  validateUngoogledChromiumPin(pin);
  if (process.platform !== pin.target.platform || process.arch !== pin.target.arch) fail("requires_matching_host");
  const options = { resourceStagePath, expectedResourceStageChecksum, target: pin.target };
  const source = await verifyBrowserArchiveSource(options), inputs = await inputRecords();
  if (inputs.find(r => r.path === "ungoogled-chromium-candidate.json").checksum !== checksum(pinBytes)) fail("inputs_changed");
  const requested = resolve(outputPath);
  if (await exists(requested)) fail("output_exists");
  const parent = await realpath(dirname(requested)), output = join(parent, basename(requested));
  if (overlap(source.root, output) || overlap(output, source.root)) fail("output_overlap");
  const lease = await managedResourceWrite(output, { kind: "browser", additionalBytes: pin.asset.sizeBytes + 256 * 1024 ** 2 });
  onProgress("verify exact GitHub asset, tag, successful build, submodule and original source bytes");
  const identity = await verifyUngoogledReleaseIdentity(pin), references = await verifyUngoogledSourceRecords(pin);
  const version = references.find(r => r.repository === pin.commonRepository && r.path === "chromium_version.txt");
  if (version.bytes.toString("utf8").trim() !== pin.version) fail("source_version_mismatch");
  const temporary = await realpath(await mkdtemp(join(parent, ".gstack-ungoogled-candidate-")));
  let reserved = false;
  try {
    const candidate = join(temporary, "candidate"); await mkdir(candidate);
    const archivePath = join(candidate, pin.asset.name);
    onProgress("download immutable DMG candidate and independently rehash it without mounting or executing");
    const archive = await downloadUngoogledChromium(pin, archivePath, fetch,
      ({ sizeBytes, totalBytes }) => onProgress(`candidate archive bytes ${sizeBytes}/${totalBytes}`));
    await verifyArchive(archivePath, pin); await verifyBrowserArchiveSource(options);
    if (JSON.stringify(identity) !== JSON.stringify(await verifyUngoogledReleaseIdentity(pin))) fail("release_changed");
    const receipt = { schemaVersion: 1, deliveryStage: "ungoogled-chromium-archive-candidate", reviewStatus: "candidate-only",
      releaseEligible: false, hostAcceptance: "pending", packageAcceptance: "pending", target: pin.target,
      repository: pin.repository, revision: pin.revision, browserVersion: pin.version, source: source.provenance,
      identity, pinChecksum: checksum(pinBytes), inputChecksums: inputs, archive: { ...archive, path: pin.asset.name },
      references: references.map(({ bytes, ...r }) => r),
      pendingGates: ["readonly-dmg-member-and-native-inspection", "complete-compiled-notices-and-codec-review",
        "actual-widevine-component-review", "safe-browsing-and-patch-level-security-review", "owned-materialization",
        "headed-headless-extension-recording-equivalence", "installed-client-acceptance"] };
    for (const r of references) await writeFile(join(candidate, r.output), r.bytes, { flag: "wx", mode: 0o600 });
    await writeFile(join(candidate, "ungoogled-candidate.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await verifyArchive(archivePath, pin); await verifyBrowserArchiveSource(options);
    if (JSON.stringify(inputs) !== JSON.stringify(await inputRecords())) fail("inputs_changed");
    await resourceCheckpoint(lease.root);
    await mkdir(output); reserved = true; await rename(candidate, output); reserved = false;
    return receipt;
  } finally {
    try { if (reserved) await rmdir(output); }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [resourceStagePath, outputPath, expectedResourceStageChecksum] = process.argv.slice(2);
  if (!resourceStagePath || !outputPath || !expectedResourceStageChecksum) throw new Error("Usage: collect-ungoogled-chromium.mjs <resource-stage> <new-output> <detached-resource-sha256>");
  const receipt = await collectUngoogledChromiumCandidate({ resourceStagePath, outputPath, expectedResourceStageChecksum,
    onProgress: message => process.stderr.write(`${message}\n`) });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}
