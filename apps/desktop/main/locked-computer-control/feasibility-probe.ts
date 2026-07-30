import type {
  LockedComputerControlCapabilityV1,
  LockedComputerControlPlatform,
  LockedControlReasonCode,
} from "@ling-stack/contracts";

export const LOCKED_CONTROL_FEASIBILITY_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const LOCKED_CONTROL_FEASIBILITY_RESULTS = [
  "feasible_candidate",
  "unsupported",
] as const;

export type LockedControlFeasibilityResult =
  (typeof LOCKED_CONTROL_FEASIBILITY_RESULTS)[number];

/**
 * Content-free evidence emitted by an attended development probe.
 *
 * `feasible_candidate` is deliberately not a product capability. Only packaged Slice 7
 * acceptance may promote a platform to `supported_restricted`.
 */
export interface LockedControlFeasibilityEvidenceV1 {
  readonly schemaVersion: 1;
  readonly platform: LockedComputerControlPlatform;
  readonly result: LockedControlFeasibilityResult;
  readonly reason?: LockedControlReasonCode;
  readonly sameUserSessionBound: boolean;
  readonly captureReadyWhileLocked: boolean;
  readonly inputAcknowledgedWhileLocked: boolean;
  readonly secureSurfaceExcluded: boolean;
  readonly providerIntegrationMode: "embedded-stdio";
  readonly providerVersion: "0.8.3";
  readonly distributionRevision: "ling.1";
  readonly helperSha256: string;
  readonly providerSha256: string;
  readonly adapterVersion: string;
  readonly osVersion: string;
  readonly observedAt: string;
}

export interface LockedControlNativeFeasibilityProbe {
  probe(platform: LockedComputerControlPlatform): Promise<unknown>;
}

export interface LockedControlFeasibilityProbeResult {
  readonly capability: LockedComputerControlCapabilityV1;
  readonly evidence?: LockedControlFeasibilityEvidenceV1;
}

export interface LockedControlFeasibilityProbe {
  run(): Promise<LockedControlFeasibilityProbeResult>;
}

const EVIDENCE_KEYS = new Set([
  "schemaVersion",
  "platform",
  "result",
  "reason",
  "sameUserSessionBound",
  "captureReadyWhileLocked",
  "inputAcknowledgedWhileLocked",
  "secureSurfaceExcluded",
  "providerIntegrationMode",
  "providerVersion",
  "distributionRevision",
  "helperSha256",
  "providerSha256",
  "adapterVersion",
  "osVersion",
  "observedAt",
]);

const UNSUPPORTED_REASONS: ReadonlySet<LockedControlReasonCode> = new Set([
  "locked_control_platform_unsupported",
  "locked_control_session_mismatch",
  "locked_control_secure_surface",
  "locked_control_capture_unavailable",
  "locked_control_input_unavailable",
  "locked_control_user_switched",
]);

export function isLockedControlFeasibilityEvidenceV1(
  value: unknown,
): value is LockedControlFeasibilityEvidenceV1 {
  if (!isRecord(value)
    || !Object.keys(value).every((key) => EVIDENCE_KEYS.has(key))
    || value.schemaVersion !== 1
    || (value.platform !== "darwin" && value.platform !== "win32")
    || !(LOCKED_CONTROL_FEASIBILITY_RESULTS as readonly unknown[]).includes(value.result)
    || !areBooleans(value, [
      "sameUserSessionBound",
      "captureReadyWhileLocked",
      "inputAcknowledgedWhileLocked",
      "secureSurfaceExcluded",
    ])
    || value.providerIntegrationMode !== "embedded-stdio"
    || value.providerVersion !== "0.8.3"
    || value.distributionRevision !== "ling.1"
    || !isSha256(value.helperSha256)
    || !isSha256(value.providerSha256)
    || !isText(value.adapterVersion)
    || !isText(value.osVersion)
    || !isCanonicalTimestamp(value.observedAt)) {
    return false;
  }
  const allProofs = value.sameUserSessionBound === true
    && value.captureReadyWhileLocked === true
    && value.inputAcknowledgedWhileLocked === true
    && value.secureSurfaceExcluded === true;
  return value.result === "feasible_candidate"
    ? allProofs && value.reason === undefined
    : !allProofs && UNSUPPORTED_REASONS.has(value.reason as LockedControlReasonCode);
}

/**
 * Create an inert per-platform probe. Build policy must opt in before a native helper is
 * invoked; absence, timeout, malformed output and platform mismatch all remain fail-closed.
 */
export function createLockedControlFeasibilityProbe(options: {
  readonly platform: LockedComputerControlPlatform;
  readonly buildProbeEnabled: boolean;
  readonly adapterVersion: string;
  readonly osVersion: string;
  readonly nativeProbe?: LockedControlNativeFeasibilityProbe;
}): LockedControlFeasibilityProbe {
  return Object.freeze({
    async run(): Promise<LockedControlFeasibilityProbeResult> {
      if (!options.buildProbeEnabled) {
        return { capability: negativeCapability(options, "disabled_by_build", "locked_control_disabled_by_build") };
      }
      if (!options.nativeProbe) {
        return { capability: negativeCapability(options, "probe_required", "locked_control_probe_required") };
      }
      let rawEvidence: unknown;
      try {
        rawEvidence = await options.nativeProbe.probe(options.platform);
      } catch {
        return { capability: negativeCapability(options, "probe_required", "locked_control_probe_required") };
      }
      if (!isLockedControlFeasibilityEvidenceV1(rawEvidence)
        || rawEvidence.platform !== options.platform
        || rawEvidence.adapterVersion !== options.adapterVersion
        || rawEvidence.osVersion !== options.osVersion) {
        return { capability: negativeCapability(options, "probe_required", "locked_control_probe_required") };
      }
      if (rawEvidence.result === "unsupported") {
        return {
          capability: negativeCapability(
            options,
            "unsupported",
            rawEvidence.reason ?? "locked_control_platform_unsupported",
          ),
          evidence: rawEvidence,
        };
      }
      // Development evidence may be retained for review, but cannot self-promote the live
      // product capability. Slice 7 packaged acceptance owns that transition.
      return {
        capability: negativeCapability(options, "probe_required", "locked_control_probe_required"),
        evidence: rawEvidence,
      };
    },
  });
}

function negativeCapability(
  options: Pick<
    Parameters<typeof createLockedControlFeasibilityProbe>[0],
    "platform" | "adapterVersion" | "osVersion"
  >,
  state: Exclude<LockedComputerControlCapabilityV1["state"], "supported_restricted">,
  reason: LockedControlReasonCode,
): LockedComputerControlCapabilityV1 {
  return Object.freeze({
    schemaVersion: 1,
    platform: options.platform,
    state,
    reason,
    canCaptureSameUserDesktopWhileLocked: false,
    canInjectSameUserDesktopWhileLocked: false,
    canProveSessionContinuity: false,
    secureSurfaceExcluded: false,
    adapterVersion: options.adapterVersion,
    osVersion: options.osVersion,
    observedAt: new Date().toISOString(),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function areBooleans(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "boolean");
}

function isText(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && value.trim() === value;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
