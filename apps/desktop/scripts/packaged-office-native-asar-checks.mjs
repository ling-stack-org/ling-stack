import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { extractFile, getRawHeader, listPackage, statFile, uncache } from "@electron/asar";
import { readActiveOriginalPackagedOfficeDaemonBundle } from "./build-packaged-daemon.mjs";
import { readActiveOriginalPackagedOfficeNativePublication } from "./build-packaged-office-native.mjs";

const cliEntry = "dist/daemon/cli.mjs";
const maximumArchiveBytes = 2n * 1024n * 1024n * 1024n;
const maximumHeaderBytes = 16 * 1024 * 1024;
const maximumCliBytes = 64 * 1024 * 1024;
const maximumEntries = 100_000;
const maximumDepth = 64;
const maximumDuplicateCandidates = 256;
const maximumDuplicateReadBytes = 128 * 1024 * 1024;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function requireAsar(value) {
  if (!value) throw new Error("packaged_office_native_asar_invalid");
}
function sameNode(actual, original) {
  return ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"]
    .every(key => actual[key] === original[key]);
}
function inspect(path, directory) {
  requireAsar(typeof path === "string" && isAbsolute(path) && resolve(path) === path && realpathSync(path) === path);
  const stat = lstatSync(path, { bigint: true });
  requireAsar(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n)
    && stat.uid === BigInt(process.getuid()) && (stat.mode & 0o022n) === 0n);
  return stat;
}
function forbiddenOfficeName(path) {
  return path.split(/[\/\\]/u).some(name => {
    const lower = name.toLowerCase();
    return lower === "office-local" || lower === "office-local.node" || lower.startsWith(".office-local-next-");
  });
}
function candidateBudget(budget, size) {
  requireAsar(Number.isSafeInteger(size) && size >= 0
    && ++budget.candidates <= maximumDuplicateCandidates
    && (budget.bytes += size) <= maximumDuplicateReadBytes);
}
function readOrdinaryFile(path, original) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    requireAsar(sameNode(fstatSync(fd, { bigint: true }), original));
    const bytes = Buffer.alloc(Number(original.size));
    let offset = 0, attempts = 0;
    const maximumAttempts = Math.ceil(bytes.length / 65536) + 32;
    while (offset < bytes.length) {
      requireAsar(attempts++ < maximumAttempts);
      const count = readSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), offset);
      requireAsar(count > 0); offset += count;
    }
    requireAsar(readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) === 0
      && sameNode(fstatSync(fd, { bigint: true }), original));
    return bytes;
  } finally { closeSync(fd); }
}
function checkHeaderBudget(path, original) {
  requireAsar(original.size >= 8n && original.size <= maximumArchiveBytes);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    requireAsar(sameNode(fstatSync(fd, { bigint: true }), original));
    const prefix = Buffer.alloc(8);
    requireAsar(readSync(fd, prefix, 0, 8, 0) === 8 && prefix.readUInt32LE(0) === 4);
    const size = prefix.readUInt32LE(4);
    requireAsar(size > 0 && size <= maximumHeaderBytes && BigInt(size) <= original.size - 8n
      && sameNode(fstatSync(fd, { bigint: true }), original));
    return size;
  } finally { closeSync(fd); }
}
function inspectHeader(header, budget) {
  const entries = [];
  function visit(node, prefix, depth) {
    requireAsar(depth <= maximumDepth && node && typeof node === "object" && node.files
      && typeof node.files === "object" && !Array.isArray(node.files));
    const names = Object.keys(node.files);
    requireAsar(budget.entries + names.length <= maximumEntries);
    budget.entries += names.length;
    for (const name of names) {
      requireAsar(name.length > 0 && name !== "." && name !== ".." && !/[\/\\\0]/u.test(name));
      const path = prefix + name, metadata = node.files[name];
      requireAsar(!forbiddenOfficeName(path));
      requireAsar(!Object.hasOwn(metadata, "link") || (typeof metadata.link === "string" && !forbiddenOfficeName(metadata.link)));
      entries.push(path);
      if (Object.hasOwn(metadata, "files")) visit(metadata, path + "/", depth + 1);
    }
  }
  visit(header, "", 0);
  return entries;
}
function scanUnpacked(root, native, budget, observations) {
  let original;
  try { original = inspect(root, true); }
  catch (cause) { if (cause?.code === "ENOENT") return; throw cause; }
  observations.push({ path: root, directory: true, original });
  function visit(path, depth) {
    requireAsar(depth <= maximumDepth);
    const stream = opendirSync(path);
    try {
      for (;;) {
        const entry = stream.readSync();
        if (!entry) break;
        requireAsar(++budget.entries <= maximumEntries && !forbiddenOfficeName(entry.name));
        const child = join(path, entry.name), stat = lstatSync(child, { bigint: true });
        requireAsar(!stat.isSymbolicLink());
        const directory = stat.isDirectory(), current = inspect(child, directory);
        observations.push({ path: child, directory, original: current });
        if (directory) visit(child, depth + 1);
        else if (current.size === BigInt(native.finalBinarySizeBytes)) {
          candidateBudget(budget, native.finalBinarySizeBytes);
          requireAsar(hash(readOrdinaryFile(child, current)) !== native.finalBinarySha256);
        }
      }
    } finally { stream.closeSync(); }
  }
  visit(root, 0);
}

