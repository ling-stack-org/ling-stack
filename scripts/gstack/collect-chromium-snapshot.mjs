import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBrowserArchiveSource } from "./collect-browser-archives.mjs";
import { managedResourceWrite, resourceCheckpoint } from "./resource-workspace.mjs";
import { inspectBrowserZip } from "./inspect-browser-zip.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const digest = value => /^sha256:[a-f0-9]{64}$/.test(value ?? "");
const fail = reason => { throw new Error(`gstack_chromium_snapshot_${reason}`); };
const exists = path => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const inside = (root, path) => {
  const r = relative(root, path);
  return !r || !isAbsolute(r) && r !== ".." && !r.startsWith("../") && !r.startsWith("..\\");
};
const inputNames = ["collect-chromium-snapshot.mjs", "chromium-snapshot-candidate.json", "inspect-browser-zip.mjs",
  "collect-browser-archives.mjs", "runtime-dependency-audit.mjs", "upstream-lock.json"];
const inputRecords = () => Promise.all(inputNames.map(async path => ({ path, checksum: checksum(await readFile(new URL(path, import.meta.url))) })));

export function validateChromiumSnapshotPin(pin) {
  if (pin?.schemaVersion !== 1 || pin.reviewStatus !== "candidate-only" || pin.releaseEligible !== false ||
    pin.target?.platform !== "darwin" || pin.target.arch !== "arm64" || !/^[1-9][0-9]{5,8}$/.test(pin.position ?? "") ||
    !/^[a-f0-9]{40}$/.test(pin.revision ?? "") || !/^151\.0\.7922\.0$/.test(pin.version ?? "") ||
    ![pin.revisionsChecksum, pin.versionChecksum, pin.sourceLicenseChecksum].every(digest) ||
    !/^[1-9][0-9]{10,19}$/.test(pin.archive?.generation ?? "") || !/^[a-f0-9]{32}$/.test(pin.archive?.etag ?? "") ||
    !Number.isSafeInteger(pin.archive?.sizeBytes) || pin.archive.sizeBytes < 4 || pin.archive.sizeBytes > 512 * 1024 * 1024) fail("pin_invalid");
  const base = `https://storage.googleapis.com/chromium-browser-snapshots/Mac_Arm/${pin.position}`;
  const source = `https://chromium.googlesource.com/chromium/src/+/${pin.revision}`;
  return { revisions: `${base}/REVISIONS`, version: `${source}/chrome/VERSION?format=TEXT`,
    license: `${source}/LICENSE?format=TEXT`, archive: `${base}/chrome-mac.zip?generation=${pin.archive.generation}` };
}

async function boundedResponse(response, maximum) {
  if (!response.ok || !response.body) fail(`http_${response.status}`);
  const parts = []; let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > maximum) fail("metadata_too_large");
    parts.push(part);
  }
  if (!size) fail("metadata_empty");
  return Buffer.concat(parts);
}

export async function readChromiumSnapshotMetadata(pin, request = fetch) {
  const urls = validateChromiumSnapshotPin(pin), result = {};
  for (const key of ["revisions", "version", "license"]) {
    const response = await request(urls[key], { redirect: "error", signal: AbortSignal.timeout(30_000) });
    const wire = await boundedResponse(response, 64 * 1024);
    let bytes = wire;
    if (key !== "revisions") {
      const encoded = wire.toString("utf8").trim();
      bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded) fail("source_encoding_invalid");
    }
    if (bytes.includes(0) || !Buffer.from(bytes.toString("utf8")).equals(bytes)) fail("source_text_invalid");
    const expected = key === "revisions" ? pin.revisionsChecksum : key === "version" ? pin.versionChecksum : pin.sourceLicenseChecksum;
    if (checksum(bytes) !== expected) fail(`${key}_changed`);
    result[key] = { url: urls[key], checksum: expected, wireChecksum: checksum(wire), bytes };
  }
  const revisions = JSON.parse(result.revisions.bytes.toString("utf8"));
  if (revisions.chromium_revision !== pin.position || revisions.got_revision !== pin.revision ||
    revisions.got_revision_cp !== `refs/heads/main@{#${pin.position}}`) fail("source_revision_mismatch");
  if (result.version.bytes.toString("utf8") !== "MAJOR=151\nMINOR=0\nBUILD=7922\nPATCH=0\n") fail("source_version_mismatch");
  return result;
}

export async function downloadChromiumSnapshot(pin, path, request = fetch) {
  const url = validateChromiumSnapshotPin(pin).archive;
  const response = await request(url, { redirect: "error", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) fail(`archive_http_${response.status}`);
  if (response.headers.get("content-length") !== String(pin.archive.sizeBytes) ||
    response.headers.get("x-goog-generation") !== pin.archive.generation ||
    response.headers.get("etag") !== `"${pin.archive.etag}"` || response.headers.get("content-encoding") !== null) {
    await response.body.cancel(); fail("archive_identity_mismatch");
  }
  const file = await open(path, "wx", 0o600), sha = createHash("sha256"), md5 = createHash("md5");
  let sizeBytes = 0, signature = Buffer.alloc(0);
  try {
    for await (const part of response.body) {
      sizeBytes += part.length;
      if (sizeBytes > pin.archive.sizeBytes) fail("archive_too_large");
      if (signature.length < 4) signature = Buffer.concat([signature, part.subarray(0, 4 - signature.length)]);
      sha.update(part); md5.update(part); await file.writeFile(part);
    }
  } finally { await file.close(); }
  if (sizeBytes !== pin.archive.sizeBytes) fail("archive_truncated");
  if (!signature.equals(Buffer.from("504b0304", "hex"))) fail("archive_not_zip");
  if (md5.digest("hex") !== pin.archive.etag) fail("archive_md5_mismatch");
  return { url, sizeBytes, checksum: `sha256:${sha.digest("hex")}`, generation: pin.archive.generation,
    storageMd5: pin.archive.etag };
}

async function verifyArchive(path, archive) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== archive.sizeBytes || await realpath(path) !== path) fail("archive_file_invalid");
  const hash = createHash("sha256");
  for await (const part of createReadStream(path)) hash.update(part);
  if (`sha256:${hash.digest("hex")}` !== archive.checksum) fail("archive_changed");
}

