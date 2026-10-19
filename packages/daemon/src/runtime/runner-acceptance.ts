import { RUNNER_RELEASE_CHECKS, RUNNER_HOST_CHECKS, type RunnerAcceptanceDecision, type RunnerAcceptanceIdentity, type RunnerReleaseIdentity } from "@ling-stack/contracts";

const identityKeys = [
  "runnerId", "runtimeVersion", "sdkVersion", "adapterVersion", "executableDigest",
  "platform", "architecture", "profileId", "profileRevision", "configurationFingerprint",
  "workspaceId", "policyFingerprint", "workflowSurface",
] as const satisfies readonly (keyof RunnerAcceptanceIdentity)[];

const releaseIdentityKeys = [
  "runnerId", "runtimeVersion", "sdkVersion", "adapterVersion", "executableDigest",
  "platform", "architecture", "policyFingerprint", "workflowSurface",
] as const satisfies readonly (keyof RunnerReleaseIdentity)[];

/** Compare trusted verifier storage with current host/workspace facts; never grant policy. */
export function assessRunnerAcceptance(
  current: RunnerAcceptanceIdentity,
  evidence: unknown,
  now = Date.now(),
): RunnerAcceptanceDecision {
  const host = assessRecord(current, evidence, identityKeys, RUNNER_HOST_CHECKS, now);
  if (host.status !== "accepted") return host;
  if (!isRecord(evidence)) return blocked("verification_invalid");
  const release = assessRecord(current, evidence.release, releaseIdentityKeys, RUNNER_RELEASE_CHECKS, now);
  if (release.status !== "accepted") return release;
  if (!isRecord(evidence.release) || evidence.releaseEvidenceId !== evidence.release.id) {
    return blocked("verification_mismatch");
  }
  return { status: "accepted" };
}

function assessRecord(
  current: RunnerAcceptanceIdentity,
  evidence: unknown,
  keys: readonly (keyof RunnerAcceptanceIdentity)[],
  requiredChecks: readonly string[],
  now: number,
): RunnerAcceptanceDecision {
  if (evidence === undefined) return blocked("verification_missing");
  if (!isRecord(evidence) || evidence.schemaVersion !== 1 || !nonEmptyString(evidence.id) || !Number.isFinite(now)) {
    return blocked("verification_invalid");
  }
  if (evidence.revokedAt !== undefined) return blocked("verification_revoked");
  const identity = evidence.identity;
  if (!isRecord(identity) || keys.some((key) => !validIdentityField(key, identity[key]))) {
    return blocked("verification_invalid");
  }
  if (keys.some((key) => !validIdentityField(key, current[key]) || current[key] !== identity[key])) {
    return blocked("verification_mismatch");
  }
  const verifiedAt = typeof evidence.verifiedAt === "string" ? Date.parse(evidence.verifiedAt) : Number.NaN;
  const expiresAt = typeof evidence.expiresAt === "string" ? Date.parse(evidence.expiresAt) : Number.NaN;
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt) || verifiedAt > now || expiresAt <= verifiedAt) {
    return blocked("verification_invalid");
  }
  if (expiresAt <= now) return blocked("verification_expired");
  const checks = evidence.checks;
  if (!isRecord(checks) || requiredChecks.some((check) => !Object.hasOwn(checks, check) || checks[check] !== "passed")) {
    return blocked("verification_incomplete");
  }
  return { status: "accepted" };
}

function blocked(reason: Extract<RunnerAcceptanceDecision, { status: "blocked" }>["reason"]): RunnerAcceptanceDecision {
  return { status: "blocked", reason };
}

function validIdentityField(key: keyof RunnerAcceptanceIdentity, value: unknown): boolean {
  return key === "profileRevision"
    ? typeof value === "number" && Number.isSafeInteger(value) && value > 0
    : nonEmptyString(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
