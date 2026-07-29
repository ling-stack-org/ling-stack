import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const expectedScenarioIds = [
  "web-release-shell",
  "web-release-channel",
  "web-release-normal-conversation",
  "web-release-teammate-chat",
  "web-release-settings-imported-theme",
  "web-release-model-workbench",
  "web-release-plugin-manager",
  "web-release-automations",
  "web-release-media-jobs",
  "web-release-work-board",
  "web-release-runs",
  "web-release-approvals",
];
const allowedViewports = new Set(["1280x800", "1440x960"]);
const allowedLocales = new Set(["en-US", "zh-CN"]);
const allowedMotion = new Set(["no-preference", "reduce"]);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const releaseDirectory = path.join(repositoryRoot, "docs/design/ui2.0升级/evidence/release/web");
const manifestPath = path.join(releaseDirectory, "manifest.json");
const metadataPath = path.join(releaseDirectory, "metadata.md");
const errors = [];

const manifest = await readJson(manifestPath, "manifest");
const metadata = await readText(metadataPath, "metadata");

if (manifest) await verifyManifest(manifest);
verifyMetadata(metadata, manifest);

if (errors.length > 0) {
  console.error(`UI 2.0 Web release evidence verification failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  const count = Array.isArray(manifest?.scenarios) ? manifest.scenarios.length : 0;
  console.log(`UI 2.0 Web release evidence is structurally valid: status=${manifest?.status ?? "unknown"}, scenarios=${count}/${expectedScenarioIds.length}.`);
}

async function verifyManifest(value) {
  if (!isObject(value)) {
    errors.push("manifest must be a JSON object");
    return;
  }
  requireExact(value.schemaVersion, 1, "manifest.schemaVersion");
  requireNonEmptyString(value.release, "manifest.release");
  if (!new Set(["pending", "partial", "captured"]).has(value.status)) {
    errors.push("manifest.status must be pending, partial, or captured");
  }
  requireNonEmptyString(value.servedArtifact, "manifest.servedArtifact");
  verifyCaptureCommand(value.captureCommand, "manifest.captureCommand");
  verifyExpectedScenarioIds(value.expectedScenarioIds);
  if (!Array.isArray(value.scenarios)) {
    errors.push("manifest.scenarios must be an array");
    return;
  }

  const count = value.scenarios.length;
  if (value.status === "pending" && count !== 0) errors.push("pending manifest must not contain captured scenarios");
  if (value.status === "partial" && (count === 0 || count >= expectedScenarioIds.length)) errors.push("partial manifest must contain between 1 and 11 scenarios");
  if (value.status === "captured" && count !== expectedScenarioIds.length) errors.push("captured manifest must contain all 12 scenarios");
  if (count === 0) {
    if (value.generatedAt !== null) errors.push("pending empty manifest.generatedAt must be null");
    if (value.source !== null) errors.push("pending empty manifest.source must be null");
  } else {
    verifyIsoDate(value.generatedAt, "manifest.generatedAt");
    verifySource(value.source, "manifest.source");
  }

  const seenScenarioIds = new Set();
  const seenFunctionIds = new Set();
  const referencedPng = new Set();
  const referencedJson = new Set();
  for (let index = 0; index < value.scenarios.length; index += 1) {
    const record = value.scenarios[index];
    const label = `manifest.scenarios[${index}]`;
    await verifyScenario(record, label, seenScenarioIds, seenFunctionIds, referencedPng, referencedJson, value.source);
  }
  if (value.status === "captured") {
    for (const stableId of expectedScenarioIds) {
      if (!seenScenarioIds.has(stableId)) errors.push(`captured manifest is missing scenario ${stableId}`);
    }
  }
  await verifyOrphans(referencedPng, referencedJson);
}

async function verifyScenario(record, label, seenScenarioIds, seenFunctionIds, referencedPng, referencedJson, manifestSource) {
  if (!isObject(record)) {
    errors.push(`${label} must be an object`);
    return;
  }
  requireExact(record.status, "captured", `${label}.status`);
  const stableId = requireNonEmptyString(record.stableId, `${label}.stableId`);
  if (stableId) {
    if (!expectedScenarioIds.includes(stableId)) errors.push(`${label}.stableId is not declared in expectedScenarioIds: ${stableId}`);
    if (seenScenarioIds.has(stableId)) errors.push(`duplicate scenario stableId: ${stableId}`);
    seenScenarioIds.add(stableId);
  }
  requireNonEmptyString(record.label, `${label}.label`);
  verifyFunctionIds(record.functionIds, `${label}.functionIds`, seenFunctionIds);
  requireNonEmptyString(record.fixture, `${label}.fixture`);
  verifyTrigger(record.trigger, `${label}.trigger`);
  verifyUrl(record.url, `${label}.url`);
  verifyViewport(record.viewport, `${label}.viewport`);
  verifyTheme(record.theme, `${label}.theme`);
  if (!allowedLocales.has(record.locale)) errors.push(`${label}.locale must be en-US or zh-CN`);
  verifyKeyboard(record.keyboard, `${label}.keyboard`);
  if (!allowedMotion.has(record.reducedMotion)) errors.push(`${label}.reducedMotion must be no-preference or reduce`);
  verifyEmptyArray(record.consoleErrors, `${label}.consoleErrors`);
  verifyEmptyArray(record.pageErrors, `${label}.pageErrors`);
  verifyEmptyArray(record.overflow, `${label}.overflow`);
  requireNonEmptyString(record.servedArtifact, `${label}.servedArtifact`);
  verifyCaptureCommand(record.captureCommand, `${label}.captureCommand`);
  verifySource(record.source, `${label}.source`);
  if (isObject(manifestSource) && stableJson(record.source) !== stableJson(manifestSource)) {
    errors.push(`${label}.source must match manifest.source`);
  }
  verifyIsoDate(record.capturedAt, `${label}.capturedAt`);

  const pngFile = isObject(record.png) ? requireSafeBasename(record.png.file, `${label}.png.file`, ".png") : undefined;
  const sidecarFile = requireSafeBasename(record.sidecarFile, `${label}.sidecarFile`, ".json");
  if (!isObject(record.png)) errors.push(`${label}.png must be an object`);
  if (stableId && pngFile && pngFile !== `${stableId}.png`) errors.push(`${label}.png.file must be ${stableId}.png`);
  if (stableId && sidecarFile && sidecarFile !== `${stableId}.json`) errors.push(`${label}.sidecarFile must be ${stableId}.json`);
  if (pngFile) {
    if (referencedPng.has(pngFile)) errors.push(`PNG is referenced more than once: ${pngFile}`);
    referencedPng.add(pngFile);
  }
  if (sidecarFile) {
    if (referencedJson.has(sidecarFile)) errors.push(`sidecar is referenced more than once: ${sidecarFile}`);
    referencedJson.add(sidecarFile);
  }
  if (!pngFile || !isObject(record.png)) return;

  const pngPath = path.join(releaseDirectory, pngFile);
  const bytes = await readBytes(pngPath, `${label}.png`);
  if (bytes) {
    const dimensions = readPngDimensions(bytes, `${label}.png`);
    requirePositiveInteger(record.png.width, `${label}.png.width`);
    requirePositiveInteger(record.png.height, `${label}.png.height`);
    if (dimensions && (record.png.width !== dimensions.width || record.png.height !== dimensions.height)) {
      errors.push(`${label}.png dimensions ${record.png.width}x${record.png.height} do not match PNG ${dimensions.width}x${dimensions.height}`);
    }
    if (isObject(record.viewport) && (record.png.width !== record.viewport.width || record.png.height !== record.viewport.height)) {
      errors.push(`${label}.png dimensions must match the CSS viewport for this deviceScaleFactor=1 release gate`);
    }
    const expectedHash = requireSha256(record.png.sha256, `${label}.png.sha256`);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (expectedHash && expectedHash !== actualHash) errors.push(`${label}.png.sha256 does not match ${pngFile}`);
  }

  if (sidecarFile) {
    const sidecar = await readJson(path.join(releaseDirectory, sidecarFile), `${label}.sidecar`);
    if (sidecar && stableJson(sidecar) !== stableJson(record)) errors.push(`${label} does not match sidecar ${sidecarFile}`);
  }
}

function verifyExpectedScenarioIds(value) {
  if (!Array.isArray(value)) {
    errors.push("manifest.expectedScenarioIds must be an array");
    return;
  }
  const actual = [...value];
  if (new Set(actual).size !== actual.length) errors.push("manifest.expectedScenarioIds contains duplicates");
  if (actual.length !== expectedScenarioIds.length || actual.some((item, index) => item !== expectedScenarioIds[index])) {
    errors.push("manifest.expectedScenarioIds must contain the canonical 12 scenario IDs in release order");
  }
}

function verifyFunctionIds(value, label, seenFunctionIds) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must be a non-empty array`);
    return;
  }
  const local = new Set();
  for (const functionId of value) {
    if (typeof functionId !== "string" || !/^[A-Z][A-Z0-9-]*-\d{3}$/u.test(functionId)) {
      errors.push(`${label} contains an empty or invalid Function ID`);
      continue;
    }
    if (local.has(functionId)) errors.push(`${label} contains duplicate Function ID ${functionId}`);
    if (seenFunctionIds.has(functionId)) errors.push(`Function ID is assigned to more than one release scenario: ${functionId}`);
    local.add(functionId);
    seenFunctionIds.add(functionId);
  }
}

