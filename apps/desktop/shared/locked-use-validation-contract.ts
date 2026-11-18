export const LOCKED_USE_VALIDATION_METADATA_KEY = "lingLockedUseValidationCandidateSha256";
export const LOCKED_USE_VALIDATION_ENTRY = "./dist/main/locked-computer-control/validation-entry.js";
export const LOCKED_USE_VALIDATION_RESOURCE = "locked-use/validation-candidate.json";
export const LOCKED_USE_VALIDATION_FIXTURE = "Locked Use Validation.app";
export const LOCKED_USE_VALIDATION_FIXTURE_BINARY = "LingLockedUseFixture";
export const LOCKED_USE_VALIDATION_FIXTURE_ID = "com.lingstack.validation.fixture";

export interface LockedUseValidationCandidate {
  readonly schemaVersion: 1;
  readonly kind: "attended_candidate";
  readonly platform: "darwin";
  readonly architecture: "arm64";
  readonly osBuild: string;
  readonly expectedTeamId: string;
  readonly expectedBuildManifestSha256: string;
  readonly providerCodeHash: string;
  readonly fixtureExecutableSha256: string;
}

export function parseLockedUseValidationCandidate(value: unknown): LockedUseValidationCandidate {
  if (!record(value) || !exact(value, ["schemaVersion", "kind", "platform", "architecture", "osBuild",
    "expectedTeamId", "expectedBuildManifestSha256", "providerCodeHash", "fixtureExecutableSha256"])
    || value.schemaVersion !== 1 || value.kind !== "attended_candidate" || value.platform !== "darwin"
    || value.architecture !== "arm64" || typeof value.osBuild !== "string" || !/^[A-Za-z0-9.]{1,64}$/u.test(value.osBuild)
    || typeof value.expectedTeamId !== "string" || !/^[A-Z0-9]{10}$/u.test(value.expectedTeamId)
    || value.expectedTeamId === "0000000000" || !isHash(value.expectedBuildManifestSha256)
    || typeof value.providerCodeHash !== "string" || !/^[a-f0-9]{40,64}$/u.test(value.providerCodeHash)
    || !isHash(value.fixtureExecutableSha256)) throw new Error("locked_use_validation_candidate_invalid");
  return Object.freeze({ ...value }) as unknown as LockedUseValidationCandidate;
}

export const LOCKED_USE_PACKAGED_VALIDATION_FACTS = Object.freeze([
  "localIdentityVerified", "providerCaptureReady", "providerInputAcknowledged", "changedWindowPixels",
  "providerExited", "relockedAndReleased", "manualUnlockObserved",
] as const);

export interface LockedUsePackagedValidationReport {
  readonly schemaVersion: 1;
  readonly kind: "packaged_gui_capture_input";
  readonly result: "passed";
  readonly productCapability: "disabled_by_build";
  readonly candidateSha256: string;
  readonly nativeBuildManifestSha256: string;
  readonly providerCodeHash: string;
  readonly fixtureExecutableSha256: string;
  readonly packageCodeHash: string;
  readonly osBuild: string;
  readonly architecture: "arm64";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly counterBefore: 0;
  readonly counterAfter: 1;
  readonly beforeImageSha256: string;
  readonly afterImageSha256: string;
  readonly beforePixelsSha256: string;
  readonly afterPixelsSha256: string;
  readonly facts: Readonly<Record<typeof LOCKED_USE_PACKAGED_VALIDATION_FACTS[number], true>>;
}

/** A passing candidate run is evidence for one review case, never release authority. */
export function parseLockedUsePackagedValidationReport(value: unknown): LockedUsePackagedValidationReport {
  if (!record(value) || !exact(value, ["schemaVersion", "kind", "result", "productCapability", "candidateSha256",
    "nativeBuildManifestSha256", "providerCodeHash", "fixtureExecutableSha256", "packageCodeHash", "osBuild",
    "architecture", "startedAt", "completedAt", "counterBefore", "counterAfter", "beforeImageSha256", "afterImageSha256",
    "beforePixelsSha256", "afterPixelsSha256", "facts"])
    || value.schemaVersion !== 1 || value.kind !== "packaged_gui_capture_input" || value.result !== "passed"
    || value.productCapability !== "disabled_by_build" || !isHash(value.candidateSha256)
    || !isHash(value.nativeBuildManifestSha256) || !isHash(value.fixtureExecutableSha256)
    || !codeHash(value.providerCodeHash) || !codeHash(value.packageCodeHash)
    || value.architecture !== "arm64" || typeof value.osBuild !== "string" || !/^[A-Za-z0-9.]{1,64}$/u.test(value.osBuild)
    || !timestamp(value.startedAt) || !timestamp(value.completedAt)
    || Date.parse(value.startedAt) > Date.parse(value.completedAt) || Date.parse(value.completedAt) > Date.now()
    || value.counterBefore !== 0 || value.counterAfter !== 1
    || !isHash(value.beforeImageSha256) || !isHash(value.afterImageSha256)
    || value.beforeImageSha256 === value.afterImageSha256 || !isHash(value.beforePixelsSha256) || !isHash(value.afterPixelsSha256)
    || value.beforePixelsSha256 === value.afterPixelsSha256 || !record(value.facts)
    || !exact(value.facts, LOCKED_USE_PACKAGED_VALIDATION_FACTS)
    || !LOCKED_USE_PACKAGED_VALIDATION_FACTS.every(key => (value.facts as Record<string, unknown>)[key] === true)) {
    throw new Error("locked_use_packaged_validation_incomplete");
  }
  return value as unknown as LockedUsePackagedValidationReport;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function isHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function codeHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{40,64}$/u.test(value); }
function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && Number.isFinite(Date.parse(value));
}
