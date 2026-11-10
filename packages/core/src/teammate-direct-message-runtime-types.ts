import type { LingTurn, RunSession } from "./run-types.js";
import type { RuntimeAttemptFenceV1, WorkUnit, WorkUnitAttempt } from "./runtime-supervisor-types.js";
import type { TeammateDirectMessage } from "./workspace-types.js";

/** Native private-message scope. runId may identify the first, not-yet-linked Run. */
export interface TeammateDirectMessageRuntimeScope {
  readonly workspaceId: string;
  readonly teammateId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly runId?: string;
  /** Only for durable cancellation before a Run was created; never an execution capability. */
  readonly workUnitId?: string;
}

export type TeammateDirectMessageRuntimeState =
  | { readonly kind: "unlinked" }
  | { readonly kind: "active" }
  | {
      readonly kind: "logical_wait";
      readonly proof: {
        readonly kind: "approval_wait" | "resume_pre_dispatch" | "user_input_yield";
        readonly id: string;
        readonly revision: number;
      };
    }
  | { readonly kind: "terminal"; readonly status: "succeeded" | "failed" | "cancelled" }
  | { readonly kind: "indeterminate"; readonly reason: string };

/** One read-only SQLite snapshot; fingerprint excludes heartbeat-only changes. */
export interface TeammateDirectMessageRuntimeObservation {
  readonly scope: TeammateDirectMessageRuntimeScope;
  readonly message: TeammateDirectMessage;
  readonly fingerprint: string;
  readonly state: TeammateDirectMessageRuntimeState;
  readonly run?: RunSession;
  readonly workUnit?: WorkUnit;
  readonly attempt?: WorkUnitAttempt;
  readonly turn?: LingTurn;
  readonly lastRunEventSeq: number;
}

export interface TeammateDirectMessageRuntimePatch {
  readonly body?: string;
  readonly status?: TeammateDirectMessage["status"];
  readonly errorMessage?: string | null;
  readonly linkedRunId?: string | null;
}

/** Fixed capabilities, never a callback, SQL expression or caller-selected predicate. */
export interface CommitTeammateDirectMessageRuntimeInput {
  readonly expected: TeammateDirectMessageRuntimeObservation;
  readonly operation:
    | {
        readonly kind: "pre_dispatch";
        readonly patch: TeammateDirectMessageRuntimePatch;
      }
    | {
        readonly kind: "execution";
        readonly fence: RuntimeAttemptFenceV1;
        readonly patch: TeammateDirectMessageRuntimePatch;
      }
    | {
        readonly kind: "reconcile";
        readonly patch: TeammateDirectMessageRuntimePatch;
      };
}

export type CommitTeammateDirectMessageRuntimeResult =
  | { readonly kind: "applied" | "unchanged"; readonly message: TeammateDirectMessage }
  | { readonly kind: "stale" | "not_found" | "owner_mismatch" | "invalid_proof" };
