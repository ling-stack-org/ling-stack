import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { verifyBrowserArchiveSource } from "./collect-browser-archives.mjs";
import { validateChromiumSnapshotPin } from "./collect-chromium-snapshot.mjs";
import { decodeChromiumResource, parseChromiumDataPack } from "./chromium-data-pack.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const fail = reason => { throw new Error(`gstack_chromium_credits_${reason}`); };
const exists = path => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const overlap = (root, path) => {
  const r = relative(root, path);
  return !r || !isAbsolute(r) && r !== ".." && !r.startsWith("../") && !r.startsWith("..\\");
};
const snapshotInputs = ["collect-chromium-snapshot.mjs", "chromium-snapshot-candidate.json", "inspect-browser-zip.mjs",
  "collect-browser-archives.mjs", "runtime-dependency-audit.mjs", "upstream-lock.json"];
const inputNames = ["inspect-chromium-credits.mjs", "chromium-data-pack.mjs", "chromium-credits-pin.json", ...snapshotInputs];
const inputRecords = () => Promise.all(inputNames.map(async path => ({ path, checksum: checksum(await readFile(new URL(path, import.meta.url))) })));

async function boundedFile(path, maximum, expected) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum || await realpath(path) !== path) fail("file_invalid");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), parts = [];
  let size = 0;
  try {
    const opened = await file.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) fail("file_changed");
    for await (const bytes of file.createReadStream({ autoClose: false })) {
      size += bytes.length;
      if (size > maximum || size > stat.size) fail("file_changed");
      parts.push(bytes);
    }
    if (size !== stat.size) fail("file_changed");
  } finally { await file.close(); }
  const bytes = Buffer.concat(parts);
  if (expected && checksum(bytes) !== expected) fail("file_checksum_mismatch");
  return bytes;
}

export async function readPinnedChromiumReference(record, revision, request = fetch) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? "") || typeof record.path !== "string" ||
    !/^[a-zA-Z0-9_./-]+$/.test(record.path) || record.path.split("/").some(part => !part || part === "." || part === "..") ||
    !/^sha256:[a-f0-9]{64}$/.test(record.checksum ?? "")) fail("reference_identity_invalid");
  const url = `https://chromium.googlesource.com/chromium/src/+/${revision}/${record.path}?format=TEXT`;
  const response = await request(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) fail(`reference_http_${response.status}`);
  const parts = []; let size = 0;
  for await (const bytes of response.body) {
    size += bytes.length; if (size > 256 * 1024) fail("reference_too_large"); parts.push(bytes);
  }
  const wire = Buffer.concat(parts), encoded = wire.toString("utf8").trim(), bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || !Buffer.from(bytes.toString("utf8")).equals(bytes) || bytes.includes(0)) fail("reference_encoding_invalid");
  if (checksum(bytes) !== record.checksum) fail("reference_changed");
  return { ...record, url, wireChecksum: checksum(wire), bytes };
}

// Inspect a single retained member in memory. Never extract an executable app or
// render HTML. The parent operation independently verifies the complete archive.
export async function readSelectedChromiumPack({ archiveBytes, yauzl, member, maxDurationMs = 30_000 }) {
  if (!Buffer.isBuffer(archiveBytes) || archiveBytes.length > 512 * 1024 * 1024 || !Number.isSafeInteger(maxDurationMs) ||
    maxDurationMs < 1 || maxDurationMs > 30_000 || member?.kind !== "file" ||
    !Number.isSafeInteger(member.sizeBytes) || member.sizeBytes < 0 || member.sizeBytes > 32 * 1024 * 1024 ||
    !Number.isSafeInteger(member.compressedSizeBytes) || member.compressedSizeBytes < 0 ||
    !Number.isSafeInteger(member.mode) || member.mode < 0 || member.mode > 65535 ||
    ![0, 8].includes(member.compressionMethod) || !/^sha256:[a-f0-9]{64}$/.test(member.checksum ?? "") ||
    !/^[a-f0-9]{8}$/.test(member.crc32 ?? "") || typeof member.path !== "string" || member.path.length > 4096) fail("member_limits_invalid");
  const zip = await yauzl.fromBufferPromise(archiveBytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false });
  let timer, operation, stream, result;
  try {
    if (zip.entryCount < 1 || zip.entryCount > 5_000) fail("member_count_invalid");
    await new Promise((resolve, reject) => {
      let settled = false, found = false;
      const stop = error => {
        if (settled) return; settled = true;
        if (error) { stream?.destroy(error); zip.close(); reject(error); } else resolve();
      };
      timer = setTimeout(() => stop(new Error("gstack_chromium_credits_member_timeout")), maxDurationMs);
      zip.on("error", stop); zip.on("end", () => stop(found ? undefined : new Error("gstack_chromium_credits_member_missing")));
      zip.on("entry", entry => {
        operation = (async () => {
          if (entry.fileName === member.path) {
            if (found) fail("member_duplicate"); found = true;
            if (entry.uncompressedSize !== member.sizeBytes || entry.compressedSize !== member.compressedSizeBytes ||
              entry.compressionMethod !== member.compressionMethod || entry.generalPurposeBitFlag & 0x41 ||
              entry.externalFileAttributes >>> 16 !== member.mode || entry.crc32.toString(16).padStart(8, "0") !== member.crc32) fail("member_identity_mismatch");
            const chunks = []; let size = 0, crc = 0;
            stream = await zip.openReadStreamPromise(entry);
            for await (const bytes of stream) {
              size += bytes.length; if (size > member.sizeBytes) fail("member_size_mismatch");
              crc = crc32(bytes, crc); chunks.push(bytes);
            }
            stream = undefined; result = Buffer.concat(chunks);
            if (size !== member.sizeBytes || crc !== entry.crc32 || checksum(result) !== member.checksum) fail("member_payload_mismatch");
          }
          if (!settled) zip.readEntry();
        })().catch(stop);
      });
      zip.readEntry();
    });
  } finally {
    clearTimeout(timer); stream?.destroy(); zip.close(); await operation;
  }
  return result;
}

