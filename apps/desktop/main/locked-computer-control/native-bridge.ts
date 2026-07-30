import type { LockedComputerControlPlatform } from "@ling-stack/contracts";

export type LockedControlNativeIdentityStatus =
  | "verified"
  | "cancelled"
  | "failed"
  | "unavailable";

export interface LockedControlNativeIdentityRequest {
  readonly requestId: string;
  readonly platform: LockedComputerControlPlatform;
  readonly localizedReason: string;
  readonly signal: AbortSignal;
}

/** Native identity output intentionally contains no user, credential or biometric fields. */
export interface LockedControlNativeIdentityResponse {
  readonly status: LockedControlNativeIdentityStatus;
}

export interface LockedControlNativeAttestationRequest {
  readonly platform: LockedComputerControlPlatform;
  readonly expectedSessionBindingDigest: string;
  readonly lockEpoch: number;
  readonly providerGeneration: number;
  readonly signal: AbortSignal;
}

/** Content-free proof facts. Desktop owns grant binding, sequence and timestamps. */
export interface LockedControlNativeAttestationResponse {
  readonly platform: LockedComputerControlPlatform;
  readonly sessionBindingDigest: string;
  readonly lockEpoch: number;
  readonly providerGeneration: number;
  readonly sameUserSession: boolean;
  readonly userDesktopTargeted: boolean;
  readonly captureReady: boolean;
  readonly inputReady: boolean;
  readonly secureSurfaceExcluded: boolean;
}

export interface LockedControlNativeBridge {
  verifyIdentity(
    request: LockedControlNativeIdentityRequest,
  ): Promise<unknown>;
  attestLockedSession(
    request: LockedControlNativeAttestationRequest,
  ): Promise<unknown>;
}

const NATIVE_IDENTITY_KEYS = new Set(["status"]);
const NATIVE_ATTESTATION_KEYS = new Set([
  "platform",
  "sessionBindingDigest",
  "lockEpoch",
  "providerGeneration",
  "sameUserSession",
  "userDesktopTargeted",
  "captureReady",
  "inputReady",
  "secureSurfaceExcluded",
]);

export function parseLockedControlNativeIdentityResponse(
  value: unknown,
): LockedControlNativeIdentityResponse | undefined {
  if (!isRecord(value)
    || !Object.keys(value).every((key) => NATIVE_IDENTITY_KEYS.has(key))
    || (value.status !== "verified"
      && value.status !== "cancelled"
      && value.status !== "failed"
      && value.status !== "unavailable")) {
    return undefined;
  }
  return { status: value.status };
}

export function parseLockedControlNativeAttestationResponse(
  value: unknown,
): LockedControlNativeAttestationResponse | undefined {
  if (!isRecord(value)
    || !Object.keys(value).every((key) => NATIVE_ATTESTATION_KEYS.has(key))
    || (value.platform !== "darwin" && value.platform !== "win32")
    || !isSha256(value.sessionBindingDigest)
    || !isPositiveInteger(value.lockEpoch)
    || !isPositiveInteger(value.providerGeneration)
    || !areBooleans(value, [
      "sameUserSession",
      "userDesktopTargeted",
      "captureReady",
      "inputReady",
      "secureSurfaceExcluded",
    ])) {
    return undefined;
  }
  return {
    platform: value.platform,
    sessionBindingDigest: value.sessionBindingDigest,
    lockEpoch: value.lockEpoch,
    providerGeneration: value.providerGeneration,
    sameUserSession: value.sameUserSession as boolean,
    userDesktopTargeted: value.userDesktopTargeted as boolean,
    captureReady: value.captureReady as boolean,
    inputReady: value.inputReady as boolean,
    secureSurfaceExcluded: value.secureSurfaceExcluded as boolean,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function areBooleans(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "boolean");
}
