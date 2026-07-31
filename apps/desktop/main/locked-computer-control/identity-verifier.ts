import type {
  LockedComputerControlPlatform,
  LockedControlIdentityResultV1,
  LockedControlReasonCode,
} from "@ling-stack/contracts";
import { AsyncSingleFlight } from "../async-single-flight.js";
import {
  parseLockedControlNativeIdentityResponse,
  type LockedControlNativeBridge,
  type LockedControlNativeIdentityResponse,
} from "./native-bridge.js";

export const LOCKED_CONTROL_IDENTITY_TIMEOUT_MS = 120_000;

export interface LockedControlIdentityContext {
  readonly platform: LockedComputerControlPlatform;
  readonly sessionBindingDigest: string;
  readonly workspaceCwd: string;
  readonly runId?: string;
  readonly computerUseSessionId?: string;
  readonly desktopInstanceId: string;
  readonly desktopInstanceEpoch: number;
  readonly daemonAuthorityEpoch: string;
  readonly bridgeConnectionId: string;
  readonly providerGeneration: number;
  readonly lockEpoch: number;
  readonly sessionActive: boolean;
  readonly sessionLocked: boolean;
}

export interface LockedControlIdentityVerifier {
  verify(requestId: string): Promise<LockedControlIdentityResultV1>;
}

export function createLockedControlIdentityVerifier(options: {
  readonly platform: LockedComputerControlPlatform;
  readonly nativeBridge?: Pick<LockedControlNativeBridge, "verifyIdentity">;
  readonly readContext: () => LockedControlIdentityContext;
  readonly localizedReason: string;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}): LockedControlIdentityVerifier {
  const method = options.platform === "darwin"
    ? "device_owner_authentication" as const
    : "windows_user_consent" as const;
  const now = options.now ?? (() => new Date());
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const nativeFlight = new AsyncSingleFlight<LockedControlNativeIdentityResponse | undefined>();

  return Object.freeze({
    async verify(requestId: string): Promise<LockedControlIdentityResultV1> {
      if (!isText(requestId) || !isText(options.localizedReason)) {
        return failure(requestId, method, "failed", "locked_control_identity_failed");
      }
      const before = safeReadContext(options.readContext, options.platform);
      const initialReason = contextEligibilityReason(before);
      if (initialReason) {
        return failure(requestId, method, "failed", initialReason);
      }
      if (!options.nativeBridge) {
        return failure(requestId, method, "unavailable", "locked_control_identity_unavailable");
      }

      const nativeResult = await nativeFlight.run(async () => {
        const controller = new AbortController();
        try {
          const raw = await withTimeout(
            options.nativeBridge!.verifyIdentity({
              requestId,
              platform: options.platform,
              localizedReason: options.localizedReason,
              signal: controller.signal,
            }),
            timeoutMs,
            controller,
          );
          return parseLockedControlNativeIdentityResponse(raw);
        } catch {
          return undefined;
        }
      });

      if (!nativeResult) {
        return failure(requestId, method, "unavailable", "locked_control_identity_unavailable");
      }
      if (nativeResult.status !== "verified") {
        const reason: Record<Exclude<LockedControlNativeIdentityResponse["status"], "verified">, LockedControlReasonCode> = {
          cancelled: "locked_control_identity_cancelled",
          failed: "locked_control_identity_failed",
          unavailable: "locked_control_identity_unavailable",
        };
        return failure(requestId, method, nativeResult.status, reason[nativeResult.status]);
      }

      const after = safeReadContext(options.readContext, options.platform);
      const changedReason = contextChangedReason(before!, after);
      if (changedReason) {
        return failure(requestId, method, "failed", changedReason);
      }
      return {
        schemaVersion: 1,
        requestId,
        status: "verified",
        method,
        verifiedAt: now().toISOString(),
      };
    },
  });
}

function contextEligibilityReason(
  context: LockedControlIdentityContext | undefined,
): LockedControlReasonCode | undefined {
  if (!context || context.sessionLocked) {
    return "locked_control_session_mismatch";
  }
  if (!context.sessionActive || !context.runId || !context.computerUseSessionId) {
    return "locked_control_no_active_run";
  }
  return undefined;
}

function contextChangedReason(
  before: LockedControlIdentityContext,
  after: LockedControlIdentityContext | undefined,
): LockedControlReasonCode | undefined {
  if (!after || after.platform !== before.platform) {
    return "locked_control_session_mismatch";
  }
  if (!after.sessionActive || after.sessionLocked) {
    return "locked_control_session_mismatch";
  }
  if (after.sessionBindingDigest !== before.sessionBindingDigest) {
    return "locked_control_user_switched";
  }
  if (after.workspaceCwd !== before.workspaceCwd
    || after.runId !== before.runId
    || after.computerUseSessionId !== before.computerUseSessionId) {
    return "locked_control_no_active_run";
  }
  if (after.desktopInstanceId !== before.desktopInstanceId
    || after.desktopInstanceEpoch !== before.desktopInstanceEpoch
    || after.daemonAuthorityEpoch !== before.daemonAuthorityEpoch
    || after.bridgeConnectionId !== before.bridgeConnectionId
    || after.providerGeneration !== before.providerGeneration
    || after.lockEpoch !== before.lockEpoch) {
    return "locked_control_authority_rotated";
  }
  return undefined;
}

function safeReadContext(
  readContext: () => LockedControlIdentityContext,
  platform: LockedComputerControlPlatform,
): LockedControlIdentityContext | undefined {
  try {
    const context = readContext();
    if (!context
      || context.platform !== platform
      || !isSha256(context.sessionBindingDigest)
      || !isText(context.workspaceCwd, 4096)
      || (context.runId !== undefined && !isText(context.runId))
      || (context.computerUseSessionId !== undefined && !isText(context.computerUseSessionId))
      || !isText(context.desktopInstanceId)
      || !isPositiveInteger(context.desktopInstanceEpoch)
      || !isText(context.daemonAuthorityEpoch)
      || !isText(context.bridgeConnectionId)
      || !isNonNegativeInteger(context.providerGeneration)
      || !isNonNegativeInteger(context.lockEpoch)
      || typeof context.sessionActive !== "boolean"
      || typeof context.sessionLocked !== "boolean") {
      return undefined;
    }
    return context;
  } catch {
    return undefined;
  }
}

function failure(
  requestId: string,
  method: LockedControlIdentityResultV1["method"],
  status: Exclude<LockedControlIdentityResultV1["status"], "verified">,
  reason: LockedControlReasonCode,
): LockedControlIdentityResultV1 {
  return {
    schemaVersion: 1,
    requestId: isText(requestId) ? requestId : "invalid-request",
    status,
    method,
    reason,
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("locked_control_identity_timeout"));
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
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 300_000
    ? value as number
    : LOCKED_CONTROL_IDENTITY_TIMEOUT_MS;
}

function isText(value: unknown, maxLength = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && value.trim() === value;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
