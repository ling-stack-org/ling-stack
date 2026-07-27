import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const batchId = "T13-P.9EF";
const protectedTag = "ui2-web-p9d-checkpoint-20260727";
const servedArtifact = "Vite source via Playwright webServer";
const captureCommand = "LING_CAPTURE_UI2_P9EF_EVIDENCE=1 LING_PLAYWRIGHT_PORT=4284 corepack pnpm --filter @ling-stack/web exec playwright test e2e/ui2-p9ef-final-evidence.spec.ts --workers=1";
const expectedConsole503Pattern = "^Failed to load resource: the server responded with a status of 503 \\(Service Unavailable\\)$";
const expectedScenarioIds = [
  "p9ef-conversation-beta-clean-after-late-alpha",
  "p9ef-conversation-alpha-failure-restored",
  "p9ef-conversation-new-draft-clean-after-stale-upload",
  "p9ef-teammate-designer-clean-after-late-engineer",
  "p9ef-teammate-engineer-error-after-designer-success",
  "p9ef-plugin-row-failure-after-unrelated-success",
  "p9ef-shell-settings-error-restored",
  "p9ef-channel-teammate-add-failure-restored",
];
const expectedSurfaces = new Map([
  [expectedScenarioIds[0], { viewport: "1440x960", theme: "ling-light", motion: "no-preference" }],
  [expectedScenarioIds[1], { viewport: "1440x960", theme: "ling-light", motion: "no-preference" }],
  [expectedScenarioIds[2], { viewport: "1280x800", theme: "ling-dark", motion: "reduce" }],
  [expectedScenarioIds[3], { viewport: "1280x800", theme: "ling-dark", motion: "reduce" }],
  [expectedScenarioIds[4], { viewport: "1440x960", theme: "ling-light", motion: "no-preference" }],
  [expectedScenarioIds[5], { viewport: "1440x960", theme: "ling-light", motion: "no-preference" }],
  [expectedScenarioIds[6], { viewport: "1280x800", theme: "ling-dark", motion: "reduce" }],
  [expectedScenarioIds[7], { viewport: "1280x800", theme: "ling-light", motion: "reduce" }],
]);
const expectedExclusions = [
  "Desktop cross-platform release acceptance",
  "Quick Theme Studio D3",
  "First Run new entry",
  "Teammate MCP A/A/A",
  "Skill Source Sync",
  "Council Runtime",
];
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureDirectory = parseFixtureDirectory(process.argv.slice(2));
const evidenceDirectory = fixtureDirectory ?? path.join(
  repositoryRoot,
  "docs/design/ui2.0升级/evidence/release/web/p9ef-final-error-ownership",
);
const errors = [];

const manifest = await readJson(path.join(evidenceDirectory, "manifest.json"), "manifest");
const metadata = await readText(path.join(evidenceDirectory, "metadata.md"), "metadata");
if (manifest) await verifyManifest(manifest);
verifyMetadata(metadata, manifest);
if (!fixtureDirectory && manifest) {
  verifyCurrentSource(manifest);
  verifyProtectedEvidence(manifest);
}

