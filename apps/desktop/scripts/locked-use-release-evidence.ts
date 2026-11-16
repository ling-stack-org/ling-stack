import { createHash } from "node:crypto";

export const LOCKED_USE_ACCEPTANCE_CASES = Object.freeze([
  "source_checks", "cold_plugin_load", "packaged_gui_capture_input", "all_displays",
  "physical_takeover", "turn_end", "ttl", "sleep_wake", "user_switch", "guardian_exit",
  "watchdog_exit", "broker_restart", "helper_exit", "desktop_exit", "provider_exit",
  "component_replacement", "display_hotplug", "secure_surface_denied", "uninstall_restore",
] as const);

export const LOCKED_USE_COMPONENTS = Object.freeze({
  LingLockBroker: "com.lingstack.locked-use.broker",
  LingLockInstaller: "com.lingstack.locked-use.installer",
  "Ling Guardian.app/Contents/MacOS/LingGuardian": "com.lingstack.locked-use.guardian.dev",
  "Client.app/Contents/MacOS/LingLockedUseClient": "com.lingstack.locked-use.client",
  "LingLockAuth.bundle/Contents/MacOS/LingLockAuth": "com.lingstack.locked-use.authorization",
});

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
export const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown): value is string => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256;

export interface ObservedLockedUseRelease {
  readonly osBuild: string;
  readonly team: string;
  readonly providerSha256: string;
  readonly artifactSha256: Readonly<Record<string, string>>;
  readonly componentCodeHashes: Readonly<{ brokerHash: string; guardianHash: string; pluginHash: string; clientHash: string }>;
}

/** Physical and fault results are supplied by an identified release reviewer. */
export function validateLockedUseReleaseEvidence(input: {
  readonly manifestBytes: Buffer;
  readonly manifest: unknown;
  readonly report: unknown;
  readonly checklist: unknown;
  readonly observed: ObservedLockedUseRelease;
}): Buffer {
  const { manifest: manifest, report, checklist, observed } = input;
  function fail(reason: string): never { throw new Error("locked_use_release_" + reason); }
  const artifacts = record(manifest) && record(manifest.artifacts) ? manifest.artifacts : {};
  const reportedEvidence = record(report) && record(report.evidence) ? report.evidence : {};
  if (!record(manifest) || !exact(manifest, ["schemaVersion", "platform", "architecture", "team", "signing",
    "productCapability", "nativeAcceptance", "checks", "upstreamCommit", "artifacts"])
    || manifest.schemaVersion !== 1 || manifest.platform !== "darwin"
    || manifest.architecture !== process.arch || manifest.signing !== "local_identity"
    || manifest.team !== observed.team || !/^[A-Z0-9]{10}$/u.test(observed.team) || observed.team === "0000000000"
    || manifest.productCapability !== "disabled_by_build" || manifest.nativeAcceptance !== "not_run"
    || typeof manifest.upstreamCommit !== "string" || !/^[a-f0-9]{40}$/u.test(manifest.upstreamCommit)
    || !record(manifest.checks) || !exact(manifest.checks, ["policy", "authorizationPluginABI", "kernelTaskVerifier", "xctest"])
    || manifest.checks.policy !== "passed" || manifest.checks.authorizationPluginABI !== "passed"
    || manifest.checks.kernelTaskVerifier !== "identity_passed" || manifest.checks.xctest !== "separate"
    || !record(manifest.artifacts) || !exact(manifest.artifacts, Object.keys(LOCKED_USE_COMPONENTS))
    || !Object.keys(LOCKED_USE_COMPONENTS).every((key) => isHash(artifacts[key])
      && artifacts[key] === observed.artifactSha256[key])) fail("manifest_mismatch");
  const evidence = { osBuild: observed.osBuild, ...observed.componentCodeHashes };
  if (!record(report) || !exact(report, ["schemaVersion", "leaseID", "evidence", "ownerToken", "ownerCodeHash",
    "guiAndKeychainPassed", "lockedAndReleased", "afterManualUnlockPassed"])
    || report.schemaVersion !== 2 || typeof report.leaseID !== "string" || !/^[A-Fa-f0-9-]{36}$/u.test(report.leaseID)
    || !record(report.evidence) || !exact(report.evidence, Object.keys(evidence))
    || !Object.entries(evidence).every(([key, value]) => reportedEvidence[key] === value)
    || typeof report.ownerToken !== "string" || Buffer.from(report.ownerToken, "base64").length !== 32
    || typeof report.ownerCodeHash !== "string" || Buffer.from(report.ownerCodeHash, "base64").toString("hex") !== evidence.clientHash
    || report.guiAndKeychainPassed !== true || report.lockedAndReleased !== true || report.afterManualUnlockPassed !== true) fail("native_acceptance_incomplete");
  if (!record(checklist) || !exact(checklist, ["schemaVersion", "platform", "osBuild", "team",
    "nativeBuildManifestSha256", "providerExecutableSha256", "reviewer", "reviewedAt", "cases"])
    || checklist.schemaVersion !== 1 || checklist.platform !== "darwin" || checklist.osBuild !== observed.osBuild
    || checklist.team !== observed.team || checklist.nativeBuildManifestSha256 !== sha256(input.manifestBytes)
    || !isHash(observed.providerSha256) || checklist.providerExecutableSha256 !== observed.providerSha256
    || !text(checklist.reviewer) || typeof checklist.reviewedAt !== "string" || !Number.isFinite(Date.parse(checklist.reviewedAt))
    || Date.parse(checklist.reviewedAt) > Date.now() || !record(checklist.cases)
    || !exact(checklist.cases, LOCKED_USE_ACCEPTANCE_CASES)) fail("checklist_mismatch");
  for (const name of LOCKED_USE_ACCEPTANCE_CASES) {
    const item: unknown = checklist.cases[name];
    if (!record(item) || !exact(item, ["result", "evidencePath", "evidenceSha256"])
      || item.result !== "passed" || !text(item.evidencePath) || !isHash(item.evidenceSha256)) fail("case_incomplete:" + name);
  }
  return Buffer.from(JSON.stringify({
    schemaVersion: 1, platform: "darwin", nativeAcceptance: "passed",
    expectedTeamId: observed.team, expectedBuildManifestSha256: sha256(input.manifestBytes),
  }, null, 2) + "\n");
}