// Candidate acquisition and member inspection only. Source BSD terms do not clear
// compiled third-party obligations, patch-level security, or runtime equivalence.
export async function collectChromiumSnapshotCandidate({ resourceStagePath, expectedResourceStageChecksum, outputPath,
  onProgress = () => {} }) {
  const pinBytes = await readFile(new URL("./chromium-snapshot-candidate.json", import.meta.url));
  const pin = JSON.parse(pinBytes.toString("utf8")); validateChromiumSnapshotPin(pin);
  if (process.platform !== pin.target.platform || process.arch !== pin.target.arch) fail("requires_matching_host");
  const options = { resourceStagePath, expectedResourceStageChecksum, target: pin.target };
  const source = await verifyBrowserArchiveSource(options), inputs = await inputRecords();
  if (inputs.find(input => input.path === "chromium-snapshot-candidate.json").checksum !== checksum(pinBytes)) fail("inputs_changed");
  const requested = resolve(outputPath);
  if (await exists(requested)) fail("output_exists");
  const parent = await realpath(dirname(requested)), output = join(parent, basename(requested));
  if (inside(source.root, output) || inside(output, source.root)) fail("output_overlap");
  const lease = await managedResourceWrite(output, { kind: "browser", additionalBytes: pin.archive.sizeBytes + 256 * 1024 ** 2 });
  onProgress("verify frozen snapshot source revision, version and original source license");
  const metadata = await readChromiumSnapshotMetadata(pin);
  const temporary = await realpath(await mkdtemp(join(parent, ".gstack-chromium-snapshot-")));
  let reserved = false;
  try {
    const candidate = join(temporary, "candidate"); await mkdir(candidate);
    const archivePath = join(candidate, "chrome-mac.zip");
    onProgress("acquire generation-pinned official Chromium archive; do not extract or execute");
    const archive = await downloadChromiumSnapshot(pin, archivePath);
    await verifyArchive(archivePath, archive); await verifyBrowserArchiveSource(options);
    const require = createRequire(join(source.root, "runtime/package.json"));
    const { yauzl } = require(join(source.packagePath, "lib/utilsBundle.js"));
    onProgress("inspect every archive payload, native target, internal link and included notice");
    const inspected = await inspectBrowserZip({ zipPath: archivePath, yauzl, target: pin.target, rootPrefix: "chrome-mac" });
    const executable = inspected.members.find(member => member.path === "chrome-mac/Chromium.app/Contents/MacOS/Chromium");
    if (executable?.kind !== "file" || executable.native?.fileType !== "executable" ||
      !executable.native.architectures.includes(pin.target.arch) || !(executable.mode & 0o111)) fail("executable_missing");
    const identity = { source: source.provenance, pinChecksum: checksum(pinBytes), target: pin.target,
      snapshotPosition: pin.position, sourceRevision: pin.revision, sourceVersion: pin.version, inputChecksums: inputs, archive };
    const inventory = Buffer.from(`${JSON.stringify({ schemaVersion: 1, ...identity, ...inspected }, null, 2)}\n`);
    const receipt = { schemaVersion: 1, deliveryStage: "chromium-snapshot-member-candidate", reviewStatus: "candidate-only",
      releaseEligible: false, hostAcceptance: "pending", packageAcceptance: "pending", ...identity,
      inventoryChecksum: checksum(inventory), memberCount: inspected.members.length, totalBytes: inspected.totalBytes,
      nativeMemberCount: inspected.members.filter(member => member.native).length, noticeCount: inspected.notices.length,
      widevineMemberPaths: inspected.members.filter(member => /widevine/i.test(member.path)).map(member => member.path),
      pendingGates: ["compiled-version-and-third-party-notice-review", "patch-level-security-review",
        "owned-materialization", "headed-headless-extension-recording-equivalence", "installed-client-acceptance"] };
    for (const [name, bytes] of [["REVISIONS", metadata.revisions.bytes], ["SOURCE-VERSION", metadata.version.bytes],
      ["SOURCE-LICENSE", metadata.license.bytes], ["snapshot-members.json", inventory],
      ["snapshot-candidate.json", `${JSON.stringify(receipt, null, 2)}\n`]]) await writeFile(join(candidate, name), bytes, { flag: "wx" });
    await verifyArchive(archivePath, archive); await verifyBrowserArchiveSource(options);
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
  if (!resourceStagePath || !outputPath || !expectedResourceStageChecksum) throw new Error("Usage: collect-chromium-snapshot.mjs <resource-stage> <new-output> <detached-resource-sha256>");
  const result = await collectChromiumSnapshotCandidate({ resourceStagePath, outputPath, expectedResourceStageChecksum,
    onProgress: message => process.stderr.write(`${message}\n`) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
