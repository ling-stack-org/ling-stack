import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_JSON_BYTES = 1024 * 1024;
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export class AssuranceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AssuranceError";
    this.code = code;
  }
}

export function requireCondition(condition, code, message) {
  if (!condition) throw new AssuranceError(code, message);
}

export function exactObject(value, keys, label) {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype, "invalid_manifest", `${label} must be an object.`);
  requireCondition(Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key)), "invalid_manifest", `${label} has missing or unsupported fields.`);
  return value;
}

export function identifier(value, label) {
  requireCondition(typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value),
    "invalid_manifest", `${label} must be a bounded identifier.`);
  return value;
}

export function nonempty(value, label) {
  requireCondition(typeof value === "string" && value.trim().length > 0 && value.length <= 4096,
    "invalid_manifest", `${label} must be bounded non-empty text.`);
  return value;
}

export function digest(value, label) {
  requireCondition(typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    "invalid_manifest", `${label} must be a SHA-256 byte digest.`);
  return value;
}

export function safeRelativePath(value) {
  requireCondition(typeof value === "string" && value.length <= 1024
    && /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value)
    && value.split("/").every(part => part !== "" && part !== "." && part !== ".."),
  "path_outside_fixture_root", "Path must be a portable relative file path without traversal.");
  return value;
}

export function artifactRef(value) {
  exactObject(value, ["path", "sha256", "mediaType"], "artifact reference");
  safeRelativePath(value.path);
  digest(value.sha256, "artifact sha256");
  requireCondition(["application/json", "text/plain", "text/x-diff"].includes(value.mediaType),
    "invalid_manifest", "Unsupported artifact media type.");
  return value;
}

export async function readBoundFile(root, path, maxBytes = MAX_JSON_BYTES) {
  safeRelativePath(path);
  const canonicalRoot = await realpath(root);
  const target = resolve(canonicalRoot, path);
  const inside = value => {
    const child = relative(canonicalRoot, value);
    return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
  };
  requireCondition(inside(target), "path_outside_fixture_root", "Artifact escapes its trusted root.");
  let current = canonicalRoot;
  const parts = path.split("/");
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    const stat = await lstat(current);
    requireCondition(!stat.isSymbolicLink(), "path_outside_fixture_root", "Artifact path contains a symbolic link.");
    requireCondition(index === parts.length - 1 ? stat.isFile() : stat.isDirectory(),
      "invalid_manifest", "Artifact path must end in a regular file.");
  }
  requireCondition(inside(await realpath(target)), "path_outside_fixture_root", "Artifact resolves outside its trusted root.");
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    requireCondition(before.isFile() && before.size <= maxBytes, "invalid_manifest", "Artifact is not a bounded regular file.");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    const after = await handle.stat();
    requireCondition(bytes.length <= maxBytes && bytes.length === before.size && before.size === after.size
      && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,
      "snapshot_changed", "Artifact changed during its read.");
    requireCondition(inside(await realpath(target)), "path_outside_fixture_root", "Artifact path changed during its read.");
    return { bytes, sha256: sha256(bytes) };
  } finally {
    await handle.close();
  }
}

export function parseJson(bytes, label = "JSON artifact") {
  requireCondition(bytes.length <= MAX_JSON_BYTES, "invalid_manifest", `${label} exceeds the JSON limit.`);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new AssuranceError("invalid_manifest", `${label} is not valid JSON.`); }
  const visit = (item, depth) => {
    requireCondition(depth <= 64, "invalid_manifest", `${label} exceeds the JSON depth limit.`);
    if (typeof item === "number") requireCondition(Number.isFinite(item), "invalid_manifest", `${label} contains a non-finite number.`);
    if (item && typeof item === "object") for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(value, 0);
  return value;
}

export async function readArtifact(root, reference) {
  artifactRef(reference);
  const result = await readBoundFile(root, reference.path);
  requireCondition(result.sha256 === reference.sha256, "artifact_digest_mismatch", "Artifact byte digest does not match its frozen reference.");
  return { ...result, value: reference.mediaType === "application/json" ? parseJson(result.bytes) : undefined };
}

function uniqueList(value, label, parse = identifier) {
  requireCondition(Array.isArray(value) && value.length >= 1 && value.length <= 100,
    "invalid_manifest", `${label} must have 1 to 100 entries.`);
  value.forEach(item => parse(item, label));
  requireCondition(new Set(value).size === value.length, "invalid_manifest", `${label} has duplicate entries.`);
}

export function parseSuite(value) {
  exactObject(value, ["schemaVersion", "suiteId", "suiteVersion", "description", "tasks"], "suite");
  requireCondition(value.schemaVersion === 1, "invalid_manifest", "Unsupported suite schema.");
  identifier(value.suiteId, "suiteId"); identifier(value.suiteVersion, "suiteVersion");
  nonempty(value.description, "description");
  requireCondition(Array.isArray(value.tasks) && value.tasks.length >= 1 && value.tasks.length <= 100,
    "invalid_manifest", "Suite must have 1 to 100 tasks.");
  const identities = new Set();
  for (const entry of value.tasks) {
    exactObject(entry, ["taskId", "taskVersion", "task"], "suite task");
    identifier(entry.taskId, "taskId"); identifier(entry.taskVersion, "taskVersion"); artifactRef(entry.task);
    requireCondition(entry.task.mediaType === "application/json", "invalid_manifest", "Task metadata must be JSON.");
    requireCondition(!identities.has(entry.taskId), "invalid_manifest", "Suite task identities must be unique.");
    identities.add(entry.taskId);
  }
  return value;
}