function verifyTrigger(value, label) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  requireNonEmptyString(value.summary, `${label}.summary`);
  verifyNonEmptyStringArray(value.steps, `${label}.steps`);
}

function verifyUrl(value, label) {
  const text = requireNonEmptyString(value, label);
  if (!text) return;
  try {
    const url = new URL(text);
    if (!new Set(["http:", "https:"]).has(url.protocol)) errors.push(`${label} must use http or https`);
  } catch {
    errors.push(`${label} must be an absolute URL`);
  }
}

function verifyViewport(value, label) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  requirePositiveInteger(value.width, `${label}.width`);
  requirePositiveInteger(value.height, `${label}.height`);
  if (!allowedViewports.has(`${value.width}x${value.height}`)) errors.push(`${label} must be 1280x800 or 1440x960`);
}

function verifyTheme(value, label) {
  if (value === "ling-light" || value === "ling-dark") return;
  if (typeof value === "string" && /^imported:[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) return;
  errors.push(`${label} must be ling-light, ling-dark, or imported:<stable-id>`);
}

function verifyKeyboard(value, label) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  if (value.exercised !== true) errors.push(`${label}.exercised must be true`);
  verifyNonEmptyStringArray(value.checks, `${label}.checks`);
}

function verifySource(value, label) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  requireGitCommit(value.commit, `${label}.commit`);
  requireNonEmptyString(value.branch, `${label}.branch`);
  if (typeof value.dirty !== "boolean") errors.push(`${label}.dirty must be boolean`);
  requireSha256(value.worktreeStatusSha256, `${label}.worktreeStatusSha256`);
  requireNonEmptyString(value.identifier, `${label}.identifier`);
}