if (errors.length > 0) {
  console.error(`P9-EF evidence verification failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`P9-EF evidence is structurally valid: batch=${batchId}, scenarios=${expectedScenarioIds.length}/${expectedScenarioIds.length}.`);
}

async function verifyManifest(value) {
  if (!isObject(value)) {
    errors.push("manifest must be a JSON object");
    return;
  }
  requireExact(value.schemaVersion, 1, "manifest.schemaVersion");
  requireExact(value.batchId, batchId, "manifest.batchId");
  requireExact(value.status, "captured", "manifest.status");
  verifyCanonicalArray(value.expectedScenarioIds, expectedScenarioIds, "manifest.expectedScenarioIds");
  requireExact(value.servedArtifact, servedArtifact, "manifest.servedArtifact");
  requireExact(value.captureCommand, captureCommand, "manifest.captureCommand");
  const baseUrl = verifyAbsoluteUrl(value.baseUrl, "manifest.baseUrl");
  verifyIsoDate(value.generatedAt, "manifest.generatedAt");
  verifySource(value.source, "manifest.source", true);
  verifyProtectedLedger(value.protectedEvidence, "manifest.protectedEvidence");
  verifyCloseout(value.closeout, "manifest.closeout");

  if (!Array.isArray(value.scenarios)) {
    errors.push("manifest.scenarios must be an array");
    return;
  }
  if (value.scenarios.length !== expectedScenarioIds.length) {
    errors.push(`manifest.scenarios must contain exactly ${expectedScenarioIds.length} records`);
  }

  const seen = new Set();
  const referencedPng = new Set();
  const referencedJson = new Set();
  for (let index = 0; index < value.scenarios.length; index += 1) {
    await verifyScenario({
      record: value.scenarios[index],
      label: `manifest.scenarios[${index}]`,
      expectedId: expectedScenarioIds[index],
      manifestSource: value.source,
      baseUrl,
      seen,
      referencedPng,
      referencedJson,
    });
  }
  for (const id of expectedScenarioIds) {
    if (!seen.has(id)) errors.push(`manifest is missing canonical scenario ${id}`);
  }
  verifyCoverage(value.scenarios);
  await verifyDirectoryFiles(referencedPng, referencedJson);
}

async function verifyScenario(input) {
  const { record, label, expectedId, manifestSource, baseUrl, seen, referencedPng, referencedJson } = input;
  if (!isObject(record)) {
    errors.push(`${label} must be an object`);
    return;
  }
  requireExact(record.status, "captured", `${label}.status`);
  const stableId = requireNonEmptyString(record.stableId, `${label}.stableId`);
  if (stableId) {
    if (!expectedScenarioIds.includes(stableId)) errors.push(`${label}.stableId is not canonical: ${stableId}`);
    if (stableId !== expectedId) errors.push(`${label}.stableId must be ${expectedId ?? "absent"} at this index`);
    if (seen.has(stableId)) errors.push(`duplicate scenario stableId: ${stableId}`);
    seen.add(stableId);
  }
  requireNonEmptyString(record.label, `${label}.label`);
  verifyFunctionIds(record.functionIds, `${label}.functionIds`);
  requireNonEmptyString(record.fixture, `${label}.fixture`);
  verifyTrigger(record.trigger, `${label}.trigger`);
  verifyOwner(record.owner, `${label}.owner`);
  verifyAssertions(record.assertions, `${label}.assertions`);
  verifyExpectedHttpFailures(record.expectedHttpFailures, `${label}.expectedHttpFailures`);
  verifyOverflowOwners(record.overflowOwners, `${label}.overflowOwners`);
  verifyCanonicalSurface(record, stableId, label);
  if (!new Set(["en-US", "zh-CN"]).has(record.locale)) errors.push(`${label}.locale must be en-US or zh-CN`);
  verifyKeyboard(record.keyboard, `${label}.keyboard`);
  verifyAbsoluteUrl(record.url, `${label}.url`, baseUrl);
  verifyRuntime(record.runtime, record.expectedHttpFailures, `${label}.runtime`);
  requireExact(record.servedArtifact, servedArtifact, `${label}.servedArtifact`);
  requireExact(record.captureCommand, captureCommand, `${label}.captureCommand`);
  verifySource(record.source, `${label}.source`, true);
  if (isObject(manifestSource) && stableJson(record.source) !== stableJson(manifestSource)) {
    errors.push(`${label}.source must match manifest.source`);
  }
  verifyIsoDate(record.capturedAt, `${label}.capturedAt`);

  const pngFile = isObject(record.png) ? requireSafeBasename(record.png.file, `${label}.png.file`, ".png") : undefined;
  const sidecarFile = requireSafeBasename(record.sidecarFile, `${label}.sidecarFile`, ".json");
  if (!isObject(record.png)) errors.push(`${label}.png must be an object`);
  if (stableId && pngFile && pngFile !== `${stableId}.png`) errors.push(`${label}.png.file must be ${stableId}.png`);
  if (stableId && sidecarFile && sidecarFile !== `${stableId}.json`) errors.push(`${label}.sidecarFile must be ${stableId}.json`);
  if (pngFile) addUniqueReference(referencedPng, pngFile, "PNG");
  if (sidecarFile) addUniqueReference(referencedJson, sidecarFile, "sidecar");
  if (pngFile && isObject(record.png)) await verifyPng(record, label, pngFile);
  if (sidecarFile) {
    const sidecar = await readJson(path.join(evidenceDirectory, sidecarFile), `${label}.sidecar`);
    if (sidecar && stableJson(sidecar) !== stableJson(record)) errors.push(`${label} does not match sidecar ${sidecarFile}`);
  }
}

async function verifyPng(record, label, pngFile) {
  const bytes = await readBytes(path.join(evidenceDirectory, pngFile), `${label}.png`);
  if (!bytes) return;
  const dimensions = readPngDimensions(bytes, `${label}.png`);
  requirePositiveInteger(record.png.width, `${label}.png.width`);
  requirePositiveInteger(record.png.height, `${label}.png.height`);
  if (dimensions && (record.png.width !== dimensions.width || record.png.height !== dimensions.height)) {
    errors.push(`${label}.png dimensions ${record.png.width}x${record.png.height} do not match PNG ${dimensions.width}x${dimensions.height}`);
  }
  if (isObject(record.viewport) && (record.png.width !== record.viewport.width || record.png.height !== record.viewport.height)) {
    errors.push(`${label}.png dimensions must match its CSS viewport`);
  }
  const declaredHash = requireSha256(record.png.sha256, `${label}.png.sha256`);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (declaredHash && declaredHash !== actualHash) errors.push(`${label}.png.sha256 does not match ${pngFile}`);
}

function verifyRuntime(value, expectedFailures, label) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const expectedCount = Array.isArray(expectedFailures)
    ? expectedFailures.reduce((sum, failure) => sum + (isObject(failure) && Number.isInteger(failure.count) ? failure.count : 0), 0)
    : 0;
  requireExact(value.expectedConsole503Pattern, expectedConsole503Pattern, `${label}.expectedConsole503Pattern`);
  requireExact(value.expectedConsole503Count, expectedCount, `${label}.expectedConsole503Count`);
  verifyEmptyArray(value.pageErrors, `${label}.pageErrors`);
  verifyEmptyArray(value.unexpectedConsoleErrors, `${label}.unexpectedConsoleErrors`);
  verifyEmptyArray(value.unexpectedHttpFailures, `${label}.unexpectedHttpFailures`);

  if (!Array.isArray(value.consoleErrors)) errors.push(`${label}.consoleErrors must be an array`);
  else {
    const pattern = new RegExp(expectedConsole503Pattern, "u");
    const matching = value.consoleErrors.filter((entry) => isObject(entry) && pattern.test(entry.text));
    if (matching.length !== expectedCount) errors.push(`${label}.consoleErrors has ${matching.length} expected 503 entries, wanted ${expectedCount}`);
    for (const [index, entry] of value.consoleErrors.entries()) {
      if (!isObject(entry)) errors.push(`${label}.consoleErrors[${index}] must be an object`);
      else {
        requireNonEmptyString(entry.text, `${label}.consoleErrors[${index}].text`);
        if (typeof entry.locationUrl !== "string") errors.push(`${label}.consoleErrors[${index}].locationUrl must be a string`);
        if (!pattern.test(entry.text)) errors.push(`${label}.consoleErrors[${index}] is not the declared synthetic 503 console line`);
      }
    }
  }

  if (!Array.isArray(value.httpFailures)) errors.push(`${label}.httpFailures must be an array`);
  else if (Array.isArray(expectedFailures)) {
    for (const [index, failure] of value.httpFailures.entries()) {
      if (!isObject(failure)) {
        errors.push(`${label}.httpFailures[${index}] must be an object`);
        continue;
      }
      const matches = expectedFailures.some((expected) => matchesHttpFailure(failure, expected));
      if (!matches) errors.push(`${label}.httpFailures[${index}] is not an expected synthetic failure`);
    }
    for (const [index, expected] of expectedFailures.entries()) {
      if (!isObject(expected)) continue;
      const count = value.httpFailures.filter((actual) => isObject(actual) && matchesHttpFailure(actual, expected)).length;
      if (count !== expected.count) errors.push(`${label}.expectedHttpFailures[${index}] count ${count} != ${expected.count}`);
    }
  }
  verifyOverflow(value.overflow, `${label}.overflow`);
}

function verifyOverflow(value, label) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  verifyOverflowNumber(value.document, `${label}.document`);
  verifyOverflowNumber(value.body, `${label}.body`);
  if (!Array.isArray(value.owners) || value.owners.length === 0) {
    errors.push(`${label}.owners must be a non-empty array`);
    return;
  }
  for (const [index, owner] of value.owners.entries()) {
    const ownerLabel = `${label}.owners[${index}]`;
    if (!isObject(owner)) {
      errors.push(`${ownerLabel} must be an object`);
      continue;
    }
    requireNonEmptyString(owner.label, `${ownerLabel}.label`);
    requireNonEmptyString(owner.selector, `${ownerLabel}.selector`);
    requireExact(owner.found, true, `${ownerLabel}.found`);
    verifyOverflowNumber(owner.overflow, `${ownerLabel}.overflow`);
    requireNonNegativeInteger(owner.clientWidth, `${ownerLabel}.clientWidth`);
    requireNonNegativeInteger(owner.scrollWidth, `${ownerLabel}.scrollWidth`);
  }
}

function verifyCanonicalSurface(record, stableId, label) {
  const expected = expectedSurfaces.get(stableId);
  if (!expected) return;
  if (!isObject(record.viewport)) errors.push(`${label}.viewport must be an object`);
  else {
    requirePositiveInteger(record.viewport.width, `${label}.viewport.width`);
    requirePositiveInteger(record.viewport.height, `${label}.viewport.height`);
    requireExact(`${record.viewport.width}x${record.viewport.height}`, expected.viewport, `${label}.viewport`);
  }
  requireExact(record.theme, expected.theme, `${label}.theme`);
  requireExact(record.reducedMotion, expected.motion, `${label}.reducedMotion`);
}

function verifyCoverage(scenarios) {
  const viewports = new Set();
  const themes = new Set();
  const motions = new Set();
  for (const record of scenarios) {
    if (!isObject(record)) continue;
    if (isObject(record.viewport)) viewports.add(`${record.viewport.width}x${record.viewport.height}`);
    themes.add(record.theme);
    motions.add(record.reducedMotion);
  }
  for (const viewport of ["1280x800", "1440x960"]) if (!viewports.has(viewport)) errors.push(`evidence lacks viewport ${viewport}`);
  for (const theme of ["ling-light", "ling-dark"]) if (!themes.has(theme)) errors.push(`evidence lacks theme ${theme}`);
  if (!motions.has("reduce")) errors.push("evidence lacks a reduced-motion scenario");
}

async function verifyDirectoryFiles(referencedPng, referencedJson) {
  let entries;
  try {
    entries = await readdir(evidenceDirectory, { withFileTypes: true });
  } catch (error) {
    errors.push(`evidence directory cannot be read: ${formatError(error)}`);
    return;
  }
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const allowed = new Set(["manifest.json", "metadata.md", ...referencedPng, ...referencedJson]);
  for (const file of files) if (!allowed.has(file)) errors.push(`orphan evidence file: ${file}`);
  for (const file of allowed) if (!files.includes(file)) errors.push(`referenced evidence file is missing: ${file}`);
  for (const entry of entries) if (!entry.isFile()) errors.push(`evidence directory must be flat; unexpected entry: ${entry.name}`);
}

function verifyMetadata(value, manifestValue) {
  if (typeof value !== "string" || !isObject(manifestValue)) return;
  const required = [
    "# T13-P.9EF Final Error Ownership Evidence",
    `- Batch: \`${batchId}\``,
    `- Status: \`${manifestValue.status}\``,
    `- Capture state: \`${manifestValue.scenarios?.length ?? 0}-of-${expectedScenarioIds.length}\``,
    `- Served artifact: ${servedArtifact}`,
    `- Base URL: \`${manifestValue.baseUrl}\``,
    `- Generated at: \`${manifestValue.generatedAt}\``,
    `- Source commit: \`${manifestValue.source?.commit}\``,
    `- Source branch: \`${manifestValue.source?.branch}\``,
    `- Source dirty: \`false\``,
    `- Worktree status SHA-256: \`${manifestValue.source?.worktreeStatusSha256}\``,
    `- Source identifier: \`${manifestValue.source?.identifier}\``,
    `- Protected P9-D tag: \`${protectedTag}\` (\`${manifestValue.protectedEvidence?.tagCommit}\`)`,
    `- Focused gate: \`${manifestValue.closeout?.focusedGate}\``,
    `- Final non-Desktop gate: \`${manifestValue.closeout?.finalNonDesktopGate}\``,
    `- Feedback guard: \`${manifestValue.closeout?.feedbackGuard?.status}\` (expected ${manifestValue.closeout?.feedbackGuard?.expected})`,
    captureCommand,
    ...expectedExclusions,
  ];
  for (const fragment of required) if (!value.includes(fragment)) errors.push(`metadata is missing: ${fragment}`);
  if (/Structural verifier state:\s*`(?:passed|verified)`/u.test(value)) {
    errors.push("capture-generated metadata must not pre-claim verifier success");
  }
}

