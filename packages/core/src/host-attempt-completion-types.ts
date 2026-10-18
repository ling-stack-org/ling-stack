import type { HostOperationSource } from "./host-operation-journal-types.js";

/** An original local lifetime fact, never an effect-settlement or execution capability. */
export interface HostAttemptCompletionRecord {
  readonly schemaVersion: 1;
  readonly source: HostOperationSource;
  readonly registeredAt: string;
  readonly drainedAt?: string;
  /** Only a Host-verified, original SDK boundary observation may set this. */
  readonly effectCoverage?: "pi_no_tools_v1" | "pi_tracked_tools_v1";
}

export interface HostAttemptEffectInventory {
  readonly schemaVersion: 1;
  readonly toolCallIds: readonly string[];
  readonly settledBuiltinReads: readonly {
    readonly toolCallId: string;
    readonly toolName: "read" | "grep" | "find" | "ls";
  }[];
}

export type HostAttemptEffectObservation = boolean | readonly string[] | HostAttemptEffectInventory;
