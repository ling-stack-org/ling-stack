import { REMOTE_PROTOCOL_LIMITS } from "@ling-stack/contracts";

import { RemoteProtocolError } from "../errors.js";

export interface RemoteValidationClockOptions {
  readonly nowMs?: number;
  readonly maxClockSkewMs?: number;
}

export function validationNow(options: RemoteValidationClockOptions): number {
  const now = options.nowMs ?? Date.now();
  if (!Number.isFinite(now)) {
    throw new RemoteProtocolError("invalid_time", "Validation clock is invalid");
  }
  return now;
}

export function assertExpiryWindow(
  issuedAt: string,
  expiresAt: string,
  maximumLifetimeMs: number,
  options: RemoteValidationClockOptions,
  path: string,
): void {
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Date.parse(expiresAt);
  const now = validationNow(options);
  const skew = options.maxClockSkewMs ?? REMOTE_PROTOCOL_LIMITS.maxClockSkewMs;
  if (expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > maximumLifetimeMs) {
    throw new RemoteProtocolError("invalid_time", "Expiry window is outside the protocol limit", path);
  }
  if (issuedAtMs > now + skew) {
    throw new RemoteProtocolError("invalid_time", "Issued time is too far in the future", path);
  }
  if (expiresAtMs < now - skew) {
    throw new RemoteProtocolError("command_expired", "Protocol value has expired", path);
  }
}
