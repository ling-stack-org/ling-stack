import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { validateBrowserArchivePlan, verifyBrowserArchiveSource } from "./collect-browser-archives.mjs";
import { inspectBrowserZip } from "./inspect-browser-zip.mjs";
import { publishStagedDirectory } from "./publish-staged-directory.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const digest = value => /^sha256:[a-f0-9]{64}$/u.test(value ?? "");
const fail = reason => { throw new Error(`gstack_browser_${reason}`); };
const collectorNames = ["collect-browser-archives.mjs", "upstream-lock.json", "runtime-dependency-audit.mjs",
  "build-native-runtime.mjs", "public-domain-package-review.mjs", "reviewed-public-domain-packages.json", "publish-staged-directory.mjs"];
const inspectorNames = ["inspect-browser-archives.mjs", "inspect-browser-zip.mjs", "collect-browser-archives.mjs",
  "runtime-dependency-audit.mjs", "upstream-lock.json", "publish-staged-directory.mjs"];
const exists = path => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const contains = (root, path) => {
  const value = relative(root, path);
  return !value || !isAbsolute(value) && value !== ".." && !value.startsWith("../") && !value.startsWith("..\\");
};
async function inspectorInputs() {
  return Promise.all(inspectorNames.map(async path => ({ path, checksum: checksum(await readFile(new URL(path, import.meta.url))) })));
}
async function fileHash(path, maximum) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > maximum || await realpath(path) !== path) fail("inspection_input_invalid");
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const bytes of createReadStream(path)) {
    sizeBytes += bytes.length;
    if (sizeBytes > maximum) fail("inspection_input_too_large");
    hash.update(bytes);
  }
  if (sizeBytes !== stat.size) fail("inspection_input_changed");
  return { checksum: `sha256:${hash.digest("hex")}`, sizeBytes };
}

export async function verifyBrowserArchiveCandidates({ resourceStagePath, archivePath,
  expectedResourceStageChecksum, expectedArchiveReceiptChecksum, target }) {
  if (!digest(expectedArchiveReceiptChecksum)) fail("inspection_receipt_required");
  const requested = resolve(archivePath), stat = await lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("inspection_root_invalid");
  const root = await realpath(requested), receiptPath = join(root, "browser-archives.json");
  if ((await fileHash(receiptPath, 1024 * 1024)).checksum !== expectedArchiveReceiptChecksum) fail("inspection_receipt_mismatch");
  const receiptBytes = await readFile(receiptPath);
  if (checksum(receiptBytes) !== expectedArchiveReceiptChecksum) fail("inspection_receipt_mismatch");
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  if (receipt.schemaVersion !== 1 || receipt.deliveryStage !== "browser-archive-candidates" || receipt.reviewStatus !== "candidate-only" ||
    receipt.releaseEligible !== false || receipt.hostAcceptance !== "pending" || receipt.packageAcceptance !== "pending" ||
    !isDeepStrictEqual(receipt.target, target) || receipt.source?.resourceStageChecksum !== expectedResourceStageChecksum ||
    !Array.isArray(receipt.archives)) fail("inspection_identity_mismatch");
  const source = await verifyBrowserArchiveSource({ resourceStagePath, expectedResourceStageChecksum, target });
  if (!isDeepStrictEqual(receipt.source, source.provenance)) fail("inspection_source_mismatch");
  const lock = JSON.parse(await readFile(new URL("./upstream-lock.json", import.meta.url), "utf8"));
  if (receipt.upstreamRevision !== lock.revision || receipt.upstreamVersion !== lock.version) fail("inspection_identity_mismatch");
  const inputs = receipt.collectorInputChecksums;
  if (!Array.isArray(inputs) || inputs.length !== collectorNames.length ||
    !isDeepStrictEqual(inputs.map(input => input.path).sort(), [...collectorNames].sort())) fail("inspection_collector_invalid");
  for (const input of inputs) {
    if (!digest(input.checksum) || checksum(await readFile(new URL(input.path, import.meta.url))) !== input.checksum) fail("inspection_collector_changed");
  }
  const plan = validateBrowserArchivePlan(receipt.archives.map(archive => ({ name: archive.name, downloadURLs: [archive.url] })), source, target);
  for (const expected of plan) {
    const archive = receipt.archives.find(entry => entry.name === expected.name);
    for (const [key, value] of Object.entries(expected)) if (archive[key] !== value) fail("inspection_archive_identity_mismatch");
    if (!digest(archive.checksum) || !Number.isSafeInteger(archive.sizeBytes)) fail("inspection_archive_identity_mismatch");
    const file = await fileHash(join(root, archive.filename), 512 * 1024 * 1024);
    if (file.checksum !== archive.checksum || file.sizeBytes !== archive.sizeBytes) fail("inspection_archive_changed");
  }
  if (!isDeepStrictEqual((await readdir(root)).sort(), ["browser-archives.json", ...plan.map(entry => entry.filename)].sort())) fail("inspection_extra_artifacts");
  return { root, source, receipt };
}

