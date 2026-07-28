import { execFile as execFileCallback } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import {
  inspectUniversalMachO,
  inspectWindowsPe,
  verifyPinnedBytes,
} from "./cua-driver-binary-identity.mjs";

const execFile = promisify(execFileCallback);
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_ATTEMPT_TIMEOUT_MS = 60_000;
const COMMAND_BUFFER_LIMIT = 128 * 1024 * 1024;

export function referenceArtifactUrl(lock, reference) {
  const repository = String(lock.upstream.repository).replace(/\/+$/u, "");
  assert(repository === "https://github.com/trycua/cua", "reference repository changed");
  return `${repository}/releases/download/${lock.upstream.tag}/${reference.filename}`;
}

export function expectedReferenceMembers(platform, reference) {
  if (platform === "darwin") return [reference.member];
  if (platform === "win32-x64") return [reference.mainMember, reference.uiaMember].sort(compareText);
  throw new Error(`unsupported reference platform: ${platform}`);
}

export function validateReferenceMemberInventory({ listedMembers, verboseMembers, expectedMembers }) {
  assert(Array.isArray(listedMembers) && Array.isArray(verboseMembers), "reference archive listings are required");
  const normalized = listedMembers.map(validateArchiveMemberPath);
  assert(new Set(normalized).size === normalized.length, "reference archive contains duplicate members");
  const expected = [...expectedMembers].sort(compareText);
  assert(JSON.stringify([...normalized].sort(compareText)) === JSON.stringify(expected), `reference archive member allowlist mismatch: ${JSON.stringify(normalized)}`);
  const verbose = new Map();
  for (const entry of verboseMembers) {
    const path = validateArchiveMemberPath(entry.path);
    assert(!verbose.has(path), `reference archive has duplicate verbose member: ${path}`);
    verbose.set(path, entry.type);
  }
  assert(JSON.stringify([...verbose.keys()].sort(compareText)) === JSON.stringify(expected), "reference archive verbose inventory mismatch");
  for (const path of expected) {
    assert(verbose.get(path) === "file", `reference archive member is not a regular file: ${path}`);
  }
  return expected;
}

export function parseTarVerboseListing(value, expectedMembers) {
  const remaining = new Set(expectedMembers);
  const entries = [];
  for (const rawLine of String(value).split(/\r?\n/u).filter(Boolean)) {
    const path = [...remaining].find((candidate) => rawLine.endsWith(` ${candidate}`));
    assert(path, `unrecognized verbose archive member: ${rawLine}`);
    remaining.delete(path);
    const marker = rawLine[0];
    entries.push({ path, type: marker === "-" ? "file" : marker === "l" ? "symlink" : marker === "h" ? "hardlink" : "other" });
  }
  assert(remaining.size === 0, `verbose archive listing omitted: ${[...remaining].join(", ")}`);
  return entries;
}

export async function acquireReferenceArtifact({
  platform,
  lock,
  workRoot,
  fetchImpl = globalThis.fetch,
  tarPath = defaultTarPath(platform),
  downloadTimeoutMs = DOWNLOAD_ATTEMPT_TIMEOUT_MS,
}) {
  const reference = lock.referenceArtifacts[platform === "darwin" ? "darwin" : "win32X64"];
  assert(reference?.usage === "reference_only_never_packaged", `${platform} reference usage changed`);
  const referenceRoot = join(resolve(workRoot), "reference-evidence");
  await assertFreshPath(referenceRoot, "reference evidence directory");
  await mkdir(referenceRoot, { recursive: true });
  const archivePath = join(referenceRoot, reference.filename);
  await downloadPinnedArchive(
    referenceArtifactUrl(lock, reference),
    archivePath,
    reference,
    fetchImpl,
    downloadTimeoutMs,
  );
  const archiveBytes = await readFile(archivePath);
  const archive = verifyPinnedBytes(archiveBytes, reference, `${platform} reference archive`);

  const listedMembers = splitListing(await runText(tarPath, ["-tf", archivePath]));
  const expectedMembers = expectedReferenceMembers(platform, reference);
  const verboseMembers = parseTarVerboseListing(
    await runText(tarPath, ["-tvf", archivePath]),
    expectedMembers,
  );
  const members = validateReferenceMemberInventory({ listedMembers, verboseMembers, expectedMembers });
  const extracted = {};
  const extractedRoot = join(referenceRoot, "verified-members");
  await mkdir(extractedRoot);
  for (const member of members) {
    const bytes = await runBuffer(tarPath, ["-xOf", archivePath, member]);
    const destination = join(extractedRoot, basename(member));
    await writeFile(destination, bytes, { flag: "wx", mode: 0o700 });
    await chmod(destination, 0o700).catch(() => {});
    extracted[member] = { bytes, path: destination };
  }

  const identity = platform === "darwin"
    ? await verifyDarwinReference({ binary: extracted[reference.member], reference })
    : verifyWindowsReference({ extracted, reference });

  return {
    schemaVersion: 1,
    usage: "reference_only_never_packaged",
    platform,
    archive: {
      filename: reference.filename,
      sizeBytes: archive.sizeBytes,
      sha256: archive.sha256,
      members,
    },
    identity,
    referenceRoot,
  };
}

