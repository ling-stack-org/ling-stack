import type { RuntimeAttemptFenceV1 } from "./runtime-supervisor-types.js";
import type { UserInputSource } from "./user-input-store-types.js";

/** Host-only stop receipt. The Runner/Host executor must establish this before committing a yield. */
export interface UserInputQuiescence {
  readonly kind: "runner_quiesced";
  readonly runnerId: string;
  readonly stoppedAt: string;
  readonly lastRunEventSeq: number;
}
export interface CommitUserInputYield {
  readonly threadId: string;
  readonly requestId: string;
  readonly expectedRequestVersion: number;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly quiescence: UserInputQuiescence;
}
/** Immutable lineage, not a model prompt, permission grant or proof of task completion. */
export interface UserInputYieldCheckpoint {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly requestVersion: number;
  readonly source: UserInputSource;
  readonly taskId: string;
  readonly quiescence: UserInputQuiescence;
  readonly committedAt: string;
}
export interface UserInputWait {
  readonly status: "waiting" | "resuming" | "resumed" | "cancelled" | "blocked";
  readonly revision: number;
  readonly checkpoint: UserInputYieldCheckpoint;
}
export interface CommitUserInputYieldResult {
  readonly wait: UserInputWait;
  readonly replayed: boolean;
}
/** Cancels the logical wait owned by this immutable source Run, never its successor. */
export interface CancelUserInputWait {
  readonly threadId: string;
  readonly sourceRunId: string;
}
export interface CancelUserInputWaitResult {
  readonly wait: UserInputWait;
  readonly request: import("./user-input-store-types.js").UserInputRequest;
  readonly replayed: boolean;
}