function verifyProtectedLedger(value, label) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  requireExact(value.tag, protectedTag, `${label}.tag`);
  requireGitCommit(value.tagCommit, `${label}.tagCommit`);
}

function verifyCloseout(value, label) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  requireExact(value.focusedGate, "pending-final-ledger", `${label}.focusedGate`);
  requireExact(value.finalNonDesktopGate, "pending-final-ledger", `${label}.finalNonDesktopGate`);
  requireExact(value.visualReview, "pending", `${label}.visualReview`);
  if (!isObject(value.feedbackGuard)) errors.push(`${label}.feedbackGuard must be an object`);
  else {
    requireExact(value.feedbackGuard.status, "pending-final-ledger", `${label}.feedbackGuard.status`);
    requireExact(value.feedbackGuard.expected, "writer=0 compatibility=0 consumer=0 released-contracts=22", `${label}.feedbackGuard.expected`);
  }
  verifyCanonicalArray(value.excluded, expectedExclusions, `${label}.excluded`);
}

function verifyProtectedEvidence(manifestValue) {
  let actualTagCommit;
  try {
    actualTagCommit = runGit(["rev-parse", `${protectedTag}^{commit}`]);
  } catch (error) {
    errors.push(`protected tag cannot be resolved: ${formatError(error)}`);
    return;
  }
  if (manifestValue.protectedEvidence?.tagCommit !== actualTagCommit) {
    errors.push("manifest.protectedEvidence.tagCommit does not match the local protected tag");
  }
  let paths;
  try {
    paths = runGit(["ls-tree", "-r", "--name-only", protectedTag, "--", "docs/design/ui2.0升级/evidence"])
      .split("\n")
      .filter((entry) => entry.endsWith(".png") || entry.endsWith("/metadata.md"));
  } catch (error) {
    errors.push(`protected evidence inventory failed: ${formatError(error)}`);
    return;
  }
  for (const relativePath of paths) {
    const currentPath = path.join(repositoryRoot, relativePath);
    let taggedBytes;
    let headBytes;
    let worktreeBytes;
    try {
      taggedBytes = execFileSync("git", ["show", `${protectedTag}:${relativePath}`], { cwd: repositoryRoot });
      headBytes = execFileSync("git", ["show", `HEAD:${relativePath}`], { cwd: repositoryRoot });
      worktreeBytes = readFileSync(currentPath);
    } catch {
      errors.push(`protected evidence is missing from HEAD or worktree: ${relativePath}`);
      continue;
    }
    if (!taggedBytes.equals(headBytes) || !taggedBytes.equals(worktreeBytes)) {
      errors.push(`protected evidence changed after ${protectedTag}: ${relativePath}`);
    }
  }
}