function requiredArtifacts(archive, target) {
  const slug = { "darwin-arm64": "mac-arm64", "darwin-x64": "mac-x64", "win32-x64": "win64" }[`${target.platform}-${target.arch}`];
  if (!slug) fail("inspection_target_invalid");
  if (archive.name === "ffmpeg") return { executable: target.platform === "darwin" ? "ffmpeg-mac" : "ffmpeg-win64.exe", notice: "COPYING.LGPLv2.1" };
  if (archive.name === "chromium-headless-shell") {
    const prefix = `chrome-headless-shell-${slug}`;
    return { prefix, executable: `${prefix}/chrome-headless-shell${target.platform === "win32" ? ".exe" : ""}`, notice: `${prefix}/LICENSE.headless_shell` };
  }
  const prefix = `chrome-${slug}`;
  // The Windows Chrome for Testing archive carries ABOUT, not a Widevine
  // license. This original copyright/reference material grants no approval.
  if (target.platform === "win32") return { prefix, executable: `${prefix}/chrome.exe`, notice: `${prefix}/ABOUT` };
  const framework = `${prefix}/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework`;
  const version = `${framework}/Versions/${archive.browserVersion}`;
  return { prefix, executable: `${prefix}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    notice: `${version}/Libraries/WidevineCdm/LICENSE`, library: `${version}/Google Chrome for Testing Framework`,
    currentLink: `${framework}/Versions/Current`, currentTarget: version };
}

export function validateRequiredBrowserArtifacts(archive, result, target) {
  const required = requiredArtifacts(archive, target), executable = result.members.find(member => member.path === required.executable);
  if (executable?.kind !== "file" || executable.native?.fileType !== "executable" ||
    !executable.native.architectures.includes(target.arch) || target.platform === "darwin" && !(executable.mode & 0o111)) fail("inspection_executable_missing");
  if (!result.notices.some(notice => notice.path === required.notice)) fail("inspection_notice_missing");
  if (required.library) {
    const library = result.members.find(member => member.path === required.library);
    const current = result.members.find(member => member.path === required.currentLink);
    if (library?.native?.fileType !== "library" || !library.native.architectures.includes(target.arch) ||
      current?.kind !== "link" || current.resolvedTarget !== required.currentTarget || current.targetKind !== "directory") fail("inspection_framework_invalid");
  }
  return { executablePath: required.executable, requiredNoticePath: required.notice,
    ...(required.library ? { frameworkLibraryPath: required.library, frameworkCurrentPath: required.currentLink } : {}) };
}

async function destination(path) {
  const parts = [basename(path)]; let parent = dirname(path);
  while (!await exists(parent)) { parts.unshift(basename(parent)); parent = dirname(parent); }
  const base = await realpath(parent);
  if (!(await lstat(base)).isDirectory()) fail("inspection_output_parent_invalid");
  return join(base, ...parts);
}

// Only inspect archive payloads and emit candidate evidence. No member is
// extracted, executable approval granted, or user browser/profile modified.
export async function inspectGstackBrowserArchives({ outputPath, onProgress = () => {}, ...options }) {
  const verified = await verifyBrowserArchiveCandidates(options), inputs = await inspectorInputs();
  const requested = resolve(outputPath);
  if (await exists(requested)) fail("inspection_output_exists");
  const output = await destination(requested);
  if ([verified.root, verified.source.root].some(root => contains(root, output) || contains(output, root))) fail("inspection_output_overlap");
  const require = createRequire(join(verified.source.root, "runtime/package.json"));
  const { yauzl } = require(join(verified.source.packagePath, "lib/utilsBundle.js"));
  const archives = [], notices = [];
  for (const archive of verified.receipt.archives) {
    await onProgress(`inspect every payload: ${archive.name}`);
    const result = await inspectBrowserZip({ zipPath: join(verified.root, archive.filename), yauzl, target: options.target,
      rootPrefix: requiredArtifacts(archive, options.target).prefix });
    const required = validateRequiredBrowserArtifacts(archive, result, options.target);
    archives.push({ name: archive.name, archiveChecksum: archive.checksum, sizeBytes: archive.sizeBytes,
      totalUncompressedBytes: result.totalBytes, memberCount: result.members.length,
      nativeMemberCount: result.members.filter(member => member.native).length,
      linkCount: result.members.filter(member => member.kind === "link").length, ...required, members: result.members });
    notices.push(...result.notices.map(notice => ({ archive: archive.name, ...notice })));
  }
  await verifyBrowserArchiveCandidates(options);
  if (!isDeepStrictEqual(await inspectorInputs(), inputs)) fail("inspection_inputs_changed");
  const identity = { upstreamRevision: verified.receipt.upstreamRevision, upstreamVersion: verified.receipt.upstreamVersion,
    target: options.target, archiveReceiptChecksum: options.expectedArchiveReceiptChecksum,
    source: verified.source.provenance, inspectorInputChecksums: inputs };
  const inventoryBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, ...identity, archives }, null, 2)}\n`);
  const noticeBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, reviewStatus: "candidate-only", ...identity, notices }, null, 2)}\n`);
  const receipt = { schemaVersion: 1, deliveryStage: "browser-archive-member-inspection", reviewStatus: "candidate-only",
    releaseEligible: false, hostAcceptance: "pending", packageAcceptance: "pending", ...identity,
    inventoryChecksum: checksum(inventoryBytes), noticeCandidatesChecksum: checksum(noticeBytes),
    memberCount: archives.reduce((sum, archive) => sum + archive.memberCount, 0),
    totalUncompressedBytes: archives.reduce((sum, archive) => sum + archive.totalUncompressedBytes, 0),
    nativeMemberCount: archives.reduce((sum, archive) => sum + archive.nativeMemberCount, 0),
    linkCount: archives.reduce((sum, archive) => sum + archive.linkCount, 0), noticeCount: notices.length,
    pendingGates: ["exact-archive-license-review", "owned-resource-materialization", "real-browser-execution", "installed-client-acceptance"] };
  await mkdir(dirname(output), { recursive: true });
  const temporary = await mkdtemp(join(dirname(output), ".gstack-browser-inspection-"));
  try {
    const candidate = join(temporary, "candidate"); await mkdir(candidate);
    for (const [name, bytes] of [["browser-member-inventory.json", inventoryBytes], ["browser-license-candidates.json", noticeBytes],
      ["browser-member-inspection.json", `${JSON.stringify(receipt, null, 2)}\n`]]) await writeFile(join(candidate, name), bytes, { flag: "wx" });
    await verifyBrowserArchiveCandidates(options);
    if (!isDeepStrictEqual(await inspectorInputs(), inputs)) fail("inspection_inputs_changed");
    await publishStagedDirectory(candidate, output);
    return receipt;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [resourceStagePath, archivePath, outputPath, expectedResourceStageChecksum, expectedArchiveReceiptChecksum] = process.argv.slice(2);
  if (!resourceStagePath || !archivePath || !outputPath) throw new Error("Usage: inspect-browser-archives.mjs <resource-stage> <archives> <new-output> <detached-resource-sha256> <detached-archive-receipt-sha256>");
  const receipt = await inspectGstackBrowserArchives({ resourceStagePath, archivePath, outputPath,
    expectedResourceStageChecksum, expectedArchiveReceiptChecksum, target: { platform: process.platform, arch: process.arch },
    onProgress: message => process.stderr.write(`${message}\n`) });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}
