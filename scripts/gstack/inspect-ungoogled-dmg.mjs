import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBrowserArchiveSource } from "./collect-browser-archives.mjs";
import { validateUngoogledChromiumPin } from "./collect-ungoogled-chromium.mjs";
import { inspectBrowserZip } from "./inspect-browser-zip.mjs";
import { readSelectedChromiumPack } from "./inspect-chromium-credits.mjs";
import { decodeChromiumResource, parseChromiumDataPack } from "./chromium-data-pack.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const fail = reason => { throw new Error(`gstack_ungoogled_inspection_${reason}`); };
const exists = path => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const overlap = (root, path) => {
  const r = relative(root, path);
  return !r || !isAbsolute(r) && r !== ".." && !r.startsWith("../") && !r.startsWith("..\\");
};
const acquisitionInputs = ["collect-ungoogled-chromium.mjs", "ungoogled-chromium-candidate.json", "collect-browser-archives.mjs",
  "runtime-dependency-audit.mjs", "upstream-lock.json", "public-github-metadata.mjs"];
const inputNames = ["inspect-ungoogled-dmg.mjs", "inspect-browser-zip.mjs", "inspect-chromium-credits.mjs", "chromium-data-pack.mjs", ...acquisitionInputs];
const inputRecords = () => Promise.all(inputNames.map(async path => ({ path, checksum: checksum(await readFile(new URL(path, import.meta.url))) })));

async function plainBytes(root, path, maximum, expected) {
  const absolute = join(root, path), stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum || await realpath(absolute) !== absolute) fail("file_invalid");
  const bytes = await readFile(absolute);
  if (bytes.length !== stat.size || expected && checksum(bytes) !== expected) fail("file_changed");
  return bytes;
}

async function fileHash(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path) fail("file_invalid");
  const hash = createHash("sha256"); let sizeBytes = 0;
  for await (const bytes of createReadStream(path)) { sizeBytes += bytes.length; hash.update(bytes); }
  if (sizeBytes !== stat.size) fail("file_changed");
  return { sizeBytes, checksum: `sha256:${hash.digest("hex")}` };
}

async function verifyCandidate(root, expectedChecksum) {
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedChecksum ?? "")) fail("receipt_required");
  const pinBytes = await readFile(new URL("./ungoogled-chromium-candidate.json", import.meta.url)), pin = JSON.parse(pinBytes);
  validateUngoogledChromiumPin(pin);
  const receipt = JSON.parse(await plainBytes(root, "ungoogled-candidate.json", 256 * 1024, expectedChecksum));
  if (receipt.schemaVersion !== 1 || receipt.deliveryStage !== "ungoogled-chromium-archive-candidate" ||
    receipt.reviewStatus !== "candidate-only" || receipt.releaseEligible !== false ||
    receipt.revision !== pin.revision || receipt.browserVersion !== pin.version || receipt.repository !== pin.repository ||
    receipt.target?.platform !== pin.target.platform || receipt.target?.arch !== pin.target.arch ||
    receipt.pinChecksum !== checksum(pinBytes) || receipt.archive?.path !== pin.asset.name ||
    receipt.archive?.sizeBytes !== pin.asset.sizeBytes || receipt.archive.checksum !== pin.asset.checksum ||
    receipt.identity?.asset?.id !== pin.asset.id || receipt.identity.build?.revision !== pin.revision ||
    receipt.identity.common?.revision !== pin.commonRevision || receipt.inputChecksums?.length !== acquisitionInputs.length) fail("receipt_identity_mismatch");
  for (const [index, path] of acquisitionInputs.entries()) {
    const r = receipt.inputChecksums[index];
    if (r.path !== path || r.checksum !== checksum(await readFile(new URL(path, import.meta.url)))) fail("acquisition_inputs_changed");
  }
  if (JSON.stringify(receipt.references) !== JSON.stringify(pin.references)) fail("references_changed");
  for (const r of pin.references) await plainBytes(root, r.output, 256 * 1024, r.checksum);
  const archive = await fileHash(join(root, pin.asset.name));
  if (archive.sizeBytes !== pin.asset.sizeBytes || archive.checksum !== pin.asset.checksum) fail("archive_changed");
  return { receipt, pin, archivePath: join(root, pin.asset.name) };
}

