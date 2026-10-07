import type { UnifiedExecCommand, UnifiedExecProcessObservation } from "./exec/unified-exec-types.js";
import type { RuntimeAttemptFenceV1 } from "./runtime-supervisor-types.js";

declare const commandTicket: unique symbol;
/** Only the preparing Host store can settle this in-memory capability. Not serializable authority. */
export interface HostCommandExecutionTicket {
  readonly executionId: string;
  readonly [commandTicket]: true;
}
export interface PrepareHostCommandExecutionInput {
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly toolCallId: string;
  readonly cwd: string;
  readonly command: UnifiedExecCommand;
}
export type HostCommandSettlementInput =
  | { readonly kind: "not_started" }
  | { readonly kind: "observed"; readonly observation: UnifiedExecProcessObservation };