async function verifiedSnapshot(root, receiptChecksum, pin) {
  const receiptBytes = await boundedFile(join(root, "snapshot-candidate.json"), 128 * 1024, receiptChecksum);
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  const snapshotPin = JSON.parse(await readFile(new URL("./chromium-snapshot-candidate.json", import.meta.url), "utf8"));
  validateChromiumSnapshotPin(snapshotPin);
  if (receiptChecksum !== pin.snapshotReceiptChecksum || receipt.sourceRevision !== pin.sourceRevision ||
    receipt.sourceVersion !== snapshotPin.version || receipt.releaseEligible !== false ||
    receipt.deliveryStage !== "chromium-snapshot-member-candidate" || receipt.reviewStatus !== "candidate-only" ||
    receipt.pinChecksum !== checksum(await readFile(new URL("./chromium-snapshot-candidate.json", import.meta.url))) ||
    receipt.archive.sizeBytes !== snapshotPin.archive.sizeBytes || receipt.archive.generation !== snapshotPin.archive.generation ||
    receipt.archive.storageMd5 !== snapshotPin.archive.etag) fail("snapshot_identity_mismatch");
  if (!Array.isArray(receipt.inputChecksums) || receipt.inputChecksums.length !== snapshotInputs.length ||
    receipt.inputChecksums.some((input, index) => input.path !== snapshotInputs[index])) fail("snapshot_inputs_invalid");
  for (const input of receipt.inputChecksums) if (checksum(await readFile(new URL(input.path, import.meta.url))) !== input.checksum) fail("snapshot_inputs_changed");
  for (const [name, expected] of [["REVISIONS", snapshotPin.revisionsChecksum], ["SOURCE-VERSION", snapshotPin.versionChecksum],
    ["SOURCE-LICENSE", snapshotPin.sourceLicenseChecksum]]) await boundedFile(join(root, name), 128 * 1024, expected);
  const inventory = JSON.parse((await boundedFile(join(root, "snapshot-members.json"), 4 * 1024 * 1024, receipt.inventoryChecksum)).toString("utf8"));
  const members = inventory.members.filter(member => member.path === pin.pack.path);
  if (members.length !== 1 || members[0].checksum !== pin.pack.checksum || members[0].sizeBytes !== pin.pack.sizeBytes) fail("pack_identity_mismatch");
  const archiveBytes = await boundedFile(join(root, "chrome-mac.zip"), receipt.archive.sizeBytes, receipt.archive.checksum);
  return { receipt, member: members[0], archiveBytes };
}