function requireGitCommit(value, label) {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    errors.push(`${label} must be a lowercase 40- or 64-character Git object ID`);
    return undefined;
  }
  return value;
}

function verifyCaptureCommand(value, label) {
  const command = requireNonEmptyString(value, label);
  if (!command) return;
  if (!command.includes("LING_CAPTURE_UI2_EVIDENCE=1") || !command.includes("ui2-web-release-gate.spec.ts") || !command.includes("--workers=1")) {
    errors.push(`${label} must be the gated single-worker release capture command`);
  }
}

function verifyEmptyArray(value, label) {
  if (!Array.isArray(value)) errors.push(`${label} must be an array`);
  else if (value.length > 0) errors.push(`${label} must be empty for releasable evidence`);
}

function verifyNonEmptyStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    errors.push(`${label} must be a non-empty string array`);
  }
}

function verifyIsoDate(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) errors.push(`${label} must be an ISO date string`);
}

async function verifyOrphans(referencedPng, referencedJson) {
  let entries = [];
  try {
    entries = await readdir(releaseDirectory, { withFileTypes: true });
  } catch (error) {
    errors.push(`release directory cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const actualPng = new Set(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".png")).map((entry) => entry.name));
  const actualJson = new Set(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "manifest.json").map((entry) => entry.name));
  for (const file of actualPng) if (!referencedPng.has(file)) errors.push(`orphan PNG: ${file}`);
  for (const file of referencedPng) if (!actualPng.has(file)) errors.push(`referenced PNG is missing: ${file}`);
  for (const file of actualJson) if (!referencedJson.has(file)) errors.push(`orphan JSON sidecar: ${file}`);
  for (const file of referencedJson) if (!actualJson.has(file)) errors.push(`referenced JSON sidecar is missing: ${file}`);
}

function verifyMetadata(value, manifestValue) {
  if (typeof value !== "string") return;
  if (manifestValue?.status === "pending") {
    if (/\bstatus:\s*`?(?:captured|verified)`?/iu.test(value) || /verification state:\s*`?(?:verifier-passed|verified)`?/iu.test(value)) {
      errors.push("pending metadata must not claim captured or verified status");
    }
    if (!value.includes("Capture state at foundation time: `not-captured`")) errors.push("pending metadata must explicitly state not-captured");
    if (!value.includes("Verification state: `not-verified`")) errors.push("pending metadata must explicitly state not-verified");
  }
  if (manifestValue?.status === "partial") {
    if (!value.includes("Status: `partial`")) errors.push("partial metadata must explicitly state partial status");
    if (/verification state:\s*`?(?:verifier-passed|verified)`?/iu.test(value)) errors.push("partial metadata must not claim verifier-passed status");
  }
  if (manifestValue?.status === "captured") {
    if (!value.includes("Status: `captured`")) errors.push("captured metadata must explicitly state captured status");
    if (!value.includes("Capture state: `captured-12-of-12`")) errors.push("captured metadata must state captured-12-of-12");
    if (!value.includes("Verification state: `verifier-passed`")) errors.push("captured metadata must state verifier-passed");
    if (!value.includes("Visual review state: `reviewed-12-of-12`")) errors.push("captured metadata must state reviewed-12-of-12");
    if (!value.includes("packaged Desktop evidence") || !value.includes("remains pending")) {
      errors.push("captured metadata must preserve the packaged Desktop pending boundary");
    }
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${label} must be a non-empty string`);
    return undefined;
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    errors.push(`${label} must be a lowercase SHA-256 value`);
    return undefined;
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) errors.push(`${label} must be a positive integer`);
}

function requireSafeBasename(value, label, extension) {
  const file = requireNonEmptyString(value, label);
  if (!file) return undefined;
  if (path.basename(file) !== file || !file.endsWith(extension)) {
    errors.push(`${label} must be a basename ending in ${extension}`);
    return undefined;
  }
  return file;
}

function requireExact(actual, expected, label) {
  if (actual !== expected) errors.push(`${label} must equal ${JSON.stringify(expected)}`);
}

function readPngDimensions(bytes, label) {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
    errors.push(`${label} is not a valid PNG with an IHDR chunk`);
    return undefined;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function readJson(filePath, label) {
  const text = await readText(filePath, label);
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function readText(filePath, label) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    errors.push(`${label} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function readBytes(filePath, label) {
  try {
    return await readFile(filePath);
  } catch (error) {
    errors.push(`${label} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