export async function verifyDarwinReference({ binary, reference, codesignPath = "/usr/bin/codesign" }) {
  const pinned = verifyPinnedBytes(binary.bytes, {
    sizeBytes: reference.binarySizeBytes,
    sha256: reference.binarySha256,
  }, "darwin reference binary");
  const macho = inspectUniversalMachO(binary.bytes, "darwin reference binary");
  assert(macho.slices.every((slice) => slice.minimumOSVersion === reference.minimumOSVersion), "darwin reference minimum OS changed");
  assert(macho.slices.every((slice) => slice.sdkVersion === reference.sdkVersion), "darwin reference SDK changed");
  await runCommand(codesignPath, ["--verify", "--deep", "--strict", "--verbose=4", binary.path]);
  const detail = await runCommand(codesignPath, ["-d", "--verbose=4", binary.path]);
  const detailText = `${detail.stdout}\n${detail.stderr}`;
  const identifier = lineValue(detailText, "Identifier");
  const teamId = lineValue(detailText, "TeamIdentifier");
  const runtimeVersion = lineValue(detailText, "Runtime Version");
  const authority = detailText.split(/\r?\n/u).find((line) => line.startsWith("Authority="))?.slice("Authority=".length);
  assert(identifier === reference.identifier, `darwin reference identifier changed: ${identifier}`);
  assert(teamId === reference.teamId, `darwin reference Team ID changed: ${teamId}`);
  assert(runtimeVersion === reference.runtimeVersion, `darwin reference runtime version changed: ${runtimeVersion}`);
  assert(authority === reference.authority, `darwin reference authority changed: ${authority}`);
  assert(/flags=0x[0-9a-f]+\(runtime\)/u.test(detailText), "darwin reference hardened runtime flag is missing");

  const entitlementResult = await runCommand(codesignPath, ["-d", "--entitlements", ":-", binary.path]);
  const entitlementText = extractPlist(`${entitlementResult.stdout}\n${entitlementResult.stderr}`);
  const entitlements = parseBooleanEntitlements(entitlementText);
  assert(JSON.stringify(entitlements) === JSON.stringify(reference.entitlements), `darwin reference entitlements changed: ${JSON.stringify(entitlements)}`);

  return {
    member: reference.member,
    sizeBytes: pinned.sizeBytes,
    sha256: pinned.sha256,
    ...macho,
    signing: {
      identifier,
      teamId,
      authority,
      hardenedRuntime: true,
      runtimeVersion,
      entitlements,
    },
  };
}

export function verifyWindowsReference({ extracted, reference }) {
  const results = [];
  for (const [member, role, expectedSizeBytes, expectedSha256, expectedUiAccess, expectedManifestSha256] of [
    [reference.mainMember, "main", reference.mainSizeBytes, reference.mainSha256, false, reference.mainManifestSha256],
    [reference.uiaMember, "uia-audit", reference.uiaSizeBytes, reference.uiaSha256, true, reference.uiaManifestSha256],
  ]) {
    const binary = extracted[member];
    assert(binary, `missing extracted Windows reference member: ${member}`);
    const pinned = verifyPinnedBytes(binary.bytes, {
      sizeBytes: expectedSizeBytes,
      sha256: expectedSha256,
    }, `${member} reference binary`);
    const identity = inspectWindowsPe(binary.bytes, member);
    assert(identity.embeddedCertificateTablePresent === false, `${member} reference must remain unsigned`);
    assert(identity.manifest.executionLevel === "asInvoker", `${member} execution level changed`);
    assert(identity.manifest.uiAccess === expectedUiAccess, `${member} uiAccess manifest changed`);
    assert(identity.manifest.sha256 === expectedManifestSha256, `${member} manifest digest changed`);
    results.push({ member, role, ...pinned, ...identity });
  }
  return { binaries: results };
}

