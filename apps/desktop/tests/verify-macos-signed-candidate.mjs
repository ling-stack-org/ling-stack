import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readlink,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  LING_DESKTOP_BUNDLE_ID,
  MACOS_RELEASE_ARCHITECTURES,
  canonicalJson,
  captureMacosReleaseHarnessProvenance,
  macosSystemTool,
  reportRelativePath,
  resolveReportRelativePath,
} from "./macos-acceptance-common.mjs";

const OUTPUT_LIMIT_BYTES = 512 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEVELOPER_ID_AUTHORITY_PREFIX = "Developer ID Application:";
const NOTARIZED_DEVELOPER_ID_SOURCE = "Notarized Developer ID";
const REQUIRED_ARCHITECTURES = MACOS_RELEASE_ARCHITECTURES;
const REQUIRED_BUNDLE_ID = LING_DESKTOP_BUNDLE_ID;

export const MACOS_SIGNED_CANDIDATE_LIMITATIONS = Object.freeze({
  tccEvidence: false,
  captureIndicatorEvidence: false,
  voiceOverEvidence: false,
  statement:
    "This verifier establishes the arm64/x86_64 app, DMG, and ZIP signing, notarization-ticket, Gatekeeper, archive-integrity, and embedded-app binding evidence only. " +
    "It does not inspect or mutate macOS TCC state, observe the operating-system capture indicator, or exercise VoiceOver.",
});

export function parseCliArguments(argv) {
  const values = {
    apps: [],
    dmgs: [],
    zips: [],
    teamId: undefined,
    bundleId: undefined,
    output: undefined,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      values.help = true;
      continue;
    }
    const [name, inlineValue] = splitArgument(argument);
    if (
      ![
        "--app",
        "--dmg",
        "--zip",
        "--team-id",
        "--bundle-id",
        "--output",
      ].includes(name)
    ) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = inlineValue ?? argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    if (name === "--app") {
      values.apps.push(resolve(value));
    } else if (name === "--dmg") {
      values.dmgs.push(resolve(value));
    } else if (name === "--zip") {
      values.zips.push(resolve(value));
    } else if (name === "--team-id") {
      if (values.teamId !== undefined) {
        throw new Error("--team-id may be provided only once");
      }
      values.teamId = value;
    } else if (name === "--bundle-id") {
      if (values.bundleId !== undefined) {
        throw new Error("--bundle-id may be provided only once");
      }
      values.bundleId = value;
    } else if (name === "--output") {
      if (values.output !== undefined) {
        throw new Error("--output may be provided only once");
      }
      values.output = resolve(value);
    }
  }

  if (values.help) {
    return values;
  }
  if (!values.teamId) {
    throw new Error("--team-id is required");
  }
  if (!/^[A-Z0-9]{10}$/u.test(values.teamId)) {
    throw new Error("--team-id must be a 10-character uppercase Apple Team ID");
  }
  if (!values.bundleId) {
    throw new Error("--bundle-id is required");
  }
  if (values.bundleId !== REQUIRED_BUNDLE_ID) {
    throw new Error(`--bundle-id must be ${REQUIRED_BUNDLE_ID}`);
  }
  if (values.apps.length === 0) {
    throw new Error(
      "At least one --app artifact is required to establish signed candidate evidence",
    );
  }
  return {
    ...values,
    apps: deduplicate(values.apps),
    dmgs: deduplicate(values.dmgs),
    zips: deduplicate(values.zips),
  };
}

export function parseCodesignDetails(output) {
  const lines = String(output)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const valueFor = (prefix) =>
    lines.find((line) => line.startsWith(prefix))?.slice(prefix.length);
  const codeDirectory = lines.find((line) => line.startsWith("CodeDirectory "));
  const entitlements = extractEntitlementsPlist(String(output));
  return {
    executable: valueFor("Executable="),
    identifier: valueFor("Identifier="),
    format: valueFor("Format="),
    signature: valueFor("Signature="),
    authorities: lines
      .filter((line) => line.startsWith("Authority="))
      .map((line) => line.slice("Authority=".length)),
    teamIdentifier: valueFor("TeamIdentifier="),
    runtimeVersion: valueFor("Runtime Version="),
    cdhash: valueFor("CDHash="),
    cdhashFull: valueFor("CDHashFull="),
    codeDirectory,
    hardenedRuntime: Boolean(
      codeDirectory && /(?:\(|,)runtime(?:\)|,)/u.test(codeDirectory),
    ),
    entitlements,
    entitlementsSha256: entitlements
      ? sha256Buffer(Buffer.from(entitlements, "utf8"))
      : undefined,
  };
}