export function summarizeUngoogledPack(packBytes) {
  const parsed = parseChromiumDataPack(packBytes), resources = [], credits = [];
  let decodedTotalBytes = 0;
  for (const r of parsed.resources) {
    const maximum = Math.min(32 * 1024 * 1024, 256 * 1024 * 1024 - decodedTotalBytes);
    if (maximum < 1) fail("decoded_total_limit");
    const decoded = decodeChromiumResource(r.bytes, { maxOutputBytes: maximum });
    decodedTotalBytes += decoded.bytes.length;
    resources.push({ id: r.id, offset: r.offset, storedSizeBytes: r.bytes.length, storedChecksum: checksum(r.bytes),
      compression: decoded.format, sizeBytes: decoded.bytes.length, checksum: checksum(decoded.bytes) });
    const text = decoded.bytes.toString("utf8");
    if (!/<title>\s*Credits\s*<\/title>/i.test(text) || !Buffer.from(text).equals(decoded.bytes)) continue;
    const placeholder = /This is sample credits page|generate_about_credits=true/.test(text);
    credits.push({ resourceId: r.id, sizeBytes: decoded.bytes.length, checksum: checksum(decoded.bytes),
      output: `compiled-credits-${r.id}.html.txt`, placeholder,
      permissiveGrantCount: (text.match(/Permission is hereby granted|Redistribution and use in source and binary forms/g) ?? []).length,
      bytes: decoded.bytes });
  }
  return { version: parsed.version, encoding: parsed.encoding, containerCompression: parsed.containerCompression,
    decodedTotalBytes, resources, aliases: parsed.aliases, credits };
}

function system(command, args, env, input) {
  return execFileSync(command, args, { env, input, encoding: "utf8", timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
}
function plistJson(bytes, env) {
  return JSON.parse(system("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], env, bytes));
}
export function readonlyImageArguments(archivePath, mountpoint) {
  if (!isAbsolute(archivePath) || !isAbsolute(mountpoint) || archivePath.includes("\0") || mountpoint.includes("\0")) fail("mount_path_invalid");
  return ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mountpoint, "-plist", archivePath];
}
export function validateUngoogledAppInfo(info, version) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version) || info.CFBundleShortVersionString !== version ||
    info.CFBundleVersion !== version.split(".").slice(2).join(".") || info.CFBundleIdentifier !== "org.chromium.Chromium" ||
    info.CFBundleExecutable !== "Chromium") fail("app_version_invalid");
}
export function validateReadonlyMount(info, archivePath, mountpoint) {
  const images = (info.images ?? []).filter(image => image["image-path"] === archivePath &&
    (image["system-entities"] ?? []).some(e => e["mount-point"] === mountpoint));
  if (images.length !== 1 || images[0].writeable !== false) fail("mount_not_readonly");
}
function mountEntries(mountpoint, env) {
  const info = plistJson(system("/usr/bin/hdiutil", ["info", "-plist"], env), env);
  return (info.images ?? []).flatMap(image => (image["system-entities"] ?? []).filter(e => e["mount-point"] === mountpoint));
}