function verifyCurrentSource(manifestValue) {
  const source = manifestValue.source;
  if (!isObject(source)) return;
  let head;
  let branch;
  let unrelatedStatus;
  let sourceDrift;
  try {
    head = runGit(["rev-parse", "HEAD"]);
    branch = runGit(["branch", "--show-current"]) || "detached";
    unrelatedStatus = runGit([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ".",
      ":(exclude)docs/design/ui2.0升级/evidence/release/web/p9ef-final-error-ownership",
    ]);
    if (source.commit !== head) {
      runGit(["merge-base", "--is-ancestor", source.commit, head]);
      sourceDrift = runGit([
        "diff",
        "--name-only",
        source.commit,
        head,
        "--",
        ".",
        ":(exclude)docs/design/ui2.0升级/evidence/release/web/p9ef-final-error-ownership",
      ]);
    }
  } catch (error) {
    errors.push(`current source identity cannot be read: ${formatError(error)}`);
    return;
  }
  if (source.commit !== head && sourceDrift?.length > 0) {
    errors.push(`source changed outside the dedicated evidence directory after ${source.commit}: ${sourceDrift}`);
  }
  if (source.branch !== branch) errors.push(`manifest.source.branch ${source.branch} does not match current branch ${branch}`);
  if (unrelatedStatus.length > 0) errors.push("worktree has changes outside the dedicated P9-EF evidence directory");
  const cleanStatusHash = createHash("sha256").update("").digest("hex");
  if (source.worktreeStatusSha256 !== cleanStatusHash) {
    errors.push("manifest.source.worktreeStatusSha256 must identify the clean pre-capture worktree");
  }
}

