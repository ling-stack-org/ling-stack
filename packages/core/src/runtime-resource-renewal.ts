import type { RuntimeResourceRenewal } from "./runtime-supervisor-types.js";

/** Trusted Host policy; a deadline is not an execution-authority or stop receipt. */
export const RUNTIME_RESOURCE_RENEWAL_WINDOW_MS = 6 * 60 * 60 * 1000;

function canonicalTimestamp(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("runtime_resource_renewal_time_invalid");
  }
  return parsed;
}

/** Validate internal renewals too: JS callers must not retain the old string interface. */
export function assertRuntimeResourceRenewal(renewal: RuntimeResourceRenewal): void {
  const renewedAt = canonicalTimestamp(renewal?.renewedAt);
  const expiresAt = canonicalTimestamp(renewal?.expiresAt);
  const window = expiresAt - renewedAt;
  if (window <= 0 || window > RUNTIME_RESOURCE_RENEWAL_WINDOW_MS) {
    throw new Error("runtime_resource_renewal_window_invalid");
  }
}

/** Capture the timestamp once at the Host and share this deadline across both resource stores. */
export function createRuntimeResourceRenewal(renewedAt: string): RuntimeResourceRenewal {
  const expiresAt = new Date(canonicalTimestamp(renewedAt) + RUNTIME_RESOURCE_RENEWAL_WINDOW_MS).toISOString();
  const renewal = { renewedAt, expiresAt };
  assertRuntimeResourceRenewal(renewal);
  return renewal;
}
