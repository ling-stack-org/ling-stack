import type { RuntimeAttemptFenceV1 } from "./runtime-supervisor-types.js";
import type { ControlPlaneEvent } from "./run-types.js";

/** Host decision to finish this exact source, not proof that any execution stopped. */
export interface RunTerminalIntentV1 {
  readonly schemaVersion: 1;
  readonly kind: "run.terminal_intent.v1";
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly desiredOutcome: "failed" | "cancelled";
  readonly contextDigest: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly requestedAt: string;
}
export interface RunTerminalIntentRecord {
  readonly id: string;
  readonly artifactId: string;
  readonly digest: string;
  readonly state: "pending" | "committed";
  readonly notifiedAt?: string;
  readonly payload: RunTerminalIntentV1;
}
export type RunTerminalIntentReconcileResult =
  | { readonly status: "committed"; readonly runId: string; readonly replayed: boolean; readonly controlPlaneEvents: readonly ControlPlaneEvent[] }
  | { readonly status: "pending" | "blocked"; readonly runId: string; readonly code: string };