function verifyFunctionIds(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must be a non-empty array`);
    return;
  }
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !/^[A-Z][A-Z0-9-]*-\d{3}$/u.test(item)) errors.push(`${label} contains an invalid Function ID`);
    else if (seen.has(item)) errors.push(`${label} contains duplicate Function ID ${item}`);
    else seen.add(item);
  }
}

function verifyTrigger(value, label) {
  if (!isObject(value)) errors.push(`${label} must be an object`);
  else {
    requireNonEmptyString(value.summary, `${label}.summary`);
    verifyNonEmptyStringArray(value.steps, `${label}.steps`);
  }
}

function verifyOwner(value, label) {
  if (!isObject(value)) errors.push(`${label} must be an object`);
  else for (const key of ["surface", "scope", "key"]) requireNonEmptyString(value[key], `${label}.${key}`);
}

function verifyAssertions(value, label) {
  if (!isObject(value)) errors.push(`${label} must be an object`);
  else {
    verifyNonEmptyStringArray(value.visible, `${label}.visible`);
    verifyNonEmptyStringArray(value.absent, `${label}.absent`);
  }
}

function verifyExpectedHttpFailures(value, label) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return;
  }
  for (const [index, item] of value.entries()) {
    const itemLabel = `${label}[${index}]`;
    if (!isObject(item)) {
      errors.push(`${itemLabel} must be an object`);
      continue;
    }
    if (!new Set(["GET", "PATCH", "POST", "PUT"]).has(item.method)) errors.push(`${itemLabel}.method is unsupported`);
    requireExact(item.status, 503, `${itemLabel}.status`);
    const pattern = requireNonEmptyString(item.urlPattern, `${itemLabel}.urlPattern`);
    if (pattern) try { new RegExp(pattern, "u"); } catch { errors.push(`${itemLabel}.urlPattern is not a valid regular expression`); }
    requirePositiveInteger(item.count, `${itemLabel}.count`);
  }
}

function verifyOverflowOwners(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must be a non-empty array`);
    return;
  }
  for (const [index, item] of value.entries()) {
    if (!isObject(item)) errors.push(`${label}[${index}] must be an object`);
    else {
      requireNonEmptyString(item.label, `${label}[${index}].label`);
      requireNonEmptyString(item.selector, `${label}[${index}].selector`);
    }
  }
}