export function assertDeveloperIdSignature(
  details,
  expectedTeamId,
  label = "signed code",
) {
  const developerAuthority = details.authorities.find((authority) =>
    authority.startsWith(DEVELOPER_ID_AUTHORITY_PREFIX),
  );
  if (!developerAuthority) {
    throw new Error(
      `${label} is not signed by a Developer ID Application authority`,
    );
  }
  if (details.teamIdentifier !== expectedTeamId) {
    throw new Error(
      `${label} TeamIdentifier mismatch: expected ${expectedTeamId}, found ${details.teamIdentifier ?? "<missing>"}`,
    );
  }
  if (!details.hardenedRuntime) {
    throw new Error(
      `${label} is missing the hardened runtime code-signing flag`,
    );
  }
  if (!/^[0-9a-f]{40}$/iu.test(details.cdhash ?? "")) {
    throw new Error(`${label} is missing a canonical CodeDirectory CDHash`);
  }
  if (
    details.cdhashFull !== undefined &&
    !/^[0-9a-f]{64}$/iu.test(details.cdhashFull)
  ) {
    throw new Error(`${label} has an invalid full CodeDirectory hash`);
  }
  return {
    developerAuthority,
    teamIdentifier: details.teamIdentifier,
    hardenedRuntime: true,
    cdhash: details.cdhash.toLowerCase(),
    cdhashFull: details.cdhashFull?.toLowerCase(),
  };
}

