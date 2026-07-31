import {
  isPositiveLockedComputerControlAttestationV1,
  type LockedComputerControlAttestationV1,
  type LockedComputerControlCapabilityV1,
  type LockedComputerControlGrantV1,
  type LockedControlReasonCode,
} from "@ling-stack/contracts";
import {
  parseLockedControlNativeAttestationResponse,
  type LockedControlNativeBridge,
} from "./native-bridge.js";

export const LOCKED_CONTROL_ATTESTATION_TIMEOUT_MS = 5_000;

export type LockedControlAttestationOutcome =
  | { readonly ok: true; readonly attestation: LockedComputerControlAttestationV1 }
  | { readonly ok: false; readonly reason: LockedControlReasonCode };

export interface LockedControlCapabilityAttestor {
  attest(input: {
    readonly capability: LockedComputerControlCapabilityV1;
    readonly grant: LockedComputerControlGrantV1;
    readonly lockEpoch: number;
    readonly reservedProviderGeneration: number;
    readonly sequence: number;
  }): Promise<LockedControlAttestationOutcome>;
}

export function createLockedControlCapabilityAttestor(options: {
  readonly nativeBridge?: Pick<LockedControlNativeBridge, "attestLockedSession">;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}): LockedControlCapabilityAttestor {
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    async attest(
      input: Parameters<LockedControlCapabilityAttestor["attest"]>[0],
    ): Promise<LockedControlAttestationOutcome> {
      const staticReason = validateInput(input, now().getTime());
      if (staticReason) {
        return { ok: false, reason: staticReason };
      }
      if (!options.nativeBridge) {
        return { ok: false, reason: "locked_control_platform_unsupported" };
      }
      const controller = new AbortController();
      let raw: unknown;
      try {
        raw = await withTimeout(
          options.nativeBridge.attestLockedSession({
            platform: input.grant.platform,
            expectedSessionBindingDigest: input.grant.osSessionBindingDigest,
            lockEpoch: input.lockEpoch,
            providerGeneration: input.reservedProviderGeneration,
            signal: controller.signal,
          }),
          timeoutMs,
          controller,
        );
      } catch {
        return { ok: false, reason: "locked_control_platform_unsupported" };
      }
      const nativeResult = parseLockedControlNativeAttestationResponse(raw);
      if (!nativeResult
        || nativeResult.platform !== input.grant.platform
        || nativeResult.lockEpoch !== input.lockEpoch
        || nativeResult.providerGeneration !== input.reservedProviderGeneration
        || nativeResult.sessionBindingDigest !== input.grant.osSessionBindingDigest) {
        return { ok: false, reason: "locked_control_session_mismatch" };
      }
      const proofFailure = nativeProofFailure(nativeResult);
      if (proofFailure) {
        return { ok: false, reason: proofFailure };
      }
      const attestation: LockedComputerControlAttestationV1 = {
        schemaVersion: 1,
        grantId: input.grant.grantId,
        platform: input.grant.platform,
        lockEpoch: input.lockEpoch,
        sessionBindingDigest: nativeResult.sessionBindingDigest,
        sameUserSession: nativeResult.sameUserSession,
        userDesktopTargeted: nativeResult.userDesktopTargeted,
        captureReady: nativeResult.captureReady,
        inputReady: nativeResult.inputReady,
        secureSurfaceExcluded: nativeResult.secureSurfaceExcluded,
        providerGeneration: input.reservedProviderGeneration,
        sequence: input.sequence,
        observedAt: now().toISOString(),
      };
      return isPositiveLockedComputerControlAttestationV1(attestation)
        ? { ok: true, attestation }
        : { ok: false, reason: "locked_control_platform_unsupported" };
    },
  });
}

function validateInput(
  input: Parameters<LockedControlCapabilityAttestor["attest"]>[0],
  wallClockNowMs: number,
): LockedControlReasonCode | undefined {
  if (input.capability.platform !== input.grant.platform) {
    return "locked_control_session_mismatch";
  }
  if (input.capability.state !== "supported_restricted"
    || !input.capability.canCaptureSameUserDesktopWhileLocked
    || !input.capability.canInjectSameUserDesktopWhileLocked
    || !input.capability.canProveSessionContinuity
    || !input.capability.secureSurfaceExcluded) {
    return input.capability.reason ?? "locked_control_probe_required";
  }
  if (!Number.isSafeInteger(input.lockEpoch)
    || input.lockEpoch <= 0
    || input.lockEpoch !== input.grant.authorizedLockEpoch
    || !Number.isSafeInteger(input.reservedProviderGeneration)
    || input.reservedProviderGeneration <= input.grant.authorizedNormalGeneration
    || !Number.isSafeInteger(input.sequence)
    || input.sequence <= 0) {
    return "locked_control_authority_rotated";
  }
  if (Date.parse(input.grant.expiresAt) <= wallClockNowMs) {
    return "locked_control_grant_expired";
  }
  return undefined;
}

function nativeProofFailure(input: {
  readonly sameUserSession: boolean;
  readonly userDesktopTargeted: boolean;
  readonly captureReady: boolean;
  readonly inputReady: boolean;
  readonly secureSurfaceExcluded: boolean;
}): LockedControlReasonCode | undefined {
  if (!input.sameUserSession || !input.userDesktopTargeted) {
    return "locked_control_session_mismatch";
  }
  if (!input.secureSurfaceExcluded) {
    return "locked_control_secure_surface";
  }
  if (!input.captureReady) {
    return "locked_control_capture_unavailable";
  }
  if (!input.inputReady) {
    return "locked_control_input_unavailable";
  }
  return undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("locked_control_attestation_timeout"));
    }, timeoutMs);
    timeout.unref?.();
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function boundedTimeout(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 30_000
    ? value as number
    : LOCKED_CONTROL_ATTESTATION_TIMEOUT_MS;
}