export function verifyReferenceArtifactEvidence({ platform, reference, evidence }) {
  assertExactKeys(evidence, ["archive", "identity", "platform", "schemaVersion", "usage"], "reference evidence");
  assert(evidence.schemaVersion === 1, "reference evidence schema changed");
  assert(evidence.usage === "reference_only_never_packaged", "reference evidence usage changed");
  assert(evidence.platform === platform, "reference evidence platform changed");
  const members = expectedReferenceMembers(platform, reference);
  assertExactKeys(evidence.archive, ["filename", "members", "sha256", "sizeBytes"], "reference archive evidence");
  assert(evidence.archive.filename === reference.filename, "reference evidence filename changed");
  assert(evidence.archive.sizeBytes === reference.sizeBytes, "reference evidence archive size changed");
  assert(evidence.archive.sha256 === reference.sha256, "reference evidence archive digest changed");
  assert(JSON.stringify(evidence.archive.members) === JSON.stringify(members), "reference evidence members changed");

  if (platform === "darwin") {
    const identity = evidence.identity;
    assertExactKeys(identity, ["architectures", "format", "member", "sha256", "signing", "sizeBytes", "slices"], "darwin reference identity");
    assert(identity.member === reference.member, "darwin reference identity member changed");
    assert(identity.sizeBytes === reference.binarySizeBytes, "darwin reference identity size changed");
    assert(identity.sha256 === reference.binarySha256, "darwin reference identity digest changed");
    assert(identity.format === "Mach-O universal", "darwin reference format changed");
    assert(JSON.stringify(identity.architectures) === JSON.stringify(["arm64", "x86_64"]), "darwin reference architectures changed");
    assert(Array.isArray(identity.slices) && identity.slices.length === 2, "darwin reference slices changed");
    for (const [index, architecture] of ["arm64", "x86_64"].entries()) {
      const slice = identity.slices[index];
      assertExactKeys(slice, ["architecture", "minimumOSVersion", "sdkVersion"], `darwin reference ${architecture} slice`);
      assert(
        slice.architecture === architecture
        && slice.minimumOSVersion === reference.minimumOSVersion
        && slice.sdkVersion === reference.sdkVersion,
        `darwin reference ${architecture} build identity changed`,
      );
    }
    assertExactKeys(identity.signing, ["authority", "entitlements", "hardenedRuntime", "identifier", "runtimeVersion", "teamId"], "darwin reference signing evidence");
    assert(identity.signing.identifier === reference.identifier, "darwin reference signing identifier changed");
    assert(identity.signing.teamId === reference.teamId, "darwin reference signing Team ID changed");
    assert(identity.signing.authority === reference.authority, "darwin reference signing authority changed");
    assert(identity.signing.hardenedRuntime === true, "darwin reference hardened runtime changed");
    assert(identity.signing.runtimeVersion === reference.runtimeVersion, "darwin reference runtime version changed");
    assert(JSON.stringify(identity.signing.entitlements) === JSON.stringify(reference.entitlements), "darwin reference signing entitlements changed");
    return true;
  }

  assertExactKeys(evidence.identity, ["binaries"], "Windows reference identity");
  assert(Array.isArray(evidence.identity.binaries) && evidence.identity.binaries.length === 2, "Windows reference binary evidence changed");
  for (const [index, member, role, sizeBytes, sha256, uiAccess, manifestSha256] of [
    [0, reference.mainMember, "main", reference.mainSizeBytes, reference.mainSha256, false, reference.mainManifestSha256],
    [1, reference.uiaMember, "uia-audit", reference.uiaSizeBytes, reference.uiaSha256, true, reference.uiaManifestSha256],
  ]) {
    const identity = evidence.identity.binaries[index];
    assertExactKeys(identity, [
      "architecture",
      "embeddedCertificateTablePresent",
      "format",
      "machine",
      "manifest",
      "member",
      "role",
      "sha256",
      "sizeBytes",
    ], `Windows reference ${role} identity`);
    assertExactKeys(identity.manifest, ["executionLevel", "sha256", "uiAccess"], `Windows reference ${role} manifest`);
    assert(identity.member === member && identity.role === role, `Windows reference ${role} member changed`);
    assert(identity.sizeBytes === sizeBytes && identity.sha256 === sha256, `Windows reference ${role} bytes changed`);
    assert(identity.format === "PE32+" && identity.machine === "0x8664" && identity.architecture === "x86_64", `Windows reference ${role} PE identity changed`);
    assert(identity.embeddedCertificateTablePresent === false, `Windows reference ${role} signing state changed`);
    assert(identity.manifest?.executionLevel === "asInvoker" && identity.manifest.uiAccess === uiAccess, `Windows reference ${role} manifest changed`);
    assert(identity.manifest.sha256 === manifestSha256, `Windows reference ${role} manifest digest changed`);
  }
  return true;
}