export async function inspectChromiumCredits({ snapshotPath, expectedSnapshotChecksum, resourceStagePath, outputPath,
  referenceReader = readPinnedChromiumReference, onProgress = () => {} }) {
  const pinBytes = await readFile(new URL("./chromium-credits-pin.json", import.meta.url)), pin = JSON.parse(pinBytes);
  const requestedRoot = resolve(snapshotPath), stat = await lstat(requestedRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("snapshot_root_invalid");
  const root = await realpath(requestedRoot), inputs = await inputRecords();
  if (inputs.find(input => input.path === "chromium-credits-pin.json").checksum !== checksum(pinBytes)) fail("inputs_changed");
  const initial = await verifiedSnapshot(root, expectedSnapshotChecksum, pin);
  const sourceOptions = { resourceStagePath, expectedResourceStageChecksum: initial.receipt.source.resourceStageChecksum, target: initial.receipt.target };
  const source = await verifyBrowserArchiveSource(sourceOptions);
  if (JSON.stringify(initial.receipt.source) !== JSON.stringify(source.provenance)) fail("source_identity_mismatch");
  const requestedOutput = resolve(outputPath);
  if (await exists(requestedOutput)) fail("output_exists");
  const parent = await realpath(dirname(requestedOutput)), output = join(parent, basename(requestedOutput));
  for (const inputRoot of [root, source.root]) if (overlap(inputRoot, output) || overlap(output, inputRoot)) fail("output_overlap");
  const require = createRequire(join(source.root, "runtime/package.json")), { yauzl } = require(join(source.packagePath, "lib/utilsBundle.js"));
  onProgress("decode the pinned resource pack without extracting or executing the browser");
  const packBytes = await readSelectedChromiumPack({ archiveBytes: initial.archiveBytes, yauzl, member: initial.member });
  initial.archiveBytes = undefined;
  const parsed = parseChromiumDataPack(packBytes), resources = [];
  let credits, totalBytes = 0;
  for (const resource of parsed.resources) {
    const available = Math.min(8 * 1024 * 1024, 128 * 1024 * 1024 - totalBytes);
    if (available < 1) fail("decoded_total_too_large");
    const decoded = decodeChromiumResource(resource.bytes, { maxOutputBytes: available }); totalBytes += decoded.bytes.length;
    resources.push({ id: resource.id, offset: resource.offset, storedSizeBytes: resource.bytes.length, storedChecksum: checksum(resource.bytes),
      compression: decoded.format, sizeBytes: decoded.bytes.length, checksum: checksum(decoded.bytes) });
    if (resource.id === pin.credits.resourceId) credits = decoded.bytes;
  }
  if (!credits || credits.length !== pin.credits.sizeBytes || checksum(credits) !== pin.credits.checksum) fail("credits_identity_mismatch");
  onProgress("retain exact source-format references and prove the compiled credits match the upstream placeholder");
  const references = [];
  for (const record of pin.references) {
    if (!/^[a-zA-Z0-9_.-]+\.txt$/.test(record.output ?? "")) fail("reference_output_invalid");
    const reference = await referenceReader(record, pin.sourceRevision);
    if (!Buffer.isBuffer(reference.bytes) || checksum(reference.bytes) !== record.checksum ||
      !/^sha256:[a-f0-9]{64}$/.test(reference.wireChecksum ?? "")) fail("reference_changed");
    references.push({ ...record, url: `https://chromium.googlesource.com/chromium/src/+/${pin.sourceRevision}/${record.path}?format=TEXT`,
      wireChecksum: reference.wireChecksum, bytes: reference.bytes });
  }
  if (!references.find(reference => reference.path === "components/resources/sample_credits.html")?.bytes.equals(credits)) fail("placeholder_source_mismatch");
  const inventory = Buffer.from(`${JSON.stringify({ schemaVersion: 1, pack: pin.pack, version: parsed.version,
    encoding: parsed.encoding, containerCompression: parsed.containerCompression, decodedTotalBytes: totalBytes,
    resources, aliases: parsed.aliases }, null, 2)}\n`);
  const receipt = { schemaVersion: 1, deliveryStage: "chromium-compiled-credits-evidence", releaseEligible: false,
    candidateDisposition: "rejected-for-delivery", snapshotReceiptChecksum: expectedSnapshotChecksum,
    sourceRevision: pin.sourceRevision, source: source.provenance, inputChecksums: inputs, pack: pin.pack,
    resourceCount: resources.length, aliasCount: parsed.aliases.length, decodedTotalBytes: totalBytes,
    inventoryChecksum: checksum(inventory), credits: { ...pin.credits, output: "compiled-credits.html.txt" },
    references: references.map(({ bytes, ...reference }) => ({ ...reference, sizeBytes: bytes.length })),
    pendingGates: ["replacement-browser-with-complete-third-party-notices", "patch-level-security-review",
      "headed-headless-extension-recording-equivalence", "installed-client-acceptance"] };
  const temporary = await realpath(await mkdtemp(join(parent, ".gstack-chromium-credits-")));
  let reserved = false;
  try {
    const candidate = join(temporary, "candidate"); await mkdir(candidate);
    const files = [["pack-resources.json", inventory], ["compiled-credits.html.txt", credits],
      ["credits-candidate.json", `${JSON.stringify(receipt, null, 2)}\n`], ...references.map(reference => [reference.output, reference.bytes])];
    for (const [name, bytes] of files) await writeFile(join(candidate, name), bytes, { flag: "wx", mode: 0o600 });
    await verifiedSnapshot(root, expectedSnapshotChecksum, pin); await verifyBrowserArchiveSource(sourceOptions);
    if (JSON.stringify(inputs) !== JSON.stringify(await inputRecords())) fail("inputs_changed");
    await mkdir(output); reserved = true; await rename(candidate, output); reserved = false;
    return receipt;
  } finally {
    try { if (reserved) await rmdir(output); }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [snapshotPath, resourceStagePath, outputPath, expectedSnapshotChecksum] = process.argv.slice(2);
  if (!snapshotPath || !resourceStagePath || !outputPath || !expectedSnapshotChecksum) throw new Error("Usage: inspect-chromium-credits.mjs <snapshot> <resource-stage> <new-output> <detached-snapshot-sha256>");
  const result = await inspectChromiumCredits({ snapshotPath, resourceStagePath, outputPath, expectedSnapshotChecksum,
    onProgress: message => process.stderr.write(`${message}\n`) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