export function assertNestedMachOArchitectureCompatibility(
  mainArchitectures,
  nestedArchitectures,
  label = "nested Mach-O",
) {
  const missing = mainArchitectures.filter(
    (architecture) => !nestedArchitectures.includes(architecture),
  );
  if (missing.length > 0) {
    throw new Error(
      `${label} is missing app execution architecture${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
    );
  }
  return [...nestedArchitectures].sort();
}

export function parseSpctlAssessment(output) {
  const lines = String(output)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    accepted: lines.some(
      (line) => line === "accepted" || /:\s*accepted$/u.test(line),
    ),
    source: lines
      .find((line) => line.startsWith("source="))
      ?.slice("source=".length),
    origin: lines
      .find((line) => line.startsWith("origin="))
      ?.slice("origin=".length),
  };
}

export function assertNotarizedAssessment(assessment, label = "artifact") {
  if (assessment.accepted !== true) {
    throw new Error(`${label} was not accepted by Gatekeeper`);
  }
  if (assessment.source !== NOTARIZED_DEVELOPER_ID_SOURCE) {
    throw new Error(
      `${label} Gatekeeper source must be ${NOTARIZED_DEVELOPER_ID_SOURCE}, found ${assessment.source ?? "<missing>"}`,
    );
  }
  return assessment;
}

export function parseMachOHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return undefined;
  }
  const magic = buffer.subarray(0, 4).toString("hex");
  const formats = {
    feedface: { kind: "mach-o", bits: 32, endian: "big", fat: false },
    cefaedfe: { kind: "mach-o", bits: 32, endian: "little", fat: false },
    feedfacf: { kind: "mach-o", bits: 64, endian: "big", fat: false },
    cffaedfe: { kind: "mach-o", bits: 64, endian: "little", fat: false },
    cafebabe: { kind: "fat-mach-o", bits: 32, endian: "big", fat: true },
    bebafeca: { kind: "fat-mach-o", bits: 32, endian: "little", fat: true },
    cafebabf: { kind: "fat-mach-o", bits: 64, endian: "big", fat: true },
    bfbafeca: { kind: "fat-mach-o", bits: 64, endian: "little", fat: true },
  };
  const format = formats[magic];
  if (!format) {
    return undefined;
  }
  if (format.fat) {
    return {
      ...format,
      magic,
      architectureCount:
        buffer.length >= 8 ? readUInt32(buffer, 4, format.endian) : undefined,
    };
  }
  const cpuType =
    buffer.length >= 8 ? readUInt32(buffer, 4, format.endian) : undefined;
  return {
    ...format,
    magic,
    cpuType,
    architecture: architectureForCpuType(cpuType),
  };
}

export async function verifyMacosSignedCandidate(input) {
  if (process.platform !== "darwin") {
    throw new Error("macOS signed-candidate verification must run on darwin");
  }
  if (!/^[A-Z0-9]{10}$/u.test(input?.teamId ?? "")) {
    throw new Error(
      "macOS signed-candidate verification requires a valid Team ID",
    );
  }
  if (input?.bundleId !== REQUIRED_BUNDLE_ID) {
    throw new Error(
      `macOS signed-candidate verification requires ${REQUIRED_BUNDLE_ID}`,
    );
  }
  if (!Array.isArray(input?.apps) || input.apps.length === 0) {
    throw new Error(
      "macOS signed-candidate verification requires at least one app",
    );
  }
  const reportDirectory = resolve(input.reportDirectory ?? process.cwd());
  const verificationInput = { ...input, reportDirectory };
  const startedAt = new Date().toISOString();
  const apps = [];
  const dmgs = [];
  const zips = [];
  for (const path of input.apps) {
    const resolvedPath = resolve(path);
    apps.push(
      await captureArtifact("app", reportRelativePath(reportDirectory, resolvedPath), () =>
        verifyApp(resolvedPath, verificationInput),
      ),
    );
  }
  for (const path of input.dmgs ?? []) {
    const resolvedPath = resolve(path);
    dmgs.push(
      await captureArtifact("dmg", reportRelativePath(reportDirectory, resolvedPath), () =>
        verifyDmg(resolvedPath, verificationInput),
      ),
    );
  }
  for (const path of input.zips ?? []) {
    const resolvedPath = resolve(path);
    zips.push(
      await captureArtifact("zip", reportRelativePath(reportDirectory, resolvedPath), () =>
        verifyZip(resolvedPath, verificationInput),
      ),
    );
  }
  const artifacts = { apps, dmgs, zips };
  let matrix;
  try {
    matrix = assertMacosCandidateMatrix(artifacts);
  } catch (error) {
    matrix = {
      pass: false,
      requiredArchitectures: [...REQUIRED_ARCHITECTURES],
      error: serializeError(error),
    };
  }
  const pass =
    Object.values(artifacts)
      .flat()
      .every((artifact) => artifact.pass === true) && matrix.pass === true;
  return {
    schemaVersion: 1,
    kind: "ling-desktop-macos-signed-candidate",
    generatedAt: startedAt,
    platform: process.platform,
    expected: {
      teamId: input.teamId,
      ...(input.bundleId ? { bundleId: input.bundleId } : {}),
    },
    ...(input.harness ? { harness: input.harness } : {}),
    apps,
    dmgs,
    zips,
    matrix,
    limitations: MACOS_SIGNED_CANDIDATE_LIMITATIONS,
    verdict: {
      status: pass ? "PASS" : "FAIL",
      pass,
      signedCandidateEvidence: pass,
      overallReleaseGateClosed: false,
      reason: pass
        ? "The arm64/x86_64 app, DMG, and ZIP matrix is Developer ID signed, notarized, Gatekeeper accepted, stapled, archive-integrity checked, and content-bound. TCC, capture-indicator, VoiceOver, signed performance, and clean-host review remain separate gates."
        : "At least one artifact failed signed-candidate verification.",
    },
  };
}

async function verifyApp(path, input, options = {}) {
  await assertArtifactPath(path, ".app", "directory");
  const infoPlist = join(path, "Contents", "Info.plist");
  const bundleIdentifier = await readPlistString(
    infoPlist,
    "CFBundleIdentifier",
  );
  const executableName = await readPlistString(infoPlist, "CFBundleExecutable");
  if (input.bundleId && bundleIdentifier !== input.bundleId) {
    throw new Error(
      `Bundle identifier mismatch: expected ${input.bundleId}, found ${bundleIdentifier}`,
    );
  }

  const bundleVerify = await runCommand(macosSystemTool("codesign"), [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=4",
    path,
  ]);
  const bundleDetails = await readCodesignDetails(path);
  const bundleIdentity = assertDeveloperIdSignature(
    bundleDetails,
    input.teamId,
    `${path} main app`,
  );
  if (bundleDetails.identifier !== bundleIdentifier) {
    throw new Error(
      `${path} code-signing identifier mismatch: expected ${bundleIdentifier}, found ${bundleDetails.identifier ?? "<missing>"}`,
    );
  }

  const mainExecutablePath = join(path, "Contents", "MacOS", executableName);
  const architectureCommand = await runCommand(macosSystemTool("lipo"), [
    "-archs",
    mainExecutablePath,
  ]);
  const architectures = parseArchitectures(architectureCommand.stdout);
  if (architectures.length === 0) {
    throw new Error(
      `${mainExecutablePath} has no recognized release architecture`,
    );
  }

  const machOFiles = await discoverMachOFiles(path);
  if (machOFiles.length === 0) {
    throw new Error(`${path} contains no Mach-O code`);
  }
  const nestedCode = [];
  for (const entry of machOFiles) {
    const verification = await runCommand(macosSystemTool("codesign"), [
      "--verify",
      "--strict",
      "--verbose=4",
      entry.path,
    ]);
    const details = await readCodesignDetails(entry.path);
    const identity = assertDeveloperIdSignature(
      details,
      input.teamId,
      entry.path,
    );
    const nestedArchitectureCommand = await runCommand(
      macosSystemTool("lipo"),
      ["-archs", entry.path],
    );
    const nestedArchitectures = parseArchitectures(
      nestedArchitectureCommand.stdout,
    );
    assertNestedMachOArchitectureCompatibility(
      architectures,
      nestedArchitectures,
      entry.path,
    );
    nestedCode.push({
      path: relative(path, entry.path),
      machO: entry.header,
      architectures: nestedArchitectures,
      identifier: details.identifier,
      developerAuthority: identity.developerAuthority,
      teamIdentifier: identity.teamIdentifier,
      hardenedRuntime: identity.hardenedRuntime,
      cdhash: identity.cdhash,
      cdhashFull: identity.cdhashFull,
      entitlementsSha256: details.entitlementsSha256,
      verification: summarizeCommand(verification),
    });
  }

  const assessmentCommand = await runCommand(macosSystemTool("spctl"), [
    "--assess",
    "--type",
    "execute",
    "--verbose=4",
    path,
  ]);
  const assessment = assertNotarizedAssessment(
    parseSpctlAssessment(combinedOutput(assessmentCommand)),
    path,
  );
  const stapler = await runCommand(macosSystemTool("xcrun"), [
    "stapler",
    "validate",
    path,
  ]);
  const bundleTreeSha256 = await computeAppBundleTreeSha256(path);

  return {
    type: "app",
    path: options.reportedPath ?? reportRelativePath(input.reportDirectory, path),
    pass: true,
    bundleIdentifier,
    executableName,
    mainExecutable: {
      path: relative(path, mainExecutablePath).split(sep).join("/"),
      sha256: await sha256File(mainExecutablePath),
      architectures,
    },
    mainSignature: {
      identifier: bundleDetails.identifier,
      developerAuthority: bundleIdentity.developerAuthority,
      teamIdentifier: bundleIdentity.teamIdentifier,
      hardenedRuntime: bundleIdentity.hardenedRuntime,
      cdhash: bundleIdentity.cdhash,
      cdhashFull: bundleIdentity.cdhashFull,
      runtimeVersion: bundleDetails.runtimeVersion,
      entitlementsSha256: bundleDetails.entitlementsSha256,
    },
    bundleFingerprint: {
      treeSha256: bundleTreeSha256,
      cdhash: bundleIdentity.cdhash,
      cdhashFull: bundleIdentity.cdhashFull,
    },
    bundleVerification: summarizeCommand(bundleVerify),
    nestedMachOCount: nestedCode.length,
    nestedCode,
    gatekeeper: assessment,
    stapler: { validated: true, ...summarizeCommand(stapler) },
  };
}

async function verifyDmg(path, input) {
  await assertArtifactPath(path, ".dmg", "file");
  const integrity = await runCommand(macosSystemTool("hdiutil"), ["verify", path]);
  const assessmentCommand = await runCommand(macosSystemTool("spctl"), [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    "--verbose=4",
    path,
  ]);
  const assessment = assertNotarizedAssessment(
    parseSpctlAssessment(combinedOutput(assessmentCommand)),
    path,
  );
  assertAssessmentTeam(assessment, input.teamId, path);
  const stapler = await runCommand(macosSystemTool("xcrun"), [
    "stapler",
    "validate",
    path,
  ]);
  const embeddedApp = await inspectDmgApp(path, input);
  return {
    type: "dmg",
    path: reportRelativePath(input.reportDirectory, path),
    pass: true,
    sha256: await sha256File(path),
    integrity: summarizeCommand(integrity),
    gatekeeper: assessment,
    stapler: { validated: true, ...summarizeCommand(stapler) },
    embeddedApp,
  };
}

async function verifyZip(path, input) {
  await assertArtifactPath(path, ".zip", "file");
  const integrity = await runCommand(macosSystemTool("unzip"), ["-t", path]);
  const embeddedApp = await inspectZipApp(path, input);
  return {
    type: "zip",
    path: reportRelativePath(input.reportDirectory, path),
    pass: true,
    sha256: await sha256File(path),
    integrity: summarizeCommand(integrity),
    embeddedApp,
  };
}

export function assertMacosCandidateMatrix({ apps, dmgs, zips }) {
  const passingApps = apps.filter((artifact) => artifact?.pass === true);
  const passingDmgs = dmgs.filter((artifact) => artifact?.pass === true);
  const passingZips = zips.filter((artifact) => artifact?.pass === true);
  if (
    passingApps.length === 0 ||
    passingDmgs.length === 0 ||
    passingZips.length === 0
  ) {
    throw new Error(
      "Signed release evidence requires app, DMG, and ZIP artifacts",
    );
  }
  const standaloneKeys = new Set(passingApps.flatMap(candidateKeys));
  const coverage = {
    apps: architectureCoverage(passingApps),
    dmgs: architectureCoverage(
      passingDmgs.map((artifact) => artifact.embeddedApp),
    ),
    zips: architectureCoverage(
      passingZips.map((artifact) => artifact.embeddedApp),
    ),
  };
  for (const [kind, architectures] of Object.entries(coverage)) {
    for (const architecture of REQUIRED_ARCHITECTURES) {
      if (!architectures.includes(architecture)) {
        throw new Error(`${kind} release matrix is missing ${architecture}`);
      }
    }
  }
  const releaseArtifacts = {
    apps: passingApps,
    dmgs: passingDmgs.map((artifact) => artifact.embeddedApp),
    zips: passingZips.map((artifact) => artifact.embeddedApp),
  };
  for (const [kind, artifacts] of Object.entries(releaseArtifacts)) {
    for (const architecture of REQUIRED_ARCHITECTURES) {
      if (
        !artifacts.some(
          (artifact) =>
            artifact?.mainExecutable?.architectures?.length === 1 &&
            artifact.mainExecutable.architectures[0] === architecture,
        )
      ) {
        throw new Error(
          `${kind} release matrix requires a dedicated ${architecture} artifact`,
        );
      }
    }
  }
  for (const artifact of [...passingDmgs, ...passingZips]) {
    const keys = candidateKeys(artifact.embeddedApp);
    if (keys.length === 0 || !keys.some((key) => standaloneKeys.has(key))) {
      throw new Error(
        `${artifact.path} embedded app does not match a verified standalone app`,
      );
    }
  }
  return {
    pass: true,
    requiredArchitectures: [...REQUIRED_ARCHITECTURES],
    coverage,
  };
}

export function candidateReportFingerprint(report) {
  if (
    report?.schemaVersion !== 1 ||
    report?.kind !== "ling-desktop-macos-signed-candidate" ||
    report?.verdict?.status !== "PASS" ||
    report?.verdict?.pass !== true ||
    report?.verdict?.signedCandidateEvidence !== true ||
    report?.matrix?.pass !== true ||
    report?.expected?.bundleId !== REQUIRED_BUNDLE_ID ||
    !/^[A-Z0-9]{10}$/u.test(report?.expected?.teamId ?? "") ||
    !Array.isArray(report?.apps) ||
    !Array.isArray(report?.dmgs) ||
    !Array.isArray(report?.zips)
  ) {
    throw new Error("macos_signed_candidate_report_invalid");
  }
  assertMacosCandidateMatrix(report);
  return {
    expected: {
      teamId: report.expected.teamId,
      bundleId: report.expected.bundleId,
    },
    matrix: {
      requiredArchitectures: [...(report.matrix.requiredArchitectures ?? [])].sort(),
      coverage: Object.fromEntries(
        ["apps", "dmgs", "zips"].map((kind) => [
          kind,
          [...(report.matrix.coverage?.[kind] ?? [])].sort(),
        ]),
      ),
    },
    apps: report.apps.map(appFingerprint).sort(compareFingerprint),
    dmgs: report.dmgs.map(dmgFingerprint).sort(compareFingerprint),
    zips: report.zips.map(zipFingerprint).sort(compareFingerprint),
  };
}

export function resolveMacosCandidateArtifactPaths(report, reportPath) {
  candidateReportFingerprint(report);
  const resolveArtifacts = (artifacts, kind) =>
    artifacts.map((artifact, index) =>
      resolveReportRelativePath(reportPath, artifact.path, `${kind}.${index}.path`),
    );
  return {
    apps: resolveArtifacts(report.apps, "apps"),
    dmgs: resolveArtifacts(report.dmgs, "dmgs"),
    zips: resolveArtifacts(report.zips, "zips"),
  };
}

export async function reverifyMacosSignedCandidateReport(report, reportPath) {
  const artifactPaths = resolveMacosCandidateArtifactPaths(report, reportPath);
  const live = await verifyMacosSignedCandidate({
    ...artifactPaths,
    teamId: report.expected.teamId,
    bundleId: report.expected.bundleId,
    reportDirectory: dirname(resolve(reportPath)),
    harness: report.harness,
  });
  if (live.verdict.pass !== true) {
    throw new Error("macos_signed_candidate_live_verification_failed");
  }
  if (
    JSON.stringify(candidateReportFingerprint(live)) !==
    JSON.stringify(candidateReportFingerprint(report))
  ) {
    throw new Error("macos_signed_candidate_live_report_mismatch");
  }
  return live;
}

async function inspectDmgApp(path, input) {
  const mountPoint = await mkdtemp(join(tmpdir(), "ling-macos-signed-dmg-"));
  let mounted = false;
  try {
    await runCommand(macosSystemTool("hdiutil"), [
      "attach",
      "-nobrowse",
      "-readonly",
      "-mountpoint",
      mountPoint,
      path,
    ]);
    mounted = true;
    return await verifyUniqueEmbeddedApp(mountPoint, input, path);
  } finally {
    if (mounted) {
      try {
        await runCommand(macosSystemTool("hdiutil"), ["detach", mountPoint], 30_000);
      } catch {
        await runCommand(
          macosSystemTool("hdiutil"),
          ["detach", "-force", mountPoint],
          30_000,
        ).catch(() => undefined);
      }
    }
    await rm(mountPoint, { recursive: true, force: true });
  }
}

async function inspectZipApp(path, input) {
  const extractionRoot = await mkdtemp(
    join(tmpdir(), "ling-macos-signed-zip-"),
  );
  try {
    await runCommand(macosSystemTool("ditto"), ["-x", "-k", path, extractionRoot]);
    return await verifyUniqueEmbeddedApp(extractionRoot, input, path);
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

async function verifyUniqueEmbeddedApp(root, input, archivePath) {
  const candidates = await discoverTopLevelAppBundles(root);
  const matches = [];
  for (const candidate of candidates) {
    try {
      const bundleIdentifier = await readPlistString(
        join(candidate, "Contents", "Info.plist"),
        "CFBundleIdentifier",
      );
      if (!input.bundleId || bundleIdentifier === input.bundleId) {
        matches.push(candidate);
      }
    } catch {
      // Ignore unrelated malformed bundles; the exact release app must still be unique.
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `${archivePath} must contain exactly one matching release app, found ${matches.length}`,
    );
  }
  return verifyApp(matches[0], input, {
    reportedPath: reportRelativePath(root, matches[0]),
  });
}

async function discoverTopLevelAppBundles(root) {
  const matches = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.name.toLowerCase().endsWith(".app")) {
        matches.push(path);
      } else {
        await walk(path);
      }
    }
  }
  await walk(root);
  return matches;
}

async function readCodesignDetails(path) {
  const result = await runCommand(macosSystemTool("codesign"), [
    "--display",
    "--verbose=4",
    "--entitlements",
    ":-",
    path,
  ]);
  return parseCodesignDetails(combinedOutput(result));
}

async function readPlistString(path, key) {
  const result = await runCommand(macosSystemTool("plutil"), [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    path,
  ]);
  const value = result.stdout.trim();
  if (!value) {
    throw new Error(`${path} is missing ${key}`);
  }
  return value;
}

async function discoverMachOFiles(root) {
  const matches = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const header = await readMachOHeader(path);
      if (header) {
        matches.push({ path, header });
      }
    }
  }
  await walk(root);
  return matches.sort((left, right) => left.path.localeCompare(right.path));
}

async function readMachOHeader(path) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(32);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseMachOHeader(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function assertArtifactPath(path, suffix, kind) {
  if (extname(path).toLowerCase() !== suffix) {
    throw new Error(`${path} must have a ${suffix} suffix`);
  }
  const metadata = await stat(path);
  if (kind === "directory" ? !metadata.isDirectory() : !metadata.isFile()) {
    throw new Error(`${path} must be a ${kind}`);
  }
}

async function captureArtifact(type, path, operation) {
  try {
    return await operation();
  } catch (error) {
    return {
      type,
      path,
      pass: false,
      error: serializeError(error),
    };
  }
}

async function runCommand(
  command,
  args,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = boundedAppend(stderr, chunk);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      const result = { command, args, exitCode, signal, stdout, stderr };
      if (exitCode === 0) {
        resolvePromise(result);
      } else {
        rejectPromise(new CommandFailure(result));
      }
    });
  });
}

class CommandFailure extends Error {
  constructor(result) {
    super(
      `${result.command} ${result.args.join(" ")} failed with ${result.exitCode ?? result.signal ?? "unknown"}: ` +
        `${(result.stderr || result.stdout).trim() || "no command output"}`,
    );
    this.name = "CommandFailure";
    this.code = "command_failed";
    this.result = result;
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function computeAppBundleTreeSha256(root) {
  const hash = createHash("sha256");
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join("/");
      const metadata = await lstat(path);
      const mode = metadata.mode & 0o7777;
      if (entry.isSymbolicLink()) {
        hash.update(`symlink\0${relativePath}\0${mode.toString(8)}\0${await readlink(path)}\0`);
        continue;
      }
      if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\0${mode.toString(8)}\0`);
        await walk(path);
        continue;
      }
      if (entry.isFile()) {
        hash.update(`file\0${relativePath}\0${mode.toString(8)}\0${metadata.size}\0`);
        for await (const chunk of createReadStream(path)) {
          hash.update(chunk);
        }
        hash.update("\0");
        continue;
      }
      throw new Error(`${path} contains an unsupported bundle entry type`);
    }
  };
  await walk(root);
  return hash.digest("hex");
}

