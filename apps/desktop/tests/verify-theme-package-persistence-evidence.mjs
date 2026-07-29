#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, win32 } from "node:path";

const METADATA_FILE = "metadata.json";
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const ID_PATTERN = /^[A-Z0-9][A-Z0-9._-]{1,63}$/u;
const THEME_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const PLATFORM_ARCHES = Object.freeze({
  darwin: new Set(["arm64", "x64"]),
  win32: new Set(["x64"]),
});

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ status: "invalid", error: message }, null, 2)}\n`);
  process.exit(1);
}
if (options.help) {
  process.stdout.write(helpText());
  process.exit(0);
}

try {
  const result = await verifyEvidence(options.evidenceDirectory);
  process.stdout.write(`${JSON.stringify({ status: "verified", ...result }, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ status: "invalid", error: message }, null, 2)}\n`);
  process.exitCode = 1;
}

async function verifyEvidence(inputDirectory) {
  const requestedRoot = resolve(inputDirectory);
  const requestedInfo = await lstat(requestedRoot).catch((error) => {
    throw new Error(`Evidence directory is unavailable: ${readErrorCode(error)}`);
  });
  assert(!requestedInfo.isSymbolicLink(), "Evidence directory must not be a symlink");
  assert(requestedInfo.isDirectory(), "Evidence path must be a directory");

  const authorityRoot = await realpath(requestedRoot);
  const pathRegistry = new Map();
  const inodeRegistry = new Map();
  const metadataReference = await resolveEvidenceFile({
    authorityRoot,
    relativePath: METADATA_FILE,
    label: "metadata",
    pathRegistry,
    inodeRegistry,
  });
  const metadata = await readJson(metadataReference, MAX_METADATA_BYTES, "metadata.json");
  validateMetadataSchema(metadata);

  const fileReferences = collectFileReferences(metadata);
  const verifiedFiles = new Map();
  for (const reference of fileReferences) {
    const resolved = await resolveEvidenceFile({
      authorityRoot,
      relativePath: reference.path,
      label: reference.label,
      pathRegistry,
      inodeRegistry,
    });
    const actualSha256 = await sha256File(resolved);
    assert(
      actualSha256 === reference.sha256,
      `${reference.label} SHA-256 mismatch for ${reference.path}: expected ${reference.sha256}, received ${actualSha256}`,
    );
    verifiedFiles.set(reference.path, { ...reference, resolved, actualSha256 });
  }

  const reportReference = verifiedFiles.get(metadata.report.path);
  assert(reportReference, "Report file was not registered for verification");
  const report = await readJsonAndVerifySha256(
    reportReference.resolved,
    metadata.report.sha256,
    MAX_REPORT_BYTES,
    metadata.report.path,
  );
  validateReport(metadata, report, verifiedFiles);

  return {
    evidenceDirectory: authorityRoot,
    functionId: metadata.functionId,
    harness: metadata.harness,
    platform: metadata.platform,
    arch: metadata.arch,
    gateStatus: metadata.status,
    candidate: {
      version: metadata.candidate.version,
      commit: metadata.candidate.commit,
      applicationId: metadata.candidate.applicationId,
      artifactSha256: metadata.candidate.artifact.sha256,
      executableSha256: metadata.candidate.executable.sha256,
      appAsarSha256: metadata.candidate.appAsar.sha256,
    },
    verifiedFileCount: fileReferences.length,
    screenshotCount: metadata.screenshots.length,
    logCount: metadata.logs.length,
    requiredStepCount: metadata.requiredStepIds.length,
    firstFrameTransitionCount: metadata.firstFrameTransitions.length,
  };
}

function validateMetadataSchema(metadata) {
  assertPlainObject(metadata, "metadata");
  assertKnownKeys(metadata, [
    "schemaVersion",
    "functionId",
    "harness",
    "status",
    "platform",
    "arch",
    "candidate",
    "report",
    "screenshots",
    "logs",
    "requiredStepIds",
    "firstFrameTransitions",
    "generatedAt",
    "notes",
  ], "metadata");
  assert(metadata.schemaVersion === 1, "metadata.schemaVersion must be 1");
  assert(
    metadata.functionId === "DESKTOP-THEME-PACK-PERSISTENCE-001",
    "metadata.functionId must be DESKTOP-THEME-PACK-PERSISTENCE-001",
  );
  assertNonEmptyString(metadata.harness, "metadata.harness", 80);
  assert(["passed", "failed", "uncovered"].includes(metadata.status), "metadata.status must be passed, failed, or uncovered");
  assert(Object.hasOwn(PLATFORM_ARCHES, metadata.platform), "metadata.platform must be darwin or win32");
  assert(
    PLATFORM_ARCHES[metadata.platform].has(metadata.arch),
    `metadata.arch ${String(metadata.arch)} is not valid for ${metadata.platform}`,
  );
  if (metadata.generatedAt !== undefined) assertIsoDate(metadata.generatedAt, "metadata.generatedAt");
  if (metadata.notes !== undefined) assertStringArray(metadata.notes, "metadata.notes", { allowEmpty: true, maxItems: 100 });

  validateCandidate(metadata.candidate);
  validateFileReference(metadata.report, "metadata.report", ["path", "sha256"]);
  validateEvidenceList(metadata.screenshots, "metadata.screenshots", validateScreenshotReference);
  validateEvidenceList(metadata.logs, "metadata.logs", validateLogReference);
  assert(metadata.screenshots.length > 0, "metadata.screenshots must contain evidence");
  assert(metadata.logs.length > 0, "metadata.logs must contain evidence");

  assertStringArray(metadata.requiredStepIds, "metadata.requiredStepIds", { maxItems: 256 });
  assert(metadata.requiredStepIds.length > 0, "metadata.requiredStepIds must not be empty");
  assertUnique(metadata.requiredStepIds, "metadata.requiredStepIds");
  for (const id of metadata.requiredStepIds) {
    assert(ID_PATTERN.test(id), `metadata.requiredStepIds contains an invalid ID: ${id}`);
  }

  assert(Array.isArray(metadata.firstFrameTransitions), "metadata.firstFrameTransitions must be an array");
  assert(metadata.firstFrameTransitions.length > 0, "metadata.firstFrameTransitions must not be empty");
  assert(metadata.firstFrameTransitions.length <= 64, "metadata.firstFrameTransitions exceeds 64 entries");
  const transitionStepIds = [];
  for (const [index, transition] of metadata.firstFrameTransitions.entries()) {
    const label = `metadata.firstFrameTransitions[${index}]`;
    assertPlainObject(transition, label);
    assertKnownKeys(transition, ["stepId", "expectedThemeId"], label);
    assertNonEmptyString(transition.stepId, `${label}.stepId`, 64);
    assert(ID_PATTERN.test(transition.stepId), `${label}.stepId is invalid`);
    assert(metadata.requiredStepIds.includes(transition.stepId), `${label}.stepId must also appear in metadata.requiredStepIds`);
    assertNonEmptyString(transition.expectedThemeId, `${label}.expectedThemeId`, 64);
    assert(THEME_ID_PATTERN.test(transition.expectedThemeId), `${label}.expectedThemeId is invalid`);
    transitionStepIds.push(transition.stepId);
  }
  assertUnique(transitionStepIds, "metadata.firstFrameTransitions step IDs");
}

function validateCandidate(candidate) {
  assertPlainObject(candidate, "metadata.candidate");
  assertKnownKeys(candidate, ["version", "commit", "applicationId", "artifact", "executable", "appAsar"], "metadata.candidate");
  assertNonEmptyString(candidate.version, "metadata.candidate.version", 128);
  assertNonEmptyString(candidate.commit, "metadata.candidate.commit", 64);
  assert(COMMIT_PATTERN.test(candidate.commit), "metadata.candidate.commit must be a lowercase 40- or 64-character Git object ID");
  assertNonEmptyString(candidate.applicationId, "metadata.candidate.applicationId", 200);
  validateFileReference(candidate.artifact, "metadata.candidate.artifact", ["path", "sha256"]);
  validateFileReference(candidate.executable, "metadata.candidate.executable", ["path", "sha256"]);
  validateFileReference(candidate.appAsar, "metadata.candidate.appAsar", ["path", "sha256"]);
}

function validateScreenshotReference(reference, label) {
  validateFileReference(reference, label, ["path", "sha256", "stepId", "phase", "capture"]);
  if (reference.stepId !== undefined) {
    assertNonEmptyString(reference.stepId, `${label}.stepId`, 64);
    assert(ID_PATTERN.test(reference.stepId), `${label}.stepId is invalid`);
  }
  if (reference.phase !== undefined) {
    assert(["first-observed", "react-ready", "preview", "other"].includes(reference.phase), `${label}.phase is invalid`);
  }
  if (reference.capture !== undefined) {
    assert(["window", "content"].includes(reference.capture), `${label}.capture is invalid`);
  }
}

function validateLogReference(reference, label) {
  validateFileReference(reference, label, ["path", "sha256", "launchId", "stream"]);
  assertNonEmptyString(reference.launchId, `${label}.launchId`, 80);
  assert(ID_PATTERN.test(reference.launchId.toUpperCase()), `${label}.launchId is invalid`);
  assert(["stdout", "stderr"].includes(reference.stream), `${label}.stream must be stdout or stderr`);
}

function validateEvidenceList(value, label, validator) {
  assert(Array.isArray(value), `${label} must be an array`);
  assert(value.length <= 2048, `${label} exceeds 2048 entries`);
  for (const [index, entry] of value.entries()) validator(entry, `${label}[${index}]`);
}

function validateFileReference(reference, label, knownKeys) {
  assertPlainObject(reference, label);
  assertKnownKeys(reference, knownKeys, label);
  assertSafeRelativePath(reference.path, `${label}.path`);
  assertSha256(reference.sha256, `${label}.sha256`);
}

function collectFileReferences(metadata) {
  return [
    { ...metadata.candidate.artifact, label: "candidate artifact" },
    { ...metadata.candidate.executable, label: "candidate executable" },
    { ...metadata.candidate.appAsar, label: "candidate app.asar" },
    { ...metadata.report, label: "report" },
    ...metadata.screenshots.map((entry, index) => ({ ...entry, label: `screenshot[${index}]` })),
    ...metadata.logs.map((entry, index) => ({ ...entry, label: `log[${index}]` })),
  ];
}

function validateReport(metadata, report, verifiedFiles) {
  assertPlainObject(report, "report");
  assert(report.schemaVersion === 1, "report.schemaVersion must be 1");
  assert(report.harness === metadata.harness, "report.harness does not match metadata.harness");
  assert(["passed", "failed", "uncovered"].includes(report.status), "report.status is invalid");
  assert(report.status === metadata.status, "report.status does not match metadata.status");
  assertPlainObject(report.summary, "report.summary");
  assert(typeof report.summary.gatePassed === "boolean", "report.summary.gatePassed must be boolean");
  assert(
    report.summary.gatePassed === (metadata.status === "passed"),
    "report.summary.gatePassed is inconsistent with metadata.status",
  );
  if (metadata.status === "passed") {
    assert(report.mode === "all", "A passed evidence gate requires report.mode=all");
    assert(report.dryRun === false, "A passed evidence gate cannot use a dry-run report");
  }

  assertPlainObject(report.host, "report.host");
  assert(report.host.platform === metadata.platform, "report.host.platform does not match metadata.platform");
  assert(report.host.architecture === metadata.arch, "report.host.architecture does not match metadata.arch");
  assertPlainObject(report.app, "report.app");
  assert(report.app.executableArch === metadata.arch, "report.app.executableArch does not match metadata.arch");
  assert(report.app.version === metadata.candidate.version, "report.app.version does not match metadata.candidate.version");
  assert(report.app.commit === metadata.candidate.commit, "report.app.commit does not match metadata.candidate.commit");
  assert(
    (report.app.applicationId ?? report.app.bundleId) === metadata.candidate.applicationId,
    "report application identity does not match metadata.candidate.applicationId",
  );
  compareReportSha256(report.app.artifactSha256, metadata.candidate.artifact.sha256, "artifact");
  compareReportSha256(report.app.executableSha256, metadata.candidate.executable.sha256, "executable");
  compareReportSha256(report.app.appAsarSha256, metadata.candidate.appAsar.sha256, "app.asar");

  assert(Array.isArray(report.steps), "report.steps must be an array");
  const stepMap = new Map();
  const statusCounts = { passed: 0, failed: 0, uncovered: 0, skipped: 0 };
  for (const [index, step] of report.steps.entries()) {
    const label = `report.steps[${index}]`;
    assertPlainObject(step, label);
    assertNonEmptyString(step.id, `${label}.id`, 64);
    assert(!stepMap.has(step.id), `report.steps contains duplicate ID ${step.id}`);
    assert(Object.hasOwn(statusCounts, step.status), `${label}.status is invalid`);
    stepMap.set(step.id, step);
    statusCounts[step.status] += 1;
  }
  assert(report.summary.total === report.steps.length, "report.summary.total does not match report.steps.length");
  for (const [status, count] of Object.entries(statusCounts)) {
    assert(report.summary[status] === count, `report.summary.${status} does not match report.steps`);
  }
  if (metadata.status === "passed") {
    assert(report.summary.failed === 0, "A passed gate cannot contain failed steps");
    assert(report.summary.uncovered === 0, "A passed gate cannot contain uncovered steps");
    assert(report.summary.blockingRuntimeErrorCount === 0, "A passed gate cannot contain blocking runtime errors");
  }

  for (const requiredStepId of metadata.requiredStepIds) {
    const step = stepMap.get(requiredStepId);
    assert(step, `Required lifecycle step is missing from report: ${requiredStepId}`);
    if (metadata.status === "passed") {
      assert(step.status === "passed", `Required lifecycle step did not pass: ${requiredStepId}`);
    }
  }

  validateFirstFrameTransitions(metadata, stepMap, verifiedFiles);
  validateLaunchLogs(metadata, report);
}

function validateFirstFrameTransitions(metadata, stepMap, verifiedFiles) {
  for (const expected of metadata.firstFrameTransitions) {
    const step = stepMap.get(expected.stepId);
    assert(step, `First-frame step is missing from report: ${expected.stepId}`);
    const launchEvidence = step.details?.launchEvidence;
    assertPlainObject(launchEvidence, `report step ${expected.stepId} launchEvidence`);
    assert(
      launchEvidence.expectedThemeId === expected.expectedThemeId,
      `First-frame expected theme mismatch for ${expected.stepId}`,
    );
    assertNonEmptyString(launchEvidence.firstThemeId, `${expected.stepId}.launchEvidence.firstThemeId`, 64);
    assert(typeof launchEvidence.stable === "boolean", `${expected.stepId}.launchEvidence.stable must be boolean`);
    assert(Array.isArray(launchEvidence.transitions), `${expected.stepId}.launchEvidence.transitions must be an array`);
    assert(launchEvidence.transitions.length > 0, `${expected.stepId} has no first-frame transitions`);
    for (const [index, transition] of launchEvidence.transitions.entries()) {
      const label = `${expected.stepId}.launchEvidence.transitions[${index}]`;
      assertPlainObject(transition, label);
      assert(Number.isFinite(transition.offsetMs) && transition.offsetMs >= 0, `${label}.offsetMs is invalid`);
      assertNonEmptyString(transition.themeId, `${label}.themeId`, 64);
      assertNonEmptyString(transition.appBackground, `${label}.appBackground`, 128);
      assert(Number.isSafeInteger(transition.rootChildCount) && transition.rootChildCount >= 0, `${label}.rootChildCount is invalid`);
    }
    if (metadata.status === "passed") {
      assert(launchEvidence.stable === true, `First-frame transition is not stable for ${expected.stepId}`);
      assert(
        launchEvidence.firstThemeId === expected.expectedThemeId,
        `First observed theme is incorrect for ${expected.stepId}`,
      );
      assert(
        launchEvidence.transitions.every((transition) => transition.themeId === expected.expectedThemeId),
        `First-frame transitions contain another theme for ${expected.stepId}`,
      );
      assert(launchEvidence.screenshot?.windowCapture === "passed", `Window screenshot did not pass for ${expected.stepId}`);
    }

    const reportWindowSha256 = launchEvidence.screenshot?.windowSha256;
    assertSha256(reportWindowSha256, `${expected.stepId}.launchEvidence.screenshot.windowSha256`);
    const screenshots = metadata.screenshots.filter((entry) => (
      entry.stepId === expected.stepId
      && entry.phase === "first-observed"
      && entry.capture === "window"
    ));
    assert(screenshots.length === 1, `Expected exactly one first-observed window screenshot for ${expected.stepId}`);
    const [screenshot] = screenshots;
    assert(
      screenshot.sha256 === reportWindowSha256,
      `First-observed window screenshot hash does not match report for ${expected.stepId}`,
    );
    assert(verifiedFiles.has(screenshot.path), `First-frame screenshot was not verified for ${expected.stepId}`);
  }
}

function validateLaunchLogs(metadata, report) {
  assert(Array.isArray(report.launches), "report.launches must be an array");
  const launchIds = new Set();
  for (const [index, launch] of report.launches.entries()) {
    const label = `report.launches[${index}]`;
    assertPlainObject(launch, label);
    assertNonEmptyString(launch.launchId, `${label}.launchId`, 80);
    assert(!launchIds.has(launch.launchId), `report.launches contains duplicate launchId ${launch.launchId}`);
    launchIds.add(launch.launchId);
    for (const stream of ["stdout", "stderr"]) {
      const matches = metadata.logs.filter((entry) => entry.launchId === launch.launchId && entry.stream === stream);
      assert(matches.length === 1, `Expected exactly one ${stream} log for launch ${launch.launchId}`);
    }
  }
  for (const log of metadata.logs) {
    assert(launchIds.has(log.launchId), `Metadata log references unknown launchId ${log.launchId}`);
  }
}

function compareReportSha256(reportValue, metadataValue, label) {
  assertSha256(reportValue, `report.app ${label} SHA-256`);
  assert(reportValue === metadataValue, `report.app ${label} SHA-256 does not match metadata candidate`);
}

async function resolveEvidenceFile({ authorityRoot, relativePath, label, pathRegistry, inodeRegistry }) {
  assertSafeRelativePath(relativePath, `${label} path`);
  const canonicalKey = posix.normalize(relativePath).toLowerCase();
  assert(!pathRegistry.has(canonicalKey), `${label} duplicates path already used by ${pathRegistry.get(canonicalKey)}`);
  pathRegistry.set(canonicalKey, label);

  const candidate = resolve(authorityRoot, ...relativePath.split("/"));
  const containment = relative(authorityRoot, candidate);
  assert(containment && !isAbsolute(containment) && !containment.startsWith(".."), `${label} escapes the evidence directory`);

  let current = authorityRoot;
  for (const segment of relativePath.split("/")) {
    current = resolve(current, segment);
    const info = await lstat(current).catch((error) => {
      throw new Error(`${label} is unavailable at ${relativePath}: ${readErrorCode(error)}`);
    });
    assert(!info.isSymbolicLink(), `${label} must not traverse a symlink: ${relativePath}`);
  }
  const info = await lstat(candidate);
  assert(info.isFile(), `${label} must be a regular file: ${relativePath}`);
  const inodeKey = info.ino && info.dev ? `${info.dev}:${info.ino}` : undefined;
  if (inodeKey) {
    assert(!inodeRegistry.has(inodeKey), `${label} aliases file already used by ${inodeRegistry.get(inodeKey)}`);
    inodeRegistry.set(inodeKey, label);
  }
  return { path: candidate, relativePath, size: info.size };
}

async function readJson(reference, maxBytes, label) {
  assert(reference.size <= maxBytes, `${label} exceeds the ${maxBytes}-byte limit`);
  const handle = await openNoFollow(reference.path);
  try {
    const info = await handle.stat();
    assert(info.isFile(), `${label} must remain a regular file while reading`);
    assert(info.size <= maxBytes, `${label} exceeds the ${maxBytes}-byte limit`);
    const bytes = await handle.readFile();
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`${label} is not valid JSON`);
    }
  } finally {
    await handle.close();
  }
}

async function readJsonAndVerifySha256(reference, expectedSha256, maxBytes, label) {
  assert(reference.size <= maxBytes, `${label} exceeds the ${maxBytes}-byte limit`);
  const handle = await openNoFollow(reference.path);
  try {
    const before = await handle.stat();
    assert(before.isFile(), `${label} must remain a regular file while reading`);
    assert(before.size <= maxBytes, `${label} exceeds the ${maxBytes}-byte limit`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    assert(after.size === before.size, `${label} changed while reading`);
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    assert(actualSha256 === expectedSha256, `${label} changed after its initial SHA-256 verification`);
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`${label} is not valid JSON`);
    }
  } finally {
    await handle.close();
  }
}

async function sha256File(reference) {
  const handle = await openNoFollow(reference.path);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  try {
    const info = await handle.stat();
    assert(info.isFile(), `${reference.relativePath} must remain a regular file while hashing`);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    assert(after.size === info.size, `${reference.relativePath} changed while hashing`);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function openNoFollow(path) {
  return open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
}

function assertSafeRelativePath(value, label) {
  assertNonEmptyString(value, label, 1024);
  assert(!value.includes("\\"), `${label} must use forward slashes`);
  assert(!/[\u0000-\u001f\u007f]/u.test(value), `${label} contains a control character`);
  assert(!isAbsolute(value) && !win32.isAbsolute(value), `${label} must be relative`);
  const segments = value.split("/");
  assert(segments.every((segment) => segment && segment !== "." && segment !== ".."), `${label} contains an unsafe path segment`);
  assert(posix.normalize(value) === value, `${label} must be in canonical relative form`);
}

function assertSha256(value, label) {
  assert(typeof value === "string" && SHA256_PATTERN.test(value), `${label} must be a lowercase 64-character SHA-256 hex digest`);
}

function assertPlainObject(value, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}

function assertKnownKeys(value, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  assert(unknown.length === 0, `${label} contains unknown keys: ${unknown.join(", ")}`);
  for (const required of allowedKeys.filter((key) => !["generatedAt", "notes", "stepId", "phase", "capture"].includes(key))) {
    assert(Object.hasOwn(value, required), `${label}.${required} is required`);
  }
}

function assertNonEmptyString(value, label, maxLength) {
  assert(typeof value === "string" && value.trim() === value && value.length > 0, `${label} must be a non-empty trimmed string`);
  assert(value.length <= maxLength, `${label} exceeds ${maxLength} characters`);
}

function assertStringArray(value, label, { allowEmpty = false, maxItems }) {
  assert(Array.isArray(value), `${label} must be an array`);
  assert(value.length <= maxItems, `${label} exceeds ${maxItems} entries`);
  if (!allowEmpty) assert(value.length > 0, `${label} must not be empty`);
  for (const [index, entry] of value.entries()) assertNonEmptyString(entry, `${label}[${index}]`, 1000);
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    assert(!seen.has(value), `${label} contains duplicate value ${value}`);
    seen.add(value);
  }
}

function assertIsoDate(value, label) {
  assertNonEmptyString(value, label, 64);
  assert(Number.isFinite(Date.parse(value)), `${label} must be an ISO-8601 timestamp`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(args) {
  const parsed = { evidenceDirectory: undefined, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const [flag, inlineValue] = argument.split("=", 2);
    if (flag === "--help" || flag === "-h") {
      parsed.help = true;
    } else if (flag === "--evidence") {
      const value = inlineValue ?? args[++index];
      assert(value && !value.startsWith("--"), "--evidence requires a directory");
      assert(parsed.evidenceDirectory === undefined, "--evidence may only be specified once");
      parsed.evidenceDirectory = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!parsed.help) assert(parsed.evidenceDirectory, "--evidence <directory> is required");
  return parsed;
}

function helpText() {
  return `Verify a P7CD packaged Theme Package persistence evidence bundle.\n\nUsage:\n  node apps/desktop/tests/verify-theme-package-persistence-evidence.mjs --evidence <directory>\n\nOptions:\n  --evidence <directory>  Directory containing metadata.json and all referenced files\n  --help, -h              Show this help\n\nThe verifier is read-only. metadata.json schemaVersion 1 declares one real\nplatform/architecture, candidate file references, report, screenshots, logs,\nrequiredStepIds, and firstFrameTransitions. All paths must be canonical relative\npaths inside the evidence directory; symlinks, duplicate paths, unsafe segments,\nand invalid or mismatched SHA-256 values are rejected. The verifier never infers\nor synthesizes evidence for another platform.\n`;
}

function readErrorCode(error) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "unknown error";
}