export async function downloadPinnedArchive(
  url,
  destinationPath,
  expected,
  fetchImpl,
  timeoutMs = DOWNLOAD_ATTEMPT_TIMEOUT_MS,
) {
  assert(typeof fetchImpl === "function", "Fetch-compatible reference downloader is required");
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "reference download timeout is invalid");
  let lastError;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    const partialPath = `${destinationPath}.partial`;
    const abortController = new AbortController();
    const timer = setTimeout(() => {
      abortController.abort(new Error(`reference download attempt timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    try {
      await rm(partialPath, { force: true });
      const response = await fetchImpl(url, {
        redirect: "follow",
        headers: { "User-Agent": "ling-cua-driver-source-builder/1" },
        signal: abortController.signal,
      });
      assert(response.ok && response.body, `reference download returned HTTP ${response.status}`);
      const contentLength = response.headers?.get?.("content-length");
      if (contentLength !== null && contentLength !== undefined && contentLength !== "") {
        assert(Number(contentLength) === expected.sizeBytes, `reference Content-Length mismatch: ${contentLength}`);
      }
      let observedBytes = 0;
      const exactSize = new Transform({
        transform(chunk, _encoding, callback) {
          observedBytes += chunk.length;
          if (observedBytes > expected.sizeBytes) {
            callback(new Error(`reference download exceeded ${expected.sizeBytes} bytes`));
            return;
          }
          callback(null, chunk);
        },
        flush(callback) {
          callback(observedBytes === expected.sizeBytes
            ? undefined
            : new Error(`reference download size mismatch: expected ${expected.sizeBytes}, found ${observedBytes}`));
        },
      });
      await pipeline(
        Readable.fromWeb(response.body),
        exactSize,
        createWriteStream(partialPath, { flags: "wx", mode: 0o600 }),
        { signal: abortController.signal },
      );
      await rename(partialPath, destinationPath);
      clearTimeout(timer);
      return;
    } catch (error) {
      lastError = error;
      clearTimeout(timer);
      await rm(partialPath, { force: true });
      if (attempt < DOWNLOAD_ATTEMPTS) await delay(attempt * 250);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`unable to download pinned reference archive: ${lastError?.message ?? lastError}`);
}

export function validateArchiveMemberPath(value) {
  assert(typeof value === "string" && value.length > 0, "reference archive member path is empty");
  assert(!value.includes("\\") && !value.includes("\0"), `reference archive member path is invalid: ${value}`);
  assert(!isAbsolute(value) && !/^[A-Za-z]:/u.test(value), `reference archive member path is absolute: ${value}`);
  const components = value.split("/");
  assert(components.every((component) => component && component !== "." && component !== ".."), `reference archive member path traverses: ${value}`);
  return components.join("/");
}

function splitListing(value) {
  return String(value).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function defaultTarPath(platform) {
  if (platform === "darwin") return "/usr/bin/tar";
  if (platform === "win32-x64") {
    const systemRoot = process.env.SystemRoot ?? process.env.windir;
    assert(systemRoot, "Windows SystemRoot is unavailable");
    return join(systemRoot, "System32", "tar.exe");
  }
  throw new Error(`unsupported reference platform: ${platform}`);
}

async function assertFreshPath(path, label) {
  try {
    await lstat(path);
    throw new Error(`${label} already exists: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function runText(command, args) {
  const result = await runCommand(command, args);
  return result.stdout.trim();
}

async function runBuffer(command, args) {
  const result = await execFile(command, args, { encoding: "buffer", maxBuffer: COMMAND_BUFFER_LIMIT, windowsHide: true });
  assert(Buffer.isBuffer(result.stdout), `${command} did not return binary stdout`);
  return result.stdout;
}

async function runCommand(command, args) {
  try {
    return await execFile(command, args, { encoding: "utf8", maxBuffer: COMMAND_BUFFER_LIMIT, windowsHide: true });
  } catch (error) {
    throw new Error(`${command} ${args.join(" ")} failed\n${[error.message, error.stdout, error.stderr].filter(Boolean).join("\n")}`);
  }
}

function lineValue(value, key) {
  return String(value).split(/\r?\n/u).find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
}

function extractPlist(value) {
  const start = value.indexOf("<?xml");
  const end = value.indexOf("</plist>", start);
  assert(start >= 0 && end >= start, "codesign did not return an entitlement plist");
  return value.slice(start, end + "</plist>".length);
}

export function parseBooleanEntitlements(value) {
  const plist = String(value).match(/<plist\b[^>]*>\s*<dict>([\s\S]*?)<\/dict>\s*<\/plist>\s*$/u);
  assert(plist, "codesign entitlement output is not a single plist dictionary");
  let remaining = plist[1];
  const entries = [];
  while (remaining.trim()) {
    const match = remaining.match(/^\s*<key>([^<]+)<\/key>\s*<(true|false)\s*\/>/u);
    assert(match, "codesign entitlement plist contains a non-boolean or malformed entry");
    entries.push([match[1], match[2] === "true"]);
    remaining = remaining.slice(match[0].length);
  }
  entries.sort(([left], [right]) => compareText(left, right));
  assert(entries.length > 0, "codesign entitlement plist has no boolean entries");
  assert(new Set(entries.map(([key]) => key)).size === entries.length, "codesign entitlement plist has duplicate keys");
  return Object.fromEntries(entries);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExactKeys(value, keys, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} keys changed`);
}