function extractEntitlementsPlist(output) {
  const xmlStart = output.indexOf("<?xml");
  const plistStart = xmlStart >= 0 ? xmlStart : output.indexOf("<plist");
  if (plistStart < 0) {
    return undefined;
  }
  const endMarker = "</plist>";
  const end = output.indexOf(endMarker, plistStart);
  return end < 0
    ? undefined
    : output.slice(plistStart, end + endMarker.length).trim();
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function serializeError(error) {
  if (error instanceof CommandFailure) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      command: summarizeCommand(error.result),
    };
  }
  return {
    name: error instanceof Error ? error.name : "Error",
    code: "verification_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

function summarizeCommand(result) {
  return {
    command: result.command,
    args: result.args,
    exitCode: result.exitCode,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function combinedOutput(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function parseArchitectures(output) {
  return deduplicate(
    String(output)
      .trim()
      .split(/\s+/u)
      .filter((architecture) => REQUIRED_ARCHITECTURES.includes(architecture)),
  ).sort();
}

function architectureCoverage(artifacts) {
  return deduplicate(
    artifacts.flatMap(
      (artifact) => artifact?.mainExecutable?.architectures ?? [],
    ),
  ).sort();
}

function candidateKeys(artifact) {
  const sha256 = artifact?.mainExecutable?.sha256;
  const treeSha256 = artifact?.bundleFingerprint?.treeSha256;
  const cdhash = artifact?.bundleFingerprint?.cdhash;
  const cdhashFull = artifact?.bundleFingerprint?.cdhashFull ?? "";
  if (
    !/^[0-9a-f]{64}$/u.test(sha256 ?? "") ||
    !/^[0-9a-f]{64}$/u.test(treeSha256 ?? "") ||
    !/^[0-9a-f]{40}$/u.test(cdhash ?? "") ||
    (cdhashFull !== "" && !/^[0-9a-f]{64}$/u.test(cdhashFull))
  ) {
    return [];
  }
  return (artifact.mainExecutable.architectures ?? []).map(
    (architecture) =>
      `${architecture}:${sha256}:${treeSha256}:${cdhash}:${cdhashFull}`,
  );
}

function appFingerprint(app) {
  if (
    app?.type !== "app" ||
    app?.pass !== true ||
    typeof app?.path !== "string" ||
    app?.bundleIdentifier !== REQUIRED_BUNDLE_ID ||
    !/^[0-9a-f]{64}$/u.test(app?.mainExecutable?.sha256 ?? "") ||
    !Array.isArray(app?.mainExecutable?.architectures) ||
    !app.mainExecutable.architectures.every((architecture) =>
      REQUIRED_ARCHITECTURES.includes(architecture),
    ) ||
    app?.mainSignature?.teamIdentifier === undefined ||
    app?.mainSignature?.hardenedRuntime !== true ||
    !/^[0-9a-f]{64}$/u.test(app?.bundleFingerprint?.treeSha256 ?? "") ||
    !/^[0-9a-f]{40}$/u.test(app?.bundleFingerprint?.cdhash ?? "") ||
    (
      app?.bundleFingerprint?.cdhashFull !== undefined &&
      !/^[0-9a-f]{64}$/u.test(app.bundleFingerprint.cdhashFull)
    ) ||
    app?.gatekeeper?.accepted !== true ||
    app?.gatekeeper?.source !== NOTARIZED_DEVELOPER_ID_SOURCE ||
    app?.stapler?.validated !== true
  ) {
    throw new Error("macos_signed_candidate_app_invalid");
  }
  return {
    path: app.path,
    bundleIdentifier: app.bundleIdentifier,
    mainExecutable: {
      path: app.mainExecutable.path,
      sha256: app.mainExecutable.sha256,
      architectures: [...app.mainExecutable.architectures].sort(),
    },
    mainSignature: {
      teamIdentifier: app.mainSignature.teamIdentifier,
      hardenedRuntime: true,
      entitlementsSha256: app.mainSignature.entitlementsSha256,
    },
    bundleFingerprint: {
      treeSha256: app.bundleFingerprint.treeSha256,
      cdhash: app.bundleFingerprint.cdhash,
      ...(app.bundleFingerprint.cdhashFull
        ? { cdhashFull: app.bundleFingerprint.cdhashFull }
        : {}),
    },
    gatekeeper: {
      accepted: true,
      source: app.gatekeeper.source,
    },
    staplerValidated: true,
  };
}

function embeddedAppFingerprint(app) {
  const fingerprint = appFingerprint(app);
  return {
    bundleIdentifier: fingerprint.bundleIdentifier,
    mainExecutable: fingerprint.mainExecutable,
    mainSignature: fingerprint.mainSignature,
    bundleFingerprint: fingerprint.bundleFingerprint,
    gatekeeper: fingerprint.gatekeeper,
    staplerValidated: true,
  };
}

function dmgFingerprint(dmg) {
  if (
    dmg?.type !== "dmg" ||
    dmg?.pass !== true ||
    typeof dmg?.path !== "string" ||
    !/^[0-9a-f]{64}$/u.test(dmg?.sha256 ?? "") ||
    dmg?.gatekeeper?.accepted !== true ||
    dmg?.gatekeeper?.source !== NOTARIZED_DEVELOPER_ID_SOURCE ||
    dmg?.stapler?.validated !== true
  ) {
    throw new Error("macos_signed_candidate_dmg_invalid");
  }
  return {
    path: dmg.path,
    sha256: dmg.sha256,
    embeddedApp: embeddedAppFingerprint(dmg.embeddedApp),
    gatekeeper: { accepted: true, source: dmg.gatekeeper.source },
    staplerValidated: true,
  };
}

function zipFingerprint(zip) {
  if (
    zip?.type !== "zip" ||
    zip?.pass !== true ||
    typeof zip?.path !== "string" ||
    !/^[0-9a-f]{64}$/u.test(zip?.sha256 ?? "")
  ) {
    throw new Error("macos_signed_candidate_zip_invalid");
  }
  return {
    path: zip.path,
    sha256: zip.sha256,
    embeddedApp: embeddedAppFingerprint(zip.embeddedApp),
  };
}

function compareFingerprint(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function assertAssessmentTeam(assessment, expectedTeamId, label) {
  if (
    typeof assessment.origin !== "string" ||
    !assessment.origin.includes(`(${expectedTeamId})`)
  ) {
    throw new Error(
      `${label} Gatekeeper origin is not bound to Team ID ${expectedTeamId}`,
    );
  }
}

function boundedAppend(current, chunk) {
  const next = `${current}${String(chunk)}`;
  return Buffer.byteLength(next, "utf8") <= OUTPUT_LIMIT_BYTES
    ? next
    : Buffer.from(next, "utf8").subarray(-OUTPUT_LIMIT_BYTES).toString("utf8");
}

function architectureForCpuType(cpuType) {
  return new Map([
    [7, "x86"],
    [0x01000007, "x86_64"],
    [12, "arm"],
    [0x0100000c, "arm64"],
  ]).get(cpuType);
}

function readUInt32(buffer, offset, endian) {
  return endian === "little"
    ? buffer.readUInt32LE(offset)
    : buffer.readUInt32BE(offset);
}

function splitArgument(argument) {
  const separator = argument.indexOf("=");
  return separator < 0
    ? [argument, undefined]
    : [argument.slice(0, separator), argument.slice(separator + 1)];
}

function deduplicate(values) {
  return [...new Set(values)];
}

function usage() {
  return [
    "Usage: node apps/desktop/tests/verify-macos-signed-candidate.mjs \\",
    "  --team-id ABCDE12345 --bundle-id com.lingstack.desktop \\",
    "  [--app <path>]... [--dmg <path>]... [--zip <path>]... [--output <report.json>]",
    "",
    "The verifier requires an already signed/notarized arm64+x86_64 app/DMG/ZIP matrix, stores report-relative artifact paths, and never signs, notarizes, or changes TCC state.",
  ].join("\n");
}

async function main() {
  const input = parseCliArguments(process.argv.slice(2));
  if (input.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const harness = await captureMacosReleaseHarnessProvenance([
    fileURLToPath(import.meta.url),
    fileURLToPath(new URL("./macos-acceptance-common.mjs", import.meta.url)),
  ]);
  const report = await verifyMacosSignedCandidate({
    ...input,
    harness,
    reportDirectory: input.output ? dirname(input.output) : process.cwd(),
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (input.output) {
    await mkdir(dirname(input.output), { recursive: true });
    await writeFile(input.output, json, "utf8");
  }
  process.stdout.write(json);
  if (!report.verdict.pass) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`,
    );
    process.exitCode = 1;
  });
}
