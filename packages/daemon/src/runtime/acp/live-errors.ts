export class AcpLifecycleError extends Error {
  constructor(readonly code: "invalid_input" | "invalid_state" | "protocol_error" | "binding_mismatch"
    | "unsupported_capability" | "connection_lost" | "output_limit" | "host_commit_failed"
    | "cancelled" | "timeout" | "submission_uncertain" | "host_cleanup_failed",
  readonly outcome: "not_submitted" | "unknown" = "not_submitted") { super(code); }
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
}