/**
 * Compare the actual copied packed CLI with the private original emitted pins,
 * and reject a second Office stage/addon anywhere in asar or its unpacked tree.
 * Third-party ASAR APIs reopen a path and cache headers: explicit uncache,
 * bounded header/entry reads and before/after identity fences do NOT constitute
 * retained-original-FD custody or isolation against a malicious same-UID peer.
 * No archive code is imported/evaluated and no caller DTO can mint byte pins.
 */
export function verifyOriginalOfficeDaemonInApp(appPath) {
  const pins = readActiveOriginalPackagedOfficeDaemonBundle();
  const native = readActiveOriginalPackagedOfficeNativePublication();
  requireAsar(pins && native && Number.isSafeInteger(pins.sizeBytes) && pins.sizeBytes > 0
    && pins.sizeBytes <= maximumCliBytes && /^[a-f0-9]{64}$/u.test(pins.sha256)
    && Number.isSafeInteger(native.finalBinarySizeBytes) && native.finalBinarySizeBytes > 0
    && native.finalBinarySizeBytes <= maximumCliBytes && /^[a-f0-9]{64}$/u.test(native.finalBinarySha256));
  const resources = join(appPath, "Contents/Resources"), archive = join(resources, "app.asar");
  const observations = [];
  for (const path of [appPath, join(appPath, "Contents"), resources])
    observations.push({ path, directory: true, original: inspect(path, true) });
  const original = inspect(archive, false);
  observations.push({ path: archive, directory: false, original });
  const headerSize = checkHeaderBudget(archive, original);
  const budget = { entries: 0, candidates: 0, bytes: 0 };
  uncache(archive);
  try {
    const raw = getRawHeader(archive);
    requireAsar(raw.headerSize === headerSize);
    const expected = inspectHeader(raw.header, budget).sort();
    const entries = listPackage(archive).map(path => path.replace(/^\//u, "")).sort();
    requireAsar(entries.length === expected.length && entries.every((path, index) => path === expected[index])
      && entries.filter(path => path === cliEntry).length === 1);
    for (const path of ["dist", "dist/daemon"]) {
      const metadata = statFile(archive, path, false);
      requireAsar(Object.hasOwn(metadata, "files") && !Object.hasOwn(metadata, "link") && metadata.unpacked !== true);
    }
    const cli = statFile(archive, cliEntry, false);
    requireAsar(!Object.hasOwn(cli, "files") && !Object.hasOwn(cli, "link") && cli.unpacked !== true
      && cli.size === pins.sizeBytes && cli.size <= maximumCliBytes);
    const bytes = extractFile(archive, cliEntry, false);
    requireAsar(bytes.length === pins.sizeBytes && hash(bytes) === pins.sha256);
    for (const path of entries) {
      const metadata = statFile(archive, path, false);
      if (!Object.hasOwn(metadata, "files") && !Object.hasOwn(metadata, "link") && metadata.unpacked !== true
        && metadata.size === native.finalBinarySizeBytes) {
        candidateBudget(budget, metadata.size);
        const candidate = extractFile(archive, path, false);
        requireAsar(candidate.length === metadata.size && hash(candidate) !== native.finalBinarySha256);
      }
    }
    scanUnpacked(archive + ".unpacked", native, budget, observations);
    for (const { path, directory, original: before } of observations)
      requireAsar(sameNode(inspect(path, directory), before));
    requireAsar(readActiveOriginalPackagedOfficeDaemonBundle() === pins
      && readActiveOriginalPackagedOfficeNativePublication() === native);
    return Object.freeze({ evidenceKind: "copied_asar_cli_byte_pins_only", archivePath: archive,
      cliEntry, cliSha256: pins.sha256, cliSizeBytes: pins.sizeBytes });
  } finally { uncache(archive); }
}