// The system mounts this pinned image read-only solely for inspection. No app is
// started or modified; the ZIP is an inspection transport, never a release asset.
export async function inspectUngoogledDmg({ candidatePath, expectedCandidateChecksum, resourceStagePath, outputPath, onProgress = () => {} }) {
  if (process.platform !== "darwin" || process.arch !== "arm64") fail("requires_matching_host");
  const requested = resolve(candidatePath), stat = await lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("candidate_root_invalid");
  const root = await realpath(requested), initial = await verifyCandidate(root, expectedCandidateChecksum), inputs = await inputRecords();
  const options = { resourceStagePath, expectedResourceStageChecksum: initial.receipt.source.resourceStageChecksum, target: initial.pin.target };
  const source = await verifyBrowserArchiveSource(options);
  if (JSON.stringify(source.provenance) !== JSON.stringify(initial.receipt.source)) fail("resource_source_changed");
  const requestedOutput = resolve(outputPath);
  if (await exists(requestedOutput)) fail("output_exists");
  const parent = await realpath(dirname(requestedOutput)), output = join(parent, basename(requestedOutput));
  if (overlap(root, output) || overlap(output, root) || overlap(source.root, output) || overlap(output, source.root)) fail("output_overlap");
  const temporary = await realpath(await mkdtemp(join(parent, ".gstack-ungoogled-inspection-")));
  const mountpoint = join(temporary, "mount"), candidate = join(temporary, "candidate");
  const env = { PATH: "/usr/bin:/bin", HOME: temporary, TMPDIR: temporary, LANG: "en_US.UTF-8" };
  let attempted = false, detached = false, reserved = false;
  try {
    await mkdir(mountpoint); await mkdir(candidate);
    onProgress("mount the independently hashed DMG read-only with Finder auto-open disabled");
    attempted = true;
    const attached = plistJson(system("/usr/bin/hdiutil", readonlyImageArguments(initial.archivePath, mountpoint), env), env);
    const mounted = (attached["system-entities"] ?? []).filter(e => e["mount-point"] === mountpoint);
    if (mounted.length !== 1 || !/^\/dev\/disk\d+s\d+$/.test(mounted[0]["dev-entry"] ?? "")) fail("mount_identity_invalid");
    validateReadonlyMount(plistJson(system("/usr/bin/hdiutil", ["info", "-plist"], env), env), initial.archivePath, mountpoint);
    const app = join(mountpoint, "Chromium.app"), appStat = await lstat(app);
    if (!appStat.isDirectory() || appStat.isSymbolicLink() || await realpath(app) !== app) fail("app_root_invalid");
    const plist = await plainBytes(app, "Contents/Info.plist", 1024 * 1024);
    const appInfo = plistJson(plist, env);
    onProgress(`candidate app identity ${JSON.stringify({ version: appInfo.CFBundleVersion,
      shortVersion: appInfo.CFBundleShortVersionString, identifier: appInfo.CFBundleIdentifier, executable: appInfo.CFBundleExecutable })}`);
    validateUngoogledAppInfo(appInfo, initial.pin.version);
    onProgress("repackage read-only files only as inspection transport; verify every payload, native slice and internal link");
    const archivePath = join(candidate, "inspection-members.zip");
    execFileSync("/usr/bin/zip", ["-q", "-r", "-y", archivePath, "Chromium.app"], {
      cwd: mountpoint, env, encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    const require = createRequire(join(source.root, "runtime/package.json")), { yauzl } = require(join(source.packagePath, "lib/utilsBundle.js"));
    const inspected = await inspectBrowserZip({ zipPath: archivePath, yauzl, target: initial.pin.target, rootPrefix: "Chromium.app" });
    const infoMember = inspected.members.find(m => m.path === "Chromium.app/Contents/Info.plist");
    if (infoMember?.checksum !== checksum(plist)) fail("app_plist_changed");
    const executable = inspected.members.find(m => m.path === "Chromium.app/Contents/MacOS/Chromium");
    if (executable?.kind !== "file" || executable.native?.fileType !== "executable" || !executable.native.architectures.includes("arm64")) fail("app_executable_invalid");
    const packs = inspected.members.filter(m => m.kind === "file" && /\/Resources\/resources\.pak$/.test(m.path));
    if (packs.length !== 1) fail("compiled_pack_missing");
    onProgress("decode all compiled resources and preserve Credits bytes as text, without rendering HTML or executing the browser");
    const zipBytes = await plainBytes(candidate, "inspection-members.zip", 512 * 1024 * 1024);
    const pack = await readSelectedChromiumPack({ archiveBytes: zipBytes, yauzl, member: packs[0] });
    const summarized = summarizeUngoogledPack(pack), transport = { path: "inspection-members.zip", sizeBytes: zipBytes.length, checksum: checksum(zipBytes) };
    const inventory = Buffer.from(`${JSON.stringify({ schemaVersion: 1, ...inspected }, null, 2)}\n`);
    const resourceBytes = Buffer.from(`${JSON.stringify({ ...summarized, credits: summarized.credits.map(({ bytes, ...r }) => r) }, null, 2)}\n`);
    const record = { schemaVersion: 1, deliveryStage: "ungoogled-chromium-member-evidence", reviewStatus: "candidate-only", releaseEligible: false,
      hostAcceptance: "pending", packageAcceptance: "pending", target: initial.pin.target, browserVersion: initial.pin.version,
      candidateReceiptChecksum: expectedCandidateChecksum, source: source.provenance, inputChecksums: inputs, transport,
      app: { version: appInfo.CFBundleShortVersionString, buildVersion: appInfo.CFBundleVersion,
        identifier: appInfo.CFBundleIdentifier, executable: appInfo.CFBundleExecutable, infoChecksum: checksum(plist) },
      inventoryChecksum: checksum(inventory), resourceInventoryChecksum: checksum(resourceBytes),
      memberCount: inspected.members.length, totalBytes: inspected.totalBytes, nativeMemberCount: inspected.members.filter(m => m.native).length,
      noticeCount: inspected.notices.length, widevineMemberPaths: inspected.members.filter(m => /widevine/i.test(m.path)).map(m => m.path),
      pack: { path: packs[0].path, checksum: checksum(pack), sizeBytes: pack.length }, resourceCount: summarized.resources.length,
      aliasCount: summarized.aliases.length, credits: summarized.credits.map(({ bytes, ...r }) => r),
      candidateDisposition: summarized.credits.some(r => !r.placeholder && r.permissiveGrantCount > 10)
        ? "compiled-credits-present-review-pending" : "compiled-credits-incomplete",
      pendingGates: initial.receipt.pendingGates.filter(g => g !== "readonly-dmg-member-and-native-inspection") };
    for (const [name, bytes] of [["members.json", inventory], ["compiled-resources.json", resourceBytes],
      ["app-info.plist.txt", plist], ...summarized.credits.map(r => [r.output, r.bytes])]) await writeFile(join(candidate, name), bytes, { flag: "wx", mode: 0o600 });
    system("/usr/bin/hdiutil", ["detach", mountpoint], env);
    if (mountEntries(mountpoint, env).length) fail("detach_failed");
    detached = true;
    record.readonlyMountDetached = true;
    await verifyCandidate(root, expectedCandidateChecksum); await verifyBrowserArchiveSource(options);
    if (JSON.stringify(inputs) !== JSON.stringify(await inputRecords())) fail("inputs_changed");
    await writeFile(join(candidate, "ungoogled-inspection.json"), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await mkdir(output); reserved = true; await rename(candidate, output); reserved = false;
    return record;
  } finally {
    if (attempted && !detached) {
      const mounted = mountEntries(mountpoint, env);
      if (mounted.length) system("/usr/bin/hdiutil", ["detach", mountpoint], env);
      if (mountEntries(mountpoint, env).length) fail("detach_failed_retained_staging");
      detached = true;
    }
    if (!attempted || detached) {
      try { if (reserved) await rmdir(output); }
      finally { await rm(temporary, { recursive: true, force: true }); }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [candidatePath, resourceStagePath, outputPath, expectedCandidateChecksum] = process.argv.slice(2);
  if (!candidatePath || !resourceStagePath || !outputPath || !expectedCandidateChecksum) throw new Error("Usage: inspect-ungoogled-dmg.mjs <candidate> <resource-stage> <new-output> <detached-candidate-sha256>");
  const record = await inspectUngoogledDmg({ candidatePath, resourceStagePath, outputPath, expectedCandidateChecksum,
    onProgress: message => process.stderr.write(`${message}\n`) });
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}