function verifyKeyboard(value, label) {
  if (!isObject(value)) errors.push(`${label} must be an object`);
  else {
    requireExact(value.exercised, true, `${label}.exercised`);
    verifyNonEmptyStringArray(value.checks, `${label}.checks`);
  }
}

function verifySource(value, label, requireClean) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const commit = requireGitCommit(value.commit, `${label}.commit`);
  requireNonEmptyString(value.branch, `${label}.branch`);
  if (requireClean) requireExact(value.dirty, false, `${label}.dirty`);
  requireSha256(value.worktreeStatusSha256, `${label}.worktreeStatusSha256`);
  if (commit) requireExact(value.identifier, commit, `${label}.identifier`);
}

function matchesHttpFailure(actual, expected) {
  if (!isObject(actual) || !isObject(expected)) return false;
  try {
    return actual.method === expected.method
      && actual.status === expected.status
      && typeof actual.url === "string"
      && new RegExp(expected.urlPattern, "u").test(actual.url);
  } catch {
    return false;
  }
}

function addUniqueReference(set, value, kind) {
  if (set.has(value)) errors.push(`${kind} is referenced more than once: ${value}`);
  set.add(value);
}

function verifyOverflowNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) errors.push(`${label} must be a non-negative number`);
  else if (value > 1) errors.push(`${label} exceeds the 1px tolerance: ${value}`);
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) errors.push(`${label} must be a non-negative integer`);
}