export function parseTask(value) {
  exactObject(value, ["schemaVersion", "taskId", "taskVersion", "category", "source", "provenance", "prompt",
    "validationProfile", "ruleCase", "expected", "controls", "environment", "capabilityRequirements", "requiredEvidence", "limits"], "task");
  requireCondition(value.schemaVersion === 1, "invalid_manifest", "Unsupported task schema.");
  identifier(value.taskId, "taskId"); identifier(value.taskVersion, "taskVersion");
  requireCondition(["analysis_readonly", "single_module_fix", "two_module_change"].includes(value.category), "invalid_manifest", "Unsupported task category.");
  exactObject(value.source, ["repository", "commit", "lockSha256", "files"], "source");
  requireCondition(value.source.repository === "ling-stack" && typeof value.source.commit === "string"
    && /^[a-f0-9]{40}$/.test(value.source.commit), "invalid_manifest", "Source must pin a Ling Git commit.");
  digest(value.source.lockSha256, "source lock digest");
  requireCondition(Array.isArray(value.source.files) && value.source.files.length >= 1 && value.source.files.length <= 20,
    "invalid_manifest", "Source must have a bounded file list.");
  value.source.files.forEach(artifactRef);
  requireCondition(new Set(value.source.files.map(item => item.path)).size === value.source.files.length,
    "invalid_manifest", "Source file pins must be unique.");
  exactObject(value.provenance, ["kind", "description", "anchors", "injection"], "provenance");
  requireCondition(["source_analysis", "real_regression", "fault_injection"].includes(value.provenance.kind), "invalid_manifest", "Unsupported task provenance.");
  nonempty(value.provenance.description, "provenance description");
  uniqueList(value.provenance.anchors, "source anchors", safeRelativePath);
  if (value.provenance.kind === "fault_injection") {
    artifactRef(value.provenance.injection);
    requireCondition(value.provenance.injection.mediaType === "text/x-diff", "invalid_manifest", "Injection must be a frozen patch.");
  } else requireCondition(value.provenance.injection === null, "invalid_manifest", "Non-injected tasks must not contain an injection patch.");
  artifactRef(value.prompt); artifactRef(value.ruleCase); artifactRef(value.expected);
  requireCondition(value.prompt.mediaType === "text/plain" && value.ruleCase.mediaType === "application/json"
    && value.expected.mediaType === "application/json", "invalid_manifest", "Task artifact types are invalid.");
  exactObject(value.validationProfile, ["id", "version", "artifact"], "validation profile reference");
  identifier(value.validationProfile.id, "profile id"); identifier(value.validationProfile.version, "profile version");
  artifactRef(value.validationProfile.artifact);
  requireCondition(value.validationProfile.artifact.mediaType === "application/json", "invalid_manifest", "Validation profile must be JSON.");
  exactObject(value.controls, ["correct", "incorrect", "missing"], "controls");
  for (const [name, assessment] of [["correct", "pass"], ["incorrect", "fail"], ["missing", "invalid_evidence"]]) {
    const control = value.controls[name];
    exactObject(control, ["candidate", "expectedAssessment"], "control"); artifactRef(control.candidate);
    requireCondition(control.candidate.mediaType === "application/json" && control.expectedAssessment === assessment,
      "invalid_manifest", "Controls must include passing, failing and missing-evidence cases.");
  }
  exactObject(value.environment, ["node", "pnpm", "typescript", "platform"], "environment");
  Object.values(value.environment).forEach(item => nonempty(item, "environment value"));
  uniqueList(value.capabilityRequirements, "capability requirements");
  uniqueList(value.requiredEvidence, "required evidence");
  exactObject(value.limits, ["timeoutMs", "maxConcurrent", "maxRequests", "maxAmount", "currency", "unknownUsagePolicy"], "limits");
  requireCondition(Number.isSafeInteger(value.limits.timeoutMs) && value.limits.timeoutMs > 0 && value.limits.timeoutMs <= 3600000
    && Number.isSafeInteger(value.limits.maxConcurrent) && value.limits.maxConcurrent >= 1 && value.limits.maxConcurrent <= 16
    && Number.isSafeInteger(value.limits.maxRequests) && value.limits.maxRequests >= 0
    && Number.isFinite(value.limits.maxAmount) && value.limits.maxAmount >= 0
    && typeof value.limits.currency === "string" && /^[A-Z]{3}$/.test(value.limits.currency)
    && value.limits.unknownUsagePolicy === "stop", "invalid_manifest", "Invalid resource limits.");
  return value;
}

export async function verifySource(repoRoot, source) {
  const pins = [...source.files, { path: "pnpm-lock.yaml", sha256: source.lockSha256, mediaType: "text/plain" }];
  for (const pin of pins) {
    await readArtifact(repoRoot, pin);
    let frozen;
    try { frozen = execFileSync("git", ["cat-file", "blob", `${source.commit}:${pin.path}`], { cwd: repoRoot, maxBuffer: MAX_JSON_BYTES, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { throw new AssuranceError("source_unavailable", "Frozen source commit or file is not available locally."); }
    requireCondition(sha256(frozen) === pin.sha256, "artifact_digest_mismatch", "Source pin does not match its declared commit.");
  }
}