function verifyCanonicalArray(value, expected, label) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return;
  }
  if (value.length !== expected.length || value.some((item, index) => item !== expected[index])) {
    errors.push(`${label} must match the canonical ordered values`);
  }
}

function verifyNonEmptyStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    errors.push(`${label} must be a non-empty string array`);
  }
}

function verifyEmptyArray(value, label) {
  if (!Array.isArray(value)) errors.push(`${label} must be an array`);
  else if (value.length > 0) errors.push(`${label} must be empty`);
}

function verifyAbsoluteUrl(value, label, expectedOrigin) {
  const text = requireNonEmptyString(value, label);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (!new Set(["http:", "https:"]).has(url.protocol)) errors.push(`${label} must use http or https`);
    if (expectedOrigin && url.origin !== expectedOrigin) errors.push(`${label} must use manifest.baseUrl origin ${expectedOrigin}`);
    return url.origin;
  } catch {
    errors.push(`${label} must be an absolute URL`);
    return undefined;
  }
}

function verifyIsoDate(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) errors.push(`${label} must be an ISO date string`);
}

function requireExact(value, expected, label) {
  if (value !== expected) errors.push(`${label} must be ${JSON.stringify(expected)}`);
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) errors.push(`${label} must be a positive integer`);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${label} must be a non-empty string`);
    return undefined;
  }
  return value;
}

function requireGitCommit(value, label) {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    errors.push(`${label} must be a lowercase 40- or 64-character Git object ID`);
    return undefined;
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    errors.push(`${label} must be a lowercase SHA-256 digest`);
    return undefined;
  }
  return value;
}

function requireSafeBasename(value, label, extension) {
  const text = requireNonEmptyString(value, label);
  if (!text) return undefined;
  if (path.basename(text) !== text || !text.endsWith(extension)) {
    errors.push(`${label} must be a safe ${extension} basename`);
    return undefined;
  }
  return text;
}

async function readJson(filePath, label) {
  const text = await readText(filePath, label);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${formatError(error)}`);
    return undefined;
  }
}

async function readText(filePath, label) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    errors.push(`${label} cannot be read: ${formatError(error)}`);
    return undefined;
  }
}

async function readBytes(filePath, label) {
  try {
    return await readFile(filePath);
  } catch (error) {
    errors.push(`${label} cannot be read: ${formatError(error)}`);
    return undefined;
  }
}

function readPngDimensions(bytes, label) {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
    errors.push(`${label} is not a PNG with an IHDR chunk`);
    return undefined;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function runGit(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function parseFixtureDirectory(args) {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === "--fixture-directory") return path.resolve(args[1]);
  console.error("Usage: node verify-ui2-p9ef-evidence.mjs [--fixture-directory <absolute-or-relative-path>]");
  process.exit(2);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
